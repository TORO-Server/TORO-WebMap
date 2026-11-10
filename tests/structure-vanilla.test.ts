// 構造物を Minecraft と同じ形で描く処理 (app/bluemap/marumasign/structure/ の vanilla.ts など) の試験: npm test
// blockstates と models は試験用に自分で書いたもの (Mojang のファイルは使わない)。ブロックの性質の表 (tables/blocks.txt.gz) は本物
// MCJAR に Minecraft のクライアントの jar を渡すと、本物のリソースでも確かめる (なければ飛ばす)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync, gunzipSync } from 'node:zlib'
import { animate, Atlas, halveImage, MIP_LEVELS } from '../app/bluemap/marumasign/structure/atlas.ts'
import { fixSkin, GameAssets, Sprite, spriteFromPng, TRANSLUCENT, CUTOUT, OPAQUE } from '../app/bluemap/marumasign/structure/assets.ts'
import { BiomeColors } from '../app/bluemap/marumasign/structure/biomes.ts'
import { BlockModels, matchesCondition, matchesVariant } from '../app/bluemap/marumasign/structure/block-models.ts'
import { BlockState } from '../app/bluemap/marumasign/structure/block-state.ts'
import { fixStructure } from '../app/bluemap/marumasign/structure/fixer.ts'
import { parseTables, readStructure, Structure } from '../app/bluemap/marumasign/structure/formats.ts'
import { blockSeed, JavaRandom } from '../app/bluemap/marumasign/structure/java-random.ts'
import { NbtReader } from '../app/bluemap/marumasign/structure/nbt.ts'
import { parseSignSpec } from '../app/bluemap/marumasign/structure/nested.ts'
import { decodePng } from '../app/bluemap/marumasign/structure/png.ts'
import { parseText } from '../app/bluemap/marumasign/structure/sign-text.ts'
import { PlayerSkins, profileSkin, profileSkinInfo, skinUrl } from '../app/bluemap/marumasign/structure/skins.ts'
import { normalizeUuid, SkinResolver, texturesToSkin } from '../server/utils/skin-lookup.ts'
import { signSpec, SpecialModels } from '../app/bluemap/marumasign/structure/special.ts'
import { LAYER_CUTOUT, LAYER_SOLID, LAYER_TRANSLUCENT, StructureMesher } from '../app/bluemap/marumasign/structure/structure-mesher.ts'
import { meshVanilla } from '../app/bluemap/marumasign/structure/vanilla.ts'
import { buildMcAssets, compareVersions, resolveClientJar } from '../server/utils/mcassets-build.ts'
import { ZipFile } from '../server/utils/zip.ts'
import { fixtureAssets, png, realBlockData, realEntityModels } from './mc-fixtures.ts'
import { B, C, D, encode, F, I, L, S, Sh, BA } from './nbt-writer.ts'

/** 読み込みを済ませてから四角形にする (vanilla.ts の流れのうち、四角形にするところだけ) */
async function mesh(st: Structure, assets: GameAssets): Promise<StructureMesher> {
  const data = realBlockData()
  fixStructure(st, data, null)
  let mesher!: StructureMesher
  for (let pass = 0; pass < 5; pass++) {
    const models = new BlockModels(assets, data)
    const biomes = new BiomeColors(assets)
    mesher = new StructureMesher(st, data, models, biomes, new SpecialModels(models, realEntityModels(), biomes))
    mesher.build()
    if (!assets.hasNeeds) break
    await assets.fulfill()
  }
  return mesher
}

function quads(m: StructureMesher, layer: number): { pos: number[], uv: number[], color: number[], sprite: string }[] {
  const o = m.output
  const out = []
  for (let q = 0; q < o.spriteOf[layer]!.n; q++) {
    out.push({
      pos: Array.from(o.positions[layer]!.a.subarray(q * 12, q * 12 + 12)),
      uv: Array.from(o.uvs[layer]!.a.subarray(q * 8, q * 8 + 8)),
      color: Array.from(o.colors[layer]!.a.subarray(q * 4, q * 4 + 4)),
      sprite: o.sprites[o.spriteOf[layer]!.a[q]!]!.id,
    })
  }
  return out
}

test('java.util.Random と Mth.getSeed がゲームと同じ値', () => {
  const r = new JavaRandom()
  r.setSeed(0n)
  assert.equal(r.nextLong(), -4962768465676381896n)
  r.setSeed(42n)
  const ints = [r.nextInt(10), r.nextInt(10), r.nextInt(16), r.nextInt(7)]
  // 同じ種なら同じ並び
  r.setSeed(42n)
  assert.deepEqual([r.nextInt(10), r.nextInt(10), r.nextInt(16), r.nextInt(7)], ints)
  assert.equal(typeof blockSeed(1, 2, 3), 'bigint')
  assert.equal(blockSeed(0, 0, 0), 0n)
})

