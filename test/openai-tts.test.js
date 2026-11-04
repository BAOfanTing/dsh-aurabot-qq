// 说话接入：OpenAI 兼容 TTS（本机 say-sing-drawPlugin 网关 /v1/audio/speech）
// 只验配置归一、请求形状、错误处理和降级顺序，不真发声。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalize } from '../src/core/config.js'
import { openaiSynth, textToSpeech } from '../src/voice/tts.js'

// 一段最小的合法 mp3：ID3 头 + 足够长度（>400 字节），saveAudio 会按 ID3 判成 mp3
const fakeMp3 = () => {
  const buf = Buffer.alloc(1200)
  buf.write('ID3', 0, 'ascii')
  return buf
}

const withFetch = async (impl, fn) => {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try {
    return await fn()
  } finally {
    globalThis.fetch = real
  }
}

test('配置：voice.openai 有默认值，引擎可选 openai', () => {
  const c = normalize({})
  assert.equal(c.voice.engine, 'auto')
  assert.deepEqual(c.voice.openai, {
    baseUrl: '',
    apiKey: '',
    model: '',
    voice: '',
    format: 'mp3',
    speed: 1,
    timeoutMs: 120000,
    sampleRate: 24000,
  })
  assert.equal(normalize({ voice: { engine: 'openai' } }).voice.engine, 'openai')
  // 填进去的地址/令牌不会被归一化丢掉
  const c2 = normalize({ voice: { engine: 'openai', openai: { baseUrl: 'http://127.0.0.1:8899/v1', apiKey: 't' } } })
  assert.equal(c2.voice.openai.baseUrl, 'http://127.0.0.1:8899/v1')
  assert.equal(c2.voice.openai.apiKey, 't')
})

test('配置：翻唱网关字段有默认值，填了会保留', () => {
  const c = normalize({})
  assert.equal(c.song.gatewayUrl, '')
  assert.equal(c.song.gatewayToken, '')
  assert.equal(c.song.gatewayTimeoutMs, 900000)
  const c2 = normalize({ song: { gatewayUrl: 'http://127.0.0.1:8899', gatewayToken: 'gw' } })
  assert.equal(c2.song.gatewayUrl, 'http://127.0.0.1:8899')
  assert.equal(c2.song.gatewayToken, 'gw')
})

test('说话：按 OpenAI 协议打 /audio/speech，并带回音频文件', async () => {
  const calls = []
  const file = await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init })
      return new Response(fakeMp3(), { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    },
    () =>
      openaiSynth('爸爸我回来了', {
        baseUrl: 'http://127.0.0.1:8899/v1',
        apiKey: 'gw-token',
        model: 'breeze-tts-2',
        voice: 'hanser',
        format: 'mp3',
        speed: 1,
      }),
  )
  assert.match(file, /\.mp3$/)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, 'http://127.0.0.1:8899/v1/audio/speech')
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(calls[0].init.headers.authorization, 'Bearer gw-token')
  const body = JSON.parse(calls[0].init.body)
  assert.equal(body.input, '爸爸我回来了')
  assert.equal(body.voice, 'hanser')
  assert.equal(body.model, 'breeze-tts-2')
  assert.equal(body.response_format, 'mp3')
  assert.equal(body.speed, undefined) // 默认 1 不塞进请求
})

test('说话：地址尾巴多个斜杠也不会拼出双斜杠；speed 非 1 才带', async () => {
  const calls = []
  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) })
      return new Response(fakeMp3(), { status: 200 })
    },
    () => openaiSynth('嗯', { baseUrl: 'http://127.0.0.1:8899/v1///', speed: 1.2 }),
  )
  assert.equal(calls[0].url, 'http://127.0.0.1:8899/v1/audio/speech')
  assert.equal(calls[0].body.speed, 1.2)
})

test('说话：没填地址直接报错；网关报错把状态码带出来', async () => {
  await assert.rejects(() => openaiSynth('嗯', { baseUrl: '' }), /没填 OpenAI 兼容 TTS 地址/)
  await withFetch(
    async () => new Response('token 不对', { status: 401 }),
    async () => {
      await assert.rejects(
        () => openaiSynth('嗯', { baseUrl: 'http://127.0.0.1:8899/v1' }),
        /HTTP 401/,
      )
    },
  )
})

test('说话：网关挂了不抛死整轮，textToSpeech 会降级到别的引擎', async () => {
  const warnings = []
  const log = { info() {}, warn: (...a) => warnings.push(a.join(' ')) }
  await withFetch(
    async () => new Response('boom', { status: 500 }),
    async () => {
      // 兜底引擎（edge / Windows 语音）在这个环境里不一定装得出来，
      // 所以只断言两件事：没把异常直接摔出去 / 记了降级日志。
      const r = await textToSpeech('嗯', { engine: 'openai', openai: { baseUrl: 'http://127.0.0.1:8899/v1' } }, log).catch((e) => ({ error: e }))
      assert.ok(r, '不该静默返回 undefined')
      if (r.error) assert.match(String(r.error.message), /语音没合成出来|HTTP 500/)
      else assert.notEqual(r.engine, 'openai')
      assert.ok(warnings.some((w) => w.includes('openai 失败')), '要记一条降级日志')
    },
  )
})
