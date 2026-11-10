// ブラウザーがそのまま読めない画像の形式 (必要になったときだけ読み込む)
// 自前のもの (raster.ts, extra.ts, tiff.ts, dds.ts, bcn.ts, heif.ts, jp2.ts) と、three.js の読み込み (TGA, HDR, EXR, KTX2) を使う。
// JPEG 2000・HEIC・JPEG XL は codecs.ts (wasm と WebCodecs)。形式ごとの部分は、その形式のときだけ読み込む
import { CanvasTexture, CompressedTexture, DataTexture, FloatType, RGBAFormat, type Texture } from 'three'
import { MAX_ANIMATION_FRAMES } from '../core'
import { animationFrom, decodeBrowser, frameSize, toCanvas, type Frame, type LoadedImage } from '../image-load'
import { setupTexture } from '../board'
import { getRenderer } from '../renderer-ref'
import { getKtx2Loader, withTimeout } from '../ktx2'
import {
  allocate, decodeDib, decodeFarbfeld, decodeFits, decodePcx, decodePfm, decodePnm, decodePsd, decodeQoi, decodeRas, decodeSgi,
  decodeWbmp, decodeXbm, decodeXpm, srgb, type Pixels,
} from './raster'
import type { BcFormat } from './bcn'

/** ピクセルを縮めたテクスチャにする */
export function fromPixels(px: Pixels, size: number): LoadedImage {
  const full = document.createElement('canvas')
  full.width = px.width
  full.height = px.height
  full.getContext('2d')!.putImageData(new ImageData(px.data as Uint8ClampedArray<ArrayBuffer>, px.width, px.height), 0, 0)
  if (px.width <= size && px.height <= size) {
    return { texture: setupTexture(new CanvasTexture(full)), width: px.width, height: px.height, pixels: px.width * px.height }
  }
  const r = toCanvas(full, px.width, px.height, size)
  return { texture: setupTexture(new CanvasTexture(r.canvas)), width: px.width, height: px.height, pixels: r.pixels }
}

/** もう縮めた canvas をテクスチャにする */
function fromCanvas(r: { canvas: HTMLCanvasElement, width: number, height: number }): LoadedImage {
  return { texture: setupTexture(new CanvasTexture(r.canvas)), width: r.width, height: r.height, pixels: r.canvas.width * r.canvas.height }
}

/** TIFF (自前のもので読めなければ、three.js の TIFFLoader (UTIF) でも試す。CCITT の白黒のファクスの圧縮などは UTIF が読める) */
async function decodeTiffAny(bytes: Uint8Array): Promise<Pixels> {
  try {
    return await (await import('./tiff')).decodeTiff(bytes)
  }
  catch (e) {
    if ((e as Error).message === 'bad size') throw e
    try {
      const { TIFFLoader } = await import('three/addons/loaders/TIFFLoader.js')
      const r = new TIFFLoader().parse(buffer(bytes)) as { width: number, height: number, data: Uint8Array }
      return toPixels(r.width, r.height, r.data, false, false)
    }
    catch {
      throw e
    }
  }
}

/** RGBA の 8 ビットか浮動小数点の並びを、ピクセルにする (bottomUp なら行を上下に入れ替える) */
function toPixels(width: number, height: number, data: ArrayLike<number>, float: boolean, bottomUp: boolean): Pixels {
  const px = allocate(width, height)
  for (let y = 0; y < height; y++) {
    const sy = bottomUp ? height - 1 - y : y
    for (let x = 0; x < width * 4; x++) {
      const v = data[sy * width * 4 + x]!
      const o = y * width * 4 + x
      // 透明度は線形のまま
      px.data[o] = float ? ((x & 3) === 3 ? v * 255 : srgb(v)) : v
    }
  }
  return px
}

