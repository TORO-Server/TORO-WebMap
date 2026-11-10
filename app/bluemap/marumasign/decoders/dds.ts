// DDS (DirectDraw Surface)。MarumaSign 本体の texture/DdsDecoder.java と同じ形式に対応する:
// BC1 (DXT1), BC2 (DXT2/3), BC3 (DXT4/5), BC4, BC5, BC6H, BC7、非圧縮 (RGB・明るさ・マスクの指定)、256 色。
// 最初の面 (キューブマップなら +X、配列なら 1 枚目) の、いちばん大きい絵を読む。ブラウザーのものは使わない (Node の試験でも動く)
import { bcByteLength, decodeBc, type BcFormat } from './bcn.ts'
import { allocate, type Pixels } from './raster.ts'

const DDPF_ALPHAPIXELS = 0x1
const DDPF_FOURCC = 0x4
const DDPF_PALETTEINDEXED8 = 0x20
const DDPF_RGB = 0x40
const DDPF_LUMINANCE = 0x20000
const MAX_DIMENSION = 8192

function fourCC(s: string): number {
  return (s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)) >>> 0
}

const FOURCC: Record<number, BcFormat> = {
  [fourCC('DXT1')]: 'bc1', [fourCC('DXT2')]: 'bc2', [fourCC('DXT3')]: 'bc2', [fourCC('DXT4')]: 'bc3', [fourCC('DXT5')]: 'bc3',
  [fourCC('ATI1')]: 'bc4', [fourCC('BC4U')]: 'bc4', [fourCC('BC4S')]: 'bc4s',
  [fourCC('ATI2')]: 'bc5', [fourCC('BC5U')]: 'bc5', [fourCC('BC5S')]: 'bc5s',
}

// DXGI の形式 (型を決めていない TYPELESS は、符号なしとして読む)
const DXGI_BC: Record<number, BcFormat> = {
  70: 'bc1', 71: 'bc1', 72: 'bc1', 73: 'bc2', 74: 'bc2', 75: 'bc2', 76: 'bc3', 77: 'bc3', 78: 'bc3',
  79: 'bc4', 80: 'bc4', 81: 'bc4s', 82: 'bc5', 83: 'bc5', 84: 'bc5s', 94: 'bc6h', 95: 'bc6h', 96: 'bc6hs', 97: 'bc7', 98: 'bc7', 99: 'bc7',
}
// 非圧縮の DXGI の形式: [ビット数, R, G, B, A のマスク, 透明度があるか]
const DXGI_RAW: Record<number, [number, number, number, number, number, boolean]> = {
  28: [32, 0x000000FF, 0x0000FF00, 0x00FF0000, 0xFF000000, true], 29: [32, 0x000000FF, 0x0000FF00, 0x00FF0000, 0xFF000000, true],
  87: [32, 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000, true], 91: [32, 0x00FF0000, 0x0000FF00, 0x000000FF, 0xFF000000, true],
  88: [32, 0x00FF0000, 0x0000FF00, 0x000000FF, 0, false], 93: [32, 0x00FF0000, 0x0000FF00, 0x000000FF, 0, false],
}
const SRGB_DXGI = new Set([29, 72, 75, 78, 91, 93, 99])

/** DDS の見出しを読んだもの */
export interface DdsHeader {
  width: number
  height: number
  /** 絵の始まり */
  offset: number
  /** 絵の数 (1 は縮小した絵なし) */
  mipmaps: number
  cubemap: boolean
  /** GPU 向けに圧縮された形式なら、その種類 */
  bc: BcFormat | null
  /** sRGB と書かれた形式 (DXGI の *_SRGB) */
  srgb: boolean
}

function u32(d: Uint8Array, p: number): number {
  return (d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16) | (d[p + 3]! << 24)) >>> 0
}

export function isDds(d: Uint8Array): boolean {
  return d.length >= 128 && u32(d, 0) === 0x20534444
}

/** 見出しを読む。対応していない形式なら失敗にする */
export function readDdsHeader(d: Uint8Array): DdsHeader & { raw?: [number, number, number, number, number, boolean, boolean], palette?: boolean } {
  if (!isDds(d)) throw new Error('not a dds image')
  if (u32(d, 4) !== 124) throw new Error('invalid dds header size')
  const height = u32(d, 12), width = u32(d, 16)
  if (width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION) throw new Error('invalid dds dimensions')
  const mipmaps = Math.max(1, u32(d, 28))
  const cubemap = (u32(d, 112) & 0x200) !== 0
  const flags = u32(d, 80), cc = u32(d, 84)
  const base = { width, height, mipmaps, cubemap, srgb: false }
  if (flags & DDPF_FOURCC) {
    if (cc === fourCC('DX10')) {
      if (d.length < 148) throw new Error('dds dx10 header truncated')
      const dxgi = u32(d, 128)
      // 配列の数 (u32(d, 140)) が 2 以上でも、1 枚目だけを読む
      const srgb = SRGB_DXGI.has(dxgi)
      const bc = DXGI_BC[dxgi]
      if (bc) return { ...base, offset: 148, bc, srgb, cubemap: cubemap || (u32(d, 136) & 4) !== 0 }
      const raw = DXGI_RAW[dxgi]
      if (raw) return { ...base, offset: 148, bc: null, srgb, raw: [...raw, false] }
      throw new Error('unsupported dds dxgi format: ' + dxgi)
    }
    const bc = FOURCC[cc]
    if (!bc) throw new Error('unsupported dds fourcc: 0x' + cc.toString(16))
    return { ...base, offset: 128, bc }
  }
  if (flags & (DDPF_RGB | DDPF_LUMINANCE)) {
    return {
      ...base, offset: 128, bc: null,
      raw: [u32(d, 88), u32(d, 92), u32(d, 96), u32(d, 100), u32(d, 104), (flags & DDPF_ALPHAPIXELS) !== 0, (flags & DDPF_LUMINANCE) !== 0],
    }
  }
  if (flags & DDPF_PALETTEINDEXED8) return { ...base, offset: 128, bc: null, palette: true }
  throw new Error('unsupported dds pixel format')
}

