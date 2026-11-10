// 画像の読み込み (fetch で読み、種類と大きさを確かめて、縮めたテクスチャにする)
// ブラウザーがそのまま読める形式 (png, apng, gif, jpeg, webp, bmp, avif) は前のスクリプトと同じ読み方で、
// アニメーション (gif, apng, webp, avif) はコマごとに読む。ほかの形式は decoders/ (必要になったときだけ読み込む)
import { CanvasTexture, type Texture } from 'three'
import {
  fitScale, IMAGE_TYPES, MAX_ANIMATION_FRAMES, MAX_ANIMATION_SIZE, MAX_IMAGE_BYTES, MAX_IMAGE_PIXELS, MAX_STATIC_SIZE, sniff,
} from './core'
import { concat, open, readHead, readLimited, readRest, sniffAsync, WrongKindError } from './fetch'
import { setupTexture } from './board'

// アニメーション 1 つのコマのピクセルの合計の上限 (縮めて収める)
const ANIMATION_PIXEL_BUDGET = 8 * 1024 * 1024

/** アニメーションのコマ */
export interface Frame {
  image: CanvasImageSource & { width: number, height: number, close?: () => void }
  /** このコマが終わる時刻 (ミリ秒, 累積) */
  end: number
}

/** 読み込んだ画像 */
export interface LoadedImage {
  texture: Texture
  /** 元の画像の大きさ (縦横比だけ使う) */
  width: number
  height: number
  /** テクスチャのピクセル数 (アニメーションはすべてのコマの合計) */
  pixels: number
  animation?: Animation
}

/**
 * アニメーションの再生 (MarumaSign 本体の TextureEntry.current と同じく、読み込んでからの時間でコマを選ぶ)。
 * 1 つのテクスチャ (canvas) に、いまのコマを描き直す。
 */
export class Animation {
  readonly canvas: HTMLCanvasElement
  readonly texture: CanvasTexture
  readonly frames: Frame[]
  readonly total: number
  /** 繰り返す回数 (0 はずっと) */
  readonly repetitions: number
  private readonly g: CanvasRenderingContext2D
  private readonly start = performance.now()
  private current = -1

  constructor(canvas: HTMLCanvasElement, frames: Frame[], repetitions: number) {
    this.canvas = canvas
    this.g = canvas.getContext('2d')!
    this.frames = frames
    this.total = frames.length ? frames[frames.length - 1]!.end : 0
    this.repetitions = repetitions
    this.texture = setupTexture(new CanvasTexture(canvas), false)
    this.draw(0)
  }

  /** いまのコマに進める。変わったら true */
  tick(now: number): boolean {
    if (this.frames.length <= 1 || this.total <= 0) return false
    const elapsed = now - this.start
    let index: number
    if (this.repetitions > 0 && elapsed >= this.total * this.repetitions) {
      index = this.frames.length - 1
    }
    else {
      const time = elapsed % this.total
      let low = 0, high = this.frames.length - 1
      while (low < high) {
        const mid = (low + high) >>> 1
        if (this.frames[mid]!.end > time) high = mid
        else low = mid + 1
      }
      index = low
    }
    if (index === this.current) return false
    this.draw(index)
    return true
  }

  private draw(index: number): void {
    const f = this.frames[index]
    if (!f) return
    this.g.clearRect(0, 0, this.canvas.width, this.canvas.height)
    this.g.drawImage(f.image, 0, 0, this.canvas.width, this.canvas.height)
    this.texture.needsUpdate = true
    this.current = index
  }

  dispose(): void {
    this.texture.dispose()
    for (const f of this.frames) f.image.close?.()
  }
}

/** 縮めた canvas に描く (前のスクリプトと同じ) */
export function toCanvas(source: CanvasImageSource, w: number, h: number, size: number): { canvas: HTMLCanvasElement, pixels: number } {
  const scale = Math.min(1, size / Math.max(w, h))
  const cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale))
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(source, 0, 0, cw, ch)
  return { canvas, pixels: cw * ch }
}

function still(canvas: HTMLCanvasElement, width: number, height: number, pixels: number): LoadedImage {
  return { texture: setupTexture(new CanvasTexture(canvas)), width, height, pixels }
}

function checkSize(w: number, h: number): void {
  if (!(w > 0 && h > 0) || w * h > MAX_IMAGE_PIXELS) throw new Error('bad size')
}

/** ブラウザーが読める画像を、縮めたテクスチャにする (前のスクリプトの fetchTexture の後半と同じ) */
export async function decodeBrowserStill(blob: Blob, size: number): Promise<LoadedImage> {
  const bmp = await createImageBitmap(blob)
  try {
    const w = bmp.width, h = bmp.height
    checkSize(w, h)
    const r = toCanvas(bmp, w, h, size)
    return still(r.canvas, w, h, r.pixels)
  }
  finally {
    bmp.close?.()
  }
}

