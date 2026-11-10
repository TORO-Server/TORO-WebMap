// 構造物のファイルを、ブロックの並びにする (MarumaSign 本体の StructureReader と同じ読み方)
//  - .schem (Sponge Schematic 1 - 3)、.litematic、.nbt (ストラクチャーブロック。26.1 からの書き方も)、.mcstructure (統合版)、
//    .schematic (MCEdit・古い WorldEdit・Schematica。1.12 までの番号)
// ここは Node の試験でも使うので、ブラウザーのものは使わない (古い番号と統合版の表は、呼ぶ側が渡す)
import { BlockState } from './block-state.ts'
import { compound, int, ints, list, NbtReader, str, type Compound, type Tag } from './nbt.ts'

/** 展開したあとの大きさの上限 (MarumaSign 本体と同じ) */
export const MAX_DECOMPRESSED = 96 * 1024 * 1024
/** 読むます目の数の上限 (これより大きい構造物は、何ブロックかおきに間引く。MarumaSign 本体と同じ) */
export const MAX_CELLS = 16 * 1024 * 1024
/** 1 つの領域で読むます目の数の上限 (壊れたファイルで長い時間かからないように。MarumaSign 本体と同じ) */
export const MAX_SCANNED = 128 * 1024 * 1024
const MAX_EDGE = 1 << 16
/** 読むブロックエンティティとエンティティの数の上限 (壊れたファイルで、メモリを使い切らないように) */
export const MAX_BLOCK_ENTITIES = 262144
export const MAX_ENTITY_RECORDS = 65536

/** 書いた形式 (Java 版の名前、1.12 までの番号、統合版) */
export type StructureSource = 'java' | 'legacy' | 'bedrock'

export interface StructureEntity {
  id: string
  /** 構造物の角を原点とした位置 (ブロック単位。間引く前の座標) */
  x: number
  y: number
  z: number
  nbt: Compound
}

/** ブロックの並びと、ブロックエンティティ・エンティティ・バイオーム。palette[0] は空気 */
export class Structure {
  readonly sizeX: number
  readonly sizeY: number
  readonly sizeZ: number
  /** 間引く前の大きさ */
  readonly fullX: number
  readonly fullY: number
  readonly fullZ: number
  /** 間引きの間隔 (1 なら全部。halve で 2 倍になる) */
  readonly step: number
  readonly blocks: Uint16Array
  readonly palette: string[]
  source: StructureSource = 'java'
  /** 書いたゲームのデータのバージョン (分からなければ 0) */
  dataVersion = 0
  /** ます目の番号 → ブロックエンティティ */
  readonly blockEntities = new Map<number, Compound>()
  readonly entities: StructureEntity[] = []
  biomePalette: string[] | null = null
  biomes: Uint16Array | null = null
  private readonly ids: Map<string, number>
  private readonly states: BlockState[] = []

  constructor(sizeX: number, sizeY: number, sizeZ: number, step = 1, palette?: string[]) {
    if (!(sizeX >= 0 && sizeY >= 0 && sizeZ >= 0) || sizeX > MAX_EDGE || sizeY > MAX_EDGE || sizeZ > MAX_EDGE) throw new Error('bad structure size')
    let s = step
    // 大きすぎるものは間引く
    while (Math.ceil(sizeX / s) * Math.ceil(sizeY / s) * Math.ceil(sizeZ / s) > MAX_CELLS) s++
    this.step = s
    this.fullX = sizeX
    this.fullY = sizeY
    this.fullZ = sizeZ
    this.sizeX = Math.ceil(sizeX / s)
    this.sizeY = Math.ceil(sizeY / s)
    this.sizeZ = Math.ceil(sizeZ / s)
    this.blocks = new Uint16Array(this.sizeX * this.sizeY * this.sizeZ)
    this.palette = palette ? palette.slice() : ['minecraft:air']
    this.ids = new Map(this.palette.map((p, i) => [p, i]))
  }