test('blockstates: variants と multipart の条件 (OR / AND / | / !)', () => {
  const s = BlockState.parse('minecraft:oak_fence[east=true,north=false,south=true,waterlogged=false,west=false]')
  assert.equal(matchesVariant(s, ''), true)
  assert.equal(matchesVariant(s, 'east=true'), true)
  assert.equal(matchesVariant(s, 'east=true,north=true'), false)
  assert.equal(matchesCondition(s, { north: 'false', south: 'true' }, 0), true)
  assert.equal(matchesCondition(s, { north: 'true|false' }, 0), true)
  assert.equal(matchesCondition(s, { west: '!true' }, 0), true)
  assert.equal(matchesCondition(s, { OR: [{ north: 'true' }, { east: 'true' }] }, 0), true)
  assert.equal(matchesCondition(s, { AND: [{ north: 'true' }, { east: 'true' }] }, 0), false)
  assert.equal(matchesCondition(s, { missing: 'x' }, 0), false)
})

test('models: 継承・テクスチャの参照・回転・uvlock・cullface の回転', async () => {
  const assets = fixtureAssets({
    blockstates: {
      'minecraft:oak_stairs': { variants: { 'facing=east,half=bottom,shape=straight': { model: 'minecraft:block/step' }, 'facing=north,half=bottom,shape=straight': { model: 'minecraft:block/step', y: 270, uvlock: true } } },
    },
    models: {
      'minecraft:block/step_parent': { textures: { side: 'minecraft:block/planks' }, elements: [{ from: [0, 0, 0], to: [16, 8, 16], faces: { up: { texture: '#top' }, east: { texture: '#side', cullface: 'east' } } }] },
      'minecraft:block/step': { parent: 'minecraft:block/step_parent', textures: { top: '#side' } },
    },
  })
  await assets.fulfill()
  assets.sprite('minecraft:block/planks')
  await assets.fulfill()
  const models = new BlockModels(assets, realBlockData())
  const east = models.model(BlockState.parse('minecraft:oak_stairs[facing=east,half=bottom,shape=straight,waterlogged=false]'))
  const v = east.choices[0]!.variants[0]!
  assert.equal(v.quads.length, 2)
  // 子のモデルの #top は親の #side (planks)
  assert.ok(v.quads.every(q => q.sprite.id === 'minecraft:block/planks'))
  const top = v.quads.find(q => q.direction === 1)!
  assert.deepEqual(Array.from(top.positions).filter((_, i) => i % 3 === 1), [0.5, 0.5, 0.5, 0.5])
  assert.equal(v.quads.find(q => q.direction === 5)!.cull, 5)
  // y: 270 で東の面は北を向き、cullface も北になる。uvlock なら上の面の UV は回らない
  const north = models.model(BlockState.parse('minecraft:oak_stairs[facing=north,half=bottom,shape=straight,waterlogged=false]')).choices[0]!.variants[0]!
  const side = north.quads.find(q => q.cull >= 0)!
  assert.equal(side.direction, 2)
  assert.equal(side.cull, 2)
  const top2 = north.quads.find(q => q.direction === 1)!
  assert.deepEqual(Array.from(top2.uvs), Array.from(top.uvs))
  // 知らないブロックは紫と黒の立方体
  const missing = models.model(BlockState.parse('somemod:thing'))
  assert.equal(missing.choices[0]!.variants[0]!.quads[0]!.sprite.missing, true)
})

test('models: 要素の回転 (rescale) と重み付きのモデル', async () => {
  const assets = fixtureAssets({
    blockstates: {
      'minecraft:poppy': { variants: { '': [{ model: 'minecraft:block/cross', weight: 3 }, { model: 'minecraft:block/cross', y: 90 }] } },
    },
    models: {
      'minecraft:block/cross': {
        ambientocclusion: false, textures: { cross: 'minecraft:block/glass' },
        elements: [{ from: [0.8, 0, 8], to: [15.2, 16, 8], rotation: { origin: [8, 8, 8], axis: 'y', angle: 45, rescale: true }, faces: { north: { texture: '#cross' }, south: { texture: '#cross' } } }],
      },
    },
  })
  const models = new BlockModels(assets, realBlockData())
  const m = models.model(BlockState.parse('minecraft:poppy'))
  assert.equal(m.random, true)
  const v = m.choices[0]!.variants[0]!
  assert.equal(v.ambientOcclusion, false)
  // 45 度回して引き伸ばした面は、ブロックの対角線の長さ
  const p = v.quads[0]!.positions
  const len = Math.hypot(p[0]! - p[6]!, p[2]! - p[8]!)
  assert.ok(Math.abs(len - (14.4 / 16) * Math.SQRT2) < 1e-3, String(len))
})