/**
 * DDS を CPU で RGBA にする (MarumaSign 本体と同じ見え方)。GPU が圧縮の形式に対応していなくても読める。
 * 3D モデルのテクスチャ (MSFT_texture_dds) にも使える。
 */
export function decodeDdsPixels(d: Uint8Array): Pixels {
  const h = readDdsHeader(d)
  const px = allocate(h.width, h.height)
  if (h.bc) {
    px.data.set(decodeBc(h.bc, d, h.offset, h.width, h.height))
    return px
  }
  if (h.palette) {
    if (h.offset + 1024 + h.width * h.height > d.length) throw new Error('palette dds data truncated')
    const pixels = h.offset + 1024
    for (let i = 0; i < h.width * h.height; i++) {
      const p = h.offset + d[pixels + i]! * 4
      px.data[i * 4] = d[p]!
      px.data[i * 4 + 1] = d[p + 1]!
      px.data[i * 4 + 2] = d[p + 2]!
      px.data[i * 4 + 3] = d[p + 3]!
    }
    return px
  }
  uncompressed(d, h.offset, h.width, h.height, h.raw!, px.data)
  return px
}

function shiftOf(mask: number): number {
  if (mask === 0) return 0
  let s = 0
  while (((mask >>> s) & 1) === 0) s++
  return s
}

/** 非圧縮 (RGBA・BGRA・RGB・BGR・明るさなど。マスクで並びを決める) */
function uncompressed(d: Uint8Array, offset: number, width: number, height: number,
  raw: [number, number, number, number, number, boolean, boolean], out: Uint8ClampedArray): void {
  const [bitCount, , gMask, bMask, , hasAlpha, luminance] = raw
  let rMask = raw[1], aMask = raw[4]
  if (bitCount <= 0 || bitCount > 32) throw new Error('unsupported dds bit count: ' + bitCount)
  if (luminance && bitCount < 32 && (rMask >>> bitCount) !== 0) {
    // 画素より広いマスクが書かれていることがある。明るさは下位のビット、透明度は残りのビットとみなす
    const lumaBits = aMask !== 0 && hasAlpha ? bitCount >> 1 : bitCount
    rMask = (1 << lumaBits) - 1
    if (hasAlpha && aMask !== 0) aMask = (((1 << bitCount) - 1) & ~rMask) >>> 0
  }
  const bpp = (bitCount + 7) >> 3
  const pitch = ((width * bitCount + 31) >> 5) * 4
  if (offset + (height - 1) * pitch + width * bpp > d.length) throw new Error('uncompressed dds data truncated')
  const sr = shiftOf(rMask), sg = shiftOf(gMask), sb = shiftOf(bMask), sa = shiftOf(aMask)
  const mr = rMask ? rMask >>> sr : 0, mg = gMask ? gMask >>> sg : 0, mb = bMask ? bMask >>> sb : 0, ma = aMask ? aMask >>> sa : 0
  const comp = (pixel: number, mask: number, shift: number, max: number): number => (((pixel & mask) >>> 0) >>> shift) * 255 / max | 0
  for (let y = 0; y < height; y++) {
    let p = offset + y * pitch
    for (let x = 0; x < width; x++) {
      let pixel: number
      if (bpp === 4) pixel = u32(d, p)
      else if (bpp === 3) pixel = d[p]! | (d[p + 1]! << 8) | (d[p + 2]! << 16)
      else if (bpp === 2) pixel = d[p]! | (d[p + 1]! << 8)
      else pixel = d[p]!
      p += bpp
      const r = mr ? comp(pixel, rMask, sr, mr) : 0
      // 明るさだけの画像 (R のマスクだけがある) は、灰色にする
      const g = luminance ? r : mg ? comp(pixel, gMask, sg, mg) : 0
      const b = luminance ? r : mb ? comp(pixel, bMask, sb, mb) : 0
      const a = hasAlpha && ma ? comp(pixel, aMask, sa, ma) : 255
      const o = (y * width + x) * 4
      out[o] = r
      out[o + 1] = g
      out[o + 2] = b
      out[o + 3] = a
    }
  }
}

/** GPU にそのまま渡す、縮小した絵の並び (足りなければ、あるところまで) */
export function ddsMipmaps(d: Uint8Array, h: DdsHeader): { data: Uint8Array, width: number, height: number }[] {
  if (!h.bc) return []
  const list: { data: Uint8Array, width: number, height: number }[] = []
  let p = h.offset, w = h.width, ht = h.height
  for (let i = 0; i < h.mipmaps; i++) {
    const n = bcByteLength(h.bc, w, ht)
    if (p + n > d.length) break
    list.push({ data: d.subarray(p, p + n), width: w, height: ht })
    p += n
    if (w === 1 && ht === 1) break
    w = Math.max(1, w >> 1)
    ht = Math.max(1, ht >> 1)
  }
  return list
}
