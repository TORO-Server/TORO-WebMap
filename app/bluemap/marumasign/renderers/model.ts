// 3D モデルの看板 (glTF 2.0)。置き方・大きさ・回転は MarumaSign 本体と同じ (core.ts の modelPlacement)
// 最初のアニメーション (中身のあるもの) を繰り返し再生する (MarumaSign 本体と同じ)。同じ URL の看板は、読んだモデルを分け合う。
// 陰影は MarumaSign 本体と同じ式で、モデルの材質の中で計算する (model-shading.ts。three.js の光源は使わない)
import { AnimationMixer, Group, type Matrix4, type Sphere } from 'three'
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js'
import { Board, placeholder, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH } from '../board'
import type { Route } from '../core'
import { WrongKindError } from '../fetch'
import { disposeModel, loadModel, type LoadedModel } from '../model-load'
import { bindInstance, type InstanceBinding } from '../model-shading'
import { InstanceLimiter, placedSphere, placementMatrix, SharedLoader, type SharedEntry } from '../shared'
import type { RenderContext, RendererHooks, Sign, SignRenderer } from '../types'

// 読んでおくモデルの三角形の合計の上限、同時に読む数、同時に置く数
const TRIANGLE_BUDGET = 1_500_000
const MAX_PLACED = 24

const models = new SharedLoader<LoadedModel>({
  concurrency: 2,
  budget: TRIANGLE_BUDGET,
  keepMillis: 60000,
  load: url => loadModel(url, extOf(url)),
  cost: m => m.triangles,
  dispose: disposeModel,
})

function extOf(url: string): string {
  const path = new URL(url).pathname
  const dot = path.lastIndexOf('.')
  return dot > path.lastIndexOf('/') ? path.substring(dot + 1).toLowerCase() : ''
}

const limiter = new InstanceLimiter(MAX_PLACED)

/** 置いているモデル (window.marumasign3d.stats() の models) */
const placed = new Set<ModelRenderer>()
let statsAdded = false
function addStats(ctx: RenderContext): void {
  if (statsAdded) return
  statsAdded = true
  ctx.addStats('models', () => {
    let lights = 0, animated = 0, cpuTextures = 0
    for (const r of placed) {
      lights += r.lights
      if (r.animated) animated++
      cpuTextures += r.cpuTextures
    }
    return { placed: placed.size, animated, lights, cpuTextures }
  })
}

export class ModelRenderer implements SignRenderer {
  readonly sign: Sign
  private readonly ctx: RenderContext
  private readonly route: Route
  private readonly hooks: RendererHooks
  private readonly board: Board
  private entry: SharedEntry<LoadedModel> | null = null
  private object: Group | null = null
  private mixer: AnimationMixer | null = null
  private binding: InstanceBinding | null = null
  private sphere: Sphere | null = null
  private last = 0
  private disposed = false
  private allowed = false
  private model: LoadedModel | null = null
  distance = Infinity

  /** 計算している光源の数・アニメーションしているか・CPU で展開したテクスチャの数 (stats) */
  get lights(): number {
    return this.binding?.lights ?? 0
  }

  get animated(): boolean {
    return !!this.mixer
  }

  get cpuTextures(): number {
    return this.model?.cpuTextures ?? 0
  }

  constructor(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks) {
    this.ctx = ctx
    this.sign = sign
    this.route = route
    this.hooks = hooks
    this.board = new Board(ctx, sign)
  }

  start(): void {
    this.board.show(placeholder('model', 'loading'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    this.hooks.shown()
    addStats(this.ctx)
    limiter.add(this)
  }

  /** 近いものから MAX_PLACED 個だけ置く (InstanceLimiter が決める) */
  setAllowed(value: boolean): void {
    this.allowed = value
    if (value) this.load()
    else if (this.object) this.unplace(true)
    // 近くのものから数えて上限を超えたものは、種類の絵の板 (読み込み中の印なし)
    else if (!this.disposed) this.board.show(placeholder('model', 'ok'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
  }

  private load(): void {
    if (this.entry || this.disposed) {
      if (this.entry?.value) this.place(this.entry.value)
      return
    }
    const entry = models.acquire(this.route.url, this.ctx)
    this.entry = entry
    entry.promise.then((m) => {
      if (this.disposed || this.entry !== entry || !this.allowed) return
      this.place(m)
    }, (e: unknown) => {
      if (this.disposed || this.entry !== entry) return
      if (e instanceof WrongKindError) {
        this.hooks.reroute({ type: e.route as Route['type'], url: this.route.url, ext: this.route.ext })
        return
      }
      console.info('MarumaSign: cannot load model', this.route.url, String(e))
      this.board.show(placeholder('model', 'error'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    })
  }

  private place(m: LoadedModel): void {
    if (this.object) return
    const matrix: Matrix4 = placementMatrix(this.sign, m.box)
    const wrapper = new Group()
    wrapper.matrixAutoUpdate = false
    wrapper.matrix.copy(matrix)
    const instance = cloneSkinned(m.scene)
    // 押したら、画像の看板と同じくリンクの案内を出す
    instance.traverse(o => (o.onClick = () => {
      this.ctx.showInfo(this.sign)
      return true
    }))
    wrapper.add(instance)
    // 材質を看板ごとに写し、陰影と KHR_animation_pointer の書き換え先を用意する (ミキサーを作る前に)
    this.binding = bindInstance(instance, m.extras, matrix)
    wrapper.updateMatrixWorld(true)
    this.ctx.group.add(wrapper)
    this.object = wrapper
    this.sphere = placedSphere(matrix, m.box)
    // MarumaSign 本体と同じく、動かせるチャンネルのある最初のアニメーションだけ
    const clip = m.clips.find(c => c.tracks.length > 0)
    if (clip) {
      this.mixer = new AnimationMixer(instance)
      this.mixer.clipAction(clip).play()
      this.mixer.update(0)
      this.last = performance.now()
    }
    this.model = m
    placed.add(this)
    this.board.remove()
    this.hooks.shown()
    this.ctx.redraw()
  }

  /** 置いたモデルを外す (keepEntry なら、また近くなったときのために読んだものは持っておく) */
  private unplace(keepEntry: boolean): void {
    if (this.object) {
      this.ctx.group.remove(this.object)
      this.object = null
      this.mixer?.stopAllAction()
      this.mixer = null
      this.binding?.dispose()
      this.binding = null
      this.model = null
      placed.delete(this)
      if (!this.disposed) this.board.show(placeholder('model', 'ok'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
      this.ctx.redraw()
    }
    if (!keepEntry && this.entry) {
      models.release(this.route.url)
      this.entry = null
    }
  }

  update(distance: number): void {
    this.distance = distance
  }

  frame(now: number): boolean {
    if (!this.mixer || !this.sphere || !this.ctx.sphereInView(this.sphere)) {
      this.last = now
      return false
    }
    this.mixer.update(Math.min(0.1, (now - this.last) / 1000))
    this.last = now
    return true
  }

  dispose(): void {
    this.disposed = true
    limiter.remove(this)
    this.unplace(false)
    this.board.remove()
  }
}

export function createModelRenderer(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks): SignRenderer {
  return new ModelRenderer(ctx, sign, route, hooks)
}
