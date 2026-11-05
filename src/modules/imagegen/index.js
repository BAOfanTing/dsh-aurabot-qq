// 内置模块：生图。她能画图发到聊天里（OpenAI 兼容的生图服务，或「本地接口」里接的 SD WebUI / ComfyUI）。

import { readFileSync } from 'node:fs'
import { createImageGen, drawResultBlocks, drawToolMessage, imageToolBlock } from '../../features/imagegen.js'
import { listPaintings, openPaintFolder, paintingPath, rememberPainting, removePainting, savePainting } from '../../features/paintings.js'
import { defineTool, str, bool } from '../../tools/tools.js'
import { dataDir } from '../../core/store.js'
import { mimeOf } from '../../chat/inbound.js'
import { segmentBytes } from '../../core/net.js'
import { findFfmpeg, findSharp, shrinkImage, shrinkWithSharp } from '../../core/img.js'

/**
 * 聊天里那张图 → 参考图 data URI（长边 1024 的 JPEG）。
 * 缩不下来就用原图（宁可大一点，也不要静默丢掉参考图）。
 */
async function toDataUrl (buf, { ffmpegPath = '', log } = {}) {
  const mediaType = String(mimeOf(buf) || 'image/jpeg')
  const asIs = () => `data:${mediaType};base64,${buf.toString('base64')}`
  if (buf.length <= 400 * 1024) return asIs()
  const ffmpeg = findFfmpeg(ffmpegPath)
  let small = ffmpeg ? await shrinkImage(buf, 1024, ffmpeg) : null
  if (!small) small = await shrinkWithSharp(await findSharp(), buf, 1024)
  if (!small || !small.length) {
    log?.debug?.(`参考图缩不下来（${Math.round(buf.length / 1024)}KB），直接用原图`)
    return asIs()
  }
  log?.debug?.(`参考图 ${Math.round(buf.length / 1024)}KB → ${Math.round(small.length / 1024)}KB`)
  return `data:image/jpeg;base64,${small.toString('base64')}`
}

