// 地図 (Dynmap の画面、BlueMap の画面) の API の実装 (正本はここ 1 か所)。
// 公開するパスは api.torosaba.net の /map/v1/ (server/routes/map/v1/) と、3d-map.torosaba.net の WebSocket /up/ws (server/routes/up/ws.ts)。どちらもここの値をそのまま default export する。
// パスの一覧は docs/map-deployment.md
import type { RowDataPacket } from 'mysql2/promise'
import { decodePathParam } from '../lib/path-param'

// ---- 設定 (/map/v1/configuration)
// Dynmap のブラウザ側が最初に読む設定 (ログインは使っていないので、書き出されたものをそのまま返す)
export const dynmapConfigurationHandler = defineEventHandler(async (event) => {
  const config = await dynmapStandaloneFile('dynmap_config.json')
  if (config === undefined) throw createError({ statusCode: 503, statusMessage: 'Dynmap has not written its configuration yet' })
  return respond(event, { data: config, type: 'application/json; charset=utf-8', cache: 'no-cache' })
})

// ---- ワールドの更新 (/map/v1/world/<world>/<ts>)
// Dynmap のブラウザ側が 2 秒ごとに読むワールドの更新 (プレイヤーの位置、描き直したタイルなど)
// 中身は時刻によらず同じ。どの更新が新しいかはブラウザ側が timestamp で選ぶ
export const dynmapWorldUpdateHandler = defineEventHandler(async (event) => {
  const world = getRouterParam(event, 'world') ?? ''
  if (world.includes('/') || world.includes('\\')) return respond(event, { data: '{ "error": "invalid-world" }', type: 'application/json; charset=utf-8', cache: 'no-cache' })
  // 知らないワールドの名前で DB を読まない (一覧が読めないときは、これまでどおり読みに行く)
  if (await dynmapWorldKnown(world) === false) throw createError({ statusCode: 404 })
  const update = await dynmapStandaloneFile(`dynmap_${world}.json`)
  if (update === undefined) throw createError({ statusCode: 503, statusMessage: 'Database unavailable' })
  return respond(event, { data: update, type: 'application/json; charset=utf-8', cache: 'no-cache' })
})

// ---- タイル・マーカー・顔 (/map/v1/tiles/...)
// Dynmap のタイル置き場と同じ形のパス
//   tiles/<world>/<prefix>/<x_y>/<zoom_x_y>.<ext>  地図のタイル
//   tiles/_markers_/marker_<world>.json            マーカー
//   tiles/_markers_/<icon>.png                     マーカーのアイコン
//   tiles/faces/<8x8|16x16|32x32|body>/<name>.png  プレイヤーの顔

interface TileRow extends RowDataPacket { HashCode: number, LastUpdate: number, Format: number, Image: Buffer | null }
interface ContentRow extends RowDataPacket { Content: string }
interface ImageRow extends RowDataPacket { Image: Buffer }

const FACE_TYPES: Record<string, number> = { '8x8': 0, '16x16': 1, '32x32': 2, 'body': 3 }
const TILE_TYPES = ['image/png', 'image/jpeg', 'image/webp']

export const dynmapTilesHandler = defineEventHandler(async (event) => {
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

// ---- WebSocket (/map/v1/ws と、3d-map.torosaba.net の /up/ws)
// ブラウザ (map.torosaba.net / 3d-map.torosaba.net の画面) との WebSocket。
// map.torosaba.net (Dynmap): 見ているワールドを {"subscribe": "<world>"} で知らせてもらい、そのワールドの更新とプレイヤーの位置を送る (server/utils/live.ts)
// 3d-map.torosaba.net (BlueMap): 見ている地図を {"bluemap": "<map>"} で知らせてもらい、BlueMap のライブ情報を送る (server/utils/bluemap-live.ts)
const messageTimestamps = new Map<string, number[]>()
// 届くのは名前が 1 つだけの短いもの (全体の上限は server/lib/ws-options.ts)。これより長いものは解かない
const MAX_MESSAGE_CHARS = 512

export const dynmapLiveSocketHandler = defineWebSocketHandler({
  open(peer) {
    const origin = peer.request?.headers.get('origin')
    if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1|([a-z0-9-]+\.)?torosaba\.net)(:\d+)?$/i.test(origin)) {
      peer.close(1008, 'Forbidden')
    }
  },
  message(peer, message) {
    // Rate limit: max 5 messages per 2 seconds
    const now = Date.now()
    const timestamps = messageTimestamps.get(peer.id) ?? []
    const recent = timestamps.filter(t => now - t < 2000)
    if (recent.length >= 5) {
      return
    }
    recent.push(now)
    messageTimestamps.set(peer.id, recent)

    const text = message.text()
    if (text.length > MAX_MESSAGE_CHARS) return
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    }
    catch {
      return
    }
    if (typeof parsed !== 'object' || parsed === null) return
    const data = parsed as { subscribe?: unknown, bluemap?: unknown }
    if (typeof data.subscribe === 'string' && data.subscribe.length > 0 && data.subscribe.length < 100) {
      liveSubscribe(peer, data.subscribe)
    }
    // 3d-map.torosaba.net (BlueMap) の画面は、見る地図を {"bluemap": "<地図>"} で知らせる (server/utils/bluemap-live.ts)
    if (typeof data.bluemap === 'string' && data.bluemap.length > 0 && data.bluemap.length < 100) {
      void bluemapSubscribe(peer, data.bluemap).catch(() => {})
    }
  },
  close(peer) {
    messageTimestamps.delete(peer.id)
    liveLeave(peer)
    bluemapLeave(peer)
  },
  error(peer) {
    messageTimestamps.delete(peer.id)
    liveLeave(peer)
    bluemapLeave(peer)
  },
})
