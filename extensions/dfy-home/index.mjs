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

/**
 * 「家没开着」是很正常的事，不该被记成模块报错——插件会把抛出的错误记进模块状态，
 * 面板顶上就一直挂着一条红字。接口里一律用它包一层，转成 { ok: false, message }。
 */
async function tryCall(fn) {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    return { ok: false, message: String((err && err.message) || err || '出错了') }
  }
}

/**
 * 这个地方在家里的哪儿。
 * 房间页面会直接给一句 hint；老版本页面没给，就按坐标兜一句粗方位，别让她答"不知道床在哪"。
 */
function spotHint(spot) {
  if (!spot) return ''
  if (spot.hint) return spot.hint
  const x = spot.nav && Number.isFinite(spot.nav.x) ? spot.nav.x : 0
  const z = spot.nav && Number.isFinite(spot.nav.z) ? spot.nav.z : 0
  const area = spot.area || spot.zone || 'house'
  const outdoor = area === 'yard' || area === 'water'
  const room = { bedroom: '卧室', living: '客厅', kitchen: '厨房' }[area]
  const side = x < -6 ? '左边' : x > 4 ? '右边' : '中间'
  const depth = outdoor ? (z > 7 ? '院子最里面' : '院子靠屋这半边') : z < -5 ? '靠后墙' : z > -3 ? '靠门口' : '屋子中部'
  return outdoor ? `院子${depth}，${side}` : `${room || '屋里'}${depth}，${side}`
}

