// 構造物の看板のための Minecraft のリソースのまとめ (/mcassets/) を、手元で作って大きさを見る
//   node --experimental-strip-types tools/mcassets.ts <client の jar> [BlueMap の packs フォルダ] [書き出すフォルダ]
// 書き出すフォルダを渡すと、assets.json と textures.bin をそこに書く (git に入れないこと。Mojang のファイルが入っている)
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { gzipSync, brotliCompressSync } from 'node:zlib'
import { buildMcAssets } from '../server/utils/mcassets-build.ts'

const [jar, packs, out] = process.argv.slice(2)
if (!jar) {
  console.error('usage: tools/mcassets.ts <client.jar> [packs dir] [out dir]')
  process.exit(2)
}
const a = await buildMcAssets({ jar, packs: packs || undefined })
const b = a.bundle
console.log(JSON.stringify({
  hash: a.hash, version: b.version, millis: a.millis,
  blockstates: Object.keys(b.blockstates).length, models: Object.keys(b.models).length, items: Object.keys(b.items).length,
  textures: Object.keys(b.textures).length, biomes: Object.keys(b.biomes).length, paintings: Object.keys(b.paintings).length,
  json: a.json.length, jsonGzip: gzipSync(a.json, { level: 9 }).length, jsonBrotli: brotliCompressSync(a.json).length, texturesBin: a.textures.length,
}, null, 1))
if (out) {
  await mkdir(out, { recursive: true })
  await writeFile(join(out, 'assets.json'), a.json)
  await writeFile(join(out, 'textures.bin'), a.textures)
}
