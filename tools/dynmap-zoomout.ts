// Dynmap の縮小したタイル (zoom の段) を、1 つ下の段のタイルから作って DB に入れる
//
// worlds.txt の extrazoomout を増やしても、Dynmap は増えた段のタイルを最初に作らない
// (下の段のタイルが変わったときにだけ、その上の段を作り直す)。最初の 1 回だけこれで埋めると、あとは Dynmap が更新する
//
// 使い方 (このリポジトリで): node --experimental-strip-types tools/dynmap-zoomout.ts <world> <map の prefix> <いちばん縮小した段> [--check]
//   例: node --experimental-strip-types tools/dynmap-zoomout.ts main flat 10
//   --check: 書き込まず、既にある段を作り直して Dynmap の作ったものと比べる (並べる向きの確認)
// 接続先は環境変数 DB_HOST, DB_PORT, DB_USER, DB_PASSWORD, DB_NAME (既定は tidb:4000 の root、dynmap)

import mysql from 'mysql2/promise'
import type { RowDataPacket } from 'mysql2/promise'
import sharp from 'sharp'

interface TileRow extends RowDataPacket { x: number, y: number, Format: number, Image: Buffer }

const [world, prefix, maxArg] = process.argv.slice(2)
const check = process.argv.includes('--check')
if (!world || !prefix || !maxArg) {
  console.error('usage: dynmap-zoomout.ts <world> <prefix> <max zoom> [--check]')
  process.exit(1)
}
const maxZoom = Number(maxArg)

const db = await mysql.createConnection({
  host: process.env.DB_HOST ?? 'tidb',
  port: Number(process.env.DB_PORT ?? 4000),
  user: process.env.DB_USER ?? 'root',
  password: process.env.DB_PASSWORD ?? '',
  database: process.env.DB_NAME ?? 'dynmap',
})
const P = process.env.DB_PREFIX ?? 'dynmap_'

const [maps] = await db.query<RowDataPacket[]>(`SELECT ID FROM ${P}Maps WHERE WorldID = ? AND MapID = ? AND Variant = 'STANDARD'`, [world, prefix])
if (!maps[0]) throw new Error(`map ${world}/${prefix} not found`)
const mapId = maps[0].ID as number

async function tiles(zoom: number): Promise<TileRow[]> {
  const [rows] = await db.query<TileRow[]>(
    `SELECT x, y, Format, IFNULL(NewImage, Image) AS Image FROM ${P}Tiles WHERE MapID = ? AND zoom = ? AND IFNULL(NewImage, Image) IS NOT NULL`,
    [mapId, zoom])
  return rows
}

// HD 地図のタイル名の y は Leaflet の y の符号を反対にしたもの (web/js/hdmap.js)。
// Leaflet で切り捨てた親は、名前では y を切り上げた位置になり、y が親と同じ子が上の段に来る
const floorTo = (v: number, step: number): number => Math.floor(v / step) * step
const ceilTo = (v: number, step: number): number => Math.ceil(v / step) * step

/** 4 枚の子を 1 枚の親にする。子は半分の大きさにして (2x2 の画素の平均)、親の 4 分の 1 に置く */
async function compose(children: TileRow[], step: number, px: number, py: number): Promise<{ data: Buffer, format: number }> {
  const first = await sharp(children[0]!.Image).metadata()
  const size = first.width!
  const half = size / 2
  const out = Buffer.alloc(size * size * 4)
  for (const child of children) {
    const { data } = await sharp(child.Image).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
    const ox = ((child.x - px) / step) * half
    const oy = ((py - child.y) / step) * half
    for (let y = 0; y < half; y++) {
      for (let x = 0; x < half; x++) {
        const o = ((oy + y) * size + (ox + x)) * 4
        for (let c = 0; c < 4; c++) {
          const i = (sy: number, sx: number): number => data[((2 * y + sy) * size + (2 * x + sx)) * 4 + c]!
          out[o + c] = (i(0, 0) + i(0, 1) + i(1, 0) + i(1, 1) + 2) >> 2
        }
      }
    }
  }
  const format = children[0]!.Format
  const img = sharp(out, { raw: { width: size, height: size, channels: 4 } })
  const data = format === 2 ? await img.webp({ lossless: true }).toBuffer()
    : format === 1 ? await img.flatten({ background: '#000000' }).jpeg({ quality: 90 }).toBuffer()
      : await img.png().toBuffer()
  return { data, format }
}

function group(rows: TileRow[], parentStep: number): Map<string, { px: number, py: number, children: TileRow[] }> {
  const parents = new Map<string, { px: number, py: number, children: TileRow[] }>()
  for (const r of rows) {
    const px = floorTo(r.x, parentStep)
    const py = ceilTo(r.y, parentStep)
    const key = `${px}_${py}`
    let p = parents.get(key)
    if (!p) parents.set(key, p = { px, py, children: [] })
    p.children.push(r)
  }
  return parents
}

async function diff(a: Buffer, b: Buffer): Promise<number> {
  const ra = await sharp(a).ensureAlpha().raw().toBuffer()
  const rb = await sharp(b).ensureAlpha().raw().toBuffer()
  let sum = 0
  for (let i = 0; i < ra.length; i++) sum += Math.abs(ra[i]! - rb[i]!)
  return sum / ra.length
}

if (check) {
  // 既にある段 (zoom と zoom+1) で、作り直したものと Dynmap の作ったものを比べる
  const zoom = maxZoom
  const step = 1 << zoom
  const children = await tiles(zoom)
  const actual = new Map((await tiles(zoom + 1)).map(r => [`${r.x}_${r.y}`, r]))
  let n = 0
  let total = 0
  let missing = 0
  for (const p of group(children, step * 2).values()) {
    const real = actual.get(`${p.px}_${p.py}`)
    if (!real) {
      missing++
      continue
    }
    if (p.children.length < 4) continue
    total += await diff((await compose(p.children, step, p.px, p.py)).data, real.Image)
    if (++n >= 20) break
  }
  console.log(`compared ${n} tiles: mean abs diff per channel ${(total / n).toFixed(2)} (0-255); parents not made by Dynmap: ${missing}`)
  await db.end()
  process.exit(0)
}

const [levels] = await db.query<RowDataPacket[]>(`SELECT MAX(zoom) AS z FROM ${P}Tiles WHERE MapID = ?`, [mapId])
const start = levels[0]!.z as number
console.log(`${world}/${prefix}: highest existing zoom ${start}, building ${start + 1}..${maxZoom}`)
const now = Date.now()
for (let zoom = start; zoom < maxZoom; zoom++) {
  const step = 1 << zoom
  const parents = group(await tiles(zoom), step * 2)
  let written = 0
  for (const p of parents.values()) {
    const { data, format } = await compose(p.children, step, p.px, p.py)
    // HashCode は Dynmap が次に描き直すときに自分で計算し直す。ここでは画像から作った値を入れておく
    const hash = BigInt('0x' + (await import('node:crypto')).createHash('sha1').update(data).digest('hex').slice(0, 15))
    await db.query(
      `REPLACE INTO ${P}Tiles (MapID, x, y, zoom, HashCode, LastUpdate, Format, Image, NewImage) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
      [mapId, p.px, p.py, zoom + 1, hash.toString(), now, format, data])
    written++
  }
  console.log(`zoom ${zoom + 1}: ${written} tiles`)
}
await db.end()