  /** ブロックの状態 (minecraft:name[key=value,...]) の番号 */
  paletteId(state: string | BlockState): number {
    const s = typeof state === 'string' ? normalizeState(state) : state.toString()
    if (isAir(s)) return 0
    let id = this.ids.get(s)
    if (id === undefined) {
      if (this.palette.length >= 65535) return 0
      id = this.palette.length
      this.palette.push(s)
      this.ids.set(s, id)
    }
    return id
  }

  /** パレットの番号の状態 */
  state(id: number): BlockState {
    let s = this.states[id]
    if (!s) this.states[id] = s = id === 0 ? BlockState.AIR : BlockState.parse(this.palette[id] ?? 'minecraft:air')
    return s
  }

  /** パレットの中身を差し替える (名前の付け替えなど) */
  replacePalette(id: number, state: BlockState): void {
    const old = this.palette[id]!
    if (this.ids.get(old) === id) this.ids.delete(old)
    const text = state.toString()
    this.palette[id] = text
    this.states[id] = state
    if (!this.ids.has(text)) this.ids.set(text, id)
  }

  index(x: number, y: number, z: number): number {
    return (y * this.sizeZ + z) * this.sizeX + x
  }

  /** 元の座標で置く (間引くときは、間隔の倍数のところだけ) */
  set(x: number, y: number, z: number, id: number): void {
    const s = this.step
    if (x < 0 || y < 0 || z < 0 || x >= this.fullX || y >= this.fullY || z >= this.fullZ || x % s || y % s || z % s) return
    const gx = x / s, gy = y / s, gz = z / s
    if (gx >= this.sizeX || gy >= this.sizeY || gz >= this.sizeZ) return
    this.blocks[this.index(gx, gy, gz)] = id
  }

  setBlockEntity(x: number, y: number, z: number, nbt: Compound): void {
    const s = this.step
    if (!Number.isInteger(x) || !Number.isInteger(y) || !Number.isInteger(z)) return
    if (x < 0 || y < 0 || z < 0 || x >= this.fullX || y >= this.fullY || z >= this.fullZ || x % s || y % s || z % s) return
    if (this.blockEntities.size >= MAX_BLOCK_ENTITIES) return
    this.blockEntities.set(this.index(x / s, y / s, z / s), nbt)
  }

