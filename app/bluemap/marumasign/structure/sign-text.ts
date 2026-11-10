// 看板の文字を絵にする (MarumaSign 本体の SignTexts と同じ)。Minecraft のフォント (font/include/default.json の bitmap) と同じ字形と幅で描き、
// jar にない文字は、ゲームと同じく Unifont で描く (Unifont はサーバーの /mcassets/ が 256 文字ずつ返す)
// ここは Node の試験でも使う
import { type GameAssets, Sprite } from './assets.ts'
import { arr, int, obj, str } from './json.ts'

/** 絵の大きさ (文字の座標で、看板の中心からの範囲) と、文字の座標 1 あたりのピクセル数 */
export const HALF_WIDTH = 50, HALF_HEIGHT = 26, SCALE = 2
/** 文字ディスプレイの幅 (文字の座標) と行の数の上限 */
export const MAX_BLOCK_WIDTH = 512, MAX_BLOCK_LINES = 48
/** 1 つの文字のデータから読む文字の数の上限 */
export const MAX_TEXT = 2048

const COLOR_NAMES = ['black', 'dark_blue', 'dark_green', 'dark_aqua', 'dark_red', 'dark_purple', 'gold', 'gray',
  'dark_gray', 'blue', 'green', 'aqua', 'red', 'light_purple', 'yellow', 'white']
const COLOR_VALUES = [0x000000, 0x0000AA, 0x00AA00, 0x00AAAA, 0xAA0000, 0xAA00AA, 0xFFAA00, 0xAAAAAA,
  0x555555, 0x5555FF, 0x55FF55, 0x55FFFF, 0xFF5555, 0xFF55FF, 0xFFFF55, 0xFFFFFF]
/** DyeColor.getTextColor (DYE_COLORS と同じ順) */
export const DYE_TEXT = [0xFFFFFF, 0xFF681F, 0xFF00FF, 0x9AC0CD, 0xFFFF00, 0xBFFF00, 0xFF69B4, 0x808080,
  0xD3D3D3, 0x00FFFF, 0xA020F0, 0x0000FF, 0x8B4513, 0x00FF00, 0xFF0000, 0x000000]

interface Glyph {
  // ビットマップのフォント
  pixels?: Uint8Array
  imageWidth?: number
  x?: number
  y?: number
  width?: number
  height?: number
  scale?: number
  ascent?: number
  // Unifont: 16 行のビット (幅は bits)
  rows?: number[][]
  bits?: number
  left?: number
  right?: number
  advance: number
  boldOffset: number
}

/** 文字の並び 1 つ (同じ色と太さ) */
export interface Run {
  text: string
  color: number | null
  bold: boolean
}

// Unifont の幅の指定 (unifont.json の size_overrides)
const OVERRIDES = [[0x3001, 0x30FF, 0, 15], [0x3200, 0x9FFF, 0, 15], [0x1100, 0x11FF, 0, 15], [0x3130, 0x318F, 0, 15],
  [0xA960, 0xA97F, 0, 15], [0xD7B0, 0xD7FF, 0, 15], [0xAC00, 0xD7AF, 1, 15], [0xF900, 0xFAFF, 0, 15], [0xFF01, 0xFF5E, 0, 15]]

const CACHE = new Map<string, Sprite>()
const CACHE_SIZE = 256

function remember(key: string, s: Sprite): void {
  if (s.pending) return
  if (CACHE.size >= CACHE_SIZE) CACHE.delete(CACHE.keys().next().value!)
  CACHE.set(key, s)
}

export class SignTexts {
  private readonly assets: GameAssets
  private bitmap: Map<number, Glyph> | null = null
  private readonly unifont = new Map<number, Glyph | null>()
  private readonly pages = new Map<number, Map<number, string> | null>()
  /** まだ読んでいないフォントがあった (この結果は使わない) */
  pending = false
  private bitmapPending = false

  constructor(assets: GameAssets) {
    this.assets = assets
  }

