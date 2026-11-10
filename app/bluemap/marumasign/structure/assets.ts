// 構造物を描くための Minecraft のリソース (サーバーの /mcassets/ がまとめたもの。server/utils/mcassets-build.ts) と、
// テクスチャ 1 枚 (MarumaSign 本体の Sprite)。
// 四角形にする処理は同期で書く (本体と同じ形) ので、テクスチャやスキンは「要るものを集めて (needs)、まとめて読み、もう一度作る」形にする
// ここは Node の試験でも使う (読み方は呼ぶ側が渡す)
import { decodePng } from './png.ts'

export const OPAQUE = 0
/** 完全に透明な部分がある (くり抜き) */
export const CUTOUT = 1
/** 半透明の部分がある */
export const TRANSLUCENT = 2

/** /mcassets/<hash>/assets.json の中身 (server/utils/mcassets-build.ts の McBundle) */
export interface McBundle {
  format: number
  version: string
  blockstates: Record<string, unknown>
  models: Record<string, unknown>
  items: Record<string, unknown>
  equipment: Record<string, unknown>
  biomes: Record<string, [number, number, number | null, number | null, number | null, number | null, string]>
  paintings: Record<string, [number, number, string]>
  fonts: unknown[]
  textures: Record<string, [number, number, unknown]>
  unifont: boolean
}

let spriteSerial = 0

export class Sprite {
  readonly id: string
  readonly width: number
  readonly height: number
  /** 絵ごとの RGBA (アニメーションしなければ 1 枚) */
  readonly frames: Uint8Array[]
  /** 表示する順の絵の番号と、それぞれの時間 (tick)。アニメーションしなければ null */
  readonly sequence: number[] | null
  readonly times: number[] | null
  readonly interpolate: boolean
  readonly missing: boolean
  /** 読み込み前の仮のもの (この絵で作った四角形は使わない) */
  readonly pending: boolean
  /** まとめた画像の中で同じものを 1 つにするための番号 */
  readonly serial = ++spriteSerial
  private readonly transparencies = new Map<string, number>()

  constructor(id: string, width: number, height: number, frames: Uint8Array[], sequence: number[] | null, times: number[] | null,
    interpolate: boolean, missing: boolean, pending = false) {
    this.id = id
    this.width = width
    this.height = height
    this.frames = frames
    this.sequence = sequence
    this.times = times
    this.interpolate = interpolate
    this.missing = missing
    this.pending = pending
  }

  /** 作った絵 (旗の模様を重ねたものなど) */
  static of(id: string, width: number, height: number, pixels: Uint8Array): Sprite {
    return new Sprite(id, width, height, [pixels], null, null, false, false)
  }

  isAnimated(): boolean {
    return !!this.sequence && this.sequence.length > 1
  }

  firstFrame(): Uint8Array {
    return this.frames[this.sequence && this.sequence.length > 0 ? this.sequence[0]! : 0]!
  }

  /** 範囲 (0 - 1) の透明度の扱い。アニメーションするものはすべての絵を見る (SpriteContents.computeTransparency と同じ) */
  transparency(u0: number, v0: number, u1: number, v1: number): number {
    const key = u0 + ',' + v0 + ',' + u1 + ',' + v1
    const hit = this.transparencies.get(key)
    if (hit !== undefined) return hit
    const x0 = Math.max(0, Math.floor(Math.min(u0, u1) * this.width))
    const y0 = Math.max(0, Math.floor(Math.min(v0, v1) * this.height))
    const x1 = Math.min(this.width, Math.ceil(Math.max(u0, u1) * this.width))
    const y1 = Math.min(this.height, Math.ceil(Math.max(v0, v1) * this.height))
    let result = OPAQUE
    const count = this.sequence ? this.frames.length : 1
    outer:
    for (let f = 0; f < count; f++) {
      const px = this.frames[f]!
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const a = px[(y * this.width + x) * 4 + 3]!
          if (a === 0) result = Math.max(result, CUTOUT)
          else if (a < 255) {
            result = TRANSLUCENT
            break outer
          }
        }
      }
    }
    if (this.transparencies.size < 256) this.transparencies.set(key, result)
    return result
  }
}

/** テクスチャがないときの、紫と黒の市松模様 (Minecraft と同じ) */
function missingSprite(pending: boolean): Sprite {
  const px = new Uint8Array(16 * 16 * 4)
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const o = (y * 16 + x) * 4
      const on = (x < 8) === (y < 8)
      px[o] = on ? 0xF8 : 0
      px[o + 1] = 0
      px[o + 2] = on ? 0xF8 : 0
      px[o + 3] = 255
    }
  }
  return new Sprite(pending ? 'pending' : 'minecraft:missingno', 16, 16, [px], null, null, false, true, pending)
}

