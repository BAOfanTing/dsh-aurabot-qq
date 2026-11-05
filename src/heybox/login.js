// 小黑盒扫码登录：走网页版登录页那套接口（get_qrcode_url → qr_state），手机上用小黑盒 App 扫。
// 签名沿用 api.js；成功后把 pkey / heybox_id / x_xhh_tokenid 拼成整串 Cookie 交给调用方。

import { HeyboxClient } from './api.js'
import { qrDataUrl } from '../core/qr.js'

/**
 * 在对象里按名字找第一个非空值。接口把字段套在哪一层不好说（顶层 / profile / account_detail / session），
 * 所以宁可翻三层也别猜死位置。
 */
function findDeep(obj, names, depth = 3) {
  if (!obj || typeof obj !== 'object' || depth < 0) return ''
  for (const name of names) {
    const v = obj[name]
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim()
  }
  for (const v of Object.values(obj)) {
    if (!v || typeof v !== 'object') continue
    const hit = findDeep(v, names, depth - 1)
    if (hit) return hit
  }
  return ''
}

/** Set-Cookie → { 名字: 值 }。整条都留着：二维码的会话 cookie 要原样带回去问状态。 */
export function cookiesFromHeaders(setCookies = []) {
  const out = {}
  for (const line of setCookies || []) {
    const m = /^\s*([^=;\s]+)=([^;]*)/.exec(String(line || ''))
    if (m) out[m[1].trim()] = decodeURIComponent(m[2].trim())
  }
  return out
}

/** { 名字: 值 } → "名字=值; 名字2=值2" */
function cookieHeader(jar = {}) {
  return Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ')
}

/** 返回里都有哪些非空字段（只报名字、不报值），拿不到 pkey 时用来定位接口改了哪里。 */
export function shapeOf(obj, prefix = '', out = [], depth = 3) {
  if (!obj || typeof obj !== 'object' || depth < 0 || out.length >= 16) return out
  for (const [key, v] of Object.entries(obj)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'object') shapeOf(v, prefix + key + '.', out, depth - 1)
    else out.push(prefix + key)
    if (out.length >= 16) break
  }
  return out
}

/**
 * 按网页端的写法拼 Cookie。
 * @param {object} result qr_state 成功时的 result（pkey、profile / account_detail 可能在哪一层都不一定）
 * @param {string} [token] x_xhh_tokenid（写操作要用，读不需要）
 * @param {object} [extra] 从 Set-Cookie 里捡到的键值，JSON 里没有时兜底
 */
export function cookieFromLogin(result = {}, token = '', extra = {}) {
  const pick = (...names) => findDeep(result, names) || names.map((n) => extra[n]).find(Boolean) || ''
  const heyboxId = pick('heybox_id', 'user_heybox_id') || findDeep(result, ['userid', 'user_id'])
  const pkey = pick('pkey', 'user_pkey')
  const nickname = findDeep(result, ['nickname', 'username'])
  const token2 = token || extra.x_xhh_tokenid || ''
  const parts = [
    pkey && `pkey=${pkey}`,
    pkey && `user_pkey=${pkey}`,
    heyboxId && `heybox_id=${heyboxId}`,
    heyboxId && `user_heybox_id=${heyboxId}`,
    token2 && `x_xhh_tokenid=${token2}`,
  ].filter(Boolean)
  return { cookie: parts.join('; '), pkey, heyboxId, nickname, hasToken: Boolean(token2) }
}

/**
 * @param {object} [opts]
 * @param {{info?: Function, warn?: Function}} [opts.log]
 * @param {(cookie?: string) => object} [opts.client] 测试时换成假的
 */
export function createHeyboxQrLogin({ log, client } = {}) {
  const open = client || ((cookie = '') => new HeyboxClient({ cookie, interval: 0, timeout: 15000 }))
  // 二维码的会话 cookie：get_qrcode_url 会下发，问状态得带着同一份（浏览器里本来就是同一个会话）
  const jars = new Map()

  /** 取一张新二维码（key 是二维码链接里的 qr 参数，查状态要用它）。 */
  async function start() {
    const res = await open().request({ path: '/account/get_qrcode_url/', params: { app: 'web' }, captureCookies: true })
    const r = res?.data
    const url = r?.result?.qr_url
    if (!url) throw new Error('小黑盒没给二维码')
    let key = ''
    try { key = new URL(url).searchParams.get('qr') || '' } catch (error) {}
    if (!key) throw new Error('二维码链接里没有 qr 参数')
    jars.set(key, cookieHeader(cookiesFromHeaders(res?.setCookies)))
    if (jars.size > 20) jars.delete(jars.keys().next().value) // 别越攒越多
    return { key, url, image: qrDataUrl(url), expiresInSec: Number(r?.result?.expire) || 120 }
  }

  /** 问一次扫码进度；成功了带整串 Cookie。 */
  async function poll(key) {
    const jar = jars.get(key) || ''
    // 抓 Set-Cookie：网页端登录成功后 pkey 可能就在这里发，不一定在 JSON 里
    const res = await open(jar).request({ path: '/account/qr_state/', params: { qr: key, app: 'web' }, captureCookies: true })
    const d = res?.data?.result || {}
    if (d.error === 'wait') return { status: 'wait', message: '等手机扫码' }
    if (d.error === 'ready') return { status: 'scanned', message: '扫到了，等手机上点确认' }
    if (d.error !== 'ok') {
      jars.delete(key)
      return { status: 'expired', message: d.error_msg || '二维码过期了，重新点一次' }
    }
    const fromHeaders = cookiesFromHeaders(res?.setCookies)
    // 登录态一般在 result 里；也有接口把它放外层，所以整体再兜一次
    const info = cookieFromLogin(d, '', fromHeaders).pkey ? d : res?.data
    const base = cookieFromLogin(info, '', fromHeaders)
    if (!base.pkey) {
      // 没拿到就别装作登录成功：把接口到底回了什么报出来，下次好定位
      const shape = shapeOf(res?.data).join(', ') || '（空）'
      const headers = Object.keys(fromHeaders).join(', ') || '（无）'
      log?.warn?.(`小黑盒扫码：qr_state 返回里没有 pkey。返回字段：${shape}；Set-Cookie：${headers}`)
      log?.debug?.('小黑盒扫码：qr_state 原始返回 ' + JSON.stringify(res?.data).slice(0, 600))
      return { status: 'error', message: `扫码成功了，但没拿到 pkey（返回字段：${shape}）` }
    }
    jars.delete(key)
    // 写操作用的 x_xhh_tokenid 得用新登录态再要一次；拿不到就先只存 pkey（只能读）
    let token = ''
    try {
      const p = await open([jar, base.cookie].filter(Boolean).join('; ')).get('/bbs/app/api/user/permission', { heybox_id: base.heyboxId })
      token = String(p?.result?.heybox_token || '')
    } catch (error) {
      log?.warn?.('小黑盒扫码登录：没拿到 x_xhh_tokenid，先只存 pkey：' + error.message)
    }
    const out = cookieFromLogin(info, token, fromHeaders)
    log?.info?.(`小黑盒扫码登录成功${out.nickname ? '：' + out.nickname : ''}`)
    return {
      status: 'ok',
      message: out.hasToken ? '登录成功' : '登录成功（只有 pkey，点赞评论发帖可能被拒）',
      cookie: out.cookie,
      nickname: out.nickname,
      hasToken: out.hasToken,
    }
  }

  return { start, poll }
}
