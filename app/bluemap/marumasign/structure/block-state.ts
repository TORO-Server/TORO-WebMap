// ブロックの状態 (MarumaSign 本体の BlockState) と、方向の番号 (StructureFixer と同じ: 下、上、北、南、西、東)
// ここは何も import しない (Node の試験と Worker の両方で使う)

export const DOWN = 0, UP = 1, NORTH = 2, SOUTH = 3, WEST = 4, EAST = 5
export const DX = [0, 0, 0, 0, -1, 1]
export const DY = [-1, 1, 0, 0, 0, 0]
export const DZ = [0, 0, -1, 1, 0, 0]
export const OPPOSITE = [UP, DOWN, SOUTH, NORTH, EAST, WEST]
export const NAMES = ['down', 'up', 'north', 'south', 'west', 'east']
/** 水平の方向を時計回りに回したもの (上から見て) */
export const CLOCKWISE = [DOWN, UP, EAST, WEST, NORTH, SOUTH]
export const COUNTER_CLOCKWISE = [DOWN, UP, WEST, EAST, SOUTH, NORTH]
export const HORIZONTAL = [NORTH, SOUTH, WEST, EAST]
export const DYE_COLORS = ['white', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'pink', 'gray',
  'light_gray', 'cyan', 'purple', 'blue', 'brown', 'green', 'red', 'black']

/** 方向の名前 (up / top など) の番号。知らなければ -1 */
export function direction(name: string | null | undefined): number {
  switch (name) {
    case 'down': case 'bottom': return DOWN
    case 'up': case 'top': return UP
    case 'north': return NORTH
    case 'south': return SOUTH
    case 'west': return WEST
    case 'east': return EAST
    default: return -1
  }
}

/** 名前空間がなければ minecraft: を付ける */
export function namespaced(name: string): string {
  const t = name.trim()
  return t.indexOf(':') >= 0 ? t : 'minecraft:' + t
}

/**
 * ブロックの名前と性質 (例: minecraft:oak_stairs[facing=east,half=bottom])。性質は名前の順に並べて持つ。作ったあとは変えない
 */
export class BlockState {
  static readonly AIR = new BlockState('minecraft:air', [], [])
  readonly name: string
  readonly keys: readonly string[]
  readonly values: readonly string[]
  private text: string | null = null

  constructor(name: string, keys: readonly string[], values: readonly string[]) {
    this.name = name
    this.keys = keys
    this.values = values
  }

  static of(name: string, props: Map<string, string> | Record<string, string>): BlockState {
    const entries = props instanceof Map ? Array.from(props) : Object.entries(props)
    entries.sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
    return new BlockState(namespaced(name), entries.map(e => e[0]), entries.map(e => e[1]))
  }

  /** "名前[性質=値,...]" から作る */
  static parse(text: string): BlockState {
    const open = text.indexOf('[')
    if (open < 0) return new BlockState(namespaced(text), [], [])
    const close = text.lastIndexOf(']')
    const body = text.substring(open + 1, close > open ? close : text.length)
    const props = new Map<string, string>()
    for (const pair of body.split(',')) {
      const eq = pair.indexOf('=')
      if (eq <= 0) continue
      props.set(pair.substring(0, eq).trim(), pair.substring(eq + 1).trim())
    }
    return BlockState.of(text.substring(0, open), props)
  }

  get(key: string): string | null {
    for (let i = 0; i < this.keys.length; i++) if (this.keys[i] === key) return this.values[i]!
    return null
  }

  properties(): Map<string, string> {
    const m = new Map<string, string>()
    for (let i = 0; i < this.keys.length; i++) m.set(this.keys[i]!, this.values[i]!)
    return m
  }

  /** 性質を 1 つ変えたもの (value が null なら除く) */
  with(key: string, value: string | null): BlockState {
    const m = this.properties()
    if (value === null) m.delete(key)
    else m.set(key, value)
    return BlockState.of(this.name, m)
  }

  withName(name: string): BlockState {
    return new BlockState(namespaced(name), this.keys, this.values)
  }

  /** 名前空間を除いた名前 */
  get path(): string {
    const c = this.name.indexOf(':')
    return c >= 0 ? this.name.substring(c + 1) : this.name
  }

  isAir(): boolean {
    return this.name === 'minecraft:air' || this.name === 'minecraft:cave_air' || this.name === 'minecraft:void_air'
  }

  toString(): string {
    if (this.text !== null) return this.text
    let s = this.name
    if (this.keys.length) {
      s += '['
      for (let i = 0; i < this.keys.length; i++) s += (i ? ',' : '') + this.keys[i] + '=' + this.values[i]
      s += ']'
    }
    this.text = s
    return s
  }

  equals(other: BlockState): boolean {
    return this.toString() === other.toString()
  }
}
