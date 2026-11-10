// TIFF と BigTIFF (MarumaSign 本体の image/format/TiffDecoder.java と同じ)。
// ストリップとタイル、非圧縮・LZW・Deflate・PackBits・JPEG・Zstandard、1 から 64 ビットの整数と浮動小数点、
// グレー・RGB・色の一覧・CMYK・YCbCr、予測 (差分)、色の面ごとの並び (planar) に対応する。
// DNG などの RAW 形式は、中に入っている読める絵のうち最も大きいものを使う。
// Deflate はブラウザーの DecompressionStream、JPEG は jpeg-js、Zstandard は fzstd (どちらも要るときだけ読み込む)
/// <reference path="./vendor.d.ts" />
import { allocate, type Pixels } from './raster.ts'

const MAX_RAW = 256 * 1024 * 1024
const TYPE_SIZE = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4, 0, 0, 8, 8, 8]
// 画像を読むのに使う項目
const NEEDED = new Set([254, 256, 257, 258, 259, 262, 266, 273, 274, 277, 278, 279, 284, 317, 320, 322, 323, 324, 325, 330, 338, 339, 347])
const COMPRESSIONS = new Set([1, 5, 7, 8, 32946, 32773, 50000])

export function looksLikeTiff(h: Uint8Array): boolean {
  if (h.length < 8) return false
  const ii = h[0] === 0x49 && h[1] === 0x49, mm = h[0] === 0x4D && h[1] === 0x4D
  if (!ii && !mm) return false
  const version = ii ? h[2]! | (h[3]! << 8) : (h[2]! << 8) | h[3]!
  return version === 42 || version === 43
}

type Ifd = Map<number, number[]>

function get(ifd: Ifd, tag: number, fallback: number): number {
  const v = ifd.get(tag)
  return v && v.length ? v[0]! : fallback
}

class Tiff {
  readonly d: Uint8Array
  readonly little: boolean
  readonly big: boolean
  private readonly dv: DataView

  constructor(d: Uint8Array) {
    this.d = d
    this.little = d[0] === 0x49
    this.big = (this.little ? d[2] : d[3]) === 43
    this.dv = new DataView(d.buffer, d.byteOffset, d.byteLength)
  }

  u16(p: number): number {
    return this.dv.getUint16(p, this.little)
  }

  u32(p: number): number {
    return this.dv.getUint32(p, this.little)
  }

  u64(p: number): number {
    const a = this.u32(p), b = this.u32(p + 4)
    return this.little ? a + b * 4294967296 : b + a * 4294967296
  }

  /** IFD を読んで、次の IFD の位置を返す */
  readIfd(offset: number, ifd: Ifd): number {
    const d = this.d, big = this.big
    const countSize = big ? 8 : 2, entrySize = big ? 20 : 12, inline = big ? 8 : 4
    if (offset + countSize > d.length) throw new Error('invalid tiff directory')
    const count = big ? this.u64(offset) : this.u16(offset)
    if (count > 4096 || offset + countSize + count * entrySize > d.length) throw new Error('invalid tiff directory')
    for (let i = 0; i < count; i++) {
      const entry = offset + countSize + i * entrySize
      const tag = this.u16(entry), type = this.u16(entry + 2)
      const n = big ? this.u64(entry + 4) : this.u32(entry + 4)
      if (type < 1 || type >= TYPE_SIZE.length || TYPE_SIZE[type] === 0 || !NEEDED.has(tag)) continue
      // 有理数や小数の項目は、画像を読むのには使わない
      if (type === 5 || type === 10 || type === 11 || type === 12) continue
      const size = TYPE_SIZE[type]!
      const total = n * size
      if (n > (1 << 22) || total > d.length) continue
      const field = entry + (big ? 12 : 8)
      const where = total <= inline ? field : (big ? this.u64(field) : this.u32(field))
      if (where + total > d.length) continue
      if (tag === 347) {
        // JPEG の共通の表は、バイト列のまま残す (位置と長さ)
        ifd.set(-347, [where, n])
        continue
      }
      const values = new Array<number>(n)
      for (let k = 0; k < n; k++) {
        const p = where + k * size
        switch (type) {
          case 1: case 2: case 7: values[k] = d[p]!; break
          case 6: values[k] = (d[p]! << 24) >> 24; break
          case 3: values[k] = this.u16(p); break
          case 8: values[k] = (this.u16(p) << 16) >> 16; break
          case 4: case 13: values[k] = this.u32(p); break
          case 9: values[k] = this.u32(p) | 0; break
          default: values[k] = this.u64(p); break
        }
      }
      ifd.set(tag, values)
    }
    const next = offset + countSize + count * entrySize
    if (next + (big ? 8 : 4) > d.length) return 0
    return big ? this.u64(next) : this.u32(next)
  }
}