test('テクスチャの透明度から層を決める (不透明・切り抜き・半透明)', async () => {
  const assets = fixtureAssets()
  for (const id of ['stone', 'glass', 'ice']) assets.sprite('minecraft:block/' + id)
  await assets.fulfill()
  assert.equal(assets.sprite('minecraft:block/stone').transparency(0, 0, 1, 1), OPAQUE)
  assert.equal(assets.sprite('minecraft:block/glass').transparency(0, 0, 1, 1), CUTOUT)
  assert.equal(assets.sprite('minecraft:block/ice').transparency(0, 0, 1, 1), TRANSLUCENT)
  const st = new Structure(3, 1, 1)
  st.set(0, 0, 0, st.paletteId('minecraft:stone'))
  st.set(1, 0, 0, st.paletteId('minecraft:glass'))
  st.set(2, 0, 0, st.paletteId('minecraft:ice'))
  const m = await mesh(st, assets)
  assert.ok(quads(m, LAYER_SOLID).every(q => q.sprite === 'minecraft:block/stone'))
  assert.ok(quads(m, LAYER_CUTOUT).every(q => q.sprite === 'minecraft:block/glass'))
  assert.ok(quads(m, LAYER_TRANSLUCENT).every(q => q.sprite === 'minecraft:block/ice'))
  // 石とガラスの間の面: ガラスは石に隠れる。石の東の面はガラス (透ける) の側なので描く
  const stoneEast = quads(m, LAYER_SOLID).filter(q => q.pos.every((v, i) => i % 3 !== 0 || v === 1))
  assert.equal(stoneEast.length, 1)
  assert.equal(quads(m, LAYER_CUTOUT).filter(q => q.pos.every((v, i) => i % 3 !== 0 || v === 1)).length, 0)
})

test('面の向きの明るさと、なめらかな明るさ (環境光の遮蔽)', async () => {
  const assets = fixtureAssets()
  // 1 つだけの石: 上 1.0、下 0.5、北と南 0.8、東と西 0.6 (Minecraft と同じ)
  const one = new Structure(1, 1, 1)
  one.set(0, 0, 0, one.paletteId('minecraft:stone'))
  const m1 = await mesh(one, assets)
  const byNormal = new Map<string, number>()
  for (const q of quads(m1, LAYER_SOLID)) {
    const p = q.pos
    const axis = [0, 1, 2].find(a => p[a] === p[3 + a] && p[a] === p[6 + a])!
    byNormal.set(axis + ':' + p[axis], q.color[0]! & 255)
  }
  assert.equal(byNormal.get('1:1'), 255)
  assert.equal(byNormal.get('1:0'), 127)
  assert.equal(byNormal.get('2:0'), 204)
  assert.equal(byNormal.get('0:1'), 153)
  // 石の上の面のうち、東の隣の上に石があると、その側の 2 つの頂点が暗くなる ((0.2 + 1 + 1 + 1) / 4 = 0.8 → 204)
  const st = new Structure(2, 2, 1)
  const stone = st.paletteId('minecraft:stone')
  st.set(0, 0, 0, stone)
  st.set(1, 1, 0, stone)
  const m2 = await mesh(st, assets)
  const top = quads(m2, LAYER_SOLID).find(q => q.pos[1] === 1 && q.pos[4] === 1 && q.pos[7] === 1 && q.pos[0]! < 1 && q.pos[6]! <= 1)!
  const byX = [0, 1, 2, 3].map(v => [top.pos[v * 3]!, top.color[v]! & 255])
  for (const [x, c] of byX) assert.equal(c, x === 1 ? 204 : 255, JSON.stringify(byX))
})

test('草の色: 構造物のバイオーム (なければ平原) と、まわり 5 x 5 の平均', async () => {
  const assets = fixtureAssets({
    blockstates: { 'minecraft:grass_block': { variants: { 'snowy=false': { model: 'minecraft:block/grass' } } } },
    models: { 'minecraft:block/grass': { textures: { top: 'minecraft:block/stone' }, elements: [{ from: [0, 0, 0], to: [16, 16, 16], faces: { up: { texture: '#top', tintindex: 0, cullface: 'up' } } }] } },
  })
  const st = new Structure(1, 1, 1)
  st.set(0, 0, 0, st.paletteId('minecraft:grass_block[snowy=false]'))
  const m = await mesh(st, assets)
  const plains = quads(m, LAYER_SOLID)[0]!.color[0]!
  // 試験の色の表 (x = 温度、y = 雨の量 × 温度): 平原 (0.8, 0.4) → x = 51, y = 173
  const t = 0.8, d = 0.4 * 0.8
  const expected = (Math.trunc((1 - t) * 255) << 16 | Math.trunc((1 - d) * 255) << 8 | 77)
  // 上の面は明るさ 1.0 なので色そのまま (8 ビットの丸めの分だけずれることがある)
  assert.ok(Math.abs((plains >> 16) - (expected >> 16)) <= 1 && Math.abs(((plains >> 8) & 255) - ((expected >> 8) & 255)) <= 1, plains.toString(16))
  // 沼のバイオームの草の色は決まった色
  const swamp = new Structure(1, 1, 1)
  swamp.set(0, 0, 0, swamp.paletteId('minecraft:grass_block[snowy=false]'))
  swamp.biomePalette = ['minecraft:swamp']
  swamp.biomes = new Uint16Array(1)
  const m2 = await mesh(swamp, assets)
  assert.equal(quads(m2, LAYER_SOLID)[0]!.color[0], 0x6A7039)
})

