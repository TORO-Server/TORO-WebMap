// ブロックのモデルのファイルでは形が決まらず、ゲームのコードで描かれるブロック (チェスト、旗、頭など) と、エンティティを描く
// (MarumaSign 本体の SpecialModels と同じ)。形は EntityModels (ゲームのモデルの定義から書き出したもの)、置き方は各ブロックの描き方
// (BlockEntityRenderer) と同じにする。ここは Node の試験でも使う
import { type GameAssets, Sprite } from './assets.ts'
import type { BlockModels, Variant } from './block-models.ts'
import type { BiomeColors } from './biomes.ts'
import { BlockState, CLOCKWISE, direction, DOWN, DX, DY, DYE_COLORS, DZ, EAST, NORTH, OPPOSITE, SOUTH, UP, WEST } from './block-state.ts'
import type { EntityModels } from './entity-models.ts'
import { emitEntity, Items } from './entities.ts'
import type { StructureSource } from './formats.ts'
import { JavaRandom, blockSeed } from './java-random.ts'
import { child, list as jlist, obj, str as jstr } from './json.ts'
import { type Compound, compound, int, list, str, type Tag } from './nbt.ts'
import { NestedSigns, parseSignSpec, type SignSpec } from './nested.ts'
import { DYE_TEXT, HALF_HEIGHT, HALF_WIDTH, parseText, type Run, SignTexts } from './sign-text.ts'
import { PlayerSkins } from './skins.ts'
import { LAYER_CUTOUT, LAYER_SOLID, layerOf, scale, SHADE, type SpecialRenderer, type StructureMesher } from './structure-mesher.ts'
import { Transform } from './transform.ts'

/** 染料の色 (DyeColor.getTextureDiffuseColor)。DYE_COLORS と同じ順 */
export const DYE_DIFFUSE = [0xF9FFFE, 0xF9801D, 0xC74EBD, 0x3AB3DA, 0xFED83D, 0x80C71F, 0xF38BAA, 0x474F52,
  0x9D9D97, 0x169C9C, 0x8932B8, 0x3C44AA, 0x835432, 0x5E7C16, 0xB02E26, 0x1D1D21]

// 1.20.4 までの旗の模様の短い名前
const PATTERN_CODES = new Map<string, string>()
{
  const pairs = ['b', 'base', 'bs', 'stripe_bottom', 'ts', 'stripe_top', 'ls', 'stripe_left', 'rs', 'stripe_right',
    'cs', 'stripe_center', 'ms', 'stripe_middle', 'drs', 'stripe_downright', 'dls', 'stripe_downleft', 'ss', 'small_stripes',
    'cr', 'cross', 'sc', 'straight_cross', 'ld', 'diagonal_left', 'rud', 'diagonal_up_right', 'lud', 'diagonal_up_left',
    'rd', 'diagonal_right', 'vh', 'half_vertical', 'vhr', 'half_vertical_right', 'hh', 'half_horizontal',
    'hhb', 'half_horizontal_bottom', 'bl', 'square_bottom_left', 'br', 'square_bottom_right', 'tl', 'square_top_left',
    'tr', 'square_top_right', 'bt', 'triangle_bottom', 'tt', 'triangle_top', 'bts', 'triangles_bottom',
    'tts', 'triangles_top', 'mc', 'circle', 'mr', 'rhombus', 'bo', 'border', 'cbo', 'curly_border', 'bri', 'bricks',
    'gra', 'gradient', 'gru', 'gradient_up', 'cre', 'creeper', 'sku', 'skull', 'flo', 'flower', 'moj', 'mojang',
    'glb', 'globe', 'pig', 'piglin', 'flw', 'flow', 'gus', 'guster']
  for (let i = 0; i < pairs.length; i += 2) PATTERN_CODES.set(pairs[i]!, pairs[i + 1]!)
}

// 作った絵 (旗の模様を重ねたものなど) を、同じ内容なら使い回す
const COMPOSED = new Map<string, Sprite>()
function composed(id: string): Sprite | undefined {
  return COMPOSED.get(id)
}
function remember(id: string, s: Sprite): void {
  if (s.pending) return
  if (COMPOSED.size >= 256) COMPOSED.delete(COMPOSED.keys().next().value!)
  COMPOSED.set(id, s)
}

/** 1 つの構造物で使う、看板の文字の絵と旗の絵の数の上限 (本体と同じ) */
export const MAX_TEXT_SPRITES = 64, MAX_BANNER_SPRITES = 64
/** 描くエンティティの数の上限 (本体と同じ) */
export const MAX_ENTITIES = 4096
/** 1 つの構造物の文字ディスプレイの絵の大きさの合計の上限 (ピクセル。まとめた画像が大きくなりすぎないように) */
export const MAX_TEXT_DISPLAY_PIXELS = 4 * 1024 * 1024

/** 数え上げ (stats) */
export interface SpecialCounts {
  blockEntities: number
  entities: number
  texts: number
  banners: number
  skins: number
}

function isChest(path: string): boolean {
  return path === 'chest' || path === 'trapped_chest' || path === 'ender_chest' || path.endsWith('copper_chest')
}

function isSkull(path: string): boolean {
  return path.endsWith('_skull') || (path.endsWith('_head') && path !== 'piston_head')
}

function num(v: Tag | undefined, def: number): number {
  if (typeof v === 'number') return v
  if (typeof v === 'bigint') return Number(v)
  return def
}

