// 構造物 (建築のファイル) の看板。.schem .litematic .nbt .mcstructure .schematic
// 読み込みと四角形にする処理は Worker (structure/worker.ts) で 1 つずつ行う (MarumaSign 本体と同じく、1 つずつ読む)。
// サーバーに Minecraft のリソースのまとめ (/mcassets/、server/utils/mcassets.ts) があれば、本体と同じく jar のブロックのモデルとテクスチャで、
// ブロックエンティティ・エンティティ・看板の文字・なめらかな明るさ・バイオームの色・動くテクスチャまで描く (structure/vanilla.ts)。
// なければ、前と同じく簡単にした形を BlueMap の地図のテクスチャで描く (structure/mesher.ts)。
// 構造物の中の MarumaSign の看板は、ほかの看板と同じ描き方 (renderers/) で、構造物の中に置く (本体の NestedSigns と同じ上限)。
// 置き方は 3D モデルと同じ (最も長い辺が画像の長い辺と同じ大きさ、正面 +Z が看板の正面)
import {
  BufferAttribute, BufferGeometry, DataTexture, FrontSide, Group, Mesh, MeshBasicMaterial, NearestFilter, NearestMipmapLinearFilter, NoColorSpace,
  type Material, type Object3D, RGBAFormat, ShaderMaterial, type Sphere, type Texture, UnsignedByteType,
} from 'three'
import { Board, placeholder, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH } from '../board'
import { clamp, extensionOf, mediaKindOf, planRoute, safeUrl, type Route, type RouteType } from '../core'
import { open, readHead, readRest, sniffAsync, WrongKindError } from '../fetch'
import { withTimeout } from '../ktx2'
import { factoryNow, loadFactory } from './index'
import { InstanceLimiter, placedSphere, placementMatrix, SharedLoader, type SharedEntry } from '../shared'
import type { RenderContext, RendererHooks, Sign, SignRenderer } from '../types'
import { animate, type AnimatedSprite } from '../structure/atlas'
import type { NestedPlacement } from '../structure/nested'
import type { StructureJob, StructureReply, VanillaReply } from '../structure/worker'
import legacyTable from '../structure/tables/legacy.txt.gz?url&no-inline'
import bedrockTable from '../structure/tables/bedrock.txt.gz?url&no-inline'
import blocksTable from '../structure/tables/blocks.txt.gz?url&no-inline'
import entityModelsTable from '../structure/tables/entity_models.txt.gz?url&no-inline'

/** ファイルの大きさの上限 (MarumaSign 本体と同じ。展開したあとは 96 MB まで) */
const MAX_STRUCTURE_BYTES = 64 * 1024 * 1024
// 読んでおく構造物の四角形の合計の上限、同時に置く数
const QUAD_BUDGET = 1_000_000
const MAX_PLACED = 16
// 構造物の中の MarumaSign の看板 (本体の NestedSigns と同じ上限)
/** 入れ子にする深さの上限 (看板の構造物の中の看板の構造物、まで) */
const MAX_NESTED_DEPTH = 2
/** 1 つの構造物 (中の構造物も含めて) で読み込む URL の数 */
const MAX_NESTED_URLS = 16
/** 中身を読み込むのに使う時間 (これを過ぎて描けていないものはやめる) */
const NESTED_MILLIS = 20000
/** 中の 3D モデルと構造物の面の数の上限 */
const MAX_NESTED_QUADS = 30000
/** 構造物の中で描く種類 (動画・音声・ガウシアンスプラッティングは、本体と同じく描かない) */
const NESTED_TYPES = new Set<RouteType>(['image', 'probe', 'pdf', 'model', 'structure'])

interface Animation {
  texture: DataTexture
  page: { width: number, height: number, pixels: Uint8Array, mips: Uint8Array[] }
  sprites: AnimatedSprite[]
  shown: Int32Array
}

interface LoadedStructure {
  geometry: BufferGeometry
  /** 絵ごとの材質 (geometry の groups と同じ並び) */
  materials: Material[]
  textures: Texture[]
  box: number[]
  quads: number
  /** 構造物の中の MarumaSign の看板 */
  nested: NestedPlacement[]
  animations: Animation[]
  lastTick: number
  mode: 'vanilla' | 'simple'
  counts: VanillaReply['counts'] | null
}

// ---- Worker (1 つを使い回し、1 つずつ頼む)

