// BlueMap (3d-map.torosaba.net) の /maps/<map>/... を BlueMap の SQL 保存 (TiDB) から返す
//   tiles/<lod>/x-3/5/5/z-3/9/0.prbm  高解像度 (lod 0) / 低解像度 (.png)
//   settings.json, textures.json, live/markers.json, live/players.json, assets/<path>
// 鍵の名前は bluemap-5.29 の KeyedMapStorage と同じ
import { decodePathParam } from '../../lib/path-param'

const ITEMS: Record<string, string> = {
  'settings.json': 'bluemap:settings',
  'textures.json': 'bluemap:textures',
  'live/markers.json': 'bluemap:markers',
  'live/players.json': 'bluemap:players',
}
const ENCODINGS: Record<string, string> = { 'bluemap:gzip': 'gzip', 'bluemap:deflate': 'deflate', 'bluemap:zstd': 'zstd', 'bluemap:lz4': 'lz4' }
const TYPES: Record<string, string> = { json: 'application/json', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg' }

export default defineEventHandler(async (event) => {
  const path = decodePathParam(getRouterParam(event, 'path', { decode: false }) ?? '')
  if (path === null) throw createError({ statusCode: 404 })
  const slash = path.indexOf('/')
  if (slash < 0) throw createError({ statusCode: 404 })
  const mapId = path.slice(0, slash)
  const mapPath = path.slice(slash + 1)

  const tile = /^tiles\/(\d+)\/x(-?[\d/]+)z(-?[\d/]+)\.(prbm|png)$/.exec(mapPath)
  if (tile) {
    const lod = Number(tile[1])
    const x = Number(tile[2]!.replaceAll('/', ''))
    const z = Number(tile[3]!.replaceAll('/', ''))
    if (!Number.isSafeInteger(lod) || !Number.isSafeInteger(x) || !Number.isSafeInteger(z)) throw createError({ statusCode: 404 })
    const found = await bluemapTile(mapId, lod === 0 ? 'bluemap:hires' : `bluemap:lowres/${lod}`, x, z)
    if (!found) {
      // 描いていないタイルは 204 (BlueMap と同じ)
      setResponseHeader(event, 'Cache-Control', 'public, max-age=60')
      return sendNoContent(event, 204)
    }
    return respond(event, {
      data: found.data,
      type: lod === 0 ? 'application/octet-stream' : 'image/png',
      cache: 'public, max-age=86400, stale-if-error=604800',
      encoding: ENCODINGS[found.compression],
    })
  }

  const key = ITEMS[mapPath] ?? (mapPath.startsWith('assets/') ? `bluemap:asset/${mapPath.slice(7)}` : undefined)
  if (!key) throw createError({ statusCode: 404 })
  const found = await bluemapItem(mapId, key)
  if (!found) throw createError({ statusCode: 404 })
  const live = mapPath.startsWith('live/') || mapPath === 'settings.json'
  return respond(event, {
    data: found.data,
    type: TYPES[mapPath.split('.').pop()!.toLowerCase()] ?? 'application/octet-stream',
    cache: live ? 'no-cache' : 'public, max-age=3600',
    encoding: ENCODINGS[found.compression],
  })
})
