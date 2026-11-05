// 「拿聊天里最近那张图当参考」：请求体透传 + 工具侧取图 / 失败时的说法。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-chat-image-'))

const { createImageGen, customRequest } = await import('../src/features/imagegen.js')
const { normalize } = await import('../src/core/config.js')
const imagegenModule = (await import('../src/modules/imagegen/index.js')).default

const log = { info() {}, debug() {}, warn() {} }
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)])
const DATA_URL = 'data:image/png;base64,' + PNG.toString('base64')
const config = (extra = {}) => normalize({ imageGen: { enabled: true, provider: 'openai', baseUrl: 'https://image.example/v1', model: 'image-test', size: '1024x1024', ...extra } })

// ── 请求体 ────────────────────────────────────────────────
test('OpenAI 兼容：带参考图时请求体多一个 image（data URI 原样），不带时字段不出现', async (t) => {
  const seen = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    seen.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  const gen = createImageGen({ getConfig: () => config(), log })
  await gen.generate('照着这张改成水彩', { image: DATA_URL })
  assert.equal(seen[0].image, DATA_URL)
  await gen.generate('一只猫')
  assert.equal('image' in seen[1], false, '没参考图就别塞 image 字段，接口可能不认')
})

test('自定义接口：参数值里能写 {image}；没有参考图时占位符原样留着', () => {
  const c = config({
    provider: 'custom',
    custom: {
      method: 'POST',
      url: 'https://image.example/gen',
      params: [{ key: 'init_image', value: '{image}' }, { key: 'prompt', value: '{prompt}' }],
    },
  })
  const withImage = customRequest(c.imageGen, '猫', DATA_URL)
  assert.equal(JSON.parse(withImage.body).init_image, DATA_URL)
  const without = customRequest(c.imageGen, '猫')
  assert.equal(JSON.parse(without.body).init_image, '{image}')
})

test('订阅接法不支持参考图：直接说清楚，不去发请求', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(PNG) })
  const gen = createImageGen({ getConfig: () => config({ provider: 'codex' }), log })
  await assert.rejects(() => gen.generate('照着画', { image: DATA_URL }), /不支持拿图当参考/)
  assert.equal(calls, 0)
})

// ── 工具侧 ────────────────────────────────────────────────
function makeTool ({ recent = [], chatImage = true, onebot = { call: async () => ({}) } } = {}) {
  let build
  const c = config({ chatImage })
  const sent = []
  imagegenModule.setup({
    config: () => c,
    log,
    dsh: {},
    lazy: () => ({}),
    route() {},
    tool: (fn) => { build = fn },
    core: {
      onebot,
      local: { active: () => false },
      hub: {
        recentMedia: () => recent,
        turnSendersAllOwner: () => true,
        sendSegments: async (chatId, segs) => { sent.push(segs); return { message_id: 1 } },
        canSeeImages: async () => false,
      },
    },
  })
  const tool = build({ chat: { kind: 'private', chatId: 'private:10001', userId: '10001' }, sessionId: 'chat-image-test' })
  return { tool, sent, c }
}

test('工具：useChatImage 把这条聊天最近那张图当参考发出去', async (t) => {
  const bodies = []
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    bodies.push(JSON.parse(init.body))
    return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] }))
  })
  const seg = { type: 'image', data: { url: 'base64://' + PNG.toString('base64') } }
  const { tool } = makeTool({ recent: [{ seg, userId: '10001', sticker: false }] })
  assert.equal(tool.parameters.properties.useChatImage.type, 'boolean')
  const out = await tool.execute({ prompt: '照着改成水彩风', useChatImage: true })
  assert.equal(out.ok, true, out.message)
  assert.equal(out.usedChatImage, true)
  assert.match(bodies[0].image, /^data:image\/png;base64,/)
})

test('工具：这条聊天最近没图就说清楚，不硬画', async (t) => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ data: [{ b64_json: PNG.toString('base64') }] })) })
  const { tool } = makeTool({ recent: [] })
  const out = await tool.execute({ prompt: '照着画', useChatImage: true })
  assert.equal(out.ok, false)
  assert.match(out.message, /最近半小时没发过图/)
  assert.equal(calls, 0)
})

test('工具：面板关掉「照着聊天里的图画」时拒绝，并说明原因', async () => {
  const seg = { type: 'image', data: { url: 'base64://' + PNG.toString('base64') } }
  const { tool } = makeTool({ recent: [{ seg, userId: '10001', sticker: false }], chatImage: false })
  const out = await tool.execute({ prompt: '照着画', useChatImage: true })
  assert.equal(out.ok, false)
  assert.match(out.message, /面板里关掉了/)
})

test('工具：图取不到（地址过期）时给一句能说出口的话，不崩', async () => {
  const seg = { type: 'image', data: { url: '', file: '' } }
  const { tool } = makeTool({
    recent: [{ seg, userId: '10001', sticker: false }],
    onebot: { call: async () => { throw new Error('boom') } },
  })
  const out = await tool.execute({ prompt: '照着画', useChatImage: true })
  assert.equal(out.ok, false)
  assert.match(out.message, /取不到了/)
})