let worker: Worker | null = null
let queue: Promise<unknown> = Promise.resolve()

function runJob(job: StructureJob): Promise<StructureReply> {
  const p = queue.then(() => new Promise<StructureReply>((resolve) => {
    if (!worker) worker = new Worker(new URL('../structure/worker.ts', import.meta.url), { type: 'module', name: 'marumasign-structure' })
    const w = worker
    const done = (reply: StructureReply): void => {
      w.removeEventListener('message', onMessage)
      w.removeEventListener('error', onError)
      resolve(reply)
    }
    const onMessage = (e: MessageEvent<StructureReply>): void => done(e.data)
    const onError = (e: ErrorEvent): void => {
      // Worker が壊れたら作り直す
      worker?.terminate()
      worker = null
      done({ ok: false, error: e.message || 'worker error' })
    }
    w.addEventListener('message', onMessage)
    w.addEventListener('error', onError)
    w.postMessage(job, [job.bytes])
  }))
  queue = p.catch(() => {})
  return p
}

// ---- Minecraft のリソースのまとめ (/mcassets/index.json が、いまの版の場所を返す)

let mcassets: Promise<string | null> | null = null
let mcassetsAt = 0

function mcassetsBase(): Promise<string | null> {
  // 使えないときは 5 分ごとに確かめ直す (サーバーが作り終えるのを待つ)
  if (mcassets && Date.now() - mcassetsAt < 5 * 60_000) return mcassets
  mcassetsAt = Date.now()
  mcassets = fetch('/mcassets/index.json', { credentials: 'same-origin' })
    .then((res): Promise<{ hash?: unknown }> | null => res.ok ? res.json() as Promise<{ hash?: unknown }> : null)
    .then((j): string | null => j && typeof j.hash === 'string' && /^[0-9a-f]{20}$/.test(j.hash) ? '/mcassets/' + j.hash + '/' : null)
    .catch((): null => null)
  return mcassets
}

// ---- 地図の絵 (簡単にした形のとき)

/** いまの地図のテクスチャ (名前 → テクスチャ) */
function mapTextures(ctx: RenderContext): Map<string, Texture> {
  const m = new Map<string, Texture>()
  for (const t of ctx.viewer.map?.loadedTextures ?? []) if (t.name) m.set(t.name, t)
  return m
}

function simpleMaterial(key: string, render: string, textures: Map<string, Texture>): Material {
  const params = {
    vertexColors: true,
    transparent: render === 'translucent',
    depthWrite: render !== 'translucent',
    alphaTest: render === 'cutout' ? 0.5 : render === 'translucent' ? 0.02 : 0,
  }
  const base = key.startsWith('#') ? undefined : textures.get(key)
  if (!base) return new MeshBasicMaterial({ ...params, color: key.startsWith('#') ? key : '#808080' })
  // 動く絵 (水など) は縦にコマが並んでいるので、最初のコマだけを使う。地図の材質に影響しないように写しを使う (画像は分け合う)
  const tex = base.clone()
  const img = base.image as { naturalWidth?: number, naturalHeight?: number, width?: number, height?: number } | undefined
  const w = img?.naturalWidth || img?.width || 0, h = img?.naturalHeight || img?.height || 0
  if (w > 0 && h > w) tex.repeat.set(1, w / h)
  tex.needsUpdate = true
  return new MeshBasicMaterial({ ...params, map: tex })
}

// ---- Minecraft と同じ描き方の材質
// 色はゲームと同じく、テクスチャの色に頂点の色 (面の明るさ・環境光の遮蔽・草の色) をそのまま掛ける (色空間の変換をしない)

const VERTEX = `
#include <common>
#include <logdepthbuf_pars_vertex>
attribute vec3 mcColor;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  vUv = uv;
  vColor = mcColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  #include <logdepthbuf_vertex>
}`

const FRAGMENT = `
#include <logdepthbuf_pars_fragment>
uniform sampler2D map;
uniform float alphaCutoff;
uniform float translucent;
varying vec2 vUv;
varying vec3 vColor;
void main() {
  #include <logdepthbuf_fragment>
  vec4 t = texture2D(map, vUv);
  if (t.a < alphaCutoff) discard;
  gl_FragColor = vec4(t.rgb * vColor, translucent > 0.5 ? t.a : 1.0);
}`

