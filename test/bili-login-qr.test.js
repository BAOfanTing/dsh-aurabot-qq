// B 站扫码登录：只验状态映射和 Cookie 解析，不碰真接口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBiliQrLogin, cookieFromLogin } from '../src/bili/login.js'

const reply = (body, setCookies = []) => ({
  status: 200,
  headers: { getSetCookie: () => setCookies },
  json: async () => body,
})

test('B 站扫码：取二维码返回 key 和 PNG', async () => {
  const login = createBiliQrLogin({
    fetchImpl: async () => reply({ code: 0, data: { url: 'https://account.bilibili.com/h5/scan?qrcode_key=abc', qrcode_key: 'abc' } }),
  })
  const r = await login.start()
  assert.equal(r.key, 'abc')
  assert.match(r.image, /^data:image\/png;base64,/)
})

test('B 站扫码：拿不到二维码要抛错（面板才好提示）', async () => {
  const login = createBiliQrLogin({ fetchImpl: async () => reply({ code: -400, message: '参数错误' }) })
  await assert.rejects(() => login.start(), /参数错误/)
})

test('B 站扫码：四种状态都能认', async () => {
  const cases = [
    [86101, 'wait'],
    [86090, 'scanned'],
    [86038, 'expired'],
  ]
  for (const [code, expected] of cases) {
    const login = createBiliQrLogin({ fetchImpl: async () => reply({ code: 0, data: { code, message: 'x' } }) })
    assert.equal((await login.poll('k')).status, expected)
  }
})

test('B 站扫码：确认后从 data.url 的查询串里取 Cookie', async () => {
  const url = 'https://passport.biligame.com/crossDomain?DedeUserID=12345&SESSDATA=abc%2Cdef&bili_jct=csrf1&gourl=https%3A%2F%2Fwww.bilibili.com'
  const login = createBiliQrLogin({ fetchImpl: async () => reply({ code: 0, data: { code: 0, url } }) })
  const r = await login.poll('k')
  assert.equal(r.status, 'ok')
  assert.equal(r.cookie.SESSDATA, 'abc,def') // 要在解码之后
  assert.equal(r.cookie.bili_jct, 'csrf1')
  assert.equal(r.cookie.DedeUserID, '12345')
})

test('B 站扫码：data.url 没带 Cookie 时退回 Set-Cookie', async () => {
  const login = createBiliQrLogin({
    fetchImpl: async () => reply({ code: 0, data: { code: 0, url: '' } }, ['SESSDATA=s1; Path=/; HttpOnly', 'bili_jct=j1; Path=/']),
  })
  const r = await login.poll('k')
  assert.equal(r.status, 'ok')
  assert.equal(r.cookie.SESSDATA, 's1')
  assert.equal(r.cookie.bili_jct, 'j1')
})

test('B 站扫码：登录成功但没 SESSDATA 要说清楚，不能存个空 Cookie', async () => {
  const login = createBiliQrLogin({ fetchImpl: async () => reply({ code: 0, data: { code: 0, url: 'https://x/?bili_jct=j1' } }) })
  const r = await login.poll('k')
  assert.equal(r.status, 'error')
  assert.match(r.message, /SESSDATA/)
})

test('B 站 Cookie 解析：只认需要的键', () => {
  const c = cookieFromLogin({ url: 'https://x/?SESSDATA=s&buvid3=b&DedeUserID=9&sid=q' })
  assert.deepEqual(c, { SESSDATA: 's', DedeUserID: '9', sid: 'q' })
})