export default {
  id: 'imagegen',
  name: '生图',
  version: '1.0.0',
  description: '画一张图发到聊天里（qq_draw_image）',
  tab: 'imagegen',
  files: ['features/imagegen.js', 'features/image-shape.js', 'features/paintings.js', 'features/codex-auth.js', 'features/codex-image.js'],
  setup(api) {
    const { hub, local } = api.core
    const memory = api.lazy('memory')
    const gen = createImageGen({ getConfig: api.config, log: api.log, local })
    const auth = gen.codexAuth
    api.onDispose?.(() => gen.dispose())
    const accountAction = (fn) => async (req) => {
      if (req?.method !== 'POST' || !/^application\/json(?:\s*;|$)/i.test(String(req.headers?.['content-type'] || ''))) return { ok: false, message: '账号操作需要 POST JSON 请求' }
      return fn(req)
    }
    api.route('/image/codex/status', async () => ({ ok: true, ...auth.status(), login: auth.loginStatus() }))
    api.route('/image/codex/login', accountAction(async () => ({ ok: true, ...(await auth.startLogin()), ...auth.loginStatus() })))
    api.route('/image/codex/login/status', async () => ({ ok: true, ...auth.loginStatus(), ...auth.status() }))
    api.route('/image/codex/complete', accountAction(async (req) => {
      const body = await api.core.http.body(req)
      const credential = await auth.completeLogin(String(body?.input || ''))
      return { ok: true, email: credential.email || '', accountId: credential.accountId || '' }
    }))
    api.route('/image/codex/cancel', accountAction(async () => ({ ok: true, ...auth.cancelLogin('已取消') })))
    api.route('/image/codex/logout', accountAction(async () => ({ ok: true, ...auth.logout() })))

    // 她的画作：面板底下的图库（直接读存图目录，可以单张删、开文件夹）
    api.route('/image/gallery', async (req) => {
      const q = api.core.http.query(req)
      const limit = q && q.limit ? Number(q.limit) : api.config().imageGen.galleryShown
      return { ok: true, ...listPaintings({ limit }), dir: dataDir('imagegen') }
    })
    api.route('/image/gallery/image', async (req, res) => {
      const p = paintingPath(api.core.http.query(req).file)
      if (!p) return api.core.http.send(res, 404, '')
      const buf = readFileSync(p)
      api.core.http.send(res, 200, buf, String(mimeOf(buf) || 'image/png'))
    })
    api.route('/image/gallery/delete', async (req) => {
      const b = await api.core.http.body(req).catch(() => ({}))
      return removePainting(String((b && b.file) || ''))
    })
    api.route('/image/open-folder', async () => openPaintFolder())

    api.tool(({ chat, sessionId }) => (gen.enabled() && chat.kind !== 'system' ? defineTool({
      name: 'qq_draw_image',
      description: '画一张图并发到当前 QQ 聊天里。prompt 详细描述画面，shape 可按用途选择方图、竖图、横图或宽幅；不填就沿用面板默认构图 / 图片尺寸。'
        + '要是人家刚发了一张图、让你「照这张画」「把这张改成…」「画成这种风格」，就把 useChatImage 打开，用这条聊天里最近那张图当参考（30 分钟内有效）。'
        + '画好会直接发出去，并给你一个画作编号（换头像、收成表情时用这个编号）。回复里简单说一句就行。',
      properties: {
        prompt: str('画面描述'),
        shape: { type: 'string', enum: ['square', 'portrait', 'landscape', 'wide'], description: 'square 方图 1:1；portrait 竖图 2:3；landscape 横图 3:2；wide 宽幅 16:9。可不填' },
        useChatImage: bool('用这条聊天里最近收到的那张图当参考（照着改、照着画时打开）。这条聊天 30 分钟内没图就会失败，别硬开'),
      },
      required: ['prompt'],
      slow: '好，我这就去画，画好了发你。',
      // 能看图时把原图放进工具结果（image 块），她当轮就能看见自己画了什么
      render: drawResultBlocks,
      execute: async ({ prompt, shape, useChatImage }) => {
        if (api.config().imageGen.ownerOnly && !hub.turnSendersAllOwner(sessionId)) return { ok: false, message: '画图只给主人画哦' }
        // 参考图：这条聊天最近那张（主人、群友都算；表情也行，实在太小的图她自己看着办）
        let image = ''
        if (useChatImage) {
          if (api.config().imageGen.chatImage === false) return { ok: false, message: '拿聊天里的图当参考已经在面板里关掉了，我只能凭描述画' }
          const recent = hub.recentMedia(chat.chatId) || []
          const newest = [...recent].reverse()
          const picked = newest.find((x) => x.seg && x.seg.type === 'image') || newest.find((x) => x.seg && x.seg.type === 'mface')
          if (!picked) return { ok: false, message: '这条聊天最近半小时没发过图，没法照着画（可以让她先发一张，或者我直接按描述画）' }
          let raw
          try {
            raw = await segmentBytes(picked.seg, api.core.onebot, { maxBytes: 12 * 1024 * 1024 })
          } catch (error) {
            api.log.debug('取聊天里的图失败：', error.message)
            return { ok: false, message: '那张图我取不到了（链接大概过期了），让她再发一次' }
          }
          image = await toDataUrl(raw, { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath, log: api.log })
        }
        const startedAt = Date.now()
        const buf = await gen.generate(String(prompt || ''), { shape, ...(image ? { image } : {}) })
        const sent = await hub.sendSegments(chat.chatId, [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }], `[生图] ${String(prompt).slice(0, 30)}`)
        if (!sent) return { ok: false, message: '画好了，但没有发到 QQ（请检查试运行和网关）' }
        const saved = savePainting(buf, String(prompt || ''))
        if (saved) api.log.debug(`生图已存盘：${saved}`)
        try { memory.addEvent?.({ text: `${image ? '照着聊天里那张图' : '按提示词'}画了一张图（不一定等于实际画面）：${String(prompt).slice(0, 120)}`, about: chat.kind === 'private' ? chat.userId : '', tags: image ? ['画画', '图生图'] : ['画画'], importance: 0.4 }) }
        catch (error) { api.log.warn('生图已发送，但经历没记下来：', error.message) }
        let visual = (await hub.canSeeImages(chat)) === true
        // 「让她画完自己看一眼」是总开关：关掉就当没视觉能力处理 —— 不给图、也不给路径。
        const seeOwn = api.config().imageGen.seeOwn !== false
        // 只有明确能看图的模型才把图交给它；纯文本模型只拿文字，不会崩。
        // 图要先缩、再登记成 DSH 附件块 —— 直接塞 base64 会让下一轮请求整轮失败（实测）
        let img = null
        if (visual && seeOwn) {
          img = await imageToolBlock(api.dsh, buf, { ffmpegPath: api.config().bili && api.config().bili.ffmpegPath })
          if (!img) {
            // 图没给成：如实说看不了，别让她照着提示词编画面细节
            visual = false
            api.log.debug('这次生图没把图交给模型（缩图/登记失败），只给文字')
          }
        }
        const shown = Boolean(img)
        let message
        if (!visual) message = drawToolMessage({ visual: false })
        else if (!seeOwn) message = drawToolMessage({ visual: true, seeOwn: false })
        else if (!shown) message = drawToolMessage({ visual: false })
        else message = drawToolMessage({ visual: true, seeOwn: true })
        // 画作编号：换头像 / 收表情时用编号，别用路径（路径只在图真的交出去时才附带）
        const index = saved ? rememberPainting(chat.chatId, saved) : 0
        const out = {
          ok: true,
          message,
          prompt: String(prompt || ''),
          bytes: buf.length,
          elapsedMs: Date.now() - startedAt,
          ...(image ? { usedChatImage: true } : {}),
          ...(saved ? { path: saved } : {}),
        }
        if (img) out.image = img
        if (index && saved) out.message += `\n画作编号 #${index}（想换头像、收成表情时用这个编号）`
        // 只有**图真的交给模型了**才把本地路径告诉她（#59）：收录表情包 / 存素材 / qq_add_sticker 用；
        // 看不了图或开关关着时不给路径，免得她知道路径就去读图，绕开「不给看」的判断。
        if (shown && saved) out.message += `\n已保存到本机：${saved}（要收录表情包、存素材时可以用这个路径）`
        return out
      },
    }) : []))
    return gen
  },
}