  addEntity(id: string, x: number, y: number, z: number, nbt: Compound): void {
    if (this.entities.length >= MAX_ENTITY_RECORDS || !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return
    this.entities.push({ id, x, y, z, nbt })
  }

  /** ます目のバイオームの名前。分からなければ null */
  biome(index: number): string | null {
    if (!this.biomes || !this.biomePalette) return null
    return this.biomePalette[this.biomes[index]!] ?? null
  }

  get(x: number, y: number, z: number): number {
    if (x < 0 || y < 0 || z < 0 || x >= this.sizeX || y >= this.sizeY || z >= this.sizeZ) return 0
    return this.blocks[this.index(x, y, z)]!
  }

  /** 2 x 2 x 2 のます目を 1 つにまとめる。中の空気でないブロックのうち最も多いもの (MarumaSign 本体の halve と同じ) */
  halve(): Structure {
    const r = new Structure(Math.ceil(this.sizeX / 2), Math.ceil(this.sizeY / 2), Math.ceil(this.sizeZ / 2), 1, this.palette)
    ;(r as { step: number }).step = this.step * 2
    ;(r as { fullX: number }).fullX = this.fullX
    ;(r as { fullY: number }).fullY = this.fullY
    ;(r as { fullZ: number }).fullZ = this.fullZ
    r.source = this.source
    r.dataVersion = this.dataVersion
    for (let i = 0; i < this.states.length; i++) if (this.states[i]) r.states[i] = this.states[i]!
    r.entities.push(...this.entities)
    r.biomePalette = this.biomePalette
    if (this.biomes) r.biomes = new Uint16Array(r.blocks.length)
    const ids = new Array<number>(8)
    const indices = new Array<number>(8)
    for (let y = 0; y < r.sizeY; y++) {
      for (let z = 0; z < r.sizeZ; z++) {
        for (let x = 0; x < r.sizeX; x++) {
          let count = 0
          for (let d = 0; d < 8; d++) {
            const sx = x * 2 + (d & 1), sy = y * 2 + ((d >> 1) & 1), sz = z * 2 + ((d >> 2) & 1)
            if (sx >= this.sizeX || sy >= this.sizeY || sz >= this.sizeZ) continue
            const index = this.index(sx, sy, sz)
            const id = this.blocks[index]!
            if (!id) continue
            ids[count] = id
            indices[count] = index
            count++
          }
          if (!count) continue
          let best = 0, bestCount = 0
          for (let i = 0; i < count; i++) {
            let same = 0
            for (let j = 0; j < count; j++) if (ids[j] === ids[i]) same++
            if (same > bestCount) {
              bestCount = same
              best = i
            }
          }
          const target = r.index(x, y, z)
          r.blocks[target] = ids[best]!
          const entity = this.blockEntities.get(indices[best]!)
          if (entity) r.blockEntities.set(target, entity)
          if (this.biomes && r.biomes) r.biomes[target] = this.biomes[indices[best]!]!
        }
      }
    }
    return r
  }
}

const AIR = new Set(['minecraft:air', 'minecraft:cave_air', 'minecraft:void_air', 'minecraft:structure_void'])

export function isAir(state: string): boolean {
  const b = state.indexOf('[')
  return AIR.has(b < 0 ? state : state.substring(0, b))
}

/** 名前に名前空間を付け、状態を名前の順に並べる */
export function normalizeState(state: string): string {
  const b = state.indexOf('[')
  let name = (b < 0 ? state : state.substring(0, b)).trim().toLowerCase()
  if (name.indexOf(':') < 0) name = 'minecraft:' + name
  if (b < 0) return name
  const props = state.substring(b + 1, state.lastIndexOf(']') > b ? state.lastIndexOf(']') : state.length)
    .split(',').map(p => p.trim()).filter(p => p.indexOf('=') > 0)
    .map(p => [p.substring(0, p.indexOf('=')).trim(), p.substring(p.indexOf('=') + 1).trim()] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)
  return props.length ? name + '[' + props.map(p => p[0] + '=' + p[1]).join(',') + ']' : name
}

function stateOf(name: string, props: Compound | Map<string, Tag>): string {
  const parts: string[] = []
  for (const [k, v] of props) parts.push(k + '=' + String(typeof v === 'bigint' ? v.toString() : v))
  return parts.length ? name + '[' + parts.join(',') + ']' : name
}

/** {Name, Properties} (26.1 からは {id, properties}) の形のブロックの状態 */
function stateFromNbt(entry: Compound): string {
  const name = entry.has('Name') ? str(entry.get('Name'), 'minecraft:air') : str(entry.get('id'), 'minecraft:air')
  const props = entry.has('Properties') ? compound(entry.get('Properties')) : compound(entry.get('properties'))
  return stateOf(name, props)
}

/** 古い番号と統合版のブロックを、Java 版の状態に直す表 (MarumaSign 本体の BlockTables と同じもの) */
export interface BlockTables {
  /** 1.12 までの番号とデータ値から状態。知らなければ null */
  legacy(id: number, data: number): string | null
  /** 1.12 の名前から番号。知らなければ -1 */
  legacyId(name: string): number
  /** 統合版の名前と状態から Java 版の状態。知らなければ null */
  bedrock(name: string, states: Map<string, string>): string | null
}

/** 表のテキスト (legacy.txt と bedrock.txt) から BlockTables を作る */
export function parseTables(legacyText: string, bedrockText: string): BlockTables {
  const legacy = new Map<number, string>()
  const legacyIds = new Map<string, number>()
  for (const line of legacyText.split('\n')) {
    if (!line || line[0] === '#') continue
    const parts = line.trim().split(' ')
    if (parts[0] === 'N') {
      legacyIds.set(parts[1]!, Number(parts[2]))
      continue
    }
    const [id, data] = parts[0]!.split(':').map(Number) as [number, number]
    legacy.set((id << 4) | data, normalizeState(parts[1]!))
  }
  const bedrock = new Map<string, string>()
  const byName = new Map<string, string[]>()
  for (const line of bedrockText.split('\n')) {
    if (!line || line[0] === '#') continue
    const space = line.indexOf(' ')
    const key = normalizeState(line.substring(0, space))
    bedrock.set(key, normalizeState(line.substring(space + 1).trim()))
    const name = key.split('[')[0]!
    let l = byName.get(name)
    if (!l) byName.set(name, l = [])
    l.push(key)
  }
  return {
    legacy(id, data) {
      return legacy.get((id << 4) | (data & 15)) ?? legacy.get(id << 4) ?? null
    },
    legacyId(name) {
      return legacyIds.get(normalizeState(name)) ?? -1
    },
    bedrock(name, states) {
      const n = normalizeState(name)
      const key = normalizeState(stateOf(n, states))
      const exact = bedrock.get(key)
      if (exact) return exact
      const candidates = byName.get(n)
      if (!candidates) return null
      // 同じ名前で値が最も多く一致するもの
      let best: string | null = null, bestScore = -Infinity
      for (const c of candidates) {
        let score = 0
        const b = c.indexOf('[')
        if (b >= 0) {
          for (const p of c.substring(b + 1, c.length - 1).split(',')) {
            const [k, v] = p.split('=') as [string, string]
            const have = states.get(k)
            if (have === v) score += 2
            else if (have === undefined) score -= 1
          }
        }
        if (score > bestScore) {
          bestScore = score
          best = c
        }
      }
      return best ? bedrock.get(best) ?? null : null
    },
  }
}

// ---------------------------------------------------------------- 形式ごと

/**
 * NBT のバイト列 (展開したもの) を構造物にする。
 * @param tables 古い番号 (.schematic) と統合版 (.mcstructure) の表。必要になったときだけ呼ぶ
 */
export async function readStructure(data: Uint8Array, tables: () => Promise<BlockTables>): Promise<Structure> {
  let root: Compound
  let little = false
  try {
    root = new NbtReader(data, false).readRoot().value
    if (looksBedrock(root)) throw new Error('bedrock')
  }
  catch {
    root = new NbtReader(data, true).readRoot().value
    little = true
  }
  if (little || looksBedrock(root)) return bedrock(root, await tables())
  const schematic = root.get('Schematic')
  // Sponge Schematic バージョン 3 は、名前のない複合タグの中に Schematic がある
  if (schematic instanceof Map) return sponge(schematic)
  if (root.has('Regions') && root.has('Version')) return litematic(root)
  if (root.has('Blocks') && root.has('Width') && root.get('Blocks') instanceof Int8Array) return mcedit(root, await tables())
  if (root.has('Palette') || root.has('BlockData')) return sponge(root)
  if (root.get('Blocks') instanceof Map && int(root.get('Version')) >= 3) return sponge(root)
  if (root.has('blocks') && root.has('size')) return template(root)
  throw new Error('Unknown structure format')
}

function looksBedrock(root: Compound): boolean {
  return root.has('structure') && root.has('size') && root.has('format_version')
}

function bytes(v: Tag | undefined): Int8Array | null {
  return v instanceof Int8Array ? v : null
}

/** 数の並び (リスト、int の配列、long の配列)。なければ null */
export function doubles(v: Tag | undefined): number[] | null {
  if (v instanceof Int32Array || v instanceof Int8Array) return Array.from(v)
  if (v instanceof BigInt64Array) return Array.from(v, x => Number(x))
  if (Array.isArray(v)) {
    const out: number[] = []
    for (const x of v) {
      if (typeof x === 'number') out.push(x)
      else if (typeof x === 'bigint') out.push(Number(x))
      else return null
    }
    return out
  }
  return null
}

/** 可変長の整数 (7 ビットずつ) を順に読む。壊れていれば -1 */
function varints(data: Int8Array): () => number {
  let p = 0
  return () => {
    let value = 0, shift = 0, b: number
    do {
      if (p >= data.length) return -1
      b = data[p++]! & 0xFF
      value |= (b & 0x7F) << shift
      shift += 7
      if (shift > 35) return -1
    } while (b & 0x80)
    return value
  }
}

function sponge(s: Compound): Structure {
  const version = int(s.get('Version'), 1)
  const width = int(s.get('Width')) & 0xFFFF, height = int(s.get('Height')) & 0xFFFF, length = int(s.get('Length')) & 0xFFFF
  const st = new Structure(width, height, length)
  st.source = 'java'
  // バージョン 1 にはデータのバージョンがない (1.13 のころの形式)
  st.dataVersion = int(s.get('DataVersion'), 1519)
  const blocks = version >= 3 ? compound(s.get('Blocks')) : s
  const palette = compound(blocks.get('Palette'))
  const data = bytes(blocks.get(version >= 3 ? 'Data' : 'BlockData'))
  if (!data) throw new Error('Schematic has no block data')
  let maxIndex = 0
  for (const v of palette.values()) maxIndex = Math.max(maxIndex, int(v))
  if (maxIndex >= Math.max(1024, palette.size * 4)) throw new Error('Invalid schematic palette index')
  const mapping = new Int32Array(maxIndex + 1)
  for (const [k, v] of palette) if (int(v) >= 0) mapping[int(v)] = st.paletteId(k)
  // 番号は可変長の整数 (7 ビットずつ)。並びは x が最も速く、次に z、最後に y
  let p = 0, index = 0
  const total = width * height * length
  const wl = width * length
  while (index < total && p < data.length) {
    let value = 0, shift = 0, b: number
    do {
      if (p >= data.length) throw new Error('Truncated block data')
      b = data[p++]! & 0xFF
      value |= (b & 0x7F) << shift
      shift += 7
      if (shift > 35) throw new Error('Invalid block data')
    } while (b & 0x80)
    if (value >= 0 && value < mapping.length) {
      const x = index % width, z = Math.floor(index / width) % length, y = Math.floor(index / wl)
      st.set(x, y, z, mapping[value]!)
    }
    index++
  }
  // ブロックエンティティ (バージョン 1 は TileEntities、2 は BlockEntities、3 は Blocks の中の BlockEntities)
  let entities = list(blocks.get('BlockEntities'))
  if (!entities.length) entities = list(s.get('TileEntities'))
  for (const item of entities) {
    const entity = compound(item)
    const pos = ints(entity.get('Pos'))
    if (!pos || pos.length < 3) continue
    let nbt = entity
    if (version >= 3 && entity.get('Data') instanceof Map) {
      nbt = new Map(compound(entity.get('Data')))
      nbt.set('id', str(entity.get('Id')))
    }
    else if (!entity.has('id')) {
      nbt = new Map(entity)
      nbt.set('id', str(entity.get('Id')))
    }
    st.setBlockEntity(pos[0]!, pos[1]!, pos[2]!, nbt)
  }
  for (const item of list(s.get('Entities'))) {
    const entity = compound(item)
    const pos = doubles(entity.get('Pos'))
    if (!pos || pos.length < 3) continue
    const nbt = version >= 3 && entity.get('Data') instanceof Map ? compound(entity.get('Data')) : entity
    st.addEntity(str(entity.get('Id'), str(nbt.get('id'))), pos[0]!, pos[1]!, pos[2]!, nbt)
  }
  readSpongeBiomes(st, version, version >= 3 ? compound(s.get('Biomes')) : s, width, height, length)
  return st
}

function readSpongeBiomes(st: Structure, version: number, source: Compound, width: number, height: number, length: number): void {
  const palette = compound(source.get(version >= 3 ? 'Palette' : 'BiomePalette'))
  const data = bytes(source.get(version >= 3 ? 'Data' : 'BiomeData'))
  if (!palette.size || !data || palette.size > 4096) return
  const names: string[] = []
  const remap = new Map<number, number>()
  for (const [k, v] of palette) {
    remap.set(int(v), names.length)
    names.push(k.indexOf(':') >= 0 ? k.trim() : 'minecraft:' + k.trim())
  }
  const biomes = new Uint16Array(st.blocks.length)
  // バージョン 2 は x, z の 2 次元、バージョン 3 は 3 次元
  const total = version >= 3 ? width * height * length : width * length
  const next = varints(data)
  const step = st.step
  for (let index = 0; index < total; index++) {
    const value = next()
    if (value < 0) break
    const mapped = remap.get(value)
    if (mapped === undefined) continue
    const x = index % width, z = Math.floor(index / width) % length
    if (x % step || z % step) continue
    if (version >= 3) {
      const y = Math.floor(index / (width * length))
      if (y % step) continue
      biomes[st.index(x / step, y / step, z / step)] = mapped
    }
    else {
      for (let y = 0; y < st.sizeY; y++) biomes[st.index(x / step, y, z / step)] = mapped
    }
  }
  st.biomePalette = names
  st.biomes = biomes
}

function litematic(root: Compound): Structure {
  const regions = compound(root.get('Regions'))
  if (!regions.size) throw new Error('Litematic has no regions')
  const regionMin = (r: Compound): number[] => {
    const pos = compound(r.get('Position')), size = compound(r.get('Size'))
    return ['x', 'y', 'z'].map((a) => {
      const p = int(pos.get(a)), s = int(size.get(a))
      return s < 0 ? p + s + 1 : p
    })
  }
  const regionSize = (r: Compound): number[] => ['x', 'y', 'z'].map(a => Math.abs(int(compound(r.get('Size')).get(a))))
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]
  for (const v of regions.values()) {
    const r = compound(v)
    const m = regionMin(r), s = regionSize(r)
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i]!, m[i]!)
      max[i] = Math.max(max[i]!, m[i]! + s[i]!)
    }
  }
  const st = new Structure(max[0]! - min[0]!, max[1]! - min[1]!, max[2]! - min[2]!)
  st.source = 'java'
  st.dataVersion = int(root.get('MinecraftDataVersion'), 1631)
  for (const v of regions.values()) {
    const r = compound(v)
    const m = regionMin(r), size = regionSize(r)
    const [ox, oy, oz] = [m[0]! - min[0]!, m[1]! - min[1]!, m[2]! - min[2]!]
    const paletteList = list(r.get('BlockStatePalette'))
    const mapping = paletteList.map(e => st.paletteId(stateFromNbt(compound(e))))
    const states = r.get('BlockStates')
    const longs = states instanceof BigInt64Array ? states : new BigInt64Array(0)
    // 1 つの番号のビット数。番号は long の境目をまたいで詰められている
    const bits = Math.max(2, 32 - Math.clz32(Math.max(1, paletteList.length) - 1))
    const total = size[0]! * size[1]! * size[2]!
    if (total > MAX_SCANNED) throw new Error('Litematic region is too large')
    if (Math.ceil(total * bits / 64) > longs.length) throw new Error('Litematic block data is too short')
    // 64 ビットを 32 ビットずつに分けて読む (bigint は遅いので)
    const words = new Uint32Array(longs.buffer, longs.byteOffset, longs.length * 2)
    const mask = (1 << bits) - 1
    const read = (bit: number): number => {
      const w = bit >>> 5, o = bit & 31
      let value = words[w]! >>> o
      if (o + bits > 32) value |= words[w + 1]! << (32 - o)
      return value & mask
    }
    const step = st.step
    for (let y = 0; y < size[1]!; y++) {
      if ((oy + y) % step) continue
      for (let z = 0; z < size[2]!; z++) {
        if ((oz + z) % step) continue
        for (let x = 0; x < size[0]!; x++) {
          const value = read(((y * size[2]! + z) * size[0]! + x) * bits)
          if (value < mapping.length) st.set(ox + x, oy + y, oz + z, mapping[value]!)
        }
      }
    }
    for (const item of list(r.get('TileEntities'))) {
      const e = compound(item)
      st.setBlockEntity(ox + int(e.get('x')), oy + int(e.get('y')), oz + int(e.get('z')), e)
    }
    // エンティティの位置は、最も小さい角ではなく、領域の位置 (Position) からの位置
    const position = compound(r.get('Position'))
    const ex = int(position.get('x')) - min[0]!, ey = int(position.get('y')) - min[1]!, ez = int(position.get('z')) - min[2]!
    for (const item of list(r.get('Entities'))) {
      const e = compound(item)
      const pos = doubles(e.get('Pos'))
      if (!pos || pos.length < 3) continue
      st.addEntity(str(e.get('id')), ex + pos[0]!, ey + pos[1]!, ez + pos[2]!, e)
    }
  }
  return st
}

