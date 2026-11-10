/*! bcdec (https://github.com/iOrange/bcdec) | MIT License | Copyright (c) 2022 Sergii Kudlai */
// GPU 向けの圧縮 (BC1 - BC7) を、CPU で RGBA にする。GPU が対応していないとき (スマートフォンの多く) に使う。
// DDS の看板と 3D モデル (glTF の MSFT_texture_dds など) で分け合う。ブラウザーのものは何も使わない (Node の試験でも動く)。
// 計算は MarumaSign 本体の texture/DdsDecoder.java と Bptc.java と同じ。BC6H と BC7 は bcdec
// (https://github.com/iOrange/bcdec, MIT License, Copyright (c) 2022 Sergii Kudlai) を書き直したもの

/** 圧縮の種類。s の付くものは符号つき */
export type BcFormat = 'bc1' | 'bc2' | 'bc3' | 'bc4' | 'bc4s' | 'bc5' | 'bc5s' | 'bc6h' | 'bc6hs' | 'bc7'

/** 4x4 の 1 ブロックのバイト数 */
export function bcBlockBytes(format: BcFormat): number {
  return format === 'bc1' || format === 'bc4' || format === 'bc4s' ? 8 : 16
}

/** width x height の絵の、圧縮されたバイト数 */
export function bcByteLength(format: BcFormat, width: number, height: number): number {
  return Math.ceil(width / 4) * Math.ceil(height / 4) * bcBlockBytes(format)
}

/**
 * 圧縮された絵を RGBA (1 行目が絵の上、1 画素 4 バイト) にする。
 * BC4 は灰色、BC5 は法線の Z を戻した色、BC6H は明るさを 0 - 1 に収めた sRGB (MarumaSign 本体と同じ見え方)。
 * @param offset data の中の、絵の始まり
 */
export function decodeBc(format: BcFormat, data: Uint8Array, offset: number, width: number, height: number): Uint8ClampedArray {
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('bad size')
  if (offset < 0 || offset + bcByteLength(format, width, height) > data.length) throw new Error(format + ' data truncated')
  const out = new Uint8ClampedArray(width * height * 4)
  const bx = Math.ceil(width / 4), by = Math.ceil(height / 4)
  const size = bcBlockBytes(format)
  const block = new Uint8Array(64)
  const hdr = new Uint16Array(48)
  const bits = new Bits()
  let pos = offset
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      switch (format) {
        case 'bc1': bc1(data, pos, block, true); break
        case 'bc2': bc2(data, pos, block); break
        case 'bc3': bc3(data, pos, block); break
        case 'bc4': case 'bc4s': bc4(data, pos, format === 'bc4s', block); break
        case 'bc5': case 'bc5s': bc5(data, pos, format === 'bc5s', block); break
        case 'bc6h': case 'bc6hs':
          bc6h(bits, data, pos, format === 'bc6hs', hdr)
          for (let i = 0; i < 16; i++) {
            const lut = halfToDisplay()
            block[i * 4] = lut[hdr[i * 3]!]!
            block[i * 4 + 1] = lut[hdr[i * 3 + 1]!]!
            block[i * 4 + 2] = lut[hdr[i * 3 + 2]!]!
            block[i * 4 + 3] = 255
          }
          break
        case 'bc7': bc7(bits, data, pos, block); break
      }
      pos += size
      // ブロックの 16 画素を、絵の中に収まる分だけ写す
      for (let py = 0; py < 4; py++) {
        const ty = y * 4 + py
        if (ty >= height) break
        const n = Math.min(4, width - x * 4)
        out.set(block.subarray(py * 16, py * 16 + n * 4), (ty * width + x * 4) * 4)
      }
    }
  }
  return out
}

/**
 * BC6H を half (16 ビットの浮動小数点数) の RGBA のまま展開する (3D モデルのテクスチャ。明るさを 0 - 1 に収めない)。
 * A は 1.0 (0x3C00)
 */