export async function decode(format: string, bytes: Uint8Array, size: number): Promise<LoadedImage> {
  switch (format) {
    case 'qoi': return fromPixels(decodeQoi(bytes), size)
    case 'psd': return fromPixels(decodePsd(bytes), size)
    case 'pnm': return fromPixels(decodePnm(bytes), size)
    case 'pfm': return fromPixels(decodePfm(bytes), size)
    case 'farbfeld': return fromPixels(decodeFarbfeld(bytes), size)
    case 'pcx': return fromPixels(decodePcx(bytes), size)
    case 'sgi': return fromPixels(decodeSgi(bytes), size)
    case 'ras': return fromPixels(decodeRas(bytes), size)
    case 'wbmp': return fromPixels(decodeWbmp(bytes), size)
    case 'xbm': return fromPixels(decodeXbm(bytes), size)
    case 'xpm': return fromPixels(decodeXpm(bytes), size)
    case 'fits': return fromPixels(decodeFits(bytes), size)
    case 'ico': case 'cur': return fromPixels(await decodeIco(bytes), size)
    case 'ani': return decodeAni(bytes, size)
    case 'icns': return decodeIcns(bytes, size)
    case 'bmp': return fromPixels(decodeBmpFile(bytes), size)
    case 'svg': return decodeSvg(bytes, size)
    case 'svgz': return decodeSvg(await gunzip(bytes, 32 * 1024 * 1024), size)
    case 'tga': {
      const { TGALoader } = await import('three/addons/loaders/TGALoader.js')
      const r = new TGALoader().parse(buffer(bytes)) as { width: number, height: number, data: Uint8Array }
      return fromPixels(toPixels(r.width, r.height, r.data, false, false), size)
    }
    case 'tiff': return fromPixels(await decodeTiffAny(bytes), size)
    case 'dpx': return fromPixels((await import('./extra')).decodeDpx(bytes), size)
    case 'iff': return fromPixels((await import('./extra')).decodeIlbm(bytes), size)
    case 'xwd': return fromPixels((await import('./extra')).decodeXwd(bytes), size)
    case 'pgx': return fromPixels((await import('./extra')).decodePgx(bytes), size)
    case 'jp2': return fromCanvas(await (await import('./codecs')).decodeJpeg2000(bytes, size))
    case 'heic': case 'avif': return fromCanvas(await (await import('./codecs')).decodeHeif(bytes, size, format === 'heic'))
    case 'jxl': return (await import('./codecs')).decodeJxl(bytes, size)
    case 'hdr': {
      const { HDRLoader } = await import('three/addons/loaders/HDRLoader.js')
      const loader = new HDRLoader()
      loader.setDataType(FloatType)
      const r = loader.parse(buffer(bytes)) as { width: number, height: number, data: Float32Array }
      return fromPixels(toPixels(r.width, r.height, r.data, true, false), size)
    }
    case 'exr': {
      const { EXRLoader } = await import('three/addons/loaders/EXRLoader.js')
      const loader = new EXRLoader()
      loader.setDataType(FloatType)
      const r = loader.parse(buffer(bytes)) as { width: number, height: number, data: Float32Array, format: number }
      if (r.format !== RGBAFormat) throw new Error('unsupported exr')
      // EXRLoader は WebGL の向き (下の行から) で返す
      return fromPixels(toPixels(r.width, r.height, r.data, true, true), size)
    }
    case 'dds': return decodeDds(bytes, size)
    case 'ktx2': return decodeKtx2(bytes, size)
    default: throw new Error('unsupported format: ' + format)
  }
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

/** gzip を展開する (max バイトまで) */
async function gunzip(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
  const reader = stream.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    total += r.value.length
    if (total > max) {
      await reader.cancel()
      throw new Error('too large')
    }
    chunks.push(r.value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

// ---------------------------------------------------------------- SVG
// 画像として読むので、中のスクリプトは動かず、外のファイルも読まない (img 要素と同じ)

async function decodeSvg(bytes: Uint8Array, size: number): Promise<LoadedImage> {
  const text = new TextDecoder().decode(bytes)
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml')
  const root = doc.documentElement
  if (!root || root.nodeName.toLowerCase() !== 'svg' || doc.getElementsByTagName('parsererror').length > 0) throw new Error('bad svg')
  // 大きさ: width と height (単位なし・px) か、viewBox の縦横比
  const num = (v: string | null): number => {
    const m = v ? /^\s*([0-9.]+)\s*(px)?\s*$/.exec(v) : null
    return m ? Number(m[1]) : 0
  }
  let w = num(root.getAttribute('width')), h = num(root.getAttribute('height'))
  const vb = (root.getAttribute('viewBox') ?? '').trim().split(/[\s,]+/).map(Number)
  if (!(w > 0 && h > 0) && vb.length === 4 && vb[2]! > 0 && vb[3]! > 0) {
    w = vb[2]!
    h = vb[3]!
  }
  if (!(w > 0 && h > 0)) {
    w = 300
    h = 150
  }
  // 描く大きさ (長い辺を size に)。元の大きさの属性も書き換えて、どのブラウザーでも同じ大きさで描かせる
  const scale = size / Math.max(w, h)
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale))
  if (!root.getAttribute('viewBox')) root.setAttribute('viewBox', `0 0 ${w} ${h}`)
  root.setAttribute('width', String(cw))
  root.setAttribute('height', String(ch))
  const svg = new XMLSerializer().serializeToString(doc)
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  try {
    const img = new Image()
    img.decoding = 'async'
    img.src = url
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = cw
    canvas.height = ch
    canvas.getContext('2d')!.drawImage(img, 0, 0, cw, ch)
    return { texture: setupTexture(new CanvasTexture(canvas)), width: w, height: h, pixels: cw * ch }
  }
  finally {
    URL.revokeObjectURL(url)
  }
}

// ---------------------------------------------------------------- ICO, CUR, ANI, ICNS, BMP

function isPng(b: Uint8Array): boolean {
  return b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47
}

/** PNG をピクセルにする (ブラウザーに読ませる) */
async function pngPixels(b: Uint8Array): Promise<Pixels> {
  const bmp = await createImageBitmap(new Blob([b as BlobPart], { type: 'image/png' }))
  try {
    const px = allocate(bmp.width, bmp.height)
    const c = document.createElement('canvas')
    c.width = bmp.width
    c.height = bmp.height
    const g = c.getContext('2d')!
    g.drawImage(bmp, 0, 0)
    px.data.set(g.getImageData(0, 0, bmp.width, bmp.height).data)
    return px
  }
  finally {
    bmp.close()
  }
}

/** ICO と CUR の中の、いちばん大きい絵 */
async function decodeIco(b: Uint8Array): Promise<Pixels> {
  if (b.length < 6) throw new Error('bad ico')
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const count = dv.getUint16(4, true)
  let best = -1, bestScore = -1
  for (let i = 0; i < count && 6 + i * 16 + 16 <= b.length; i++) {
    const e = 6 + i * 16
    const w = b[e] || 256, h = b[e + 1] || 256
    const bpp = dv.getUint16(e + 6, true)
    const score = w * h * 64 + bpp
    if (score > bestScore) {
      bestScore = score
      best = e
    }
  }
  if (best < 0) throw new Error('bad ico')
  const size = dv.getUint32(best + 8, true), offset = dv.getUint32(best + 12, true)
  const data = b.subarray(offset, offset + size)
  return isPng(data) ? pngPixels(data) : decodeDib(data)
}

/** BMP ファイル (ブラウザーが読めなかったとき。中身の形は ICO の中のものと同じ) */
function decodeBmpFile(b: Uint8Array): Pixels {
  // ICO の中のものは高さが 2 倍で、AND の面がある。ここでは高さを 2 倍にした写しを作って同じ読み方をする
  const dib = new Uint8Array(b.subarray(14))
  const dv = new DataView(dib.buffer)
  dv.setInt32(8, dv.getInt32(8, true) * 2, true)
  return decodeDib(dib)
}

/** RIFF の中の塊を順に見る */
function riff(b: Uint8Array, start: number, end: number, each: (id: string, data: Uint8Array) => void): void {
  let p = start
  while (p + 8 <= end) {
    const id = String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!)
    const len = (b[p + 4]! | (b[p + 5]! << 8) | (b[p + 6]! << 16) | (b[p + 7]! << 24)) >>> 0
    each(id, b.subarray(p + 8, Math.min(end, p + 8 + len)))
    p += 8 + len + (len & 1)
  }
}

