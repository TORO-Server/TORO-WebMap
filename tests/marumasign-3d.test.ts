// MarumaSign の 3D の看板 (3D モデル・ガウシアンスプラッティング・構造物) の、ブラウザーに頼らない部分の試験: npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { gzipSync } from 'node:zlib'
import {
  looksLikeNbt, modelPlacement, modelViewDistance, selectSplats, sniff, sniffGzipInner, sniffSplat, splatImportance,
  type SignShape,
} from '../app/bluemap/marumasign/core.ts'
import { NbtReader } from '../app/bluemap/marumasign/structure/nbt.ts'
import { parseTables, readStructure, Structure, type BlockTables } from '../app/bluemap/marumasign/structure/formats.ts'
import { meshStructure, MAX_QUADS } from '../app/bluemap/marumasign/structure/mesher.ts'
import { blockModel, TextureResolver } from '../app/bluemap/marumasign/structure/blocks.ts'
import { B, BA, C, encode, I, IA, L, LA, S, Sh } from './nbt-writer.ts'

const sign: SignShape = { ox: 0, oy: 0, oz: 0, sx: 1, sy: 1, roll: 0, yaw: 0, pitch: 0, orient: 0 }

/** 列優先の 4x4 で点を移す */
function apply(m: number[], x: number, y: number, z: number): number[] {
  return [m[0]! * x + m[4]! * y + m[8]! * z + m[12]!, m[1]! * x + m[5]! * y + m[9]! * z + m[13]!, m[2]! * x + m[6]! * y + m[10]! * z + m[14]!]
}

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps

test('3D モデルの置き方 (MarumaSign 本体の SignImage.computePlacement と同じ)', () => {
  // 一辺 2 の立方体のモデルは、大きさ 1 の画像の板と同じ範囲 (ブロックの 0 - 1) に収まる
  const m = modelPlacement(sign, [0, 0, 0, 2, 2, 2])
  const lo = apply(m, 0, 0, 0), hi = apply(m, 2, 2, 2)
  for (let k = 0; k < 3; k++) {
    assert.ok(near(Math.min(lo[k]!, hi[k]!), 0) && near(Math.max(lo[k]!, hi[k]!), 1), `axis ${k}: ${lo[k]} ${hi[k]}`)
  }
  // 向き 0 の立て看板 (南向き) では、モデルの +X は東、+Y は上、正面 +Z は南 (看板の正面)
  assert.ok(apply(m, 2, 1, 1)[0]! > apply(m, 0, 1, 1)[0]!)
  assert.ok(apply(m, 1, 2, 1)[1]! > apply(m, 1, 0, 1)[1]!)
  assert.ok(apply(m, 1, 1, 2)[2]! > apply(m, 1, 1, 0)[2]!)
  // 最も長い辺に合わせる (細長いものは縦横比を保つ)
  const tall = modelPlacement(sign, [0, 0, 0, 1, 4, 1])
  assert.ok(near(apply(tall, 0, 4, 0)[1]! - apply(tall, 0, 0, 0)[1]!, 1))
  assert.ok(near(Math.abs(apply(tall, 1, 0, 0)[0]! - apply(tall, 0, 0, 0)[0]!), 0.25))
  // 看板の大きさと位置のずれ
  const big = modelPlacement({ ...sign, sx: 3, sy: 3, oy: 1 }, [0, 0, 0, 2, 2, 2])
  assert.ok(near(apply(big, 1, 1, 1)[1]!, 1.5), String(apply(big, 1, 1, 1)[1]))
  assert.ok(near(apply(big, 2, 2, 2)[0]! - apply(big, 0, 0, 0)[0]!, 3))
  // 壁掛け (南向き = 向き 16) では、モデルの背面が壁 (北側の、ブロックの外側から 1/16) に付く
  const wall = modelPlacement({ ...sign, orient: 16 }, [0, 0, 0, 2, 2, 2])
  const back = Math.min(apply(wall, 1, 1, 0)[2]!, apply(wall, 1, 1, 2)[2]!)
  assert.ok(near(back, 0.5 - 0.4375), String(back))
  // 画像の板と同じ向きの回転: 向き 4 (西向き) の立て看板の正面は西 (-X)
  const west = modelPlacement({ ...sign, orient: 4 }, [0, 0, 0, 2, 2, 2])
  assert.ok(apply(west, 1, 1, 2)[0]! < apply(west, 1, 1, 0)[0]!)
  // 見える距離
  assert.ok(modelViewDistance(sign, [0, 0, 0, 2, 2, 2], 192) > 64)
})