  private loadBitmaps(): Map<number, Glyph> {
    const map = new Map<number, Glyph>()
    for (const item of this.assets.bundle.fonts) {
      const provider = obj(item)
      if (str(provider, 'type', '') !== 'bitmap') continue
      const file = str(provider, 'file', '')
      const sprite = this.assets.sprite(file.replace(/\.png$/, ''))
      if (sprite.pending) {
        this.pending = true
        continue
      }
      if (sprite.missing) continue
      const rows = arr(provider.chars)
      if (!rows.length) continue
      const grid = rows.map(r => Array.from(String(r), c => c.codePointAt(0)!))
      const columns = Math.max(...grid.map(r => r.length))
      if (!columns) continue
      const cellWidth = Math.floor(sprite.width / columns), cellHeight = Math.floor(sprite.height / grid.length)
      const height = int(provider, 'height', 8), ascent = int(provider, 'ascent', 7)
      const scale = height / cellHeight
      const pixels = sprite.frames[0]!
      for (let r = 0; r < grid.length; r++) {
        for (let c = 0; c < grid[r]!.length; c++) {
          const cp = grid[r]![c]!
          if (cp === 0 || map.has(cp)) continue
          const g: Glyph = { pixels, imageWidth: sprite.width, x: c * cellWidth, y: r * cellHeight, width: cellWidth, height: cellHeight, scale, ascent, advance: 0, boldOffset: 1 }
          // BitmapProvider.getActualGlyphWidth: 右から見て最初に色のある列まで
          let actual = cellWidth - 1
          outer:
          for (; actual >= 0; actual--) {
            for (let py = 0; py < cellHeight; py++) if (pixels[((g.y! + py) * sprite.width + g.x! + actual) * 4 + 3] !== 0) break outer
          }
          g.advance = Math.trunc(0.5 + (actual + 1) * scale) + 1
          map.set(cp, g)
        }
      }
    }
    return map
  }

  private unifontGlyph(cp: number): Glyph | null {
    if (this.unifont.has(cp)) return this.unifont.get(cp)!
    const pageNo = cp >> 8
    let page = this.pages.get(pageNo)
    if (page === undefined) {
      const text = this.assets.unifontPage(pageNo)
      if (text === undefined) {
        this.pending = true
        return null
      }
      page = null
      if (text) {
        page = new Map()
        for (const line of text.split('\n')) {
          const colon = line.indexOf(':')
          if (colon > 0) page.set(Number.parseInt(line.substring(0, colon), 16), line.substring(colon + 1))
        }
      }
      this.pages.set(pageNo, page)
    }
    const hex = page?.get(cp)
    let glyph: Glyph | null = null
    if (hex) {
      const bits = hex.length * 4 / 16
      if (bits > 0 && bits <= 64 && Number.isInteger(bits)) {
        const digits = bits / 4
        const rows: number[][] = []
        let left = bits, right = -1
        for (let row = 0; row < 16; row++) {
          const part = hex.substring(row * digits, (row + 1) * digits)
          const set: number[] = []
          for (let column = 0; column < bits; column++) {
            const nibble = Number.parseInt(part[column >> 2]!, 16)
            if ((nibble >> (3 - (column & 3))) & 1) {
              set.push(column)
              left = Math.min(left, column)
              right = Math.max(right, column)
            }
          }
          rows.push(set)
        }
        const o = OVERRIDES.find(r => cp >= r[0]! && cp <= r[1]!)
        if (o) {
          left = o[2]!
          right = o[3]!
        }
        else if (right < 0) {
          left = 0
          right = -1
        }
        glyph = { rows, bits, left, right, advance: Math.trunc((right - left + 1) / 2) + 1, boldOffset: 0.5 }
      }
    }
    if (this.unifont.size < 65536) this.unifont.set(cp, glyph)
    return glyph
  }

  private glyph(cp: number): Glyph | null {
    if (!this.bitmap) {
      const before = this.pending
      this.pending = false
      this.bitmap = this.loadBitmaps()
      this.bitmapPending = this.pending
      this.pending ||= before
    }
    const g = this.bitmap.get(cp)
    if (g) return g
    // フォントの画像をまだ読んでいなければ、Unifont は頼まない (読んだあとで、要るものだけ頼む)
    if (this.bitmapPending) return null
    return this.unifontGlyph(cp)
  }

  private advance(cp: number, bold: boolean): number {
    if (cp === 0x20) return 4
    if (cp === 0x200C) return 0
    const g = this.glyph(cp)
    if (!g) return 0
    return g.advance + (bold ? g.boldOffset : 0)
  }

