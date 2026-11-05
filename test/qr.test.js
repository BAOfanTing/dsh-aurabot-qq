// 二维码编码器：验尺寸、定位 / 定时图案、格式信息位置和一份钉住的矩阵（防止改动后画歪）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { qrPng, qrMatrix } from '../src/core/qr.js'

const rows = (m) => m.map((line) => line.map((v) => (v ? '1' : '0')).join(''))

test('二维码：PNG 头、尺寸、留白都对', () => {
  const png = qrPng('AURABOT')
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  // 7 字节 → 版本 1（21 模块）；scale 6 + 四边各留 4 模块 → (21 + 8) * 6
  assert.equal(png.readUInt32BE(16), 174)
  assert.equal(png.readUInt32BE(20), 174)
})

test('二维码：三个定位图案、分隔带、定时图案在标准位置', () => {
  const m = qrMatrix('AURABOT', 0)
  assert.equal(m.length, 21)
  for (const [ox, oy] of [[0, 0], [14, 0], [0, 14]]) {
    for (let y = 0; y < 7; y++) {
      for (let x = 0; x < 7; x++) {
        // 外框一圈黑、往内一圈白、中间 3x3 黑
        const ring = Math.max(Math.abs(x - 3), Math.abs(y - 3))
        assert.equal(m[oy + y][ox + x], ring !== 2, `定位图案 ${ox},${oy} 的 ${x},${y}`)
      }
    }
  }
  // 分隔带（定位图案外侧那一圈）必须是白的
  for (let i = 0; i < 8; i++) {
    assert.equal(m[7][i], false)
    assert.equal(m[i][7], false)
    assert.equal(m[7][20 - i], false)
    assert.equal(m[20 - i][7], false)
  }
  // 定时图案：第 6 行 / 第 6 列黑白交替
  for (let i = 8; i < 13; i++) {
    assert.equal(m[6][i], i % 2 === 0)
    assert.equal(m[i][6], i % 2 === 0)
  }
})

test('二维码：已知内容的矩阵不变（版本 1）', () => {
  assert.deepEqual(rows(qrMatrix('AURABOT', 0)), [
    '111111100101101111111',
    '100000101111001000001',
    '101110100100101011101',
    '101110100110001011101',
    '101110101010101011101',
    '100000100010101000001',
    '111111101010101111111',
    '000000000101100000000',
    '101010100111000010010',
    '101110001100001100000',
    '001101111000100011111',
    '100111001000001100000',
    '101010101100101111101',
    '000000001011010001010',
    '111111100001011110011',
    '100000100101110010001',
    '101110101111011100111',
    '101110100110001101010',
    '101110101010100111101',
    '100000100110001110010',
    '111111101000101010111',
  ])
})

test('二维码：长内容自动升级版本，并摆上对齐图案（版本 4 = 33 模块）', () => {
  const m = qrMatrix('https://example.com/qr?key=0123456789abcdefghij', 0)
  assert.equal(m.length, 33)
  // 版本 4 对齐图案中心在 (26,26)：中心黑、外一圈白、再外一圈黑
  assert.equal(m[26][26], true)
  assert.equal(m[25][26], false)
  assert.equal(m[24][26], true)
})

test('二维码：内容太长要报错，别画出一张错码', () => {
  assert.throws(() => qrPng('x'.repeat(400)), /画不下/)
})
