// ブロックの性質の表 (tables/blocks.txt.gz。MarumaSign 本体の BlockData と同じもの。本体の tools/blockdata/BlockDataDump.java が作る)
// 性質の名前と取りうる値、既定の状態、面の隠れ方 (16 x 16 のます目)、光、液体などを、ブロックの状態ごとに持つ
// ここは何も import しない (Node の試験と Worker の両方で使う)
import { BlockState } from './block-state.ts'

export const FULL_COLLISION = 1
export const LIGHT_PERMEABLE = 2
export const SOLID_RENDER = 4
export const INVISIBLE = 8
/** 面が丈夫か (下、上、北、南、西、東の順に 1 ビットずつ) */
export const STURDY_SHIFT = 4
/** 固体 (BlockState.isSolid。液体の高さの計算に使う) */
export const SOLID = 1024

export const SKIP_NONE = 0
export const SKIP_SAME = 1
export const SKIP_BARS = 2
export const SKIP_LIQUID = 3
export const SKIP_ROOTS = 4

export const OFFSET_NONE = 0
export const OFFSET_XZ = 1
export const OFFSET_XYZ = 2

export class BlockInfo {
  readonly name: string
  readonly skip: number
  readonly offsetType: number
  readonly maxHorizontalOffset: number
  readonly maxVerticalOffset: number
  readonly propertyNames: string[]
  readonly propertyValues: string[][]
  readonly strides: number[]
  defaultIndex = 0
  readonly base: number
  readonly stateCount: number

  constructor(name: string, skip: number, offsetType: number, maxH: number, maxV: number, names: string[], values: string[][], base: number) {
    this.name = name
    this.skip = skip
    this.offsetType = offsetType
    this.maxHorizontalOffset = maxH
    this.maxVerticalOffset = maxV
    this.propertyNames = names
    this.propertyValues = values
    this.strides = new Array<number>(names.length)
    let count = 1
    for (let i = names.length - 1; i >= 0; i--) {
      this.strides[i] = count
      count *= values[i]!.length
    }
    this.stateCount = count
    this.base = base
  }

  propertyIndex(key: string): number {
    return this.propertyNames.indexOf(key)
  }
}

/** 面のます目 (256 ビット) を 32 ビットずつ 8 つ */
export type FaceMask = Uint32Array

const EMPTY_MASK = new Uint32Array(8)
const FULL_MASK = new Uint32Array(8).fill(0xFFFFFFFF)

export function isEmptyMask(m: FaceMask | null): boolean {
  if (!m) return true
  for (let i = 0; i < 8; i++) if (m[i]) return false
  return true
}

export function isFullMask(m: FaceMask | null): boolean {
  if (!m) return false
  for (let i = 0; i < 8; i++) if (m[i] !== 0xFFFFFFFF) return false
  return true
}

export function maskBit(m: FaceMask, bit: number): boolean {
  return ((m[bit >>> 5]! >>> (bit & 31)) & 1) !== 0
}

export class BlockData {
  private readonly blocks = new Map<string, BlockInfo>()
  private masks: FaceMask[] = [EMPTY_MASK, FULL_MASK]
  private faces: Int32Array = new Int32Array(0)
  private flagsTable: Int32Array = new Int32Array(0)
  private emission: Uint8Array = new Uint8Array(0)
  /** 液体: 0 なし、それ以外は (種類 1 水 / 2 溶岩) | 量 << 2 | 源 << 6 | 落下 << 7 */
  private fluids: Int32Array = new Int32Array(0)

