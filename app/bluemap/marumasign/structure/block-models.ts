// ブロックの状態から、描く四角形 (ブロックの角を原点とし、1 ブロックが 1 の座標) を作る (MarumaSign 本体の BlockModels と同じ)。
// Minecraft の blockstates と models の JSON を、ゲームと同じ規則で読む
// (variants / multipart、モデルの継承、要素の回転と拡大、回転のときのテクスチャの固定 (uvlock)、面の省き方 (cullface)、tintindex)
// ここは Node の試験でも使う
import { type GameAssets, MISSING, type Sprite, TRANSLUCENT } from './assets.ts'
import type { BlockData } from './block-data.ts'
import { BlockState, DOWN, direction, EAST, NORTH, SOUTH, UP, WEST } from './block-state.ts'
import { JavaRandom } from './java-random.ts'
import { bool, child, field, int, list, num, numbersOf, obj, str, type JsonObject } from './json.ts'

export const NORMALS = [[0, -1, 0], [0, 1, 0], [0, 0, -1], [0, 0, 1], [-1, 0, 0], [1, 0, 0]] as const

// FaceInfo: 面ごとの 4 頂点が、要素の最小 (0) と最大 (1) のどちらを使うか (x, y, z)
const FACE_INFO = [
  [[0, 0, 1], [0, 0, 0], [1, 0, 0], [1, 0, 1]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[1, 1, 0], [1, 0, 0], [0, 0, 0], [0, 1, 0]],
  [[0, 1, 1], [0, 0, 1], [1, 0, 1], [1, 1, 1]],
  [[0, 1, 0], [0, 0, 0], [0, 0, 1], [0, 1, 1]],
  [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
] as const

/** 描く四角形 1 枚 */
export interface Quad {
  /** 4 頂点の x, y, z */
  positions: Float32Array
  /** 4 頂点の u, v (テクスチャの中の 0 - 1) */
  uvs: Float32Array
  sprite: Sprite
  /** 隣のブロックで隠れるときに省く方向。省かない面は -1 */
  cull: number
  /** 面の向き (最も近い方向) */
  direction: number
  /** 面の向きによる明るさに使う方向 */
  shadeDirection: number
  tint: number
  transparency: number
}

export interface Variant {
  quads: Quad[]
  ambientOcclusion: boolean
}

export class Choice {
  readonly variants: Variant[]
  readonly weights: number[]
  readonly total: number

  constructor(variants: Variant[], weights: number[]) {
    this.variants = variants
    this.weights = weights
    this.total = weights.reduce((a, b) => a + b, 0)
  }

  pick(random: JavaRandom): Variant {
    if (this.variants.length === 1) return this.variants[0]!
    let selection = random.nextInt(this.total)
    for (let i = 0; i < this.variants.length; i++) {
      selection -= this.weights[i]!
      if (selection < 0) return this.variants[i]!
    }
    return this.variants[this.variants.length - 1]!
  }
}

export class StateModel {
  static readonly EMPTY = new StateModel([], false)
  readonly choices: Choice[]
  readonly multipart: boolean

  constructor(choices: Choice[], multipart: boolean) {
    this.choices = choices
    this.multipart = multipart
  }

  /** 位置ごとの乱数がいるか (いらなければ seed を計算しない) */
  get random(): boolean {
    return this.multipart || (this.choices.length > 0 && this.choices[0]!.variants.length > 1)
  }

  /** 位置で決まる乱数で、描くモデルを選ぶ (ModelBlockRenderer と同じ選び方) */
  collect(seed: () => bigint, random: JavaRandom, output: Variant[]): void {
    if (!this.choices.length) return
    if (!this.random) {
      output.push(this.choices[0]!.variants[0]!)
      return
    }
    random.setSeed(seed())
    if (!this.multipart) {
      output.push(this.choices[0]!.pick(random))
      return
    }
    const partSeed = random.nextLong()
    for (const c of this.choices) {
      random.setSeed(partSeed)
      output.push(c.pick(random))
    }
  }
}

/** アイテムのモデル: 四角形と、表示する場所ごとの変換 ([回転 x, y, z, 移動 x, y, z, 拡大 x, y, z]) */
export interface ItemModel {
  quads: Quad[]
  display: Map<string, number[]>
}

// ブロックではないが、ゲームがブロックの状態のモデルで描くもの (額縁)
const ENTITY_STATES = new Set(['minecraft:item_frame', 'minecraft:glow_item_frame'])

const IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1]

