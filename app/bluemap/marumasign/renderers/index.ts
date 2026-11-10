// 描き方ごとの作り方の表。画像のほかは、その種類の看板が近くに来たときに初めて読み込む (動的 import)
import type { RouteType } from '../core'
import type { RendererFactory } from '../types'
import { createImageRenderer } from './image'

const loaders: Record<RouteType, () => Promise<RendererFactory>> = {
  // 画像と、拡張子から分からないもの (読んでみて、画像でなければ正しい描き方に作り直す)
  image: async () => createImageRenderer,
  probe: async () => createImageRenderer,
  // 動画・音声とライブ配信 (hls.js などは、さらにその形式の看板が来たときに読み込む)
  video: () => import('./media').then(m => m.createMediaRenderer),
  hls: () => import('./media').then(m => m.createMediaRenderer),
  dash: () => import('./media').then(m => m.createMediaRenderer),
  flv: () => import('./media').then(m => m.createMediaRenderer),
  mjpeg: () => import('./media').then(m => m.createMediaRenderer),
  pdf: () => import('./pdf').then(m => m.createPdfRenderer),
  // 3D モデル (three.js の GLTFLoader)、ガウシアンスプラッティング (Spark)、構造物 (Worker で四角形にする)
  model: () => import('./model').then(m => m.createModelRenderer),
  splat: () => import('./splat').then(m => m.createSplatRenderer),
  structure: () => import('./structure').then(m => m.createStructureRenderer),
}

const loaded = new Map<RouteType, RendererFactory>([['image', createImageRenderer], ['probe', createImageRenderer]])
const pending = new Map<RouteType, Promise<RendererFactory>>()

/** もう読み込んであれば、その作り方 */
export function factoryNow(type: RouteType): RendererFactory | undefined {
  return loaded.get(type)
}

/** 作り方を読み込む */
export function loadFactory(type: RouteType): Promise<RendererFactory> {
  let p = pending.get(type)
  if (!p) {
    p = loaders[type]().then((f) => {
      loaded.set(type, f)
      return f
    })
    // 読み込めなければ、次に頼まれたときにやり直す
    p.catch(() => pending.delete(type))
    pending.set(type, p)
  }
  return p
}