function template(root: Compound): Structure {
  const size = ints(root.get('size'))
  if (!size || size.length < 3) throw new Error('Structure has no size')
  const st = new Structure(size[0]!, size[1]!, size[2]!)
  st.source = 'java'
  st.dataVersion = int(root.get('DataVersion'), 1343)
  let paletteList = list(root.get('palette'))
  // 置くたびに選ばれる複数のパレットがある場合は、最初のもの
  if (!paletteList.length) paletteList = list(list(root.get('palettes'))[0])
  const mapping = paletteList.map(e => st.paletteId(stateFromNbt(compound(e))))
  for (const item of list(root.get('blocks'))) {
    const block = compound(item)
    const pos = ints(block.get('pos'))
    const state = int(block.get('state'), -1)
    if (!pos || pos.length < 3 || state < 0 || state >= mapping.length) continue
    st.set(pos[0]!, pos[1]!, pos[2]!, mapping[state]!)
    if (block.get('nbt') instanceof Map) st.setBlockEntity(pos[0]!, pos[1]!, pos[2]!, compound(block.get('nbt')))
  }
  for (const item of list(root.get('entities'))) {
    const entity = compound(item)
    const pos = doubles(entity.get('pos'))
    const nbt = compound(entity.get('nbt'))
    if (!pos || pos.length < 3) continue
    st.addEntity(str(nbt.get('id')), pos[0]!, pos[1]!, pos[2]!, nbt)
  }
  return st
}

