// ImageDecoder (WebCodecs) がないブラウザー (Safari の古い版、Firefox の古い版など) で、アニメーション GIF と APNG と WebP を自前で読む
// アニメーションでなければ null (ブラウザーに静止画として読ませる)
import { MAX_ANIMATION_FRAMES } from '../core'
import { animationFrom, frameSize, type Frame, type LoadedImage } from '../image-load'
import { parseWebpAnimation } from './webp'

export async function decodeAnimationFallback(bytes: Uint8Array, type: string, size: number): Promise<LoadedImage | null> {
  if (type === 'image/gif') return decodeGif(bytes, size)
  if (type === 'image/webp') return decodeWebp(bytes, size)
  return decodeApng(bytes, size)
}

// ---------------------------------------------------------------- WebP
// コマごとに、それだけの WebP に包み直したものをブラウザーに読ませ、重ね方と消し方 (MarumaSign 本体の WebpDecoder と同じ) で重ねる

async function decodeWebp(bytes: Uint8Array, size: number): Promise<LoadedImage | null> {
  const anim = parseWebpAnimation(bytes, MAX_ANIMATION_FRAMES)
  if (!anim || anim.frames.length <= 1) return null
  const { width, height } = anim
  if (width * height > 100 * 1000 * 1000) throw new Error('bad size')
  const [cw, ch] = frameSize(width, height, anim.frames.length, size)
  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const g = full.getContext('2d')!
  const out: Frame[] = []
  let time = 0
  let previous: { x: number, y: number, w: number, h: number } | null = null
  for (const f of anim.frames) {
    let bmp: ImageBitmap
    try {
      bmp = await createImageBitmap(new Blob([f.file as BlobPart], { type: 'image/webp' }))
    }
    catch {
      continue
    }
    // 前のコマを背景 (透明) に戻す指示があれば、その範囲を消す
    if (previous) g.clearRect(previous.x, previous.y, previous.w, previous.h)
    if (!f.blend) g.clearRect(f.x, f.y, f.width, f.height)
    g.drawImage(bmp, f.x, f.y, f.width, f.height)
    bmp.close()
    const small = document.createElement('canvas')
    small.width = cw
    small.height = ch
    small.getContext('2d')!.drawImage(full, 0, 0, cw, ch)
    time += f.delay
    out.push({ image: small, end: time })
    previous = f.dispose ? { x: f.x, y: f.y, w: f.width, h: f.height } : null
  }
  if (out.length <= 1) return null
  return animationFrom(out, width, height, anim.loops)
}

// ---------------------------------------------------------------- GIF

interface GifFrame {
  x: number
  y: number
  w: number
  h: number
  delay: number
  disposal: number
  transparent: number
  palette: Uint8Array
  pixels: Uint8Array
}

/** LZW の展開 (GIF の仕様どおり) */
function lzw(minCodeSize: number, data: Uint8Array, pixelCount: number): Uint8Array {
  const out = new Uint8Array(pixelCount)
  const clear = 1 << minCodeSize
  const eoi = clear + 1
  const prefix = new Uint16Array(4096)
  const suffix = new Uint8Array(4096)
  const stack = new Uint8Array(4097)
  let codeSize = minCodeSize + 1
  let codeMask = (1 << codeSize) - 1
  let next = clear + 2
  let old = -1
  let first = 0
  let bits = 0
  let datum = 0
  let op = 0
  for (let i = 0; i < clear; i++) suffix[i] = i
  for (let p = 0; p < data.length && op < pixelCount;) {
    datum |= data[p++]! << bits
    bits += 8
    while (bits >= codeSize && op < pixelCount) {
      let code = datum & codeMask
      datum >>= codeSize
      bits -= codeSize
      if (code === clear) {
        codeSize = minCodeSize + 1
        codeMask = (1 << codeSize) - 1
        next = clear + 2
        old = -1
        continue
      }
      if (code === eoi) return out
      if (old === -1) {
        out[op++] = suffix[code]!
        old = code
        first = code
        continue
      }
      const inCode = code
      let sp = 0
      if (code >= next) {
        stack[sp++] = first
        code = old
      }
      while (code >= clear) {
        if (sp >= 4096) return out
        stack[sp++] = suffix[code]!
        code = prefix[code]!
      }
      first = suffix[code]!
      stack[sp++] = first
      if (next < 4096) {
        prefix[next] = old
        suffix[next] = first
        next++
        if ((next & codeMask) === 0 && next < 4096) {
          codeSize++
          codeMask = (1 << codeSize) - 1
        }
      }
      old = inCode
      while (sp > 0 && op < pixelCount) out[op++] = stack[--sp]!
    }
  }
  return out
}