/** 層 (0 不透明、1 切り抜き、2 半透明) の材質 */
function vanillaMaterial(texture: Texture, layer: number): Material {
  return new ShaderMaterial({
    uniforms: {
      map: { value: texture },
      // 切り抜きはゲームと同じく 0.1 より薄いところを捨てる
      alphaCutoff: { value: layer === 0 ? -1 : layer === 1 ? 0.1 : 0.004 },
      translucent: { value: layer === 2 ? 1 : 0 },
    },
    vertexShader: VERTEX,
    fragmentShader: FRAGMENT,
    transparent: layer === 2,
    depthWrite: layer !== 2,
    side: FrontSide,
  })
}

/**
 * まとめた画像のテクスチャ。縮小した絵 (atlas.ts がテクスチャごとに作ったもの) を使い、近くはピクセルのまま、
 * 遠くは段の間を混ぜる (ゲームと同じ NEAREST_MIPMAP_LINEAR。遠くでちらつかない)
 */
function pageTexture(width: number, height: number, pixels: Uint8Array, mips: Uint8Array[]): DataTexture {
  const t = new DataTexture(pixels, width, height, RGBAFormat, UnsignedByteType)
  t.magFilter = NearestFilter
  t.minFilter = mips.length ? NearestMipmapLinearFilter : NearestFilter
  t.mipmaps = mips.length ? [{ data: pixels, width, height }, ...mips.map((data, i) => ({ data, width: Math.max(1, width >> (i + 1)), height: Math.max(1, height >> (i + 1)) }))] as unknown as DataTexture['mipmaps'] : []
  t.generateMipmaps = false
  t.flipY = false
  t.colorSpace = NoColorSpace
  t.needsUpdate = true
  return t
}

async function loadStructure(url: string, ctx: RenderContext): Promise<LoadedStructure> {
  const ext = new URL(url).pathname.split('.').pop()?.toLowerCase() ?? ''
  const o = await open(url, 'default')
  let data: Uint8Array
  try {
    const h = await readHead(o, 64)
    const s = await sniffAsync(h.head, o.type, ext)
    if (!s || s.route !== 'structure') {
      o.controller.abort()
      throw new WrongKindError(s ? s.route : 'image', s ? s.format : '')
    }
    data = await readRest(o, h, MAX_STRUCTURE_BYTES)
  }
  finally {
    o.done()
  }
  const base = await mcassetsBase()
  const textures = base ? new Map<string, Texture>() : mapTextures(ctx)
  const bytes = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  const reply = await withTimeout(runJob({
    bytes, textures: Array.from(textures.keys()), mcassets: base,
    tables: { legacy: legacyTable, bedrock: bedrockTable, blocks: blocksTable, entityModels: entityModelsTable },
  }), 90000)
  if (!reply.ok) throw new Error((reply as { error: string }).error)
  return reply.mode === 'vanilla' ? buildVanilla(reply) : buildSimple(reply, textures)
}

function buildVanilla(r: VanillaReply): LoadedStructure {
  const textures = r.pages.map(p => pageTexture(p.width, p.height, p.pixels, p.mips))
  const animations: Animation[] = []
  r.pages.forEach((p, i) => {
    if (p.animated && p.animated.length) {
      animations.push({ texture: textures[i]!, page: p, sprites: p.animated, shown: new Int32Array(p.animated.length).fill(-1) })
    }
  })
  // 不透明なもの、切り抜き、半透明の順に描く
  const parts = r.parts.slice().sort((a, b) => a.layer - b.layer)
  let vertices = 0
  for (const p of parts) vertices += p.quads * 4
  const pos = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2), col = new Uint8Array(vertices * 3)
  const idx = new Uint32Array(vertices / 4 * 6)
  const geometry = new BufferGeometry()
  const materials: Material[] = []
  const materialFor = new Map<string, number>()
  let v = 0, i = 0
  for (const p of parts) {
    pos.set(p.positions, v * 3)
    uv.set(p.uvs, v * 2)
    col.set(p.colors, v * 3)
    const start = i
    for (let q = 0; q < p.quads; q++) {
      const o = v + q * 4
      idx[i++] = o
      idx[i++] = o + 1
      idx[i++] = o + 2
      idx[i++] = o
      idx[i++] = o + 2
      idx[i++] = o + 3
    }
    const key = p.layer + ':' + p.page
    let m = materialFor.get(key)
    if (m === undefined) {
      m = materials.length
      materials.push(vanillaMaterial(textures[p.page]!, p.layer))
      materialFor.set(key, m)
    }
    geometry.addGroup(start, i - start, m)
    v += p.quads * 4
  }
  geometry.setAttribute('position', new BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  geometry.setAttribute('mcColor', new BufferAttribute(col, 3, true))
  geometry.setIndex(new BufferAttribute(idx, 1))
  geometry.computeBoundingSphere()
  return { geometry, materials, textures, box: r.box, quads: r.quads, nested: r.nested, animations, lastTick: -1, mode: 'vanilla', counts: r.counts }
}

