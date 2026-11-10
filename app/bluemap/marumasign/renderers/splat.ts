// ガウシアンスプラッティングの看板 (.ply .spz .sog .splat .ksplat、zip にしていない .sog の meta.json)。描くのは Spark (@sparkjsdev/spark)
// Spark は three.js の Object3D として描き、BlueMap の地形と同じ深度 (対数の深度バッファ) で前後が決まる。
// MarumaSign 本体と同じ決まり:
//  - ファイルは 200 MB まで。分布が 15 万個より多ければ、目立つものから 15 万個を選ぶ。中心から遠い背景の分布は省く (core.ts の selectSplats)
//  - 置き方は 3D モデルと同じ (外れ値を除いた範囲の最も長い辺が画像の長い辺と同じ大きさ、正面 +Z が看板の正面)。
//    看板の横と縦の大きさが違えばモデルも伸ばす (本体と同じく、共分散ごと変換する。Spark の共分散の描き方 covSplats を使う)
//  - 球面調和関数は 3 次まで描く (.spz の 4 次は捨てる)
// 座標の向きは splat-file.ts の先頭を参照 (.spz は宣言・推定・仕様の順。ほかは半回転)。
// 本体と違うところ (本体が読まない・向きを誤るもの): .spz のバージョン 1、.spz の座標の拡張と向きの推定、zip にしていない .sog、URL の #coord=
import { Matrix4, type Sphere } from 'three'
import { ExtSplats, SparkRenderer, SplatMesh } from '@sparkjsdev/spark'
import { Board, placeholder, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH } from '../board'
import { MAX_SPLATS, modelViewDistance, safeUrl, selectSplats, splatImportance, withoutFragment, type Route } from '../core'
import { concat, open, readHead, readLimited, readRest, sniffAsync, WrongKindError } from '../fetch'
import { allowInlineWasmFetch, withTimeout } from '../ktx2'
import { InstanceLimiter, placedSphere, placementMatrix, SharedLoader, type SharedEntry } from '../shared'
import {
  apply3, coordinateFromUrl, coordinateMatrix, guessSpzUp, MAX_SOG_META_BYTES, parseSpzHeader, percentileBox, plyToLittleEndian, sogMetaFiles,
  storedZip,
} from '../splat-file'
import type { RenderContext, RendererHooks, Sign, SignRenderer } from '../types'

/** ファイルの大きさの上限 (MarumaSign 本体と同じ) */
const MAX_SPLAT_BYTES = 200 * 1024 * 1024
/** ばらばらの .sog の 1 つのファイルと合計の上限 (本体の .sog の zip の中身の上限と同じ) */
const MAX_SOG_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_SOG_TOTAL_BYTES = 128 * 1024 * 1024
// 読んでおく分布の合計の上限、同時に置く数
const SPLAT_BUDGET = 1_200_000
const MAX_PLACED = 6
/** 分布を切る広がり (標準偏差の何倍まで描くか)。本体の CUTOFF と同じ (Spark の既定は √8) */
const MAX_STD_DEV = 2.5
// Spark に渡す名前 (拡張子で形式を決めるため)
const FILE_NAMES: Record<string, string> = {
  'ply': 'sign.ply', 'spz': 'sign.spz', 'sog': 'sign.sog', 'sog-meta': 'sign.sog', 'splat': 'sign.splat', 'ksplat': 'sign.ksplat',
}

/** 座標の向きをどう決めたか (stats の splat.detail で見る) */
type CoordinateSource = 'format' | 'url' | 'declared' | 'guess' | 'spec'

interface LoadedSplats {
  splats: ExtSplats
  /** 置く座標 (RUB) での、外れ値を除いた範囲 */
  box: number[]
  /** ファイルの座標から置く座標 (RUB) への変換 */
  frame: Matrix4
  count: number
  total: number
  format: string
  coordinate: string
  source: CoordinateSource
  sh: number
}

function extOf(url: string): string {
  const path = new URL(url).pathname
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? path.substring(dot + 1).toLowerCase() : ''
}