/** TIFF を RGBA にする */
export async function decodeTiff(d: Uint8Array): Promise<Pixels> {
  if (!looksLikeTiff(d)) throw new Error('not a tiff image')
  const t = new Tiff(d)
  const ifds: Ifd[] = []
  const seen = new Set<number>()
  let offset = t.big ? t.u64(8) : t.u32(4)
  while (offset > 0 && offset < d.length && ifds.length < 64 && !seen.has(offset)) {
    seen.add(offset)
    const ifd: Ifd = new Map()
    offset = t.readIfd(offset, ifd)
    ifds.push(ifd)
    const subs = ifd.get(330)
    if (subs) {
      for (let i = 0; i < subs.length && i < 8; i++) {
        const s = subs[i]!
        if (s > 0 && s < d.length && !seen.has(s)) {
          seen.add(s)
          const sub: Ifd = new Map()
          t.readIfd(s, sub)
          ifds.push(sub)
        }
      }
    }
  }
  if (!ifds.length) throw new Error('tiff has no image')
  // 普通の TIFF なら最初の絵。RAW の縮小した絵や、読めない絵のときは、読める中でいちばん大きいものを使う
  let failure: unknown = null
  const head = ifds[0]!
  const raw = (ifd: Ifd): boolean => [32803, 34892].includes(get(ifd, 262, 1))
  if ((get(head, 254, 0) & 1) === 0 && !raw(head)) {
    try {
      return await decodeIfd(t, head)
    }
    catch (e) {
      failure = e
    }
  }
  let best: Ifd | null = null
  let bestArea = -1
  for (const ifd of ifds) {
    const area = get(ifd, 256, 0) * get(ifd, 257, 0)
    if (area > bestArea && !raw(ifd) && get(ifd, 262, 1) !== 32892) {
      best = ifd
      bestArea = area
    }
  }
  if (!best) throw failure ?? new Error('tiff has no readable image')
  try {
    return await decodeIfd(t, best)
  }
  catch (e) {
    throw failure ?? e
  }
}

function checkedProduct(a: number, b: number, limit: number): number {
  const p = a * b
  if (a < 0 || b < 0 || p > limit) throw new Error('image data is too large')
  return p
}