export function decodeBc6hHalf(signed: boolean, data: Uint8Array, offset: number, width: number, height: number): Uint16Array {
  const format: BcFormat = signed ? 'bc6hs' : 'bc6h'
  if (!(width > 0 && height > 0) || !Number.isInteger(width) || !Number.isInteger(height)) throw new Error('bad size')
  if (offset < 0 || offset + bcByteLength(format, width, height) > data.length) throw new Error(format + ' data truncated')
  const out = new Uint16Array(width * height * 4)
  const bx = Math.ceil(width / 4), by = Math.ceil(height / 4)
  const hdr = new Uint16Array(48)
  const bits = new Bits()
  let pos = offset
  for (let y = 0; y < by; y++) {
    for (let x = 0; x < bx; x++) {
      bc6h(bits, data, pos, signed, hdr)
      pos += 16
      for (let py = 0; py < 4; py++) {
        const ty = y * 4 + py
        if (ty >= height) break
        for (let px = 0; px < 4 && x * 4 + px < width; px++) {
          const s = (py * 4 + px) * 3, d = (ty * width + x * 4 + px) * 4
          out[d] = hdr[s]!
          out[d + 1] = hdr[s + 1]!
          out[d + 2] = hdr[s + 2]!
          out[d + 3] = 0x3C00
        }
      }
    }
  }
  return out
}

/** 3D モデル (model-dds.ts) での形式の名前 */
export type BcnFormat = 'BC1' | 'BC2' | 'BC3' | 'BC4' | 'BC4S' | 'BC5' | 'BC5S' | 'BC6H' | 'BC6HS' | 'BC7'

export function bcnByteLength(format: BcnFormat, width: number, height: number): number {
  return bcByteLength(format.toLowerCase() as BcFormat, width, height)
}

/** 3D モデルのテクスチャ用: BC6H は half の RGBA (Uint16Array)、ほかは 8 ビットの RGBA (Uint8Array)。並びは上の行から */
export function decodeBcnToRgba(format: BcnFormat, width: number, height: number, data: Uint8Array): Uint8Array | Uint16Array {
  if (format === 'BC6H' || format === 'BC6HS') return decodeBc6hHalf(format === 'BC6HS', data, 0, width, height)
  const px = decodeBc(format.toLowerCase() as BcFormat, data, 0, width, height)
  return new Uint8Array(px.buffer, px.byteOffset, px.byteLength)
}

// ---------------------------------------------------------------- BC1 - BC5

function u16(d: Uint8Array, p: number): number {
  return d[p]! | (d[p + 1]! << 8)
}

