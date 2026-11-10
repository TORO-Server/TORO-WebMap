// 画像のテクスチャ (URL ごとに 1 つ。同じ URL の看板で分け合う)。前のスクリプトの requestTexture, pumpQueue, evictTextures と同じ
import type { Texture } from 'three'
import { WrongKindError } from './fetch'
import { loadImage, type Animation } from './image-load'

const MAX_CONCURRENT_LOADS = 3
const TEXTURE_PIXEL_BUDGET = 48 * 1024 * 1024

export interface TextureEntry {
  state: 'new' | 'loading' | 'ok' | 'fail'
  tex: Texture | null
  pixels: number
  last: number
  /** 元の画像の大きさ [横, 縦] */
  aspect: [number, number] | null
  waiting: ((t: TextureEntry) => void)[]
  /** いま使っている看板の数 */
  refs: number
  animation: Animation | null
  /** 画像ではなかったとき、その正しい描き方 */
  wrong: WrongKindError | null
  ext: string
}

export class ImageCache {
  readonly textures = new Map<string, TextureEntry>()
  private readonly loadQueue: string[] = []
  loading = 0
  /** テクスチャの一辺の上限 (データファイルの textureSize) */
  size = 1024

  get queued(): number {
    return this.loadQueue.length
  }

  /** URL のテクスチャを頼む。読み終わったら (もう読んであればすぐに) then を呼ぶ */
  request(url: string, ext: string, then: (t: TextureEntry) => void): void {
    let t = this.textures.get(url)
    if (!t) {
      t = { state: 'new', tex: null, pixels: 0, last: Date.now(), aspect: null, waiting: [], refs: 0, animation: null, wrong: null, ext }
      this.textures.set(url, t)
      this.loadQueue.push(url)
      this.pump()
    }
    t.last = Date.now()
    t.refs++
    if (t.state === 'ok' || t.state === 'fail') {
      then(t)
    }
    else {
      t.waiting.push(then)
    }
  }

  /** 看板が使わなくなった */
  release(url: string): void {
    const t = this.textures.get(url)
    if (t && t.refs > 0) {
      t.refs--
      t.last = Date.now()
    }
  }

  private pump(): void {
    while (this.loading < MAX_CONCURRENT_LOADS && this.loadQueue.length > 0) {
      // 新しく頼まれたものから読む (カメラの近くのものが後から頼まれるため)
      const url = this.loadQueue.pop()!
      const t = this.textures.get(url)
      if (!t || t.state !== 'new') continue
      t.state = 'loading'
      this.loading++
      loadImage(url, this.size, t.ext).then((r) => {
        t.tex = r.texture
        t.aspect = [r.width, r.height]
        t.pixels = r.pixels
        t.animation = r.animation ?? null
        t.state = 'ok'
      }).catch((e: unknown) => {
        if (e instanceof WrongKindError) t.wrong = e
        else console.info('MarumaSign: cannot load image', url, String(e))
        t.state = 'fail'
      }).finally(() => {
        this.loading--
        const waiting = t.waiting
        t.waiting = []
        for (const f of waiting) {
          try {
            f(t)
          }
          catch { /* 1 件の失敗で他を止めない */ }
        }
        this.evict()
        this.pump()
      })
    }
  }

  private evict(): void {
    let total = 0
    for (const t of this.textures.values()) total += t.pixels
    if (total <= TEXTURE_PIXEL_BUDGET) return
    const candidates: [string, TextureEntry][] = []
    for (const [url, t] of this.textures) if (t.state === 'ok' && t.refs <= 0) candidates.push([url, t])
    candidates.sort((a, b) => a[1].last - b[1].last)
    for (const [url, t] of candidates) {
      if (total <= TEXTURE_PIXEL_BUDGET) break
      total -= t.pixels
      t.tex?.dispose()
      t.animation?.dispose()
      this.textures.delete(url)
    }
  }

  /** 使っているアニメーションを進める。変わったものがあれば true */
  tick(now: number): boolean {
    let changed = false
    for (const t of this.textures.values()) {
      if (t.animation && t.refs > 0 && t.animation.tick(now)) changed = true
    }
    return changed
  }
}

/** すべての看板で 1 つ */
export const imageCache = new ImageCache()