/** ANI (アニメーションのカーソル) */
async function decodeAni(b: Uint8Array, size: number): Promise<LoadedImage> {
  let rate = 10
  let rates: number[] = []
  let seq: number[] = []
  const icons: Uint8Array[] = []
  riff(b, 12, b.length, (id, data) => {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
    if (id === 'anih' && data.length >= 36) rate = dv.getUint32(28, true) || 10
    else if (id === 'rate') rates = Array.from({ length: data.length >> 2 }, (_, i) => dv.getUint32(i * 4, true))
    else if (id === 'seq ') seq = Array.from({ length: data.length >> 2 }, (_, i) => dv.getUint32(i * 4, true))
    else if (id === 'LIST' && String.fromCharCode(data[0]!, data[1]!, data[2]!, data[3]!) === 'fram') {
      riff(data, 4, data.length, (sub, icon) => {
        if (sub === 'icon' && icons.length < MAX_ANIMATION_FRAMES) icons.push(icon)
      })
    }
  })
  if (icons.length === 0) throw new Error('bad ani')
  const decoded: Pixels[] = []
  for (const icon of icons) decoded.push(await decodeIco(icon))
  const first = decoded[0]!
  if (decoded.length === 1) return fromPixels(first, size)
  const steps = seq.length ? seq : decoded.map((_, i) => i)
  const [cw, ch] = frameSize(first.width, first.height, steps.length, size)
  const frames: Frame[] = []
  let time = 0
  const canvases = decoded.map(px => fromPixels(px, Math.max(cw, ch)).texture.image as HTMLCanvasElement)
  for (let i = 0; i < steps.length && i < MAX_ANIMATION_FRAMES; i++) {
    const image = canvases[steps[i]!]
    if (!image) continue
    // 速さは 1/60 秒単位
    time += Math.max(1, rates[i] ?? rate) * 1000 / 60
    frames.push({ image, end: time })
  }
  return animationFrom(frames, first.width, first.height, 0)
}

