// 语音条「发了但像是失败」的判定：判成「可能已发出」时不能再补发同样的文字，
// 否则对方会同时收到语音和文字（用户反馈：同一句话收到语音 + 文字两份）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { OneBotError, isMaybeDelivered, createOneBotClient } from '../src/onebot/client.js'

const err = (data, opts) => new OneBotError('send_group_msg', data, opts)

test('判定：等回执超时 → 可能已经发出去了', () => {
  assert.equal(isMaybeDelivered(err({ message: '超时' })), true)
  assert.equal(isMaybeDelivered(new Error('Timeout of 30000ms exceeded')), true)
})

test('判定：QQ 回 241 → 语音其实收到了，不要补发文字', () => {
  assert.equal(isMaybeDelivered(err({ message: 'send group message rejected: result=241 err=' })), true)
})

test('判定：明确没发出去的要照常改发文字', () => {
  assert.equal(isMaybeDelivered(err({ retcode: 100, message: 'record not supported' })), false)
  assert.equal(isMaybeDelivered(err({ message: '连接被拒绝' }, { transport: true })), false) // 连网关都没连上
  assert.equal(isMaybeDelivered(new Error('这条语音里只有表情/符号，没有能念的字')), false)
  assert.equal(isMaybeDelivered(null), false)
})

test('判定：真有一条卡住的网关，超时也能被判成「可能已发出」', async () => {
  // 一个永远不回话的 HTTP 接口，模拟网关收下了但迟迟不给回执
  const server = createServer(() => {})
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address()
  const client = createOneBotClient({
    endpoint: () => ({ httpUrl: `http://127.0.0.1:${port}`, wsUrl: '' }),
    onEvent: () => {},
    log: { info() {}, warn() {}, debug() {} },
    retryDelays: [],
  })
  try {
    await client.call('send_group_msg', { group_id: 1, message: [] }, { timeoutMs: 120, retries: 0 })
      .then(() => assert.fail('不该成功'))
      .catch((e) => {
        assert.match(String(e.message), /超时/)
        assert.equal(isMaybeDelivered(e), true)
      })
  } finally {
    client.stop()
    server.close()
  }
})
