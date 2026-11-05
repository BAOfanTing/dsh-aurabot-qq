// 小黑盒定时任务：`tick` 里那道「有没有登录」的闸。
// 回归：这里原来调了一个从没定义过的 hasLogin()，因为小黑盒默认关着、短路一直没走到，
// 一旦打开「定时自己去逛」就会每分钟报 hasLogin is not defined。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HOME = mkdtempSync(join(tmpdir(), 'aurabot-heybox-tick-'))
process.env.USERPROFILE = HOME // site.js 在加载时就把 HOME 定下来了，所以要先设再 import
process.env.HOME = HOME
const { createHeybox } = await import('../src/heybox/site.js')

const quiet = { info() {}, warn() {}, debug() {}, error() {} }

function setup(cookie) {
  const turns = []
  const cfg = {
    heybox: { enabled: true, autoBrowse: true, cookie, intervalHours: 4, maxRunsPerDay: 3, perRun: 3 },
    ownerName: '爸爸',
  }
  const hb = createHeybox({
    getConfig: () => cfg,
    hub: { runSystemTurn: async (id, title, prompt) => { turns.push({ id, title, prompt }); return '看了几个帖子' } },
    memory: null,
    log: quiet,
  })
  return { hb, cfg, turns }
}

test('小黑盒定时：没登录就别跑（不会炸 ReferenceError）', async () => {
  const { hb, turns } = setup('')
  await hb.tick({})
  assert.equal(turns.length, 0)
})

test('小黑盒定时：有 pkey 就跑一轮后台会话，跑完记额度', async () => {
  const { hb, turns } = setup('pkey=pk1; heybox_id=9')
  await hb.tick({ owner: '爸爸' })
  assert.equal(turns.length, 1)
  assert.equal(turns[0].id, 'heybox')
  assert.equal(hb.state().quota.browse >= 1, true)
})
