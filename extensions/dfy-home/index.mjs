// 大肥鱼的家（Aurabot 用户模块）
//
// 把 dfy-room 那个小房间接进来：她住在里面，能说出自己在哪个角落，也能拍一张
// 「第一视角」照片发到 QQ —— 就是她眼睛看到的那张。
//
// 装法：把整个文件夹复制到 Aurabot 数据目录的 modules/dfy-home/，
//       然后在面板「扩展」页确认它在跑。默认连接 http://127.0.0.1:5178。
//
// 需要对面先跑起来：在 dfy-room 目录里 `node server.js 5178`（面板「大肥鱼的家」能一键开）。

const DEFAULT_BASE = 'http://127.0.0.1:5178'
const STATE_TIMEOUT = 6000
const SHOT_TIMEOUT = 95_000 // 页面没开着时，服务端会起一个无头 Chrome 现拍，慢一点

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function baseUrl(api) {
  const raw = String(api.settings().baseUrl || DEFAULT_BASE).trim().replace(/\/+$/, '')
  if (!/^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(raw)) {
    throw new Error('「大肥鱼的家地址」只能是本机地址，例如 http://127.0.0.1:5178')
  }
  return raw
}

function portOf(api) {
  try {
    const u = new URL(baseUrl(api))
    return Number(u.port || 80)
  } catch {
    return 5178
  }
}

async function roomFetch(api, path, { method = 'GET', body, timeout = STATE_TIMEOUT } = {}) {
  const init = { method, signal: AbortSignal.timeout(timeout) }
  if (body !== undefined) {
    init.headers = { 'content-type': 'application/json' }
    init.body = JSON.stringify(body)
  }
  return fetch(baseUrl(api) + path, init)
}

async function roomJson(api, path, opts) {
  let r
  try {
    r = await roomFetch(api, path, opts)
  } catch (err) {
    throw new Error(
      err && (err.name === 'TimeoutError' || err.name === 'AbortError')
        ? '大肥鱼的家没反应（超时），可能没跑起来'
        : `连不上大肥鱼的家（${baseUrl(api)}）：${err.message || err}`
    )
  }
  const text = await r.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    json = null
  }
  if (!r.ok) throw new Error((json && json.message) || `大肥鱼的家返回 ${r.status}`)
  if (!json) throw new Error('大肥鱼的家返回了看不懂的内容')
  return json
}

/** 她现在在家里的状态（房间接口的原始返回） */
async function homeState(api) {
  return roomJson(api, '/api/home')
}

/** 一句人话：她在哪、在干嘛 */
function describe(state) {
  const loc = state.location
  if (!loc) {
    return state.online
      ? '她还没报位置（可能是刚打开页面）'
      : '她家没开着（可以先在「大肥鱼的家」面板点「打开家」）'
  }
  const bits = [`她在「${loc.emoji || ''}${loc.name}」`]
  if (loc.desc) bits.push(loc.desc)
  if (state.asleep) bits.push('已经睡着了')
  else if (state.clip) bits.push(`正在「${state.clip}」`)
  if (!state.online) bits.push('（页面现在没开着，这是最后一次记下的位置）')
  else if (state.photo && typeof state.photo.ageMs === 'number') {
    bits.push(`上一张第一视角是 ${Math.round(state.photo.ageMs / 1000)} 秒前拍的`)
  }
  return bits.join(' · ')
}

/** 要一张第一视角（JPEG Buffer） */
async function shotBuffer(api) {
  let r
  try {
    r = await roomFetch(api, '/api/home/shot', { timeout: SHOT_TIMEOUT })
  } catch (err) {
    throw new Error(`没拍到照片：${err.message || err}`)
  }
  if (!r.ok) {
    let msg = `没拍到照片（${r.status}）`
    try {
      const j = await r.json()
      if (j && j.message) msg = j.message
    } catch {
      /* ignore */
    }
    throw new Error(msg)
  }
  const type = String(r.headers.get('content-type') || '')
  if (!type.startsWith('image/')) throw new Error(`对面没给图片：${type}`)
  return Buffer.from(await r.arrayBuffer())
}

/** 地点名 → spot id（支持中文名、id、包含匹配） */
function matchSpot(spots, place) {
  const want = String(place || '').trim()
  if (!want) return null
  const list = Array.isArray(spots) ? spots : []
  return (
    list.find((s) => s.id === want) ||
    list.find((s) => s.name === want) ||
    list.find((s) => s.name && (s.name.includes(want) || want.includes(s.name))) ||
    null
  )
}