function u32(d: Uint8Array, p: number): number {
  return (d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0
}

/** 5:6:5 の両端の色と、間の 2 色 (block の 4 つの色。RGB の並び 3 つずつ) */
function colors565(d: Uint8Array, p: number, table: Int32Array): boolean {
  const c0 = u16(d, p), c1 = u16(d, p + 2)
  const r0 = ((c0 >>> 11) & 31) * 255 / 31 | 0, g0 = ((c0 >>> 5) & 63) * 255 / 63 | 0, b0 = (c0 & 31) * 255 / 31 | 0
  const r1 = ((c1 >>> 11) & 31) * 255 / 31 | 0, g1 = ((c1 >>> 5) & 63) * 255 / 63 | 0, b1 = (c1 & 31) * 255 / 31 | 0
  table[0] = r0; table[1] = g0; table[2] = b0
  table[3] = r1; table[4] = g1; table[5] = b1
  return c0 > c1
}

const COLORS = new Int32Array(12)

/** BC1 と、BC2・BC3 の色の部分。fourColor が false なら、c0 <= c1 で 3 色と透明 (BC1 のときだけ) */
function bc1(d: Uint8Array, p: number, out: Uint8Array, bc1Alpha: boolean): void {
  const t = COLORS
  const four = colors565(d, p, t) || !bc1Alpha
  if (four) {
    for (let c = 0; c < 3; c++) {
      t[6 + c] = (2 * t[c]! + t[3 + c]!) / 3 | 0
      t[9 + c] = (t[c]! + 2 * t[3 + c]!) / 3 | 0
    }
  }
  else {
    for (let c = 0; c < 3; c++) {
      t[6 + c] = (t[c]! + t[3 + c]!) / 2 | 0
      t[9 + c] = 0
    }
  }
  const bits = u32(d, p + 4)
  for (let i = 0; i < 16; i++) {
    const code = (bits >>> (i * 2)) & 3
    out[i * 4] = t[code * 3]!
    out[i * 4 + 1] = t[code * 3 + 1]!
    out[i * 4 + 2] = t[code * 3 + 2]!
    out[i * 4 + 3] = !four && code === 3 ? 0 : 255
  }
}

function bc2(d: Uint8Array, p: number, out: Uint8Array): void {
  bc1(d, p + 8, out, false)
  const lo = u32(d, p), hi = u32(d, p + 4)
  for (let i = 0; i < 16; i++) {
    const a4 = (i < 8 ? lo >>> (i * 4) : hi >>> ((i - 8) * 4)) & 15
    out[i * 4 + 3] = a4 | (a4 << 4)
  }
}

/** BC3 の透明度と BC4 の 1 チャンネル (8 つの値の表) */
function table8(d: Uint8Array, p: number, signed: boolean, t: Int32Array): void {
  if (!signed) {
    const e0 = d[p]!, e1 = d[p + 1]!
    t[0] = e0
    t[1] = e1
    if (e0 > e1) {
      for (let i = 1; i <= 6; i++) t[i + 1] = ((7 - i) * e0 + i * e1) / 7 | 0
    }
    else {
      for (let i = 1; i <= 4; i++) t[i + 1] = ((5 - i) * e0 + i * e1) / 5 | 0
      t[6] = 0
      t[7] = 255
    }
    return
  }
  const e0 = (d[p]! << 24) >> 24, e1 = (d[p + 1]! << 24) >> 24
  t[0] = clamp255(e0 + 128)
  t[1] = clamp255(e1 + 128)
  if (e0 > e1) {
    for (let i = 1; i <= 6; i++) t[i + 1] = clamp255((((7 - i) * e0 + i * e1) / 7 | 0) + 128)
  }
  else {
    for (let i = 1; i <= 4; i++) t[i + 1] = clamp255((((5 - i) * e0 + i * e1) / 5 | 0) + 128)
    t[6] = 0
    t[7] = 255
  }
}

/** 16 画素の 3 ビットの番号 (6 バイト) */
function index3(d: Uint8Array, p: number, i: number): number {
  const q = i < 8 ? p : p + 3
  const v = d[q]! | (d[q + 1]! << 8) | (d[q + 2]! << 16)
  return (v >>> ((i & 7) * 3)) & 7
}

const T1 = new Int32Array(8)
const T2 = new Int32Array(8)

function bc3(d: Uint8Array, p: number, out: Uint8Array): void {
  bc1(d, p + 8, out, false)
  table8(d, p, false, T1)
  for (let i = 0; i < 16; i++) out[i * 4 + 3] = T1[index3(d, p + 2, i)]!
}

function bc4(d: Uint8Array, p: number, signed: boolean, out: Uint8Array): void {
  table8(d, p, signed, T1)
  for (let i = 0; i < 16; i++) {
    const v = T1[index3(d, p + 2, i)]!
    out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v
    out[i * 4 + 3] = 255
  }
}

function bc5(d: Uint8Array, p: number, signed: boolean, out: Uint8Array): void {
  table8(d, p, signed, T1)
  table8(d, p + 8, signed, T2)
  for (let i = 0; i < 16; i++) {
    const r = T1[index3(d, p + 2, i)]!, g = T2[index3(d, p + 10, i)]!
    // 法線の Z を戻す: z = sqrt(max(0, 1 - x^2 - y^2))
    const nx = r / 255 * 2 - 1, ny = g / 255 * 2 - 1
    const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny))
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = Math.min(255, Math.max(0, Math.round(Math.fround(Math.fround(nz * 0.5 + 0.5) * 255))))
    out[i * 4 + 3] = 255
  }
}

function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v
}

let HALF_TO_DISPLAY: Uint8Array | null = null

/** half (16 ビットの浮動小数点数) のビット列から、表示用の 0 - 255 への表 (BC6H。初めて使うときに作る) */
function halfToDisplay(): Uint8Array {
  if (!HALF_TO_DISPLAY) {
    HALF_TO_DISPLAY = new Uint8Array(65536)
    for (let h = 0; h < 65536; h++) HALF_TO_DISPLAY[h] = display(halfToFloat(h))
  }
  return HALF_TO_DISPLAY
}

/** リニアの値を、表示用 (sRGB) の 0 - 255 にする */
function display(linear: number): number {
  if (!(linear > 0)) return 0
  if (linear >= 1) return 255
  return Math.round((linear <= 0.0031308 ? linear * 12.92 : 1.055 * Math.pow(linear, 1 / 2.4) - 0.055) * 255)
}

// ---------------------------------------------------------------- BC6H と BC7 (bcdec)

/** 128 ビットのブロックを、下位のビットから順に読む */
class Bits {
  private readonly b = new Uint8Array(24)
  private p = 0

  reset(data: Uint8Array, pos: number): void {
    this.b.set(data.subarray(pos, pos + 16))
    this.p = 0
  }

