// 読み込んだ構造物のブロックを、表示に使う Minecraft のバージョン (BlockData の版) の状態にそろえる (MarumaSign 本体の StructureFixer と同じ)
//  - 名前の変わったブロックの付け替え、性質の値の変わったものの直し
//  - 1.12 までの形式で、ブロックエンティティに書かれていた色や種類 (ベッド、旗、頭、植木鉢) をブロックに移す
//  - 1.12 までの形式と統合版で、まわりのブロックで決まる形 (フェンスのつながり、階段の角など) を計算する
//  - 足りない性質を既定の値で埋める
// ここは Node の試験でも使う
import { type BlockData, SKIP_BARS, SOLID_RENDER, STURDY_SHIFT } from './block-data.ts'
import {
  BlockState, CLOCKWISE, COUNTER_CLOCKWISE, DOWN, DX, DYE_COLORS, DZ, EAST, HORIZONTAL, NAMES, NORTH, OPPOSITE, SOUTH, UP, WEST,
} from './block-state.ts'
import type { BlockTables, Structure } from './formats.ts'
import { type Compound, compound, int, str, type Tag } from './nbt.ts'

const SIGNAL_SOURCES = new Set(['redstone_torch', 'redstone_wall_torch', 'lever', 'redstone_block', 'daylight_detector',
  'comparator', 'trapped_chest', 'tripwire_hook', 'detector_rail', 'sculk_sensor', 'calibrated_sculk_sensor',
  'lectern', 'target', 'lightning_rod', 'redstone_wire', 'observer', 'repeater'].map(n => 'minecraft:' + n))

function num(v: Tag | undefined, def: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return def
}

function dirOf(name: string | null): number {
  return name === null ? -1 : NAMES.indexOf(name)
}

export function fixStructure(structure: Structure, data: BlockData, tables: BlockTables | null): void {
  new Fixer(structure, data, tables).run()
}

class Fixer {
  private readonly st: Structure
  private readonly data: BlockData
  private readonly tables: BlockTables | null
  private stateIndex: number[] = []

  constructor(st: Structure, data: BlockData, tables: BlockTables | null) {
    this.st = st
    this.data = data
    this.tables = tables
  }

  run(): void {
    this.renamePalette()
    if (this.st.source === 'legacy') this.applyLegacyBlockEntities()
    if (this.st.source === 'bedrock') this.applyBedrockBlockEntities()
    this.completePalette()
    if (this.st.source !== 'java') this.updateShapes()
  }

  // ---------- 名前と値 ----------

  private renamePalette(): void {
    for (let id = 1; id < this.st.palette.length; id++) {
      const original = this.st.state(id)
      const renamed = this.rename(original)
      if (renamed !== original) this.st.replacePalette(id, renamed)
    }
  }

  private rename(state: BlockState): BlockState {
    const name = state.name
    if (name === 'minecraft:grass') return state.withName('minecraft:short_grass')
    if (name === 'minecraft:grass_path') return state.withName('minecraft:dirt_path')
    if (name === 'minecraft:sign') return state.withName('minecraft:oak_sign')
    if (name === 'minecraft:wall_sign') return state.withName('minecraft:oak_wall_sign')
    if (name === 'minecraft:chain') return state.withName('minecraft:iron_chain')
    // 1.14 より前の stone_slab は、今の smooth_stone_slab
    if (name === 'minecraft:stone_slab' && (this.st.source === 'legacy' || (this.st.source === 'java' && this.st.dataVersion < 1901))) {
      return state.withName('minecraft:smooth_stone_slab')
    }
    // 1.17 より前の大釜は、水の量を持っていた
    if (name === 'minecraft:cauldron') {
      const level = state.get('level')
      if (level !== null && level !== '0') return BlockState.parse('minecraft:water_cauldron[level=' + level + ']')
    }
    // 1.16 より前の壁は、つながりを true / false で持っていた
    if (state.get('up') !== null && name.endsWith('_wall')) {
      let result = state
      for (const d of HORIZONTAL) {
        const value = state.get(NAMES[d]!)
        if (value === 'true') result = result.with(NAMES[d]!, 'low')
        else if (value === 'false') result = result.with(NAMES[d]!, 'none')
      }
      return result
    }
    return state
  }