interface ResolvedModel {
  elements: unknown[] | null
  textures: Map<string, unknown>
  ambientOcclusion: boolean | null
}

export class BlockModels {
  readonly assets: GameAssets
  readonly data: BlockData
  private readonly states = new Map<string, StateModel>()
  private readonly baked = new Map<string, Variant>()
  private readonly itemModels = new Map<string, ItemModel>()
  private sharedMissing: StateModel | null = null
  /** モデルが見つからなかったブロック (確かめる用) */
  readonly missing = new Set<string>()

  constructor(assets: GameAssets, data: BlockData) {
    this.assets = assets
    this.data = data
  }

  sprite(id: string): Sprite {
    return this.assets.sprite(id)
  }

  /** 回さない面 1 枚 (エンドポータルなど) */
  bakeQuad(from: number[], to: number[], face: number, uv: number[], sprite: Sprite): Quad {
    return bakeFace(from, to, face, uv, 0, sprite, false, -1, -1, null, null, IDENTITY, false)
  }

  model(input: BlockState): StateModel {
    // 表にあるブロックは性質をそろえた状態で覚える。表にないブロックは紫と黒の立方体 (覚えない)
    let state = input
    const block = this.data.block(input.name)
    if (!block && !ENTITY_STATES.has(input.name)) {
      if (this.missing.size < 256) this.missing.add(input.name)
      return this.sharedMissing ??= this.missingModel()
    }
    if (block) state = this.data.complete(block, input)
    const key = state.toString()
    let model = this.states.get(key)
    if (!model) {
      try {
        model = this.build(state)
      }
      catch {
        model = this.missingModel()
      }
      this.states.set(key, model)
    }
    return model
  }

  private missingModel(): StateModel {
    const quads: Quad[] = []
    for (let face = 0; face < 6; face++) quads.push(bakeFace([0, 0, 0], [16, 16, 16], face, null, 0, MISSING, false, -1, face, null, null, IDENTITY, false))
    return new StateModel([new Choice([{ quads, ambientOcclusion: true }], [1])], false)
  }

  private file(kind: 'blockstates' | 'models', name: string): JsonObject {
    const key = name.indexOf(':') >= 0 ? name : 'minecraft:' + name
    const table = kind === 'blockstates' ? this.assets.bundle.blockstates : this.assets.bundle.models
    return obj(field(table, key))
  }

  private build(state: BlockState): StateModel {
    const file = this.file('blockstates', state.name)
    if (!Object.keys(file).length) {
      if (this.missing.size < 256) this.missing.add(state.name)
      return this.missingModel()
    }
    const choices: Choice[] = []
    let multipart = false
    const variants = child(file, 'variants')
    const variantKeys = Object.keys(variants)
    if (variantKeys.length) {
      let selected: unknown = undefined
      for (const k of variantKeys) if (matchesVariant(state, k)) selected = variants[k]
      if (selected !== undefined) choices.push(this.choice(selected))
    }
    const parts = list(file, 'multipart')
    if (parts.length) {
      multipart = true
      for (const item of parts) {
        const part = obj(item)
        if (field(part, 'when') !== undefined && !matchesCondition(state, child(part, 'when'), 0)) continue
        choices.push(this.choice(field(part, 'apply')))
      }
    }
    if (!choices.length) return !variantKeys.length && !parts.length ? this.missingModel() : StateModel.EMPTY
    return new StateModel(choices, multipart || choices.length > 1)
  }