export const MISSING = missingSprite(false)
export const PENDING = missingSprite(true)

/** リソースの読み方 (Worker は /mcassets/ から、試験は手元のものから) */
export interface AssetLoader {
  /** テクスチャの PNG (textures.bin の中) */
  png(id: string, offset: number, length: number): Promise<Uint8Array | null>
  /** Unifont のページ ("XXXX:hex" の行)。なければ null */
  unifont(page: number): Promise<string | null>
  /** プレイヤーのスキン (https://textures.minecraft.net/texture/...) の PNG */
  skin(url: string): Promise<Uint8Array | null>
  /** 名前か UUID だけのプロフィールのスキン (サーバーの /mcassets/skin?<query>)。分からなければ null */
  lookup?(query: string): Promise<{ url: string | null, slim: boolean } | null>
}

const MAX_SKINS = 128

/** 読み込んだリソース (Worker の中で使い回す) */
export class GameAssets {
  readonly bundle: McBundle
  private readonly loader: AssetLoader
  private readonly sprites = new Map<string, Sprite>()
  private readonly skins = new Map<string, Sprite | null>()
  private readonly unifontPages = new Map<number, string | null>()
  private readonly wantedSprites = new Set<string>()
  private readonly wantedSkins = new Set<string>()
  private readonly wantedPages = new Set<number>()
  private readonly lookups = new Map<string, { url: string | null, slim: boolean } | null>()
  private readonly wantedLookups = new Set<string>()
  /** 見つからなかったテクスチャの名前 (確かめる用。数に上限) */
  readonly missingNames = new Set<string>()

  constructor(bundle: McBundle, loader: AssetLoader) {
    this.bundle = bundle
    this.loader = loader
  }

  /** まだ読んでいないものを頼んだか */
  get hasNeeds(): boolean {
    return this.wantedSprites.size > 0 || this.wantedSkins.size > 0 || this.wantedPages.size > 0 || this.wantedLookups.size > 0
  }

  /** テクスチャ (例: minecraft:block/stone)。なければ紫と黒の模様。まだ読んでいなければ仮のもの (読む予定に入れる) */
  sprite(name: string): Sprite {
    const id = name.indexOf(':') >= 0 ? name : 'minecraft:' + name
    const hit = this.sprites.get(id)
    if (hit) return hit
    if (this.bundle.textures[id]) {
      this.wantedSprites.add(id)
      return PENDING
    }
    if (this.missingNames.size < 256) this.missingNames.add(id)
    return MISSING
  }

  /** プレイヤーのスキン。読めなければ null。まだなら undefined (読む予定に入れる) */
  skin(url: string): Sprite | null | undefined {
    if (this.skins.has(url)) return this.skins.get(url)!
    this.wantedSkins.add(url)
    return undefined
  }

  /** 名前か UUID だけのプロフィールのスキンの URL。分からなければ null。まだなら undefined (聞く予定に入れる) */
  profileLookup(query: string): { url: string | null, slim: boolean } | null | undefined {
    if (!this.loader.lookup) return null
    if (this.lookups.has(query)) return this.lookups.get(query)!
    this.wantedLookups.add(query)
    return undefined
  }

  /** Unifont のページ。なければ null。まだなら undefined (読む予定に入れる) */
  unifontPage(page: number): string | null | undefined {
    if (!this.bundle.unifont) return null
    if (this.unifontPages.has(page)) return this.unifontPages.get(page)!
    this.wantedPages.add(page)
    return undefined
  }

