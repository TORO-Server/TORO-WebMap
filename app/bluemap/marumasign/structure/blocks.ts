// 構造物のブロックの形と絵 (簡単にしたもの)。サーバーに Minecraft のリソースのまとめ (/mcassets/) がないときだけ使う
// (あるときは vanilla.ts が、MarumaSign 本体と同じく jar のブロックのモデルで描く)。ここでは、
// 形は「立方体・半ブロック・階段・柵・壁・板ガラス・薄い板・植物 (交差した 2 枚)・液体」などに簡単にし、
// 絵は BlueMap の地図のテクスチャ (maps/<地図>/textures.json) から名前で選ぶ。地図にない絵は、名前から決めた色で塗る
// ここは何も import しない (Node の試験と Worker の両方で使う)

/** 面の順: 上、下、北 (-Z)、南 (+Z)、西 (-X)、東 (+X) */
export const UP = 0, DOWN = 1, NORTH = 2, SOUTH = 3, WEST = 4, EAST = 5

export type RenderMode = 'opaque' | 'cutout' | 'translucent'

export interface BlockModel {
  air: boolean
  /** 不透明な立方体 (隣のブロックの、接する面を隠す) */
  occludes: boolean
  /** 同じ種類どうしの、接する面を隠す (ガラス、水など) */
  cullSame: string | null
  render: RenderMode
  /** 箱 [x0, y0, z0, x1, y1, z1] (0 - 1) */
  boxes: number[][]
  /** 交差した 2 枚の板 (植物) */
  cross: boolean
  /** 面ごとの絵の名前 (地図のテクスチャの resourcePath)。なければ色 (#rrggbb) */
  tex: string[]
  /** 色を掛ける面 (ビット) と、その色 */
  tintFaces: number
  tint: number
}

const FULL = [0, 0, 0, 1, 1, 1]

// 平原のバイオームの色 (MarumaSign 本体はファイルのバイオームごと。ここでは平原の色にする)
const GRASS = 0x91BD59
const FOLIAGE = 0x77AB2F
const WATER = 0x3F76E4
const LEAF_TINTS: Record<string, number> = { birch_leaves: 0x80A755, spruce_leaves: 0x619961 }
const UNTINTED_LEAVES = new Set(['cherry_leaves', 'azalea_leaves', 'flowering_azalea_leaves', 'pale_oak_leaves'])
const WOODS = ['oak', 'spruce', 'birch', 'jungle', 'acacia', 'dark_oak', 'mangrove', 'cherry', 'pale_oak', 'bamboo', 'crimson', 'warped']

const FLOWERS = new Set([
  'dandelion', 'poppy', 'blue_orchid', 'allium', 'azure_bluet', 'red_tulip', 'orange_tulip', 'white_tulip', 'pink_tulip', 'oxeye_daisy',
  'cornflower', 'lily_of_the_valley', 'wither_rose', 'torchflower', 'closed_eyeblossom', 'open_eyeblossom', 'short_grass', 'grass', 'fern',
  'dead_bush', 'short_dry_grass', 'tall_dry_grass', 'brown_mushroom', 'red_mushroom', 'crimson_fungus', 'warped_fungus', 'crimson_roots',
  'warped_roots', 'nether_sprouts', 'cobweb', 'sugar_cane', 'bamboo_sapling', 'seagrass', 'kelp', 'kelp_plant', 'hanging_roots',
  'sweet_berry_bush', 'cave_vines', 'cave_vines_plant', 'weeping_vines', 'weeping_vines_plant', 'twisting_vines', 'twisting_vines_plant',
  'pitcher_crop', 'torchflower_crop', 'firefly_bush', 'bush', 'cactus_flower',
])
const DOUBLE_PLANTS = new Set(['tall_grass', 'large_fern', 'sunflower', 'lilac', 'rose_bush', 'peony', 'tall_seagrass', 'pitcher_plant'])
const CROPS = new Set(['wheat', 'carrots', 'potatoes', 'beetroots', 'nether_wart'])
const GRASS_TINTED = new Set(['short_grass', 'grass', 'fern', 'tall_grass', 'large_fern', 'sugar_cane', 'bush'])
const SKIP = new Set([
  'barrier', 'light', 'structure_void', 'moving_piston', 'tripwire', 'tripwire_hook', 'string', 'redstone_wire', 'lever', 'end_gateway',
  'end_portal', 'nether_portal', 'fire', 'soul_fire', 'bubble_column',
])

