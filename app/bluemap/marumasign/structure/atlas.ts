// 使われているテクスチャを 1 枚 (入りきらなければ数枚) の大きな画像にまとめ、四角形の UV をその中の位置にする (MarumaSign 本体の Atlas と同じ)。
// アニメーションするテクスチャは、絵を差し替えやすいように別の画像にまとめ、絵の並びと時間を画面の側 (renderers/structure.ts) に渡す。
// 遠くでちらつかないように、ゲームと同じく 4 段の縮小した絵 (ミップマップ) を作る。テクスチャごとに縮める (隣のテクスチャと混ざらない) ため、
// テクスチャの左上を 16 ピクセルごとの位置にそろえ、まわりに端の色を延ばした余白 (8 ピクセル。1 段ごとに半分) を置く
// ここは Node の試験でも使う
import { MISSING, type Sprite } from './assets.ts'
import type { MeshOutput } from './structure-mesher.ts'

const MAX_SIZE = 4096
/** ミップマップの段の数 (ゲームの初期設定と同じ) */
export const MIP_LEVELS = 4
/** テクスチャの左上をそろえる間隔 (2 の MIP_LEVELS 乗) */
const ALIGN = 1 << MIP_LEVELS
/** テクスチャの周りに端の色を延ばす幅 (1 段目。段ごとに半分、少なくとも 1) */
const GUTTER = ALIGN / 2

function roundUp(v: number): number {
  return Math.ceil(v / ALIGN) * ALIGN
}

/** 段 level での余白の幅 */
function gutterAt(level: number): number {
  return Math.max(1, GUTTER >> level)
}

export interface AnimatedSprite {
  width: number
  height: number
  x: number
  y: number
  frames: Uint8Array[]
  sequence: number[]
  times: number[]
  interpolate: boolean
}

export interface AtlasPage {
  width: number
  height: number
  /** RGBA (最初の絵) */
  pixels: Uint8Array
  /** 縮小した絵 (1 段目から。それぞれ幅と高さが半分) */
  mips: Uint8Array[]
  /** アニメーションするテクスチャ (この画像がアニメーションの画像のときだけ) */
  animated: AnimatedSprite[] | null
}

/** 層と画像ごとの四角形 */
export interface AtlasPart {
  /** 0 不透明、1 切り抜き、2 半透明 */
  layer: number
  page: number
  positions: Float32Array
  uvs: Float32Array
  /** 頂点の色 (RGB、0 - 255) */
  colors: Uint8Array
  quads: number
}

interface Slot {
  page: number
  x: number
  y: number
}

export class Atlas {
  readonly pages: AtlasPage[] = []
  private readonly pageSprites: Sprite[][] = []
  private readonly pagePlaces: [number, number][][] = []
  private readonly slots: Slot[]
  /** まとめに入れた絵 (大きすぎて入らないものは紫と黒の模様にしたもの) */
  private readonly effective: Sprite[]

  constructor(sprites: Sprite[]) {
    this.slots = new Array(sprites.length)
    this.effective = sprites.slice()
    const still: number[] = [], moving: number[] = []
    for (let i = 0; i < sprites.length; i++) (sprites[i]!.isAnimated() ? moving : still).push(i)
    this.pack(this.effective, still, false)
    this.pack(this.effective, moving, true)
  }

  private pack(sprites: Sprite[], indices: number[], animated: boolean): void {
    if (!indices.length) return
    // 背の高い順に棚に並べる
    const order = indices.slice().sort((a, b) => {
      const sa = sprites[a]!, sb = sprites[b]!
      if (sa.height !== sb.height) return sb.height - sa.height
      return sb.width - sa.width
    })
    let start = 0
    while (start < order.length) {
      let area = 0
      for (let i = start; i < order.length; i++) {
        const s = sprites[order[i]!]!
        area += (roundUp(s.width) + ALIGN) * (roundUp(s.height) + ALIGN)
      }
      let size = 16
      while (size < MAX_SIZE && size * size < area) size *= 2
      let placed: number
      for (;;) {
        placed = this.tryPack(sprites, order, start, size, false, animated)
        if (placed === order.length - start || size >= MAX_SIZE) break
        size *= 2
      }
      if (placed === 0) {
        // 1 枚が大きすぎる。紫と黒の模様で代わりにする
        sprites[order[start]!] = MISSING
        placed = this.tryPack(sprites, order, start, size, false, animated)
        if (placed === 0) placed = 1
      }
      this.tryPack(sprites, order, start, size, true, animated)
      start += placed
    }
  }