function buildSimple(r: Extract<StructureReply, { ok: true, mode: 'simple' }>, textures: Map<string, Texture>): LoadedStructure {
  // 1 つの形に、絵ごとのまとまり (groups) を入れる。不透明なもの、切り抜き、半透明の順に描く
  const order = { opaque: 0, cutout: 1, translucent: 2 }
  const groups = r.groups.slice().sort((a, b) => order[a.render] - order[b.render])
  let vertices = 0, indices = 0
  for (const g of groups) {
    vertices += g.positions.length / 3
    indices += g.indices.length
  }
  const pos = new Float32Array(vertices * 3), uv = new Float32Array(vertices * 2), col = new Float32Array(vertices * 3)
  const idx = new Uint32Array(indices)
  const geometry = new BufferGeometry()
  const materials: Material[] = []
  let v = 0, i = 0
  for (const g of groups) {
    pos.set(g.positions, v * 3)
    uv.set(g.uvs, v * 2)
    col.set(g.colors, v * 3)
    for (let k = 0; k < g.indices.length; k++) idx[i + k] = g.indices[k]! + v
    geometry.addGroup(i, g.indices.length, materials.length)
    materials.push(simpleMaterial(g.key, g.render, textures))
    v += g.positions.length / 3
    i += g.indices.length
  }
  geometry.setAttribute('position', new BufferAttribute(pos, 3))
  geometry.setAttribute('uv', new BufferAttribute(uv, 2))
  geometry.setAttribute('color', new BufferAttribute(col, 3))
  geometry.setIndex(new BufferAttribute(idx, 1))
  geometry.computeBoundingSphere()
  return { geometry, materials, textures: [], box: r.box, quads: r.quads, nested: [], animations: [], lastTick: -1, mode: 'simple', counts: null }
}

function disposeStructure(s: LoadedStructure): void {
  s.geometry.dispose()
  for (const m of s.materials) {
    ;(m as MeshBasicMaterial).map?.dispose()
    m.dispose()
  }
  for (const t of s.textures) t.dispose()
}

let structures: SharedLoader<LoadedStructure> | null = null
function loader(): SharedLoader<LoadedStructure> {
  if (!structures) {
    structures = new SharedLoader<LoadedStructure>({
      concurrency: 1,
      budget: QUAD_BUDGET,
      keepMillis: 60000,
      load: (url, ctx) => loadStructure(url, ctx),
      cost: s => s.quads,
      dispose: disposeStructure,
    })
  }
  return structures
}

const limiter = new InstanceLimiter(MAX_PLACED)

// ---- 数え上げ (window.marumasign3d.stats() の structures)

const placedRenderers = new Set<StructureRenderer>()
let statsRegistered = false
let nestedActive = 0

function registerStats(ctx: RenderContext): void {
  if (statsRegistered) return
  statsRegistered = true
  ctx.addStats('structures', () => {
    let quads = 0, animated = 0, vanilla = 0, blockEntities = 0, entities = 0, texts = 0
    for (const r of placedRenderers) {
      const s = r.loaded
      if (!s) continue
      quads += s.quads
      animated += s.animations.length
      if (s.mode === 'vanilla') vanilla++
      blockEntities += s.counts?.blockEntities ?? 0
      entities += s.counts?.entities ?? 0
      texts += s.counts?.texts ?? 0
    }
    return { placed: placedRenderers.size, vanilla, quads, animatedPages: animated, blockEntities, entities, texts, nested: nestedActive }
  })
}

// ---- 構造物の中の看板

/** 1 つのいちばん外側の構造物で、中の看板に使える量 (中の構造物の中の看板も同じものから使う) */
interface NestedBudget {
  urls: number
}

interface NestedOptions {
  depth: number
  /** たどってきた URL (同じ URL はたどり直さない) */
  chain: string[]
  budget: NestedBudget | null
}