/** 選んだ分布だけの ExtSplats (球面調和関数の係数も写す。Spark の extractSplats は係数を落とすため) */
function extract(source: ExtSplats, indices: Uint32Array): ExtSplats {
  const n = indices.length
  const capacity = Math.ceil(Math.max(1, n) / 2048) * 2048
  const copy = (src: Uint32Array): Uint32Array => {
    const out = new Uint32Array(capacity * 4)
    for (let i = 0; i < n; i++) out.set(src.subarray(indices[i]! * 4, indices[i]! * 4 + 4), i * 4)
    return out
  }
  const extra: ExtSplats['extra'] = {}
  for (const key of ['sh1', 'sh2', 'sh3a', 'sh3b'] as const) {
    const arr = source.extra[key]
    if (arr instanceof Uint32Array) extra[key] = copy(arr)
  }
  return new ExtSplats({ extArrays: [copy(source.extArrays[0]), copy(source.extArrays[1])], numSplats: n, extra })
}

/** ファイルの読み込み結果 */
interface FileBytes {
  data: Uint8Array
  format: string
}

/**
 * 看板の URL のファイルを読む。フォルダの URL (/ で終わる) はその中の meta.json (zip にしていない .sog)。
 * 拡張子のない URL が読めないか、ガウシアンスプラッティングでなければ、フォルダとみなして「URL/meta.json」も試す
 */
async function fetchSplatFile(url: string): Promise<FileBytes> {
  const path = new URL(url).pathname
  if (path.endsWith('/')) return fetchOne(new URL('meta.json', withoutFragment(url)).href, true)
  try {
    return await fetchOne(url, false)
  }
  catch (e) {
    if (extOf(url) !== '' || (e instanceof WrongKindError && e.route !== 'image' && e.route !== 'probe')) throw e
    const folder = withoutFragment(url) + '/meta.json'
    try {
      return await fetchOne(folder, true)
    }
    catch {
      throw e
    }
  }
}

async function fetchOne(url: string, metaOnly: boolean): Promise<FileBytes> {
  const o = await open(url, 'default')
  try {
    const h = await readHead(o, 4096)
    const s = await sniffAsync(h.head, o.type, extOf(url))
    if (!s || s.route !== 'splat' || (metaOnly && s.format !== 'sog-meta')) {
      o.controller.abort()
      throw new WrongKindError(s ? s.route : 'image', s ? s.format : '')
    }
    if (s.format === 'sog-meta') {
      const meta = await readRest(o, h, MAX_SOG_META_BYTES)
      return { data: await packLooseSog(url, meta), format: 'sog-meta' }
    }
    return { data: await readRest(o, h, MAX_SPLAT_BYTES), format: s.format }
  }
  finally {
    o.done()
  }
}

/**
 * zip にしていない .sog: meta.json が参照する WebP を、meta.json からの相対の位置で読み (どれも看板の URL と同じ決まりで確かめる)、
 * 圧縮しない zip にまとめる (Spark が .sog として読む)。名前は file0.webp のように付け直す
 */
async function packLooseSog(metaUrl: string, metaBytes: Uint8Array): Promise<Uint8Array> {
  const text = new TextDecoder().decode(metaBytes)
  const names = sogMetaFiles(text)
  if (!names) throw new Error('bad sog meta.json')
  const rename = new Map<string, string>()
  const entries: { name: string, data: Uint8Array }[] = []
  let total = metaBytes.length
  for (const [i, name] of names.entries()) {
    let fileUrl: string
    try {
      fileUrl = new URL(name, withoutFragment(metaUrl)).href
    }
    catch {
      throw new Error('bad sog file name')
    }
    if (!safeUrl(fileUrl, true)) throw new Error('blocked sog file url')
    const o = await open(fileUrl, 'default')
    let data: Uint8Array
    try {
      data = concat(await readLimited(o, Math.min(MAX_SOG_ENTRY_BYTES, MAX_SOG_TOTAL_BYTES - total)))
    }
    finally {
      o.done()
    }
    // 中身は WebP だけ (RIFF....WEBP)
    if (data.length < 12 || data[0] !== 0x52 || data[1] !== 0x49 || data[2] !== 0x46 || data[3] !== 0x46
      || data[8] !== 0x57 || data[9] !== 0x45 || data[10] !== 0x42 || data[11] !== 0x50) throw new Error('sog file is not webp')
    total += data.length
    const entry = `file${i}.webp`
    rename.set(name, entry)
    entries.push({ name: entry, data })
  }
  const meta = JSON.parse(text) as Record<string, { files?: string[] } | unknown>
  for (const key of ['means', 'scales', 'quats', 'sh0', 'shN']) {
    const part = meta[key] as { files?: string[] } | undefined
    if (part && Array.isArray(part.files)) part.files = part.files.map(f => rename.get(f) ?? f)
  }
  entries.unshift({ name: 'meta.json', data: new TextEncoder().encode(JSON.stringify(meta)) })
  return storedZip(entries)
}

