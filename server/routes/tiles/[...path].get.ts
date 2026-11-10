import type { RowDataPacket } from 'mysql2/promise'
import { decodePathParam } from '../../lib/path-param'

// Dynmap の /tiles/ (configuration.txt の url: で tiles と markers をここにしている)
//   tiles/<world>/<prefix>/<x_y>/<zoom_x_y>.<ext>  地図のタイル
//   tiles/_markers_/marker_<world>.json            マーカー
//   tiles/_markers_/<icon>.png                     マーカーのアイコン
//   tiles/faces/<8x8|16x16|32x32|body>/<name>.png  プレイヤーの顔

interface TileRow extends RowDataPacket { HashCode: number, LastUpdate: number, Format: number, Image: Buffer | null }
interface ContentRow extends RowDataPacket { Content: string }
interface ImageRow extends RowDataPacket { Image: Buffer }

const FACE_TYPES: Record<string, number> = { '8x8': 0, '16x16': 1, '32x32': 2, 'body': 3 }
const TILE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export default defineEventHandler(async (event) => {
  const { dynmap } = useRuntimeConfig()
  const db = dynmap.database
  const p = dynmap.prefix
  const path = decodePathParam(getRouterParam(event, 'path', { decode: false }) ?? '')
  if (path === null || path.includes('..')) return dynmapBlank(event)
  const parts = path.split('/')

  if (parts[0] === '_markers_' && parts.length === 2) {
    const file = parts[1]!
    const json = /^marker_(.+)\.json$/.exec(file)
    if (json) {
      const row = await queryOne<ContentRow>(db, `SELECT Content FROM ${p}MarkerFiles WHERE FileName = ?`, [json[1]])
      return respond(event, { data: row?.Content ?? '{ }', type: 'application/json', cache: 'public, max-age=30' })
    }
    const icon = await queryOne<ImageRow>(db, `SELECT Image FROM ${p}MarkerIcons WHERE IconName = ?`, [file.replace(/\.[^.]+$/, '')])
    return icon ? respond(event, { data: icon.Image, type: 'image/png', cache: 'public, max-age=3600' }) : dynmapBlank(event)
  }

  if (parts[0] === 'faces' && parts.length === 3) {
    const type = FACE_TYPES[parts[1]!] ?? 0
    const face = await queryOne<ImageRow>(db, `SELECT Image FROM ${p}Faces WHERE PlayerName = ? AND TypeID = ?`, [parts[2]!.split('.')[0], type])
    return face ? respond(event, { data: face.Image, type: 'image/png', cache: 'public, max-age=3600' }) : dynmapBlank(event)
  }

  if (parts.length !== 4) return dynmapBlank(event)
  const [world, rawPrefix, , file] = parts as [string, string, string, string]
  const day = rawPrefix.endsWith('_day') && rawPrefix.length > 4
  const prefix = day ? rawPrefix.slice(0, -4) : rawPrefix
  // zz_x_y (z の数が縮小の段) または x_y
  const f = file.split('.')[0]!.split('_')
  if (f.length !== 2 && f.length !== 3) return dynmapBlank(event)
  const zoom = f.length === 3 ? f[0]!.length : 0
  const [x, y] = f.slice(-2).map(Number) as [number, number]
  if (!Number.isSafeInteger(x) || !Number.isSafeInteger(y)) return dynmapBlank(event)

  const tile = await queryOne<TileRow>(db,
    `SELECT t.HashCode, t.LastUpdate, t.Format, IFNULL(t.NewImage, t.Image) AS Image
     FROM ${p}Maps m JOIN ${p}Tiles t ON m.ID = t.MapID
     WHERE m.WorldID = ? AND m.MapID = ? AND m.Variant = ? AND t.x = ? AND t.y = ? AND t.zoom = ?`,
    [world, prefix, day ? 'DAY' : 'STANDARD', x, y, zoom])
  if (!tile?.Image) return dynmapBlank(event)

  return respond(event, {
    data: tile.Image,
    type: TILE_TYPES[tile.Format] ?? 'image/jpeg',
    // ?timestamp= が付いた URL はタイルが描き直されると別の URL になるので、長く持たせてよい
    cache: getQuery(event).timestamp !== undefined ? 'public, max-age=604800, immutable' : 'public, max-age=300',
    etag: `"${tile.HashCode}"`,
    lastModified: new Date(Number(tile.LastUpdate)),
  })
})