/**
 * 中の看板を入れる入れ物。3D モデルの描き方が、光 (ensureLights) をこの入れ物に足そうとしたときは、
 * いちばん外側の入れ物に足し直す (光が 2 つにならないように、同じ名前の古いものは外す)
 */
class NestedGroup extends Group {
  private readonly root: Group

  constructor(root: Group) {
    super()
    this.root = root
  }

  override add(...objects: Object3D[]): this {
    for (const o of objects) {
      if (o.name === 'marumasign3d-lights') {
        for (const c of this.root.children.slice()) if (c !== o && c.name === o.name) this.root.remove(c)
        this.root.add(o)
      }
      else super.add(o)
    }
    return this
  }
}

/** 中の看板の、読み込み中・読めないときの種類の絵 (本体は中の看板では何も描かないので、隠す) */
let placeholderTextures: Set<Texture> | null = null
function isPlaceholder(t: Texture | null | undefined): boolean {
  if (!t) return false
  if (!placeholderTextures) {
    placeholderTextures = new Set()
    for (const k of ['image', 'model', 'structure', 'pdf', 'splat', 'video', 'audio', 'other'] as const) {
      for (const s of ['loading', 'error', 'ok'] as const) placeholderTextures.add(placeholder(k, s))
    }
  }
  return placeholderTextures.has(t)
}

interface NestedEntry {
  group: NestedGroup
  renderer: SignRenderer | null
  url: string
  type: RouteType
  created: number
  /** 描けたもの (種類の絵ではないもの) が出たか */
  shown: boolean
  disposed: boolean
}

export class StructureRenderer implements SignRenderer {
  readonly sign: Sign
  private readonly ctx: RenderContext
  private readonly route: Route
  private readonly hooks: RendererHooks
  private readonly board: Board
  private readonly nestedOptions: NestedOptions
  private entry: SharedEntry<LoadedStructure> | null = null
  private object: Group | null = null
  private sphere: Sphere | null = null
  private disposed = false
  private allowed = false
  private nested: NestedEntry[] = []
  loaded: LoadedStructure | null = null
  distance = Infinity

  constructor(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks, nested?: NestedOptions) {
    this.ctx = ctx
    this.sign = sign
    this.route = route
    this.hooks = hooks
    this.board = new Board(ctx, sign)
    this.nestedOptions = nested ?? { depth: 0, chain: [route.url], budget: null }
    registerStats(ctx)
  }

