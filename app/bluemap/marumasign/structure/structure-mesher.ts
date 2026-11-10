// 構造物のブロックを四角形の列にする (MarumaSign 本体の StructureMesher と同じ)。
// 面の省き方、なめらかな明るさ (環境光の遮蔽)、面の向きによる明るさ、草や葉の色、植物の位置のずれ、液体の形は、
// Minecraft (ModelBlockRenderer / BlockModelLighter / FluidRenderer) と同じ計算にする。
// 明るさは、すべてのブロックに空の光が当たっている状態 (昼の屋外) として計算する (本体と同じ。ブロックの光は使わない)
// ここは Node の試験でも使う
import { CUTOUT, type Sprite, TRANSLUCENT } from './assets.ts'
import type { BiomeColors, BiomeColorSet } from './biomes.ts'
import {
  type BlockData, type BlockInfo, FULL_COLLISION, INVISIBLE, isEmptyMask, isFullMask, LIGHT_PERMEABLE, maskBit, OFFSET_NONE, OFFSET_XYZ,
  SKIP_BARS, SKIP_LIQUID, SKIP_ROOTS, SKIP_SAME, SOLID, SOLID_RENDER, STURDY_SHIFT, type FaceMask,
} from './block-data.ts'
import type { BlockModels, Quad, StateModel, Variant } from './block-models.ts'
import { BlockState, DOWN, DX, DY, DZ, EAST, NAMES, NORTH, OPPOSITE, SOUTH, UP, WEST } from './block-state.ts'
import type { Structure } from './formats.ts'
import { blockSeed, JavaRandom } from './java-random.ts'
import type { Compound } from './nbt.ts'

/** 描く四角形の数の上限 (MarumaSign 本体と同じ。超える構造物は 2 x 2 x 2 ブロックを 1 つにまとめて粗くする) */
export const MAX_QUADS = 150000

export const LAYER_SOLID = 0
export const LAYER_CUTOUT = 1
export const LAYER_TRANSLUCENT = 2

/** 面の向きによる明るさ (CardinalLighting.DEFAULT) */
export const SHADE = [0.5, 1.0, 0.8, 0.8, 0.6, 0.6]

export function layerOf(transparency: number): number {
  return transparency === TRANSLUCENT ? LAYER_TRANSLUCENT : transparency === CUTOUT ? LAYER_CUTOUT : LAYER_SOLID
}

/** 色に明るさを掛ける (0xRRGGBB。Java の (int) と同じく切り捨て) */
export function scale(color: number, factor: number): number {
  const f = Math.fround(factor)
  const r = Math.min(255, Math.trunc(Math.fround(((color >> 16) & 255) * f)))
  const g = Math.min(255, Math.trunc(Math.fround(((color >> 8) & 255) * f)))
  const b = Math.min(255, Math.trunc(Math.fround((color & 255) * f)))
  return r << 16 | g << 8 | b
}

class GrowF32 {
  a = new Float32Array(1024)
  n = 0
  push(src: ArrayLike<number>, count: number): void {
    if (this.n + count > this.a.length) {
      const b = new Float32Array(Math.max(this.a.length * 2, this.n + count))
      b.set(this.a.subarray(0, this.n))
      this.a = b
    }
    for (let i = 0; i < count; i++) this.a[this.n + i] = src[i]!
    this.n += count
  }
}

class GrowI32 {
  a = new Int32Array(256)
  n = 0
  push(v: number): void {
    if (this.n === this.a.length) {
      const b = new Int32Array(this.a.length * 2)
      b.set(this.a)
      this.a = b
    }
    this.a[this.n++] = v
  }
}

/** 書き出した四角形 (層ごと) */
export class MeshOutput {
  readonly sprites: Sprite[] = []
  private readonly spriteIndex = new Map<Sprite, number>()
  readonly positions = [new GrowF32(), new GrowF32(), new GrowF32()]
  readonly uvs = [new GrowF32(), new GrowF32(), new GrowF32()]
  readonly colors = [new GrowI32(), new GrowI32(), new GrowI32()]
  readonly spriteOf = [new GrowI32(), new GrowI32(), new GrowI32()]
  quadCount = 0
  /** 仮のテクスチャ (読み込み前) を使った */
  pending = false
  overflow = false
  /** 集める四角形の数の上限。超えたら捨てて overflow にする (読み込み側で粗くしてやり直す) */
  static readonly HARD_LIMIT = MAX_QUADS * 4

  sprite(s: Sprite): number {
    let i = this.spriteIndex.get(s)
    if (i === undefined) {
      i = this.sprites.length
      this.sprites.push(s)
      this.spriteIndex.set(s, i)
    }
    return i
  }

  add(layer: number, position: ArrayLike<number>, uv: ArrayLike<number>, color: ArrayLike<number>, sprite: Sprite): void {
    if (this.quadCount >= MeshOutput.HARD_LIMIT) {
      this.overflow = true
      return
    }
    if (sprite.pending) this.pending = true
    this.positions[layer]!.push(position, 12)
    this.uvs[layer]!.push(uv, 8)
    for (let i = 0; i < 4; i++) this.colors[layer]!.push(color[i]!)
    this.spriteOf[layer]!.push(this.sprite(sprite))
    this.quadCount++
  }
}

/** ブロックエンティティとエンティティを描くもの (special.ts) */
export interface SpecialRenderer {
  handles(state: BlockState): boolean
  /** 描く。ブロックのモデルを描かないほうがよいとき (MarumaSign の看板の板は消える) は true */
  emit(mesher: StructureMesher, state: BlockState, entity: Compound | undefined, x: number, y: number, z: number): boolean
  emitEntities(mesher: StructureMesher): void
  startPass(): void
}