test('液体: 源と流れの高さ、同じ液体の間の面を省く', async () => {
  const assets = fixtureAssets({ textures: { 'minecraft:block/water_still': [png(16, 16, () => [60, 90, 200, 180])], 'minecraft:block/water_flow': [png(16, 16, () => [60, 90, 200, 180])], 'minecraft:block/water_overlay': [png(16, 16, () => [60, 90, 200, 180])] } })
  const st = new Structure(2, 1, 1)
  st.set(0, 0, 0, st.paletteId('minecraft:water[level=0]'))
  st.set(1, 0, 0, st.paletteId('minecraft:water[level=4]'))
  const m = await mesh(st, assets)
  const q = quads(m, LAYER_TRANSLUCENT)
  assert.ok(q.length > 0)
  // 2 つの水の間 (x = 1) の縦の面は描かない
  assert.equal(q.filter(x => [0, 3, 6, 9].every(i => Math.abs(x.pos[i]! - 1) < 0.01)).length, 0)
  // 源の上面は 8/9 より低い
  const top = q.filter(x => x.pos[0]! < 1 && x.pos[1]! > 0.5)
  assert.ok(top.length > 0 && top.every(x => x.pos[1]! < 0.9))
})

test('ブロックエンティティ: 看板の文字 (表と裏、色、光る文字) と MarumaSign の看板', () => {
  const text = (lines: string[], color = 'black', glow = 0): Map<string, unknown> => new Map<string, unknown>([
    ['messages', lines.map(l => JSON.stringify(l))], ['color', color], ['has_glowing_text', glow],
  ])
  const be = new Map<string, unknown>([['front_text', text(['https://example.com/a.p', 'ng|0|0|0|2|1|0|', '0|0', ''])], ['back_text', text([''])]])
  const spec = signSpec(be as never, 'java')
  assert.equal(spec?.url, 'https://example.com/a.png')
  assert.equal(spec?.scaleX, 2)
  assert.equal(signSpec(new Map([['front_text', text(['Hello', 'world'])]]) as never, 'java'), null)
  // 1.12 までの Text1 - Text4 と、統合版の Text
  assert.equal(signSpec(new Map<string, unknown>([['Text1', '{"text":"https://e.com/x.png|1|2|3|1|1|0|0|0"}']]) as never, 'legacy')?.y, 2)
  // § の色と太字、JSON のテキストコンポーネント
  const runs = parseText('{"text":"a","color":"red","extra":[{"text":"§lb§rc"}]}')
  assert.deepEqual(runs.map(r => [r.text, r.color, r.bold]), [['a', 0xFF5555, false], ['b', 0xFF5555, true], ['c', 0xFF5555, false]])
  assert.equal(parseSignSpec('a|b|c'), null)
  assert.equal(parseSignSpec('u|1|2|3|4|5|6|7|NaN'), null)
  assert.equal(parseSignSpec('u|1|2|3|4|5000|6|7|8')?.scaleY, 1000)
})