  start(): void {
    this.board.show(placeholder('structure', 'loading'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    this.hooks.shown()
    limiter.add(this)
  }

  setAllowed(value: boolean): void {
    this.allowed = value
    if (value) this.load()
    else if (this.object) this.unplace()
    // 近くのものから数えて上限を超えたものは、種類の絵の板 (読み込み中の印なし)
    else if (!this.disposed) this.board.show(placeholder('structure', 'ok'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
  }

  private load(): void {
    if (this.entry) {
      if (this.entry.value) this.place(this.entry.value)
      return
    }
    const entry = loader().acquire(this.route.url, this.ctx)
    this.entry = entry
    entry.promise.then((s) => {
      if (this.disposed || this.entry !== entry || !this.allowed) return
      this.place(s)
    }, (e: unknown) => {
      if (this.disposed || this.entry !== entry) return
      if (e instanceof WrongKindError) {
        this.hooks.reroute({ type: e.route as Route['type'], url: this.route.url, ext: this.route.ext })
        return
      }
      console.info('MarumaSign: cannot load structure', this.route.url, String(e))
      this.board.show(placeholder('structure', 'error'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    })
  }

  private place(s: LoadedStructure): void {
    if (this.object) return
    // 中の構造物は、本体と同じく面が多すぎるものは描かない
    if (this.nestedOptions.depth > 0 && s.quads > MAX_NESTED_QUADS) {
      this.board.remove()
      return
    }
    const matrix = placementMatrix(this.sign, s.box)
    const wrapper = new Group()
    wrapper.matrixAutoUpdate = false
    wrapper.matrix.copy(matrix)
    const mesh = new Mesh(s.geometry, s.materials)
    mesh.onClick = () => {
      this.ctx.showInfo(this.sign)
      return true
    }
    wrapper.add(mesh)
    wrapper.updateMatrixWorld(true)
    this.ctx.group.add(wrapper)
    this.object = wrapper
    this.loaded = s
    this.sphere = placedSphere(matrix, s.box)
    placedRenderers.add(this)
    this.board.remove()
    this.hooks.shown()
    this.startNested(s.nested, wrapper)
    this.ctx.redraw()
  }

  private unplace(): void {
    this.stopNested()
    if (!this.object) return
    this.ctx.group.remove(this.object)
    this.object = null
    this.loaded = null
    placedRenderers.delete(this)
    if (!this.disposed) this.board.show(placeholder('structure', 'ok'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    this.ctx.redraw()
  }

  // ---- 中の看板

  private startNested(placements: NestedPlacement[], wrapper: Group): void {
    const opts = this.nestedOptions
    const depth = opts.depth + 1
    if (depth > MAX_NESTED_DEPTH || !placements.length) return
    // いちばん外側の構造物を置いたときから数える
    const budget = opts.budget ?? { urls: MAX_NESTED_URLS }
    const limits = this.ctx.settings?.limits ?? { maxSize: 64, maxOffset: 64 }
    for (const p of placements) {
      if (budget.urls <= 0) break
      const url = safeUrl(p.spec.url, true)
      if (!url || opts.chain.includes(url)) continue
      const sp = p.spec
      const item = p.kind === 'item'
      const orient = item ? 0 : p.orient
      const route = planRoute({ image: null, link: url, orient }, mediaKindOf(extensionOf(url)))
      if (!route || !NESTED_TYPES.has(route.type)) continue
      budget.urls--
      const group = new NestedGroup(this.ctx.group)
      if (p.kind === 'block') {
        group.position.set(p.origin[0], p.origin[1], p.origin[2])
        group.scale.setScalar(p.scale)
      }
      else {
        // アイテムの位置 (一辺 1 の立方体) から構造物の座標へ (行の順)
        group.matrixAutoUpdate = false
        group.matrix.set(...(p.matrix as [number, number, number, number, number, number, number, number, number, number, number, number, number, number, number, number]))
      }
      wrapper.add(group)
      group.updateMatrixWorld(true)
      const sign: Sign = {
        x: 0, y: 0, z: 0, orient, kind: this.sign.kind, image: null, link: url,
        // アイテムとして描くときは、看板に書かれた位置・大きさ・回転は使わない (本体と同じ)
        ox: item ? 0 : clamp(sp.x, -limits.maxOffset, limits.maxOffset),
        oy: item ? 0 : clamp(sp.y, -limits.maxOffset, limits.maxOffset),
        oz: item ? 0 : clamp(sp.z, -limits.maxOffset, limits.maxOffset),
        sx: item ? 1 : clamp(sp.scaleX, -limits.maxSize, limits.maxSize),
        sy: item ? 1 : clamp(sp.scaleY, -limits.maxSize, limits.maxSize),
        roll: item ? 0 : sp.roll, yaw: item ? 0 : sp.yaw, pitch: item ? 0 : sp.pitch,
        kindId: mediaKindOf(extensionOf(url)), route, cap: this.sign.cap,
      }
      const entry: NestedEntry = { group, renderer: null, url, type: route.type, created: performance.now(), shown: false, disposed: false }
      this.nested.push(entry)
      nestedActive++
      this.createNested(entry, sign, route, { depth, chain: [...opts.chain, url], budget }, budget)
    }
  }

  private subContext(group: Group): RenderContext {
    const ctx = this.ctx
    const parent = this.sign
    return {
      viewer: ctx.viewer,
      renderer: ctx.renderer,
      group,
      get settings() {
        return ctx.settings
      },
      redraw: () => ctx.redraw(),
      // 押したときは、外側の看板の位置と、中の看板の URL を出す
      showInfo: (s: Sign) => ctx.showInfo({ ...parent, link: s.link }),
      loads: ctx.loads,
      kindLabel: (s: Sign) => ctx.kindLabel(s),
      inView: (o: Object3D | null) => ctx.inView(o),
      // 中の看板の球は入れ物の座標なので、ワールドの座標にしてから確かめる
      sphereInView: (sphere: Sphere) => ctx.sphereInView(sphere.clone().applyMatrix4(group.matrixWorld)),
      camera: ctx.camera,
      addStats: () => {},
    }
  }

  private createNested(entry: NestedEntry, sign: Sign, route: Route, opts: NestedOptions, budget: NestedBudget): void {
    if (entry.disposed || this.disposed) return
    const sub = this.subContext(entry.group)
    const hooks: RendererHooks = {
      shown: () => {},
      failed: () => {},
      reroute: (next: Route) => {
        if (entry.disposed) return
        entry.renderer?.dispose()
        entry.renderer = null
        // 中身を読んだら描かない種類だったとき (動画など) は、何も描かない
        if (!NESTED_TYPES.has(next.type)) return
        this.createNested(entry, { ...sign, route: next }, next, opts, budget)
      },
    }
    const make = (factory: NonNullable<ReturnType<typeof factoryNow>>): void => {
      if (entry.disposed || this.disposed) return
      const r = route.type === 'structure'
        ? new StructureRenderer(sub, sign, route, hooks, opts)
        : factory(sub, sign, route, hooks)
      entry.renderer = r
      try {
        r.start()
        r.update(this.distance)
      }
      catch (e) {
        console.warn('MarumaSign:', e)
      }
      // 読み込み中の種類の絵は、すぐに隠す
      this.checkNested()
    }
    if (route.type === 'structure') {
      make(createStructureRenderer)
      return
    }
    const now = factoryNow(route.type)
    if (now) make(now)
    else loadFactory(route.type).then(make, () => {})
  }

  /** 中の看板の見た目を確かめる (種類の絵は隠す、時間切れと面の数の上限) */
  private checkNested(): boolean {
    let changed = false
    const now = performance.now()
    for (const e of this.nested) {
      if (e.disposed) continue
      let content = false
      let triangles = 0
      e.group.traverse((o) => {
        const m = o as Mesh
        if (!m.isMesh) return
        const map = (m.material as MeshBasicMaterial | undefined)?.map
        const hide = isPlaceholder(map)
        if (m.visible === hide) {
          m.visible = !hide
          changed = true
        }
        if (!hide) {
          content = true
          const g = m.geometry
          if (g) triangles += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3
        }
      })
      if (content && !e.shown) {
        e.shown = true
        // 中の 3D モデルは、本体と同じく面が多すぎるものは描かない
        if (e.type === 'model' && triangles > MAX_NESTED_QUADS) this.disposeNested(e)
      }
      else if (!e.shown && now - e.created > NESTED_MILLIS) this.disposeNested(e)
    }
    return changed
  }

  private disposeNested(e: NestedEntry): void {
    if (e.disposed) return
    e.disposed = true
    nestedActive--
    try {
      e.renderer?.dispose()
    }
    catch (err) {
      console.warn('MarumaSign:', err)
    }
    e.renderer = null
    e.group.parent?.remove(e.group)
    this.ctx.redraw()
  }

  private stopNested(): void {
    for (const e of this.nested) this.disposeNested(e)
    this.nested = []
  }

  update(distance: number): void {
    this.distance = distance
    for (const e of this.nested) {
      if (e.disposed || !e.renderer) continue
      try {
        e.renderer.update(distance)
      }
      catch { /* 1 件の失敗で他を止めない */ }
    }
    if (this.nested.length && this.checkNested()) this.ctx.redraw()
  }

  /** 動くテクスチャ (ゲームと同じく 1 秒に 20 回進める) と、中の看板のアニメーション */
  frame(now: number): boolean {
    let changed = false
    const s = this.loaded
    if (s && s.animations.length && this.visible) {
      const tick = Math.floor(now / 50)
      if (tick !== s.lastTick) {
        s.lastTick = tick
        for (const a of s.animations) {
          if (animate(a.page, a.sprites, a.shown, tick)) {
            a.texture.needsUpdate = true
            changed = true
          }
        }
      }
    }
    for (const e of this.nested) {
      if (e.disposed || !e.renderer?.frame) continue
      try {
        if (e.renderer.frame(now)) changed = true
      }
      catch { /* 1 件の失敗で他を止めない */ }
    }
    return changed
  }

  /** 画面に入っているか */
  get visible(): boolean {
    return !!this.sphere && this.ctx.sphereInView(this.sphere)
  }

  dispose(): void {
    this.disposed = true
    limiter.remove(this)
    this.unplace()
    if (this.entry) {
      loader().release(this.route.url)
      this.entry = null
    }
    this.board.remove()
  }
}

export function createStructureRenderer(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks): SignRenderer {
  return new StructureRenderer(ctx, sign, route, hooks)
}
