// 极简二维码编码器：把一段文字画成 PNG，给扫码登录用。
// 只做字节模式 + 纠错级别 M + 版本 1~10（登录链接一百来个字符，够用），不引第三方依赖。

import { deflateSync } from 'node:zlib'

// 版本 → 纠错码字数 / 分块（[块数, 每块数据码字数]），纠错级别 M
const VERSIONS = {
  1: { ec: 10, blocks: [[1, 16]] },
  2: { ec: 16, blocks: [[1, 28]] },
  3: { ec: 26, blocks: [[1, 44]] },
  4: { ec: 18, blocks: [[2, 32]] },
  5: { ec: 24, blocks: [[2, 43]] },
  6: { ec: 16, blocks: [[4, 27]] },
  7: { ec: 18, blocks: [[4, 31]] },
  8: { ec: 22, blocks: [[2, 38], [2, 39]] },
  9: { ec: 22, blocks: [[3, 36], [2, 37]] },
  10: { ec: 26, blocks: [[4, 43], [1, 44]] },
}

// 版本 → 对齐图案中心坐标
const ALIGN = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
}

// GF(256)，本原多项式 0x11d
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}
const gfMul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0)

/** 生成多项式（次数 n，最高次项系数在前）。 */
function genPoly(n) {
  let g = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0)
    for (let j = 0; j < g.length; j++) {
      next[j] ^= g[j]
      next[j + 1] ^= gfMul(g[j], EXP[i])
    }
    g = next
  }
  return g
}

/** 一段数据的纠错码字。 */
function rsRemainder(data, degree) {
  const gen = genPoly(degree)
  const rem = new Array(degree).fill(0)
  for (const byte of data) {
    const factor = byte ^ rem[0]
    rem.shift()
    rem.push(0)
    for (let i = 0; i < degree; i++) rem[i] ^= gfMul(gen[i + 1], factor)
  }
  return rem
}

const capacity = (v) => VERSIONS[v].blocks.reduce((n, [count, size]) => n + count * size, 0)

function pickVersion(len) {
  for (let v = 1; v <= 10; v++) {
    const header = 4 + (v >= 10 ? 16 : 8)
    if (header + len * 8 <= capacity(v) * 8) return v
  }
  throw new Error(`内容太长（${len} 字节），二维码画不下`)
}

/** 文字 → 交织好的码字。 */
function codewords(text) {
  const bytes = new TextEncoder().encode(text)
  const version = pickVersion(bytes.length)
  const bits = []
  const push = (value, width) => { for (let i = width - 1; i >= 0; i--) bits.push((value >> i) & 1) }
  push(0b0100, 4) // 字节模式
  push(bytes.length, version >= 10 ? 16 : 8)
  for (const b of bytes) push(b, 8)
  const total = capacity(version) * 8
  push(0, Math.min(4, total - bits.length)) // 终止符
  while (bits.length % 8) bits.push(0)
  const data = []
  for (let i = 0; i < bits.length; i += 8) data.push(Number.parseInt(bits.slice(i, i + 8).join(''), 2))
  for (let i = 0; data.length < total / 8; i++) data.push(i % 2 ? 0x11 : 0xec)

  const { ec, blocks } = VERSIONS[version]
  const chunks = []
  let at = 0
  for (const [count, size] of blocks) {
    for (let i = 0; i < count; i++) {
      chunks.push(data.slice(at, at + size))
      at += size
    }
  }
  const ecc = chunks.map((c) => rsRemainder(c, ec))
  const out = []
  const widest = Math.max(...chunks.map((c) => c.length))
  for (let i = 0; i < widest; i++) for (const c of chunks) if (i < c.length) out.push(c[i])
  for (let i = 0; i < ec; i++) for (const c of ecc) out.push(c[i])
  return { version, words: out }
}