  private choice(value: unknown): Choice {
    const items = Array.isArray(value) ? value : [value]
    const variants: Variant[] = [], weights: number[] = []
    for (const item of items.slice(0, 64)) {
      const v = obj(item)
      variants.push(this.bakeVariant(v))
      weights.push(Math.max(1, int(v, 'weight', 1)))
    }
    if (!variants.length) variants.push({ quads: [], ambientOcclusion: true }), weights.push(1)
    return new Choice(variants, weights)
  }

  // ---------- モデル ----------

  private resolve(name: string): ResolvedModel {
    const r: ResolvedModel = { elements: null, textures: new Map(), ambientOcclusion: null }
    let current: string | null = name
    for (let depth = 0; depth < 32 && current !== null; depth++) {
      const file = this.file('models', current)
      if (!Object.keys(file).length) break
      const elements = field(file, 'elements')
      if (r.elements === null && Array.isArray(elements)) r.elements = elements
      const ao = field(file, 'ambientocclusion')
      if (r.ambientOcclusion === null && typeof ao === 'boolean') r.ambientOcclusion = ao
      for (const [k, v] of Object.entries(child(file, 'textures'))) if (!r.textures.has(k)) r.textures.set(k, v)
      const parent = field(file, 'parent')
      current = typeof parent === 'string' ? parent : null
    }
    return r
  }

  bakeVariant(variant: JsonObject): Variant {
    const model = str(variant, 'model', 'minecraft:block/air')
    const x = int(variant, 'x', 0), y = int(variant, 'y', 0), z = int(variant, 'z', 0)
    const uvLock = bool(variant, 'uvlock', false)
    const key = model + '|' + x + '|' + y + '|' + z + '|' + uvLock
    const hit = this.baked.get(key)
    if (hit) return hit
    const resolved = this.resolve(model)
    const rotation = multiply(rotationZ(-z), multiply(rotationY(-y), rotationX(-x)))
    const rotated = x % 360 !== 0 || y % 360 !== 0 || z % 360 !== 0
    const quads: Quad[] = []
    for (const item of (resolved.elements ?? []).slice(0, 4096)) {
      const element = obj(item)
      const from = numbersOf(element, 'from', [0, 0, 0])
      const to = numbersOf(element, 'to', [16, 16, 16])
      if (from.length < 3 || to.length < 3) continue
      const rot = child(element, 'rotation')
      const elementRotation = elementRotationOf(rot)
      const origin = elementRotation ? numbersOf(rot, 'origin', [8, 8, 8]) : null
      const shadeName = str(element, 'shade_direction_override', null)
      const shadeOverride = shadeName === null ? -1 : direction(shadeName)
      // 1.21.4 までの "shade": false は、上向きの明るさと同じ
      const noShade = field(element, 'shade') === false
      let drawX = true, drawY = true, drawZ = true
      if (from[0] === to[0]) drawY = drawZ = false
      if (from[1] === to[1]) drawX = drawZ = false
      if (from[2] === to[2]) drawX = drawY = false
      if (!drawX && !drawY && !drawZ) continue
      for (const [faceName, faceValue] of Object.entries(child(element, 'faces'))) {
        const face = direction(faceName)
        if (face < 0) continue
        const axis = face >> 1
        if ((axis === 0 && !drawY) || (axis === 1 && !drawZ) || (axis === 2 && !drawX)) continue
        const fd = obj(faceValue)
        const texture = resolveTexture(resolved, str(fd, 'texture', '#missing'))
        const sprite = texture ? this.sprite(texture[0]) : MISSING
        const forceTranslucent = !!texture && texture[1]
        const uv = Array.isArray(field(fd, 'uv')) ? numbersOf(fd, 'uv', [0, 0, 16, 16]) : null
        const uvRotation = (((int(fd, 'rotation', 0) % 360) + 360) % 360) / 90 | 0
        const cullName = str(fd, 'cullface', null)
        const cull = cullName === null ? -1 : direction(cullName)
        const shade = noShade ? UP : shadeOverride
        const quad = bakeFace(from, to, face, uv && uv.length >= 4 ? uv : null, uvRotation, sprite, forceTranslucent, int(fd, 'tintindex', -1),
          shade, elementRotation, origin, rotated ? rotation : IDENTITY, uvLock && rotated)
        if (cull >= 0) quad.cull = rotated ? rotateDirection(rotation, cull) : cull
        quads.push(quad)
      }
    }
    const result: Variant = { quads, ambientOcclusion: resolved.ambientOcclusion === null || resolved.ambientOcclusion }
    this.baked.set(key, result)
    return result
  }

