// 構造物に含まれるエンティティのうち、建物の飾りに使われるもの (MarumaSign 本体の Entities) と、アイテム (本体の Items) を描く。
// 絵画、額縁 (中のアイテムも)、ディスプレイエンティティ (ブロック、アイテム、文字)、防具立て。生き物は描かない。
// アイテムは assets/minecraft/items の定義と models/item のモデルを、ゲームと同じ規則で読む
// (時刻や持ち方で変わる部分は、置かれたまま何もしていないときのもの)。ここは Node の試験でも使う
import type { BlockModels, ItemModel, StateModel, Variant } from './block-models.ts'
import { BlockState, DX, DY, DZ, NORTH, SOUTH, UP, WEST, EAST, namespaced } from './block-state.ts'
import type { StructureEntity, StructureSource } from './formats.ts'
import { JavaRandom } from './java-random.ts'
import { arr, child, field, list as jlist, num as jnum, numbers, obj, str as jstr, type JsonObject } from './json.ts'
import { type Compound, compound, int, list, str, type Tag } from './nbt.ts'
import { doublesOf, type SpecialModels, signSpec, yRot } from './special.ts'
import { parseText } from './sign-text.ts'
import { layerOf, type StructureMesher } from './structure-mesher.ts'
import { Transform } from './transform.ts'

// 2D の向きの番号 (南 0, 西 1, 北 2, 東 3) を方向にする
function direction2d(v: number): number {
  switch (v & 3) {
    case 1: return WEST
    case 2: return NORTH
    case 3: return EAST
    default: return SOUTH
  }
}