  width(runs: Run[]): number {
    let w = 0
    for (const run of runs) for (const ch of run.text) w += this.advance(ch.codePointAt(0)!, run.bold)
    return w
  }

  /** 最大の幅に収まるところまでで切る (Font.split の最初の行) */
  truncate(runs: Run[], maxWidth: number): Run[] {
    const result: Run[] = []
    let w = 0
    for (const run of runs) {
      let kept = ''
      for (const ch of run.text) {
        const a = this.advance(ch.codePointAt(0)!, run.bold)
        if (w + a > maxWidth) {
          if (kept) result.push({ text: kept, color: run.color, bold: run.bold })
          return result
        }
        w += a
        kept += ch
      }
      result.push({ text: kept, color: run.color, bold: run.bold })
    }
    return result
  }

  /**
   * 看板の片面の文字を絵にする。文字がなければ null。
   * @param lineHeight 行の高さ
   * @param maxWidth 1 行の最大の幅
   * @param color 色を指定していない文字の色
   * @param outline 縁取りの色 (縁取りしなければ -1)
   */
  render(lines: Run[][], lineHeight: number, maxWidth: number, color: number, outline: number): Sprite | null {
    let key = 'sign:' + lineHeight + ':' + maxWidth + ':' + color + ':' + outline
    let any = false
    for (const line of lines) {
      key += '\n'
      for (const run of line) {
        key += run.color + (run.bold ? 'b' : 'n') + run.text + '\u0000'
        if (run.text.trim()) any = true
      }
    }
    if (!any) return null
    const hit = CACHE.get(key)
    if (hit) return hit
    const width = HALF_WIDTH * 2 * SCALE, height = HALF_HEIGHT * 2 * SCALE
    const text = new Uint32Array(width * height)
    const midpoint = Math.trunc(4 * lineHeight / 2)
    for (let i = 0; i < lines.length; i++) {
      const line = this.truncate(lines[i]!, maxWidth)
      let x = -Math.trunc(Math.trunc(this.width(line)) / 2)
      const y = i * lineHeight - midpoint
      for (const run of line) {
        const runColor = (0xFF000000 | (run.color ?? color)) >>> 0
        for (const ch of run.text) {
          const cp = ch.codePointAt(0)!
          const g = cp === 0x20 ? null : this.glyph(cp)
          if (g) {
            draw(text, width, height, g, x, y, runColor)
            if (run.bold) draw(text, width, height, g, x + g.boldOffset, y, runColor)
          }
          x += this.advance(cp, run.bold)
        }
      }
    }
    let pixels = text
    if (outline !== -1) {
      // 光る文字の縁取り: 文字のまわり 1 ます (文字の座標で) に縁の色を置き、その上に文字を重ねる
      pixels = new Uint32Array(text.length)
      const o = (0xFF000000 | outline) >>> 0
      for (let py = 0; py < height; py++) {
        for (let px = 0; px < width; px++) {
          if ((text[py * width + px]! >>> 24) === 0) continue
          for (let oy = -SCALE; oy <= SCALE; oy += SCALE) {
            for (let ox = -SCALE; ox <= SCALE; ox += SCALE) {
              const nx = px + ox, ny = py + oy
              if (nx >= 0 && ny >= 0 && nx < width && ny < height) pixels[ny * width + nx] = o
            }
          }
        }
      }
      for (let i = 0; i < text.length; i++) if ((text[i]! >>> 24) !== 0) pixels[i] = text[i]!
    }
    const sprite = new Sprite(key, width, height, [toRgba(pixels)], null, null, false, false, this.pending)
    remember(key, sprite)
    return sprite
  }

  /** 文字の並びを、改行と最大の幅で行に分ける */
  wrap(runs: Run[], maxWidth: number): Run[][] {
    const lines: Run[][] = []
    let line: Run[] = []
    let w = 0
    for (const run of runs) {
      let part = ''
      for (const ch of run.text) {
        const cp = ch.codePointAt(0)!
        const a = this.advance(cp, run.bold)
        if (cp === 0x0A || (w + a > maxWidth && w > 0)) {
          if (part) line.push({ text: part, color: run.color, bold: run.bold })
          part = ''
          lines.push(line)
          line = []
          w = 0
          if (cp === 0x0A) continue
        }
        part += ch
        w += a
      }
      if (part) line.push({ text: part, color: run.color, bold: run.bold })
    }
    lines.push(line)
    return lines
  }