  // ---------- アイテムのモデル ----------

  /** アイテムのモデル (models/item/... など)。平らなアイテム (builtin/generated) は、絵の形に 1 ピクセルの厚みを付ける */
  itemModel(name: string): ItemModel {
    const hit = this.itemModels.get(name)
    if (hit) return hit
    let model: ItemModel
    try {
      model = this.buildItemModel(name)
    }
    catch {
      model = { quads: [], display: new Map() }
    }
    this.itemModels.set(name, model)
    return model
  }

  private buildItemModel(name: string): ItemModel {
    const resolved = this.resolve(name)
    const display = new Map<string, number[]>()
    let generated = false
    let current: string | null = name
    for (let depth = 0; depth < 32 && current !== null; depth++) {
      const key = current.indexOf(':') >= 0 ? current : 'minecraft:' + current
      if (key === 'minecraft:builtin/generated') {
        generated = true
        break
      }
      const file = this.file('models', current)
      if (!Object.keys(file).length) break
      for (const [k, v] of Object.entries(child(file, 'display'))) {
        if (display.has(k)) continue
        const t = obj(v)
        const r = numbersOf(t, 'rotation', [0, 0, 0]), tr = numbersOf(t, 'translation', [0, 0, 0]), s = numbersOf(t, 'scale', [1, 1, 1])
        const values: number[] = []
        for (let i = 0; i < 3; i++) values[i] = r[i] ?? 0
        for (let i = 0; i < 3; i++) values[3 + i] = Math.max(-5, Math.min(5, (tr[i] ?? 0) * 0.0625))
        for (let i = 0; i < 3; i++) values[6 + i] = Math.max(-4, Math.min(4, s[i] ?? 1))
        display.set(k, values)
      }
      if (Array.isArray(field(file, 'elements'))) break
      const parent = field(file, 'parent')
      current = typeof parent === 'string' ? parent : null
    }
    const quads: Quad[] = []
    if (generated && resolved.elements === null) {
      for (let layer = 0; layer < 5; layer++) {
        if (!resolved.textures.has('layer' + layer)) break
        const ref = resolveTexture(resolved, '#layer' + layer)
        if (!ref) break
        generateLayer(quads, this.sprite(ref[0]), layer)
      }
    }
    else {
      quads.push(...this.bakeVariant({ model: name }).quads)
    }
    return { quads, display }
  }
}

/** "facing=east,half=bottom" のような条件に、状態が当てはまるか */
export function matchesVariant(state: BlockState, key: string): boolean {
  if (!key) return true
  for (const pair of key.split(',')) {
    const eq = pair.indexOf('=')
    if (eq < 0) continue
    const value = state.get(pair.substring(0, eq))
    if (value === null || value !== pair.substring(eq + 1)) return false
  }
  return true
}

export function matchesCondition(state: BlockState, condition: JsonObject, depth: number): boolean {
  if (depth > 16) return false
  if (field(condition, 'OR') !== undefined) {
    for (const item of list(condition, 'OR')) if (matchesCondition(state, obj(item), depth + 1)) return true
    return false
  }
  if (field(condition, 'AND') !== undefined) {
    for (const item of list(condition, 'AND')) if (!matchesCondition(state, obj(item), depth + 1)) return false
    return true
  }
  for (const [k, expected] of Object.entries(condition)) {
    const actual = state.get(k)
    if (actual === null) return false
    const text = typeof expected === 'number' ? String(Math.round(expected)) : String(expected)
    let any = false
    for (const term of text.split('|')) {
      const negated = term.startsWith('!')
      const value = negated ? term.substring(1) : term
      if ((actual === value) !== negated) any = true
    }
    if (!any) return false
  }
  return true
}

