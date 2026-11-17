// 構造物の看板のための、サーバー側の処理の試験: npm test
// 名前や UUID だけのプレイヤーの頭 (server/utils/skin-lookup.ts)、Minecraft のリソースのまとめ (server/utils/mcassets-build.ts、zip.ts)
// 画面側の処理の試験は TORO-3D-WebMap にある
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'
import { normalizeUuid, SkinResolver, texturesToSkin } from '../server/utils/skin-lookup.ts'
import { buildMcAssets, compareVersions, resolveClientJar } from '../server/utils/mcassets-build.ts'
import { ZipFile } from '../server/utils/zip.ts'
import { png } from './png-writer.ts'

test('名前や UUID だけのプレイヤーの頭: サーバーが決まった Mojang のサーバーに聞き、URL だけを返す', async () => {
  const b64 = (o: unknown): string => Buffer.from(JSON.stringify(o)).toString('base64')
  // 形を確かめた UUID と、スキンの URL の取り出し
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
    assert.deepEqual(Buffer.from(a.textures.subarray(o, o + l)), Buffer.from(blue))
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
