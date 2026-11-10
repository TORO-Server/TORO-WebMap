// 3D モデルのテクスチャの DDS (MSFT_texture_dds) を読む。
// 形式は MarumaSign 本体 (core/texture/DdsDecoder.java) と同じ: BC1 - BC7 (DXT1 - 5、ATI1/2、BC4U/S、BC5U/S、DX10 の DXGI)、
// 非圧縮の 32 ビット (RGBA / BGRA / BGRX)。キューブマップや 3D テクスチャは読まない。
// GPU が描ける形式 (S3TC、BPTC) は圧縮のまま渡し、描けないものは CPU で RGBA にする (decoders/bcn.ts)。
// BC4 と BC5 は MarumaSign 本体と同じ見た目 (BC4 は灰色、BC5 は法線の Z を足す) にするため、いつも CPU で展開する
import {
  CompressedTexture, DataTexture, HalfFloatType, LinearFilter, RGBA_BPTC_Format, RGBA_S3TC_DXT1_Format, RGBA_S3TC_DXT3_Format,
  RGBA_S3TC_DXT5_Format, RGBAFormat, RGB_BPTC_SIGNED_Format, RGB_BPTC_UNSIGNED_Format, UnsignedByteType, type CompressedPixelFormat,
  type Texture,
} from 'three'
import { bcnByteLength, decodeBcnToRgba, type BcnFormat } from './decoders/bcn'
import { getRenderer } from './renderer-ref'

const MAX_SIDE = 8192

type DdsFormat = BcnFormat | 'RGBA8' | 'BGRA8' | 'BGRX8'

export interface DdsImage {
  format: DdsFormat
  width: number
  height: number
  /** ミップマップの段ごとのバイト列 (0 段目から) */
  levels: Uint8Array[]
}

const fourCC = (s: string): number => s.charCodeAt(0) | (s.charCodeAt(1) << 8) | (s.charCodeAt(2) << 16) | (s.charCodeAt(3) << 24)

const FOURCC: Record<number, DdsFormat> = {
  [fourCC('DXT1')]: 'BC1', [fourCC('DXT2')]: 'BC2', [fourCC('DXT3')]: 'BC2', [fourCC('DXT4')]: 'BC3', [fourCC('DXT5')]: 'BC3',
  [fourCC('ATI1')]: 'BC4', [fourCC('BC4U')]: 'BC4', [fourCC('BC4S')]: 'BC4S', [fourCC('ATI2')]: 'BC5', [fourCC('BC5U')]: 'BC5', [fourCC('BC5S')]: 'BC5S',
}

// 型を決めていない形式 (TYPELESS) は、符号なしとして読む (MarumaSign 本体と同じ)
const DXGI: Record<number, DdsFormat> = {
  70: 'BC1', 71: 'BC1', 72: 'BC1', 73: 'BC2', 74: 'BC2', 75: 'BC2', 76: 'BC3', 77: 'BC3', 78: 'BC3',
  79: 'BC4', 80: 'BC4', 81: 'BC4S', 82: 'BC5', 83: 'BC5', 84: 'BC5S',
  94: 'BC6H', 95: 'BC6H', 96: 'BC6HS', 97: 'BC7', 98: 'BC7', 99: 'BC7',
  28: 'RGBA8', 29: 'RGBA8', 87: 'BGRA8', 91: 'BGRA8', 88: 'BGRX8', 93: 'BGRX8',
}

function levelBytes(format: DdsFormat, w: number, h: number): number {
  return format === 'RGBA8' || format === 'BGRA8' || format === 'BGRX8' ? w * h * 4 : bcnByteLength(format, w, h)
}