test('ガウシアンスプラッティングの選び方 (MarumaSign 本体の SplatLoader.select と同じ)', () => {
  assert.equal(splatImportance(0, 1, 1, 1), 0)
  assert.ok(near(splatImportance(0.5, 1, 1, 1), 0.5 * Math.sqrt(3)))
  // 100 個が原点の近く、2 個が遠く (背景): 遠いものは省く
  const n = 102
  const pos = new Float32Array(n * 3), imp = new Float32Array(n)
  for (let i = 0; i < 100; i++) {
    pos[i * 3] = Math.cos(i) * (i % 10) / 10
    pos[i * 3 + 1] = Math.sin(i) * (i % 7) / 7
    pos[i * 3 + 2] = (i % 5) / 5
    imp[i] = i
  }
  pos.set([1000, 0, 0, 0, -1000, 0], 300)
  imp[100] = imp[101] = 1e9
  const all = selectSplats(imp, pos, n, 1000)
  assert.equal(all.length, 100)
  assert.ok(!all.includes(100) && !all.includes(101))
  // 上限より多ければ、目立つものから
  const top = selectSplats(imp, pos, n, 10)
  assert.deepEqual(Array.from(top), [90, 91, 92, 93, 94, 95, 96, 97, 98, 99])
  // 切り落とすと半分より少なくなるときは、切り落とさない
  const spread = new Float32Array([0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0])
  assert.equal(selectSplats(new Float32Array(4).fill(1), spread, 4, 10).length, 4)
})

test('3D の形式の判別 (MarumaSign 本体と同じ目印)', () => {
  const nbt = encode(C({ size: L(3, [I(1), I(1), I(1)]) }))
  assert.ok(looksLikeNbt(nbt, false))
  assert.equal(sniff(nbt, '', '')?.route, 'structure')
  const le = encode(C({ format_version: I(1) }), true)
  assert.ok(looksLikeNbt(le, true))
  assert.equal(sniff(le, '', 'mcstructure')?.route, 'structure')
  // gzip は中を見る
  assert.equal(sniff(gzipSync(nbt), '', '')?.format, 'gzip')
  assert.equal(sniff(gzipSync(nbt), '', 'schem')?.route, 'structure')
  assert.equal(sniffGzipInner(nbt, '')?.route, 'structure')
  assert.equal(sniffGzipInner(new TextEncoder().encode('NGSP\u0002'), '')?.format, 'spz')
  assert.equal(sniffGzipInner(new TextEncoder().encode('<svg>'), '')?.format, 'svgz')
  assert.equal(sniffGzipInner(new TextEncoder().encode('hello'), ''), null)
  // スプラット
  const zip = new Uint8Array(40)
  zip.set([0x50, 0x4B, 3, 4])
  zip.set([9, 0], 26)
  zip.set(new TextEncoder().encode('meta.json'), 30)
  assert.equal(sniffSplat(zip, ''), 'sog')
  assert.equal(sniffSplat(new Uint8Array([0x50, 0x4B, 3, 4, 0, 0]), 'sog'), 'sog')
  const splat = new Uint8Array(64)
  assert.equal(sniffSplat(splat, 'splat'), 'splat')
  assert.equal(sniffSplat(splat, ''), null, '.splat は拡張子がなければ決めない')
  const nan = new Uint8Array(64)
  new DataView(nan.buffer).setFloat32(4, NaN, true)
  assert.equal(sniffSplat(nan, 'splat'), null)
  const ksplat = new Uint8Array(64)
  const dv = new DataView(ksplat.buffer)
  ksplat[0] = 0; ksplat[1] = 1
  dv.setInt32(4, 1, true); dv.setInt32(12, 10, true); dv.setInt32(16, 10, true); dv.setUint16(20, 0, true)
  assert.equal(sniffSplat(ksplat, 'ksplat'), 'ksplat')
  const v4 = new Uint8Array(32)
  v4.set(new TextEncoder().encode('NGSP'))
  new DataView(v4.buffer).setInt32(4, 4, true)
  assert.equal(sniffSplat(v4, ''), 'spz')
})