export default {
  id: 'dfy-home',
  name: '大肥鱼的家',
  version: '1.0.0',
  api: 1,
  description: '接上 dfy-room 的小房间：说出她在哪个角落，拍第一视角发到 QQ，还能让她走去某个角落。',
  panel: 'panel.js',
  defaults: {
    enabled: true,
    baseUrl: DEFAULT_BASE,
    roomDir: '',
    groupPhoto: false,
    openBrowser: true,
  },
  settings: [],

  setup(api) {
    /** 发一张第一视角到 chat */
    async function sendPhoto(chatId) {
      const buf = await shotBuffer(api)
      const st = await homeState(api).catch(() => null)
      const where = st && st.location ? st.location.name : '家里'
      const sent = await api.sendSegments(
        chatId,
        [{ type: 'image', data: { file: 'base64://' + buf.toString('base64') } }],
        `[大肥鱼的第一视角 · ${where}]`
      )
      if (!sent) throw new Error('照片拍好了，但没有发到 QQ（检查总开关、试运行和连接）')
      return { where, bytes: buf.length }
    }

    // ---------------- 给她用的工具 ----------------
    api.tool((where) => {
      if (api.settings().enabled === false) return []
      if (!where || !where.chat || where.chat.kind === 'system') return []
      const isPrivate = where.chat.kind === 'private'
      const photoOk = isPrivate || api.settings().groupPhoto === true
      const chatId = where.chat.chatId

      const tools = [
        api.defineTool({
          name: 'home_where',
          description:
            '查大肥鱼现在在自己家（那个小房间）里的哪个角落、正在做什么。有人问她"你在哪""你在家干什么呢"时用。',
          properties: {},
          execute: async () => {
            const st = await homeState(api)
            const spots = (st.spots || []).map((s) => s.name).filter(Boolean)
            return {
              ok: true,
              message: describe(st) + (spots.length ? `\n家里能待的地方：${spots.join('、')}` : ''),
              spot: st.location ? st.location.name : null,
              online: !!st.online,
            }
          },
        }),
      ]

      if (photoOk) {
        tools.push(
          api.defineTool({
            name: 'home_photo',
            description:
              '拍一张大肥鱼眼睛看到的第一视角照片，直接发进当前聊天。有人说"给我看看你那边""发张照片/截图""你现在看到什么"时用。',
            properties: {},
            execute: async () => {
              const r = await sendPhoto(chatId)
              return { ok: true, message: `已经发了一张第一视角照片（她当时在${r.where}）` }
            },
          })
        )
      }

      tools.push(
        api.defineTool({
          name: 'home_goto',
          description:
            '让大肥鱼走到自己家里的某个角落。地点用中文名，例如 泳池里 / 书桌前 / 窗边 / 地毯中间 / 大树下 / 院子里。想让她换个地方并让对方看一眼时，把 photo 设成 true。',
          properties: {
            place: { type: 'string', description: '地点名，例如 泳池里、书桌前、院子里' },
            photo: { type: 'boolean', description: '到了之后要不要顺便发一张第一视角照片' },
          },
          required: ['place'],
          execute: async ({ place, photo }) => {
            const st = await homeState(api)
            const spot = matchSpot(st.spots, place)
            if (!spot) {
              return { ok: false, message: `家里没有「${place}」这个地方。能去的有：${(st.spots || []).map((s) => s.name).join('、') || '（还没读到地点）'}` }
            }
            await roomJson(api, '/api/home/command', { method: 'POST', body: { type: 'goto', spot: spot.id } })
            // 等她走过去（房间那边走到就更新状态）
            let now = st
            for (let i = 0; i < 24; i++) {
              await sleep(700)
              now = await homeState(api).catch(() => now)
              if (now.location && now.location.id === spot.id) break
            }
            let extra = ''
            if (photo && photoOk) {
              const r = await sendPhoto(chatId)
              extra = `，还发了一张第一视角`
              void r
            }
            return {
              ok: true,
              message: `她走到「${spot.name}」了${extra}。${describe(now)}`,
            }
          },
        })
      )

      return tools
    })

    // ---------------- 让她知道有这回事 ----------------
    api.rule(
      () =>
        '你住在一个叫「大肥鱼的家」的小房间里（有床、书桌、书架、落地灯，院子里有泳池和秋千）。' +
        '别人问你在哪、你想让对方看看你身边时，用 home_where 查位置、home_photo 发一张第一视角照片；' +
        '想换个角落可以用 home_goto。这些是你的真实位置，不要编。'
    )

    // ---------------- 主人命令 ----------------
    api.command({
      name: '家',
      aliases: ['home', '我的家'],
      desc: '看看大肥鱼现在在家哪、并发一张第一视角',
      run: async (arg, msg) => {
        if (api.settings().enabled === false) return '「大肥鱼的家」模块关着，先到面板把它打开'
        const st = await homeState(api)
        const text = describe(st)
        if (/照片|图|看看|照/.test(String(arg || '')) || !arg) {
          await sendPhoto(msg.chatId).catch((err) => api.log.warn('发第一视角失败：', err.message))
        }
        return text
      },
    })

    // ---------------- 面板接口 ----------------
    api.route('/state', async () => {
      if (api.settings().enabled === false) return { ok: false, message: '模块关着（开关打开后再试）' }
      const st = await homeState(api)
      return {
        ok: true,
        online: !!st.online,
        location: st.location || null,
        clip: st.clip || null,
        asleep: !!st.asleep,
        view: st.view || null,
        pos: st.pos || null,
        spots: (st.spots || []).map((s) => ({ id: s.id, name: s.name, emoji: s.emoji, zone: s.zone, desc: s.desc })),
        history: (st.history || []).slice(0, 8),
        photo: st.photo || null,
        summary: describe(st),
        baseUrl: baseUrl(api),
      }
    })

    api.route('/photo', async () => {
      const buf = await shotBuffer(api)
      return { ok: true, dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'), bytes: buf.length, at: Date.now() }
    })

    api.route('/goto', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const st = await homeState(api)
      const spot = matchSpot(st.spots, body.spot || body.place)
      if (!spot) return { ok: false, message: `没有这个地方：${body.spot || body.place || '（空）'}` }
      await roomJson(api, '/api/home/command', { method: 'POST', body: { type: 'goto', spot: spot.id } })
      let now = st
      for (let i = 0; i < 24; i++) {
        await sleep(700)
        now = await homeState(api).catch(() => now)
        if (now.location && now.location.id === spot.id) break
      }
      return { ok: true, message: `她到${spot.name}了`, location: now.location || null }
    })

    api.route('/command', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      if (!body || !body.type) return { ok: false, message: '要带 type，比如 {"type":"pat"}' }
      const r = await roomJson(api, '/api/home/command', { method: 'POST', body })
      await sleep(600)
      return { ok: true, id: r.id }
    })

    // 一键把家开起来：起 dfy-room 的 server.js，再打开浏览器
    api.route('/open', async () => {
      try {
        const st = await homeState(api)
        if (st.online) return { ok: true, message: '家已经开着了，页面正开着', url: baseUrl(api) }
      } catch {
        /* 没开：继续往下起服务 */
      }
      const dir = String(api.settings().roomDir || '').trim()
      if (!dir) {
        return { ok: false, message: '先在设置里填「大肥鱼的家目录」（dfy-room 文件夹的完整路径），我才能帮你启动' }
      }
      const { spawn } = await import('node:child_process')
      const { existsSync } = await import('node:fs')
      const { join } = await import('node:path')
      if (!existsSync(join(dir, 'server.js'))) return { ok: false, message: `在 ${dir} 里没找到 server.js` }
      try {
        const child = spawn(process.execPath, ['server.js', String(portOf(api))], {
          cwd: dir,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
        child.unref()
      } catch (err) {
        return { ok: false, message: '起不来：' + (err.message || err) }
      }
      // 等它监听上
      let up = false
      for (let i = 0; i < 20; i++) {
        await sleep(400)
        try {
          const r = await roomFetch(api, '/health', { timeout: 1500 })
          if (r.ok) {
            up = true
            break
          }
        } catch {
          /* 还没起来 */
        }
      }
      if (!up) return { ok: false, message: '服务没能起来（端口被占用？看 dfy-room 目录里的控制台输出）' }
      if (api.settings().openBrowser !== false) {
        const url = baseUrl(api) + '/'
        const cmd = process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
        try {
          spawn(cmd[0], cmd[1], { detached: true, stdio: 'ignore' }).unref()
        } catch {
          /* 浏览器打不开就算了，地址已经返回 */
        }
      }
      return { ok: true, message: '家开起来了', url: baseUrl(api) + '/' }
    })

    return {
      state: () => homeState(api),
      describe,
      photo: () => shotBuffer(api),
      base: () => baseUrl(api),
    }
  },
}
