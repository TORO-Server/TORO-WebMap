// 画像の看板 (前のスクリプトの activate / addMesh と同じ)。アニメーションも同じテクスチャを進めるだけ
import { Board } from '../board'
import { imageCache } from '../image-cache'
import type { Route } from '../core'
import type { RenderContext, RendererHooks, Sign, SignRenderer } from '../types'

export class ImageRenderer implements SignRenderer {
  readonly sign: Sign
  private readonly ctx: RenderContext
  private readonly route: Route
  private readonly hooks: RendererHooks
  private readonly board: Board
  private requested = false
  private disposed = false

  constructor(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks) {
    this.ctx = ctx
    this.sign = sign
    this.route = route
    this.hooks = hooks
    this.board = new Board(ctx, sign)
  }

  start(): void {
    this.requested = true
    imageCache.request(this.route.url, this.route.ext, (t) => {
      if (this.disposed) return
      if (t.state === 'ok' && t.tex && t.aspect) {
        this.board.show(t.tex, t.aspect[0], t.aspect[1])
        this.hooks.shown()
      }
      else if (t.wrong) {
        this.hooks.reroute({ type: t.wrong.route as Route['type'], url: this.route.url, ext: this.route.ext })
      }
      else {
        this.hooks.failed()
      }
    })
  }

  update(): void {}

  dispose(): void {
    this.disposed = true
    this.board.remove()
    if (this.requested) imageCache.release(this.route.url)
  }
}

export function createImageRenderer(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks): SignRenderer {
  return new ImageRenderer(ctx, sign, route, hooks)
}