/** テクスチャの名前 (#side など) をたどって、[テクスチャの名前, 常に半透明か] を返す。見つからなければ null */
function resolveTexture(model: ResolvedModel, reference: string): [string, boolean] | null {
  // 面の texture は、# がなくてもテクスチャの名前の参照 (TextureSlots.getMaterial)
  let current = reference.startsWith('#') ? reference : '#' + reference
  for (let depth = 0; depth < 32; depth++) {
    if (!current.startsWith('#')) return [current, false]
    const value = model.textures.get(current.substring(1))
    if (typeof value === 'string') current = value
    else if (value && typeof value === 'object') {
      const material = obj(value)
      const sprite = str(material, 'sprite', null)
      if (sprite === null) return null
      if (sprite.startsWith('#')) {
        current = sprite
        continue
      }
      return [sprite, bool(material, 'force_translucent', false)]
    }
    else return null
  }
  return null
}

/** 要素の回転 (原点を中心にする前の 3x3 の行列)。回転しなければ null */
function elementRotationOf(rotation: JsonObject): number[] | null {
  if (!Object.keys(rotation).length) return null
  let matrix: number[]
  if (field(rotation, 'axis') !== undefined || field(rotation, 'angle') !== undefined) {
    const angle = num(rotation, 'angle', 0)
    if (angle === 0) return null
    const axis = str(rotation, 'axis', 'y')
    matrix = axis === 'x' ? rotationX(angle) : axis === 'z' ? rotationZ(angle) : rotationY(angle)
  }
  else {
    matrix = multiply(rotationZ(num(rotation, 'z', 0)), multiply(rotationY(num(rotation, 'y', 0)), rotationX(num(rotation, 'x', 0))))
  }
  if (bool(rotation, 'rescale', false)) {
    // 回転で縮んで見える分を、軸ごとに引き伸ばす
    const scale = [0, 0, 0]
    for (let a = 0; a < 3; a++) scale[a] = f(1 / Math.max(Math.abs(matrix[a]!), Math.abs(matrix[3 + a]!), Math.abs(matrix[6 + a]!)))
    matrix = matrix.map((v, i) => f(v * scale[i % 3]!))
  }
  return matrix
}

/**
 * 要素の面 1 枚を四角形にする (Minecraft の FaceBakery と同じ計算)。
 * @param uv テクスチャの範囲 (0 - 16)。null なら要素の大きさから決める
 * @param uvRotation テクスチャの回転 (90 度単位の回数)
 * @param shade 明るさに使う方向。-1 なら面の向き
 */