  private tryPack(sprites: Sprite[], order: number[], start: number, size: number, commit: boolean, animated: boolean): number {
    let x = 0, y = 0, shelf = 0, count = 0
    let page: AtlasPage | null = null
    let pageIndex = -1
    if (commit) {
      const mips: Uint8Array[] = []
      for (let k = 1; k <= MIP_LEVELS; k++) mips.push(new Uint8Array(Math.max(1, size >> k) * Math.max(1, size >> k) * 4))
      page = { width: size, height: size, pixels: new Uint8Array(size * size * 4), mips, animated: animated ? [] : null }
      pageIndex = this.pages.length
      this.pages.push(page)
      this.pageSprites.push([])
      this.pagePlaces.push([])
    }
    for (let i = start; i < order.length; i++) {
      const sprite = sprites[order[i]!]!
      // ます目: 左と上に ALIGN の余白 (隣と分け合う)、テクスチャは ALIGN の倍数の位置から。右と下の端には ALIGN を残す
      const w = ALIGN + roundUp(sprite.width), h = ALIGN + roundUp(sprite.height)
      if (w + ALIGN > size || h + ALIGN > size) break
      if (x + w + ALIGN > size) {
        x = 0
        y += shelf
        shelf = 0
      }
      if (y + h + ALIGN > size) break
      if (commit && page) {
        const slot = { page: pageIndex, x: x + ALIGN, y: y + ALIGN }
        this.slots[order[i]!] = slot
        this.pageSprites[pageIndex]!.push(sprite)
        this.pagePlaces[pageIndex]!.push([slot.x, slot.y])
        drawWithMips(page, sprite, sprite.firstFrame(), slot.x, slot.y)
        if (page.animated && sprite.isAnimated()) {
          page.animated.push({
            width: sprite.width, height: sprite.height, x: slot.x, y: slot.y,
            // Worker の中で使い回す絵と分けるために写す
            frames: sprite.frames.map(f => f.slice()),
            sequence: sprite.sequence!.slice(), times: sprite.times!.slice(), interpolate: sprite.interpolate,
          })
        }
      }
      x += w
      shelf = Math.max(shelf, h)
      count++
    }
    return count
  }

  /** 書き出した四角形から、層と画像ごとの並びを作る */
  build(output: MeshOutput): AtlasPart[] {
    const parts: AtlasPart[] = []
    for (let layer = 0; layer < 3; layer++) {
      const spriteOf = output.spriteOf[layer]!
      const quads = spriteOf.n
      if (!quads) continue
      for (let p = 0; p < this.pages.length; p++) {
        const page = this.pages[p]!
        let count = 0
        for (let q = 0; q < quads; q++) if (this.slots[spriteOf.a[q]!]?.page === p) count++
        if (!count) continue
        const positions = new Float32Array(count * 12)
        const uvs = new Float32Array(count * 8)
        const colors = new Uint8Array(count * 12)
        const srcPos = output.positions[layer]!.a, srcUv = output.uvs[layer]!.a, srcColor = output.colors[layer]!.a
        let n = 0
        for (let q = 0; q < quads; q++) {
          const si = spriteOf.a[q]!
          const slot = this.slots[si]
          if (!slot || slot.page !== p) continue
          const sprite = this.effective[si]!
          positions.set(srcPos.subarray(q * 12, q * 12 + 12), n * 12)
          for (let v = 0; v < 4; v++) {
            const c = srcColor[q * 4 + v]!
            colors[n * 12 + v * 3] = (c >> 16) & 255
            colors[n * 12 + v * 3 + 1] = (c >> 8) & 255
            colors[n * 12 + v * 3 + 2] = c & 255
            const u = clamp(srcUv[q * 8 + v * 2]!), t = clamp(srcUv[q * 8 + v * 2 + 1]!)
            uvs[n * 8 + v * 2] = (slot.x + u * sprite.width) / page.width
            uvs[n * 8 + v * 2 + 1] = (slot.y + t * sprite.height) / page.height
          }
          n++
        }
        parts.push({ layer, page: p, positions, uvs, colors, quads: count })
      }
    }
    return parts
  }
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v
}

type PageLike = { width: number, height: number, pixels: Uint8Array, mips?: Uint8Array[] }

/** テクスチャを画像に描き、周りに端の色を gutter ピクセル延ばす */
export function draw(page: { width: number, height: number, pixels: Uint8Array }, sprite: { width: number, height: number }, frame: Uint8Array, left: number, top: number, gutter = GUTTER): void {
  const w = sprite.width, h = sprite.height
  for (let y = -gutter; y < h + gutter; y++) {
    const sy = Math.max(0, Math.min(h - 1, y))
    const py = top + y
    if (py < 0 || py >= page.height) continue
    for (let x = -gutter; x < w + gutter; x++) {
      const sx = Math.max(0, Math.min(w - 1, x))
      const px = left + x
      if (px < 0 || px >= page.width) continue
      const s = (sy * w + sx) * 4, d = (py * page.width + px) * 4
      page.pixels[d] = frame[s]!
      page.pixels[d + 1] = frame[s + 1]!
      page.pixels[d + 2] = frame[s + 2]!
      page.pixels[d + 3] = frame[s + 3]!
    }
  }
}