  // 足りない性質を既定の値で埋める (表にないブロックはそのまま)
  private completePalette(): void {
    this.stateIndex = []
    for (let id = 0; id < this.st.palette.length; id++) {
      const state = this.st.state(id)
      const block = this.data.block(state.name)
      if (!block) {
        this.stateIndex[id] = -1
        continue
      }
      const complete = this.data.complete(block, state)
      if (!complete.equals(state)) this.st.replacePalette(id, complete)
      this.stateIndex[id] = this.data.stateIndex(block, complete)
    }
  }

  private paletteId(state: BlockState): number {
    const before = this.st.palette.length
    const id = this.st.paletteId(state)
    if (id >= before && this.stateIndex.length) {
      const block = this.data.block(state.name)
      this.stateIndex[id] = block ? this.data.stateIndex(block, state) : -1
    }
    return id
  }

  private setId(index: number, state: BlockState): void {
    this.st.blocks[index] = this.paletteId(state)
  }

  // ---------- 1.12 までのブロックエンティティ ----------

  private applyLegacyBlockEntities(): void {
    for (const [index, nbt] of this.st.blockEntities) {
      const state = this.st.state(this.st.blocks[index]!)
      const id = str(nbt.get('id')).toLowerCase()
      const path = state.path
      let changed: BlockState | null = null
      if (path.endsWith('_bed') && id.endsWith('bed')) {
        changed = state.withName('minecraft:' + DYE_COLORS[int(nbt.get('color'), 14) & 15] + '_bed')
      }
      else if (path.endsWith('_banner') && id.endsWith('banner')) {
        // 1.12 の旗の色は、染料の番号 (0 が黒) で書かれている
        const color = DYE_COLORS[15 - (int(nbt.get('Base'), 0) & 15)]!
        changed = state.withName('minecraft:' + color + (path.endsWith('_wall_banner') ? '_wall_banner' : '_banner'))
      }
      else if (path.endsWith('_skull') || path.endsWith('_head')) {
        if (id.endsWith('skull')) changed = legacySkull(state, nbt)
      }
      else if (path === 'flower_pot' || path.startsWith('potted_')) {
        if (id.endsWith('flower_pot') || id.endsWith('flowerpot')) changed = flowerPot(nbt)
      }
      if (changed && !changed.equals(state)) this.st.blocks[index] = this.st.paletteId(changed)
    }
  }

  // 統合版のブロックエンティティに書かれた色や種類を、ブロックに移す
  private applyBedrockBlockEntities(): void {
    for (const [index, nbt] of this.st.blockEntities) {
      const state = this.st.state(this.st.blocks[index]!)
      const id = str(nbt.get('id'))
      const path = state.path
      let changed: BlockState | null = null
      if (path.endsWith('_bed') && id === 'Bed') {
        changed = state.withName('minecraft:' + DYE_COLORS[int(nbt.get('color'), 14) & 15] + '_bed')
      }
      else if (path.endsWith('_banner') && id === 'Banner') {
        const color = DYE_COLORS[15 - (int(nbt.get('Base'), 0) & 15)]!
        changed = state.withName('minecraft:' + color + (path.endsWith('_wall_banner') ? '_wall_banner' : '_banner'))
      }
      else if ((path.endsWith('_skull') || path.endsWith('_head')) && id === 'Skull') {
        let skull = state
        if (nbt.has('SkullType') && path.startsWith('skeleton_')) {
          const types = ['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head', 'creeper_head', 'dragon_head', 'piglin_head']
          const type = int(nbt.get('SkullType'), 0)
          let name = types[type >= 0 && type < types.length ? type : 0]!
          if (path.includes('_wall_')) name = name.endsWith('_skull') ? name.replace('_skull', '_wall_skull') : name.replace('_head', '_wall_head')
          skull = skull.withName('minecraft:' + name)
        }
        if (!path.includes('_wall_')) {
          const rotation = num(nbt.get('Rotation'), 0)
          skull = skull.with('rotation', String(Math.round(rotation / 22.5) & 15))
        }
        changed = skull
      }
      else if (path === 'flower_pot' && nbt.get('PlantBlock') instanceof Map && this.tables) {
        const plant = compound(nbt.get('PlantBlock'))
        const values = new Map<string, string>()
        for (const [k, v] of compound(plant.get('states'))) values.set(k, String(typeof v === 'bigint' ? v.toString() : v))
        const java = this.tables.bedrock(str(plant.get('name')), values)
        if (java) {
          const j = BlockState.parse(java)
          if (!j.isAir() && this.data.block('minecraft:potted_' + j.path)) changed = BlockState.parse('minecraft:potted_' + j.path)
        }
      }
      if (changed && !changed.equals(state)) this.st.blocks[index] = this.st.paletteId(changed)
    }
  }

