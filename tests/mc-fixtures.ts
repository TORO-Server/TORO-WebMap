// 試験用の小さな Minecraft のリソース (blockstates, models, テクスチャ) を作る。Mojang のファイルは使わない (形は自分で書いたもの)
import { deflateSync, gunzipSync } from 'node:zlib'
import { readFileSync } from 'node:fs'
import { GameAssets, type McBundle } from '../app/bluemap/marumasign/structure/assets.ts'
import { BlockData } from '../app/bluemap/marumasign/structure/block-data.ts'
import { EntityModels } from '../app/bluemap/marumasign/structure/entity-models.ts'

const CRC = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(b: Uint8Array): number {
  let c = 0xFFFFFFFF
  for (const x of b) c = CRC[(c ^ x) & 255]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** RGBA の並びを PNG にする */
export function png(width: number, height: number, rgba: (x: number, y: number) => [number, number, number, number]): Uint8Array {
  const raw = new Uint8Array((width * 4 + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0
    for (let x = 0; x < width; x++) raw.set(rgba(x, y), y * (width * 4 + 1) + 1 + x * 4)
  }
  const chunk = (type: string, data: Uint8Array): Uint8Array => {
    const out = new Uint8Array(12 + data.length)
    const dv = new DataView(out.buffer)
    dv.setUint32(0, data.length)
    for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i)
    out.set(data, 8)
    dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)))
    return out
  }
  const ihdr = new Uint8Array(13)
  const dv = new DataView(ihdr.buffer)
  dv.setUint32(0, width)
  dv.setUint32(4, height)
  ihdr.set([8, 6, 0, 0, 0], 8)
  const parts = [Uint8Array.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(deflateSync(raw))), chunk('IEND', new Uint8Array(0))]
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 試験用のリソース。テクスチャは名前 → PNG */
export function fixtureAssets(extra: { blockstates?: Record<string, unknown>, models?: Record<string, unknown>, textures?: Record<string, [Uint8Array, unknown?]> } = {}): GameAssets {
  const solid = (r: number, g: number, b: number): Uint8Array => png(16, 16, () => [r, g, b, 255])
  const textures: Record<string, [Uint8Array, unknown?]> = {
    'minecraft:block/stone': [solid(128, 128, 128)],
    'minecraft:block/planks': [solid(160, 120, 70)],
    // 角だけ透明 (切り抜き)
    'minecraft:block/glass': [png(16, 16, (x, y) => (x === 0 || y === 0) ? [200, 220, 255, 255] : [0, 0, 0, 0])],
    // 半透明
    'minecraft:block/ice': [png(16, 16, () => [150, 180, 255, 128])],
    // 4 コマのアニメーション (16 x 64)
    'minecraft:block/flow': [png(16, 64, (_x, y) => [Math.floor(y / 16) * 60, 0, 0, 255]), { frametime: 2 }],
    'minecraft:colormap/grass': [png(256, 256, (x, y) => [x, y, 77, 255])],
    'minecraft:colormap/foliage': [png(256, 256, (x, y) => [y, x, 33, 255])],
    ...extra.textures,
  }
  const bin: Uint8Array[] = []
  const index: McBundle['textures'] = {}
  let offset = 0
  for (const [id, [bytes, anim]] of Object.entries(textures)) {
    index[id] = [offset, bytes.length, anim ?? 0]
    bin.push(bytes)
    offset += bytes.length
  }
  const all = new Uint8Array(offset)
  let at = 0
  for (const b of bin) {
    all.set(b, at)
    at += b.length
  }
  const cubeAll = { parent: 'minecraft:block/cube', textures: { particle: '#all', down: '#all', up: '#all', north: '#all', east: '#all', south: '#all', west: '#all' } }
  const cube = {
    elements: [{
      from: [0, 0, 0], to: [16, 16, 16],
      faces: {
        down: { texture: '#down', cullface: 'down' }, up: { texture: '#up', cullface: 'up' }, north: { texture: '#north', cullface: 'north' },
        south: { texture: '#south', cullface: 'south' }, west: { texture: '#west', cullface: 'west' }, east: { texture: '#east', cullface: 'east' },
      },
    }],
  }
  const bundle: McBundle = {
    format: 1, version: 'test',
    blockstates: {
      'minecraft:stone': { variants: { '': { model: 'minecraft:block/stone' } } },
      'minecraft:glass': { variants: { '': { model: 'minecraft:block/glass' } } },
      'minecraft:ice': { variants: { '': { model: 'minecraft:block/ice' } } },
      ...extra.blockstates,
    },
    models: {
      'minecraft:block/cube': cube,
      'minecraft:block/cube_all': cubeAll,
      'minecraft:block/stone': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/stone' } },
      'minecraft:block/glass': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/glass' } },
      'minecraft:block/ice': { parent: 'minecraft:block/cube_all', textures: { all: 'minecraft:block/ice' } },
      ...extra.models,
    },
    items: {}, equipment: {}, biomes: {
      'minecraft:plains': [0.8, 0.4, null, null, null, null, 'none'],
      'minecraft:swamp': [0.8, 0.9, null, 0x6A7039, null, 0x617B64, 'swamp'],
    },
    paintings: { kebab: [1, 1, 'minecraft:kebab'], pool: [2, 1, 'minecraft:pool'] },
    fonts: [], textures: index, unifont: false,
  }
  return new GameAssets(bundle, {
    png: async (_id, o, l) => all.slice(o, o + l),
    unifont: async () => null,
    skin: async () => null,
  })
}

const TABLES = new URL('../app/bluemap/marumasign/structure/tables/', import.meta.url)

let blockData: BlockData | null = null
/** ブロックの性質の表 (MarumaSign 本体が作った tables/blocks.txt.gz) */
export function realBlockData(): BlockData {
  return blockData ??= BlockData.parse(gunzipSync(readFileSync(new URL('blocks.txt.gz', TABLES))).toString())
}

let entityModels: EntityModels | null = null
export function realEntityModels(): EntityModels {
  return entityModels ??= EntityModels.parse(gunzipSync(readFileSync(new URL('entity_models.txt.gz', TABLES))).toString())
}