/** ICNS (macOS のアイコン)。中の PNG のうち、いちばん大きいもの */
async function decodeIcns(b: Uint8Array, size: number): Promise<LoadedImage> {
  const order = ['ic10', 'ic14', 'ic09', 'ic13', 'ic08', 'ic12', 'ic07', 'ic11', 'icp6', 'icp5', 'icp4']
  const entries = new Map<string, Uint8Array>()
  let p = 8
  while (p + 8 <= b.length) {
    const id = String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!)
    const len = ((b[p + 4]! << 24) | (b[p + 5]! << 16) | (b[p + 6]! << 8) | b[p + 7]!) >>> 0
    if (len < 8) break
    entries.set(id, b.subarray(p + 8, Math.min(b.length, p + len)))
    p += len
  }
  for (const id of [...order, ...entries.keys()]) {
    const data = entries.get(id)
    if (!data) continue
    if (isPng(data)) return decodeBrowser(data, 'image/png', size)
    // JPEG 2000 のもの (Safari はそのまま読める。ほかは codecs.ts)
    if ((data[4] === 0x6A && data[5] === 0x50) || (data[0] === 0xFF && data[1] === 0x4F)) {
      try {
        return await decodeBrowser(data, 'image/jp2', size)
      }
      catch { /* 自前で読む */ }
      try {
        return fromCanvas(await (await import('./codecs')).decodeJpeg2000(data, size))
      }
      catch { /* 次のものを試す */ }
    }
  }
  throw new Error('no readable icon in icns')
}

// ---------------------------------------------------------------- DDS, KTX2 (GPU 向けの圧縮)
// GPU が対応していれば圧縮のまま渡し、対応していなければ (スマートフォンの多く) CPU で RGBA にする (bcn.ts)

// three.js の圧縮の形式の番号 (RGBA_S3TC_DXT1/3/5, RGBA_BPTC, RGB_BPTC_SIGNED/UNSIGNED, RED_RGTC1, SIGNED_RED_RGTC1, RED_GREEN_RGTC2, SIGNED_RED_GREEN_RGTC2)
const GPU_FORMAT: Partial<Record<BcFormat, number>> = { bc1: 33777, bc2: 33778, bc3: 33779, bc7: 36492 }
const BC_OF_GPU_FORMAT: Record<number, BcFormat> = {
  33776: 'bc1', 33777: 'bc1', 33778: 'bc2', 33779: 'bc3', 36492: 'bc7', 36494: 'bc6hs', 36495: 'bc6h',
  36283: 'bc4', 36284: 'bc4s', 36285: 'bc5', 36286: 'bc5s',
}