  // ---------- まわりで決まる形 ----------

  private stateAt(x: number, y: number, z: number): BlockState {
    const st = this.st
    if (x < 0 || y < 0 || z < 0 || x >= st.sizeX || y >= st.sizeY || z >= st.sizeZ) return BlockState.AIR
    return st.state(st.blocks[st.index(x, y, z)]!)
  }

  private stateIndexAt(x: number, y: number, z: number): number {
    const st = this.st
    if (x < 0 || y < 0 || z < 0 || x >= st.sizeX || y >= st.sizeY || z >= st.sizeZ) return -1
    return this.stateIndex[st.blocks[st.index(x, y, z)]!] ?? -1
  }

  private sturdy(x: number, y: number, z: number, face: number): boolean {
    const i = this.stateIndexAt(x, y, z)
    return i >= 0 && (this.data.flags(i) & (1 << (STURDY_SHIFT + face))) !== 0
  }

  private solid(x: number, y: number, z: number): boolean {
    const i = this.stateIndexAt(x, y, z)
    return i >= 0 && (this.data.flags(i) & SOLID_RENDER) !== 0
  }

  private isBars(state: BlockState): boolean {
    const block = this.data.block(state.name)
    return !!block && block.skip === SKIP_BARS
  }

  private updateShapes(): void {
    const st = this.st
    // 1 回目: 2 段のブロックの上下をそろえる。2 回目: まわりで決まる形
    for (let pass = 0; pass < 2; pass++) {
      for (let y = 0; y < st.sizeY; y++) {
        for (let z = 0; z < st.sizeZ; z++) {
          for (let x = 0; x < st.sizeX; x++) {
            const index = st.index(x, y, z)
            const state = st.state(st.blocks[index]!)
            if (state.isAir()) continue
            const updated = pass === 0 ? this.updateHalves(state, x, y, z) : this.updateShape(state, x, y, z, st.blockEntities.get(index))
            if (updated && !updated.equals(state)) this.setId(index, updated)
          }
        }
      }
    }
    this.pairChests()
  }

  // 扉と背の高い植物の上下の半分は、片方にしか書かれていない値がある
  private updateHalves(state: BlockState, x: number, y: number, z: number): BlockState | null {
    const half = state.get('half')
    if (half === null) return null
    if (state.path.endsWith('_door')) {
      if (half === 'upper') {
        const below = this.stateAt(x, y - 1, z)
        if (!below.path.endsWith('_door')) return null
        return state.withName(below.name).with('facing', below.get('facing')).with('open', below.get('open'))
      }
      const above = this.stateAt(x, y + 1, z)
      if (!above.path.endsWith('_door') || above.get('half') !== 'upper') return null
      return state.with('hinge', above.get('hinge')).with('powered', above.get('powered'))
    }
    if (half === 'upper' && state.get('facing') === null) {
      // 背の高い植物 (上の半分は種類を持っていなかった)
      const below = this.stateAt(x, y - 1, z)
      if (below.get('half') === 'lower' && below.get('facing') === null) return state.withName(below.name)
    }
    return null
  }