const GRASS = 0, FOLIAGE = 1, DRY_FOLIAGE = 2, WATER = 3

// ---------- 面に掛ける色 (BlockColors.createDefault と同じ。MarumaSign 本体の Tints) ----------

const T_NONE = 0, T_GRASS = 1, T_DOUBLE_GRASS = 2, T_FOLIAGE = 3, T_DRY_FOLIAGE = 4, T_WATER = 5, T_REDSTONE = 6, T_STEM = 7
const T_SPRUCE = 8, T_BIRCH = 9, T_ATTACHED_STEM = 10, T_LILY_PAD = 11, T_FLOWER_BED = 12

const REDSTONE_COLORS: number[] = []
for (let i = 0; i <= 15; i++) {
  const fr = Math.fround
  const power = fr(i / 15)
  const r = fr(fr(power * fr(0.6)) + fr(power > 0 ? 0.4 : 0.3))
  const g = Math.max(0, Math.min(1, fr(fr(fr(power * power) * fr(0.7)) - fr(0.5))))
  const b = Math.max(0, Math.min(1, fr(fr(fr(power * power) * fr(0.6)) - fr(0.7))))
  REDSTONE_COLORS.push(Math.trunc(fr(r * 255)) << 16 | Math.trunc(fr(g * 255)) << 8 | Math.trunc(fr(b * 255)))
}

export function tintType(name: string): number {
  switch (name) {
    case 'minecraft:large_fern': case 'minecraft:tall_grass': return T_DOUBLE_GRASS
    case 'minecraft:fern': case 'minecraft:short_grass': case 'minecraft:potted_fern': case 'minecraft:bush': case 'minecraft:grass_block':
    case 'minecraft:sugar_cane': return T_GRASS
    case 'minecraft:pink_petals': case 'minecraft:wildflowers': return T_FLOWER_BED
    case 'minecraft:spruce_leaves': return T_SPRUCE
    case 'minecraft:birch_leaves': return T_BIRCH
    case 'minecraft:oak_leaves': case 'minecraft:jungle_leaves': case 'minecraft:acacia_leaves': case 'minecraft:dark_oak_leaves':
    case 'minecraft:vine': case 'minecraft:mangrove_leaves': return T_FOLIAGE
    case 'minecraft:leaf_litter': return T_DRY_FOLIAGE
    case 'minecraft:water_cauldron': return T_WATER
    case 'minecraft:redstone_wire': return T_REDSTONE
    case 'minecraft:attached_melon_stem': case 'minecraft:attached_pumpkin_stem': return T_ATTACHED_STEM
    case 'minecraft:melon_stem': case 'minecraft:pumpkin_stem': return T_STEM
    case 'minecraft:lily_pad': return T_LILY_PAD
    default: return T_NONE
  }
}

/** AO の計算の、面ごとの 4 つの隣の方向 */
const CORNERS = [
  [WEST, EAST, NORTH, SOUTH],
  [EAST, WEST, NORTH, SOUTH],
  [UP, DOWN, EAST, WEST],
  [WEST, EAST, DOWN, UP],
  [UP, DOWN, NORTH, SOUTH],
  [DOWN, UP, NORTH, SOUTH],
]
const S_DOWN = 0, S_UP = 1, S_NORTH = 2, S_SOUTH = 3, S_WEST = 4, S_EAST = 5
const F_DOWN = 6, F_UP = 7, F_NORTH = 8, F_SOUTH = 9, F_WEST = 10, F_EAST = 11
/** 面ごと・頂点ごとの重み (AdjacencyInfo.vertNWeights) */
const WEIGHTS = [
  [[F_WEST, S_SOUTH, F_WEST, F_SOUTH, S_WEST, F_SOUTH, S_WEST, S_SOUTH], [F_WEST, S_NORTH, F_WEST, F_NORTH, S_WEST, F_NORTH, S_WEST, S_NORTH],
    [F_EAST, S_NORTH, F_EAST, F_NORTH, S_EAST, F_NORTH, S_EAST, S_NORTH], [F_EAST, S_SOUTH, F_EAST, F_SOUTH, S_EAST, F_SOUTH, S_EAST, S_SOUTH]],
  [[S_EAST, S_SOUTH, S_EAST, F_SOUTH, F_EAST, F_SOUTH, F_EAST, S_SOUTH], [S_EAST, S_NORTH, S_EAST, F_NORTH, F_EAST, F_NORTH, F_EAST, S_NORTH],
    [S_WEST, S_NORTH, S_WEST, F_NORTH, F_WEST, F_NORTH, F_WEST, S_NORTH], [S_WEST, S_SOUTH, S_WEST, F_SOUTH, F_WEST, F_SOUTH, F_WEST, S_SOUTH]],
  [[S_UP, F_WEST, S_UP, S_WEST, F_UP, S_WEST, F_UP, F_WEST], [S_UP, F_EAST, S_UP, S_EAST, F_UP, S_EAST, F_UP, F_EAST],
    [S_DOWN, F_EAST, S_DOWN, S_EAST, F_DOWN, S_EAST, F_DOWN, F_EAST], [S_DOWN, F_WEST, S_DOWN, S_WEST, F_DOWN, S_WEST, F_DOWN, F_WEST]],
  [[S_UP, F_WEST, F_UP, F_WEST, F_UP, S_WEST, S_UP, S_WEST], [S_DOWN, F_WEST, F_DOWN, F_WEST, F_DOWN, S_WEST, S_DOWN, S_WEST],
    [S_DOWN, F_EAST, F_DOWN, F_EAST, F_DOWN, S_EAST, S_DOWN, S_EAST], [S_UP, F_EAST, F_UP, F_EAST, F_UP, S_EAST, S_UP, S_EAST]],
  [[S_UP, S_SOUTH, S_UP, F_SOUTH, F_UP, F_SOUTH, F_UP, S_SOUTH], [S_UP, S_NORTH, S_UP, F_NORTH, F_UP, F_NORTH, F_UP, S_NORTH],
    [S_DOWN, S_NORTH, S_DOWN, F_NORTH, F_DOWN, F_NORTH, F_DOWN, S_NORTH], [S_DOWN, S_SOUTH, S_DOWN, F_SOUTH, F_DOWN, F_SOUTH, F_DOWN, S_SOUTH]],
  [[F_DOWN, S_SOUTH, F_DOWN, F_SOUTH, S_DOWN, F_SOUTH, S_DOWN, S_SOUTH], [F_DOWN, S_NORTH, F_DOWN, F_NORTH, S_DOWN, F_NORTH, S_DOWN, S_NORTH],
    [F_UP, S_NORTH, F_UP, F_NORTH, S_UP, F_NORTH, S_UP, S_NORTH], [F_UP, S_SOUTH, F_UP, F_SOUTH, S_UP, F_SOUTH, S_UP, S_SOUTH]],
]
/** AmbientVertexRemap */
const REMAP = [[0, 1, 2, 3], [2, 3, 0, 1], [3, 0, 1, 2], [0, 1, 2, 3], [3, 0, 1, 2], [1, 2, 3, 0]]

