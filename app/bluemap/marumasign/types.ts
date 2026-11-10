// MarumaSign の看板の表示で使う型。種類ごとの描き方 (renderers/) は SignRenderer を実装する
import type { Group, Object3D, Sphere, Texture, Vector3, WebGLRenderer } from 'three'
import type { MediaKindId, ParsedSign, Route, SignLimits } from './core'
import type { MapViewer } from '../js/MapViewer'

/** データファイルの設定 (値は確かめて範囲に収めたもの) */
export interface Settings {
  drawDistance: number
  maxActive: number
  textureSize: number
  hideBoards: boolean
  labels: boolean
  /** 看板ごとの見える距離 (大きさから決まる) を使わず、drawDistance まで描く (Wiki の背景の撮影用) */
  fullDrawDistance: boolean
  limits: SignLimits
}

/** 地図に置く看板 1 つ */
export interface Sign extends ParsedSign {
  /** 見える距離 */
  cap: number
  kindId: MediaKindId
  /** 描き方。絵にしない (ラベルだけ) なら null */
  route: Route | null
}

/** 種類ごとの描き方が使うもの (overlay.ts が作る) */
export interface RenderContext {
  readonly viewer: MapViewer
  readonly renderer: WebGLRenderer
  /** 3D のものを入れる入れ物 (mapViewer.markers の子) */
  readonly group: Group
  readonly settings: Settings
  /** 描き直しを頼む */
  redraw(): void
  /** 看板を押したとき (リンクの案内を出す) */
  showInfo(sign: Sign): void
  /** 読み込みの数 (stats の loading と queued) を数える */
  readonly loads: LoadCounter
  /** 看板の種類の [icon, label] */
  kindLabel(sign: Sign): string
  /** 板が画面に入っているか (最後に update したときのカメラで) */
  inView(object: Object3D | null): boolean
  /** 球が画面に入っているか (3D のもの) */
  sphereInView(sphere: Sphere): boolean
  /** 最後に update したときのカメラの位置 */
  readonly camera: Vector3
  /** window.marumasign3d.stats() に、種類ごとの数を足す (動画の再生数など) */
  addStats(name: string, stats: () => unknown): void
}

/** 読み込み中の数 (window.marumasign3d.stats() の loading と queued に足す) */
export interface LoadCounter {
  loading: number
  queued: number
}

/**
 * 看板 1 つの描き方。種類ごとに 1 つずつ実装する (renderers/)。
 * 作る → start() → (近くにある間) update() と frame() → dispose() の順に呼ぶ。
 * 同じ URL の読み込み結果は、種類ごとの共有の入れ物 (テクスチャ、動画、PDF) で分け合う。
 */
export interface SignRenderer {
  readonly sign: Sign
  /** 近くに来たとき。読み込みを始める */
  start(): void
  /**
   * カメラが動いたとき (0.4 秒ごと)。
   * @param distance カメラから看板の中心までの距離 (ブロック)
   */
  update(distance: number): void
  /** 描くフレームごと。動画やアニメーションのテクスチャを進める。描き直しが要れば true */
  frame?(now: number): boolean
  /** 遠くなったとき。この看板の持ち物を片付ける (共有の入れ物は、使う看板がなくなったら片付く) */
  dispose(): void
}

/** 描き方から overlay.ts への知らせ */
export interface RendererHooks {
  /** 板 (絵) を出した。ラベルは消す */
  shown(): void
  /** 絵にできなかった。近ければラベルを出す (設定でラベルを出すときだけ) */
  failed(): void
  /** 中身を読んだら別の種類だった。その描き方で作り直す */
  reroute(route: Route): void
}

/** 種類ごとの描き方の作り方 (renderers/index.ts で、種類ごとに必要になったときだけ読み込む) */
export type RendererFactory = (ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks) => SignRenderer

/** 板に貼るもの (共有の入れ物が持つ) */
export interface BoardSource {
  texture: Texture
  width: number
  height: number
}