  private updateShape(state: BlockState, x: number, y: number, z: number, entity: Compound | undefined): BlockState | null {
    const path = state.path
    if (isFence(state)) {
      let result = state
      const wooden = isWoodenFence(state)
      for (const d of HORIZONTAL) {
        const nx = x + DX[d]!, nz = z + DZ[d]!
        const n = this.stateAt(nx, y, nz)
        const connect = (!isExceptionForConnection(n) && this.sturdy(nx, y, nz, OPPOSITE[d]!))
          || (isFence(n) && isWoodenFence(n) === wooden)
          || (isFenceGate(n) && gateConnects(n, d))
        result = result.with(NAMES[d]!, connect ? 'true' : 'false')
      }
      return result
    }
    if (this.isBars(state)) {
      let result = state
      for (const d of HORIZONTAL) {
        const nx = x + DX[d]!, nz = z + DZ[d]!
        const n = this.stateAt(nx, y, nz)
        const connect = (!isExceptionForConnection(n) && this.sturdy(nx, y, nz, OPPOSITE[d]!)) || this.isBars(n) || isWall(n)
        result = result.with(NAMES[d]!, connect ? 'true' : 'false')
      }
      return result
    }
    if (isWall(state)) return this.updateWall(state, x, y, z)
    if (isStairs(state)) return state.with('shape', this.stairsShape(state, x, y, z))
    if (path === 'redstone_wire') return this.updateWire(state, x, y, z)
    if (path === 'grass_block' || path === 'podzol' || path === 'mycelium') {
      const above = this.stateAt(x, y + 1, z).path
      const snowy = above === 'snow' || above === 'snow_block' || above === 'powder_snow'
      return state.with('snowy', snowy ? 'true' : 'false')
    }
    if (path === 'chest' || path === 'trapped_chest' || path.endsWith('copper_chest')) {
      // 統合版は、つながる相手の位置をブロックエンティティに書いている
      if (entity && entity.has('pairx') && entity.has('pairz')) {
        const facing = dirOf(state.get('facing'))
        const px = int(entity.get('pairx')), pz = int(entity.get('pairz'))
        const ox = int(entity.get('x'), x), oz = int(entity.get('z'), z)
        const dx = Math.sign(px - ox), dz = Math.sign(pz - oz)
        if (facing >= 0) {
          const cw = CLOCKWISE[facing]!
          if (DX[cw] === dx && DZ[cw] === dz) return state.with('type', 'left')
          const ccw = COUNTER_CLOCKWISE[facing]!
          if (DX[ccw] === dx && DZ[ccw] === dz) return state.with('type', 'right')
        }
      }
      return state.with('type', 'single')
    }
    return null
  }

  private stairsShape(state: BlockState, x: number, y: number, z: number): string {
    const facing = dirOf(state.get('facing'))
    const half = state.get('half')
    if (facing < 2) return 'straight'
    const behind = this.stateAt(x + DX[facing]!, y, z + DZ[facing]!)
    if (isStairs(behind) && half === behind.get('half')) {
      const bf = dirOf(behind.get('facing'))
      if (bf >= 2 && (bf >> 1) !== (facing >> 1) && this.canTakeShape(state, x, y, z, OPPOSITE[bf]!)) {
        return bf === COUNTER_CLOCKWISE[facing] ? 'outer_left' : 'outer_right'
      }
    }
    const front = OPPOSITE[facing]!
    const fs = this.stateAt(x + DX[front]!, y, z + DZ[front]!)
    if (isStairs(fs) && half === fs.get('half')) {
      const ff = dirOf(fs.get('facing'))
      if (ff >= 2 && (ff >> 1) !== (facing >> 1) && this.canTakeShape(state, x, y, z, ff)) {
        return ff === COUNTER_CLOCKWISE[facing] ? 'inner_left' : 'inner_right'
      }
    }
    return 'straight'
  }

  private canTakeShape(state: BlockState, x: number, y: number, z: number, d: number): boolean {
    const n = this.stateAt(x + DX[d]!, y, z + DZ[d]!)
    return !isStairs(n) || state.get('facing') !== n.get('facing') || state.get('half') !== n.get('half')
  }

