// 構造物の中にある、MarumaSign の形式で書かれた看板 (と、その文字を持つ看板のアイテム) (MarumaSign 本体の NestedSigns と SignSpec)。
// ゲームでは看板の板が消えて、書かれた URL の画像や 3D モデルが表示されるので、ここでは置く場所だけを集め、
// 中身は画面の側 (renderers/structure.ts) が、ほかの看板と同じ描き方 (renderers/) で、数と深さに上限をかけて描く
// ここは何も import しない
import type { Transform } from './transform.ts'

/** 看板に書かれる文字列の内容 (URL|X|Y|Z|横幅|高さ|Z軸回転|Y軸回転|X軸回転) */
export interface SignSpec {
  url: string
  x: number
  y: number
  z: number
  scaleX: number
  scaleY: number
  roll: number
  yaw: number
  pitch: number
}

const PARAMETER_COUNT = 9
/** 数値の上限 (本体と同じ。空を覆うような大きさにはさせない) */
const MAX_VALUE = 1000

function javaFloat(text: string): number {
  // Float.parseFloat と同じく、前後の空白と末尾の f / d を許す
  const t = text.trim().replace(/[fFdD]$/, '')
  if (!/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && !/^[+-]?(Infinity|NaN)$/.test(t)) return Number.NaN
  return Math.fround(Number(t))
}

export function parseSignSpec(text: string): SignSpec | null {
  if (!text || text.length < 2 * PARAMETER_COUNT - 1 || text.length > 4096) return null
  let bars = 0
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 0x7C) bars++
  if (bars < PARAMETER_COUNT - 1) return null
  // Java の String.split と同じく、最後の空の部分は除く
  const p = text.split('|')
  while (p.length && p[p.length - 1] === '') p.pop()
  if (p.length < PARAMETER_COUNT) return null
  const v: number[] = []
  for (let i = 1; i < PARAMETER_COUNT; i++) {
    const n = javaFloat(p[i]!)
    if (!Number.isFinite(n)) return null
    v.push(Math.max(-MAX_VALUE, Math.min(MAX_VALUE, n)))
  }
  return { url: p[0]!, x: v[0]!, y: v[1]!, z: v[2]!, scaleX: v[3]!, scaleY: v[4]!, roll: v[5]!, yaw: v[6]!, pitch: v[7]! }
}

/** 置き場所 1 つ */
export type NestedPlacement =
  | {
    kind: 'block'
    spec: SignSpec
    /** 看板の向き (core.ts の orient と同じ。立て看板 0 - 15、壁掛け看板 16 - 19) */
    orient: number
    /** 看板のブロックの角の位置 (構造物の座標) */
    origin: [number, number, number]
    /** 1 ブロックの大きさ (間引いた構造物では 1 / step) */
    scale: number
  }
  | {
    kind: 'item'
    spec: SignSpec
    /** アイテムの位置 (一辺 1 の立方体) から構造物の座標への変換 (行の順の 4x4) */
    matrix: number[]
  }

/** 1 つの構造物から集める置き場所の数の上限 (中身を読むのは、画面の側でさらに少なくする) */
export const MAX_NESTED_PLACEMENTS = 64

export class NestedSigns {
  readonly placements: NestedPlacement[] = []

  /** 看板の位置に、書かれた URL の中身を置く */
  emitSign(spec: SignSpec, signYaw: number, wall: boolean, origin: [number, number, number], scale: number): void {
    if (this.placements.length >= MAX_NESTED_PLACEMENTS) return
    const orient = wall ? 16 + (Math.round(signYaw / 90) & 3) : Math.round(signYaw / 22.5) & 15
    this.placements.push({ kind: 'block', spec, orient, origin, scale })
  }

  /** 看板のアイテムの位置 (一辺 1 の立方体) に、書かれた URL の中身を置く */
  emitItem(spec: SignSpec, transform: Transform): void {
    if (this.placements.length >= MAX_NESTED_PLACEMENTS || !transform.finite()) return
    this.placements.push({ kind: 'item', spec, matrix: Array.from(transform.m) })
  }
}
