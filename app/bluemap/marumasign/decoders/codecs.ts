// ブラウザーがそのまま読めないことの多い形式 (JPEG 2000、HEIC・HEIF、JPEG XL、AVIF)。
// ブラウザーが読めればそれを使い (image-load.ts の decodeFormat。Safari は HEIC を、Chrome は JPEG XL を読める)、読めなければここで読む:
//  - JPEG 2000: pdf.js の OpenJPEG (wasm。PDF の看板と同じもの。relaxed SIMD を読めないブラウザーでは wasm を使わない版)
//  - HEIC・HEIF・AVIF: 箱は自前で読み (heif.ts)、HEVC と AV1 はブラウザーの WebCodecs (VideoDecoder) で展開する
//  - JPEG XL: jxl-oxide (wasm。MIT か Apache-2.0)
// どれも、その形式の看板が近くに来たときに初めて読み込む。wasm はビルドに入れて /_nuxt/ から返す
import { decodeBrowserStill, toCanvas } from '../image-load'
import { parseHeif, type HeifImage } from './heif'
import { jp2Alpha, jp2Size, jpxPdf } from './jp2'

/** 時間までに終わらなければ失敗にする */
function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(what + ' timed out')), ms)
    promise.then((v) => {
      clearTimeout(timer)
      resolve(v)
    }, (e: unknown) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

// ---------------------------------------------------------------- JPEG 2000

// pdf.js の上限 (pdf-engine.ts の maxImageSize) より大きな絵は、pdf.js が描かずに消すので先に断る
const MAX_JPX_PIXELS = 4096 * 4096

/**
 * relaxed SIMD を読める wasm の実行か (pdf.js の openjpeg.wasm が使う。Safari などの読めないブラウザーでは、pdf.js は wasm を諦める)。
 * relaxed SIMD の命令 (i8x16.relaxed_swizzle) を 1 つだけ使う関数の wasm を確かめる
 */
function relaxedSimd(): boolean {
  try {
    return WebAssembly.validate(new Uint8Array([
      0, 97, 115, 109, 1, 0, 0, 0, // wasm の印と版
      1, 5, 1, 96, 0, 1, 123, // 型: () -> v128
      3, 2, 1, 0, // 関数 1 つ
      10, 15, 1, 13, 0, 65, 1, 253, 15, 65, 2, 253, 15, 253, 128, 2, 11, // i32.const 1, i8x16.splat, i32.const 2, i8x16.splat, i8x16.relaxed_swizzle
    ]))
  }
  catch {
    return false
  }
}

interface OpenJpegModule {
  _malloc(size: number): number
  _free(ptr: number): void
  _jp2_decode(ptr: number, size: number, numComponents: number, indexed: boolean, smaskInData: boolean, reducePower: number): number
  writeArrayToMemory(bytes: Uint8Array, ptr: number): void
  imageData?: Uint8ClampedArray | null
  errorMessages?: string
}

let openjpegJs: Promise<OpenJpegModule> | null = null

/**
 * pdf.js の OpenJPEG の、wasm を使わない版 (pdf.js が wasm を読めないブラウザーで使うもの) で JPEG 2000 を読む。
 * pdf.js の Worker を通さず、ここで直接呼ぶ (RGBA で返る)
 */
async function decodeJpeg2000Js(bytes: Uint8Array, width: number, height: number, size: number, alpha: 0 | 1 | 2): Promise<HTMLCanvasElement> {
  if (!openjpegJs) {
    // pdf-engine.ts が pdf.js に渡すのと同じファイル (そのままの形で /_nuxt/ に置かれる) を読む
    openjpegJs = import('pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url')
      .then(u => import(/* @vite-ignore */ u.default) as Promise<{ default: (o: object) => Promise<OpenJpegModule> }>)
      .then(m => m.default({ warn: () => {} }))
    openjpegJs.catch(() => {
      openjpegJs = null
    })
  }
  const m = await openjpegJs
  // 大きな絵は、縮めた解像度で展開する (JPEG 2000 は 1/2, 1/4 ... の解像度だけを取り出せる)
  let reduce = 0
  while (reduce < 5 && Math.max(width, height) / Math.pow(2, reduce + 1) >= size) reduce++
  for (const r of reduce ? [reduce, 0] : [0]) {
    const ptr = m._malloc(bytes.length)
    let ret: number
    try {
      m.writeArrayToMemory(bytes, ptr)
      ret = m._jp2_decode(ptr, bytes.length, 4, false, alpha !== 0, r)
    }
    finally {
      m._free(ptr)
    }
    const data = m.imageData
    m.imageData = null
    delete m.errorMessages
    const w = Math.ceil(width / Math.pow(2, r)), h = Math.ceil(height / Math.pow(2, r))
    if (ret !== 0 || !data || data.length !== w * h * 4) continue
    if (alpha === 2) {
      // 色に透明度を掛けてあるものは、戻す
      for (let i = 0; i < data.length; i += 4) {
        const a = data[i + 3]!
        if (a > 0 && a < 255) for (let c = 0; c < 3; c++) data[i + c] = data[i + c]! * 255 / a
      }
    }
    const full = document.createElement('canvas')
    full.width = w
    full.height = h
    full.getContext('2d')!.putImageData(new ImageData(data as Uint8ClampedArray<ArrayBuffer>, w, h), 0, 0)
    return toCanvas(full, w, h, size).canvas
  }
  throw new Error('openjpeg could not decode the image')
}

/** canvas がすべて透明か (pdf.js は絵を読めなくても、何も描かずに終わる) */
function blank(canvas: HTMLCanvasElement): boolean {
  const d = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
  for (let i = 3; i < d.length; i += 4) if (d[i] !== 0) return false
  return true
}

/** JPEG 2000 を、長い辺が size までの canvas にする */
export async function decodeJpeg2000(bytes: Uint8Array, size: number): Promise<{ canvas: HTMLCanvasElement, width: number, height: number }> {
  const dims = jp2Size(bytes)
  if (!dims) throw new Error('bad jpeg 2000')
  const { width, height } = dims
  if (width * height > MAX_JPX_PIXELS) throw new Error('bad size')
  const alpha = jp2Alpha(bytes)
  // pdf.js の wasm を読めないブラウザーでは、wasm を使わない版を直接呼ぶ
  if (!relaxedSimd()) return { canvas: await decodeJpeg2000Js(bytes, width, height, size, alpha), width, height }
  const canvas = await decodeJpeg2000Pdf(bytes, width, height, size, alpha)
  if (!blank(canvas)) return { canvas, width, height }
  return { canvas: await decodeJpeg2000Js(bytes, width, height, size, alpha), width, height }
}

/** pdf.js (Worker と wasm) で、絵を 1 枚だけ置いた PDF のページとして描く */
async function decodeJpeg2000Pdf(bytes: Uint8Array, width: number, height: number, size: number, alpha: 0 | 1 | 2): Promise<HTMLCanvasElement> {
  const { openPdf } = await import('../pdf-engine')
  const pdf = await openPdf(jpxPdf(bytes, width, height, alpha))
  try {
    const page = await pdf.doc.getPage(1)
    try {
      const scale = Math.min(1, size / Math.max(width, height))
      const viewport = page.getViewport({ scale })
      const canvas = document.createElement('canvas')
      canvas.width = Math.max(1, Math.round(width * scale))
      canvas.height = Math.max(1, Math.round(height * scale))
      // 透明な紙の上に描く (JPEG 2000 の透明度を残す)。pdf.js に canvas を渡すと透明度のない描き方にするので、透明度のある context を渡す
      const canvasContext = canvas.getContext('2d')!
      await withTimeout(page.render({ canvas: null, canvasContext, viewport, background: 'rgba(0,0,0,0)' }).promise, 30000, 'jpeg 2000')
      return canvas
    }
    finally {
      page.cleanup()
    }
  }
  finally {
    void pdf.destroy()
  }
}

// ---------------------------------------------------------------- HEIC・HEIF・AVIF (WebCodecs)

interface VideoDecoderLike {
  configure(config: object): void
  decode(chunk: unknown): void
  flush(): Promise<void>
  close(): void
}

interface WebCodecs {
  VideoDecoder: {
    new (init: { output: (f: VideoFrame) => void, error: (e: Error) => void }): VideoDecoderLike
    isConfigSupported(config: object): Promise<{ supported?: boolean }>
  }
  EncodedVideoChunk: new (init: { type: 'key', timestamp: number, data: Uint8Array }) => unknown
}

/** HEVC か AV1 の絵 (格子に並べたものを含む) を、元の大きさの canvas に展開する */
async function decodeHeifImage(img: HeifImage): Promise<HTMLCanvasElement> {
  const w = globalThis as unknown as Partial<WebCodecs>
  if (typeof w.VideoDecoder !== 'function' || typeof w.EncodedVideoChunk !== 'function') throw new Error('webcodecs is not available')
  const config = { codec: img.codec, description: img.description, optimizeForLatency: true }
  const support = await w.VideoDecoder.isConfigSupported(config)
  if (!support.supported) throw new Error('this browser cannot decode ' + img.codec)
  const frames: VideoFrame[] = []
  let failure: Error | null = null
  const decoder = new w.VideoDecoder({ output: f => frames.push(f), error: (e) => { failure = e } })
  try {
    decoder.configure(config)
    img.tiles.forEach((t, i) => decoder.decode(new w.EncodedVideoChunk!({ type: 'key', timestamp: i, data: t.data })))
    await withTimeout(decoder.flush(), 30000, 'heif')
    if (failure) throw failure
    if (frames.length < img.tiles.length) throw new Error('heif tiles were not decoded')
    const tw = frames[0]!.displayWidth, th = frames[0]!.displayHeight
    const grid = img.tiles.length > 1
    const width = grid ? img.width : (img.width || tw), height = grid ? img.height : (img.height || th)
    if (!(width > 0 && height > 0) || width * height > 100 * 1000 * 1000) throw new Error('bad size')
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const g = canvas.getContext('2d')!
    frames.forEach((f, i) => g.drawImage(f as unknown as CanvasImageSource, (i % img.columns) * tw, Math.floor(i / img.columns) * th))
    return canvas
  }
  finally {
    for (const f of frames) f.close()
    try {
      decoder.close()
    }
    catch { /* 閉じてあった */ }
  }
}

/**
 * AV1 の絵の入った HEIF を、ブランドだけ AVIF にした写し (ブラウザーの AVIF の読み込みは、avif のブランドがないと読まない)。
 * ブラウザーに読ませれば、透明度・格子・回転もそのまま扱える
 */
function asAvif(bytes: Uint8Array): Uint8Array {
  const b = bytes.slice()
  const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  const brand = (s: string, at: number): void => {
    for (let i = 0; i < 4; i++) b[at + i] = s.charCodeAt(i)
  }
  brand('avif', 8)
  // 互換ブランドの最後を avif にする (mif1 などは残す)
  if (size >= 20 && size <= b.length) brand('avif', size - 4)
  return b
}

/**
 * HEIF (HEIC・AVIF) を、長い辺が size までの canvas にする
 * @param asAvifFirst AV1 の絵なら、まずブランドを AVIF にしてブラウザーに読ませる (ブラウザーがもう AVIF として読めなかったときは false)
 */
export async function decodeHeif(bytes: Uint8Array, size: number, asAvifFirst: boolean): Promise<{ canvas: HTMLCanvasElement, width: number, height: number }> {
  const pic = parseHeif(bytes)
  if (asAvifFirst && pic.color.codec.startsWith('av01')) {
    try {
      const bmp = await createImageBitmap(new Blob([asAvif(bytes) as BlobPart], { type: 'image/avif' }))
      try {
        if (bmp.width * bmp.height > 100 * 1000 * 1000) throw new Error('bad size')
        const r = toCanvas(bmp, bmp.width, bmp.height, size)
        return { canvas: r.canvas, width: bmp.width, height: bmp.height }
      }
      finally {
        bmp.close()
      }
    }
    catch { /* WebCodecs で読む */ }
  }
  const hevc = pic.color.codec.startsWith('hvc1')
  let canvas: HTMLCanvasElement
  try {
    canvas = await decodeHeifImage(pic.color)
  }
  catch (e) {
    // このブラウザーの WebCodecs が HEVC を展開できない (Firefox、GPU が対応していない Chrome、Linux など) ときは libheif (wasm) で読む
    if (!hevc) throw e
    return decodeHeifLibheif(bytes, size)
  }
  if (pic.alpha) {
    try {
      const a = await decodeHeifImage(pic.alpha)
      const g = canvas.getContext('2d')!
      const color = g.getImageData(0, 0, canvas.width, canvas.height)
      // 透明度の絵は灰色 (明るさが不透明度)。大きさが違えば合わせる
      const scaled = document.createElement('canvas')
      scaled.width = canvas.width
      scaled.height = canvas.height
      scaled.getContext('2d')!.drawImage(a, 0, 0, canvas.width, canvas.height)
      const alpha = scaled.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data
      for (let i = 3; i < color.data.length; i += 4) color.data[i] = alpha[i - 3]!
      g.putImageData(color, 0, 0)
    }
    catch (e) {
      // 透明度の絵は白黒の HEVC で、GPU の展開が対応していないことが多い。そのときは全体を libheif (wasm) で読み直す
      if (pic.alpha.codec.startsWith('hvc1')) {
        try {
          return await decodeHeifLibheif(bytes, size)
        }
        catch (e2) {
          console.info('MarumaSign: heif alpha is not shown', String(e2))
        }
      }
      else {
        console.info('MarumaSign: heif alpha is not shown', String(e))
      }
    }
  }
  if (pic.crop) {
    const c = document.createElement('canvas')
    c.width = pic.crop.width
    c.height = pic.crop.height
    c.getContext('2d')!.drawImage(canvas, -pic.crop.x, -pic.crop.y)
    canvas = c
  }
  if (pic.rotation || pic.mirror !== null) {
    const swap = pic.rotation & 1
    const c = document.createElement('canvas')
    c.width = swap ? canvas.height : canvas.width
    c.height = swap ? canvas.width : canvas.height
    const g = c.getContext('2d')!
    g.translate(c.width / 2, c.height / 2)
    // 反転は回転のあと (HEIF の性質の順)
    if (pic.mirror === 0) g.scale(-1, 1)
    else if (pic.mirror === 1) g.scale(1, -1)
    // irot は反時計回り
    g.rotate(-pic.rotation * Math.PI / 2)
    g.drawImage(canvas, -canvas.width / 2, -canvas.height / 2)
    canvas = c
  }
  const r = toCanvas(canvas, canvas.width, canvas.height, size)
  return { canvas: r.canvas, width: canvas.width, height: canvas.height }
}

// ---------------------------------------------------------------- HEIC (libheif。LGPL-3.0)
// libheif-js (libheif と libde265 を Emscripten で wasm にしたもの) を、手を加えずにそのまま使う。
// WebCodecs で HEVC を展開できないときだけ、別のファイル (js と wasm) として読み込む。AV1 の展開は入っていない

interface LibheifImage {
  get_width(): number
  get_height(): number
  is_primary(): boolean
  display(target: { data: Uint8ClampedArray, width: number, height: number }, done: (result: unknown) => void): void
  free(): void
}

interface Libheif {
  HeifDecoder: new () => { decoder: number | null, decode(bytes: Uint8Array): LibheifImage[] }
  heif_context_free(context: number): void
}

let libheif: Promise<Libheif> | null = null

function loadLibheif(): Promise<Libheif> {
  if (!libheif) {
    libheif = (async () => {
      const [mod, wasm] = await Promise.all([
        import('libheif-js/libheif-wasm/libheif.js'),
        import('libheif-js/libheif-wasm/libheif.wasm?url'),
      ])
      const factory = ((mod as { default?: unknown }).default ?? mod) as (options: object) => Libheif
      let m: Libheif | null = null
      // libheif-js の js は wasm を同期で読み込む作り (factory が返るまでに wasm の関数がそろっている前提)。
      // ブラウザーでは同期で取りに行けないので、wasm を先に非同期で取ってきてコンパイルし、factory の中では同期で instance にする
      const res = await fetch(wasm.default, { credentials: 'same-origin' })
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const compiled = await WebAssembly.compile(await res.arrayBuffer())
      // 読み終えたら onRuntimeInitialized が呼ばれる (factory が返る前に呼ばれるので、1 つ待ってから使う)
      await withTimeout(new Promise<void>((resolve, reject) => {
        m = factory({
          instantiateWasm: (imports: WebAssembly.Imports, done: (instance: WebAssembly.Instance) => void) => {
            const instance = new WebAssembly.Instance(compiled, imports)
            done(instance)
            return instance.exports
          },
          onRuntimeInitialized: () => queueMicrotask(resolve),
          onAbort: (what: unknown) => reject(new Error('libheif aborted: ' + String(what))),
          print: () => {},
          printErr: () => {},
        })
      }), 30000, 'libheif')
      return m!
    })()
    libheif.catch(() => {
      libheif = null
    })
  }
  return libheif
}

/** HEIF を libheif で読む (格子・透明度・回転・反転・切り抜きも libheif が扱う) */
async function decodeHeifLibheif(bytes: Uint8Array, size: number): Promise<{ canvas: HTMLCanvasElement, width: number, height: number }> {
  const lib = await loadLibheif()
  const decoder = new lib.HeifDecoder()
  const images = decoder.decode(bytes)
  try {
    const image = images.find(i => i.is_primary()) ?? images[0]
    if (!image) throw new Error('libheif could not read the file')
    const width = image.get_width(), height = image.get_height()
    if (!(width > 0 && height > 0) || width * height > 100 * 1000 * 1000) throw new Error('bad size')
    const target = { data: new Uint8ClampedArray(width * height * 4), width, height }
    const result = await withTimeout(new Promise<unknown>(resolve => image.display(target, resolve)), 30000, 'libheif')
    if (!result) throw new Error('libheif could not decode the image')
    const full = document.createElement('canvas')
    full.width = width
    full.height = height
    full.getContext('2d')!.putImageData(new ImageData(target.data as Uint8ClampedArray<ArrayBuffer>, width, height), 0, 0)
    return { canvas: toCanvas(full, width, height, size).canvas, width, height }
  }
  finally {
    for (const i of images) i.free()
    if (decoder.decoder) lib.heif_context_free(decoder.decoder)
  }
}

// ---------------------------------------------------------------- JPEG XL (jxl-oxide)

let jxl: Promise<typeof import('jxl-oxide-wasm')> | null = null

function loadJxl(): Promise<typeof import('jxl-oxide-wasm')> {
  if (!jxl) {
    jxl = (async () => {
      const [mod, wasm] = await Promise.all([import('jxl-oxide-wasm'), import('jxl-oxide-wasm/module.wasm?url')])
      await mod.default({ module_or_path: wasm.default })
      return mod
    })()
    jxl.catch(() => {
      jxl = null
    })
  }
  return jxl
}

/** JPEG XL の最初のコマを読む (MarumaSign 本体も FFmpeg で最初のコマだけを読む) */
export async function decodeJxl(bytes: Uint8Array, size: number) {
  const mod = await loadJxl()
  const image = new mod.JxlImage()
  let png: Uint8Array
  try {
    image.forceSrgb = true
    image.feedBytes(bytes)
    if (!image.tryInit()) throw new Error('bad jpeg xl')
    const w = image.width ?? 0, h = image.height ?? 0
    if (!(w > 0 && h > 0) || w * h > 100 * 1000 * 1000) throw new Error('bad size')
    // encodeToPng は描いた結果を使い切る (あとで free しない)
    png = image.render(0).encodeToPng()
  }
  finally {
    image.free()
  }
  return decodeBrowserStill(new Blob([png as BlobPart], { type: 'image/png' }), size)
}