  private updateWall(state: BlockState, x: number, y: number, z: number): BlockState {
    let result = state
    const connected = [false, false, false, false, false, false]
    const above = this.stateAt(x, y + 1, z)
    for (const d of HORIZONTAL) {
      const nx = x + DX[d]!, nz = z + DZ[d]!
      const n = this.stateAt(nx, y, nz)
      connected[d] = isWall(n) || (!isExceptionForConnection(n) && this.sturdy(nx, y, nz, OPPOSITE[d]!))
        || this.isBars(n) || (isFenceGate(n) && gateConnects(n, d))
      let height = 'none'
      if (connected[d]) {
        // 上にブロックが載っていれば高い壁になる
        const covered = this.sturdy(x, y + 1, z, DOWN) || (isWall(above) && above.get(NAMES[d]!) !== 'none')
        height = covered ? 'tall' : 'low'
      }
      result = result.with(NAMES[d]!, height)
    }
    const ns = connected[NORTH] && connected[SOUTH] && !connected[EAST] && !connected[WEST]
    const ew = connected[EAST] && connected[WEST] && !connected[NORTH] && !connected[SOUTH]
    const ap = above.path
    const abovePost = ap.endsWith('torch') || ap.endsWith('lantern') || ap.endsWith('_sign') || ap.endsWith('_banner') || (isWall(above) && above.get('up') === 'true')
    return result.with('up', (ns || ew) && !abovePost ? 'false' : 'true')
  }

  private updateWire(state: BlockState, x: number, y: number, z: number): BlockState {
    const canConnectUp = !this.solid(x, y + 1, z)
    let result = state
    const connected = [false, false, false, false, false, false]
    for (const d of HORIZONTAL) {
      const nx = x + DX[d]!, nz = z + DZ[d]!
      const n = this.stateAt(nx, y, nz)
      let side = 'none'
      if (canConnectUp && (this.sturdy(nx, y, nz, UP) || n.path.endsWith('_trapdoor') || n.path === 'hopper') && wireConnects(this.stateAt(nx, y + 1, nz), -1)) {
        side = this.sturdy(nx, y, nz, OPPOSITE[d]!) ? 'up' : 'side'
      }
      else if (wireConnects(n, d) || (!this.solid(nx, y, nz) && wireConnects(this.stateAt(nx, y - 1, nz), -1))) {
        side = 'side'
      }
      connected[d] = side !== 'none'
      result = result.with(NAMES[d]!, side)
    }
    // どこにもつながらない線は十字、1 方向だけなら反対側にも伸ばす
    const nsEmpty = !connected[NORTH] && !connected[SOUTH]
    const ewEmpty = !connected[EAST] && !connected[WEST]
    if (!connected[WEST] && nsEmpty) result = result.with('west', 'side')
    if (!connected[EAST] && nsEmpty) result = result.with('east', 'side')
    if (!connected[NORTH] && ewEmpty) result = result.with('north', 'side')
    if (!connected[SOUTH] && ewEmpty) result = result.with('south', 'side')
    return result
  }

  // 1.12 までの形式のチェストは、隣り合う同じ向きのチェストとつながる
  private pairChests(): void {
    const st = this.st
    if (st.source !== 'legacy') return
    const done = new Set<number>()
    for (let y = 0; y < st.sizeY; y++) {
      for (let z = 0; z < st.sizeZ; z++) {
        for (let x = 0; x < st.sizeX; x++) {
          const index = st.index(x, y, z)
          if (done.has(index)) continue
          const state = st.state(st.blocks[index]!)
          if (state.path !== 'chest' && state.path !== 'trapped_chest') continue
          const facing = dirOf(state.get('facing'))
          if (facing < 2) continue
          for (let side = 0; side < 2; side++) {
            const d = side === 0 ? CLOCKWISE[facing]! : COUNTER_CLOCKWISE[facing]!
            const nx = x + DX[d]!, nz = z + DZ[d]!
            if (nx < 0 || nz < 0 || nx >= st.sizeX || nz >= st.sizeZ) continue
            const other = st.index(nx, y, nz)
            if (done.has(other)) continue
            const n = st.state(st.blocks[other]!)
            if (n.name !== state.name || state.get('facing') !== n.get('facing')) continue
            this.setId(index, state.with('type', side === 0 ? 'left' : 'right'))
            this.setId(other, n.with('type', side === 0 ? 'right' : 'left'))
            done.add(index)
            done.add(other)
            break
          }
        }
      }
    }
  }
}

function isFence(s: BlockState): boolean {
  return s.path.endsWith('_fence') && s.get('north') !== null
}

function isWoodenFence(s: BlockState): boolean {
  return isFence(s) && s.path !== 'nether_brick_fence'
}

function isWall(s: BlockState): boolean {
  return s.path.endsWith('_wall') && s.get('up') !== null
}

function isFenceGate(s: BlockState): boolean {
  return s.path.endsWith('_fence_gate')
}