test('NBT は壊れたものや悪意のある名前でも安全に読む', () => {
  const r = new NbtReader(encode(C({ ['__proto__']: I(1), a: L(8, [S('x'), S('y')]), l: LA([1n, -1n]) })), false).readRoot()
  assert.equal(r.value.get('__proto__'), 1)
  assert.equal(({} as Record<string, unknown>).polluted, undefined)
  assert.deepEqual(r.value.get('a'), ['x', 'y'])
  assert.deepEqual(Array.from(r.value.get('l') as BigInt64Array), [1n, -1n])
  // 長さが嘘のものは読まない
  const bad = encode(C({ a: BA([1, 2, 3]) }))
  bad[bad.length - 5] = 0x7F
  assert.throws(() => new NbtReader(bad, false).readRoot())
  assert.throws(() => new NbtReader(new Uint8Array([10, 0]), false).readRoot())
})

// ---- 構造物の形式ごと (同じ 2x2x2 のものを、それぞれの形式で書いて読む)
// (0,0,0)=石、(1,0,0)=樫の階段 (北向き)、(0,1,1)=ガラス、ほかは空気

const tables: BlockTables = parseTables(
  '# test\n0:0 minecraft:air\n1:0 minecraft:stone\n20:0 minecraft:glass\n53:2 minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]\nN minecraft:stone 1\n',
  '# test\nminecraft:stone[stone_type=stone] minecraft:stone\nminecraft:oak_stairs[upside_down_bit=0,weirdo_direction=3] minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]\n',
)

function check(st: Structure): void {
  assert.equal(st.sizeX, 2)
  assert.equal(st.sizeY, 2)
  assert.equal(st.sizeZ, 2)
  const name = (x: number, y: number, z: number): string => st.palette[st.get(x, y, z)]!.split('[')[0]!
  assert.equal(name(0, 0, 0), 'minecraft:stone')
  assert.equal(name(1, 0, 0), 'minecraft:oak_stairs')
  assert.match(st.palette[st.get(1, 0, 0)]!, /facing=north/)
  assert.equal(name(0, 1, 1), 'minecraft:glass')
  assert.equal(st.get(1, 1, 1), 0)
}

const STAIRS = 'minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]'

test('構造物: Sponge Schematic 2 と 3', async () => {
  // 並びは x、z、y の順 (x が最も速い)。番号: 0 空気、1 石、2 階段、3 ガラス
  const data = [1, 2, 0, 0, 0, 0, 3, 0]
  const v2 = C({ Version: I(2), Width: Sh(2), Height: Sh(2), Length: Sh(2), Palette: C({ 'minecraft:air': I(0), 'minecraft:stone': I(1), [STAIRS]: I(2), 'minecraft:glass': I(3) }), BlockData: BA(data) })
  check(await readStructure(encode(v2), async () => tables))
  const v3 = C({ Schematic: C({ Version: I(3), Width: Sh(2), Height: Sh(2), Length: Sh(2), Blocks: C({ Palette: C({ 'minecraft:air': I(0), stone: I(1), [STAIRS]: I(2), 'minecraft:glass': I(3) }), Data: BA(data) }) }) })
  check(await readStructure(encode(v3), async () => tables))
})