function bedrock(root: Compound, tables: BlockTables): Structure {
  const size = ints(root.get('size'))
  if (!size || size.length < 3) throw new Error('Structure has no size')
  const [sx, sy, sz] = size as [number, number, number]
  const st = new Structure(sx, sy, sz)
  st.source = 'bedrock'
  const body = compound(root.get('structure'))
  const layers = list(body.get('block_indices'))
  const paletteRoot = compound(compound(body.get('palette')).get('default'))
  const palette = list(paletteRoot.get('block_palette'))
  const water: boolean[] = []
  const javaStates: string[] = []
  const mapping = palette.map((item, i) => {
    const e = compound(item)
    let name = str(e.get('name'), 'minecraft:air')
    if (name.indexOf(':') < 0) name = 'minecraft:' + name
    const states = new Map<string, string>()
    for (const [k, v] of compound(e.get('states'))) states.set(k, String(typeof v === 'bigint' ? v.toString() : v))
    // 表にないブロックは、同じ名前の Java 版のブロックとして扱う
    const java = tables.bedrock(name, states) ?? name
    javaStates[i] = java
    water[i] = name === 'minecraft:water' || name === 'minecraft:flowing_water'
    return st.paletteId(java)
  })
  const primary = ints(layers[0])
  const secondary = ints(layers[1])
  if (!primary) throw new Error('Structure has no blocks')
  const cells = Math.min(sx * sy * sz, primary.length)
  const logged = new Map<number, number>()
  for (let index = 0; index < cells; index++) {
    // 並びは z が最も速く、次に y、最後に x
    const z = index % sz, y = Math.floor(index / sz) % sy, x = Math.floor(index / (sz * sy))
    const id = primary[index]!
    if (id < 0 || id >= mapping.length) continue
    let pid = mapping[id]!
    // 2 層目の水は、1 層目のブロックが水に浸かっていることを表す
    const second = secondary ? secondary[index] : undefined
    if (second !== undefined && second >= 0 && second < water.length && water[second]) {
      if (pid === 0) pid = mapping[second]!
      else {
        let l = logged.get(id)
        if (l === undefined) {
          l = st.paletteId(BlockState.parse(javaStates[id]!).with('waterlogged', 'true'))
          logged.set(id, l)
        }
        pid = l
      }
    }
    st.set(x, y, z, pid)
  }
  // ブロックエンティティは、ます目の番号 (上と同じ並び) ごとに書かれている
  for (const [key, value] of compound(paletteRoot.get('block_position_data'))) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0) continue
    const data = compound(compound(value).get('block_entity_data'))
    if (!data.size) continue
    st.setBlockEntity(Math.floor(index / (sz * sy)), Math.floor(index / sz) % sy, index % sz, data)
  }
  const origin = ints(root.get('structure_world_origin'))
  const [wx, wy, wz] = origin && origin.length >= 3 ? origin : [0, 0, 0]
  for (const item of list(body.get('entities'))) {
    const entity = compound(item)
    const pos = doubles(entity.get('Pos'))
    if (!pos || pos.length < 3) continue
    st.addEntity(str(entity.get('identifier')), pos[0]! - wx!, pos[1]! - wy!, pos[2]! - wz!, entity)
  }
  return st
}