  /** 文字ディスプレイの文字を、背景付きの絵にする (TextDisplayRenderer と同じ並べ方)。幅と高さは文字の座標 (背景の分の 1 を含む) */
  renderBlock(runs: Run[], lineWidth: number, alignment: string, background: number, opacity: number): { sprite: Sprite, width: number, height: number } {
    let lines = this.wrap(runs, Math.max(1, Math.min(MAX_BLOCK_WIDTH, lineWidth)))
    if (lines.length > MAX_BLOCK_LINES) lines = lines.slice(0, MAX_BLOCK_LINES)
    let textWidth = 0
    for (const l of lines) textWidth = Math.max(textWidth, Math.trunc(this.width(l)))
    const lineHeight = 10
    const textHeight = lines.length * lineHeight - 1
    const boxWidth = textWidth + 1, boxHeight = textHeight + 1
    const width = boxWidth * SCALE, height = boxHeight * SCALE
    const pixels = new Uint32Array(Math.max(1, width * height)).fill(background >>> 0)
    const alpha = Math.max(0, Math.min(255, opacity))
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      const lw = this.width(line)
      let x = alignment === 'left' ? 0 : alignment === 'right' ? textWidth - lw : textWidth / 2 - lw / 2
      const y = i * lineHeight
      for (const run of line) {
        const runColor = ((alpha << 24) | (run.color ?? 0xFFFFFF)) >>> 0
        for (const ch of run.text) {
          const cp = ch.codePointAt(0)!
          const g = cp === 0x20 ? null : this.glyph(cp)
          if (g) {
            draw(pixels, width, height, g, x + 1 - HALF_WIDTH, y + 1 - HALF_HEIGHT, runColor)
            if (run.bold) draw(pixels, width, height, g, x + 1 + g.boldOffset - HALF_WIDTH, y + 1 - HALF_HEIGHT, runColor)
          }
          x += this.advance(cp, run.bold)
        }
      }
    }
    const sprite = new Sprite('text_display:' + Math.random(), Math.max(1, width), Math.max(1, height), [toRgba(pixels)], null, null, false, false, this.pending)
    return { sprite, width: boxWidth, height: boxHeight }
  }
}

function toRgba(argb: Uint32Array): Uint8Array {
  const out = new Uint8Array(argb.length * 4)
  for (let i = 0; i < argb.length; i++) {
    const c = argb[i]!
    out[i * 4] = (c >>> 16) & 255
    out[i * 4 + 1] = (c >>> 8) & 255
    out[i * 4 + 2] = c & 255
    out[i * 4 + 3] = c >>> 24
  }
  return out
}

function draw(target: Uint32Array, width: number, height: number, g: Glyph, x: number, y: number, color: number): void {
  if (g.rows) {
    // Unifont: 1 ピクセルが文字の座標で 0.5
    for (let row = 0; row < 16; row++) {
      for (const column of g.rows[row]!) {
        if (column < g.left! || column > g.right!) continue
        fill(target, width, height, x + (column - g.left!) * 0.5, y + row * 0.5, 0.5, 0.5, color)
      }
    }
    return
  }
  const top = y + 7 - g.ascent!
  const px = g.pixels!, iw = g.imageWidth!, s = g.scale!
  for (let py = 0; py < g.height!; py++) {
    for (let pxi = 0; pxi < g.width!; pxi++) {
      const o = ((g.y! + py) * iw + g.x! + pxi) * 4
      const a = px[o + 3]!
      if (a === 0) continue
      // フォントの画像は白で描かれているので、色を掛ける
      const r = Math.trunc(px[o]! * ((color >>> 16) & 255) / 255)
      const gg = Math.trunc(px[o + 1]! * ((color >>> 8) & 255) / 255)
      const b = Math.trunc(px[o + 2]! * (color & 255) / 255)
      fill(target, width, height, x + pxi * s, top + py * s, s, s, ((a << 24) | (r << 16) | (gg << 8) | b) >>> 0)
    }
  }
}