export function bakeFace(from: number[], to: number[], face: number, uvIn: number[] | null, uvRotation: number, sprite: Sprite, forceTranslucent: boolean,
  tint: number, shade: number, elementRot: number[] | null, origin: number[] | null, rotation: number[], uvLock: boolean): Quad {
  // Java の float と同じ計算にする (面の向きが 2 つの方向のちょうど間のときに、同じ方を選ぶため)
  from = from.map(f)
  to = to.map(f)
  const uv = (uvIn ?? defaultUv(from, to, face)).map(f)
  const quad: Quad = {
    positions: new Float32Array(12), uvs: new Float32Array(8), sprite, cull: -1, direction: UP, shadeDirection: UP, tint,
    transparency: forceTranslucent ? TRANSLUCENT
      : sprite.transparency(Math.min(uv[0]!, uv[2]!) / 16, Math.min(uv[1]!, uv[3]!) / 16, Math.max(uv[0]!, uv[2]!) / 16, Math.max(uv[1]!, uv[3]!) / 16),
  }
  const uvTransform = uvLock ? inverseFaceTransform(rotation, face) : null
  const rotatedModel = rotation !== IDENTITY
  for (let i = 0; i < 4; i++) {
    const info = FACE_INFO[face]![i]!
    let x = f((info[0] === 0 ? from[0]! : to[0]!) / 16)
    let y = f((info[1] === 0 ? from[1]! : to[1]!) / 16)
    let z = f((info[2] === 0 ? from[2]! : to[2]!) / 16)
    if (elementRot && origin) {
      const ox = f(f(origin[0]!) / 16), oy = f(f(origin[1]!) / 16), oz = f(f(origin[2]!) / 16)
      const px = f(x - ox), py = f(y - oy), pz = f(z - oz)
      x = dot3(elementRot, 0, px, py, pz, ox)
      y = dot3(elementRot, 3, px, py, pz, oy)
      z = dot3(elementRot, 6, px, py, pz, oz)
    }
    if (rotatedModel) {
      const px = f(x - 0.5), py = f(y - 0.5), pz = f(z - 0.5)
      x = dot3(rotation, 0, px, py, pz, 0.5)
      y = dot3(rotation, 3, px, py, pz, 0.5)
      z = dot3(rotation, 6, px, py, pz, 0.5)
    }
    quad.positions[i * 3] = x
    quad.positions[i * 3 + 1] = y
    quad.positions[i * 3 + 2] = z
    const corner = (i + uvRotation) % 4
    let u = f((corner === 0 || corner === 1 ? uv[0]! : uv[2]!) / 16)
    let v = f((corner === 0 || corner === 3 ? uv[1]! : uv[3]!) / 16)
    if (uvTransform) {
      const cu = f(u - 0.5), cv = f(v - 0.5)
      u = f(f(f(uvTransform[0]! * cu) + f(uvTransform[1]! * cv)) + 0.5)
      v = f(f(f(uvTransform[3]! * cu) + f(uvTransform[4]! * cv)) + 0.5)
    }
    quad.uvs[i * 2] = u
    quad.uvs[i * 2 + 1] = v
  }
  // 面の向きを、回転したあとの頂点から求める
  const p = quad.positions
  const ax = f(p[3]! - p[0]!), ay = f(p[4]! - p[1]!), az = f(p[5]! - p[2]!)
  const bx = f(p[6]! - p[0]!), by = f(p[7]! - p[1]!), bz = f(p[8]! - p[2]!)
  const nx = f(f(ay * bz) - f(az * by)), ny = f(f(az * bx) - f(ax * bz)), nz = f(f(ax * by) - f(ay * bx))
  let best = -1, bestDot = 0
  const length = f(Math.sqrt(f(f(f(nx * nx) + f(ny * ny)) + f(nz * nz))))
  if (length > 0) {
    for (let d = 0; d < 6; d++) {
      const n = NORMALS[d]!
      const dot = f(f(f(f(nx * n[0]) + f(ny * n[1])) + f(nz * n[2])) / length)
      if (dot >= 0 && dot > bestDot) {
        bestDot = dot
        best = d
      }
    }
  }
  if (!elementRot && best >= 0) recalculateWinding(quad, best)
  quad.direction = best < 0 ? UP : best
  quad.shadeDirection = shade >= 0 ? shade : quad.direction
  return quad
}

// 頂点の順番を、向きごとの決まった順にそろえる (明るさの計算が頂点の順番に依るため)
function recalculateWinding(quad: Quad, dir: number): void {
  const p = quad.positions
  // Java の float と同じ値で比べる (Float32Array に入れたもの)
  let minX = 999, minY = 999, minZ = 999, maxX = -999, maxY = -999, maxZ = -999
  for (let i = 0; i < 4; i++) {
    minX = Math.min(minX, p[i * 3]!)
    minY = Math.min(minY, p[i * 3 + 1]!)
    minZ = Math.min(minZ, p[i * 3 + 2]!)
    maxX = Math.max(maxX, p[i * 3]!)
    maxY = Math.max(maxY, p[i * 3 + 1]!)
    maxZ = Math.max(maxZ, p[i * 3 + 2]!)
  }
  for (let vertex = 0; vertex < 4; vertex++) {
    const info = FACE_INFO[dir]![vertex]!
    const x = info[0] === 0 ? minX : maxX, y = info[1] === 0 ? minY : maxY, z = info[2] === 0 ? minZ : maxZ
    let found = -1
    for (let i = vertex; i < 4; i++) {
      if (p[i * 3] === x && p[i * 3 + 1] === y && p[i * 3 + 2] === z) {
        found = i
        break
      }
    }
    // 斜めの面など、箱の角に頂点がない場合はそのままにする
    if (found < 0) return
    if (found !== vertex) {
      for (let k = 0; k < 3; k++) {
        const t = p[vertex * 3 + k]!
        p[vertex * 3 + k] = p[found * 3 + k]!
        p[found * 3 + k] = t
      }
      for (let k = 0; k < 2; k++) {
        const t = quad.uvs[vertex * 2 + k]!
        quad.uvs[vertex * 2 + k] = quad.uvs[found * 2 + k]!
        quad.uvs[found * 2 + k] = t
      }
    }
  }
}