/** 名前から決める色 (地図に絵がないとき)。似た名前は似た色になるように、材質の言葉で決める */
function fallbackColor(name: string): number {
  const table: [RegExp, number][] = [
    [/water/, 0x3F76E4], [/lava|magma/, 0xD5622C], [/leaves|grass|moss|vine|fern|kelp|azalea/, 0x5E8F3A], [/oak|spruce|birch|jungle|acacia|wood|log|planks|mangrove|cherry|bamboo|barrel|chest|bookshelf/, 0x9C7F4E],
    [/sand/, 0xDBCFA3], [/snow|quartz|white|calcite|bone/, 0xE9ECEC], [/brick/, 0x96614F], [/glass|ice/, 0xA8C8E8], [/gold/, 0xF0CF3A],
    [/iron/, 0xD8D8D8], [/copper/, 0xC06A4F], [/obsidian|black|blackstone/, 0x1F1B25], [/red|crimson|nether/, 0x8E2B2B], [/blue|warped|prismarine/, 0x3A5E8C],
    [/green/, 0x4F6A2B], [/yellow/, 0xE8C83A], [/purple|purpur|amethyst/, 0x8E5FAE], [/dirt|mud|soil|path|farmland|podzol/, 0x866043],
    [/deepslate|basalt|tuff/, 0x4D4D52], [/stone|cobble|andesite|gravel|furnace|ore/, 0x7F7F7F],
  ]
  for (const [re, c] of table) if (re.test(name)) return c
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return 0x606060 + ((h & 0x3F) << 16) + (((h >> 6) & 0x3F) << 8) + ((h >> 12) & 0x3F)
}

function hex(c: number): string {
  return '#' + c.toString(16).padStart(6, '0')
}

/** 状態の文字列を、名前と状態に分ける */
export function parseState(state: string): { name: string, props: Map<string, string> } {
  const b = state.indexOf('[')
  const full = b < 0 ? state : state.substring(0, b)
  const name = full.substring(full.indexOf(':') + 1)
  const props = new Map<string, string>()
  if (b >= 0) {
    for (const p of state.substring(b + 1, state.length - 1).split(',')) {
      const eq = p.indexOf('=')
      if (eq > 0) props.set(p.substring(0, eq), p.substring(eq + 1))
    }
  }
  return { name, props }
}

/**
 * 形の名前の材質の部分 (oak_stairs → oak, stone_brick_wall → stone_brick)
 */
function stripShape(name: string): string {
  return name.replace(/^waxed_/, '').replace(/_(stairs|slab|wall|fence_gate|fence|pressure_plate|button|trapdoor|door|carpet|wall_sign|wall_hanging_sign|hanging_sign|sign|pane)$/, '')
}

export class TextureResolver {
  private readonly have: Set<string>

  constructor(names: Iterable<string>) {
    this.have = new Set(names)
  }

  /** 候補のうち、地図にある最初の絵 */
  first(...candidates: string[]): string | null {
    for (const c of candidates) {
      if (!c) continue
      const key = 'minecraft:block/' + c
      if (this.have.has(key)) return key
    }
    return null
  }

  /** 材質の名前から、絵の名前の候補 (oak → oak_planks、stone_brick → stone_bricks など) */
  materialCandidates(base: string): string[] {
    const b = base.replace(/^waxed_/, '')
    const out = [b, b + 's', b + '_planks', b + '_block', b.replace(/_brick$/, '_bricks'), b.replace(/_tile$/, '_tiles')]
    if (WOODS.includes(b)) out.unshift(b + '_planks')
    if (b === 'petrified_oak') out.unshift('oak_planks')
    if (b === 'smooth_quartz') out.unshift('quartz_block_bottom')
    if (b === 'quartz') out.unshift('quartz_block_side')
    if (b === 'smooth_sandstone') out.unshift('sandstone_top')
    if (b === 'smooth_red_sandstone') out.unshift('red_sandstone_top')
    if (b === 'purpur') out.unshift('purpur_block')
    if (b === 'smooth_stone') out.push('smooth_stone_slab_side')
    if (/_wood$|_hyphae$/.test(b)) out.unshift(b.replace(/_wood$/, '_log').replace(/_hyphae$/, '_stem'))
    if (/_stained_glass$|^glass$|^tinted_glass$/.test(b)) out.unshift(b)
    if (b === 'moss') out.unshift('moss_block')
    if (/(white|orange|magenta|light_blue|yellow|lime|pink|gray|light_gray|cyan|purple|blue|brown|green|red|black)$/.test(b)) out.push(b + '_wool')
    return out
  }