async function decodeIfd(t: Tiff, ifd: Ifd): Promise<Pixels> {
  const d = t.d
  const w = get(ifd, 256, 0), h = get(ifd, 257, 0)
  allocate(w, h) // 大きさを確かめる
  const compression = get(ifd, 259, 1)
  const photometric = get(ifd, 262, 1)
  const spp = get(ifd, 277, 1)
  const planar = get(ifd, 284, 1) === 2
  const predictor = get(ifd, 317, 1)
  const sampleFormat = get(ifd, 339, 1)
  const bpsArray = ifd.get(258)
  const bps = bpsArray && bpsArray.length ? bpsArray[0]! : 1
  if (spp < 1 || spp > 16) throw new Error('unsupported tiff samples per pixel: ' + spp)
  if (bpsArray && bpsArray.some(v => v !== bps)) throw new Error('unsupported tiff: mixed bits per sample')
  if (bps < 1 || bps > 64 || (bps > 8 && bps % 8 !== 0 && bps !== 12)) throw new Error('unsupported tiff bits per sample: ' + bps)
  if (sampleFormat === 3 && bps !== 16 && bps !== 32 && bps !== 64) throw new Error('unsupported tiff float size')
  if (bps === 64 && sampleFormat !== 3) throw new Error('unsupported tiff 64-bit integers')
  if (photometric === 6 && compression !== 7 && compression !== 34892) throw new Error('unsupported tiff ycbcr')
  if (![0, 1, 2, 3, 5, 6].includes(photometric)) throw new Error('unsupported tiff photometric: ' + photometric)
  if (!COMPRESSIONS.has(compression)) throw new Error('unsupported tiff compression: ' + compression)

  const tiled = ifd.has(324)
  const offsets = tiled ? ifd.get(324) : ifd.get(273)
  const counts = tiled ? ifd.get(325) : ifd.get(279)
  if (!offsets) throw new Error('tiff has no image data')
  const chunkWidth = tiled ? get(ifd, 322, 0) : w
  const rowsPerStrip = get(ifd, 278, h)
  const chunkHeight = tiled ? get(ifd, 323, 0) : Math.max(1, Math.min(rowsPerStrip, h))
  if (tiled && (chunkWidth <= 0 || chunkHeight <= 0 || chunkWidth > 16384 || chunkHeight > 16384)) throw new Error('invalid tiff tile size')

  // 1 つの面に入っているサンプルの数 (色が面ごとに分かれているときは 1)
  const perPixel = planar ? 1 : spp
  const planes = planar ? spp : 1
  const rowBytes = checkedProduct(Math.ceil(w * perPixel * bps / 8), 1, MAX_RAW)
  const imageBytes = checkedProduct(rowBytes, h, MAX_RAW / planes)
  const image: Uint8Array[] = Array.from({ length: planes }, () => new Uint8Array(imageBytes))
  const across = Math.ceil(w / chunkWidth), down = Math.ceil(h / chunkHeight)
  const perPlane = across * down
  if (perPlane * planes > offsets.length) throw new Error('tiff is missing image data')
  const reverseBits = get(ifd, 266, 1) === 2
  const chunkRowBytes = Math.ceil(chunkWidth * perPixel * bps / 8)
  const tables = compression === 7 ? jpegTables(d, ifd) : null

  for (let plane = 0; plane < planes; plane++) {
    for (let index = 0; index < perPlane; index++) {
      const chunk = plane * perPlane + index
      const start = offsets[chunk]!
      let length = counts && chunk < counts.length ? counts[chunk]! : d.length - start
      if (start < 0 || start >= d.length) throw new Error('invalid tiff strip offset')
      if (start + length > d.length) length = d.length - start
      const tx = index % across, ty = Math.floor(index / across)
      const rows = tiled ? chunkHeight : Math.min(chunkHeight, h - ty * chunkHeight)
      const expected = checkedProduct(chunkRowBytes, rows, MAX_RAW)
      let raw = await unpack(t, compression, start, length, expected, perPixel, chunkWidth, rows, tables, reverseBits)
      if (raw.length < expected) {
        const full = new Uint8Array(expected)
        full.set(raw)
        raw = full
      }
      if (predictor === 2) horizontal(t.little, raw, chunkWidth, rows, perPixel, bps)
      else if (predictor === 3) floating(t.little, raw, chunkWidth, rows, perPixel, bps)
      const y0 = ty * chunkHeight
      const xByte = tiled ? tx * chunkRowBytes : 0
      const copy = Math.min(chunkRowBytes, rowBytes - xByte)
      for (let r = 0; r < rows && y0 + r < h; r++) {
        image[plane]!.set(raw.subarray(r * chunkRowBytes, r * chunkRowBytes + copy), (y0 + r) * rowBytes + xByte)
      }
    }
  }
  const px = convert(t.little, ifd, image, w, h, spp, planar, bps, sampleFormat, photometric, rowBytes)
  return orient(get(ifd, 274, 1), px)
}

// ---------------------------------------------------------------- 展開