test('構造物: Litematica (番号は long の境目をまたいで詰める)', async () => {
  // パレット 4 つで 2 ビット。並びは x、z、y
  const values = [1, 2, 0, 0, 0, 0, 3, 0]
  let bits = 0n
  values.forEach((v, i) => (bits |= BigInt(v) << BigInt(i * 2)))
  const region = C({
    Position: C({ x: I(0), y: I(0), z: I(0) }), Size: C({ x: I(2), y: I(2), z: I(-2) }),
    BlockStatePalette: L(10, [C({ Name: S('minecraft:air') }), C({ Name: S('minecraft:stone') }),
      C({ Name: S('minecraft:oak_stairs'), Properties: C({ facing: S('north'), half: S('bottom'), shape: S('straight'), waterlogged: S('false') }) }),
      C({ Name: S('minecraft:glass') })]),
    BlockStates: LA([BigInt.asIntN(64, bits)]),
  })
  check(await readStructure(encode(C({ Version: I(6), Regions: C({ main: region }) })), async () => tables))
  // 3 ビットで 64 ビットの境目をまたぐ並び
  const n = 30
  const st = new Structure(n, 1, 1)
  assert.equal(st.sizeX, n)
  let big = 0n
  const vals = Array.from({ length: n }, (_, i) => (i % 5))
  vals.forEach((v, i) => (big |= BigInt(v) << BigInt(i * 3)))
  const longs = [BigInt.asIntN(64, big & ((1n << 64n) - 1n)), BigInt.asIntN(64, big >> 64n)]
  const palette = ['air', 'stone', 'dirt', 'glass', 'sand'].map(s => C({ Name: S('minecraft:' + s) }))
  const r2 = C({ Position: C({ x: I(0), y: I(0), z: I(0) }), Size: C({ x: I(n), y: I(1), z: I(1) }), BlockStatePalette: L(10, palette), BlockStates: LA(longs) })
  const s2 = await readStructure(encode(C({ Version: I(6), Regions: C({ r: r2 }) })), async () => tables)
  for (let i = 0; i < n; i++) assert.equal(s2.palette[s2.get(i, 0, 0)], ['minecraft:air', 'minecraft:stone', 'minecraft:dirt', 'minecraft:glass', 'minecraft:sand'][vals[i]!], String(i))
})

test('構造物: ストラクチャーブロック (.nbt。26.1 からの {id, properties} も)', async () => {
  const palette = L(10, [C({ Name: S('minecraft:stone') }), C({ id: S('minecraft:oak_stairs'), properties: C({ facing: S('north'), half: S('bottom'), shape: S('straight'), waterlogged: S('false') }) }), C({ Name: S('minecraft:glass') })])
  const blocks = L(10, [
    C({ pos: L(3, [I(0), I(0), I(0)]), state: I(0) }), C({ pos: L(3, [I(1), I(0), I(0)]), state: I(1) }), C({ pos: L(3, [I(0), I(1), I(1)]), state: I(2) }),
  ])
  check(await readStructure(encode(C({ DataVersion: I(4440), size: L(3, [I(2), I(2), I(2)]), palette, blocks })), async () => tables))
})

test('構造物: 統合版 (.mcstructure。リトルエンディアン、並びは z、y、x)', async () => {
  // index = (x * sy + y) * sz + z
  const idx = new Array(8).fill(-1)
  idx[0] = 0 // (0,0,0) 石
  idx[(1 * 2 + 0) * 2 + 0] = 1 // (1,0,0) 階段
  idx[(0 * 2 + 1) * 2 + 1] = 2 // (0,1,1) ガラス
  const root = C({
    format_version: I(1), size: L(3, [I(2), I(2), I(2)]),
    structure: C({
      block_indices: L(11, [IA(idx), IA(new Array(8).fill(-1))]),
      palette: C({ default: C({ block_palette: L(10, [
        C({ name: S('minecraft:stone'), states: C({ stone_type: S('stone') }) }),
        C({ name: S('minecraft:oak_stairs'), states: C({ upside_down_bit: B(0), weirdo_direction: I(3) }) }),
        C({ name: S('minecraft:glass'), states: C({}) }),
      ]) }) }),
    }),
  })
  check(await readStructure(encode(root, true), async () => tables))
})