  /** 面ごとの絵 (立方体のブロック) */
  faces(name: string, props: Map<string, string>): string[] {
    const n = name
    const pick = (...c: string[]): string | null => this.first(...c)
    let top: string | null, bottom: string | null, side: string | null
    let front: string | null = null
    switch (n) {
      case 'grass_block': top = pick('grass_block_top'); bottom = pick('dirt'); side = pick('grass_block_side', 'dirt'); break
      case 'podzol': case 'mycelium': top = pick(n + '_top'); bottom = pick('dirt'); side = pick(n + '_side', 'dirt'); break
      case 'dirt_path': top = pick('dirt_path_top'); bottom = pick('dirt'); side = pick('dirt_path_side', 'dirt'); break
      case 'farmland': top = pick(props.get('moisture') === '7' ? 'farmland_moist' : 'farmland', 'farmland'); bottom = pick('dirt'); side = pick('dirt'); break
      case 'snow_block': top = bottom = side = pick('snow'); break
      case 'bookshelf': case 'chiseled_bookshelf': top = bottom = pick('oak_planks'); side = pick(n, n + '_empty', 'bookshelf'); break
      case 'smooth_quartz': top = bottom = side = pick('quartz_block_bottom'); break
      case 'smooth_sandstone': top = bottom = side = pick('sandstone_top'); break
      case 'smooth_red_sandstone': top = bottom = side = pick('red_sandstone_top'); break
      case 'cut_sandstone': case 'chiseled_sandstone': top = bottom = pick('sandstone_top'); side = pick(n); break
      case 'cut_red_sandstone': case 'chiseled_red_sandstone': top = bottom = pick('red_sandstone_top'); side = pick(n); break
      case 'crafting_table': top = pick('crafting_table_top'); bottom = pick('oak_planks'); side = pick('crafting_table_side'); front = pick('crafting_table_front'); break
      case 'chest': case 'trapped_chest': case 'barrel_chest': top = bottom = side = pick('oak_planks'); break
      case 'ender_chest': top = bottom = side = pick('obsidian'); break
      case 'water': case 'bubble_column': top = bottom = side = pick('water_still', 'water_flow'); break
      case 'lava': top = bottom = side = pick('lava_still', 'lava_flow'); break
      default: {
        // 木の幹など、向き (axis) で上下の面が変わるもの
        const wood = /_wood$|_hyphae$/.test(n)
        const base = wood ? n.replace(/_wood$/, '_log').replace(/_hyphae$/, '_stem') : n
        const material = this.materialCandidates(stripShape(n))
        top = pick(base + '_top', base + '_end', ...(wood ? [base] : []), base, ...material)
        bottom = pick(base + '_bottom', base + '_top', base, ...material)
        side = pick(base + '_side', base, ...material, base + '_front')
        if (wood) top = bottom = side
        front = pick(base + (props.get('lit') === 'true' ? '_front_on' : '_front'), base + '_front')
      }
    }
    const color = hex(fallbackColor(n))
    const t = top ?? side ?? color, b = bottom ?? side ?? color, s = side ?? top ?? color
    const tex = [t, b, s, s, s, s]
    // 正面 (かまどの口など)
    const facing = props.get('facing')
    if (front && facing) {
      const f = { north: NORTH, south: SOUTH, west: WEST, east: EAST, up: UP, down: DOWN }[facing]
      if (f !== undefined) tex[f] = front
    }
    // 向き (axis) で回す
    const axis = props.get('axis')
    if (axis === 'x') return [s, s, s, s, t, t]
    if (axis === 'z') return [s, s, t, t, s, s]
    return tex
  }
}