const MAX_FLUID_HEIGHT = Math.fround(0.8888889)

// エンティティの明るさに使う 2 つの光の向き (Lighting.DIFFUSE_LIGHT_0 / 1)
function normalize(x: number, y: number, z: number): number[] {
  x = Math.fround(x)
  y = Math.fround(y)
  z = Math.fround(z)
  const l = Math.fround(Math.sqrt(Math.fround(Math.fround(Math.fround(x * x) + Math.fround(y * y)) + Math.fround(z * z))))
  return [Math.fround(x / l), Math.fround(y / l), Math.fround(z / l)]
}
const LIGHT0 = normalize(0.2, 1.0, -0.7)
const LIGHT1 = normalize(-0.2, 1.0, 0.7)

function f32(v: number): number {
  return Math.fround(v)
}

export class StructureMesher {
  readonly structure: Structure
  readonly data: BlockData
  readonly models: BlockModels
  readonly biomes: BiomeColors
  readonly special: SpecialRenderer
  readonly output = new MeshOutput()

  private readonly stateIndex: Int32Array
  private readonly blocks: (BlockInfo | undefined)[]
  private readonly stateModels: (StateModel | null)[]
  private readonly fluid: Int32Array
  private readonly flags: Int32Array
  private readonly emission: Int32Array
  private readonly tints: Int32Array
  private readonly specialBlock: Uint8Array
  private readonly faceCache = new Map<number, boolean>()
  private readonly random = new JavaRandom()
  private readonly variants: Variant[] = []
  private readonly position = new Float32Array(12)
  private readonly color = [0, 0, 0, 0]
  private readonly faceShape = new Float32Array(12)
  private readonly brightness = new Float32Array(4)
  private readonly blendCache = new Map<number, number>()

  constructor(structure: Structure, data: BlockData, models: BlockModels, biomes: BiomeColors, special: SpecialRenderer) {
    this.structure = structure
    this.data = data
    this.models = models
    this.biomes = biomes
    this.special = special
    const count = structure.palette.length
    this.stateIndex = new Int32Array(count)
    this.blocks = new Array(count)
    this.stateModels = new Array(count).fill(null)
    this.fluid = new Int32Array(count)
    this.flags = new Int32Array(count)
    this.emission = new Int32Array(count)
    this.tints = new Int32Array(count)
    this.specialBlock = new Uint8Array(count)
    for (let id = 0; id < count; id++) {
      const state = structure.state(id)
      const block = data.block(state.name)
      this.blocks[id] = block
      this.stateIndex[id] = block ? data.stateIndex(block, state) : -1
      if (block) {
        const index = this.stateIndex[id]!
        this.fluid[id] = data.fluid(index)
        this.flags[id] = data.flags(index)
        this.emission[id] = data.lightEmission(index)
      }
      else {
        // 知らないブロック (別の Mod のものなど) は、光を通す空気のようなものとして扱う
        this.flags[id] = LIGHT_PERMEABLE
      }
      this.tints[id] = tintType(state.name)
      this.specialBlock[id] = special.handles(state) ? 1 : 0
      if (!state.isAir() && (this.flags[id]! & INVISIBLE) === 0) this.stateModels[id] = models.model(state)
    }
  }

  // ---------- 隣のブロック ----------

  idAt(x: number, y: number, z: number): number {
    const st = this.structure
    if (x < 0 || y < 0 || z < 0 || x >= st.sizeX || y >= st.sizeY || z >= st.sizeZ) return 0
    return st.blocks[(y * st.sizeZ + z) * st.sizeX + x]!
  }

  private shadeBrightness(id: number): number {
    return (this.flags[id]! & FULL_COLLISION) !== 0 ? 0.2 : 1.0
  }

  private lightPermeable(id: number): boolean {
    return (this.flags[id]! & LIGHT_PERMEABLE) !== 0
  }

  private faceMask(id: number, d: number): FaceMask | null {
    return this.stateIndex[id]! < 0 ? null : this.data.faceMask(this.stateIndex[id]!, d)
  }

  // Block.shouldRenderFace
  private shouldRenderFace(id: number, neighbor: number, d: number): boolean {
    const key = (id * 65536 + neighbor) * 8 + d
    const hit = this.faceCache.get(key)
    if (hit !== undefined) return hit
    const r = this.computeShouldRenderFace(id, neighbor, d)
    this.faceCache.set(key, r)
    return r
  }