/** ImageDecoder (WebCodecs) が使えるか */
function hasImageDecoder(): boolean {
  return typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder === 'function'
}

/** アニメーションかもしれない形式 */
const MAYBE_ANIMATED = new Set(['image/gif', 'image/png', 'image/apng', 'image/webp', 'image/avif'])

/** 縮めたコマ */
async function scaledFrame(source: CanvasImageSource, cw: number, ch: number): Promise<Frame['image']> {
  const canvas = document.createElement('canvas')
  canvas.width = cw
  canvas.height = ch
  canvas.getContext('2d')!.drawImage(source, 0, 0, cw, ch)
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(canvas)
    }
    catch { /* canvas のまま使う */ }
  }
  return canvas
}

/** コマの大きさと数から、縮めたアニメーションを作る */
export function animationFrom(frames: Frame[], width: number, height: number, repetitions: number): LoadedImage {
  const first = frames[0]!
  const canvas = document.createElement('canvas')
  canvas.width = first.image.width
  canvas.height = first.image.height
  const animation = new Animation(canvas, frames, repetitions)
  const pixels = canvas.width * canvas.height * (frames.length + 1)
  return { texture: animation.texture, width, height, pixels, animation }
}

/** アニメーションの縮める大きさ (一辺は size と 2048 まで、全部のコマで上限まで) */
export function frameSize(w: number, h: number, frames: number, size: number): [number, number] {
  const scale = fitScale(w, h, Math.min(size, MAX_ANIMATION_SIZE), frames, ANIMATION_PIXEL_BUDGET)
  return [Math.max(1, Math.round(w * scale)), Math.max(1, Math.round(h * scale))]
}

/**
 * ImageDecoder でアニメーションを読む。アニメーションでなければ null (静止画として読み直す)。
 */
async function decodeAnimated(bytes: Uint8Array, type: string, size: number): Promise<LoadedImage | null> {
  const ID = (globalThis as unknown as { ImageDecoder: ImageDecoderConstructor }).ImageDecoder
  const decoder = new ID({ data: bytes, type, colorSpaceConversion: 'default', preferAnimation: true })
  try {
    await decoder.tracks.ready
    const track = decoder.tracks.selectedTrack
    if (!track || !track.animated) return null
    await decoder.completed
    const count = Math.min(track.frameCount, MAX_ANIMATION_FRAMES)
    if (count <= 1) return null
    const first = (await decoder.decode({ frameIndex: 0 })).image
    const w = first.displayWidth, h = first.displayHeight
    first.close()
    checkSize(w, h)
    const [cw, ch] = frameSize(w, h, count, size)
    const frames: Frame[] = []
    let time = 0
    for (let i = 0; i < count; i++) {
      const r = await decoder.decode({ frameIndex: i, completeFramesOnly: true })
      const f = r.image
      try {
        // コマの長さ (マイクロ秒)。0 や短すぎるものはブラウザーと同じく 100 ミリ秒にする
        let ms = (f.duration ?? 0) / 1000
        if (!(ms >= 11)) ms = 100
        time += ms
        frames.push({ image: await scaledFrame(f, cw, ch), end: time })
      }
      finally {
        f.close()
      }
    }
    const reps = track.repetitionCount
    // repetitionCount は「最初の再生のあとに繰り返す回数」。Infinity はずっと
    const repetitions = Number.isFinite(reps) ? Math.max(1, Math.round(reps) + 1) : 0
    return animationFrom(frames, w, h, repetitions)
  }
  finally {
    decoder.close()
  }
}

/** ImageDecoder がその形式を読めるか */
async function imageDecoderSupports(type: string): Promise<boolean> {
  if (!hasImageDecoder()) return false
  const ID = (globalThis as unknown as { ImageDecoder: ImageDecoderConstructor }).ImageDecoder
  if (typeof ID.isTypeSupported !== 'function') return true
  try {
    return await ID.isTypeSupported(type)
  }
  catch {
    return false
  }
}

/** ImageDecoder がないときに、自前でコマを読める形式 (decoders/animation.ts) */
const OWN_ANIMATION = new Set(['image/gif', 'image/png', 'image/apng', 'image/webp'])

/**
 * ブラウザーが読める形式 (png, apng, gif, jpeg, webp, bmp, avif など) を読む。
 * アニメーションなら、ImageDecoder があればそれで、なければ (その形式を読めなければ) gif と apng と webp は自前で読む。
 */