/** DDS のヘッダーを読み、段ごとのバイト列に分ける */
export function parseDds(buffer: ArrayBuffer): DdsImage {
  const dv = new DataView(buffer)
  if (buffer.byteLength < 128 || dv.getUint32(0, true) !== 0x20534444 || dv.getUint32(4, true) !== 124) throw new Error('not a DDS')
  const height = dv.getUint32(12, true), width = dv.getUint32(16, true)
  if (!(width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE)) throw new Error('bad DDS size')
  const mipCount = (dv.getUint32(8, true) & 0x20000) ? Math.max(1, dv.getUint32(28, true)) : 1
  const pfFlags = dv.getUint32(80, true), cc = dv.getUint32(84, true)
  const caps2 = dv.getUint32(112, true)
  if (caps2 & 0x200 || caps2 & 0x200000) throw new Error('DDS cubemap / volume is not supported')
  let offset = 128
  let format: DdsFormat | undefined
  if (pfFlags & 0x4) {
    if (cc === fourCC('DX10')) {
      if (buffer.byteLength < 148) throw new Error('DDS DX10 header truncated')
      format = DXGI[dv.getUint32(128, true)]
      const dimension = dv.getUint32(132, true), arraySize = dv.getUint32(140, true)
      if ((dimension !== 0 && dimension !== 3) || arraySize > 1 || (dv.getUint32(136, true) & 0x4)) throw new Error('DDS texture array / cubemap is not supported')
      offset = 148
    }
    else {
      format = FOURCC[cc]
    }
  }
  else if (pfFlags & 0x40 && dv.getUint32(88, true) === 32) {
    // 非圧縮の 32 ビット (色の位置はマスクで決まる)
    const r = dv.getUint32(92, true), g = dv.getUint32(96, true), b = dv.getUint32(100, true), a = (pfFlags & 0x1) ? dv.getUint32(104, true) : 0
    if (r === 0xFF && g === 0xFF00 && b === 0xFF0000) format = 'RGBA8'
    else if (r === 0xFF0000 && g === 0xFF00 && b === 0xFF) format = a ? 'BGRA8' : 'BGRX8'
  }
  if (!format) throw new Error('unsupported DDS format')
  const levels: Uint8Array[] = []
  let w = width, h = height
  for (let i = 0; i < Math.min(mipCount, 16); i++) {
    const n = levelBytes(format, w, h)
    if (offset + n > buffer.byteLength) {
      if (i === 0) throw new Error('DDS data truncated')
      break
    }
    levels.push(new Uint8Array(buffer, offset, n))
    offset += n
    if (w === 1 && h === 1) break
    w = Math.max(1, w >> 1)
    h = Math.max(1, h >> 1)
  }
  return { format, width, height, levels }
}

const GPU_FORMATS: Partial<Record<DdsFormat, { format: CompressedPixelFormat, ext: string[] }>> = {
  // sRGB の色のテクスチャ (色・発光) にもなるので、sRGB の拡張もあるときだけ圧縮のまま使う
  BC1: { format: RGBA_S3TC_DXT1_Format, ext: ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'] },
  BC2: { format: RGBA_S3TC_DXT3_Format, ext: ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'] },
  BC3: { format: RGBA_S3TC_DXT5_Format, ext: ['WEBGL_compressed_texture_s3tc', 'WEBGL_compressed_texture_s3tc_srgb'] },
  BC6H: { format: RGB_BPTC_UNSIGNED_Format, ext: ['EXT_texture_compression_bptc'] },
  BC6HS: { format: RGB_BPTC_SIGNED_Format, ext: ['EXT_texture_compression_bptc'] },
  BC7: { format: RGBA_BPTC_Format, ext: ['EXT_texture_compression_bptc'] },
}


/** DDS を three.js のテクスチャにする。cpu: CPU で展開したか (stats 用) */
export function ddsTexture(buffer: ArrayBuffer): { texture: Texture, cpu: boolean } {
  const dds = parseDds(buffer)
  const gpu = GPU_FORMATS[dds.format]
  const renderer = getRenderer()
  // 一辺が 4 の倍数でない圧縮のテクスチャは、WebGL では 0 段目を渡せないことがある
  if (gpu && renderer && dds.width % 4 === 0 && dds.height % 4 === 0 && gpu.ext.every(e => renderer.extensions.has(e))) {
    const mipmaps = dds.levels.map((data, i) => ({ data, width: Math.max(1, dds.width >> i), height: Math.max(1, dds.height >> i) }))
    const tex = new CompressedTexture(mipmaps as unknown as ImageData[], dds.width, dds.height, gpu.format)
    tex.needsUpdate = true
    return { texture: tex, cpu: false }
  }
  const half = dds.format === 'BC6H' || dds.format === 'BC6HS'
  const mipmaps = dds.levels.map((data, i) => {
    const w = Math.max(1, dds.width >> i), h = Math.max(1, dds.height >> i)
    return { data: toRgba(dds.format, w, h, data), width: w, height: h }
  })
  const tex = new DataTexture(mipmaps[0]!.data, dds.width, dds.height, RGBAFormat, half ? HalfFloatType : UnsignedByteType)
  if (mipmaps.length > 1) {
    tex.mipmaps = mipmaps as unknown as ImageData[]
    tex.generateMipmaps = false
  }
  else if (half) {
    // half の画像は、GPU によってはミップマップを作れない
    tex.generateMipmaps = false
    tex.minFilter = LinearFilter
    tex.userData.noMipmaps = true
  }
  else {
    tex.generateMipmaps = true
  }
  tex.needsUpdate = true
  return { texture: tex, cpu: true }
}

function toRgba(format: DdsFormat, w: number, h: number, data: Uint8Array): Uint8Array | Uint16Array {
  if (format === 'RGBA8') return new Uint8Array(data)
  if (format === 'BGRA8' || format === 'BGRX8') {
    const out = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) {
      out[i * 4] = data[i * 4 + 2]!
      out[i * 4 + 1] = data[i * 4 + 1]!
      out[i * 4 + 2] = data[i * 4]!
      out[i * 4 + 3] = format === 'BGRX8' ? 255 : data[i * 4 + 3]!
    }
    return out
  }
  return decodeBcnToRgba(format, w, h, data)
}