/** 展開した .spz の大きさの上限 (MarumaSign 本体と同じ) */
const MAX_SPZ_UNCOMPRESSED = 512 * 1024 * 1024

/**
 * 球面調和関数が 4 次の .spz (バージョン 4) を、3 次までのバージョン 3 (gzip) に書き直す。Spark は 4 次を読まない。
 * MarumaSign 本体も 4 次の係数は捨てて 3 次までを使う。ZSTD の展開は three.js の zstddec (KTX2 と同じもの)
 */
async function dropSh4(data: Uint8Array): Promise<Uint8Array> {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  const n = dv.getUint32(8, true), frac = data[13]!, flags = data[14]!, streams = data[15]!, toc = dv.getUint32(16, true)
  const sizes = [9 * n, n, 3 * n, 3 * n, 4 * n, 72 * n]
  if (streams !== 6 || n <= 0 || n > 10_000_000 || toc < 32 || toc + streams * 16 > data.length) throw new Error('bad spz v4')
  if (sizes.reduce((a, b) => a + b, 0) > MAX_SPZ_UNCOMPRESSED) throw new Error('spz too large')
  allowInlineWasmFetch()
  const { ZSTDDecoder } = await import('three/examples/jsm/libs/zstddec.module.js')
  const zstd = new ZSTDDecoder()
  await zstd.init()
  const parts: Uint8Array[] = []
  let at = toc + streams * 16
  for (let s = 0; s < streams; s++) {
    const c = Number(dv.getBigUint64(toc + s * 16, true)), u = Number(dv.getBigUint64(toc + s * 16 + 8, true))
    if (u !== sizes[s] || c <= 0 || at + c > data.length) throw new Error('bad spz v4 stream')
    const out = zstd.decode(data.subarray(at, at + c), u)
    if (out.length !== u) throw new Error('bad spz v4 stream')
    at += c
    if (s < 5) {
      parts.push(out)
      continue
    }
    // 1 点あたり 24 係数 x 3 色のうち、先頭の 15 係数 (3 次まで)
    const sh = new Uint8Array(45 * n)
    for (let i = 0; i < n; i++) sh.set(out.subarray(i * 72, i * 72 + 45), i * 45)
    parts.push(sh)
  }
  const header = new Uint8Array(16)
  const hv = new DataView(header.buffer)
  hv.setUint32(0, 0x5053474E, true)
  hv.setUint32(4, 3, true)
  hv.setUint32(8, n, true)
  header[12] = 3
  header[13] = frac
  header[14] = flags & 1
  const gz = new Blob([header, ...parts] as BlobPart[]).stream().pipeThrough(new CompressionStream('gzip'))
  return new Uint8Array(await new Response(gz).arrayBuffer())
}

async function loadSplats(url: string): Promise<LoadedSplats> {
  const file = await fetchSplatFile(url)
  const { format } = file
  let data = file.data
  // 座標の拡張は書き直す前のファイルで読む
  const header = format === 'spz' ? parseSpzHeader(data) : null
  if (header && header.version === 4 && header.shDegree === 4) data = await dropSh4(data)
  // 文字とビッグエンディアンの .ply は、Spark が読むリトルエンディアンに書き直す
  if (format === 'ply') data = plyToLittleEndian(data) ?? data
  const splats = new ExtSplats({ fileBytes: data, fileName: FILE_NAMES[format] ?? 'sign.' + format })
  try {
    await withTimeout(splats.initialized, 60000)
  }
  catch (e) {
    splats.dispose()
    throw e
  }
  const total = splats.numSplats
  if (!(total > 0)) {
    splats.dispose()
    throw new Error('no splats')
  }
  // 目立つものを選ぶ (MarumaSign 本体と同じく、ファイルの座標で)
  const positions = new Float32Array(total * 3)
  const importance = new Float32Array(total)
  splats.forEachSplat((i, center, scales, _q, opacity) => {
    positions[i * 3] = center.x
    positions[i * 3 + 1] = center.y
    positions[i * 3 + 2] = center.z
    importance[i] = splatImportance(opacity, Math.abs(scales.x), Math.abs(scales.y), Math.abs(scales.z))
  })
  const indices = selectSplats(importance, positions, total, MAX_SPLATS)
  const count = indices.length

  // 座標の向き
  let coordinate = format === 'spz' ? 'RUB' : 'RDF'
  let source: CoordinateSource = format === 'spz' ? 'spec' : 'format'
  const fromUrl = coordinateFromUrl(url)
  if (fromUrl) {
    coordinate = fromUrl
    source = 'url'
  }
  else if (format === 'spz') {
    const declared = header?.coordinate
    if (declared) {
      coordinate = declared
      source = 'declared'
    }
    else {
      const guess = guessFromSplats(splats, indices, positions)
      if (guess) {
        coordinate = guess
        source = 'guess'
      }
    }
  }
  const m = coordinateMatrix(coordinate)!
  const frame = new Matrix4().set(m[0]!, m[3]!, m[6]!, 0, m[1]!, m[4]!, m[7]!, 0, m[2]!, m[5]!, m[8]!, 0, 0, 0, 0, 1)
  // 置く座標での範囲 (本体の SplatScene.restBounds と同じく、各軸の 1 - 99 パーセンタイル)
  const placed = new Float32Array(count * 3)
  for (let k = 0; k < count; k++) {
    const i = indices[k]!
    placed.set(apply3(m, positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!), k * 3)
  }
  const box = percentileBox(placed, count)
  const sh = splats.getNumSh()
  let result = splats
  if (count < total) {
    result = extract(splats, indices)
    splats.dispose()
  }
  return { splats: result, box, frame, count, total, format, coordinate, source, sh }
}