  private computeShouldRenderFace(id: number, neighbor: number, d: number): boolean {
    const occluder = this.faceMask(neighbor, OPPOSITE[d]!)
    if (isFullMask(occluder)) return false
    if (this.skipRendering(id, neighbor, d)) return false
    if (isEmptyMask(occluder)) return true
    const shape = this.faceMask(id, d)
    if (isEmptyMask(shape)) return true
    for (let i = 0; i < 8; i++) if ((shape![i]! & ~occluder![i]!) !== 0) return true
    return false
  }

  private skipRendering(id: number, neighbor: number, d: number): boolean {
    const block = this.blocks[id]
    if (!block) return false
    const state = this.structure.state(id), other = this.structure.state(neighbor)
    switch (block.skip) {
      case SKIP_SAME: return state.name === other.name
      case SKIP_BARS: {
        const bothBars = isBarsTag(state) && isBarsTag(other) && other.get(NAMES[OPPOSITE[d]!]!) !== null
        if (state.name !== other.name && !bothBars) return false
        if (d === DOWN || d === UP) return true
        return state.get(NAMES[d]!) === 'true' && other.get(NAMES[OPPOSITE[d]!]!) === 'true'
      }
      case SKIP_LIQUID: return this.fluidType(neighbor) === this.fluidType(id)
      case SKIP_ROOTS: return other.name === 'minecraft:mangrove_roots' && (d === DOWN || d === UP)
      default: return false
    }
  }

  private fluidType(id: number): number {
    return this.fluid[id]! & 3
  }

  // ---------- 全体 ----------

  build(): void {
    this.special.startPass()
    const st = this.structure
    for (let y = 0; y < st.sizeY; y++) {
      for (let z = 0; z < st.sizeZ; z++) {
        for (let x = 0; x < st.sizeX; x++) {
          // 多すぎる面は集めない (読み込み側で粗くしてやり直す)
          if (this.output.overflow) return
          const index = st.index(x, y, z)
          const id = st.blocks[index]!
          if (id === 0) continue
          if (this.fluid[id] !== 0) this.fluidBlock(x, y, z, id)
          let hidden = false
          if (this.specialBlock[id]) hidden = this.special.emit(this, st.state(id), st.blockEntities.get(index), x, y, z)
          const model = this.stateModels[id]
          if (model && !hidden) this.block(x, y, z, id, model)
        }
      }
    }
    this.special.emitEntities(this)
  }

  // ---------- ブロック ----------

  private block(x: number, y: number, z: number, id: number, model: StateModel): void {
    this.variants.length = 0
    const s = this.structure.step
    const wx = x * s, wy = y * s, wz = z * s
    model.collect(() => blockSeed(wx, wy, wz), this.random, this.variants)
    if (!this.variants.length) return

    // 植物などの、位置ごとのずれ
    let ox = 0, oy = 0, oz = 0
    const block = this.blocks[id]
    if (block && block.offsetType !== OFFSET_NONE) {
      const seed = blockSeed(wx, 0, wz)
      const max = block.maxHorizontalOffset
      const clampf = (v: number): number => Math.max(-max, Math.min(max, v))
      ox = clampf(f32((f32(Number(seed & 15n) / 15) - 0.5) * 0.5))
      oz = clampf(f32((f32(Number((seed >> 8n) & 15n) / 15) - 0.5) * 0.5))
      if (block.offsetType === OFFSET_XYZ) oy = f32((f32(Number((seed >> 4n) & 15n) / 15) - 1) * block.maxVerticalOffset)
    }

    const ao = this.emission[id] === 0 && this.variants[0]!.ambientOcclusion
    let cullChecked = 0, cullVisible = 0
    const state = this.structure.state(id)
    for (const variant of this.variants) {
      for (const quad of variant.quads) {
        if (quad.cull >= 0) {
          const mask = 1 << quad.cull
          if ((cullChecked & mask) === 0) {
            cullChecked |= mask
            if (this.shouldRenderFace(id, this.idAt(x + DX[quad.cull]!, y + DY[quad.cull]!, z + DZ[quad.cull]!), quad.cull)) cullVisible |= mask
          }
          if ((cullVisible & mask) === 0) continue
        }
        if (ao) this.ambientOcclusion(x, y, z, id, quad)
        else this.brightness.fill(SHADE[quad.shadeDirection]!)
        const tint = quad.tint >= 0 ? this.tintColor(this.tints[id]!, quad.tint, state, x, y, z) : 0xFFFFFF
        for (let v = 0; v < 4; v++) {
          this.position[v * 3] = x + quad.positions[v * 3]! + ox
          this.position[v * 3 + 1] = y + quad.positions[v * 3 + 1]! + oy
          this.position[v * 3 + 2] = z + quad.positions[v * 3 + 2]! + oz
          this.color[v] = scale(tint, this.brightness[v]!)
        }
        this.output.add(layerOf(quad.transparency), this.position, quad.uvs, this.color, quad.sprite)
      }
    }
  }

  // ---------- なめらかな明るさ (BlockModelLighter.prepareQuadAmbientOcclusion) ----------

