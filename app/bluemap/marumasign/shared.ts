// 3D のもの (3D モデル・ガウシアンスプラッティング・構造物) の、URL ごとの読み込み結果の分け合いと、数の上限
import { Box3, Matrix4, Sphere, Vector3 } from 'three'
import { modelPlacement, nearest } from './core'
import type { RenderContext, Sign } from './types'

/** URL ごとの読み込み結果 */
export interface SharedEntry<T> {
  readonly url: string
  promise: Promise<T>
  value: T | null
  refs: number
  timer: ReturnType<typeof setTimeout> | null
  /** 予算に数える量 (三角形の数、ガウス分布の数、面の数) */
  cost: number
}

export interface SharedLoaderOptions<T> {
  /** 同時に読む数 */
  concurrency: number
  /** 読んでおく全部の量の上限。超えるときは使われていないものから片付け、それでも超えれば読めなかったことにする */
  budget: number
  /** 使う看板がなくなってから片付けるまで (ミリ秒) */
  keepMillis: number
  load(url: string, ctx: RenderContext): Promise<T>
  cost(value: T): number
  dispose(value: T): void
}

export class OverBudgetError extends Error {
  constructor() {
    super('over budget')
  }
}

export class SharedLoader<T> {
  private readonly entries = new Map<string, SharedEntry<T>>()
  private running = 0
  private readonly waiters: (() => void)[] = []
  private readonly options: SharedLoaderOptions<T>

  constructor(options: SharedLoaderOptions<T>) {
    this.options = options
  }

  acquire(url: string, ctx: RenderContext): SharedEntry<T> {
    let e = this.entries.get(url)
    if (!e) {
      const entry: SharedEntry<T> = { url, promise: null, value: null, refs: 0, timer: null, cost: 0 }
      entry.promise = this.run(ctx, () => this.options.load(url, ctx)).then((value) => {
        const cost = this.options.cost(value)
        if (!this.makeRoom(cost)) {
          this.options.dispose(value)
          throw new OverBudgetError()
        }
        entry.value = value
        entry.cost = cost
        return value
      })
      // 読めなかったものも、使う看板がなくなるまでは覚えておく (同じものを何度も読まない)
      entry.promise.catch(() => {})
      this.entries.set(url, entry)
      e = entry
    }
    if (e.timer) {
      clearTimeout(e.timer)
      e.timer = null
    }
    e.refs++
    return e
  }

  release(url: string): void {
    const e = this.entries.get(url)
    if (!e || --e.refs > 0) return
    e.timer = setTimeout(() => {
      if (e.refs > 0) return
      this.entries.delete(url)
      if (e.value) this.options.dispose(e.value)
    }, this.options.keepMillis)
  }

  private async run<R>(ctx: RenderContext, job: () => Promise<R>): Promise<R> {
    if (this.running >= this.options.concurrency) {
      ctx.loads.queued++
      await new Promise<void>(resolve => this.waiters.push(resolve))
      ctx.loads.queued--
    }
    this.running++
    ctx.loads.loading++
    try {
      return await job()
    }
    finally {
      ctx.loads.loading--
      this.running--
      this.waiters.shift()?.()
    }
  }

  private makeRoom(cost: number): boolean {
    let total = cost
    for (const e of this.entries.values()) total += e.cost
    if (total <= this.options.budget) return true
    for (const [url, e] of this.entries) {
      if (total <= this.options.budget) break
      if (e.refs > 0 || !e.value) continue
      total -= e.cost
      if (e.timer) clearTimeout(e.timer)
      this.entries.delete(url)
      this.options.dispose(e.value)
    }
    return total <= this.options.budget
  }
}

/**
 * 同時に置く数の上限。カメラに近いものから limit 個だけを「置いてよい」にする (ほかは種類の絵の板)。
 */
export class InstanceLimiter {
  private readonly items = new Set<{ distance: number, setAllowed(value: boolean): void }>()
  private allowed = new Set<{ distance: number, setAllowed(value: boolean): void }>()
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  add(item: { distance: number, setAllowed(value: boolean): void }): void {
    this.items.add(item)
    if (!this.timer) this.timer = setInterval(() => this.schedule(), 400)
    this.schedule()
  }

  remove(item: { distance: number, setAllowed(value: boolean): void }): void {
    this.items.delete(item)
    this.allowed.delete(item)
    if (this.items.size === 0 && this.timer) {
      clearInterval(this.timer)
      this.timer = null
    }
  }

  schedule(): void {
    const next = nearest(this.items, i => i.distance, this.limit)
    for (const i of this.items) {
      const value = next.has(i)
      if (value !== this.allowed.has(i)) i.setAllowed(value)
    }
    this.allowed = next
  }
}

/** モデルの座標から、ワールドの座標への変換 (看板のブロックの位置 × MarumaSign 本体と同じ置き方) */
export function placementMatrix(sign: Sign, box: readonly number[], extra?: Matrix4): Matrix4 {
  const m = new Matrix4().fromArray(modelPlacement(sign, box))
  m.premultiply(new Matrix4().makeTranslation(sign.x, sign.y, sign.z))
  if (extra) m.multiply(extra)
  return m
}

/** 置いたモデルを囲む球 (画面に入っているかを調べる) */
export function placedSphere(matrix: Matrix4, box: readonly number[]): Sphere {
  const b = new Box3(new Vector3(box[0], box[1], box[2]), new Vector3(box[3], box[4], box[5]))
  return b.applyMatrix4(matrix).getBoundingSphere(new Sphere())
}