/** 選んだ分布の大きさ・回転・不透明度から、上の向きを推定する */
function guessFromSplats(splats: ExtSplats, indices: Uint32Array, positions: Float32Array): 'RUB' | 'RDF' | null {
  const n = indices.length
  const slot = new Int32Array(positions.length / 3).fill(-1)
  for (let k = 0; k < n; k++) slot[indices[k]!] = k
  const pos = new Float32Array(n * 3), scl = new Float32Array(n * 3), quat = new Float32Array(n * 4), op = new Float32Array(n)
  splats.forEachSplat((i, center, scales, q, opacity) => {
    const k = slot[i]!
    if (k < 0) return
    pos[k * 3] = center.x
    pos[k * 3 + 1] = center.y
    pos[k * 3 + 2] = center.z
    scl[k * 3] = scales.x
    scl[k * 3 + 1] = scales.y
    scl[k * 3 + 2] = scales.z
    quat[k * 4] = q.x
    quat[k * 4 + 1] = q.y
    quat[k * 4 + 2] = q.z
    quat[k * 4 + 3] = q.w
    op[k] = opacity
  })
  return guessSpzUp(pos, scl, quat, op)
}

const splats = new SharedLoader<LoadedSplats>({
  concurrency: 1,
  budget: SPLAT_BUDGET,
  keepMillis: 60000,
  load: url => loadSplats(url),
  cost: s => s.count,
  dispose: (s) => {
    s.splats.dispose()
    for (const [url, v] of loaded) if (v === s) loaded.delete(url)
  },
})

const limiter = new InstanceLimiter(MAX_PLACED)
/** 置いた看板と、読んでおいたもの (stats 用) */
const placedRenderers = new Set<SplatRenderer>()
const loaded = new Map<string, LoadedSplats>()

/** Spark の描画 (すべての看板で 1 つ。BlueMap のマーカーの入れ物に入れる) */
let spark: SparkRenderer | null = null
function ensureSpark(ctx: RenderContext): void {
  if (spark && spark.parent === ctx.group) return
  // 共分散で描く (看板の縦横の伸ばしと、座標の鏡像を、本体と同じく分布の形ごと変換する)。位置は 32 ビットの浮動小数点数で持つ
  spark = new SparkRenderer({ renderer: ctx.renderer, onDirty: () => ctx.redraw(), covSplats: true, accumExtSplats: true, maxStdDev: MAX_STD_DEV })
  spark.name = 'marumasign3d-spark'
  // 半透明のものの中で最後に描く。深度を書く看板の板やモデルの奥にある分布は隠れ、手前の分布は板の上に重なる
  // (Spark は 1 つの物として並べ替えられるので、分布ごとに本体のように並べることはできない。順番の違いが出にくい最後にする)
  spark.renderOrder = 10
  ctx.group.add(spark)
  ctx.addStats('splat', () => ({
    placed: placedRenderers.size,
    loaded: loaded.size,
    detail: Array.from(loaded.entries()).map(([url, s]) => ({
      url, format: s.format, total: s.total, count: s.count, sh: s.sh, coordinate: s.coordinate, source: s.source,
      box: s.box.map(v => Math.round(v * 1000) / 1000),
    })),
  }))
}