/** この GPU で、この圧縮の形式を sRGB のテクスチャとして描けるか (看板のテクスチャは sRGB。board.ts の setupTexture) */
function gpuSupports(format: number, srgb: boolean): boolean {
  const gl = getRenderer()
  if (!gl) return false
  const has = (name: string): boolean => gl.extensions.has(name)
  if (format >= 33776 && format <= 33779) return has('WEBGL_compressed_texture_s3tc') && (!srgb || has('WEBGL_compressed_texture_s3tc_srgb'))
  if (format >= 36492 && format <= 36495) return has('EXT_texture_compression_bptc')
  if (format >= 36283 && format <= 36286) return has('EXT_texture_compression_rgtc') && !srgb
  return false
}

async function decodeDds(bytes: Uint8Array, size: number): Promise<LoadedImage> {
  const { readDdsHeader, ddsMipmaps, decodeDdsPixels } = await import('./dds')
  const h = readDdsHeader(bytes)
  allocate(h.width, h.height)
  const format = h.bc ? GPU_FORMAT[h.bc] : undefined
  // GPU にそのまま渡せるもの (BC1・BC2・BC3・BC7 で、大きさが 4 の倍数の 1 枚の絵)。ほかは MarumaSign 本体と同じく CPU で読む
  if (format && !h.cubemap && h.width % 4 === 0 && h.height % 4 === 0 && gpuSupports(format, true)) {
    const mipmaps = ddsMipmaps(bytes, h)
    if (mipmaps.length) {
      const tex = new CompressedTexture(mipmaps as unknown as ImageData[], h.width, h.height, format as never)
      setupTexture(tex, false)
      // 縮小した絵がそろっていれば使う
      const complete = mipmaps.length > 1 && mipmaps[mipmaps.length - 1]!.width === 1 && mipmaps[mipmaps.length - 1]!.height === 1
      tex.minFilter = complete ? 1008 : 1006 // LinearMipmapLinearFilter : LinearFilter
      if (!complete) tex.mipmaps = [mipmaps[0]] as unknown as ImageData[]
      tex.needsUpdate = true
      return { texture: tex, width: h.width, height: h.height, pixels: h.width * h.height }
    }
  }
  return fromPixels(decodeDdsPixels(bytes), size)
}

async function decodeKtx2(bytes: Uint8Array, size: number): Promise<LoadedImage> {
  const loader = await getKtx2Loader()
  const tex = await withTimeout(new Promise<Texture>((resolve, reject) => loader.parse(buffer(bytes), resolve, reject)), 20000)
  const image = tex.image as { width: number, height: number, depth?: number }
  allocate(image.width, image.height)
  if ((tex as { isCubeTexture?: boolean }).isCubeTexture || (image.depth ?? 1) > 1) {
    tex.dispose()
    throw new Error('unsupported ktx2')
  }
  // 圧縮のまま入っている KTX2 (Basis ではないもの) で、GPU が対応していない BC の形式は、CPU で RGBA にする
  if (tex instanceof CompressedTexture) {
    const bc = BC_OF_GPU_FORMAT[tex.format as number]
    const m = (tex.mipmaps as unknown as { data: Uint8Array, width: number, height: number }[] | undefined)?.[0]
    if (bc && m && !gpuSupports(tex.format as number, tex.colorSpace === 'srgb')) {
      tex.dispose()
      const { decodeBc } = await import('./bcn')
      const px = allocate(m.width, m.height)
      px.data.set(decodeBc(bc, m.data, 0, m.width, m.height))
      return fromPixels(px, size)
    }
  }
  if (tex instanceof DataTexture) tex.flipY = false
  tex.needsUpdate = true
  return { texture: tex, width: image.width, height: image.height, pixels: image.width * image.height }
}