function defaultUv(from: number[], to: number[], face: number): number[] {
  switch (face) {
    case DOWN: return [from[0]!, 16 - to[2]!, to[0]!, 16 - from[2]!]
    case UP: return [from[0]!, from[2]!, to[0]!, to[2]!]
    case NORTH: return [16 - to[0]!, 16 - to[1]!, 16 - from[0]!, 16 - from[1]!]
    case SOUTH: return [from[0]!, 16 - to[1]!, to[0]!, 16 - from[1]!]
    case WEST: return [from[2]!, 16 - to[1]!, to[2]!, 16 - from[1]!]
    default: return [16 - to[2]!, 16 - to[1]!, 16 - from[2]!, 16 - from[1]!]
  }
}

/** 行列で方向を回したときに、最も近い方向 */
export function rotateDirection(rotation: number[], dir: number): number {
  const n = NORMALS[dir]!
  return nearest(
    rotation[0]! * n[0] + rotation[1]! * n[1] + rotation[2]! * n[2],
    rotation[3]! * n[0] + rotation[4]! * n[1] + rotation[5]! * n[2],
    rotation[6]! * n[0] + rotation[7]! * n[1] + rotation[8]! * n[2])
}

function nearest(x: number, y: number, z: number): number {
  let best = UP, bestDot = -Infinity
  for (let d = 0; d < 6; d++) {
    const n = NORMALS[d]!
    const dot = x * n[0] + y * n[1] + z * n[2]
    if (dot > bestDot) {
      bestDot = dot
      best = d
    }
  }
  return best
}

// ---------- 回転の行列 (3x3、行の順。値は Java の float と同じ丸め) ----------

const f = Math.fround

/** m[row..row+2] と (px, py, pz) の内積に add を足す (Java の float と同じ順と丸め) */
function dot3(m: number[], row: number, px: number, py: number, pz: number, add: number): number {
  return f(f(f(f(m[row]! * px) + f(m[row + 1]! * py)) + f(m[row + 2]! * pz)) + add)
}

// 90 度の倍数では、誤差のないちょうどの値にする
function exact(v: number): number {
  return Math.abs(v) < 1e-9 ? 0 : Math.abs(Math.abs(v) - 1) < 1e-9 ? Math.sign(v) : v
}

export function rotationX(deg: number): number[] {
  const a = deg * Math.PI / 180, c = Math.fround(exact(Math.cos(a))), s = Math.fround(exact(Math.sin(a)))
  return [1, 0, 0, 0, c, -s, 0, s, c]
}

export function rotationY(deg: number): number[] {
  const a = deg * Math.PI / 180, c = Math.fround(exact(Math.cos(a))), s = Math.fround(exact(Math.sin(a)))
  return [c, 0, s, 0, 1, 0, -s, 0, c]
}

export function rotationZ(deg: number): number[] {
  const a = deg * Math.PI / 180, c = Math.fround(exact(Math.cos(a))), s = Math.fround(exact(Math.sin(a)))
  return [c, -s, 0, s, c, 0, 0, 0, 1]
}

export function multiply(a: number[], b: number[]): number[] {
  const r = new Array<number>(9)
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0
      for (let k = 0; k < 3; k++) sum = f(sum + f(a[row * 3 + k]! * b[k * 3 + col]!))
      r[row * 3 + col] = sum
    }
  }
  return r
}

function transpose(m: number[]): number[] {
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!]
}

