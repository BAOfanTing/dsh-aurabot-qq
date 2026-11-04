// 翻唱接入：走本机网关（say-sing-drawPlugin 的 /sing + /jobs/<id> + /files/<name>）
// 网关存在时不该碰本机 RVC 环境，成品下回来直接当语音条发出去。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalize } from '../src/core/config.js'

process.env.AURABOT_DATA_DIR = mkdtempSync(join(tmpdir(), 'aurabot-song-'))

const { createSongStudio } = await import('../src/song/studio.js')

const silentLog = { info() {}, warn() {}, error() {}, debug() {} }

const waitFor = async (fn, timeoutMs = 8000) => {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

test('翻唱：填了网关地址就算 ready（本机不用装 RVC 环境）', () => {
  const studio = createSongStudio({
    getConfig: () => normalize({ song: { enabled: true, gatewayUrl: 'http://127.0.0.1:8899' } }),
    log: silentLog,
    sendVoiceFile: async () => {},
    sendText: async () => {},
    onSung: () => {},
  })
  const s = studio.status()
  assert.equal(s.gateway, 'http://127.0.0.1:8899')
  assert.equal(s.ready, true)
  assert.equal(s.parts.gateway, true)
  assert.match(s.message, /网关/)
})

test('翻唱：走网关点歌 → 轮询 → 下成品 → 发语音条', async () => {
  const sent = []
  const studio = createSongStudio({
    getConfig: () => normalize({ song: { enabled: true, gatewayUrl: 'http://127.0.0.1:8899', gatewayToken: 'gw-token', maxVoiceSec: 60 } }),
    log: silentLog,
    // 成品文件在 sendVoiceFile 之后会被清掉（keepWork=false），所以在发的这一瞬间查它在不在
    sendVoiceFile: async (chatId, file, title) =>
      sent.push({ chatId, file, title, exists: existsSync(file), size: existsSync(file) ? statSync(file).size : 0 }),
    sendText: async () => {},
    onSung: () => {},
  })

  const calls = []
  let polls = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url)
    calls.push({ url: u, method: init.method || 'GET', auth: init.headers?.authorization, body: init.body })
    if (u.endsWith('/sing')) return Response.json({ ok: true, jobId: 'job1', state: 'queued' })
    if (u.endsWith('/jobs/job1')) {
      polls += 1
      return Response.json(polls < 2 ? { ok: true, state: 'running', stage: '换成她的声音' } : { ok: true, state: 'done', audioUrl: '/files/out.mp3' })
    }
    if (u.endsWith('/files/out.mp3')) {
      const buf = Buffer.alloc(2048)
      buf.write('ID3', 0, 'ascii')
      return new Response(buf, { status: 200, headers: { 'content-type': 'audio/mpeg' } })
    }
    return new Response('unexpected ' + u, { status: 500 })
  }

  try {
    const r = studio.request({ song: '起风了', chatId: 'group:100' })
    assert.equal(r.ok, true)
    assert.ok(await waitFor(() => sent.length > 0), '应该把成品发出去')

    const singCall = calls.find((c) => c.url.endsWith('/sing'))
    assert.ok(singCall, '要打 /sing')
    assert.equal(singCall.method, 'POST')
    assert.equal(singCall.auth, 'Bearer gw-token')
    const body = JSON.parse(singCall.body)
    assert.equal(body.song, '起风了')
    assert.equal(body.maxSeconds, 60)

    const job = sent[0]
    assert.equal(job.chatId, 'group:100')
    assert.match(job.title, /翻唱/)
    assert.ok(job.exists, '发出去的那一刻成品要在本地')
    assert.ok(job.size > 1000)
    assert.equal(sent.length, 1)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('翻唱：网关报失败态时不发语音，改成一句失败说明', async () => {
  const said = []
  const studio = createSongStudio({
    getConfig: () => normalize({ song: { enabled: true, gatewayUrl: 'http://127.0.0.1:8899' } }),
    log: silentLog,
    sendVoiceFile: async () => {
      throw new Error('不该发出去')
    },
    sendText: async (chatId, text) => said.push({ chatId, text }),
    onSung: () => {},
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    if (String(url).endsWith('/sing')) return Response.json({ ok: true, jobId: 'job2' })
    if (String(url).endsWith('/jobs/job2')) return Response.json({ ok: false, state: 'failed', error: '这首没有人声' })
    return new Response('x', { status: 500 })
  }
  try {
    const r = studio.request({ song: '伴奏版', chatId: 'group:1' })
    assert.equal(r.ok, true)
    assert.ok(await waitFor(() => said.length > 0), '失败要回一句话，不能静默')
    assert.match(said[0].text, /唱不了/)
    const h = studio.status().history
    assert.equal(h[0].ok, false)
  } finally {
    globalThis.fetch = realFetch
  }
})