// ---- ミップマップ (ゲームの MipmapGenerator と同じ混ぜ方: 色は 2.2 乗して平均。透明なところがある絵は、
//      透明でないピクセルだけを足して 4 で割り、アルファが 96 未満なら透明にする (切り抜きの形を保つ))

const POW22 = Float64Array.from({ length: 256 }, (_, i) => Math.pow(i / 255, 2.2))

function hasTransparent(px: Uint8Array): boolean {
  for (let i = 3; i < px.length; i += 4) if (px[i] === 0) return true
  return false
}

/** 1 段縮める (幅と高さは半分。奇数は切り上げ) */
export function halveImage(px: Uint8Array, w: number, h: number, checkAlpha: boolean): { px: Uint8Array, w: number, h: number } {
  const nw = Math.max(1, Math.ceil(w / 2)), nh = Math.max(1, Math.ceil(h / 2))
  const out = new Uint8Array(nw * nh * 4)
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, x * 2), x1 = Math.min(w - 1, x * 2 + 1), y0 = Math.min(h - 1, y * 2), y1 = Math.min(h - 1, y * 2 + 1)
      const idx = [(y0 * w + x0) * 4, (y0 * w + x1) * 4, (y1 * w + x0) * 4, (y1 * w + x1) * 4]
      const o = (y * nw + x) * 4
      if (checkAlpha) {
        let a = 0, r = 0, g = 0, b = 0
        for (const i of idx) {
          if (px[i + 3] === 0) continue
          a += POW22[px[i + 3]!]!
          r += POW22[px[i]!]!
          g += POW22[px[i + 1]!]!
          b += POW22[px[i + 2]!]!
        }
        let alpha = Math.trunc(Math.pow(a / 4, 1 / 2.2) * 255)
        if (alpha < 96) alpha = 0
        out[o] = Math.trunc(Math.pow(r / 4, 1 / 2.2) * 255)
        out[o + 1] = Math.trunc(Math.pow(g / 4, 1 / 2.2) * 255)
        out[o + 2] = Math.trunc(Math.pow(b / 4, 1 / 2.2) * 255)
        out[o + 3] = alpha
      }
      else {
        for (let c = 0; c < 4; c++) {
          out[o + c] = Math.trunc(Math.pow((POW22[px[idx[0]! + c]!]! + POW22[px[idx[1]! + c]!]! + POW22[px[idx[2]! + c]!]! + POW22[px[idx[3]! + c]!]!) * 0.25, 1 / 2.2) * 255)
        }
      }
    }
  }
  return { px: out, w: nw, h: nh }
}

/** テクスチャを、縮小した絵の段にも描く (左上は ALIGN の倍数) */
export function drawWithMips(page: PageLike, sprite: { width: number, height: number }, frame: Uint8Array, left: number, top: number): void {
  draw(page, sprite, frame, left, top, gutterAt(0))
  if (!page.mips?.length) return
  const checkAlpha = hasTransparent(frame)
  let img = { px: frame, w: sprite.width, h: sprite.height }
  for (let k = 1; k <= page.mips.length; k++) {
    img = halveImage(img.px, img.w, img.h, checkAlpha)
    const size = Math.max(1, page.width >> k)
    draw({ width: size, height: Math.max(1, page.height >> k), pixels: page.mips[k - 1]! }, { width: img.w, height: img.h }, img.px, left >> k, top >> k, gutterAt(k))
  }
}

/**
 * アニメーションの絵を進める (SpriteContents.AnimatedTexture と同じく tick ごと。interpolate なら次の絵と混ぜる)。
 * shown は前に描いたもの (絵の番号 * 256 + 混ぜる割合)。変わったら page を書き換えて true
 */
export function animate(page: PageLike, sprites: AnimatedSprite[], shown: Int32Array, tick: number): boolean {
  let changed = false
  for (let i = 0; i < sprites.length; i++) {
    const s = sprites[i]!
    let total = 0
    for (const t of s.times) total += t
    if (total <= 0 || s.sequence.length < 2) continue
    let t = tick % total
    let k = 0
    while (t >= s.times[k]!) {
      t -= s.times[k]!
      k++
    }
    const frame = s.sequence[k]!, next = s.sequence[(k + 1) % s.sequence.length]!
    let blend = 0
    if (s.interpolate && frame !== next) blend = Math.trunc(t * 255 / s.times[k]!)
    const key = frame * 256 + blend
    if (shown[i] === key) continue
    shown[i] = key
    changed = true
    let image = s.frames[frame]!
    if (blend > 0) {
      // InterpolationData: ratio = 1 - 経過 / 絵の時間 で今の絵と次の絵を混ぜる
      const ratio = 1 - t / s.times[k]!
      const a = s.frames[frame]!, b = s.frames[next]!
      image = new Uint8Array(a.length)
      for (let p = 0; p < a.length; p++) image[p] = Math.trunc(ratio * a[p]! + (1 - ratio) * b[p]!) & 255
    }
    drawWithMips(page, s, image, s.x, s.y)
  }
  return changed
}