async function unpack(t: Tiff, compression: number, start: number, length: number, expected: number, perPixel: number,
  width: number, rows: number, tables: Uint8Array | null, reverseBits: boolean): Promise<Uint8Array> {
  const d = t.d
  let src = d.subarray(start, start + length)
  if (reverseBits) {
    // 1 バイトの中のビットの並びが逆 (FillOrder 2)
    const copy = new Uint8Array(src.length)
    for (let i = 0; i < src.length; i++) copy[i] = REVERSED[src[i]!]!
    src = copy
  }
  switch (compression) {
    case 1: return src.slice(0, Math.min(src.length, expected))
    case 5: return lzw(src, expected)
    case 8: case 32946: return inflate(src, expected)
    case 32773: return packBits(src, expected)
    case 50000: {
      const { decompress } = await import('fzstd')
      const out = decompress(src)
      return out.length > expected ? out.subarray(0, expected) : out
    }
    case 7: return jpeg(src, tables, expected, width, rows, perPixel)
    default: throw new Error('unsupported tiff compression: ' + compression)
  }
}

const REVERSED = (() => {
  const t = new Uint8Array(256)
  for (let i = 0; i < 256; i++) {
    let v = 0
    for (let b = 0; b < 8; b++) if (i & (1 << b)) v |= 0x80 >> b
    t[i] = v
  }
  return t
})()