  bits(n: number): number {
    if (n === 0) return 0
    const b = this.b
    const i = this.p >> 3
    // 128 ビットを過ぎた分は 0 (後ろに 0 を並べてある)
    const v = i < 20 ? ((b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> (this.p & 7)) : 0
    this.p += n
    return v & ((1 << n) - 1)
  }

  /** ビットの並びを逆にして読む (BC6H の一部のモード) */
  reversed(n: number): number {
    let v = this.bits(n)
    let r = 0
    while (n-- > 0) {
      r = (r << 1) | (v & 1)
      v >>= 1
    }
    return r
  }
}

function extendSign(v: number, bits: number): number {
  return (v << (32 - bits)) >> (32 - bits)
}

function transformInverse(v: number, a0: number, bits: number, signed: boolean): number {
  v = (v + a0) & ((1 << bits) - 1)
  return signed ? extendSign(v, bits) : v
}

function unquantize(v: number, bits: number, signed: boolean): number {
  if (!signed) {
    if (bits >= 15) return v
    if (v === 0) return 0
    if (v === (1 << bits) - 1) return 0xFFFF
    return ((v << 16) + 0x8000) >> bits
  }
  if (bits >= 16) return v
  let negative = false
  if (v < 0) {
    negative = true
    v = -v
  }
  let r: number
  if (v === 0) r = 0
  else if (v >= (1 << (bits - 1)) - 1) r = 0x7FFF
  else r = ((v << 15) + 0x4000) >> (bits - 1)
  return negative ? -r : r
}

function interpolate(a: number, b: number, w: readonly number[], i: number): number {
  return (a * (64 - w[i]!) + b * w[i]! + 32) >> 6
}

/** 16 ビットの浮動小数点数 (half) のビット列にする */
function finishUnquantize(v: number, signed: boolean): number {
  if (!signed) return (v * 31) >> 6
  v = v < 0 ? -(((-v) * 31) >> 5) : (v * 31) >> 5
  let sign = 0
  if (v < 0) {
    sign = 0x8000
    v = -v
  }
  return sign | v
}

export function halfToFloat(h: number): number {
  const e = (h >> 10) & 0x1F, m = h & 0x3FF
  const s = h & 0x8000 ? -1 : 1
  if (e === 0) return s * m / (1 << 24)
  if (e === 31) return m === 0 ? s * Infinity : NaN
  return s * Math.pow(2, e - 15) * (1 + m / 1024)
}

const BC6H_BITS = [
  [10, 7, 11, 11, 11, 9, 8, 8, 8, 6, 10, 11, 12, 16],
  [5, 6, 5, 4, 4, 5, 6, 5, 5, 6, 10, 9, 8, 4],
  [5, 6, 4, 5, 4, 5, 5, 6, 5, 6, 10, 9, 8, 4],
  [5, 6, 4, 4, 5, 5, 5, 5, 6, 6, 10, 9, 8, 4],
] as const
const WEIGHT2 = [0, 21, 43, 64]
const WEIGHT3 = [0, 9, 18, 27, 37, 46, 55, 64]
const WEIGHT4 = [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64]

/** 分け方の表 (16 画素ごとの部分の番号。境界の目印になる画素は 128 を足してある) を文字列から作る */
function partitions(rows: string): Uint8Array[] {
  return rows.trim().split(/\s+/).map((row) => {
    const t = new Uint8Array(16)
    for (let i = 0; i < 16; i++) {
      const c = row.charCodeAt(i)
      // 0 1 2 は部分の番号、A B C はその部分の目印の画素
      t[i] = c >= 65 ? 128 + c - 65 : c - 48
    }
    return t
  })
}

// 2 つの部分への分け方 (BC6H と BC7 で同じ。BC6H は先頭の 32 個)
const P2 = partitions(`
A01100110011001B A00100010001000B A11101110111011B A00100110011011B A00000010001001B A01101110111111B A00100110111111B A00000010011011B
A00000000001001B A01101111111111B A00000010111111B A00000000001011B A00101111111111B A00000001111111B A00011111111111B A00000000000111B
A00010001110111B A1B1000100000000 A0000000B0001110 A1B1001100010000 A0B1000100000000 A0001000B1001110 A0000000B0001100 A11100110011000B
A0B1000100010000 A0001000B0001100 A1B0011001100110 A0B1011001101100 A0010111B1101000 A0001111B1110000 A1B1000110001110 A0B1100110011100
A10101010101010B A00011110000111B A10110B001011010 A0110011B1001100 A0B1110000111100 A1010101B0101010 A11010010110100B A10110101010010B
A1B1001111001110 A0010011B1001000 A0B1001001001100 A0B1101111011100 A1B0100110010110 A01111001100001B A11001101001100B A00001B001100000
A10011B001000000 A0B0011100100000 A00000B001110010 A0000100B1100100 A11011001001001B A01101101100100B A1B0001110011100 A0B1100111000110
A11011001100100B A11000110011100B A11111101000000B A00110001110011B A00011110011001B A0B1001111110000 A0B0001011101110 A10001000111011B`)

// 3 つの部分への分け方 (BC7)
const P3 = partitions(`
A01B00110221222C A00B0011C2112221 A0002001C211221B A22C00220011011B A0000000B122112C A01B00110022002C A02C00221111111B A0110011C211221B
A0000000B111222C A0001111B111222C A00011B12222222C A01200B20012001C A11201B20112011C A1220B220122012C A01B01121122122C A01B2001C2002220
A00B00110112112C A11B0011C0012200 A0001122B122112C A02C00220022111B A11B01110222022C A00B0001C2212221 A00000B10122012C A0001100C2B02210
A12C0B2200110000 A0120012B122222C A11012C1B2210110 A00001B012C11221 A0221102B102002C A1100B102002222C A011012201C2001B A0002000C211222B
A0000002B122122C A22C00220012001B A01B00120022022C A1200B2001C00120 A00011B122C20000 A1201201C0B20120 A1202012BC010120 A011220011C2001B
A01111C22200001B A10B01012222222C A0000000C121212B A0221B220022112C A02C00110022001B A22012C10220122B A10122C22222010B A0002121C121212B
A10B01010101222C A22C01110222011B A0021B120002111C A0002B122112211C A2220B110111022C A0021112B112000C A1100B100110222C A000000021B2211C
A1100B102222222C A022001100B1002C A0221122B122002C A000000000002B1C A00C00010002000B A22212220222B22C A10B22222222222C A11B2011C2012220`)

const BC6H_PARTITIONS = P2.slice(0, 32)

/** BC6H のブロックを展開する。out には 16 画素分の RGB (リニアの値の half のビット列) を、行ごとに並べて書く */
function bc6h(bs: Bits, data: Uint8Array, pos: number, signed: boolean, out: Uint16Array): void {
  bs.reset(data, pos)
  const r = [0, 0, 0, 0], g = [0, 0, 0, 0], b = [0, 0, 0, 0]
  let mode = bs.bits(2)
  if (mode > 1) mode |= bs.bits(3) << 2
  let partition = 0
  const x = (n: number): number => bs.bits(n)
  switch (mode) {
    case 0b00:
      g[2]! |= x(1) << 4; b[2]! |= x(1) << 4; b[3]! |= x(1) << 4
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(5); g[3]! |= x(1) << 4; g[2]! |= x(4); g[1]! |= x(5); b[3]! |= x(1); g[3]! |= x(4)
      b[1]! |= x(5); b[3]! |= x(1) << 1; b[2]! |= x(4); r[2]! |= x(5); b[3]! |= x(1) << 2; r[3]! |= x(5); b[3]! |= x(1) << 3
      partition = x(5); mode = 0
      break
    case 0b01:
      g[2]! |= x(1) << 5; g[3]! |= x(1) << 4; g[3]! |= x(1) << 5
      r[0]! |= x(7); b[3]! |= x(1); b[3]! |= x(1) << 1; b[2]! |= x(1) << 4
      g[0]! |= x(7); b[2]! |= x(1) << 5; b[3]! |= x(1) << 2; g[2]! |= x(1) << 4
      b[0]! |= x(7); b[3]! |= x(1) << 3; b[3]! |= x(1) << 5; b[3]! |= x(1) << 4
      r[1]! |= x(6); g[2]! |= x(4); g[1]! |= x(6); g[3]! |= x(4); b[1]! |= x(6); b[2]! |= x(4); r[2]! |= x(6); r[3]! |= x(6)
      partition = x(5); mode = 1
      break
    case 0b00010:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(5); r[0]! |= x(1) << 10; g[2]! |= x(4); g[1]! |= x(4); g[0]! |= x(1) << 10; b[3]! |= x(1); g[3]! |= x(4)
      b[1]! |= x(4); b[0]! |= x(1) << 10; b[3]! |= x(1) << 1; b[2]! |= x(4); r[2]! |= x(5); b[3]! |= x(1) << 2; r[3]! |= x(5); b[3]! |= x(1) << 3
      partition = x(5); mode = 2
      break
    case 0b00110:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(4); r[0]! |= x(1) << 10; g[3]! |= x(1) << 4; g[2]! |= x(4); g[1]! |= x(5); g[0]! |= x(1) << 10; g[3]! |= x(4)
      b[1]! |= x(4); b[0]! |= x(1) << 10; b[3]! |= x(1) << 1; b[2]! |= x(4); r[2]! |= x(4); b[3]! |= x(1); b[3]! |= x(1) << 2
      r[3]! |= x(4); g[2]! |= x(1) << 4; b[3]! |= x(1) << 3
      partition = x(5); mode = 3
      break
    case 0b01010:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(4); r[0]! |= x(1) << 10; b[2]! |= x(1) << 4; g[2]! |= x(4); g[1]! |= x(4); g[0]! |= x(1) << 10; b[3]! |= x(1)
      g[3]! |= x(4); b[1]! |= x(5); b[0]! |= x(1) << 10; b[2]! |= x(4); r[2]! |= x(4); b[3]! |= x(1) << 1; b[3]! |= x(1) << 2
      r[3]! |= x(4); b[3]! |= x(1) << 4; b[3]! |= x(1) << 3
      partition = x(5); mode = 4
      break
    case 0b01110:
      r[0]! |= x(9); b[2]! |= x(1) << 4; g[0]! |= x(9); g[2]! |= x(1) << 4; b[0]! |= x(9); b[3]! |= x(1) << 4
      r[1]! |= x(5); g[3]! |= x(1) << 4; g[2]! |= x(4); g[1]! |= x(5); b[3]! |= x(1); g[3]! |= x(4); b[1]! |= x(5)
      b[3]! |= x(1) << 1; b[2]! |= x(4); r[2]! |= x(5); b[3]! |= x(1) << 2; r[3]! |= x(5); b[3]! |= x(1) << 3
      partition = x(5); mode = 5
      break
    case 0b10010:
      r[0]! |= x(8); g[3]! |= x(1) << 4; b[2]! |= x(1) << 4; g[0]! |= x(8); b[3]! |= x(1) << 2; g[2]! |= x(1) << 4
      b[0]! |= x(8); b[3]! |= x(1) << 3; b[3]! |= x(1) << 4; r[1]! |= x(6); g[2]! |= x(4); g[1]! |= x(5); b[3]! |= x(1)
      g[3]! |= x(4); b[1]! |= x(5); b[3]! |= x(1) << 1; b[2]! |= x(4); r[2]! |= x(6); r[3]! |= x(6)
      partition = x(5); mode = 6
      break
    case 0b10110:
      r[0]! |= x(8); b[3]! |= x(1); b[2]! |= x(1) << 4; g[0]! |= x(8); g[2]! |= x(1) << 5; g[2]! |= x(1) << 4
      b[0]! |= x(8); g[3]! |= x(1) << 5; b[3]! |= x(1) << 4; r[1]! |= x(5); g[3]! |= x(1) << 4; g[2]! |= x(4); g[1]! |= x(6)
      g[3]! |= x(4); b[1]! |= x(5); b[3]! |= x(1) << 1; b[2]! |= x(4); r[2]! |= x(5); b[3]! |= x(1) << 2; r[3]! |= x(5); b[3]! |= x(1) << 3
      partition = x(5); mode = 7
      break
    case 0b11010:
      r[0]! |= x(8); b[3]! |= x(1) << 1; b[2]! |= x(1) << 4; g[0]! |= x(8); b[2]! |= x(1) << 5; g[2]! |= x(1) << 4
      b[0]! |= x(8); b[3]! |= x(1) << 5; b[3]! |= x(1) << 4; r[1]! |= x(5); g[3]! |= x(1) << 4; g[2]! |= x(4); g[1]! |= x(5)
      b[3]! |= x(1); g[3]! |= x(4); b[1]! |= x(6); b[2]! |= x(4); r[2]! |= x(5); b[3]! |= x(1) << 2; r[3]! |= x(5); b[3]! |= x(1) << 3
      partition = x(5); mode = 8
      break
    case 0b11110:
      r[0]! |= x(6); g[3]! |= x(1) << 4; b[3]! |= x(1); b[3]! |= x(1) << 1; b[2]! |= x(1) << 4
      g[0]! |= x(6); g[2]! |= x(1) << 5; b[2]! |= x(1) << 5; b[3]! |= x(1) << 2; g[2]! |= x(1) << 4
      b[0]! |= x(6); g[3]! |= x(1) << 5; b[3]! |= x(1) << 3; b[3]! |= x(1) << 5; b[3]! |= x(1) << 4
      r[1]! |= x(6); g[2]! |= x(4); g[1]! |= x(6); g[3]! |= x(4); b[1]! |= x(6); b[2]! |= x(4); r[2]! |= x(6); r[3]! |= x(6)
      partition = x(5); mode = 9
      break
    case 0b00011:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10); r[1]! |= x(10); g[1]! |= x(10); b[1]! |= x(10)
      mode = 10
      break
    case 0b00111:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(9); r[0]! |= x(1) << 10; g[1]! |= x(9); g[0]! |= x(1) << 10; b[1]! |= x(9); b[0]! |= x(1) << 10
      mode = 11
      break
    case 0b01011:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(8); r[0]! |= bs.reversed(2) << 10; g[1]! |= x(8); g[0]! |= bs.reversed(2) << 10; b[1]! |= x(8); b[0]! |= bs.reversed(2) << 10
      mode = 12
      break
    case 0b01111:
      r[0]! |= x(10); g[0]! |= x(10); b[0]! |= x(10)
      r[1]! |= x(4); r[0]! |= bs.reversed(6) << 10; g[1]! |= x(4); g[0]! |= bs.reversed(6) << 10; b[1]! |= x(4); b[0]! |= bs.reversed(6) << 10
      mode = 13
      break
    default:
      out.fill(0)
      return
  }
  const ends = mode >= 10 ? 2 : 4
  const bits0 = BC6H_BITS[0][mode]!
  if (signed) {
    r[0] = extendSign(r[0]!, bits0)
    g[0] = extendSign(g[0]!, bits0)
    b[0] = extendSign(b[0]!, bits0)
  }
  // モード 10 と 11 (ここでは 9 と 10) は差分ではなく、両端の色をそのまま持つ
  if ((mode !== 9 && mode !== 10) || signed) {
    for (let i = 1; i < ends; i++) {
      r[i] = extendSign(r[i]!, BC6H_BITS[1][mode]!)
      g[i] = extendSign(g[i]!, BC6H_BITS[2][mode]!)
      b[i] = extendSign(b[i]!, BC6H_BITS[3][mode]!)
    }
  }
  if (mode !== 9 && mode !== 10) {
    for (let i = 1; i < ends; i++) {
      r[i] = transformInverse(r[i]!, r[0]!, bits0, signed)
      g[i] = transformInverse(g[i]!, g[0]!, bits0, signed)
      b[i] = transformInverse(b[i]!, b[0]!, bits0, signed)
    }
  }
  for (let i = 0; i < ends; i++) {
    r[i] = unquantize(r[i]!, bits0, signed)
    g[i] = unquantize(g[i]!, bits0, signed)
    b[i] = unquantize(b[i]!, bits0, signed)
  }
  const weights = mode >= 10 ? WEIGHT4 : WEIGHT3
  const table = BC6H_PARTITIONS[partition]!
  for (let i = 0; i < 16; i++) {
    let set = mode >= 10 ? (i ? 0 : 128) : table[i]!
    let indexBits = mode >= 10 ? 4 : 3
    // 境界の目印になる画素は、1 ビット少ない
    if (set & 0x80) indexBits--
    set &= 1
    const index = bs.bits(indexBits)
    const e = set * 2
    out[i * 3] = finishUnquantize(interpolate(r[e]!, r[e + 1]!, weights, index), signed)
    out[i * 3 + 1] = finishUnquantize(interpolate(g[e]!, g[e + 1]!, weights, index), signed)
    out[i * 3 + 2] = finishUnquantize(interpolate(b[e]!, b[e + 1]!, weights, index), signed)
  }
}

