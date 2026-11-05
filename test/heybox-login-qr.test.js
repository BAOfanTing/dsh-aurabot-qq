// 小黑盒扫码登录：只验状态映射和 Cookie 拼装，不碰真接口。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHeyboxQrLogin, cookieFromLogin } from '../src/heybox/login.js'
import { withHeyboxToken } from '../src/heybox/site.js'

/** 假客户端：按路径返回排好的响应，记下每次请求。 */
function fakeClient(routes) {
  const calls = []
  const make = (cookie = '') => {
    const get = async (path) => {
      calls.push({ path, cookie })
      const hit = routes[path]
      if (!hit) throw new Error('没有这个假接口：' + path)
      const value = typeof hit === 'function' ? hit(cookie) : hit
      if (value instanceof Error) throw value
      return value
    }
    return {
      get,
      // poll 走的是 request({ captureCookies })，返回值多一层 { data, setCookies }
      request: async ({ path }) => {
        const value = await get(path)
        return value && value.data !== undefined ? value : { data: value, setCookies: value?.setCookies || [] }
      },
    }
  }
  return { make, calls }
}

test('小黑盒扫码：从 qr_url 里取 qr 参数，并画成二维码', async () => {
  const client = fakeClient({
    '/account/get_qrcode_url/': { result: { qr_url: 'https://api.xiaoheihe.cn/account/qr_login/?qr=abc-123&app=web', expire: 120 } },
  })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.start()
  assert.equal(r.key, 'abc-123')
  assert.equal(r.expiresInSec, 120)
  assert.match(r.image, /^data:image\/png;base64,/)
})

test('小黑盒扫码：没给二维码要抛错', async () => {
  const client = fakeClient({ '/account/get_qrcode_url/': { result: {} } })
  const login = createHeyboxQrLogin({ client: client.make })
  await assert.rejects(() => login.start(), /没给二维码/)
})

test('小黑盒扫码：wait / ready / 过期 三种状态', async () => {
  for (const [error, expected] of [['wait', 'wait'], ['ready', 'scanned'], ['timeout', 'expired']]) {
    const client = fakeClient({ '/account/qr_state/': { result: { error } } })
    const login = createHeyboxQrLogin({ client: client.make })
    assert.equal((await login.poll('abc')).status, expected)
  }
})

test('小黑盒扫码：确认后拼出整串 Cookie，并额外要 x_xhh_tokenid', async () => {
  const client = fakeClient({
    '/account/qr_state/': {
      result: { error: 'ok', pkey: 'pk1', profile: { heybox_id: '8899', nickname: '大肥鱼' } },
    },
    '/bbs/app/api/user/permission': { result: { heybox_token: 'tok1' } },
  })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.poll('abc')
  assert.equal(r.status, 'ok')
  assert.equal(r.hasToken, true)
  assert.equal(r.cookie, 'pkey=pk1; user_pkey=pk1; heybox_id=8899; user_heybox_id=8899; x_xhh_tokenid=tok1')
  // 要 token 的那次请求得带上刚拿到的登录态
  assert.match(client.calls[1].cookie, /pkey=pk1/)
})

test('小黑盒扫码：拿 token 失败也要先把 pkey 存下来（只能读）', async () => {
  const client = fakeClient({
    '/account/qr_state/': { result: { error: 'ok', pkey: 'pk1', profile: { heybox_id: '8899' } } },
    '/bbs/app/api/user/permission': new Error('接口抽风'),
  })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.poll('abc')
  assert.equal(r.status, 'ok')
  assert.equal(r.hasToken, false)
  assert.equal(r.cookie, 'pkey=pk1; user_pkey=pk1; heybox_id=8899; user_heybox_id=8899')
  assert.match(r.message, /只有 pkey/)
})