// 面を「南向きの面」に写す回転 (BlockMath の VANILLA_UV_TRANSFORM_LOCAL_TO_GLOBAL)
function localToGlobal(face: number): number[] {
  switch (face) {
    case EAST: return rotationY(90)
    case WEST: return rotationY(-90)
    case NORTH: return rotationY(180)
    case UP: return rotationX(-90)
    case DOWN: return rotationX(90)
    default: return IDENTITY.slice()
  }
}

/** テクスチャを固定するときの、テクスチャ座標の変換 (BlockMath.getFaceTransformation の逆) */
function inverseFaceTransform(rotation: number[], face: number): number[] {
  const action = multiply(rotation, localToGlobal(face))
  const newSide = nearest(action[2]!, action[5]!, action[8]!)
  return transpose(multiply(transpose(localToGlobal(newSide)), action))
}

// ---------- 平らなアイテム (ItemModelGenerator) ----------

function generateLayer(quads: Quad[], sprite: Sprite, layer: number): void {
  const from = [0, 0, 7.5], to = [16, 16, 8.5]
  quads.push(bakeFace(from, to, SOUTH, [0, 0, 16, 16], 0, sprite, false, layer, -1, null, null, IDENTITY, false))
  quads.push(bakeFace(from, to, NORTH, [16, 0, 0, 16], 0, sprite, false, layer, -1, null, null, IDENTITY, false))
  const width = sprite.width, height = sprite.height
  const xScale = 16 / width, yScale = 16 / height
  const faces = new Set<number>()
  const frames = sprite.sequence ? sprite.frames.length : 1
  // 上、下、左、右 (左は東向きの面、右は西向きの面)
  const steps = [[0, 1], [0, -1], [1, 0], [-1, 0]]
  const ordered: number[] = []
  for (let f = 0; f < frames; f++) {
    const px = sprite.frames[f]!
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        if (px[(y * width + x) * 4 + 3] === 0) continue
        for (let side = 0; side < 4; side++) {
          const sx = x - steps[side]![0]!, sy = y - steps[side]![1]!
          const transparent = sx < 0 || sy < 0 || sx >= width || sy >= height || px[(sy * width + sx) * 4 + 3] === 0
          const key = (side * 4096 + x) * 4096 + y
          if (transparent && !faces.has(key)) {
            faces.add(key)
            ordered.push(key)
          }
        }
      }
    }
  }
  const directions = [UP, DOWN, EAST, WEST]
  for (const key of ordered) {
    const y = key % 4096, x = Math.floor(key / 4096) % 4096, side = Math.floor(key / (4096 * 4096))
    const u0 = x + 0.1, u1 = x + 1 - 0.1
    let v0: number, v1: number
    if (side < 2) {
      v0 = y + 0.1
      v1 = y + 1 - 0.1
    }
    else {
      v0 = y + 1 - 0.1
      v1 = y + 0.1
    }
    let startX = x, startY = y, endX = x, endY = y
    switch (side) {
      case 0: endX = x + 1; break
      case 1: endX = x + 1; startY = y + 1; endY = y + 1; break
      case 2: endY = y + 1; break
      default: startX = x + 1; endX = x + 1; endY = y + 1; break
    }
    startX *= xScale
    endX *= xScale
    startY = 16 - startY * yScale
    endY = 16 - endY * yScale
    let a: number[], b: number[]
    switch (side) {
      case 0: a = [startX, startY, 7.5]; b = [endX, startY, 8.5]; break
      case 1: a = [startX, endY, 7.5]; b = [endX, endY, 8.5]; break
      case 2: a = [startX, startY, 7.5]; b = [startX, endY, 8.5]; break
      default: a = [endX, startY, 7.5]; b = [endX, endY, 8.5]; break
    }
    // ゲームと同じく、from と to は大小をそろえずにそのまま使う (面の向きは頂点から決まる)
    quads.push(bakeFace(a, b, directions[side]!, [u0 * xScale, v0 * yScale, u1 * xScale, v1 * yScale], 0, sprite, false, layer, -1, null, null, IDENTITY, false))
  }
}