export function doublesOf(v: Tag | undefined): number[] | null {
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

/** Direction.toYRot (南 0, 西 90, 北 180, 東 270) */
export function yRot(d: number): number {
  switch (d) {
    case WEST: return 90
    case NORTH: return 180
    case EAST: return 270
    default: return 0
  }
}

function facingOf(state: BlockState): number {
  const d = direction(state.get('facing'))
  return d < 0 ? NORTH : d
}

function reverse(values: Float32Array | number[], stride: number): void {
  for (let i = 0; i < 2; i++) {
    for (let k = 0; k < stride; k++) {
      const t = values[i * stride + k]!
      values[i * stride + k] = values[(3 - i) * stride + k]!
      values[(3 - i) * stride + k] = t
    }
  }
}

function dyeIndex(name: string): number {
  const i = DYE_COLORS.indexOf(name)
  return i < 0 ? 0 : i
}

export class SpecialModels implements SpecialRenderer {
  readonly models: BlockModels
  readonly assets: GameAssets
  readonly entityModels: EntityModels
  readonly skins: PlayerSkins
  readonly signs: SignTexts
  readonly nested = new NestedSigns()
  readonly items: Items
  private readonly usedTexts = new Set<Sprite>()
  private readonly usedBanners = new Set<string>()
  private textDisplays = 0
  private textDisplayPixels = 0
  private source: StructureSource = 'java'
  readonly counts: SpecialCounts = { blockEntities: 0, entities: 0, texts: 0, banners: 0, skins: 0 }

  private readonly biomes: BiomeColors

  constructor(models: BlockModels, entityModels: EntityModels, biomes: BiomeColors) {
    this.models = models
    this.assets = models.assets
    this.entityModels = entityModels
    this.biomes = biomes
    this.skins = new PlayerSkins(this.assets)
    this.signs = new SignTexts(this.assets)
    this.items = new Items(models, this)
  }

  sprite(id: string): Sprite {
    return this.assets.sprite(id)
  }

  /** 温度と雨の量から草の色 (アイテムの grass の色) */
  grass(temperature: number, downfall: number): number {
    return this.biomes.grassAt(temperature, downfall)
  }

  handles(state: BlockState): boolean {
    const path = state.path
    if (!state.name.startsWith('minecraft:')) return false
    return isChest(path) || path.endsWith('shulker_box') || path.endsWith('_banner') || isSkull(path)
      || path === 'bell' || path === 'decorated_pot' || path === 'enchanting_table'
      || (path === 'lectern' && state.get('has_book') === 'true') || path === 'conduit'
      || path.endsWith('copper_golem_statue') || path === 'end_portal' || path === 'end_gateway'
      || path === 'moving_piston' || path.endsWith('_sign')
  }

  startPass(): void {
    this.textDisplays = 0
    this.textDisplayPixels = 0
    this.counts.blockEntities = 0
    this.counts.entities = 0
    this.nested.placements.length = 0
  }

  emit(mesher: StructureMesher, state: BlockState, entity: Compound | undefined, x: number, y: number, z: number): boolean {
    this.source = mesher.structure.source
    this.counts.blockEntities++
    try {
      return this.emitChecked(mesher, state, entity ?? new Map(), x, y, z)
    }
    catch {
      return false
    }
  }

  private emitChecked(mesher: StructureMesher, state: BlockState, entity: Compound, x: number, y: number, z: number): boolean {
    const path = state.path
    if (path.endsWith('_sign')) return this.signText(mesher, state, entity, x, y, z)
    if (isChest(path)) this.chest(mesher, state, x, y, z)
    else if (path.endsWith('shulker_box')) this.shulkerBox(mesher, state, x, y, z)
    else if (path.endsWith('_banner')) this.banner(mesher, state, entity, x, y, z)
    else if (isSkull(path)) this.skull(mesher, state, entity, x, y, z)
    else if (path === 'bell') this.model(mesher, 'bell', this.sprite('minecraft:entity/bell/bell_body'), Transform.identity(), x, y, z)
    else if (path === 'decorated_pot') this.pot(mesher, entity, Transform.identity().rotateYAround(180 - yRot(facingOf(state)), 0.5, 0.5, 0.5), x, y, z)
    else if (path === 'enchanting_table') {
      // 近くにプレイヤーがいないときの、閉じた本 (EnchantTableRenderer)
      const t = Transform.identity().translate(0.5, 0.75, 0.5).translate(0, 0.1, 0).rotateZ(80)
      this.model(mesher, 'book_closed', this.sprite('minecraft:entity/enchantment/enchanting_table_book'), t, x, y, z)
    }
    else if (path === 'lectern') {
      const r = yRot(CLOCKWISE[facingOf(state)]!)
      const t = Transform.identity().translate(0.5, 1.0625, 0.5).rotateY(-r).rotateZ(67.5).translate(0, -0.125, 0)
      this.model(mesher, 'book_lectern', this.sprite('minecraft:entity/enchantment/enchanting_table_book'), t, x, y, z)
    }
    else if (path === 'conduit') {
      this.model(mesher, 'conduit_shell', this.sprite('minecraft:entity/conduit/base'), Transform.identity().translate(0.5, 0.5, 0.5), x, y, z)
    }
    else if (path.endsWith('copper_golem_statue')) this.copperGolem(mesher, state, x, y, z)
    else if (path === 'end_portal' || path === 'end_gateway') this.endCube(mesher, path === 'end_portal', x, y, z)
    else if (path === 'moving_piston') this.movingPiston(mesher, entity, x, y, z)
    return false
  }

  // ---------- 看板の文字 ----------

  private signText(mesher: StructureMesher, state: BlockState, entity: Compound, x: number, y: number, z: number): boolean {
    const path = state.path
    const hanging = path.endsWith('_hanging_sign')
    const wall = path.includes('_wall_')
    const angle = wall ? yRot(facingOf(state)) : (Number.parseInt(state.get('rotation') ?? '0', 10) || 0) * 22.5
    // MarumaSign の看板 (吊り看板は対象外)。表と裏の行をつなげた文字が形式に合えば、板を消して中身を描く
    if (!hanging) {
      const spec = signSpec(entity, this.source)
      if (spec) {
        this.nested.emitSign(spec, angle, wall, [x, y, z], 1 / mesher.structure.step)
        return true
      }
    }
    for (let side = 0; side < 2; side++) {
      const text = signSide(entity, side === 0, this.source)
      if (!text) continue
      const [lines, dye, glowing] = text
      // AbstractSignRenderer.getDarkColor
      const dark = dye === 0 && glowing ? 0xF0EBCC : scale(dye, 0.4)
      const color = glowing ? dye : dark
      const outline = glowing ? dark : -1
      const sprite = this.signs.render(lines, hanging ? 9 : 10, hanging ? 60 : 90, color, outline)
      if (!sprite) continue
      // 違う文字の看板は 1 つずつ絵になるので、数に上限を設ける (まとめた画像が大きくなりすぎないように)
      if (!this.usedTexts.has(sprite)) {
        if (this.usedTexts.size >= MAX_TEXT_SPRITES) continue
        this.usedTexts.add(sprite)
        this.counts.texts = this.usedTexts.size
      }
      const t = Transform.identity()
      if (hanging) {
        t.translate(0.5, 0.9375, 0.5).rotateY(-angle).translate(0, -0.3125, 0)
        if (side === 1) t.rotateY(180)
        t.translate(0, -0.32, 0.073).scale(0.0140625, -0.0140625, 0.0140625)
      }
      else {
        t.translate(0.5, 0.5, 0.5).rotateY(-angle)
        if (wall) t.translate(0, -0.3125, -0.4375)
        if (side === 1) t.rotateY(180)
        t.translate(0, 0.33333334, 0.046666667).scale(0.010416667, -0.010416667, 0.010416667)
      }
      const w = HALF_WIDTH, h = HALF_HEIGHT
      const corners = [-w, -h, -w, h, w, h, w, -h]
      const uvs = [0, 0, 0, 1, 1, 1, 1, 0]
      const positions = new Float32Array(12)
      for (let v = 0; v < 4; v++) {
        t.apply(corners[v * 2]!, corners[v * 2 + 1]!, 0, positions, v * 3)
        positions[v * 3]! += x
        positions[v * 3 + 1]! += y
        positions[v * 3 + 2]! += z
      }
      // 表が文字の前 (文字の座標の +Z) を向くように、頂点の順を合わせる
      const front = [0, 0, 0], origin = [0, 0, 0]
      t.apply(0, 0, 1, front, 0)
      t.apply(0, 0, 0, origin, 0)
      const fx = front[0]! - origin[0]!, fy = front[1]! - origin[1]!, fz = front[2]! - origin[2]!
      const ax = positions[3]! - positions[0]!, ay = positions[4]! - positions[1]!, az = positions[5]! - positions[2]!
      const bx = positions[6]! - positions[0]!, by = positions[7]! - positions[1]!, bz = positions[8]! - positions[2]!
      const nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx
      if (nx * fx + ny * fy + nz * fz < 0) {
        reverse(positions, 3)
        reverse(uvs, 2)
      }
      // 光る文字は明るさを付けない
      mesher.addQuad(LAYER_CUTOUT, positions, uvs, 0xFFFFFF, sprite, !glowing)
    }
    return false
  }

  // ---------- 共通 ----------

  model(mesher: StructureMesher, name: string, sprite: Sprite, transform: Transform, x: number, y: number, z: number): void {
    this.emitQuads(mesher, this.entityModels.get(name), sprite, transform, x, y, z, 0xFFFFFF)
  }

  emitQuads(mesher: StructureMesher, quads: Float32Array[], sprite: Sprite, transform: Transform, x: number, y: number, z: number, color: number): void {
    const flip = transform.flips()
    const point = [0, 0, 0]
    for (const quad of quads) {
      const positions = new Float32Array(12)
      const uvs = new Float32Array(8)
      let minU = 1, minV = 1, maxU = 0, maxV = 0
      for (let v = 0; v < 4; v++) {
        const s = flip ? 3 - v : v
        transform.apply(quad[s * 5]!, quad[s * 5 + 1]!, quad[s * 5 + 2]!, point, 0)
        positions[v * 3] = point[0]! + x
        positions[v * 3 + 1] = point[1]! + y
        positions[v * 3 + 2] = point[2]! + z
        uvs[v * 2] = quad[s * 5 + 3]!
        uvs[v * 2 + 1] = quad[s * 5 + 4]!
        minU = Math.min(minU, uvs[v * 2]!)
        maxU = Math.max(maxU, uvs[v * 2]!)
        minV = Math.min(minV, uvs[v * 2 + 1]!)
        maxV = Math.max(maxV, uvs[v * 2 + 1]!)
      }
      mesher.addQuad(layerOf(sprite.transparency(minU, minV, maxU, maxV)), positions, uvs, color, sprite, true)
    }
  }

  // ---------- チェスト ----------

  private chest(mesher: StructureMesher, state: BlockState, x: number, y: number, z: number): void {
    const path = state.path
    const type = state.get('type') ?? 'single'
    let texture: string
    if (path === 'ender_chest') texture = 'ender'
    else {
      if (path.endsWith('copper_chest')) {
        const base = path.replace('waxed_', '').replace('_copper_chest', '').replace('copper_chest', '')
        texture = base ? 'copper_' + base : 'copper'
      }
      else {
        const d = new Date()
        const christmas = d.getMonth() + 1 === 12 && d.getDate() >= 24 && d.getDate() <= 26
        texture = christmas ? 'christmas' : path === 'trapped_chest' ? 'trapped' : 'normal'
      }
      if (type === 'left') texture += '_left'
      else if (type === 'right') texture += '_right'
    }
    const model = path === 'ender_chest' || type === 'single' ? 'chest' : type === 'left' ? 'chest_left' : 'chest_right'
    const t = Transform.identity().rotateYAround(-yRot(facingOf(state)), 0.5, 0, 0.5)
    this.model(mesher, model, this.sprite('minecraft:entity/chest/' + texture), t, x, y, z)
  }

  // ---------- シュルカーボックス ----------

  private shulkerBox(mesher: StructureMesher, state: BlockState, x: number, y: number, z: number): void {
    const path = state.path
    const color = path === 'shulker_box' ? '' : '_' + path.substring(0, path.length - '_shulker_box'.length)
    const facing = direction(state.get('facing') ?? 'up')
    const t = Transform.identity().translate(0.5, 0.5, 0.5).scale(0.9995, 0.9995, 0.9995)
    // Direction.getRotation
    switch (facing) {
      case DOWN: t.rotateX(180); break
      case NORTH: t.rotateX(90).rotateY(0).rotateZ(180); break
      case SOUTH: t.rotateX(90); break
      case WEST: t.rotateX(90).rotateZ(90); break
      case EAST: t.rotateX(90).rotateZ(-90); break
      default: break
    }
    t.scale(1, -1, -1).translate(0, -1, 0)
    this.model(mesher, 'shulker_box', this.sprite('minecraft:entity/shulker/shulker' + color), t, x, y, z)
  }

  // ---------- 旗 ----------

  private banner(mesher: StructureMesher, state: BlockState, entity: Compound, x: number, y: number, z: number): void {
    const path = state.path
    const wall = path.endsWith('_wall_banner')
    const base = dyeIndex(path.substring(0, path.length - (wall ? '_wall_banner' : '_banner').length))
    const angle = wall ? yRot(facingOf(state)) : (Number.parseInt(state.get('rotation') ?? '0', 10) || 0) * 22.5
    const t = Transform.identity().translate(0.5, 0, 0.5).rotateY(-angle).scale(0.6666667, -0.6666667, -0.6666667)
    const texture = this.bannerTexture(base, patterns(entity, this.source))
    this.model(mesher, wall ? 'banner_wall' : 'banner_standing', texture, t, x, y, z)
    this.model(mesher, wall ? 'banner_flag_wall' : 'banner_flag_standing', texture, t, x, y, z)
  }

  /** 旗の絵 (下地に模様を重ねたもの)。BannerRenderer は模様を 1 枚ずつ重ねて描く */
  bannerTexture(base: number, pats: [string, number][]): Sprite {
    let id = 'banner:' + base
    for (let i = 0; i < pats.length && i < 16; i++) id += '|' + pats[i]![0] + ':' + pats[i]![1]
    // 違う模様の旗は 1 つずつ絵になるので、数に上限を設ける。超えたら模様を付けない
    if (!this.usedBanners.has(id)) {
      if (this.usedBanners.size >= MAX_BANNER_SPRITES) return this.sprite('minecraft:entity/banner/banner_base')
      this.usedBanners.add(id)
      this.counts.banners = this.usedBanners.size
    }
    const hit = composed(id)
    if (hit) return hit
    const background = this.sprite('minecraft:entity/banner/banner_base')
    const width = background.width, height = background.height
    const pixels = background.firstFrame().slice()
    let pending = background.pending
    const layers: [string, number][] = [['base', base], ...pats.slice(0, 16)]
    for (const [name, color] of layers) {
      const mask = this.sprite('minecraft:entity/banner/' + name)
      if (mask.pending) pending = true
      if (mask.missing || mask.width !== width || mask.height !== height) continue
      const c = DYE_DIFFUSE[color] ?? 0xFFFFFF
      const src = mask.firstFrame()
      for (let i = 0; i < width * height; i++) {
        const o = i * 4
        const alpha = src[o + 3]!
        if (alpha === 0) continue
        const sr = Math.trunc(src[o]! * ((c >> 16) & 255) / 255)
        const sg = Math.trunc(src[o + 1]! * ((c >> 8) & 255) / 255)
        const sb = Math.trunc(src[o + 2]! * (c & 255) / 255)
        pixels[o] = Math.trunc((sr * alpha + pixels[o]! * (255 - alpha)) / 255)
        pixels[o + 1] = Math.trunc((sg * alpha + pixels[o + 1]! * (255 - alpha)) / 255)
        pixels[o + 2] = Math.trunc((sb * alpha + pixels[o + 2]! * (255 - alpha)) / 255)
        pixels[o + 3] = Math.max(pixels[o + 3]!, alpha)
      }
    }
    const sprite = new Sprite(id, width, height, [pixels], null, null, false, false, pending)
    remember(id, sprite)
    return sprite
  }

  // ---------- 頭 ----------

  private skull(mesher: StructureMesher, state: BlockState, entity: Compound, x: number, y: number, z: number): void {
    const path = state.path
    const wall = path.includes('_wall_')
    const kind = path.replace('_wall_skull', '').replace('_wall_head', '').replace('_skull', '').replace('_head', '')
    const t = Transform.identity()
    if (wall) {
      const facing = facingOf(state)
      t.translate(0.5 - DX[facing]! * 0.25, 0.25, 0.5 - DZ[facing]! * 0.25).rotateY(-yRot(OPPOSITE[facing]!)).scale(-1, -1, 1)
    }
    else {
      t.translate(0.5, 0, 0.5).rotateY(-(Number.parseInt(state.get('rotation') ?? '0', 10) || 0) * 22.5).scale(-1, -1, 1)
    }
    let model: string, texture: Sprite
    switch (kind) {
      case 'skeleton': model = 'skull_mob'; texture = this.sprite('minecraft:entity/skeleton/skeleton'); break
      case 'wither_skeleton': model = 'skull_mob'; texture = this.sprite('minecraft:entity/skeleton/wither_skeleton'); break
      case 'creeper': model = 'skull_mob'; texture = this.sprite('minecraft:entity/creeper/creeper'); break
      case 'zombie': model = 'skull_humanoid'; texture = this.sprite('minecraft:entity/zombie/zombie'); break
      case 'piglin': model = 'skull_piglin'; texture = this.sprite('minecraft:entity/piglin/piglin'); break
      case 'dragon': model = 'skull_dragon'; texture = this.sprite('minecraft:entity/enderdragon/dragon'); break
      default:
        model = 'skull_humanoid'
        texture = this.skins.skin(entity)
        this.counts.skins++
    }
    this.model(mesher, model, texture, t, x, y, z)
  }

  // ---------- 銅のゴーレムの像 ----------

  private copperGolem(mesher: StructureMesher, state: BlockState, x: number, y: number, z: number): void {
    const path = state.path.replace('waxed_', '')
    const oxidation = path.startsWith('exposed_') ? '_exposed' : path.startsWith('weathered_') ? '_weathered' : path.startsWith('oxidized_') ? '_oxidized' : ''
    const pose = state.get('copper_golem_pose') ?? state.get('pose') ?? 'standing'
    const t = Transform.identity().translate(0.5, 0, 0.5).rotateY(-yRot(OPPOSITE[facingOf(state)]!))
    this.model(mesher, 'copper_golem_' + pose, this.sprite('minecraft:entity/copper_golem/copper_golem' + oxidation), t, x, y, z)
  }

  // ---------- エンドポータル ----------

  // 星空は特別な描き方をするので、空の色と星の模様を重ねた絵で近づける
  private endCube(mesher: StructureMesher, portal: boolean, x: number, y: number, z: number): void {
    let sprite = composed('end_portal')
    if (!sprite) {
      const stars = this.sprite('minecraft:entity/end_portal/end_portal')
      const src = stars.firstFrame()
      const px = new Uint8Array(stars.width * stars.height * 4)
      for (let i = 0; i < stars.width * stars.height; i++) {
        const o = i * 4, a = src[o + 3]!
        px[o] = Math.trunc((src[o]! * a + 0x0B * (255 - a)) / 255)
        px[o + 1] = Math.trunc((src[o + 1]! * a + 0x16 * (255 - a)) / 255)
        px[o + 2] = Math.trunc((src[o + 2]! * a + 0x1E * (255 - a)) / 255)
        px[o + 3] = 255
      }
      sprite = new Sprite('end_portal', stars.width, stars.height, [px], null, null, false, false, stars.pending)
      remember('end_portal', sprite)
    }
    const y0 = portal ? 0.375 : 0, y1 = portal ? 0.75 : 1
    for (let face = 0; face < 6; face++) {
      if (portal && face > UP) continue
      const q = this.models.bakeQuad([0, y0 * 16, 0], [16, y1 * 16, 16], face, [0, 0, 16, 16], sprite)
      const p = q.positions.slice()
      for (let v = 0; v < 4; v++) {
        p[v * 3]! += x
        p[v * 3 + 1]! += y
        p[v * 3 + 2]! += z
      }
      mesher.addQuad(LAYER_SOLID, p, q.uvs, 0xFFFFFF, sprite, false)
    }
  }

  // ---------- 動いているピストンのブロック ----------

  private movingPiston(mesher: StructureMesher, entity: Compound, x: number, y: number, z: number): void {
    const sv = entity.get('blockState')
    if (!(sv instanceof Map)) return
    const props = new Map<string, string>()
    const source = sv.has('Properties') ? compound(sv.get('Properties')) : compound(sv.get('properties'))
    for (const [k, v] of source) props.set(k, String(typeof v === 'bigint' ? v.toString() : v))
    const name = sv.has('Name') ? str(sv.get('Name'), 'minecraft:air') : str(sv.get('id'), 'minecraft:air')
    const moved = BlockState.of(name, props)
    if (moved.isAir()) return
    // PistonMovingBlockEntity.getXOff: 伸びているときは progress - 1、縮んでいるときは 1 - progress だけ、向きの方へずらす
    const progress = num(entity.get('progress'), 1)
    const extending = int(entity.get('extending'), 0) !== 0
    const order = [DOWN, UP, NORTH, SOUTH, WEST, EAST]
    const d = order[Math.max(0, Math.min(5, int(entity.get('facing'), 0)))]!
    const amount = extending ? progress - 1 : 1 - progress
    const variants: Variant[] = []
    this.models.model(moved).collect(() => blockSeed(x, y, z), new JavaRandom(), variants)
    const ox = x + DX[d]! * amount, oy = y + DY[d]! * amount, oz = z + DZ[d]! * amount
    for (const variant of variants) {
      for (const quad of variant.quads) {
        const p = quad.positions.slice()
        for (let v = 0; v < 4; v++) {
          p[v * 3]! += ox
          p[v * 3 + 1]! += oy
          p[v * 3 + 2]! += oz
        }
        mesher.addQuad(layerOf(quad.transparency), p, quad.uvs, scale(0xFFFFFF, SHADE[quad.shadeDirection]!), quad.sprite, false)
      }
    }
  }

  // ---------- アイテムの特別なモデル (items の minecraft:special) ----------

  item(mesher: StructureMesher, model: Record<string, unknown>, components: Compound, t: Transform): void {
    try {
      const type = jstr(model, 'type', '').replace('minecraft:', '')
      const after = (s: string): string => s.substring(s.indexOf(':') + 1)
      switch (type) {
        case 'chest':
          this.emitQuads(mesher, this.entityModels.get('chest'), this.sprite('minecraft:entity/chest/' + after(jstr(model, 'texture', 'minecraft:normal'))), t, 0, 0, 0, 0xFFFFFF)
          break
        case 'shulker_box':
          this.emitQuads(mesher, this.entityModels.get('shulker_box'), this.sprite('minecraft:entity/shulker/' + after(jstr(model, 'texture', 'minecraft:shulker'))), t, 0, 0, 0, 0xFFFFFF)
          break
        case 'head': {
          const chosen = headModel(jstr(model, 'kind', 'skeleton'))
          const override = model.texture
          const texture = typeof override === 'string' ? this.sprite('minecraft:entity/' + after(override)) : this.sprite(chosen[1])
          this.emitQuads(mesher, this.entityModels.get(chosen[0]), texture, t, 0, 0, 0, 0xFFFFFF)
          break
        }
        case 'player_head': {
          const entity: Compound = new Map()
          const profile = components.get('minecraft:profile')
          if (profile !== undefined) entity.set('profile', profile)
          this.emitQuads(mesher, this.entityModels.get('skull_humanoid'), this.skins.skin(entity), t, 0, 0, 0, 0xFFFFFF)
          break
        }
        case 'banner': {
          const entity: Compound = new Map()
          const p = components.get('minecraft:banner_patterns')
          if (p !== undefined) entity.set('patterns', p)
          const texture = this.bannerTexture(dyeIndex(jstr(model, 'color', 'white')), patterns(entity, 'java'))
          this.emitQuads(mesher, this.entityModels.get('banner_standing'), texture, t, 0, 0, 0, 0xFFFFFF)
          this.emitQuads(mesher, this.entityModels.get('banner_flag_standing'), texture, t, 0, 0, 0, 0xFFFFFF)
          break
        }
        case 'decorated_pot': {
          const entity: Compound = new Map()
          const s = components.get('minecraft:pot_decorations')
          if (s !== undefined) entity.set('sherds', s)
          this.pot(mesher, entity, t, 0, 0, 0)
          break
        }
        case 'conduit':
          this.emitQuads(mesher, this.entityModels.get('conduit_shell'), this.sprite('minecraft:entity/conduit/base'), t, 0, 0, 0, 0xFFFFFF)
          break
        case 'copper_golem_statue': {
          const texture = jstr(model, 'texture', 'minecraft:textures/entity/copper_golem/copper_golem.png')
          const path = after(texture).replace('textures/', '').replace('.png', '')
          this.emitQuads(mesher, this.entityModels.get('copper_golem_' + jstr(model, 'pose', 'standing')), this.sprite('minecraft:' + path), t, 0, 0, 0, 0xFFFFFF)
          break
        }
        default:
          // 盾とトライデントは描かない
          break
      }
    }
    catch { /* 描けないものは描かない */ }
  }

  // 飾り壺 (変換は呼ぶ側で決める)
  private pot(mesher: StructureMesher, entity: Compound, t: Transform, x: number, y: number, z: number): void {
    const base = this.sprite('minecraft:entity/decorated_pot/decorated_pot_base')
    this.emitQuads(mesher, this.entityModels.get('pot_neck'), base, t, x, y, z, 0xFFFFFF)
    this.emitQuads(mesher, this.entityModels.get('pot_top'), base, t, x, y, z, 0xFFFFFF)
    this.emitQuads(mesher, this.entityModels.get('pot_bottom'), base, t, x, y, z, 0xFFFFFF)
    // sherds: 後ろ、左、右、前 の順の陶片のアイテム
    const sherds = list(entity.get('sherds'))
    const sides = ['back', 'left', 'right', 'front']
    for (let i = 0; i < 4; i++) {
      let item = i < sherds.length ? String(sherds[i]) : 'minecraft:brick'
      item = item.substring(item.indexOf(':') + 1)
      let side = this.sprite('minecraft:entity/decorated_pot/decorated_pot_side')
      if (item.endsWith('_pottery_sherd')) {
        const pattern = this.sprite('minecraft:entity/decorated_pot/' + item.replace('_pottery_sherd', '_pottery_pattern'))
        if (!pattern.missing) side = pattern
      }
      this.emitQuads(mesher, this.entityModels.get('pot_' + sides[i]), side, t, x, y, z, 0xFFFFFF)
    }
  }

  // ---------- 文字ディスプレイ ----------

  textDisplay(mesher: StructureMesher, runs: Run[], lineWidth: number, background: number, opacity: number, alignment: string, transform: Transform): void {
    // 文字ディスプレイは 1 つずつ絵になるので、数に上限を設ける
    if (this.textDisplays >= MAX_TEXT_SPRITES) return
    this.textDisplays++
    const block = this.signs.renderBlock(runs, lineWidth, alignment, background, opacity)
    const { sprite, width, height } = block
    this.textDisplayPixels += sprite.width * sprite.height
    if (this.textDisplayPixels > MAX_TEXT_DISPLAY_PIXELS) return
    // TextDisplayRenderer: 半回転し、(-0.025) 倍にして、文字の塊の下の中央を原点にする
    const t = transform.copy().rotateY(180).scale(-0.025, -0.025, -0.025).translate(1 - (width - 1) / 2, -(height - 1), 0).translate(-1, -1, 0)
    const corners = [0, 0, 0, height, width, height, width, 0]
    const uvs = [0, 0, 0, 1, 1, 1, 1, 0]
    const positions = new Float32Array(12)
    for (let v = 0; v < 4; v++) t.apply(corners[v * 2]!, corners[v * 2 + 1]!, 0, positions, v * 3)
    const layer = layerOf(sprite.transparency(0, 0, 1, 1))
    // 文字ディスプレイは裏からも見える
    mesher.addQuad(layer, positions, uvs, 0xFFFFFF, sprite, false)
    const back = new Float32Array(12), backUvs = new Float32Array(8)
    for (let v = 0; v < 4; v++) {
      back.set(positions.subarray((3 - v) * 3, (3 - v) * 3 + 3), v * 3)
      backUvs[v * 2] = uvs[(3 - v) * 2]!
      backUvs[v * 2 + 1] = uvs[(3 - v) * 2 + 1]!
    }
    mesher.addQuad(layer, back, backUvs, 0xFFFFFF, sprite, false)
  }

  // ---------- 防具立て ----------

  armorStand(mesher: StructureMesher, nbt: Compound, base: Transform): void {
    const rotation = doublesOf(nbt.get('Rotation'))
    const yaw = rotation && rotation.length > 0 ? rotation[0]! : 0
    const small = int(nbt.get('Small'), 0) !== 0
    const invisible = int(nbt.get('Invisible'), 0) !== 0
    const showArms = int(nbt.get('ShowArms'), 0) !== 0
    const basePlate = int(nbt.get('NoBasePlate'), 0) === 0
    const pose = compound(nbt.get('Pose'))
    const angles = (name: string, x: number, y: number, z: number): number[] => {
      const v = doublesOf(pose.get(name))
      return v && v.length >= 3 ? [v[0]!, v[1]!, v[2]!] : [x, y, z]
    }
    const head = angles('Head', 0, 0, 0), body = angles('Body', 0, 0, 0)
    const leftArm = angles('LeftArm', -10, 0, -10), rightArm = angles('RightArm', -15, 0, 10)
    const leftLeg = angles('LeftLeg', -1, 0, -1), rightLeg = angles('RightLeg', 1, 0, 1)
    // LivingEntityRenderer: 向きに回し、上下と左右を返して、足元を原点にする
    const root = base.copy()
    if (small) root.scale(0.5, 0.5, 0.5)
    root.rotateY(180 - yaw).scale(-1, -1, 1).translate(0, -1.501, 0)
    if (!invisible) {
      const texture = this.sprite('minecraft:entity/armorstand/armorstand')
      this.part(mesher, 'armor_stand.head', head, root, texture, 0xFFFFFF)
      this.part(mesher, 'armor_stand.body', body, root, texture, 0xFFFFFF)
      if (showArms) {
        this.part(mesher, 'armor_stand.right_arm', rightArm, root, texture, 0xFFFFFF)
        this.part(mesher, 'armor_stand.left_arm', leftArm, root, texture, 0xFFFFFF)
      }
      this.part(mesher, 'armor_stand.right_leg', rightLeg, root, texture, 0xFFFFFF)
      this.part(mesher, 'armor_stand.left_leg', leftLeg, root, texture, 0xFFFFFF)
      this.part(mesher, 'armor_stand.right_body_stick', body, root, texture, 0xFFFFFF)
      this.part(mesher, 'armor_stand.left_body_stick', body, root, texture, 0xFFFFFF)
      this.part(mesher, 'armor_stand.shoulder_stick', body, root, texture, 0xFFFFFF)
      if (basePlate) this.part(mesher, 'armor_stand.base_plate', [0, -yaw, 0], root, texture, 0xFFFFFF)
    }
    // 装備 (1.21.5 から equipment、それより前は ArmorItems [足, 脚, 胴, 頭] と HandItems [利き手, 反対の手])
    const equipment = new Map(compound(nbt.get('equipment')))
    const armor = list(nbt.get('ArmorItems'))
    const slots = ['feet', 'legs', 'chest', 'head']
    for (let i = 0; i < armor.length && i < 4; i++) if (!equipment.has(slots[i]!)) equipment.set(slots[i]!, armor[i]!)
    const hands = list(nbt.get('HandItems'))
    if (hands.length > 0 && !equipment.has('mainhand')) equipment.set('mainhand', hands[0]!)
    if (hands.length > 1 && !equipment.has('offhand')) equipment.set('offhand', hands[1]!)
    const poses = [head, body, rightArm, leftArm, rightLeg, leftLeg]
    for (const slot of ['head', 'chest', 'legs', 'feet']) {
      const item = compound(equipment.get(slot))
      const id = Items.itemId(item)
      if (!id) continue
      const material = armorMaterial(id, slot, Items.components(item))
      if (material) this.armorLayers(mesher, slot, material, Items.components(item), poses, root)
      else if (slot === 'head') {
        // 頭に載せたアイテム (CustomHeadLayer)
        const t = this.partTransform(root, 'armor_stand.head', head).translate(0, -0.25, 0).rotateY(180).scale(0.625, -0.625, -0.625)
        this.items.emit(mesher, item, 'head', t)
      }
    }
    if (showArms) {
      for (let side = 0; side < 2; side++) {
        const item = compound(equipment.get(side === 0 ? 'mainhand' : 'offhand'))
        if (!Items.itemId(item)) continue
        // ItemInHandLayer: 腕の先に、腕に沿わせて持たせる
        const left = side === 1
        const t = this.partTransform(root, left ? 'armor_stand.left_arm' : 'armor_stand.right_arm', left ? leftArm : rightArm)
          .rotateX(-90).rotateY(180).translate((left ? -1 : 1) / 16, 0.125, -0.625)
        this.items.emit(mesher, item, left ? 'thirdperson_lefthand' : 'thirdperson_righthand', t)
      }
    }
  }

  // 部分の変換 (ModelPart.translateAndRotate: 位置に動かし、Z, Y, X の順の回転)
  private partTransform(root: Transform, part: string, a: number[]): Transform {
    const p = this.entityModels.pivot(part)
    return root.copy().translate(p[0]! / 16, p[1]! / 16, p[2]! / 16).rotateZ(a[2]!).rotateY(a[1]!).rotateX(a[0]!)
  }

  private part(mesher: StructureMesher, part: string, a: number[], root: Transform, texture: Sprite, color: number): void {
    this.emitQuads(mesher, this.entityModels.get(part), texture, this.partTransform(root, part, a), 0, 0, 0, color)
  }

  // HumanoidArmorLayer: 防具の層を、部分ごとに防具立ての姿勢で描く
  private armorLayers(mesher: StructureMesher, slot: string, material: string, components: Compound, poses: number[][], root: Transform): void {
    const json = obj(this.assets.bundle.equipment['minecraft:' + material])
    if (!Object.keys(json).length) return
    const layerType = slot === 'legs' ? 'humanoid_leggings' : 'humanoid'
    const layers = jlist(child(json, 'layers'), layerType)
    const parts = ['head', 'body', 'right_arm', 'left_arm', 'right_leg', 'left_leg']
    for (const item of layers) {
      const layer = obj(item)
      const texture = jstr(layer, 'texture', '')
      let color = 0xFFFFFF
      if (layer.dyeable && typeof layer.dyeable === 'object') {
        const dyed = components.get('minecraft:dyed_color')
        if (typeof dyed === 'number') color = dyed & 0xFFFFFF
        else if (dyed instanceof Map && typeof dyed.get('rgb') === 'number') color = (dyed.get('rgb') as number) & 0xFFFFFF
        else {
          const undyed = obj(layer.dyeable).color_when_undyed
          color = typeof undyed === 'number' ? Math.round(undyed) & 0xFFFFFF : 0xFFFFFF
        }
      }
      const sprite = this.sprite('minecraft:entity/equipment/' + layerType + '/' + texture.substring(texture.indexOf(':') + 1))
      for (let p = 0; p < parts.length; p++) {
        const name = 'armor_stand_armor_' + slot + '.' + parts[p]
        if (!this.entityModels.has(name)) continue
        this.emitQuads(mesher, this.entityModels.get(name), sprite, this.partTransform(root, name, poses[p]!), 0, 0, 0, color)
      }
    }
  }

  // ---------- エンティティ ----------

  emitEntities(mesher: StructureMesher): void {
    let count = 0
    for (const entity of mesher.structure.entities) {
      if (++count > MAX_ENTITIES) break
      try {
        if (emitEntity(this, mesher, entity)) this.counts.entities++
      }
      catch { /* 1 つの失敗で他を止めない */ }
    }
  }
}

// 看板のデータの文字 (表、裏の順に行をつなげたもの) が MarumaSign の形式なら、その内容。そうでなければ null
export function signSpec(entity: Compound, source: StructureSource): SignSpec | null {
  let text = ''
  for (let side = 0; side < 2; side++) {
    const s = signSide(entity, side === 0, source)
    if (s) for (const line of s[0]) for (const run of line) text += run.text
  }
  return parseSignSpec(text)
}

// 看板の片面の [行の並び, 色 (RGB), 光るか]。書かれていなければ null
function signSide(entity: Compound, front: boolean, source: StructureSource): [Run[][], number, boolean] | null {
  const lines: Run[][] = []
  let color = 0
  let glowing = false
  const java = entity.get(front ? 'front_text' : 'back_text')
  const bedrockText = entity.get(front ? 'FrontText' : 'BackText')
  if (java instanceof Map) {
    for (const line of list(java.get('messages')).slice(0, 8)) lines.push(parseText(line))
    color = dyeTextColor(str(java.get('color'), 'black'))
    glowing = int(java.get('has_glowing_text'), 0) !== 0
  }
  else if (bedrockText instanceof Map || (front && typeof entity.get('Text') === 'string' && source === 'bedrock')) {
    const t = bedrockText instanceof Map ? bedrockText : entity
    for (const line of str(t.get('Text')).split('\n').slice(0, 8)) lines.push(parseText(line))
    color = int(t.get('SignTextColor'), 0xFF000000 | 0) & 0xFFFFFF
    glowing = int(t.get('IgnoreLighting'), 0) !== 0
  }
  else if (front && (entity.has('Text1') || entity.has('Text2'))) {
    for (let i = 1; i <= 4; i++) lines.push(parseText(entity.get('Text' + i) ?? ''))
    color = dyeTextColor(str(entity.get('Color'), 'black'))
    glowing = int(entity.get('GlowingText'), 0) !== 0
  }
  else return null
  while (lines.length > 4) lines.pop()
  return [lines, color, glowing]
}

function dyeTextColor(name: string): number {
  const i = DYE_COLORS.indexOf(name)
  return i >= 0 ? DYE_TEXT[i]! : 0
}

// 模様の一覧 ([模様の名前, 色の番号])
function patterns(entity: Compound, source: StructureSource): [string, number][] {
  const result: [string, number][] = []
  // 1.20.5 から: patterns: [{color: "red", pattern: "minecraft:creeper"}]
  for (const item of list(entity.get('patterns')).slice(0, 64)) {
    const layer = compound(item)
    const pattern = layer.get('pattern')
    let name = typeof pattern === 'string' ? pattern : str(compound(pattern).get('asset_id'))
    name = name.substring(name.indexOf(':') + 1)
    if (!/^[a-z0-9_/.-]+$/.test(name)) continue
    result.push([name, dyeIndex(str(layer.get('color'), 'white'))])
  }
  // 1.20.4 まで: Patterns: [{Color: 番号, Pattern: "cre"}]。1.12 までと統合版は色の番号が逆の順
  for (const item of list(entity.get('Patterns')).slice(0, 64)) {
    const layer = compound(item)
    const code = str(layer.get('Pattern'))
    const name = PATTERN_CODES.get(code) ?? code
    if (!/^[a-z0-9_/.-]+$/.test(name)) continue
    let color = int(layer.get('Color'), 0) & 15
    if (source !== 'java') color = 15 - color
    result.push([name, color])
  }
  return result
}

// 頭の種類ごとの [モデル, テクスチャ]
function headModel(kind: string): [string, string] {
  switch (kind) {
    case 'wither_skeleton': return ['skull_mob', 'minecraft:entity/skeleton/wither_skeleton']
    case 'creeper': return ['skull_mob', 'minecraft:entity/creeper/creeper']
    case 'zombie': return ['skull_humanoid', 'minecraft:entity/zombie/zombie']
    case 'piglin': return ['skull_piglin', 'minecraft:entity/piglin/piglin']
    case 'dragon': return ['skull_dragon', 'minecraft:entity/enderdragon/dragon']
    case 'player': return ['skull_humanoid', 'minecraft:entity/player/wide/steve']
    default: return ['skull_mob', 'minecraft:entity/skeleton/skeleton']
  }
}

// 防具の素材 (equipment の名前)。防具でなければ null
function armorMaterial(id: string, slot: string, components: Compound): string | null {
  const equippable = compound(components.get('minecraft:equippable'))
  const asset = equippable.get('asset_id')
  if (typeof asset === 'string') return asset.substring(asset.indexOf(':') + 1)
  const path = id.substring(id.indexOf(':') + 1)
  if (path === 'turtle_helmet') return 'turtle_scute'
  const pieces = ['_helmet', '_chestplate', '_leggings', '_boots']
  const slots = ['head', 'chest', 'legs', 'feet']
  for (let i = 0; i < 4; i++) {
    if (path.endsWith(pieces[i]!) && slots[i] === slot) {
      const material = path.substring(0, path.length - pieces[i]!.length)
      return material === 'golden' ? 'gold' : material
    }
  }
  return null
}