const BC7_BITS = [[4, 6, 5, 7, 5, 7, 7, 5], [0, 0, 0, 0, 6, 8, 7, 5]] as const
// P ビットを持つモード (0, 1, 3, 6, 7)
const BC7_HAS_PBITS = 0xCB
const ENDPOINTS = Array.from({ length: 6 }, () => new Int32Array(4))
const INDICES = new Int32Array(16)

/** BC7 のブロックを展開する。out には 16 画素分の RGBA を、行ごとに並べて書く */
function bc7(bs: Bits, data: Uint8Array, pos: number, out: Uint8Array): void {
  bs.reset(data, pos)
  let mode = 0
  while (mode < 8 && bs.bits(1) === 0) mode++
  if (mode >= 8) {
    // 不正なモードは透明な黒にする
    out.fill(0, 0, 64)
    return
  }
  let partition = 0
  let parts = 1
  let rotation = 0
  let indexSelection = 0
  if (mode === 0 || mode === 1 || mode === 2 || mode === 3 || mode === 7) {
    parts = mode === 0 || mode === 2 ? 3 : 2
    partition = bs.bits(mode === 0 ? 4 : 6)
  }
  const count = parts * 2
  if (mode === 4 || mode === 5) {
    rotation = bs.bits(2)
    if (mode === 4) indexSelection = bs.bits(1)
  }
  const ep = ENDPOINTS
  for (const e of ep) e.fill(0)
  for (let c = 0; c < 3; c++) for (let e = 0; e < count; e++) ep[e]![c] = bs.bits(BC7_BITS[0][mode]!)
  if (BC7_BITS[1][mode]! > 0) for (let e = 0; e < count; e++) ep[e]![3] = bs.bits(BC7_BITS[1][mode]!)
  const pbits = ((BC7_HAS_PBITS >> mode) & 1) !== 0
  if (pbits) {
    for (let e = 0; e < count; e++) for (let c = 0; c < 4; c++) ep[e]![c] = ep[e]![c]! << 1
    if (mode === 1) {
      // 2 つの部分で 1 ビットずつ共有する
      const p0 = bs.bits(1), p1 = bs.bits(1)
      for (let c = 0; c < 3; c++) {
        ep[0]![c] = ep[0]![c]! | p0
        ep[1]![c] = ep[1]![c]! | p0
        ep[2]![c] = ep[2]![c]! | p1
        ep[3]![c] = ep[3]![c]! | p1
      }
    }
    else {
      for (let e = 0; e < count; e++) {
        const p = bs.bits(1)
        for (let c = 0; c < 4; c++) ep[e]![c] = ep[e]![c]! | p
      }
    }
  }
  for (let e = 0; e < count; e++) {
    // 上位のビットを下位にも繰り返して 8 ビットにする
    let precision = BC7_BITS[0][mode]! + (pbits ? 1 : 0)
    for (let c = 0; c < 3; c++) {
      const v = ep[e]![c]! << (8 - precision)
      ep[e]![c] = v | (v >> precision)
    }
    precision = BC7_BITS[1][mode]! + (pbits ? 1 : 0)
    const a = ep[e]![3]! << (8 - precision)
    ep[e]![3] = a | (a >> precision)
  }
  if (BC7_BITS[1][mode] === 0) for (let e = 0; e < count; e++) ep[e]![3] = 0xFF
  const indexBitsBase = mode === 0 || mode === 1 ? 3 : mode === 6 ? 4 : 2
  const indexBits2 = mode === 4 ? 3 : mode === 5 ? 2 : 0
  const weights = indexBitsBase === 2 ? WEIGHT2 : indexBitsBase === 3 ? WEIGHT3 : WEIGHT4
  const weights2 = indexBits2 === 2 ? WEIGHT2 : WEIGHT3
  const table = parts === 2 ? P2[partition]! : parts === 3 ? P3[partition]! : null
  // 色の番号 (と、モード 4, 5 では続けて透明度の番号) が別々に並んでいるので、2 回に分けて読む
  for (let i = 0; i < 16; i++) {
    const set = table ? table[i]! : (i ? 0 : 128)
    INDICES[i] = bs.bits(set & 0x80 ? indexBitsBase - 1 : indexBitsBase)
  }
  for (let i = 0; i < 16; i++) {
    const set = (table ? table[i]! : 0) & 3
    const index = INDICES[i]!
    const e0 = ep[set * 2]!, e1 = ep[set * 2 + 1]!
    let r: number, g: number, b: number, a: number
    if (indexBits2 === 0) {
      r = interpolate(e0[0]!, e1[0]!, weights, index)
      g = interpolate(e0[1]!, e1[1]!, weights, index)
      b = interpolate(e0[2]!, e1[2]!, weights, index)
      a = interpolate(e0[3]!, e1[3]!, weights, index)
    }
    else {
      const index2 = bs.bits(i ? indexBits2 : indexBits2 - 1)
      if (indexSelection === 0) {
        r = interpolate(e0[0]!, e1[0]!, weights, index)
        g = interpolate(e0[1]!, e1[1]!, weights, index)
        b = interpolate(e0[2]!, e1[2]!, weights, index)
        a = interpolate(e0[3]!, e1[3]!, weights2, index2)
      }
      else {
        r = interpolate(e0[0]!, e1[0]!, weights2, index2)
        g = interpolate(e0[1]!, e1[1]!, weights2, index2)
        b = interpolate(e0[2]!, e1[2]!, weights2, index2)
        a = interpolate(e0[3]!, e1[3]!, weights, index)
      }
    }
    // 透明度と入れ替えて持っているチャンネルを戻す
    let t: number
    switch (rotation) {
      case 1: t = a; a = r; r = t; break
      case 2: t = a; a = g; g = t; break
      case 3: t = a; a = b; b = t; break
    }
    out[i * 4] = r
    out[i * 4 + 1] = g
    out[i * 4 + 2] = b
    out[i * 4 + 3] = a
  }
}