  /** 頼まれたものを読む */
  async fulfill(): Promise<void> {
    const sprites = Array.from(this.wantedSprites)
    const skins = Array.from(this.wantedSkins)
    const pages = Array.from(this.wantedPages)
    const queries = Array.from(this.wantedLookups)
    this.wantedLookups.clear()
    this.wantedSprites.clear()
    this.wantedSkins.clear()
    this.wantedPages.clear()
    const jobs: (() => Promise<void>)[] = []
    for (const id of sprites) {
      jobs.push(async () => {
        const entry = this.bundle.textures[id]!
        let sprite: Sprite = MISSING
        try {
          const bytes = await this.loader.png(id, entry[0], entry[1])
          if (bytes) sprite = await spriteFromPng(id, bytes, entry[2])
        }
        catch { /* 読めなければ紫と黒 */ }
        this.sprites.set(id, sprite)
      })
    }
    for (const url of skins) {
      jobs.push(async () => {
        let sprite: Sprite | null = null
        try {
          const bytes = await this.loader.skin(url)
          if (bytes) {
            const png = await decodePng(bytes)
            if (png.width === 64 && (png.height === 64 || png.height === 32)) {
              const full = new Uint8Array(64 * 64 * 4)
              full.set(png.pixels.subarray(0, Math.min(png.pixels.length, full.length)))
              fixSkin(full, png.height === 32)
              sprite = Sprite.of('skin:' + url, 64, 64, full)
            }
          }
        }
        catch { /* スキンなし */ }
        if (this.skins.size >= MAX_SKINS) this.skins.delete(this.skins.keys().next().value!)
        this.skins.set(url, sprite)
      })
    }
    for (const query of queries) {
      jobs.push(async () => {
        let r: { url: string | null, slim: boolean } | null = null
        try {
          r = await this.loader.lookup!(query)
        }
        catch { /* 分からなければ Steve */ }
        if (this.lookups.size >= 1024) this.lookups.delete(this.lookups.keys().next().value!)
        this.lookups.set(query, r)
      })
    }
    for (const page of pages) {
      jobs.push(async () => {
        let text: string | null = null
        try {
          text = await this.loader.unifont(page)
        }
        catch { /* その文字は描かない */ }
        this.unifontPages.set(page, text)
      })
    }
    // 同時に 8 つずつ
    let next = 0
    const run = async (): Promise<void> => {
      while (next < jobs.length) await jobs[next++]!()
    }
    await Promise.all(Array.from({ length: Math.min(8, jobs.length) }, run))
  }
}

/**
 * スキンの、透けてはいけないところを不透明にし、古い 64 x 32 のスキンの帽子の層が全部不透明なら消す
 * (ゲームの SkinTextureDownloader.processLegacySkin と同じ。頭に使うところだけ)
 */
export function fixSkin(px: Uint8Array, legacy: boolean): void {
  const noAlpha = (x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) px[(y * 64 + x) * 4 + 3] = 255
  }
  noAlpha(0, 0, 32, 16)
  if (legacy) {
    // doNotchTransparencyHack: 帽子の層にひとつも透けたところがなければ、全部透明にする
    let opaque = true
    for (let y = 0; y < 32 && opaque; y++) for (let x = 32; x < 64; x++) if (px[(y * 64 + x) * 4 + 3]! < 128) {
      opaque = false
      break
    }
    if (opaque) for (let y = 0; y < 32; y++) for (let x = 32; x < 64; x++) px[(y * 64 + x) * 4 + 3] = 0
  }
  noAlpha(0, 16, 64, 32)
  noAlpha(16, 48, 48, 64)
}

/** PNG と .mcmeta の animation から Sprite を作る (MarumaSign 本体の Sprite.load と同じ) */
export async function spriteFromPng(id: string, bytes: Uint8Array, animation: unknown): Promise<Sprite> {
  const png = await decodePng(bytes)
  const iw = png.width, ih = png.height
  const anim = animation && typeof animation === 'object' ? animation as Record<string, unknown> : null
  if (!anim) return new Sprite(id, iw, ih, [png.pixels], null, null, false, false)
  const int = (v: unknown, d: number): number => typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : d
  const side = Math.min(iw, ih)
  const fw = int(anim.width, side), fh = int(anim.height, side)
  if (fw <= 0 || fh <= 0 || iw % fw !== 0 || ih % fh !== 0) return new Sprite(id, iw, ih, [png.pixels], null, null, false, false)
  const columns = iw / fw
  const count = Math.min(1024, columns * (ih / fh))
  const frames: Uint8Array[] = []
  for (let f = 0; f < count; f++) {
    const ox = (f % columns) * fw, oy = Math.floor(f / columns) * fh
    const px = new Uint8Array(fw * fh * 4)
    for (let y = 0; y < fh; y++) px.set(png.pixels.subarray(((oy + y) * iw + ox) * 4, ((oy + y) * iw + ox + fw) * 4), y * fw * 4)
    frames.push(px)
  }
  const defaultTime = Math.max(1, int(anim.frametime, 1))
  const order: [number, number][] = []
  const listed = Array.isArray(anim.frames) ? anim.frames : []
  if (!listed.length) for (let f = 0; f < count; f++) order.push([f, defaultTime])
  else {
    for (const item of listed.slice(0, 4096)) {
      if (typeof item === 'number') order.push([Math.round(item), defaultTime])
      else if (item && typeof item === 'object') {
        const o = item as Record<string, unknown>
        order.push([int(o.index, 0), Math.max(1, int(o.time, defaultTime))])
      }
    }
  }
  const sequence = order.map(o => o[0] >= 0 && o[0] < count ? o[0] : 0)
  const times = order.map(o => o[1])
  return new Sprite(id, fw, fh, frames, sequence, times, anim.interpolate === true, false)
}