/** 一句人话：她在哪、在干嘛（顺带说清这地方在家里的哪儿） */
function describe(state) {
  const loc = state.location
  if (!loc) {
    return state.online
      ? '她还没报位置（可能是刚打开页面）'
      : '她家没开着（可以先在「大肥鱼的家」面板点「打开家」）'
  }
  const sameSpot = (state.spots || []).find((s) => s.id === loc.id) || null
  const room = loc.areaName || (sameSpot && sameSpot.areaName) || ''
  const bits = [`她在「${room ? room + ' · ' : ''}${loc.emoji || ''}${loc.name}」`]
  const hint = loc.hint || spotHint(sameSpot)
  if (hint) bits.push(hint)
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
  version: '1.3.0',
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
            '查大肥鱼现在在自己家的哪间屋子、哪个角落、正在做什么，并列出这个地方有哪些位置（含"床在哪、灶台在哪"这种方位）。' +
            '有人问她"你在哪""你在家干什么呢""床在哪儿"时用。',
          properties: {},
          execute: async () => {
            const r = await tryCall(() => homeState(api))
            if (!r.ok) return { ok: false, message: r.message }
            const st = r.value
            const spots = (st.spots || [])
              .filter((s) => s.name)
              .map((s) => `${s.name}（${spotHint(s)}）`)
            return {
              ok: true,
              message:
                describe(st) +
                (spots.length ? `\n· ${st.sceneName || '这里'}能去的角落：\n- ${spots.join('\n- ')}` : ''),
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
              '拍一张大肥鱼眼睛看到的第一视角照片，直接发进当前聊天（她站在哪就拍哪，不会拍到别的地方）。' +
              '有人说"给我看看你那边""发张照片/截图""你现在看到什么"时用。',
            properties: {},
            execute: async () => {
              try {
                const r = await sendPhoto(chatId)
                return {
                  ok: true,
                  message:
                    `照片已经发进聊天了。拍的时候她在「${r.where}」。` +
                    '这张图只代表那一个角落——按这个位置说话，别把它说成别的地方，也别编照片里没有的东西。',
                }
              } catch (err) {
                return { ok: false, message: String(err.message || err) }
              }
            },
          })
        )
      }

      tools.push(
        api.defineTool({
          name: 'home_goto',
          description:
            '让大肥鱼走到自己家里的某个角落（房子分成卧室 / 客厅 / 厨房 / 院子几个场景，走过去会自动换房间）。地点用中文名：' +
            '卧室——床边、窗边、衣柜旁、书桌前；客厅——沙发上、电视前、扶手椅、落地灯下；' +
            '厨房——水槽边、灶台前、冰箱前、餐桌旁；院子——门口、泳池里、躺椅旁、大树下、秋千上、遮阳伞下、花圃旁、篱笆边、院子里。' +
            '想让她换个地方、或者有人问"床呢""给我看看泳池""厨房长什么样"时用（photo 设 true 就会走过去再拍一张发出来）。',
          properties: {
            place: { type: 'string', description: '地点名，例如 床边、书桌前、泳池里' },
            photo: { type: 'boolean', description: '到了之后要不要顺便发一张第一视角照片' },
          },
          required: ['place'],
          execute: async ({ place, photo }) => {
            const r0 = await tryCall(() => homeState(api))
            if (!r0.ok) return { ok: false, message: r0.message }
            const st = r0.value
            const spot = matchSpot(st.spots, place)
            if (!spot) {
              return {
                ok: false,
                message: `家里没有「${place}」这个地方。能去的有：${(st.spots || []).map((s) => s.name).join('、') || '（还没读到地点）'}`,
              }
            }
            const sentCmd = await tryCall(() =>
              roomJson(api, '/api/home/command', { method: 'POST', body: { type: 'goto', spot: spot.id } })
            )
            if (!sentCmd.ok) return { ok: false, message: sentCmd.message }
            // 等她走过去（房间那边走到就更新状态）
            let now = st
            let arrived = false
            for (let i = 0; i < 26; i++) {
              await sleep(700)
              const s2 = await tryCall(() => homeState(api))
              if (s2.ok) now = s2.value
              if (now.location && now.location.id === spot.id) {
                arrived = true
                break
              }
            }
            let extra = ''
            if (photo && photoOk) {
              const p = await tryCall(() => sendPhoto(chatId))
              if (p.ok) extra = '，还发了一张那边的第一视角照片'
              else return { ok: false, message: `她已经到「${spot.name}」了，但照片没发出去：${p.message}` }
            }
            return {
              ok: true,
              message: arrived
                ? `她已经站在「${spot.name}」了${extra}。${describe(now)}`
                : `她正往「${spot.name}」走，现在还在「${(now.location && now.location.name) || '路上'}」`,
            }
          },
        })
      )

      return tools
    })

    // ---------------- 让她知道有这回事 ----------------
    api.rule(
      () =>
        '你住在一个叫「大肥鱼的家」的小房子里，一横排三间加一个院子：' +
        '卧室（床、衣柜、书桌、窗），客厅（沙发、茶几、电视、扶手椅、落地灯），' +
        '厨房（长台面、水槽、灶台、冰箱、圆餐桌），院子（泳池、躺椅、大树和秋千、遮阳伞、花圃、篱笆）。\n' +
        '别人问你在哪、你家里什么样，用 home_where（它会告诉你自己在哪个角落，还把每个地方在家里的哪儿讲清楚）；' +
        '有人想看、想让你发照片，用 home_photo；别人问"床呢""你那边有什么""带我去看看泳池"，' +
        '用 home_goto（place=那个地方，photo=true）——先真的走过去拍一张，再照工具返回的位置说话。\n' +
        '这些位置和照片都是你真实的状态：不要编造地点，也不要把一张照片说成别的地方；' +
        '房间之间是一扇扇门：你自己走会穿过去，被别人指挥时 home_goto 也会先换房间再走过去。\n' +
        '工具说"页面没开着"或"没拍到"时，就照实说家里现在没开。'
    )

    // ---------------- 主人命令 ----------------
    api.command({
      name: '家',
      aliases: ['home', '我的家'],
      desc: '看看大肥鱼现在在家哪、并发一张第一视角',
      run: async (arg, msg) => {
        if (api.settings().enabled === false) return '「大肥鱼的家」模块关着，先到面板把它打开'
        const r = await tryCall(() => homeState(api))
        if (!r.ok) return `家里现在没开着：${r.message}`
        const st = r.value
        const text = describe(st)
        if (/照片|图|看看|照/.test(String(arg || '')) || !arg) {
          await sendPhoto(msg.chatId).catch((err) => api.log.warn('发第一视角失败：', err.message))
        }
        return text
      },
    })

    // ---------------- 面板接口（家没开着时回 { ok:false }，不要抛错） ----------------
    api.route('/state', async () => {
      if (api.settings().enabled === false) return { ok: false, message: '模块关着（开关打开后再试）' }
      const r = await tryCall(() => homeState(api))
      if (!r.ok) return r
      const st = r.value
      return {
        ok: true,
        online: !!st.online,
        scene: st.scene || (st.location && st.location.scene) || null,
        sceneName: st.sceneName || (st.location && st.location.areaName) || null,
        location: st.location || null,
        clip: st.clip || null,
        asleep: !!st.asleep,
        view: st.view || null,
        pos: st.pos || null,
        spots: (st.spots || []).map((s) => ({
          id: s.id,
          name: s.name,
          emoji: s.emoji,
          area: s.area,
          desc: s.desc,
          hint: s.hint,
        })),
        history: (st.history || []).slice(0, 8),
        photo: st.photo || null,
        summary: describe(st),
        baseUrl: baseUrl(api),
      }
    })

    api.route('/photo', async () => {
      const r = await tryCall(() => shotBuffer(api))
      if (!r.ok) return r
      const buf = r.value
      return { ok: true, dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64'), bytes: buf.length, at: Date.now() }
    })

    api.route('/goto', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      const r0 = await tryCall(() => homeState(api))
      if (!r0.ok) return r0
      const st = r0.value
      const spot = matchSpot(st.spots, body.spot || body.place)
      if (!spot) return { ok: false, message: `没有这个地方：${body.spot || body.place || '（空）'}` }
      const sent = await tryCall(() =>
        roomJson(api, '/api/home/command', { method: 'POST', body: { type: 'goto', spot: spot.id } })
      )
      if (!sent.ok) return sent
      let now = st
      let arrived = false
      for (let i = 0; i < 26; i++) {
        await sleep(700)
        const s2 = await tryCall(() => homeState(api))
        if (s2.ok) now = s2.value
        if (now.location && now.location.id === spot.id) {
          arrived = true
          break
        }
      }
      return {
        ok: true,
        message: arrived ? `她到${spot.name}了` : `她正走向${spot.name}`,
        arrived,
        location: now.location || null,
      }
    })

    api.route('/command', async (req) => {
      const body = await api.core.http.body(req).catch(() => ({}))
      if (!body || !body.type) return { ok: false, message: '要带 type，比如 {"type":"pat"}' }
      const r = await tryCall(() => roomJson(api, '/api/home/command', { method: 'POST', body }))
      if (!r.ok) return r
      await sleep(600)
      return { ok: true, id: r.value.id }
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