/** zlib の形の Deflate を expected バイトまで展開する (壊れていても、読めたところまでは使う) */
export async function inflate(src: Uint8Array, expected: number): Promise<Uint8Array> {
  const out = new Uint8Array(expected)
  let filled = 0
  const reader = new Blob([src as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  try {
    while (filled < expected) {
      const r = await reader.read()
      if (r.done) break
      const n = Math.min(r.value.length, expected - filled)
      out.set(r.value.subarray(0, n), filled)
      filled += n
    }
  }
  catch (e) {
    if (filled === 0) throw new Error('invalid tiff deflate data', { cause: e })
  }
  finally {
    void reader.cancel().catch(() => {})
  }
  return out
}

function packBits(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let p = 0, o = 0
  while (o < expected && p < src.length) {
    const n = (src[p++]! << 24) >> 24
    if (n >= 0) {
      const count = n + 1
      if (p + count > src.length) throw new Error('truncated tiff packbits data')
      const copy = Math.min(count, expected - o)
      out.set(src.subarray(p, p + copy), o)
      p += count
      o += copy
    }
    else if (n !== -128) {
      if (p >= src.length) throw new Error('truncated tiff packbits data')
      const v = src[p++]!
      const end = Math.min(expected, o + 1 - n)
      out.fill(v, o, end)
      o = end
    }
  }
  return out
}

/** TIFF の LZW (上位のビットから詰める。符号の長さは、表が埋まる 1 つ手前で増える) */
export function lzw(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  const prefix = new Int32Array(4096)
  const suffix = new Uint8Array(4096)
  for (let i = 0; i < 256; i++) suffix[i] = i
  const stack = new Uint8Array(4097)
  let next = 258, bits = 9, old = -1, o = 0, p = 0
  let buffer = 0, have = 0
  while (o < expected) {
    while (have < bits && p < src.length) {
      buffer = ((buffer << 8) | src[p++]!) & 0xFFFFFF
      have += 8
    }
    if (have < bits) break
    const code = (buffer >>> (have - bits)) & ((1 << bits) - 1)
    have -= bits
    if (code === 257) break
    if (code === 256) {
      next = 258
      bits = 9
      old = -1
      continue
    }
    let current = code
    let top = 0
    if (code >= next) {
      if (old < 0 || code > next) throw new Error('invalid tiff lzw data')
      // 直前の文字列に、その先頭の文字をつけたもの
      let first = old
      while (first >= 258) first = prefix[first]!
      stack[top++] = first
      current = old
    }
    while (current >= 258) {
      stack[top++] = suffix[current]!
      current = prefix[current]!
    }
    stack[top++] = current
    const firstChar = stack[top - 1]!
    for (let i = top - 1; i >= 0 && o < expected; i--) out[o++] = stack[i]!
    if (old >= 0 && next < 4096) {
      prefix[next] = old
      suffix[next] = firstChar
      next++
      if (next === 511) bits = 10
      else if (next === 1023) bits = 11
      else if (next === 2047) bits = 12
    }
    old = code
  }
  return out
}

function jpegTables(d: Uint8Array, ifd: Ifd): Uint8Array | null {
  const where = ifd.get(-347)
  if (!where || where[1]! < 4) return null
  return d.subarray(where[0]!, where[0]! + where[1]!)
}

/** JPEG の 1 つ分 (ストリップやタイル) を展開して、8 ビットの色を交互に並べたバイト列にする */
async function jpeg(src: Uint8Array, tables: Uint8Array | null, expected: number, width: number, rows: number, perPixel: number): Promise<Uint8Array> {
  let data: Uint8Array = src
  if (tables && src.length >= 2) {
    // 表 (SOI から EOI まで) の EOI を除き、本体の SOI を除いてつなぐ
    const end = tables.length >= 2 && tables[tables.length - 2] === 0xFF && tables[tables.length - 1] === 0xD9 ? tables.length - 2 : tables.length
    data = new Uint8Array(end + src.length - 2)
    data.set(tables.subarray(0, end))
    data.set(src.subarray(2), end)
  }
  const mod = await import('jpeg-js/lib/decoder.js')
  const decode = (mod.default ?? mod) as unknown as (b: Uint8Array, o: object) => { width: number, height: number, data: Uint8Array }
  // 色の変換をせず、入っている値のまま受け取る (YCbCr は後で直す)。4 つの色 (CMYK) だけは RGB で返ってくる
  const r = decode(data, { useTArray: true, colorTransform: false, formatAsRGBA: false, tolerantDecoding: true, maxMemoryUsageInMB: 512 })
  if (perPixel !== 1 && perPixel !== 3 && perPixel !== 4) throw new Error('unexpected tiff jpeg components: ' + perPixel)
  const out = new Uint8Array(expected)
  const rowBytes = width * perPixel
  for (let y = 0; y < Math.min(r.height, rows); y++) {
    for (let x = 0; x < Math.min(r.width, width); x++) {
      const s = (y * r.width + x) * 3, o = y * rowBytes + x * perPixel
      if (o + perPixel > expected) break
      if (perPixel === 1) out[o] = r.data[s]!
      else if (perPixel === 3) {
        out[o] = r.data[s]!
        out[o + 1] = r.data[s + 1]!
        out[o + 2] = r.data[s + 2]!
      }
      else {
        // CMYK を RGB にしたもの。K を 0 とした CMYK に戻す (あとで同じ式で RGB になる)
        out[o] = 255 - r.data[s]!
        out[o + 1] = 255 - r.data[s + 1]!
        out[o + 2] = 255 - r.data[s + 2]!
        out[o + 3] = 0
      }
    }
  }
  return out
}

// ---------------------------------------------------------------- 予測

/** 水平方向の差分 (predictor 2)。サンプルごとに左との差で入っている */
function horizontal(little: boolean, raw: Uint8Array, width: number, rows: number, perPixel: number, bps: number): void {
  const rowBytes = Math.ceil(width * perPixel * bps / 8)
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  for (let r = 0; r < rows && (r + 1) * rowBytes <= raw.length; r++) {
    const base = r * rowBytes
    if (bps === 8) {
      for (let i = perPixel; i < rowBytes; i++) raw[base + i] = raw[base + i]! + raw[base + i - perPixel]!
    }
    else if (bps === 16) {
      for (let i = perPixel; i < width * perPixel; i++) {
        const a = base + i * 2, b = a - perPixel * 2
        dv.setUint16(a, (dv.getUint16(a, little) + dv.getUint16(b, little)) & 0xFFFF, little)
      }
    }
    else if (bps === 32) {
      for (let i = perPixel; i < width * perPixel; i++) {
        const a = base + i * 4, b = a - perPixel * 4
        dv.setInt32(a, (dv.getInt32(a, little) + dv.getInt32(b, little)) | 0, little)
      }
    }
  }
}

/** 浮動小数点の予測 (predictor 3)。各行でバイトを上位から並べ替え、さらにバイトごとの差分にしてある */
function floating(little: boolean, raw: Uint8Array, width: number, rows: number, perPixel: number, bps: number): void {
  const bytes = bps / 8
  const samples = width * perPixel
  const rowBytes = samples * bytes
  const tmp = new Uint8Array(rowBytes)
  for (let r = 0; r < rows && (r + 1) * rowBytes <= raw.length; r++) {
    const base = r * rowBytes
    for (let i = perPixel; i < rowBytes; i++) raw[base + i] = raw[base + i]! + raw[base + i - perPixel]!
    tmp.set(raw.subarray(base, base + rowBytes))
    for (let s = 0; s < samples; s++) {
      for (let b = 0; b < bytes; b++) {
        // 上位のバイトが先に並んでいる。ファイルのバイト順に直す
        raw[base + s * bytes + b] = tmp[(little ? bytes - 1 - b : b) * samples + s]!
      }
    }
  }
}

// ---------------------------------------------------------------- 色の変換

function halfToFloat(h: number): number {
  const e = (h >> 10) & 31, m = h & 1023
  const s = h & 0x8000 ? -1 : 1
  if (e === 0) return s * m * Math.pow(2, -24)
  if (e === 31) return m === 0 ? s * Infinity : NaN
  return s * (1 + m / 1024) * Math.pow(2, e - 15)
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

function convert(little: boolean, ifd: Ifd, image: Uint8Array[], w: number, h: number, spp: number, planar: boolean, bps: number,
  format: number, photometric: number, rowBytes: number): Pixels {
  const views = image.map(b => new DataView(b.buffer, b.byteOffset, b.byteLength))
  const sample = (x: number, y: number, s: number): number => {
    const buffer = image[planar ? s : 0]!
    const view = views[planar ? s : 0]!
    const index = planar ? x : x * spp + s
    const rowStart = y * rowBytes
    if (bps < 8 || bps === 12) {
      const bit = index * bps
      const p = rowStart + (bit >> 3)
      if (bps === 12) {
        const v = (buffer[p]! << 8) | buffer[p + 1 < buffer.length ? p + 1 : p]!
        return (bit & 7) === 0 ? v >> 4 : v & 0xFFF
      }
      return (buffer[p]! >> (8 - bps - (bit & 7))) & ((1 << bps) - 1)
    }
    const p = rowStart + index * (bps >> 3)
    switch (bps) {
      case 8: {
        const v = buffer[p]!
        return format === 2 ? v ^ 0x80 : v
      }
      case 16: {
        const v = view.getUint16(p, little)
        if (format === 3) return halfToFloat(v)
        return format === 2 ? v ^ 0x8000 : v
      }
      case 24: {
        const v = little ? buffer[p]! | (buffer[p + 1]! << 8) | (buffer[p + 2]! << 16) : (buffer[p]! << 16) | (buffer[p + 1]! << 8) | buffer[p + 2]!
        return format === 2 ? v ^ 0x800000 : v
      }
      case 32: {
        if (format === 3) return view.getFloat32(p, little)
        const v = view.getUint32(p, little)
        return format === 2 ? (v ^ 0x80000000) >>> 0 : v
      }
      case 64: return view.getFloat64(p, little)
      default: {
        // 40, 48, 56 ビットの整数は、上位の 32 ビットだけで足りる
        const n = bps >> 3
        let v = 0
        for (let k = 0; k < 4; k++) v = v * 256 + buffer[little ? p + n - 1 - k : p + k]!
        return format === 2 ? (v ^ 0x80000000) >>> 0 : v
      }
    }
  }
  const extra = ifd.get(338)
  const colorSamples = photometric === 2 || photometric === 6 ? 3 : photometric === 5 ? 4 : 1
  if (spp < colorSamples) throw new Error('not enough tiff samples for the color model')
  // 余分なサンプルの最初のものが透明度のときだけ使う (1 は乗算済み、2 は乗算なし)
  const extraKind = extra && extra.length && spp > colorSamples ? extra[0]! : 0
  const hasAlpha = extraKind === 1 || extraKind === 2
  const premultiplied = extraKind === 1
  const isFloat = format === 3
  const effBits = bps > 32 && !isFloat ? 32 : bps
  const max = bps >= 64 ? 1 : Math.pow(2, effBits) - 1
  const to8 = (v: number): number => max === 255 ? v : Math.floor((v * 255 + Math.floor(max / 2)) / max)

  let palette: Uint8Array | null = null
  if (photometric === 3) {
    const map = ifd.get(320)
    const entries = 1 << Math.min(bps, 16)
    if (!map || map.length < entries * 3) throw new Error('tiff has no color map')
    palette = new Uint8Array(entries * 3)
    for (let i = 0; i < entries; i++) {
      palette[i * 3] = map[i]! >> 8
      palette[i * 3 + 1] = map[entries + i]! >> 8
      palette[i * 3 + 2] = map[2 * entries + i]! >> 8
    }
  }

  // 浮動小数点は、1 を超える値があれば最大が 1 になるように縮める
  let floatScale = 1
  if (isFloat) {
    let top = 0
    for (let y = 0; y < h; y += Math.max(1, Math.floor(h / 256))) {
      for (let x = 0; x < w; x++) {
        for (let s = 0; s < spp; s++) {
          const v = sample(x, y, s)
          if (Number.isFinite(v) && v > top) top = v
        }
      }
    }
    if (top > 1) floatScale = 1 / top
  }

  const px = allocate(w, h)
  const out = px.data
  const c = new Int32Array(Math.max(spp, 4))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      if (palette) {
        const i = Math.min(sample(x, y, 0), palette.length / 3 - 1)
        out[o] = palette[i * 3]!
        out[o + 1] = palette[i * 3 + 1]!
        out[o + 2] = palette[i * 3 + 2]!
        out[o + 3] = 255
        continue
      }
      for (let s = 0; s < spp; s++) {
        const v = sample(x, y, s)
        c[s] = isFloat ? clamp8(Math.round((Number.isNaN(v) ? 0 : v) * floatScale * 255)) : to8(v)
      }
      const a = hasAlpha ? c[colorSamples]! : 255
      let r: number, g: number, b: number
      switch (photometric) {
        case 0: r = g = b = 255 - c[0]!; break
        case 1: r = g = b = c[0]!; break
        case 5:
          r = (255 - c[0]!) * (255 - c[3]!) / 255 | 0
          g = (255 - c[1]!) * (255 - c[3]!) / 255 | 0
          b = (255 - c[2]!) * (255 - c[3]!) / 255 | 0
          break
        case 6: {
          const yy = c[0]!, cb = c[1]! - 128, cr = c[2]! - 128
          r = clamp8(Math.round(yy + 1.402 * cr))
          g = clamp8(Math.round(yy - 0.344136 * cb - 0.714136 * cr))
          b = clamp8(Math.round(yy + 1.772 * cb))
          break
        }
        default: r = c[0]!; g = c[1]!; b = c[2]!; break
      }
      if (premultiplied && a > 0 && a < 255) {
        r = Math.min(255, r * 255 / a | 0)
        g = Math.min(255, g * 255 / a | 0)
        b = Math.min(255, b * 255 / a | 0)
      }
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }
  return px
}

/** TIFF や Exif の向き (2 - 8) を直す (MarumaSign 本体の Orientation.apply と同じ) */
export function orient(orientation: number, px: Pixels): Pixels {
  if (orientation < 2 || orientation > 8) return px
  const { width, height } = px
  const swap = orientation >= 5
  const nw = swap ? height : width, nh = swap ? width : height
  const out = allocate(nw, nh)
  const src = new Uint32Array(px.data.buffer, px.data.byteOffset, width * height)
  const dst = new Uint32Array(out.data.buffer, out.data.byteOffset, nw * nh)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let tx: number, ty: number
      switch (orientation) {
        case 2: tx = width - 1 - x; ty = y; break
        case 3: tx = width - 1 - x; ty = height - 1 - y; break
        case 4: tx = x; ty = height - 1 - y; break
        case 5: tx = y; ty = x; break
        case 6: tx = height - 1 - y; ty = x; break
        case 7: tx = height - 1 - y; ty = width - 1 - x; break
        default: tx = y; ty = width - 1 - x; break
      }
      dst[ty * nw + tx] = src[y * width + x]!
    }
  }
  return out
}