export class SplatRenderer implements SignRenderer {
  readonly sign: Sign
  private readonly ctx: RenderContext
  private readonly route: Route
  private readonly hooks: RendererHooks
  private readonly board: Board
  private entry: SharedEntry<LoadedSplats> | null = null
  private mesh: SplatMesh | null = null
  private sphere: Sphere | null = null
  private disposed = false
  private allowed = false
  distance = Infinity

  constructor(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks) {
    this.ctx = ctx
    this.sign = sign
    this.route = route
    this.hooks = hooks
    this.board = new Board(ctx, sign)
  }

  start(): void {
    this.board.show(placeholder('splat', 'loading'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    this.hooks.shown()
    limiter.add(this)
  }

  setAllowed(value: boolean): void {
    this.allowed = value
    if (value) this.load()
    else if (this.mesh) this.unplace()
    // 近くのものから数えて上限を超えたものは、種類の絵の板 (読み込み中の印なし)
    else if (!this.disposed) this.board.show(placeholder('splat', 'ok'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
  }

  private load(): void {
    if (this.entry) {
      if (this.entry.value) this.place(this.entry.value)
      return
    }
    const entry = splats.acquire(this.route.url, this.ctx)
    this.entry = entry
    entry.promise.then((s) => {
      loaded.set(this.route.url, s)
      if (this.disposed || this.entry !== entry) return
      // 見える距離は、本体と同じく置いたモデルの角の遠さから (看板の板の大きさからではなく)
      if (!this.ctx.settings.fullDrawDistance) this.sign.cap = modelViewDistance(this.sign, s.box, this.ctx.settings.drawDistance)
      if (!this.allowed) return
      this.place(s)
    }, (e: unknown) => {
      if (this.disposed || this.entry !== entry) return
      if (e instanceof WrongKindError) {
        this.hooks.reroute({ type: e.route as Route['type'], url: this.route.url, ext: this.route.ext })
        return
      }
      console.info('MarumaSign: cannot load splats', this.route.url, String(e))
      this.board.show(placeholder('splat', 'error'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    })
  }

  private place(s: LoadedSplats): void {
    if (this.mesh) return
    ensureSpark(this.ctx)
    // ファイルの座標 → 置く座標 (RUB) → 看板の置き方 (縦横の伸ばしや鏡像も含む一般の線形変換。共分散の描き方なのでそのまま使える)
    const matrix = placementMatrix(this.sign, s.box, s.frame)
    // 読んだ分布は看板どうしで分け合う (メッシュを片付けても消さない)
    const mesh = new SplatMesh({ extSplats: s.splats, covSplats: true })
    mesh.matrixAutoUpdate = false
    mesh.matrix.copy(matrix)
    mesh.updateMatrixWorld(true)
    this.ctx.group.add(mesh)
    this.mesh = mesh
    placedRenderers.add(this)
    this.sphere = placedSphere(placementMatrix(this.sign, s.box), s.box)
    this.board.remove()
    this.hooks.shown()
    this.ctx.redraw()
  }

  private unplace(): void {
    if (!this.mesh) return
    this.ctx.group.remove(this.mesh)
    placedRenderers.delete(this)
    // SplatMesh.dispose は分け合っている ExtSplats も消すので、持ち物を外してから消す
    const m = this.mesh as unknown as { extSplats?: unknown, splats?: unknown }
    m.extSplats = undefined
    m.splats = undefined
    this.mesh.dispose()
    this.mesh = null
    if (!this.disposed) this.board.show(placeholder('splat', 'ok'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    this.ctx.redraw()
  }

  update(distance: number): void {
    this.distance = distance
  }

  frame(): boolean {
    // Spark は並べ替えが終わると onDirty で描き直しを頼む。ここでは何もしない
    return false
  }

  /** 画面に入っているか (デバッグ用) */
  get visible(): boolean {
    return !!this.sphere && this.ctx.sphereInView(this.sphere)
  }

  dispose(): void {
    this.disposed = true
    limiter.remove(this)
    this.unplace()
    if (this.entry) {
      splats.release(this.route.url)
      this.entry = null
    }
    this.board.remove()
  }
}

export function createSplatRenderer(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks): SignRenderer {
  return new SplatRenderer(ctx, sign, route, hooks)
}