test('小黑盒扫码：没有 pkey 就别当成功', async () => {
  const client = fakeClient({ '/account/qr_state/': { result: { error: 'ok', profile: { heybox_id: '8899' } } } })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.poll('abc')
  assert.equal(r.status, 'error')
  assert.match(r.message, /pkey/)
})

test('小黑盒扫码：取码时下发的会话 cookie 会带着去问状态', async () => {
  const client = fakeClient({
    '/account/get_qrcode_url/': {
      data: { result: { qr_url: 'https://api.xiaoheihe.cn/account/qr_login/?qr=k1&app=web', expire: 120 } },
      setCookies: ['hb_sess=s1; Path=/; HttpOnly'],
    },
    '/account/qr_state/': { result: { error: 'wait' } },
  })
  const login = createHeyboxQrLogin({ client: client.make })
  await login.start()
  await login.poll('k1')
  assert.equal(client.calls.at(-1).cookie, 'hb_sess=s1')
})

test('小黑盒扫码：pkey 藏在深一层也认得出来（不猜死位置）', async () => {
  const client = fakeClient({
    '/account/qr_state/': {
      result: { error: 'ok', session: { user_pkey: 'pk9', profile: { heybox_id: '4321', nickname: '小鱼' } } },
    },
    '/bbs/app/api/user/permission': { result: { heybox_token: 'tok9' } },
  })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.poll('abc')
  assert.equal(r.status, 'ok')
  assert.match(r.cookie, /pkey=pk9/)
  assert.match(r.cookie, /heybox_id=4321/)
})

test('小黑盒扫码：pkey 只在 Set-Cookie 里发也能接住', async () => {
  const client = fakeClient({
    '/account/qr_state/': {
      data: { result: { error: 'ok', profile: { nickname: '小鱼' } } },
      setCookies: ['pkey=pk7; Path=/; Max-Age=604800', 'heybox_id=1234; Path=/', 'other=1; Path=/'],
    },
    '/bbs/app/api/user/permission': { result: {} },
  })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.poll('abc')
  assert.equal(r.status, 'ok')
  assert.equal(r.cookie, 'pkey=pk7; user_pkey=pk7; heybox_id=1234; user_heybox_id=1234')
})

test('小黑盒扫码：拿不到 pkey 时把接口回了哪些字段带进提示，方便定位', async () => {
  const client = fakeClient({ '/account/qr_state/': { result: { error: 'ok', weird: { token: 'x' }, nickname: '小鱼' } } })
  const login = createHeyboxQrLogin({ client: client.make })
  const r = await login.poll('abc')
  assert.equal(r.status, 'error')
  assert.match(r.message, /weird\.token/)
  assert.match(r.message, /nickname/)
})

test('小黑盒 Cookie 拼装：账号 id 从 profile 兜底取', () => {
  const r = cookieFromLogin({ user_pkey: 'pk2', account_detail: { userid: '7', username: '谁' } })
  assert.equal(r.heyboxId, '7')
  assert.equal(r.pkey, 'pk2')
  assert.equal(r.nickname, '谁')
  assert.match(r.cookie, /pkey=pk2/)
})

test('小黑盒补令牌：只换 x_xhh_tokenid，别的 Cookie 原样留着', () => {
  assert.equal(withHeyboxToken('pkey=pk; heybox_id=1', 'tok'), 'pkey=pk; heybox_id=1; x_xhh_tokenid=tok')
  assert.equal(withHeyboxToken('pkey=pk; x_xhh_tokenid=old; heybox_id=1', 'tok'), 'pkey=pk; heybox_id=1; x_xhh_tokenid=tok')
})

test('小黑盒补令牌：空值或带空格分号的不收（别把 Cookie 弄坏）', () => {
  assert.equal(withHeyboxToken('pkey=pk', ''), '')
  assert.equal(withHeyboxToken('pkey=pk', '   '), '')
  assert.equal(withHeyboxToken('pkey=pk', 'a b'), '')
  assert.equal(withHeyboxToken('pkey=pk', 'a;b'), '')
})