function parseGif(b: Uint8Array): { width: number, height: number, frames: GifFrame[], loops: number } | null {
  if (b.length < 13) return null
  const width = b[6]! | (b[7]! << 8)
  const height = b[8]! | (b[9]! << 8)
  const flags = b[10]!
  let p = 13
  let global: Uint8Array = new Uint8Array(0)
  if (flags & 0x80) {
    const n = 3 * (1 << ((flags & 7) + 1))
    global = b.subarray(p, p + n)
    p += n
  }
  const frames: GifFrame[] = []
  let delay = 0, disposal = 0, transparent = -1
  let loops = 1
  while (p < b.length && frames.length < MAX_ANIMATION_FRAMES) {
    const block = b[p++]
    if (block === 0x3B) break
    if (block === 0x21) {
      const label = b[p++]
      if (label === 0xF9 && b[p] === 4) {
        const f = b[p + 1]!
        disposal = (f >> 2) & 7
        delay = (b[p + 2]! | (b[p + 3]! << 8)) * 10
        transparent = f & 1 ? b[p + 4]! : -1
      }
      else if (label === 0xFF && b[p] === 11) {
        let s = ''
        for (let i = 0; i < 11; i++) s += String.fromCharCode(b[p + 1 + i]!)
        if (s === 'NETSCAPE2.0' && b[p + 12] === 3) {
          const n = b[p + 14]! | (b[p + 15]! << 8)
          loops = n === 0 ? 0 : n + 1
        }
      }
      while (p < b.length && b[p] !== 0) p += b[p]! + 1
      p++
      continue
    }
    if (block !== 0x2C) return null
    const x = b[p]! | (b[p + 1]! << 8), y = b[p + 2]! | (b[p + 3]! << 8)
    const w = b[p + 4]! | (b[p + 5]! << 8), h = b[p + 6]! | (b[p + 7]! << 8)
    const f = b[p + 8]!
    p += 9
    let palette: Uint8Array = global
    if (f & 0x80) {
      const n = 3 * (1 << ((f & 7) + 1))
      palette = b.subarray(p, p + n)
      p += n
    }
    const interlaced = (f & 0x40) !== 0
    const minCode = b[p++]!
    const parts: Uint8Array[] = []
    let total = 0
    while (p < b.length && b[p] !== 0) {
      const n = b[p]!
      parts.push(b.subarray(p + 1, p + 1 + n))
      total += n
      p += n + 1
    }
    p++
    if (w === 0 || h === 0 || minCode < 2 || minCode > 11) continue
    const data = new Uint8Array(total)
    let at = 0
    for (const part of parts) {
      data.set(part, at)
      at += part.length
    }
    let pixels: Uint8Array = lzw(minCode, data, w * h)
    if (interlaced) {
      const deint = new Uint8Array(w * h)
      let row = 0
      for (const [start, step] of [[0, 8], [4, 8], [2, 4], [1, 2]] as const) {
        for (let yy = start; yy < h; yy += step) deint.set(pixels.subarray(row++ * w, row * w), yy * w)
      }
      pixels = deint
    }
    frames.push({ x, y, w, h, delay, disposal, transparent, palette, pixels })
    delay = 0
    disposal = 0
    transparent = -1
  }
  return { width, height, frames, loops }
}

async function decodeGif(bytes: Uint8Array, size: number): Promise<LoadedImage | null> {
  const gif = parseGif(bytes)
  if (!gif || gif.frames.length <= 1 || !(gif.width > 0 && gif.height > 0)) return null
  const { width, height } = gif
  const [cw, ch] = frameSize(width, height, gif.frames.length, size)
  // 元の大きさで重ねてから、縮めて残す
  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const g = full.getContext('2d')!
  const canvas = new ImageData(width, height)
  const frames: Frame[] = []
  let time = 0
  for (const f of gif.frames) {
    const before = f.disposal === 3 ? new Uint8ClampedArray(canvas.data) : null
    const pal = f.palette
    for (let yy = 0; yy < f.h; yy++) {
      const ty = f.y + yy
      if (ty >= height) break
      for (let xx = 0; xx < f.w; xx++) {
        const tx = f.x + xx
        if (tx >= width) break
        const c = f.pixels[yy * f.w + xx]!
        if (c === f.transparent || c * 3 + 2 >= pal.length) continue
        const o = (ty * width + tx) * 4
        canvas.data[o] = pal[c * 3]!
        canvas.data[o + 1] = pal[c * 3 + 1]!
        canvas.data[o + 2] = pal[c * 3 + 2]!
        canvas.data[o + 3] = 255
      }
    }
    g.putImageData(canvas, 0, 0)
    const small = document.createElement('canvas')
    small.width = cw
    small.height = ch
    small.getContext('2d')!.drawImage(full, 0, 0, cw, ch)
    time += f.delay >= 11 ? f.delay : 100
    frames.push({ image: small, end: time })
    if (f.disposal === 2) {
      for (let yy = 0; yy < f.h; yy++) {
        for (let xx = 0; xx < f.w; xx++) {
          const tx = f.x + xx, ty = f.y + yy
          if (tx < width && ty < height) canvas.data.fill(0, (ty * width + tx) * 4, (ty * width + tx) * 4 + 4)
        }
      }
    }
    else if (before) {
      canvas.data.set(before)
    }
  }
  return animationFrom(frames, width, height, gif.loops)
}