function isStairs(s: BlockState): boolean {
  return s.get('shape') !== null && s.get('half') !== null && s.get('facing') !== null && s.path.endsWith('_stairs')
}

// Block.isExceptionForConnection: これらのブロックの面にはつながらない
function isExceptionForConnection(s: BlockState): boolean {
  const p = s.path
  return p.endsWith('_leaves') || p === 'barrier' || p === 'carved_pumpkin' || p === 'jack_o_lantern' || p === 'melon' || p === 'pumpkin' || p.endsWith('shulker_box')
}

// フェンスゲートが、その向きにつながるか (ゲートの向きと直角の向き)
function gateConnects(gate: BlockState, d: number): boolean {
  const facing = dirOf(gate.get('facing'))
  if (facing < 0) return false
  const facingX = facing === WEST || facing === EAST
  const turned = CLOCKWISE[d]!
  return facingX === (turned === WEST || turned === EAST)
}

// BlockState.shouldRedstoneWireConnectTo。d が -1 なら向きを問わない (上下の段の線)
function wireConnects(s: BlockState, d: number): boolean {
  const p = s.path
  if (p === 'redstone_wire') return true
  if (p === 'repeater') {
    const f = dirOf(s.get('facing'))
    return d >= 0 && (f === d || f === OPPOSITE[d])
  }
  if (p === 'observer') return d >= 0 && dirOf(s.get('facing')) === d
  if (d < 0) return false
  return SIGNAL_SOURCES.has(s.name) || p.endsWith('_button') || p.endsWith('_pressure_plate')
}

function legacySkull(state: BlockState, nbt: Compound): BlockState {
  const types = ['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'player_head', 'creeper_head', 'dragon_head']
  const type = int(nbt.get('SkullType'), 0)
  const base = types[type >= 0 && type < types.length ? type : 0]!
  if (state.path.includes('_wall_')) {
    const name = base.endsWith('_skull') ? base.replace('_skull', '_wall_skull') : base.replace('_head', '_wall_head')
    return BlockState.parse('minecraft:' + name + '[facing=' + (state.get('facing') ?? 'north') + ']')
  }
  return BlockState.parse('minecraft:' + base + '[rotation=' + (int(nbt.get('Rot'), 0) & 15) + ']')
}

function flowerPot(nbt: Compound): BlockState {
  const v = nbt.get('Item')
  let item: string
  if (typeof v === 'number') item = legacyItemName(v)
  else {
    item = str(v)
    if (item && item.indexOf(':') < 0) item = 'minecraft:' + item
  }
  const data = int(nbt.get('Data'), 0)
  let plant: string
  if (item === 'minecraft:red_flower') {
    const flowers = ['poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy']
    plant = data >= 0 && data < flowers.length ? flowers[data]! : 'poppy'
  }
  else if (item === 'minecraft:yellow_flower') plant = 'dandelion'
  else if (item === 'minecraft:sapling') {
    const saplings = ['oak_sapling', 'spruce_sapling', 'birch_sapling', 'jungle_sapling', 'acacia_sapling', 'dark_oak_sapling']
    plant = data >= 0 && data < saplings.length ? saplings[data]! : 'oak_sapling'
  }
  else if (item === 'minecraft:red_mushroom') plant = 'red_mushroom'
  else if (item === 'minecraft:brown_mushroom') plant = 'brown_mushroom'
  else if (item === 'minecraft:cactus') plant = 'cactus'
  else if (item === 'minecraft:deadbush') plant = 'dead_bush'
  else if (item === 'minecraft:tallgrass' && data === 2) plant = 'fern'
  else return BlockState.parse('minecraft:flower_pot')
  return BlockState.parse('minecraft:potted_' + plant)
}

function legacyItemName(id: number): string {
  switch (id) {
    case 6: return 'minecraft:sapling'
    case 31: return 'minecraft:tallgrass'
    case 32: return 'minecraft:deadbush'
    case 37: return 'minecraft:yellow_flower'
    case 38: return 'minecraft:red_flower'
    case 39: return 'minecraft:brown_mushroom'
    case 40: return 'minecraft:red_mushroom'
    case 81: return 'minecraft:cactus'
    default: return ''
  }
}