  private ambientOcclusion(x: number, y: number, z: number, id: number, quad: Quad): void {
    const p = quad.positions
    let minX = 32, minY = 32, minZ = 32, maxX = -32, maxY = -32, maxZ = -32
    for (let i = 0; i < 4; i++) {
      minX = Math.min(minX, p[i * 3]!)
      minY = Math.min(minY, p[i * 3 + 1]!)
      minZ = Math.min(minZ, p[i * 3 + 2]!)
      maxX = Math.max(maxX, p[i * 3]!)
      maxY = Math.max(maxY, p[i * 3 + 1]!)
      maxZ = Math.max(maxZ, p[i * 3 + 2]!)
    }
    const fs = this.faceShape
    fs[S_WEST] = minX
    fs[S_EAST] = maxX
    fs[S_DOWN] = minY
    fs[S_UP] = maxY
    fs[S_NORTH] = minZ
    fs[S_SOUTH] = maxZ
    fs[F_WEST] = 1 - minX
    fs[F_EAST] = 1 - maxX
    fs[F_DOWN] = 1 - minY
    fs[F_UP] = 1 - maxY
    fs[F_NORTH] = 1 - minZ
    fs[F_SOUTH] = 1 - maxZ
    const d = quad.direction
    const fullBlock = (this.flags[id]! & FULL_COLLISION) !== 0
    let partial: boolean, cubic: boolean
    switch (d) {
      case DOWN:
      case UP:
        partial = minX >= 1e-4 || minZ >= 1e-4 || maxX <= 0.9999 || maxZ <= 0.9999
        cubic = minY === maxY && ((d === DOWN ? minY < 1e-4 : maxY > 0.9999) || fullBlock)
        break
      case NORTH:
      case SOUTH:
        partial = minX >= 1e-4 || minY >= 1e-4 || maxX <= 0.9999 || maxY <= 0.9999
        cubic = minZ === maxZ && ((d === NORTH ? minZ < 1e-4 : maxZ > 0.9999) || fullBlock)
        break
      default:
        partial = minY >= 1e-4 || minZ >= 1e-4 || maxY <= 0.9999 || maxZ <= 0.9999
        cubic = minX === maxX && ((d === WEST ? minX < 1e-4 : maxX > 0.9999) || fullBlock)
    }
    const bx = cubic ? x + DX[d]! : x, by = cubic ? y + DY[d]! : y, bz = cubic ? z + DZ[d]! : z
    const corners = CORNERS[d]!
    const shade = [0, 0, 0, 0]
    const permeable = [false, false, false, false]
    for (let i = 0; i < 4; i++) {
      const c = corners[i]!
      shade[i] = this.shadeBrightness(this.idAt(bx + DX[c]!, by + DY[c]!, bz + DZ[c]!))
      permeable[i] = this.lightPermeable(this.idAt(bx + DX[c]! + DX[d]!, by + DY[c]! + DY[d]!, bz + DZ[c]! + DZ[d]!))
    }
    const corner = (a: number, b: number): number => this.shadeBrightness(this.idAt(bx + DX[a]! + DX[b]!, by + DY[a]! + DY[b]!, bz + DZ[a]! + DZ[b]!))
    const c02 = !permeable[2] && !permeable[0] ? shade[0]! : corner(corners[0]!, corners[2]!)
    const c03 = !permeable[3] && !permeable[0] ? shade[0]! : corner(corners[0]!, corners[3]!)
    const c12 = !permeable[2] && !permeable[1] ? shade[0]! : corner(corners[1]!, corners[2]!)
    const c13 = !permeable[3] && !permeable[1] ? shade[0]! : corner(corners[1]!, corners[3]!)
    const center = cubic ? this.shadeBrightness(this.idAt(bx, by, bz)) : this.shadeBrightness(id)
    const l1 = f32(f32(f32(f32(shade[3]! + shade[0]!) + c03) + center) * 0.25)
    const l2 = f32(f32(f32(f32(shade[2]! + shade[0]!) + c02) + center) * 0.25)
    const l3 = f32(f32(f32(f32(shade[2]! + shade[1]!) + c12) + center) * 0.25)
    const l4 = f32(f32(f32(f32(shade[3]! + shade[1]!) + c13) + center) * 0.25)
    const remap = REMAP[d]!
    const br = this.brightness
    if (partial) {
      const weights = WEIGHTS[d]!
      for (let v = 0; v < 4; v++) {
        const w = weights[v]!
        // Java の float の計算と同じ丸め
        const w01 = f32(fs[w[0]!]! * fs[w[1]!]!), w23 = f32(fs[w[2]!]! * fs[w[3]!]!), w45 = f32(fs[w[4]!]! * fs[w[5]!]!), w67 = f32(fs[w[6]!]! * fs[w[7]!]!)
        const sum = f32(f32(f32(f32(l1 * w01) + f32(l2 * w23)) + f32(l3 * w45)) + f32(l4 * w67))
        br[remap[v]!] = Math.max(0, Math.min(1, sum))
      }
    }
    else {
      br[remap[0]!] = l1
      br[remap[1]!] = l2
      br[remap[2]!] = l3
      br[remap[3]!] = l4
    }
    const directional = SHADE[quad.shadeDirection]!
    // Minecraft は明るさを 8 ビットの灰色にしてから掛ける
    for (let v = 0; v < 4; v++) br[v] = f32(f32(Math.floor(f32(br[v]! * 255) + 0.5) / 255) * directional)
  }

  // ---------- 草や葉の色 ----------

  private biomeAt(x: number, y: number, z: number): BiomeColorSet {
    const st = this.structure
    if (!st.biomes) return this.biomes.colors(null)
    return this.biomes.colors(st.biome(st.index(x, y, z)))
  }

