// B 站扫码登录：跟网页版一个流程（取二维码 → 手机确认 → 换回 Cookie），不需要开浏览器。
// 只负责「拿到 SESSDATA / bili_jct」，存进配置的事交给调用方。

import { qrDataUrl } from '../core/qr.js'

const GENERATE = 'https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header'
const POLL = 'https://passport.bilibili.com/x/passport-login/web/qrcode/poll?source=main-fe-header&qrcode_key='
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

// 接口 data.code → 我们这边的状态
const STATES = {
  0: { status: 'ok', message: '登录成功' },
  86101: { status: 'wait', message: '等手机扫码' },
  86090: { status: 'scanned', message: '扫到了，等手机上点确认' },
  86038: { status: 'expired', message: '二维码过期了，重新点一次' },
}

const WANTED = /^(SESSDATA|bili_jct|DedeUserID|DedeUserID__ckMd5|sid)$/

/** 从登录成功的返回里取 Cookie：优先 data.url 的查询串，拿不到就退回 Set-Cookie。 */
export function cookieFromLogin(data, setCookies = []) {
  const out = {}
  try {
    for (const [k, v] of new URL(String(data?.url || '')).searchParams) if (WANTED.test(k)) out[k] = v
  } catch (error) {}
  for (const line of setCookies || []) {
    const m = /^([^=]+)=([^;]*)/.exec(String(line || ''))
    if (m && WANTED.test(m[1]) && !out[m[1]]) out[m[1]] = m[2]
  }
  return out
}

/**
 * @param {object} [opts]
 * @param {{info?: Function, warn?: Function}} [opts.log]
 * @param {typeof fetch} [opts.fetchImpl] 测试时换成假的
 */
export function createBiliQrLogin({ log, fetchImpl = fetch } = {}) {
  const headers = { 'user-agent': UA, referer: 'https://www.bilibili.com/', origin: 'https://www.bilibili.com' }

  /** 取一张新二维码。 */
  async function start() {
    const res = await fetchImpl(GENERATE, { headers, signal: AbortSignal.timeout(15000) })
    const j = await res.json().catch(() => ({}))
    const url = j?.data?.url
    const key = j?.data?.qrcode_key
    if (j?.code !== 0 || !url || !key) throw new Error(j?.message || 'B 站没给二维码')
    return { key, url, image: qrDataUrl(url), expiresInSec: 180 }
  }

  /** 问一次扫码进度；成功了带 Cookie。 */
  async function poll(key) {
    const res = await fetchImpl(POLL + encodeURIComponent(key), { headers, signal: AbortSignal.timeout(15000) })
    const j = await res.json().catch(() => ({}))
    if (j?.code !== 0) return { status: 'error', message: `B 站返回 ${j?.code ?? res.status}${j?.message ? '：' + j.message : ''}` }
    const d = j.data || {}
    const state = STATES[d.code] || { status: 'error', message: d.message || `没见过的状态 ${d.code}` }
    if (state.status !== 'ok') return { ...state }
    const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : []
    const cookie = cookieFromLogin(d, setCookies)
    if (!cookie.SESSDATA) return { status: 'error', message: '扫码成功了，但没拿到 SESSDATA（B 站接口可能改了）' }
    log?.info?.('B 站扫码登录成功')
    return { status: 'ok', message: '登录成功', cookie }
  }

  return { start, poll }
}