  static parse(text: string): BlockData {
    const data = new BlockData()
    const faces: number[] = [], flags: number[] = [], emission: number[] = [], fluids: number[] = []
    let current: BlockInfo | null = null
    for (const raw of text.split('\n')) {
      const line = raw.trimEnd()
      if (!line || line[0] === '#') continue
      const parts = line.split(' ')
      switch (parts[0]) {
        case 'M': {
          const id = Number(parts[1])
          const hex = parts[2]!
          const m = new Uint32Array(8)
          for (let k = 0; k < 4; k++) {
            const chunk = hex.substring((3 - k) * 16, (4 - k) * 16)
            m[2 * k + 1] = Number.parseInt(chunk.substring(0, 8), 16) >>> 0
            m[2 * k] = Number.parseInt(chunk.substring(8, 16), 16) >>> 0
          }
          while (data.masks.length <= id) data.masks.push(EMPTY_MASK)
          data.masks[id] = m
          break
        }
        case 'B': {
          const names: string[] = [], values: string[][] = []
          for (let i = 6; i < parts.length; i++) {
            const eq = parts[i]!.indexOf('=')
            names.push(parts[i]!.substring(0, eq))
            values.push(parts[i]!.substring(eq + 1).split(','))
          }
          const skip = parts[2] === 'same' ? SKIP_SAME : parts[2] === 'bars' ? SKIP_BARS : parts[2] === 'liquid' ? SKIP_LIQUID : parts[2] === 'roots' ? SKIP_ROOTS : SKIP_NONE
          const offset = parts[3] === 'xz' ? OFFSET_XZ : parts[3] === 'xyz' ? OFFSET_XYZ : OFFSET_NONE
          current = new BlockInfo(parts[1]!, skip, offset, Number(parts[4]), Number(parts[5]), names, values, flags.length)
          data.blocks.set(current.name, current)
          break
        }
        case 'D':
          if (current) current.defaultIndex = Number(parts[1])
          break
        case 'S':
          for (let i = 0; i < 6; i++) faces.push(Number(parts[1 + i]))
          flags.push(Number(parts[7]))
          emission.push(Number(parts[8]))
          fluids.push(parseFluid(parts[9] ?? '-'))
          break
      }
    }
    data.faces = Int32Array.from(faces)
    data.flagsTable = Int32Array.from(flags)
    data.emission = Uint8Array.from(emission)
    data.fluids = Int32Array.from(fluids)
    return data
  }

  block(name: string): BlockInfo | undefined {
    return this.blocks.get(name)
  }

  /** 状態の表での番号。足りない性質は既定の値、知らない性質や値は無視する */
  stateIndex(block: BlockInfo, state: BlockState): number {
    let index = 0
    for (let p = 0; p < block.propertyNames.length; p++) {
      const value = state.get(block.propertyNames[p]!)
      const values = block.propertyValues[p]!
      let vi = value === null ? -1 : values.lastIndexOf(value)
      if (vi < 0) vi = Math.floor(block.defaultIndex / block.strides[p]!) % values.length
      index += vi * block.strides[p]!
    }
    return block.base + index
  }

  /** 足りない性質を既定の値で埋め、知らない性質を除いた状態 */
  complete(block: BlockInfo, state: BlockState): BlockState {
    const local = this.stateIndex(block, state) - block.base
    const m = new Map<string, string>()
    for (let p = 0; p < block.propertyNames.length; p++) {
      const values = block.propertyValues[p]!
      m.set(block.propertyNames[p]!, values[Math.floor(local / block.strides[p]!) % values.length]!)
    }
    return BlockState.of(block.name, m)
  }

  faceMask(stateIndex: number, direction: number): FaceMask {
    return this.masks[this.faces[stateIndex * 6 + direction]!] ?? EMPTY_MASK
  }

  flags(stateIndex: number): number {
    return this.flagsTable[stateIndex]!
  }

  lightEmission(stateIndex: number): number {
    return this.emission[stateIndex]!
  }

  fluid(stateIndex: number): number {
    return this.fluids[stateIndex]!
  }
}

function parseFluid(text: string): number {
  if (text === '-') return 0
  const type = text[0] === 'w' ? 1 : text[0] === 'l' ? 2 : 0
  let end = 1
  while (end < text.length && text.charCodeAt(end) >= 48 && text.charCodeAt(end) <= 57) end++
  const amount = Number(text.substring(1, end)) || 0
  const source = text.indexOf('s', end) >= 0
  const falling = text.indexOf('f', end) >= 0
  return type | amount << 2 | (source ? 1 << 6 : 0) | (falling ? 1 << 7 : 0)
}