test('プレイヤーの頭: textures.minecraft.net のスキンだけを読む', () => {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64')
  assert.equal(skinUrl(b64({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/abc123' } } })), 'https://textures.minecraft.net/texture/abc123')
  assert.equal(skinUrl(b64({ textures: { SKIN: { url: 'https://evil.example/texture/abc' } } })), '')
  assert.equal(skinUrl(b64({ textures: { SKIN: { url: 'https://textures.minecraft.net.evil.example/texture/abc' } } })), '')
  assert.equal(skinUrl(b64({ textures: { SKIN: { url: 'https://textures.minecraft.net/texture/../x' } } })), '')
  const profile = new Map<string, unknown>([['properties', [new Map([['name', 'textures'], ['value', b64({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/ff00' } } })]])]]])
  assert.equal(profileSkin(new Map([['profile', profile]]) as never), 'https://textures.minecraft.net/texture/ff00')
  // 古い 64 x 32 のスキンの、全部不透明な帽子の層は消す (ゲームと同じ)
  const px = new Uint8Array(64 * 64 * 4).fill(255)
  fixSkin(px, true)
  assert.equal(px[(4 * 64 + 40) * 4 + 3], 0)
  assert.equal(px[(4 * 64 + 4) * 4 + 3], 255)
})

test('構造物のファイル: ブロックエンティティ・エンティティ・バイオームを読む', async () => {
  const tables = parseTables('', '')
  // ストラクチャーブロック (.nbt)
  const nbt = encode(C({
    DataVersion: I(4600), size: L(3, [I(2), I(1), I(1)]),
    palette: L(10, [C({ Name: S('minecraft:oak_sign'), Properties: C({ rotation: S('0'), waterlogged: S('false') }) })]),
    blocks: L(10, [C({ pos: L(3, [I(1), I(0), I(0)]), state: I(0), nbt: C({ front_text: C({ messages: L(8, [S('"hi"')]), color: S('red'), has_glowing_text: B(1) }) }) })]),
    entities: L(10, [C({ pos: L(6, [D(0.5), D(0.5), D(0.03)]), nbt: C({ id: S('minecraft:painting'), variant: S('minecraft:kebab'), facing: B(0), Rotation: L(5, [F(0), F(0)]) }) })]),
  }))
  const st = await readStructure(nbt, async () => tables)
  assert.equal(st.source, 'java')
  assert.equal(st.blockEntities.size, 1)
  assert.equal(st.blockEntities.get(st.index(1, 0, 0))?.get('front_text') instanceof Map, true)
  assert.equal(st.entities.length, 1)
  assert.equal(st.entities[0]!.id, 'minecraft:painting')
  assert.equal(st.entities[0]!.z, 0.03)
  // Sponge Schematic 3 のバイオーム (3 次元) とブロックエンティティ
  const v3 = encode(C({
    Schematic: C({
      Version: I(3), DataVersion: I(4600), Width: Sh(2), Height: Sh(1), Length: Sh(1),
      Blocks: C({ Palette: C({ 'minecraft:air': I(0), 'minecraft:chest[facing=north,type=single,waterlogged=false]': I(1) }), Data: BA([1, 0]), BlockEntities: L(10, [C({ Pos: { t: 11, v: [0, 0, 0] }, Id: S('minecraft:chest'), Data: C({ Items: L(10, []) }) })]) }),
      Biomes: C({ Palette: C({ 'minecraft:plains': I(0), 'minecraft:swamp': I(1) }), Data: BA([0, 1]) }),
    }),
  }))
  const s3 = await readStructure(v3, async () => tables)
  assert.equal(s3.blockEntities.get(0)?.get('id'), 'minecraft:chest')
  assert.deepEqual([s3.biome(0), s3.biome(1)], ['minecraft:plains', 'minecraft:swamp'])
  // 粗くしても、ブロックエンティティとバイオームとエンティティは残る
  const half = s3.halve()
  assert.equal(half.blockEntities.size, 1)
  assert.equal(half.biome(0), 'minecraft:plains')
  void NbtReader
})

test('状態をそろえる: 1.12 までの形式のつながりと、ベッドの色と、名前の付け替え', () => {
  const data = realBlockData()
  const st = new Structure(3, 1, 2)
  st.source = 'legacy'
  const fence = st.paletteId('minecraft:oak_fence[east=false,north=false,south=false,west=false]')
  st.set(0, 0, 0, fence)
  st.set(1, 0, 0, fence)
  st.set(2, 0, 0, st.paletteId('minecraft:stone'))
  const bed = st.paletteId('minecraft:red_bed[facing=north,occupied=false,part=foot]')
  st.set(0, 0, 1, bed)
  st.setBlockEntity(0, 0, 1, new Map<string, never>([['id', 'minecraft:bed' as never], ['color', 11 as never]]))
  st.set(1, 0, 1, st.paletteId('minecraft:grass'))
  fixStructure(st, data, null)
  assert.equal(st.state(st.get(0, 0, 0)).get('east'), 'true')
  assert.equal(st.state(st.get(1, 0, 0)).get('east'), 'true')
  assert.equal(st.state(st.get(1, 0, 0)).get('west'), 'true')
  assert.equal(st.state(st.get(0, 0, 1)).name, 'minecraft:blue_bed')
  assert.equal(st.state(st.get(1, 0, 1)).name, 'minecraft:short_grass')
})

test('アトラス: まとめた画像と、動くテクスチャを tick ごとに進める', async () => {
  const assets = fixtureAssets()
  assets.sprite('minecraft:block/flow')
  assets.sprite('minecraft:block/stone')
  await assets.fulfill()
  const flow = assets.sprite('minecraft:block/flow')
  assert.equal(flow.isAnimated(), true)
  assert.deepEqual(flow.times, [2, 2, 2, 2])
  const atlas = new Atlas([assets.sprite('minecraft:block/stone'), flow])
  assert.equal(atlas.pages.length, 2)
  const anim = atlas.pages.find(p => p.animated)!
  const shown = new Int32Array(1).fill(-1)
  const red = (): number => anim.pixels[(anim.animated![0]!.y * anim.width + anim.animated![0]!.x) * 4]!
  assert.equal(animate(anim, anim.animated!, shown, 0), true)
  assert.equal(red(), 0)
  // 1 コマ 2 tick: tick 1 では変わらず、tick 2 で次のコマ
  assert.equal(animate(anim, anim.animated!, shown, 1), false)
  assert.equal(animate(anim, anim.animated!, shown, 2), true)
  assert.equal(red(), 60)
  assert.equal(animate(anim, anim.animated!, shown, 8), true)
  assert.equal(red(), 0)
  // interpolate: 間の tick では混ぜる
  const s = await spriteFromPng('x', png(16, 32, (_x, y) => [y < 16 ? 0 : 200, 0, 0, 255]), { frametime: 4, interpolate: true })
  const a2 = new Atlas([s]).pages[0]!
  const sh2 = new Int32Array(1).fill(-1)
  animate(a2, a2.animated!, sh2, 2)
  assert.equal(a2.pixels[(a2.animated![0]!.y * a2.width + a2.animated![0]!.x) * 4], 100)
})

test('ミップマップ: テクスチャごとに縮め、隣のテクスチャと混ざらない。切り抜きはアルファ 96 未満を透明に', async () => {
  const red = Sprite.of('red', 16, 16, new Uint8Array(16 * 16 * 4).map((_, i) => i % 4 === 0 || i % 4 === 3 ? 255 : 0))
  const blue = Sprite.of('blue', 16, 16, new Uint8Array(16 * 16 * 4).map((_, i) => i % 4 === 2 || i % 4 === 3 ? 255 : 0))
  const atlas = new Atlas([red, blue])
  const page = atlas.pages[0]!
  assert.equal(page.mips.length, MIP_LEVELS)
  // どの段でも、それぞれのテクスチャの場所はその色だけ
  for (let k = 1; k <= MIP_LEVELS; k++) {
    const size = page.width >> k
    const mip = page.mips[k - 1]!
    const colors = new Set<string>()
    for (const s of [16, 48]) {
      const x = s >> k, y = 16 >> k
      for (let dy = 0; dy < Math.max(1, 16 >> k); dy++) for (let dx = 0; dx < Math.max(1, 16 >> k); dx++) {
        const o = ((y + dy) * size + x + dx) * 4
        colors.add(s + ':' + Array.from(mip.subarray(o, o + 4)).join(','))
      }
    }
    assert.deepEqual([...colors].sort(), ['16:255,0,0,255', '48:0,0,255,255'], 'level ' + k)
  }
  // 切り抜き (ゲームと同じ計算): 4 つとも透明なら透明、1 つだけ不透明なら (0.25 の 1/2.2 乗 → 135)、3 つなら不透明に近い。
  // 色は透明なピクセルを混ぜない (縁が黒くならない)
  const px = new Uint8Array(2 * 2 * 4)
  assert.equal(halveImage(px, 2, 2, true).px[3], 0)
  px.set([255, 255, 255, 255], 0)
  assert.equal(halveImage(px, 2, 2, true).px[3], 135)
  px.set([255, 255, 255, 255], 4)
  px.set([255, 255, 255, 255], 8)
  assert.ok(halveImage(px, 2, 2, true).px[3]! > 200)
  // 不透明なものは 2.2 乗して平均 (黒と白 → 186)
  const bw = new Uint8Array([0, 0, 0, 255, 255, 255, 255, 255, 0, 0, 0, 255, 255, 255, 255, 255])
  assert.equal(halveImage(bw, 2, 2, false).px[0], 186)
})

test('名前や UUID だけのプレイヤーの頭: サーバーが決まった Mojang のサーバーに聞き、URL だけを返す', async () => {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64')
  // ブラウザーの側: 問い合わせは形を確かめた name= か uuid= だけ
  assert.deepEqual(profileSkinInfo(new Map([['profile', new Map([['name', 'Notch']])]]) as never), { url: '', query: 'name=Notch' })
  assert.deepEqual(profileSkinInfo(new Map([['profile', new Map([['name', 'bad name!']])]]) as never), { url: '', query: '' })
  assert.deepEqual(profileSkinInfo(new Map([['profile', new Map([['id', Int32Array.from([0x069a79f4, 0x44e94726, -1514210135, 0x0e38aaf5])]])]]) as never), { url: '', query: 'uuid=069a79f444e94726a5befca90e38aaf5' })
  assert.deepEqual(profileSkinInfo(new Map([['SkullOwner', 'jeb_']]) as never), { url: '', query: 'name=jeb_' })
  assert.equal(normalizeUuid('069A79F4-44E9-4726-A5BE-FCA90E38AAF5'), '069a79f444e94726a5befca90e38aaf5')
  assert.equal(normalizeUuid('../x'), null)
  assert.deepEqual(texturesToSkin(b64({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/ab12', metadata: { model: 'slim' } } } })), { url: 'https://textures.minecraft.net/texture/ab12', slim: true })
  assert.deepEqual(texturesToSkin(b64({ textures: { SKIN: { url: 'https://evil.example/texture/ab12' } } })), { url: null, slim: false })
  // サーバーの側 (Mojang のサーバーの代わり)
  const seen: string[] = []
  let fail = false
  const fetcher = async (url: string, init: RequestInit): Promise<Response> => {
    seen.push(url)
    assert.equal(init.redirect, 'error')
    assert.ok(init.signal)
    if (fail) throw new Error('down')
    if (url === 'https://api.mojang.com/users/profiles/minecraft/Notch') return Response.json({ id: '069a79f444e94726a5befca90e38aaf5', name: 'Notch' })
    if (url === 'https://api.mojang.com/users/profiles/minecraft/Nobody') return new Response(null, { status: 404 })
    if (url === 'https://sessionserver.mojang.com/session/minecraft/profile/069a79f444e94726a5befca90e38aaf5') {
      return Response.json({ id: '069a79f444e94726a5befca90e38aaf5', properties: [{ name: 'textures', value: b64({ textures: { SKIN: { url: 'http://textures.minecraft.net/texture/2920' } } }) }] })
    }
    return new Response(null, { status: 500 })
  }
  const r = new SkinResolver(fetcher)
  assert.deepEqual(await r.resolve({ name: 'Notch' }, '1.1.1.1'), { url: 'https://textures.minecraft.net/texture/2920', slim: false })
  // 覚えたものは問い合わせない
  const calls = r.upstreamCalls
  assert.deepEqual(await r.resolve({ name: 'notch' }, '1.1.1.1'), { url: 'https://textures.minecraft.net/texture/2920', slim: false })
  assert.equal(r.upstreamCalls, calls)
  assert.deepEqual(await r.resolve({ name: 'Nobody' }, '1.1.1.1'), { url: null, slim: false })
  // 失敗したら Steve (URL なし)。ほかのホストには問い合わせない
  fail = true
  assert.deepEqual(await r.resolve({ uuid: 'ffffffffffffffffffffffffffffffff' }, '1.1.1.1'), { url: null, slim: false })
  assert.ok(seen.every(u => /^https:\/\/(api\.mojang\.com\/users\/profiles\/minecraft\/[A-Za-z0-9_]{1,16}|api\.minecraftservices\.com\/minecraft\/profile\/lookup\/name\/[A-Za-z0-9_]{1,16}|sessionserver\.mojang\.com\/session\/minecraft\/profile\/[0-9a-f]{32})$/.test(u)), seen.join('\n'))
  // 1 つの IP から問い合わせが多すぎると断る
  let limited = false
  for (let i = 0; i < 80 && !limited; i++) limited = await r.resolve({ name: 'user' + i }, '2.2.2.2') === 'rate'
  assert.equal(limited, true)
  // PlayerSkins: サーバーが URL を返したら、そのスキンを読む
  const assets = fixtureAssets()
  ;(assets as unknown as { loader: { lookup: (q: string) => Promise<unknown> } }).loader.lookup = async q => q === 'name=Notch' ? { url: 'https://textures.minecraft.net/texture/2920', slim: false } : null
  const skins = new PlayerSkins(assets)
  const head = new Map([['profile', new Map([['name', 'Notch']])]]) as never
  assert.equal(skins.skin(head).pending, true)
  await assets.fulfill()
  assert.equal(assets.skin('https://textures.minecraft.net/texture/2920'), undefined)
})

test('PNG の読み込み (パレット、透明色、16 ビット、インターレース以外)', async () => {
  const p = await decodePng(png(3, 2, (x, y) => [x * 100, y * 100, 7, x === 2 ? 0 : 255]))
  assert.equal(p.width, 3)
  assert.deepEqual(Array.from(p.pixels.subarray(4, 8)), [100, 0, 7, 255])
  assert.equal(p.pixels[11], 0)
  await assert.rejects(decodePng(new Uint8Array([1, 2, 3])))
})

test('Minecraft のリソースのまとめ (サーバー): jar とリソースパックから作り、パックが上書きする', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcassets-'))
  try {
    // 小さな zip を作る (deflate)
    const zip = (entries: Record<string, Uint8Array | string>): Uint8Array => {
      const local: Buffer[] = [], central: Buffer[] = []
      let offset = 0
      for (const [name, value] of Object.entries(entries)) {
        const data = Buffer.from(value)
        const comp = deflateRawSync(data)
        const n = Buffer.from(name)
        const h = Buffer.alloc(30)
        h.writeUInt32LE(0x04034B50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(8, 8); h.writeUInt32LE(comp.length, 18); h.writeUInt32LE(data.length, 22); h.writeUInt16LE(n.length, 26)
        local.push(h, n, comp)
        const c = Buffer.alloc(46)
        c.writeUInt32LE(0x02014B50, 0); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42)
        central.push(c, n)
        offset += 30 + n.length + comp.length
      }
      const cd = Buffer.concat(central)
      const e = Buffer.alloc(22)
      e.writeUInt32LE(0x06054B50, 0); e.writeUInt16LE(Object.keys(entries).length, 8); e.writeUInt16LE(Object.keys(entries).length, 10); e.writeUInt32LE(cd.length, 12); e.writeUInt32LE(offset, 16)
      return Buffer.concat([...local, cd, e])
    }
    const red = png(16, 16, () => [255, 0, 0, 255]), blue = png(16, 16, () => [0, 0, 255, 255])
    writeFileSync(join(dir, 'client.jar'), zip({
      'version.json': JSON.stringify({ name: '99.1' }),
      'assets/minecraft/blockstates/stone.json': JSON.stringify({ variants: { '': { model: 'minecraft:block/stone' } } }),
      'assets/minecraft/models/block/stone.json': JSON.stringify({ parent: 'block/cube_all', textures: { all: 'minecraft:block/stone' } }),
      'assets/minecraft/textures/block/stone.png': red,
      'assets/minecraft/textures/block/water_still.png': red,
      'assets/minecraft/textures/block/water_still.png.mcmeta': JSON.stringify({ animation: { frametime: 2 } }),
      'assets/minecraft/textures/gui/skip.png': red,
      'data/minecraft/worldgen/biome/plains.json': JSON.stringify({ temperature: 0.8, downfall: 0.4, effects: { water_color: 4159204 } }),
      'data/minecraft/painting_variant/kebab.json': JSON.stringify({ width: 1, height: 1, asset_id: 'minecraft:kebab' }),
    }))
    const { mkdirSync } = await import('node:fs')
    mkdirSync(join(dir, 'packs'))
    writeFileSync(join(dir, 'packs', 'a.zip'), zip({ 'assets/minecraft/textures/block/stone.png': blue, 'pack.mcmeta': '{}' }))
    const a = await buildMcAssets({ jar: join(dir, 'client.jar'), packs: join(dir, 'packs') })
    assert.equal(a.bundle.version, '99.1')
    assert.ok(a.bundle.blockstates['minecraft:stone'])
    assert.equal(a.bundle.textures['minecraft:gui/skip'], undefined)
    assert.deepEqual(a.bundle.textures['minecraft:block/water_still']![2], { frametime: 2 })
    assert.deepEqual(a.bundle.biomes['minecraft:plains'], [0.8, 0.4, null, null, null, 4159204, 'none'])
    assert.deepEqual(a.bundle.paintings.kebab, [1, 1, 'minecraft:kebab'])
    // リソースパックの石 (青) が jar の石 (赤) を上書きする
    const [o, l] = a.bundle.textures['minecraft:block/stone']!
    const decoded = await decodePng(new Uint8Array(a.textures.subarray(o, o + l)))
    assert.deepEqual(Array.from(decoded.pixels.subarray(0, 4)), [0, 0, 255, 255])
    assert.match(a.hash, /^[0-9a-f]{20}$/)
    // zip の読み込み: ないものは null
    const z = await ZipFile.open(join(dir, 'client.jar'))
    assert.equal(await z.get('nothing'), null)
    await z.close()
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('NUXT_MCASSETS_JAR がフォルダなら、minecraft-client-<版>.jar のうち最も新しい版を使う', async () => {
  assert.ok(compareVersions('26.10', '26.3') > 0)
  assert.ok(compareVersions('26.3.1', '26.3') > 0)
  assert.ok(compareVersions('1.21.11', '1.21.9') > 0)
  assert.equal(compareVersions('26.3', '26.3'), 0)
  const dir = mkdtempSync(join(tmpdir(), 'bluemap-'))
  try {
    for (const n of ['minecraft-client-26.3.jar', 'minecraft-client-26.10.jar', 'minecraft-client-1.21.11.jar', 'other.jar', 'minecraft-client-27.0.jar.tmp']) writeFileSync(join(dir, n), 'x')
    assert.equal(await resolveClientJar(dir), join(dir, 'minecraft-client-26.10.jar'))
    // ファイルの場所はそのまま
    assert.equal(await resolveClientJar(join(dir, 'minecraft-client-26.3.jar')), join(dir, 'minecraft-client-26.3.jar'))
    rmSync(join(dir, 'minecraft-client-26.10.jar'))
    rmSync(join(dir, 'minecraft-client-26.3.jar'))
    rmSync(join(dir, 'minecraft-client-1.21.11.jar'))
    assert.equal(await resolveClientJar(dir), null)
  }
  finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('本物の jar で、すべての機能を使う構造物を描く (MCJAR があるときだけ)', async (t) => {
  const jar = process.env.MCJAR
  if (!jar || !existsSync(jar)) {
    t.skip('MCJAR がない')
    return
  }
  const built = await buildMcAssets({ jar })
  const assets = new GameAssets(JSON.parse(built.json.toString()), {
    png: async (_id, o, l) => new Uint8Array(built.textures.subarray(o, o + l)),
    unifont: async () => null,
    skin: async () => null,
  })
  const st = new Structure(4, 2, 2)
  const put = (x: number, y: number, z: number, s: string): void => st.set(x, y, z, st.paletteId(s))
  put(0, 0, 0, 'minecraft:oak_stairs[facing=north,half=bottom,shape=outer_left,waterlogged=false]')
  put(1, 0, 0, 'minecraft:chest[facing=south,type=single,waterlogged=false]')
  put(2, 0, 0, 'minecraft:water[level=0]')
  put(3, 0, 0, 'minecraft:oak_sign[rotation=0,waterlogged=false]')
  st.setBlockEntity(3, 0, 0, new Map([['front_text', new Map<string, never>([['messages', ['"Hi"', '""', '""', '""'] as never], ['color', 'black' as never]])]]) as never)
  st.addEntity('minecraft:painting', 0.5, 1.5, 1.03, new Map<string, never>([['variant', 'minecraft:kebab' as never], ['facing', 0 as never]]))
  const r = await meshVanilla(st, { assets, data: realBlockData(), entityModels: realEntityModels(), tables: null })
  assert.ok(r.quads > 50)
  assert.equal(r.counts.blockEntities, 2)
  assert.equal(r.counts.entities, 1)
  assert.equal(r.counts.texts, 1)
  assert.ok(r.pages.some(p => p.animated && p.animated.length > 0), '水が動く')
  assert.deepEqual(r.missing, [])
  void gunzipSync
  void readFileSync
  void Sprite
})