/** 向きで箱を回す (北向きを基準に作った箱を、facing の向きにする) */
function rotateBox(box: number[], facing: string | undefined): number[] {
  const [x0, y0, z0, x1, y1, z1] = box as [number, number, number, number, number, number]
  switch (facing) {
    case 'south': return [1 - x1, y0, 1 - z1, 1 - x0, y1, 1 - z0]
    case 'west': return [z0, y0, 1 - x1, z1, y1, 1 - x0]
    case 'east': return [1 - z1, y0, x0, 1 - z0, y1, x1]
    default: return box
  }
}

function connected(v: string | undefined): boolean {
  return v === 'true' || v === 'low' || v === 'tall'
}

/**
 * ブロックの状態から、形と絵を決める。
 * @param r 地図にある絵を引くもの
 */
export function blockModel(state: string, r: TextureResolver): BlockModel {
  const { name, props } = parseState(state)
  const model: BlockModel = { air: false, occludes: true, cullSame: null, render: 'opaque', boxes: [FULL], cross: false, tex: [], tintFaces: 0, tint: 0xFFFFFF }
  const air = (): BlockModel => ({ ...model, air: true, occludes: false, boxes: [] })
  if (name === 'air' || name === 'cave_air' || name === 'void_air' || SKIP.has(name) || /_button$/.test(name)) return air()
  const color = hex(fallbackColor(name))
  const all = (t: string | null): string[] => {
    const v = t ?? color
    return [v, v, v, v, v, v]
  }
  const shape = (boxes: number[][], tex: string[], render: RenderMode = 'opaque'): BlockModel => ({ ...model, occludes: false, boxes, tex, render })
  const material = (): string[] => {
    const base = stripShape(name)
    const faces = r.faces(base, new Map())
    return faces
  }

  // ---- 液体
  if (name === 'water' || name === 'lava') {
    const water = name === 'water'
    return { ...model, occludes: false, cullSame: name, render: water ? 'translucent' : 'opaque', boxes: [[0, 0, 0, 1, 14 / 16, 1]], tex: r.faces(name, props), tintFaces: water ? 63 : 0, tint: WATER }
  }
  // ---- 植物 (交差した 2 枚)
  if (FLOWERS.has(name) || /_sapling$|_coral$|_coral_fan$|torch$/.test(name) || CROPS.has(name) || DOUBLE_PLANTS.has(name)) {
    let tex: string | null
    if (DOUBLE_PLANTS.has(name)) tex = r.first(name + (props.get('half') === 'upper' ? '_top' : '_bottom'), name)
    else if (CROPS.has(name)) tex = r.first(name.replace(/s$/, '') + '_stage' + (props.get('age') ?? '0'), name + '_stage' + (props.get('age') ?? '0'), name)
    else if (name === 'sweet_berry_bush') tex = r.first('sweet_berry_bush_stage' + (props.get('age') ?? '0'))
    else if (name === 'kelp' || name === 'kelp_plant') tex = r.first('kelp_plant', 'kelp')
    else if (/^wall_torch$|^soul_wall_torch$|^redstone_wall_torch$/.test(name)) tex = r.first(name.replace('wall_', ''))
    else if (name === 'short_grass' || name === 'grass') tex = r.first('short_grass', 'grass')
    else tex = r.first(name)
    return { ...model, occludes: false, render: 'cutout', boxes: [], cross: true, tex: all(tex), tintFaces: GRASS_TINTED.has(name) ? 63 : 0, tint: GRASS }
  }
  // ---- 葉
  if (/_leaves$/.test(name)) {
    const tinted = !UNTINTED_LEAVES.has(name)
    return { ...model, occludes: false, cullSame: name, render: 'cutout', tex: all(r.first(name)), tintFaces: tinted ? 63 : 0, tint: LEAF_TINTS[name] ?? FOLIAGE }
  }
  // ---- ガラスと氷
  if (name === 'glass' || name === 'tinted_glass' || /_stained_glass$/.test(name) || name === 'ice' || name === 'frosted_ice' || name === 'slime_block' || name === 'honey_block') {
    const translucent = name !== 'glass'
    return { ...model, occludes: false, cullSame: name, render: translucent ? 'translucent' : 'cutout', tex: all(r.first(name, name.replace(/_block$/, ''))) }
  }
  // ---- 板ガラスと鉄格子
  if (/glass_pane$/.test(name) || name === 'iron_bars') {
    const t = r.first(name.replace(/_pane$/, ''), name)
    const boxes = [[7 / 16, 0, 7 / 16, 9 / 16, 1, 9 / 16]]
    if (connected(props.get('north'))) boxes.push([7 / 16, 0, 0, 9 / 16, 1, 7 / 16])
    if (connected(props.get('south'))) boxes.push([7 / 16, 0, 9 / 16, 9 / 16, 1, 1])
    if (connected(props.get('west'))) boxes.push([0, 0, 7 / 16, 7 / 16, 1, 9 / 16])
    if (connected(props.get('east'))) boxes.push([9 / 16, 0, 7 / 16, 1, 1, 9 / 16])
    return shape(boxes, all(t), /stained/.test(name) ? 'translucent' : 'cutout')
  }
  // ---- 半ブロック
  if (/_slab$/.test(name)) {
    const type = props.get('type') ?? 'bottom'
    if (type === 'double') return { ...model, tex: material() }
    return shape([type === 'top' ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]], material())
  }
  // ---- 階段 (下の半分と、向いている側の上の半分。角の形は省く)
  if (/_stairs$/.test(name)) {
    const top = props.get('half') === 'top'
    const slab = top ? [0, 0.5, 0, 1, 1, 1] : [0, 0, 0, 1, 0.5, 1]
    const step = rotateBox(top ? [0, 0, 0, 1, 0.5, 0.5] : [0, 0.5, 0, 1, 1, 0.5], props.get('facing'))
    return shape([slab, step], material())
  }
  // ---- 柵と塀
  if (/_fence$/.test(name)) {
    const boxes = [[6 / 16, 0, 6 / 16, 10 / 16, 1, 10 / 16]]
    if (connected(props.get('north'))) boxes.push([7 / 16, 6 / 16, 0, 9 / 16, 15 / 16, 6 / 16])
    if (connected(props.get('south'))) boxes.push([7 / 16, 6 / 16, 10 / 16, 9 / 16, 15 / 16, 1])
    if (connected(props.get('west'))) boxes.push([0, 6 / 16, 7 / 16, 6 / 16, 15 / 16, 9 / 16])
    if (connected(props.get('east'))) boxes.push([10 / 16, 6 / 16, 7 / 16, 1, 15 / 16, 9 / 16])
    return shape(boxes, material())
  }
  if (/_fence_gate$/.test(name)) {
    const ns = props.get('facing') === 'north' || props.get('facing') === 'south'
    return shape([ns ? [0, 5 / 16, 7 / 16, 1, 1, 9 / 16] : [7 / 16, 5 / 16, 0, 9 / 16, 1, 1]], material())
  }
  if (/_wall$/.test(name) && !/_wall_(sign|torch|banner|head|skull|fan)/.test(name)) {
    const boxes = [[4 / 16, 0, 4 / 16, 12 / 16, 1, 12 / 16]]
    const h = (v: string | undefined): number => v === 'tall' ? 1 : 14 / 16
    if (connected(props.get('north'))) boxes.push([5 / 16, 0, 0, 11 / 16, h(props.get('north')), 4 / 16])
    if (connected(props.get('south'))) boxes.push([5 / 16, 0, 12 / 16, 11 / 16, h(props.get('south')), 1])
    if (connected(props.get('west'))) boxes.push([0, 0, 5 / 16, 4 / 16, h(props.get('west')), 11 / 16])
    if (connected(props.get('east'))) boxes.push([12 / 16, 0, 5 / 16, 1, h(props.get('east')), 11 / 16])
    return shape(boxes, material())
  }
  // ---- 薄いもの (じゅうたん、感圧板、雪、レール、はしご)
  if (/_carpet$/.test(name)) return shape([[0, 0, 0, 1, 1 / 16, 1]], all(r.first(name === 'moss_carpet' ? 'moss_block' : name.replace(/_carpet$/, '_wool'))))
  if (/_pressure_plate$/.test(name)) return shape([[1 / 16, 0, 1 / 16, 15 / 16, 1 / 16, 15 / 16]], material())
  if (name === 'snow') {
    const layers = Number(props.get('layers') ?? '1')
    if (layers >= 8) return { ...model, tex: all(r.first('snow')) }
    return shape([[0, 0, 0, 1, Math.max(1, layers) * 2 / 16, 1]], all(r.first('snow')))
  }
  if (/rail$/.test(name)) return shape([[0, 0, 0, 1, 1 / 16, 1]], all(r.first(name + (props.get('powered') === 'true' ? '_on' : ''), name)), 'cutout')
  if (name === 'lily_pad') return { ...shape([[0, 0, 0, 1, 1 / 32, 1]], all(r.first('lily_pad')), 'cutout'), tintFaces: 63, tint: 0x208030 }
  if (name === 'ladder' || name === 'vine' || name === 'glow_lichen') {
    const box = rotateBox([0, 0, 15 / 16, 1, 1, 1], props.get('facing') ?? 'north')
    return { ...shape([box], all(r.first(name)), 'cutout'), tintFaces: name === 'vine' ? 63 : 0, tint: FOLIAGE }
  }
  // ---- 扉と落とし戸
  if (/_door$/.test(name)) {
    const t = r.first(name + (props.get('half') === 'upper' ? '_top' : '_bottom'), name)
    return shape([rotateBox([0, 0, 0, 1, 1, 3 / 16], props.get('facing'))], all(t), 'cutout')
  }
  if (/_trapdoor$/.test(name)) {
    const t = r.first(name, ...r.materialCandidates(stripShape(name)))
    if (props.get('open') === 'true') return shape([rotateBox([0, 0, 13 / 16, 1, 1, 1], props.get('facing'))], all(t), 'cutout')
    return shape([props.get('half') === 'top' ? [0, 13 / 16, 0, 1, 1, 1] : [0, 0, 0, 1, 3 / 16, 1]], all(t), 'cutout')
  }
  // ---- 看板 (MarumaSign の看板の中身は描かない)
  if (/_sign$/.test(name)) {
    const wall = /_wall_sign$|_wall_hanging_sign$/.test(name)
    const box = wall ? rotateBox([0, 4 / 16, 14 / 16, 1, 12 / 16, 1], props.get('facing')) : [0, 7 / 16, 7.5 / 16, 1, 15 / 16, 8.5 / 16]
    return shape([box], material())
  }
  // ---- 小さな箱のもの
  if (name === 'chest' || name === 'trapped_chest' || name === 'ender_chest') return shape([[1 / 16, 0, 1 / 16, 15 / 16, 14 / 16, 15 / 16]], r.faces(name, props))
  if (/_bed$/.test(name)) return shape([[0, 0, 0, 1, 9 / 16, 1]], all(r.first(name.replace(/_bed$/, '_wool'))))
  if (name === 'flower_pot' || /^potted_/.test(name)) return shape([[5 / 16, 0, 5 / 16, 11 / 16, 6 / 16, 11 / 16]], all(r.first('flower_pot')))
  if (name === 'lantern' || name === 'soul_lantern') return shape([[5 / 16, 0, 5 / 16, 11 / 16, 9 / 16, 11 / 16]], all(r.first(name)), 'cutout')
  if (/_(head|skull)$/.test(name)) return shape([[4 / 16, 0, 4 / 16, 12 / 16, 8 / 16, 12 / 16]], all(null))
  if (/candle$/.test(name)) return shape([[7 / 16, 0, 7 / 16, 9 / 16, 6 / 16, 9 / 16]], all(r.first(name)))
  if (name === 'dirt_path' || name === 'farmland') return shape([[0, 0, 0, 1, 15 / 16, 1]], r.faces(name, props))
  if (/_banner$/.test(name)) return shape([[2 / 16, 0, 7 / 16, 14 / 16, 1, 9 / 16]], all(r.first(name.replace(/_(wall_)?banner$/, '_wool'))))
  if (name === 'cactus') return { ...shape([[1 / 16, 0, 1 / 16, 15 / 16, 1, 15 / 16]], r.faces(name, props)) }
  // ---- 立方体 (草のブロックは上の面に草の色を掛ける)
  if (name === 'grass_block') return { ...model, tex: r.faces(name, props), tintFaces: 1 << UP, tint: GRASS }
  return { ...model, tex: r.faces(name, props) }
}