function mcedit(root: Compound, tables: BlockTables): Structure {
  const width = int(root.get('Width')) & 0xFFFF, height = int(root.get('Height')) & 0xFFFF, length = int(root.get('Length')) & 0xFFFF
  const materials = str(root.get('Materials'), 'Alpha')
  if (materials !== 'Alpha') throw new Error('Unsupported schematic materials: ' + materials)
  const blocks = bytes(root.get('Blocks'))
  const data = bytes(root.get('Data'))
  const add = bytes(root.get('AddBlocks')) ?? bytes(root.get('Add'))
  const total = width * height * length
  if (!blocks || blocks.length < total) throw new Error('Schematic block data is too short')
  const st = new Structure(width, height, length)
  st.source = 'legacy'
  // 番号を名前で書いたもの (Schematica と MCEdit 2)。標準の番号に付け替える
  const remap = new Map<number, number>()
  for (const [name, v] of compound(root.get('SchematicaMapping'))) {
    const standard = tables.legacyId(name), id = int(v, -1)
    if (id >= 0 && standard >= 0 && standard !== id) remap.set(id, standard)
  }
  for (const [k, v] of compound(root.get('BlockIDs'))) {
    const standard = tables.legacyId(str(v)), id = Number(k)
    if (Number.isInteger(id) && id >= 0 && standard >= 0 && standard !== id) remap.set(id, standard)
  }
  const cache = new Map<number, number>()
  const wl = width * length
  for (let index = 0; index < total; index++) {
    let id = blocks[index]! & 0xFF
    if (add && (index >> 1) < add.length) id |= (index & 1) === 0 ? (add[index >> 1]! & 0x0F) << 8 : (add[index >> 1]! & 0xF0) << 4
    if (id === 0) continue
    id = remap.get(id) ?? id
    const meta = data && index < data.length ? data[index]! & 0x0F : 0
    const key = (id << 4) | meta
    let pid = cache.get(key)
    if (pid === undefined) {
      const state = tables.legacy(id, meta)
      pid = state ? st.paletteId(state) : 0
      cache.set(key, pid)
    }
    if (!pid) continue
    st.set(index % width, Math.floor(index / wl), Math.floor(index / width) % length, pid)
  }
  for (const item of list(root.get('TileEntities'))) {
    const e = compound(item)
    st.setBlockEntity(int(e.get('x')), int(e.get('y')), int(e.get('z')), e)
  }
  for (const item of list(root.get('Entities'))) {
    const e = compound(item)
    const pos = doubles(e.get('Pos'))
    if (!pos || pos.length < 3) continue
    st.addEntity(str(e.get('id')), pos[0]!, pos[1]!, pos[2]!, e)
  }
  return st
}
