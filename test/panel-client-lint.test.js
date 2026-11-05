// 面板前端（client/client.js）没有渲染测试，改一个组件时很容易「用了没声明的 state setter」，
// 只有在面板上点到那一页才炸（错误边界会显示「这一页出错了」）。这条静态检查专门兜这一类：
// 把所有 setXxx(...) 的用法和文件里所有 useState / const / 函数参数里的 setXxx 声明对一遍。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'client', 'client.js')
const GLOBALS = new Set(['setInterval', 'setTimeout', 'setImmediate'])

test('面板前端：用到的 setXxx 都有声明（不会只在点开那一页时才炸）', () => {
  const src = readFileSync(FILE, 'utf8')
  const declared = new Set([
    ...[...src.matchAll(/\bconst\s+\[[^\]]*?,\s*(set[A-Z]\w*)\s*\]\s*=\s*useState/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bconst\s+(set[A-Z]\w*)\s*=/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bfunction\s+\w+\s*\(([^)]*)\)/g)].flatMap((m) => [...m[1].matchAll(/\b(set[A-Z]\w*)\b/g)].map((x) => x[1])),
    ...[...src.matchAll(/\bconst\s+\{([^}]*)\}\s*=/g)].flatMap((m) => [...m[1].matchAll(/\b(set[A-Z]\w*)\b/g)].map((x) => x[1])),
  ])
  const used = new Set([...src.matchAll(/(?<![.\w])(set[A-Z]\w*)\s*\(/g)].map((m) => m[1]))
  const missing = [...used].filter((name) => !declared.has(name) && !GLOBALS.has(name))
  assert.deepEqual(missing, [], '这些 setter 在 client.js 里找不到声明：' + missing.join(', '))
})