// ---------------------------------------------------------------- APNG

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(parts: Uint8Array[]): number {
  let c = 0xFFFFFFFF
  for (const p of parts) for (let i = 0; i < p.length; i++) c = CRC_TABLE[(c ^ p[i]!) & 0xFF]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length)
  const view = new DataView(out.buffer)
  view.setUint32(0, data.length)
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
  out.set(data, 8)
  view.setUint32(8 + data.length, crc32([out.subarray(4, 8 + data.length)]))
  return out
}

interface ApngFrame {
  w: number
  h: number
  x: number
  y: number
  delay: number
  dispose: number
  blend: number
  data: Uint8Array[]
}

async function decodeApng(b: Uint8Array, size: number): Promise<LoadedImage | null> {
  if (b.length < 33) return null
  let p = 8
  let ihdr: Uint8Array | null = null
  const others: Uint8Array[] = []
  const frames: ApngFrame[] = []
  let animated = false
  let loops = 0
  let current: ApngFrame | null = null
  while (p + 8 <= b.length) {
    const len = u32(b, p)
    const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!)
    const data = b.subarray(p + 8, p + 8 + len)
    p += 12 + len
    if (type === 'IHDR') ihdr = data
    else if (type === 'acTL') {
      animated = true
      loops = u32(data, 4)
    }
    else if (type === 'fcTL') {
      if (frames.length >= MAX_ANIMATION_FRAMES) break
      const num = (data[20]! << 8) | data[21]!
      const den = ((data[22]! << 8) | data[23]!) || 100
      current = { w: u32(data, 4), h: u32(data, 8), x: u32(data, 12), y: u32(data, 16), delay: num * 1000 / den, dispose: data[24]!, blend: data[25]!, data: [] }
      frames.push(current)
    }
    else if (type === 'IDAT') {
      if (current) current.data.push(data)
    }
    else if (type === 'fdAT') {
      if (current) current.data.push(data.subarray(4))
    }
    else if (type === 'IEND') break
    else if (type === 'PLTE' || type === 'tRNS' || type === 'gAMA' || type === 'cHRM' || type === 'sRGB' || type === 'iCCP') {
      others.push(chunk(type, data))
    }
  }
  if (!animated || !ihdr || frames.length <= 1) return null
  const width = u32(ihdr, 0), height = u32(ihdr, 4)
  if (!(width > 0 && height > 0)) return null
  const [cw, ch] = frameSize(width, height, frames.length, size)
  const full = document.createElement('canvas')
  full.width = width
  full.height = height
  const g = full.getContext('2d')!
  const out: Frame[] = []
  let time = 0
  const signature = b.subarray(0, 8)
  for (const f of frames) {
    if (f.data.length === 0 || f.w === 0 || f.h === 0) continue
    const header = new Uint8Array(ihdr)
    const view = new DataView(header.buffer)
    view.setUint32(0, f.w)
    view.setUint32(4, f.h)
    const parts = [signature, chunk('IHDR', header), ...others, ...f.data.map(d => chunk('IDAT', d)), chunk('IEND', new Uint8Array(0))]
    const bmp = await createImageBitmap(new Blob(parts as BlobPart[], { type: 'image/png' }))
    const before = f.dispose === 2 ? g.getImageData(0, 0, width, height) : null
    if (f.blend === 0) g.clearRect(f.x, f.y, f.w, f.h)
    g.drawImage(bmp, f.x, f.y)
    bmp.close()
    const small = document.createElement('canvas')
    small.width = cw
    small.height = ch
    small.getContext('2d')!.drawImage(full, 0, 0, cw, ch)
    time += f.delay >= 11 ? f.delay : 100
    out.push({ image: small, end: time })
    if (f.dispose === 1) g.clearRect(f.x, f.y, f.w, f.h)
    else if (before) g.putImageData(before, 0, 0)
  }
  if (out.length <= 1) return null
  return animationFrom(out, width, height, loops)
}