  /** まわり 5x5 (半径 2) のバイオームの色の平均 (Minecraft の初期設定と同じ) */
  blendedColor(x: number, y: number, z: number, kind: number): number {
    const st = this.structure
    if (!st.biomes) return pick(this.biomes.colors(null), kind)
    const key = (st.index(x, y, z) * 4) + kind
    const hit = this.blendCache.get(key)
    if (hit !== undefined) return hit
    let r = 0, g = 0, b = 0, count = 0
    const radius = Math.max(0, Math.trunc(2 / st.step))
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const nx = Math.max(0, Math.min(st.sizeX - 1, x + dx)), nz = Math.max(0, Math.min(st.sizeZ - 1, z + dz))
        const c = pick(this.biomeAt(nx, y, nz), kind)
        r += (c >> 16) & 255
        g += (c >> 8) & 255
        b += c & 255
        count++
      }
    }
    const result = Math.trunc(r / count) << 16 | Math.trunc(g / count) << 8 | Math.trunc(b / count)
    if (this.blendCache.size < 1 << 20) this.blendCache.set(key, result)
    return result
  }

  /** 面に掛ける色 (0xRRGGBB)。色を付けない面は白 */
  private tintColor(type: number, tintIndex: number, state: BlockState, x: number, y: number, z: number): number {
    switch (type) {
      case T_GRASS: return tintIndex === 0 ? this.blendedColor(x, y, z, GRASS) : 0xFFFFFF
      case T_DOUBLE_GRASS:
        if (tintIndex !== 0) return 0xFFFFFF
        return this.blendedColor(x, state.get('half') === 'upper' ? Math.max(0, y - 1) : y, z, GRASS)
      case T_FLOWER_BED: return tintIndex === 1 ? this.blendedColor(x, y, z, GRASS) : 0xFFFFFF
      case T_FOLIAGE: return tintIndex === 0 ? this.blendedColor(x, y, z, FOLIAGE) : 0xFFFFFF
      case T_DRY_FOLIAGE: return tintIndex === 0 ? this.blendedColor(x, y, z, DRY_FOLIAGE) : 0xFFFFFF
      case T_WATER: return tintIndex === 0 ? this.blendedColor(x, y, z, WATER) : 0xFFFFFF
      case T_SPRUCE: return tintIndex === 0 ? 0x619961 : 0xFFFFFF
      case T_BIRCH: return tintIndex === 0 ? 0x80A755 : 0xFFFFFF
      case T_ATTACHED_STEM: return tintIndex === 0 ? 0xE0C71C : 0xFFFFFF
      case T_LILY_PAD: return tintIndex === 0 ? 0x208030 : 0xFFFFFF
      case T_REDSTONE: {
        if (tintIndex !== 0) return 0xFFFFFF
        const power = Number.parseInt(state.get('power') ?? '0', 10) || 0
        return REDSTONE_COLORS[Math.max(0, Math.min(15, power))]!
      }
      case T_STEM: {
        if (tintIndex !== 0) return 0xFFFFFF
        const age = Number.parseInt(state.get('age') ?? '0', 10) || 0
        return ((age * 32) << 16 | (255 - age * 8) << 8 | age * 4) & 0xFFFFFF
      }
      default: return 0xFFFFFF
    }
  }

  // ---------- 液体 (FluidRenderer) ----------

  private fluidAmount(id: number): number {
    return (this.fluid[id]! >> 2) & 15
  }

  private falling(id: number): boolean {
    return (this.fluid[id]! & (1 << 7)) !== 0
  }

  private ownHeight(id: number): number {
    return this.fluidType(id) === 0 ? 0 : f32(this.fluidAmount(id) / 9)
  }

  private height(type: number, x: number, y: number, z: number): number {
    const id = this.idAt(x, y, z)
    if (this.fluidType(id) === type) return this.fluidType(this.idAt(x, y + 1, z)) === type ? 1 : this.ownHeight(id)
    return (this.flags[id]! & SOLID) === 0 ? 0 : -1
  }

  // 液体の面が、その方向のブロックで隠れるか (FluidRenderer.isFaceOccludedByState)
  private occludedByState(d: number, height: number, id: number): boolean {
    const occluder = this.faceMask(id, OPPOSITE[d]!)
    if (isEmptyMask(occluder)) return false
    if (isFullMask(occluder)) return d !== UP || height === 1
    if (d === UP) return false
    if (d === DOWN) return isFullMask(occluder)
    // 横の面: 液体の高さまでのます目がすべて覆われていれば隠れる
    const rows = Math.min(16, Math.ceil(height * 16 - 1e-4))
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < 16; col++) if (!maskBit(occluder!, row * 16 + col)) return false
    }
    return true
  }

  private fluidBlock(x: number, y: number, z: number, id: number): void {
    const type = this.fluidType(id)
    if (type === 0) return
    const down = this.idAt(x, y - 1, z), up = this.idAt(x, y + 1, z)
    const north = this.idAt(x, y, z - 1), south = this.idAt(x, y, z + 1), west = this.idAt(x - 1, y, z), east = this.idAt(x + 1, y, z)
    const renderUp = this.fluidType(up) !== type
    const renderDown = this.fluidType(down) !== type && !this.occludedByState(UP, 1, id) && !this.occludedByState(DOWN, MAX_FLUID_HEIGHT, down)
    const renderNorth = this.fluidType(north) !== type && !this.occludedByState(SOUTH, 1, id)
    const renderSouth = this.fluidType(south) !== type && !this.occludedByState(NORTH, 1, id)
    const renderWest = this.fluidType(west) !== type && !this.occludedByState(EAST, 1, id)
    const renderEast = this.fluidType(east) !== type && !this.occludedByState(WEST, 1, id)
    if (!renderUp && !renderDown && !renderNorth && !renderSouth && !renderWest && !renderEast) return

    const water = type === 1
    const assets = this.models.assets
    const still = assets.sprite(water ? 'minecraft:block/water_still' : 'minecraft:block/lava_still')
    const flowing = assets.sprite(water ? 'minecraft:block/water_flow' : 'minecraft:block/lava_flow')
    const overlay = water ? assets.sprite('minecraft:block/water_overlay') : null
    const tint = water ? this.blendedColor(x, y, z, WATER) : 0xFFFFFF
    const layer = water ? LAYER_TRANSLUCENT : LAYER_SOLID

    const self = this.height(type, x, y, z)
    let ne: number, nw: number, se: number, sw: number
    if (self >= 1) ne = nw = se = sw = 1
    else {
      const hn = this.height(type, x, y, z - 1), hs = this.height(type, x, y, z + 1)
      const he = this.height(type, x + 1, y, z), hw = this.height(type, x - 1, y, z)
      ne = this.averageHeight(type, self, hn, he, x + 1, y, z - 1)
      nw = this.averageHeight(type, self, hn, hw, x - 1, y, z - 1)
      se = this.averageHeight(type, self, hs, he, x + 1, y, z + 1)
      sw = this.averageHeight(type, self, hs, hw, x - 1, y, z + 1)
    }
    const bottom = renderDown ? 0.001 : 0

    if (renderUp && !this.occludedByState(UP, Math.min(Math.min(nw, sw), Math.min(se, ne)), up)) {
      nw -= 0.001
      sw -= 0.001
      se -= 0.001
      ne -= 0.001
      const flow = this.flow(type, x, y, z, id)
      const u = [0, 0, 0, 0], v = [0, 0, 0, 0]
      let sprite: Sprite
      if (flow[0] === 0 && flow[1] === 0) {
        sprite = still
        u[0] = 0; v[0] = 0
        u[1] = 0; v[1] = 1
        u[2] = 1; v[2] = 1
        u[3] = 1; v[3] = 0
      }
      else {
        sprite = flowing
        const angle = f32(Math.atan2(flow[1]!, flow[0]!)) - Math.fround(1.5707964)
        const s = f32(Math.sin(angle)) * 0.25, c = f32(Math.cos(angle)) * 0.25
        u[0] = 0.5 + (-c - s); v[0] = 0.5 + (-c + s)
        u[1] = 0.5 + (-c + s); v[1] = 0.5 + (c + s)
        u[2] = 0.5 + (c + s); v[2] = 0.5 + (c - s)
        u[3] = 0.5 + (c - s); v[3] = 0.5 + (-c - s)
      }
      const topColor = scale(tint, SHADE[UP]!)
      this.fluidFace(layer, sprite, topColor, this.backwardUpFace(type, x, y + 1, z),
        [x, y + nw, z, x, y + sw, z + 1, x + 1, y + se, z + 1, x + 1, y + ne, z], [u[0]!, v[0]!, u[1]!, v[1]!, u[2]!, v[2]!, u[3]!, v[3]!])
    }
    if (renderDown) {
      this.fluidFace(layer, still, scale(tint, SHADE[DOWN]!), false,
        [x, y + bottom, z, x + 1, y + bottom, z, x + 1, y + bottom, z + 1, x, y + bottom, z + 1], [0, 0, 1, 0, 1, 1, 0, 1])
    }
    for (let face = NORTH; face <= EAST; face++) {
      let h0: number, h1: number, x0: number, z0: number, x1: number, z1: number, render: boolean, faceId: number
      switch (face) {
        case NORTH: h0 = nw; h1 = ne; x0 = x; x1 = x + 1; z0 = z + 0.001; z1 = z + 0.001; render = renderNorth; faceId = north; break
        case SOUTH: h0 = se; h1 = sw; x0 = x + 1; x1 = x; z0 = z + 1 - 0.001; z1 = z + 1 - 0.001; render = renderSouth; faceId = south; break
        case WEST: h0 = sw; h1 = nw; x0 = x + 0.001; x1 = x + 0.001; z0 = z + 1; z1 = z; render = renderWest; faceId = west; break
        default: h0 = ne; h1 = se; x0 = x + 1 - 0.001; x1 = x + 1 - 0.001; z0 = z; z1 = z + 1; render = renderEast; faceId = east
      }
      if (!render || this.occludedByState(face, Math.max(h0, h1), faceId)) continue
      let sprite = flowing
      let isOverlay = false
      if (overlay) {
        const nb = this.blocks[faceId]
        const np = this.structure.state(faceId).path
        if ((nb && nb.skip === SKIP_SAME && np !== 'powder_snow') || np.endsWith('_leaves')) {
          sprite = overlay
          isOverlay = true
        }
      }
      const side = face === NORTH || face === SOUTH ? SHADE[NORTH]! : SHADE[WEST]!
      this.fluidFace(layer, sprite, scale(tint, f32(SHADE[UP]! * side)), !isOverlay,
        [x0, y + h0, z0, x1, y + h1, z1, x1, y + bottom, z1, x0, y + bottom, z0], [0, (1 - h0) * 0.5, 0.5, (1 - h1) * 0.5, 0.5, 0.5, 0, 0.5])
    }
  }

  private averageHeight(type: number, self: number, h2: number, h1: number, cx: number, cy: number, cz: number): number {
    if (h1 >= 1 || h2 >= 1) return 1
    const w = [0, 0]
    if (h1 > 0 || h2 > 0) {
      const corner = this.height(type, cx, cy, cz)
      if (corner >= 1) return 1
      addWeighted(w, corner)
    }
    addWeighted(w, self)
    addWeighted(w, h1)
    addWeighted(w, h2)
    return f32(w[0]! / w[1]!)
  }

  // FlowingFluid.getFlow (x, z)
  private flow(type: number, x: number, y: number, z: number, id: number): number[] {
    let fx = 0, fz = 0
    const own = this.ownHeight(id)
    for (let face = NORTH; face <= EAST; face++) {
      const nx = x + DX[face]!, nz = z + DZ[face]!
      const neighbor = this.idAt(nx, y, nz)
      if (this.fluidType(neighbor) !== 0 && this.fluidType(neighbor) !== type) continue
      let nh = this.ownHeight(neighbor)
      let distance = 0
      if (nh === 0) {
        const below = this.idAt(nx, y - 1, nz)
        if (this.fluidType(below) === 0 || this.fluidType(below) === type) {
          nh = this.ownHeight(below)
          if (nh > 0) distance = own - (nh - MAX_FLUID_HEIGHT)
        }
      }
      else if (nh > 0) distance = own - nh
      if (distance !== 0) {
        fx += DX[face]! * distance
        fz += DZ[face]! * distance
      }
    }
    if (this.falling(id)) {
      for (let face = NORTH; face <= EAST; face++) {
        const nx = x + DX[face]!, nz = z + DZ[face]!
        if (this.solidFace(type, nx, y, nz, face) || this.solidFace(type, nx, y + 1, nz, face)) {
          const l = Math.sqrt(fx * fx + fz * fz)
          if (l >= 1e-5) {
            fx /= l
            fz /= l
          }
          else fx = fz = 0
          break
        }
      }
    }
    const l = Math.sqrt(fx * fx + fz * fz)
    if (l < 1e-5) return [0, 0]
    return [fx / l, fz / l]
  }

  private solidFace(type: number, x: number, y: number, z: number, d: number): boolean {
    const id = this.idAt(x, y, z)
    if (this.fluidType(id) === type) return false
    const path = this.structure.state(id).path
    if (path === 'ice' || path === 'frosted_ice') return false
    return this.stateIndex[id]! >= 0 && (this.data.flags(this.stateIndex[id]!) & (1 << (STURDY_SHIFT + d))) !== 0
  }

  // FluidState.shouldRenderBackwardUpFace: 上の 3x3 に、同じ液体でも不透明なブロックでもないものがあれば、上面の裏も描く
  private backwardUpFace(type: number, x: number, y: number, z: number): boolean {
    for (let ox = -1; ox <= 1; ox++) {
      for (let oz = -1; oz <= 1; oz++) {
        const id = this.idAt(x + ox, y, z + oz)
        if (this.fluidType(id) !== type && (this.flags[id]! & SOLID_RENDER) === 0) return true
      }
    }
    return false
  }

  private fluidFace(layer: number, sprite: Sprite, faceColor: number, backFace: boolean, p: number[], t: number[]): void {
    const c = [faceColor, faceColor, faceColor, faceColor]
    this.output.add(layer, p, t, c, sprite)
    if (backFace) {
      const bp = [p[0]!, p[1]!, p[2]!, p[9]!, p[10]!, p[11]!, p[6]!, p[7]!, p[8]!, p[3]!, p[4]!, p[5]!]
      const bt = [t[0]!, t[1]!, t[6]!, t[7]!, t[4]!, t[5]!, t[2]!, t[3]!]
      this.output.add(layer, bp, bt, c, sprite)
    }
  }

  // ---------- ほかのクラスから使う ----------

  /**
   * 特別な形のブロック (チェストなど) の四角形を書き出す。
   * 明るさは、ゲームがエンティティを描くときと同じ計算 (2 つの光の向きと法線) にする。
   * @param shade 明るさを付けるかどうか
   */
  addQuad(layer: number, positions: ArrayLike<number>, uvs: ArrayLike<number>, quadColor: number, sprite: Sprite, shade: boolean): void {
    let b = 1
    if (shade) {
      // Java の float と同じ計算
      const p = (i: number): number => f32(positions[i]!)
      const ax = f32(p(3) - p(0)), ay = f32(p(4) - p(1)), az = f32(p(5) - p(2))
      const bx = f32(p(6) - p(0)), by = f32(p(7) - p(1)), bz = f32(p(8) - p(2))
      const nx = f32(f32(ay * bz) - f32(az * by)), ny = f32(f32(az * bx) - f32(ax * bz)), nz = f32(f32(ax * by) - f32(ay * bx))
      const l = f32(Math.sqrt(f32(f32(f32(nx * nx) + f32(ny * ny)) + f32(nz * nz))))
      if (l > 0) {
        const x = f32(nx / l), y = f32(ny / l), z = f32(nz / l)
        const dot = (L: number[]): number => Math.max(0, f32(f32(f32(x * L[0]!) + f32(y * L[1]!)) + f32(z * L[2]!)))
        b = Math.min(1, f32(f32(f32(dot(LIGHT0) + dot(LIGHT1)) * f32(0.6)) + f32(0.4)))
      }
    }
    for (let i = 0; i < 12; i++) if (!Number.isFinite(positions[i]!)) return
    const c = scale(quadColor & 0xFFFFFF, b)
    this.output.add(layer, positions, uvs, [c, c, c, c], sprite)
  }

  /** 頂点ごとの色を決めてある四角形を書き出す */
  addColoredQuad(layer: number, positions: ArrayLike<number>, uvs: ArrayLike<number>, colors: ArrayLike<number>, sprite: Sprite): void {
    this.output.add(layer, positions, uvs, colors, sprite)
  }
}

function addWeighted(w: number[], h: number): void {
  if (h >= 0.8) {
    w[0]! += h * 10
    w[1]! += 10
  }
  else if (h >= 0) {
    w[0]! += h
    w[1]!++
  }
}

function pick(c: BiomeColorSet, kind: number): number {
  switch (kind) {
    case FOLIAGE: return c.foliage
    case DRY_FOLIAGE: return c.dryFoliage
    case WATER: return c.water
    default: return c.grass
  }
}

// タグ minecraft:bars (鉄格子と銅の格子)
function isBarsTag(state: BlockState): boolean {
  const p = state.path
  return p === 'iron_bars' || p.endsWith('copper_bars')
}