// 3D の向きの番号 (下 0, 上 1, 北 2, 南 3, 西 4, 東 5)
function direction3d(v: number): number {
  return v >= 0 && v < 6 ? v : NORTH
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

/** エンティティを 1 つ描く。描いたら true */
export function emitEntity(special: SpecialModels, mesher: StructureMesher, entity: StructureEntity): boolean {
  let id = entity.id
  if (!id) return false
  id = id.substring(id.indexOf(':') + 1).toLowerCase()
  // 間引いた構造物では、エンティティも同じ割合で小さくする
  const step = mesher.structure.step
  const base = Transform.identity().translate(entity.x / step, entity.y / step, entity.z / step).scale(1 / step, 1 / step, 1 / step)
  const source = mesher.structure.source
  switch (id) {
    case 'painting': painting(special, mesher, entity.nbt, base); return true
    case 'item_frame':
    case 'glow_item_frame': itemFrame(special, mesher, entity.nbt, base, id === 'glow_item_frame', source); return true
    case 'block_display': blockDisplay(special, mesher, entity.nbt, base); return true
    case 'item_display': itemDisplay(special, mesher, entity.nbt, base); return true
    case 'text_display': textDisplay(special, mesher, entity.nbt, base); return true
    case 'armor_stand': special.armorStand(mesher, entity.nbt, base); return true
    default: return false
  }
}

// ---------- 絵画 ----------

function painting(special: SpecialModels, mesher: StructureMesher, nbt: Compound, base: Transform): void {
  let variant = str(nbt.get('variant'), str(nbt.get('Motive'), 'minecraft:kebab'))
  if (nbt.get('variant') instanceof Map) variant = str(compound(nbt.get('variant')).get('asset_id'), 'minecraft:kebab')
  variant = variant.substring(variant.indexOf(':') + 1).toLowerCase()
  // 古い名前 (1.12 までは名前の先頭が大文字、統合版は同じ名前)
  if (variant === 'burningskull') variant = 'burning_skull'
  if (variant === 'donkeykong') variant = 'donkey_kong'
  if (variant === 'skullandroses') variant = 'skull_and_roses'
  let width = 1, height = 1
  let asset = 'minecraft:' + variant
  const def = Object.prototype.hasOwnProperty.call(special.assets.bundle.paintings, variant) ? special.assets.bundle.paintings[variant] : undefined
  if (def) {
    width = Math.max(1, Math.min(16, def[0]))
    height = Math.max(1, Math.min(16, def[1]))
    if (def[2]) asset = def[2]
  }
  const facing = nbt.has('facing') ? direction2d(int(nbt.get('facing'), 0)) : nbt.has('Facing') ? direction2d(int(nbt.get('Facing'), 0)) : direction2d(int(nbt.get('Direction'), 0))
  const t = base.copy().rotateY(180 - yRot(facing))
  const front = special.sprite('minecraft:painting/' + asset.substring(asset.indexOf(':') + 1))
  const back = special.sprite('minecraft:painting/back')
  const x0 = -width / 2, x1 = width / 2, y0 = -height / 2, y1 = height / 2, z = 0.03125
  // 表 (-Z 向き)。左右は絵の向きに合わせて逆になる
  quad(mesher, t, front, [x1, y0, -z, x0, y0, -z, x0, y1, -z, x1, y1, -z], [0, 1, 1, 1, 1, 0, 0, 0])
  // 裏と縁
  quad(mesher, t, back, [x0, y1, z, x0, y0, z, x1, y0, z, x1, y1, z], [0, 0, 0, 1, 1, 1, 1, 0])
  quad(mesher, t, back, [x0, y1, -z, x0, y1, z, x1, y1, z, x1, y1, -z], [0, 0, 0, 0.0625, 1, 0.0625, 1, 0])
  quad(mesher, t, back, [x0, y0, z, x0, y0, -z, x1, y0, -z, x1, y0, z], [0, 0, 0, 0.0625, 1, 0.0625, 1, 0])
  quad(mesher, t, back, [x1, y1, z, x1, y0, z, x1, y0, -z, x1, y1, -z], [0, 0, 0, 1, 0.0625, 1, 0.0625, 0])
  quad(mesher, t, back, [x0, y1, -z, x0, y0, -z, x0, y0, z, x0, y1, z], [0, 0, 0, 1, 0.0625, 1, 0.0625, 0])
}

// 四角形を 1 枚書き出す。表は頂点が反時計回りに見える側
function quad(mesher: StructureMesher, t: Transform, sprite: ReturnType<SpecialModels['sprite']>, corners: number[], uvsIn: number[]): void {
  const positions = new Float32Array(12)
  const uvs = uvsIn.slice()
  for (let v = 0; v < 4; v++) t.apply(corners[v * 3]!, corners[v * 3 + 1]!, corners[v * 3 + 2]!, positions, v * 3)
  if (t.flips()) {
    reverse(positions, 3)
    reverse(uvs, 2)
  }
  mesher.addQuad(layerOf(sprite.transparency(0, 0, 1, 1)), positions, uvs, 0xFFFFFF, sprite, true)
}

// ---------- 額縁 ----------

function itemFrame(special: SpecialModels, mesher: StructureMesher, nbt: Compound, base: Transform, glow: boolean, source: StructureSource): void {
  // 1.12 までは 2D の向きの番号だった
  const facing = source === 'legacy' ? direction2d(int(nbt.get('Facing'), int(nbt.get('Direction'), 0)))
    : direction3d(int(nbt.get('Facing'), int(nbt.get('facing'), NORTH)))
  const invisible = int(nbt.get('Invisible'), 0) !== 0
  const item = compound(nbt.get('Item'))
  const itemId = Items.itemId(item)
  const map = itemId === 'minecraft:filled_map'
  // ItemFrameRenderer: 壁から少し離して、向きに合わせて回す
  const t = base.copy().translate(DX[facing]! * 0.46875, DY[facing]! * 0.46875, DZ[facing]! * 0.46875)
  if (facing >= NORTH) t.rotateY(180 - yRot(facing))
  else t.rotateX(facing === UP ? -90 : 90).rotateY(180)
  if (!invisible) {
    const model = special.models.model(BlockState.of(glow ? 'minecraft:glow_item_frame' : 'minecraft:item_frame', { map: map ? 'true' : 'false' }))
    emitBlock(mesher, model, t.copy().translate(-0.5, -0.5, -0.5))
  }
  if (!itemId || map) return
  const it = t.copy().translate(0, 0, invisible ? 0.5 : 0.4375).rotateZ(int(nbt.get('ItemRotation'), 0) * 45).scale(0.5, 0.5, 0.5)
  special.items.emit(mesher, item, 'fixed', it)
}

// ブロックのモデルを、変換して書き出す (面の向きによる明るさだけ付ける)
function emitBlock(mesher: StructureMesher, model: StateModel, t: Transform): void {
  const variants: Variant[] = []
  model.collect(() => 0n, new JavaRandom(), variants)
  const flip = t.flips()
  for (const variant of variants) {
    for (const q of variant.quads) {
      const positions = new Float32Array(12)
      const uvs = new Float32Array(8)
      for (let v = 0; v < 4; v++) {
        const s = flip ? 3 - v : v
        t.apply(q.positions[s * 3]!, q.positions[s * 3 + 1]!, q.positions[s * 3 + 2]!, positions, v * 3)
        uvs[v * 2] = q.uvs[s * 2]!
        uvs[v * 2 + 1] = q.uvs[s * 2 + 1]!
      }
      mesher.addQuad(layerOf(q.transparency), positions, uvs, 0xFFFFFF, q.sprite, true)
    }
  }
}

// ---------- ディスプレイエンティティ ----------

// NBT の値を、JSON を読んだときと同じ形 (数は number) にする
function toJson(value: Tag | undefined, depth = 0): unknown {
  if (depth > 16) return null
  if (value instanceof Map) {
    const r: Record<string, unknown> = {}
    for (const [k, v] of value) if (k !== '__proto__') r[k] = toJson(v, depth + 1)
    return r
  }
  const nums = doublesOf(value)
  if (nums) return nums
  if (Array.isArray(value)) return value.map(v => toJson(v, depth + 1))
  if (typeof value === 'bigint') return Number(value)
  return value
}

// Display の向きと transformation
function display(nbt: Compound, base: Transform): Transform {
  const t = base.copy()
  const r = doublesOf(nbt.get('Rotation'))
  const yaw = r && r.length >= 2 ? r[0]! : 0
  const pitch = r && r.length >= 2 ? r[1]! : 0
  // billboard が fixed 以外 (カメラの方を向く) のものも、置いたときの向きで描く
  t.rotateY(-yaw).rotateX(pitch)
  const tr = nbt.get('transformation')
  if (tr instanceof Map || Array.isArray(tr) || tr instanceof Int32Array) return Items.withTransformation(t, { transformation: toJson(tr) })
  return t
}

function blockDisplay(special: SpecialModels, mesher: StructureMesher, nbt: Compound, base: Transform): void {
  const state = compound(nbt.get('block_state'))
  const props = new Map<string, string>()
  for (const [k, v] of compound(state.get('Properties'))) props.set(k, String(typeof v === 'bigint' ? v.toString() : v))
  const block = BlockState.of(str(state.get('Name'), 'minecraft:air'), props)
  if (block.isAir()) return
  const t = display(nbt, base)
  if (!t.finite()) return
  emitBlock(mesher, special.models.model(block), t)
}

function itemDisplay(special: SpecialModels, mesher: StructureMesher, nbt: Compound, base: Transform): void {
  const item = compound(nbt.get('item'))
  if (!Items.itemId(item)) return
  const t = display(nbt, base).rotateY(180)
  if (!t.finite()) return
  special.items.emit(mesher, item, str(nbt.get('item_display'), 'none'), t)
}

function textDisplay(special: SpecialModels, mesher: StructureMesher, nbt: Compound, base: Transform): void {
  const text = nbt.get('text')
  if (text === undefined) return
  const lineWidth = int(nbt.get('line_width'), 200)
  const background = nbt.has('background') ? int(nbt.get('background'), 0x40000000) : 0x40000000
  const opacity = int(nbt.get('text_opacity'), -1) & 0xFF
  const alignment = str(nbt.get('alignment'), 'center')
  const defaultBackground = int(nbt.get('default_background'), 0) !== 0
  const t = display(nbt, base)
  if (!t.finite()) return
  special.textDisplay(mesher, parseText(text), lineWidth, defaultBackground ? 0x40000000 : background, opacity === 0 ? 255 : opacity, alignment, t)
}

// ---------- アイテム ----------

export class Items {
  private readonly models: BlockModels
  private readonly special: SpecialModels

  constructor(models: BlockModels, special: SpecialModels) {
    this.models = models
    this.special = special
  }

  /** アイテムのデータ ({id, count, components} や {id, Count, tag}) の名前。なければ null */
  static itemId(item: Compound): string | null {
    const id = item.get('id')
    if (typeof id === 'string') return namespaced(id)
    const name = item.get('Name')
    if (typeof name === 'string') return namespaced(name)
    return null
  }

  static components(item: Compound): Compound {
    return compound(item.get('components'))
  }

  private definition(id: string): JsonObject {
    return obj(field(this.models.assets.bundle.items, id))
  }

  /**
   * アイテムを描く。
   * @param context 表示する場所 (fixed, ground, head, thirdperson_righthand など)
   * @param transform アイテムの位置 (この中心に、表示する場所ごとの変換をしたアイテムを置く)
   */
  emit(mesher: StructureMesher, item: Compound, context: string, transform: Transform): void {
    const id = Items.itemId(item)
    if (!id || id === 'minecraft:air') return
    const def = this.definition(id)
    if (!Object.keys(def).length) {
      // 定義のないアイテム (別の Mod のものなど) は、紫と黒の模様の立方体にする
      this.emitModel(mesher, 'minecraft:missing', [], Items.components(item), context, transform, {})
      return
    }
    // MarumaSign の看板の文字を持つ看板のアイテムは、ゲームでも看板と同じものが表示される
    if (id.endsWith('_sign') && !id.endsWith('_hanging_sign')) {
      let data = compound(Items.components(item).get('minecraft:block_entity_data'))
      if (!data.size) data = compound(compound(item.get('tag')).get('BlockEntityTag'))
      const spec = data.size ? signSpec(data, 'java') : null
      if (spec) {
        const model = this.models.itemModel('minecraft:item/' + id.substring(id.indexOf(':') + 1))
        this.special.nested.emitItem(spec, Items.withDisplay(transform, model, context))
        return
      }
    }
    this.emitNode(mesher, def, Items.components(item), context, transform, 0)
  }

  private emitNode(mesher: StructureMesher, node: JsonObject, components: Compound, context: string, transform: Transform, depth: number): void {
    if (depth > 16) return
    const type = jstr(node, 'type', 'minecraft:model').replace('minecraft:', '')
    switch (type) {
      case 'model':
        this.emitModel(mesher, jstr(node, 'model', 'minecraft:item/air'), jlist(node, 'tints'), components, context, transform, node)
        break
      case 'composite':
        for (const c of jlist(node, 'models').slice(0, 32)) this.emitNode(mesher, obj(c), components, context, transform, depth + 1)
        break
      case 'condition':
        this.emitNode(mesher, child(node, 'on_false'), components, context, transform, depth + 1)
        break
      case 'select': {
        const property = jstr(node, 'property', '').replace('minecraft:', '')
        let chosen: JsonObject | null = null
        for (const c of jlist(node, 'cases')) {
          const branch = obj(c)
          const when = field(branch, 'when')
          const values = Array.isArray(when) ? when : [when]
          for (const v of values) if (matchesSelect(property, String(v), context, components)) chosen = child(branch, 'model')
          if (chosen) break
        }
        chosen ??= child(node, 'fallback')
        if (Object.keys(chosen).length) this.emitNode(mesher, chosen, components, context, transform, depth + 1)
        break
      }
      case 'range_dispatch': {
        // 値は 0 (使っていない、時刻や方角が分からない) として選ぶ
        let chosen = child(node, 'fallback')
        let best = -Infinity
        for (const e of jlist(node, 'entries')) {
          const entry = obj(e)
          const threshold = jnum(entry, 'threshold', 0)
          if (threshold <= 0 && threshold >= best) {
            best = threshold
            chosen = child(entry, 'model')
          }
        }
        if (Object.keys(chosen).length) this.emitNode(mesher, chosen, components, context, transform, depth + 1)
        break
      }
      case 'special': {
        const t = Items.withDisplay(transform, this.models.itemModel(jstr(node, 'base', 'minecraft:item/air')), context)
        this.special.item(mesher, child(node, 'model'), components, Items.withTransformation(t, node))
        break
      }
      default:
        // empty, bundle/selected_item などは何も描かない
        break
    }
  }

  /** ノードの transformation (平行移動、左の回転、拡大、右の回転、または列優先の行列) を掛ける */
  static withTransformation(transform: Transform, node: JsonObject): Transform {
    const value = field(node, 'transformation')
    if (value === undefined || value === null) return transform
    const result = transform.copy()
    if (Array.isArray(value)) {
      const m = numbers(value, [])
      if (m.length === 16) {
        // Transformation の行列は列優先で書かれている
        result.multiply([m[0]!, m[4]!, m[8]!, m[12]!, m[1]!, m[5]!, m[9]!, m[13]!, m[2]!, m[6]!, m[10]!, m[14]!, m[3]!, m[7]!, m[11]!, m[15]!])
      }
      return result
    }
    const parts = obj(value)
    const translation = numbers(field(parts, 'translation'), [0, 0, 0])
    const sc = numbers(field(parts, 'scale'), [1, 1, 1])
    result.translate(translation[0] ?? 0, translation[1] ?? 0, translation[2] ?? 0)
    applyRotation(result, field(parts, 'left_rotation'))
    result.scale(sc[0] ?? 1, sc[1] ?? 1, sc[2] ?? 1)
    applyRotation(result, field(parts, 'right_rotation'))
    return result
  }

  /** ItemTransform.apply: 移動、回転 (X, Y, Z)、拡大のあと、モデルの中心を原点に合わせる */
  static withDisplay(transform: Transform, model: ItemModel, context: string): Transform {
    const result = transform.copy()
    const d = model.display.get(context)
    if (d) result.translate(d[3]!, d[4]!, d[5]!).rotateXYZ(d[0]!, d[1]!, d[2]!).scale(d[6]!, d[7]!, d[8]!)
    return result.translate(-0.5, -0.5, -0.5)
  }

  private emitModel(mesher: StructureMesher, modelName: string, tints: unknown[], components: Compound, context: string, transform: Transform, node: JsonObject): void {
    const model = this.models.itemModel(modelName)
    // 表示する場所ごとの変換のあとに、ノードの transformation を掛ける (ItemStackRenderState と同じ順)
    const t = Items.withTransformation(Items.withDisplay(transform, model, context), node)
    if (!t.finite()) return
    const flip = t.flips()
    for (const q of model.quads) {
      const color = q.tint >= 0 && q.tint < tints.length ? this.tintColor(obj(tints[q.tint]), components) : 0xFFFFFF
      const positions = new Float32Array(12)
      const uvs = new Float32Array(8)
      for (let v = 0; v < 4; v++) {
        const s = flip ? 3 - v : v
        t.apply(q.positions[s * 3]!, q.positions[s * 3 + 1]!, q.positions[s * 3 + 2]!, positions, v * 3)
        uvs[v * 2] = q.uvs[s * 2]!
        uvs[v * 2 + 1] = q.uvs[s * 2 + 1]!
      }
      mesher.addQuad(layerOf(q.transparency), positions, uvs, color, q.sprite, true)
    }
  }

  // アイテムの色 (ItemTintSource)。データで決まる色は、データがあればそれ、なければ既定の色
  private tintColor(tint: JsonObject, components: Compound): number {
    const type = jstr(tint, 'type', '').replace('minecraft:', '')
    switch (type) {
      case 'constant': return colorOf(field(tint, 'value'), 0xFFFFFF)
      case 'dye': {
        const dyed = components.get('minecraft:dyed_color')
        if (typeof dyed === 'number') return dyed & 0xFFFFFF
        if (dyed instanceof Map && typeof dyed.get('rgb') === 'number') return (dyed.get('rgb') as number) & 0xFFFFFF
        return colorOf(field(tint, 'default'), 0xFFFFFF)
      }
      case 'potion': {
        const contents = compound(components.get('minecraft:potion_contents'))
        const c = contents.get('custom_color')
        if (typeof c === 'number') return c & 0xFFFFFF
        return colorOf(field(tint, 'default'), 0xFFFFFF)
      }
      case 'grass':
        // GrassColor.get(温度, 雨の量)
        return this.special.grass(jnum(tint, 'temperature', 0.5), jnum(tint, 'downfall', 1))
      default:
        return colorOf(field(tint, 'default'), 0xFFFFFF)
    }
  }
}

function matchesSelect(property: string, value: string, context: string, components: Compound): boolean {
  if (property === 'display_context') return value === context
  if (property === 'trim_material') return value === str(compound(components.get('minecraft:trim')).get('material'))
  return false
}

// 回転は四元数 [x, y, z, w] か、{angle (ラジアン), axis}
function applyRotation(t: Transform, rotation: unknown): void {
  if (Array.isArray(rotation)) {
    const q = numbers(rotation, [])
    if (q.length === 4) t.rotateQuaternion(q[0]!, q[1]!, q[2]!, q[3]!)
  }
  else if (rotation && typeof rotation === 'object') {
    const aa = obj(rotation)
    const angle = jnum(aa, 'angle', 0)
    const axis = numbers(field(aa, 'axis'), [0, 1, 0])
    const l = Math.sqrt((axis[0] ?? 0) ** 2 + (axis[1] ?? 0) ** 2 + (axis[2] ?? 0) ** 2)
    if (l === 0) return
    const s = Math.sin(angle / 2) / l
    t.rotateQuaternion((axis[0] ?? 0) * s, (axis[1] ?? 0) * s, (axis[2] ?? 0) * s, Math.cos(angle / 2))
  }
}

// 色は 0xRRGGBB の数か、[r, g, b] (0 - 1)
function colorOf(value: unknown, fallback: number): number {
  if (typeof value === 'number') return Math.round(value) & 0xFFFFFF
  if (Array.isArray(value)) {
    const rgb = numbers(value, [])
    if (rgb.length >= 3) return (Math.round(rgb[0]! * 255) & 255) << 16 | (Math.round(rgb[1]! * 255) & 255) << 8 | (Math.round(rgb[2]! * 255) & 255)
  }
  return fallback
}