export async function decodeBrowser(bytes: Uint8Array, type: string, size: number): Promise<LoadedImage> {
  if (MAYBE_ANIMATED.has(type)) {
    const t = type === 'image/apng' ? 'image/png' : type
    if (await imageDecoderSupports(t)) {
      try {
        const a = await decodeAnimated(bytes, t, size)
        if (a) return a
      }
      catch (e) {
        // 読めなければ静止画として読み直す (サイズが大きすぎるときは、静止画でも同じ理由で失敗する)
        if ((e as Error).message === 'bad size') throw e
      }
    }
    else if (OWN_ANIMATION.has(type)) {
      const { decodeAnimationFallback } = await import('./decoders/animation')
      const a = await decodeAnimationFallback(bytes, type, size)
      if (a) return a
    }
  }
  return decodeBrowserStill(new Blob([bytes as BlobPart], { type }), size)
}

/**
 * 看板の画像を読む。
 * Content-Type が前のスクリプトと同じ画像の種類なら、そのまま読む。そうでなければ先頭のバイト列で形式を決め、
 * 画像でなければ WrongKindError (動画や PDF など、正しい描き方に任せる)。
 * @param size テクスチャの一辺の上限
 * @param ext URL の拡張子 (目印のない形式を決めるのに使う)
 */
export async function loadImage(url: string, size: number, ext: string): Promise<LoadedImage> {
  const o = await open(url)
  try {
    if (IMAGE_TYPES.has(o.type)) {
      const bytes = concat(await readLimited(o, MAX_IMAGE_BYTES))
      try {
        return await decodeBrowser(bytes, o.type, size)
      }
      catch (e) {
        // Content-Type と中身が違う (image/png として送られた TIFF など)、またはこのブラウザーが読めない (AVIF など) ときは、
        // 中身で形式を決めて読み直す (MarumaSign 本体は、いつも中身で決める)
        const s = sniff(bytes.subarray(0, 4096), '', ext)
        if (!s || s.route !== 'image' || (e as Error).message === 'bad size' || (NATIVE[s.format] === o.type && !(s.format in OWN_FALLBACK))) throw e
        return await decodeFormat(s.format, bytes, size)
      }
    }
    const h = await readHead(o, 64)
    const s = await sniffAsync(h.head, o.type, ext)
    if (!s) {
      o.controller.abort()
      throw new Error('not an image')
    }
    if (s.route !== 'image') {
      o.controller.abort()
      throw new WrongKindError(s.route, s.format)
    }
    const bytes = await readRest(o, h, MAX_IMAGE_BYTES)
    return await decodeFormat(s.format, bytes, size)
  }
  finally {
    o.done()
  }
}

/** 形式ごとに読む */
export async function decodeFormat(format: string, bytes: Uint8Array, size: number): Promise<LoadedImage> {
  const native = NATIVE[format]
  if (native) {
    try {
      return await decodeBrowser(bytes, native, size)
    }
    catch (e) {
      // ICO などは自前でも読める (heic, jxl, jp2, avif は decoders/codecs.ts)
      if (!(format in OWN_FALLBACK) || (e as Error).message === 'bad size') throw e
    }
  }
  const { decode } = await import('./decoders/index')
  const r = await decode(format, bytes, Math.min(size, MAX_STATIC_SIZE))
  return r
}

// ブラウザーが読めるかもしれない形式と、その MIME (Safari は heic を、Chrome は jxl を読める)
const NATIVE: Record<string, string> = {
  png: 'image/png', gif: 'image/gif', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
  ico: 'image/x-icon', heic: 'image/heic', jxl: 'image/jxl', jp2: 'image/jp2',
}
// ブラウザーが読めなくても、自前で読める形式
const OWN_FALLBACK: Record<string, true> = { ico: true, bmp: true, heic: true, jxl: true, jp2: true, avif: true }

// ---------------------------------------------------------------- ImageDecoder の型 (TypeScript の DOM の型にまだないため)

interface ImageDecoderInit {
  data: ArrayBufferView | ArrayBuffer
  type: string
  colorSpaceConversion?: 'default' | 'none'
  preferAnimation?: boolean
}

type DecodedVideoFrame = VideoFrame

interface ImageTrack {
  readonly animated: boolean
  readonly frameCount: number
  readonly repetitionCount: number
}

interface ImageDecoderLike {
  readonly tracks: { readonly ready: Promise<void>, readonly selectedTrack: ImageTrack | null }
  readonly completed: Promise<void>
  decode(options?: { frameIndex?: number, completeFramesOnly?: boolean }): Promise<{ image: DecodedVideoFrame, complete: boolean }>
  close(): void
}

interface ImageDecoderConstructor {
  new (init: ImageDecoderInit): ImageDecoderLike
  isTypeSupported?(type: string): Promise<boolean>
}