// 文字の座標の範囲を塗る (Java の Math.round と同じ丸め)
function fill(target: Uint32Array, width: number, height: number, x: number, y: number, w: number, h: number, color: number): void {
  const x0 = Math.floor((x + HALF_WIDTH) * SCALE + 0.5), y0 = Math.floor((y + HALF_HEIGHT) * SCALE + 0.5)
  const x1 = Math.floor((x + w + HALF_WIDTH) * SCALE + 0.5), y1 = Math.floor((y + h + HALF_HEIGHT) * SCALE + 0.5)
  for (let py = Math.max(0, y0); py < Math.min(height, y1); py++) {
    for (let px = Math.max(0, x0); px < Math.min(width, x1); px++) target[py * width + px] = color
  }
}

// ---------- 文字のデータ ----------

export function namedColor(name: unknown): number | null {
  if (typeof name !== 'string') return null
  if (name.startsWith('#')) {
    const n = Number.parseInt(name.substring(1), 16)
    return Number.isFinite(n) ? n & 0xFFFFFF : null
  }
  const i = COLOR_NAMES.indexOf(name)
  return i >= 0 ? COLOR_VALUES[i]! : null
}

/**
 * 1 行分のデータ (文字そのまま、JSON の文字列、NBT のテキストコンポーネント) を文字の並びにする。§ による色と太字の指定も読む
 */
export function parseText(value: unknown): Run[] {
  const runs: Run[] = []
  let component: unknown = value
  if (typeof value === 'string') {
    const first = value ? value[0] : ' '
    if (first === '{' || first === '[' || first === '"') {
      try {
        component = JSON.parse(value)
      }
      catch {
        component = value
      }
    }
  }
  flatten(component, null, false, runs, 0)
  return runs
}

function totalLength(runs: Run[]): number {
  let n = 0
  for (const r of runs) n += r.text.length
  return n
}

function flatten(value: unknown, color: number | null, bold: boolean, runs: Run[], depth: number): void {
  if (depth > 32 || totalLength(runs) >= MAX_TEXT) return
  if (typeof value === 'string') addLegacy(value, color, bold, runs)
  else if (Array.isArray(value)) {
    // リストの最初の要素の書式は、残りの要素にも引き継がれる
    for (const item of value.slice(0, 256)) flatten(item, color, bold, runs, depth + 1)
  }
  else if (value instanceof Map || (value && typeof value === 'object')) {
    const get = (k: string): unknown => value instanceof Map ? value.get(k) : Object.prototype.hasOwnProperty.call(value, k) ? (value as Record<string, unknown>)[k] : undefined
    const own = namedColor(get('color'))
    const b = get('bold')
    const ownBold = typeof b === 'boolean' ? b : typeof b === 'number' ? b !== 0 : bold
    const used = own ?? color
    const text = get('text') !== undefined ? get('text') : get('')
    if (typeof text === 'string') addLegacy(text, used, ownBold, runs)
    else if (typeof get('translate') === 'string') addLegacy(get('translate') as string, used, ownBold, runs)
    flatten(get('extra'), used, ownBold, runs, depth + 1)
  }
  else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') addLegacy(String(value), color, bold, runs)
}

// § の書式記号を読みながら加える
function addLegacy(text: string, color: number | null, bold: boolean, runs: Run[]): void {
  const total = totalLength(runs)
  if (total >= MAX_TEXT) return
  if (text.length > MAX_TEXT - total) text = text.substring(0, MAX_TEXT - total)
  let current = color
  let currentBold = bold
  let b = ''
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (c === '§' && i + 1 < text.length) {
      if (b) {
        runs.push({ text: b, color: current, bold: currentBold })
        b = ''
      }
      const code = text[++i]!.toLowerCase()
      const index = '0123456789abcdef'.indexOf(code)
      if (index >= 0) {
        current = COLOR_VALUES[index]!
        currentBold = false
      }
      else if (code === 'l') currentBold = true
      else if (code === 'r') {
        current = color
        currentBold = bold
      }
      continue
    }
    b += c
  }
  if (b) runs.push({ text: b, color: current, bold: currentBold })
}