test('構造物: MCEdit の .schematic (1.12 までの番号)', async () => {
  const blocks = [1, 53, 0, 0, 0, 0, 20, 0]
  const data = [0, 2, 0, 0, 0, 0, 0, 0]
  check(await readStructure(encode(C({ Width: Sh(2), Height: Sh(2), Length: Sh(2), Materials: S('Alpha'), Blocks: BA(blocks), Data: BA(data) })), async () => tables))
})

test('構造物: 四角形にする (隠れる面を省き、多すぎればまとめる)', () => {
  const textures = ['minecraft:block/stone', 'minecraft:block/oak_planks', 'minecraft:block/glass', 'minecraft:block/grass_block_top', 'minecraft:block/grass_block_side', 'minecraft:block/dirt']
  // 2x1x1 の石: 接する 2 面を省いて 10 面
  const st = new Structure(2, 1, 1)
  const stone = st.paletteId('minecraft:stone')
  st.set(0, 0, 0, stone)
  st.set(1, 0, 0, stone)
  const r = meshStructure(st, textures)
  assert.equal(r.quads, 10)
  assert.deepEqual(r.box, [0, 0, 0, 2, 1, 1])
  assert.equal(r.groups.length, 1)
  assert.equal(r.groups[0]!.key, 'minecraft:block/stone')
  assert.equal(r.groups[0]!.indices.length, 60)
  // 面の向きで明るさを変える (上 1.0、下 0.5)
  const colors = r.groups[0]!.colors
  assert.ok(colors.some(c => near(c, 1)) && colors.some(c => near(c, 0.5, 0.01)))
  // 草のブロック: 上は草の色を掛け、横は横の絵、下は土
  const resolver = new TextureResolver(textures)
  const grass = blockModel('minecraft:grass_block[snowy=false]', resolver)
  assert.deepEqual(grass.tex, ['minecraft:block/grass_block_top', 'minecraft:block/dirt', 'minecraft:block/grass_block_side', 'minecraft:block/grass_block_side', 'minecraft:block/grass_block_side', 'minecraft:block/grass_block_side'])
  assert.equal(grass.tintFaces & 1, 1)
  // 樫の階段は樫の板の絵で、2 つの箱
  const stairs = blockModel(STAIRS, resolver)
  assert.equal(stairs.boxes.length, 2)
  assert.equal(stairs.tex[0], 'minecraft:block/oak_planks')
  assert.equal(stairs.occludes, false)
  // 地図に絵のないブロックは色で塗る
  assert.match(blockModel('minecraft:some_mod_block', resolver).tex[0]!, /^#[0-9a-f]{6}$/)
  // 空気と見えないものは描かない
  assert.equal(blockModel('minecraft:barrier', resolver).air, true)
  // 面が多すぎれば 2 x 2 x 2 をまとめる (市松模様は面が多い)
  const n = 64
  const checker = new Structure(n, n, n)
  const id = checker.paletteId('minecraft:stone')
  for (let y = 0; y < n; y++) for (let z = 0; z < n; z++) for (let x = 0; x < n; x++) if ((x + y + z) % 2 === 0) checker.set(x, y, z, id)
  const coarse = meshStructure(checker, textures)
  assert.ok(coarse.quads <= MAX_QUADS)
  assert.ok(coarse.step >= 2)
  assert.deepEqual(coarse.box, [0, 0, 0, n, n, n])
})

test('構造物: 大きすぎるものは間引く', () => {
  const st = new Structure(4096, 4, 4096)
  assert.ok(st.sizeX * st.sizeY * st.sizeZ <= 16 * 1024 * 1024)
  assert.ok(st.step >= 2)
  assert.throws(() => new Structure(70000, 1, 1))
})