const MASKS = [
  (x, y) => (x + y) % 2 === 0,
  (x, y) => y % 2 === 0,
  (x, y) => x % 3 === 0,
  (x, y) => (x + y) % 3 === 0,
  (x, y) => (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0,
  (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
  (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
  (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
]

/** 格式信息（15 位）：纠错级别 M + 掩码号，带 BCH 校验。 */
function formatBits(mask) {
  const data = (0 << 3) | mask // 级别 M 的两位是 00
  let rem = data << 10
  for (let i = 4; i >= 0; i--) if ((rem >> (i + 10)) & 1) rem ^= 0x537 << i
  return ((data << 10) | rem) ^ 0x5412
}

/** 版本信息（18 位，版本 7 起才有）。 */
function versionBits(version) {
  let rem = version << 12
  for (let i = 5; i >= 0; i--) if ((rem >> (i + 12)) & 1) rem ^= 0x1f25 << i
  return (version << 12) | rem
}

/** 画矩阵（含功能图案、数据、格式信息），返回布尔表，true = 黑块。 */
function buildMatrix(text, mask) {
  const { version, words } = codewords(text)
  const size = 17 + version * 4
  const dark = Array.from({ length: size }, () => new Array(size).fill(false))
  const fixed = Array.from({ length: size }, () => new Array(size).fill(false))
  const put = (x, y, on) => { dark[y][x] = on; fixed[y][x] = true }

  // 三个定位图案（含分隔带）
  const finder = (ox, oy) => {
    for (let dy = -1; dy <= 7; dy++) {
      for (let dx = -1; dx <= 7; dx++) {
        const x = ox + dx
        const y = oy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const ring = Math.max(Math.abs(dx - 3), Math.abs(dy - 3))
        // 圈 0/1 = 中间 3x3 黑块，圈 2 = 白，圈 3 = 黑边，圈 4 = 分隔带（白）
        put(x, y, ring !== 2 && ring !== 4)
      }
    }
  }
  finder(0, 0)
  finder(size - 7, 0)
  finder(0, size - 7)

  // 定时图案
  for (let i = 8; i < size - 8; i++) {
    put(i, 6, i % 2 === 0)
    put(6, i, i % 2 === 0)
  }

  // 对齐图案（避开三个定位图案）
  for (const cx of ALIGN[version]) {
    for (const cy of ALIGN[version]) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) put(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    }
  }

  // 格式信息（先按真实值写，掩码由调用方决定）
  const fmt = formatBits(mask)
  for (let i = 0; i < 15; i++) {
    const on = ((fmt >> i) & 1) === 1
    // 竖着那一份（第 8 列）
    if (i < 6) put(8, i, on)
    else if (i < 8) put(8, i + 1, on)
    else put(8, size - 15 + i, on)
    // 横着那一份（第 8 行）
    if (i < 8) put(size - 1 - i, 8, on)
    else if (i === 8) put(7, 8, on)
    else put(14 - i, 8, on)
  }
  put(8, size - 8, true) // 固定暗块

  // 版本信息（版本 7 起）
  if (version >= 7) {
    const ver = versionBits(version)
    for (let i = 0; i < 18; i++) {
      const on = ((ver >> i) & 1) === 1
      const a = size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      put(a, b, on)
      put(b, a, on)
    }
  }

  // 数据：从右下角起，两列一组蛇形填
  const maskFn = MASKS[mask]
  let bitIndex = 0
  const totalBits = words.length * 8
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 跳过定时图案那一列
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (fixed[y][x]) continue
        let on = false
        if (bitIndex < totalBits) {
          on = ((words[bitIndex >> 3] >> (7 - (bitIndex & 7))) & 1) === 1
          bitIndex++
        }
        dark[y][x] = on !== maskFn(x, y)
      }
    }
  }
  return dark
}

/** 掩码打分（规则 1~4），分越低越好扫。 */
function penalty(m) {
  const size = m.length
  let score = 0
  const runScore = (line) => {
    let s = 0
    let run = 1
    for (let i = 1; i < line.length; i++) {
      if (line[i] === line[i - 1]) run++
      else {
        if (run >= 5) s += run - 2
        run = 1
      }
    }
    if (run >= 5) s += run - 2
    return s
  }
  for (let y = 0; y < size; y++) score += runScore(m[y])
  for (let x = 0; x < size; x++) score += runScore(m.map((row) => row[x]))
  // 2x2 同色块
  for (let y = 0; y < size - 1; y++) {
    for (let x = 0; x < size - 1; x++) {
      const v = m[y][x]
      if (v === m[y][x + 1] && v === m[y + 1][x] && v === m[y + 1][x + 1]) score += 3
    }
  }
  // 类似定位图案的 1:1:3:1:1
  const pattern = [true, false, true, true, true, false, true]
  const hitPattern = (line) => {
    let s = 0
    for (let i = 0; i + 7 <= line.length; i++) {
      let ok = true
      for (let j = 0; j < 7; j++) if (line[i + j] !== pattern[j]) { ok = false; break }
      if (!ok) continue
      const before = i >= 4 && line.slice(i - 4, i).every((v) => v === false)
      const after = i + 11 <= line.length && line.slice(i + 7, i + 11).every((v) => v === false)
      if (before || after) s += 40
    }
    return s
  }
  for (let y = 0; y < size; y++) score += hitPattern(m[y])
  for (let x = 0; x < size; x++) score += hitPattern(m.map((row) => row[x]))
  // 黑白比例
  const darkCount = m.reduce((n, row) => n + row.filter(Boolean).length, 0)
  const ratio = (darkCount * 100) / (size * size)
  score += Math.floor(Math.abs(ratio - 50) / 5) * 10
  return score
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

/**
 * 把一段文字画成 PNG（8 位灰度）。
 * @param {string} text 内容
 * @param {{scale?: number, margin?: number}} [opts] 每模块几像素、四周留几模块
 * @returns {Buffer}
 */
export function qrPng(text, { scale = 6, margin = 4 } = {}) {
  const best = Array.from({ length: 8 }, (_, mask) => buildMatrix(text, mask))
    .map((m) => ({ m, score: penalty(m) }))
    .sort((a, b) => a.score - b.score)[0].m
  const size = best.length
  const side = (size + margin * 2) * scale
  const raw = Buffer.alloc((side + 1) * side, 255)
  for (let y = 0; y < side; y++) raw[y * (side + 1)] = 0 // 每行的 filter 字节
  for (let my = 0; my < size; my++) {
    for (let mx = 0; mx < size; mx++) {
      if (!best[my][mx]) continue
      for (let dy = 0; dy < scale; dy++) {
        const rowStart = (margin + my) * scale + dy
        const off = rowStart * (side + 1) + 1 + (margin + mx) * scale
        raw.fill(0, off, off + scale)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(side, 0)
  ihdr.writeUInt32BE(side, 4)
  ihdr[8] = 8 // 位深
  ihdr[9] = 0 // 灰度
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 画成给面板 <img src> 用的 data URL。 */
export function qrDataUrl(text, opts) {
  return 'data:image/png;base64,' + qrPng(text, opts).toString('base64')
}

/** 调试 / 测试用：某个掩码下的矩阵（true = 黑块），不画图。 */
export function qrMatrix(text, mask = 0) {
  return buildMatrix(text, mask)
}
