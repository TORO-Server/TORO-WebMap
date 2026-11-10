import type { RowDataPacket } from 'mysql2/promise'

// BlueMap の SQL 保存の鍵の表 (map, grid_storage, item_storage, compression) は小さく、ほとんど変わらない
// 番号をここに覚えておき、データの表は主キー (map, storage, x, z) で 1 行だけ引く

interface IdRow extends RowDataPacket { id: number, name: string }
interface DataRow extends RowDataPacket { data: Buffer, compression: number }

interface Keys {
  maps: Map<string, number>
  grids: Map<string, number>
  items: Map<string, number>
  compressions: Map<number, string>
  loadedAt: number
}

let keys: Keys | undefined
let loading: Promise<Keys> | undefined
const MAX_AGE = 60_000

async function loadKeys(): Promise<Keys> {
  const { bluemap } = useRuntimeConfig()
  const p = bluemap.prefix
  const all = async (sql: string): Promise<IdRow[]> => await queryAll<IdRow>(bluemap.database, sql, [])
  const [maps, grids, items, compressions] = await Promise.all([
    all(`SELECT id, map_id AS name FROM ${p}map`),
    all(`SELECT id, \`key\` AS name FROM ${p}grid_storage`),
    all(`SELECT id, \`key\` AS name FROM ${p}item_storage`),
    all(`SELECT id, \`key\` AS name FROM ${p}compression`),
  ])
  return {
    maps: new Map(maps.map(r => [r.name, r.id])),
    grids: new Map(grids.map(r => [r.name, r.id])),
    items: new Map(items.map(r => [r.name, r.id])),
    compressions: new Map(compressions.map(r => [r.id, r.name])),
    loadedAt: Date.now(),
  }
}

/** 鍵の番号。見つからない鍵があったときは、新しく増えたかもしれないので読み直す */
async function ids(fresh = false): Promise<Keys> {
  if (!fresh && keys && Date.now() - keys.loadedAt < MAX_AGE) return keys
  loading ??= loadKeys().finally(() => { loading = undefined })
  keys = await loading
  return keys
}

export interface BlueMapData { data: Buffer, compression: string }

async function find(lookup: (k: Keys) => { sql: string, params: unknown[] } | undefined): Promise<BlueMapData | undefined> {
  const { bluemap } = useRuntimeConfig()
  for (const fresh of [false, true]) {
    const k = await ids(fresh)
    const q = lookup(k)
    if (!q) continue
    const row = await queryOne<DataRow>(bluemap.database, q.sql, q.params)
    return row ? { data: row.data, compression: k.compressions.get(row.compression) ?? 'bluemap:none' } : undefined
  }
  return undefined
}

/** BlueMap の地図の id として DB にあるか (WebSocket で知らされた id を、BlueMap 本体へ聞きに行く前に確かめる) */
export async function bluemapMapExists(mapId: string): Promise<boolean> {
  const k = await ids()
  if (k.maps.has(mapId)) return true
  // 新しい地図かもしれないので読み直す。ただし、でたらめな id で毎回 DB を読ませないよう、読んだばかりのときはしない
  if (Date.now() - k.loadedAt < 10_000) return false
  return (await ids(true)).maps.has(mapId)
}

export function bluemapTile(mapId: string, storage: string, x: number, z: number): Promise<BlueMapData | undefined> {
  const p = useRuntimeConfig().bluemap.prefix
  return find((k) => {
    const map = k.maps.get(mapId)
    const grid = k.grids.get(storage)
    if (map === undefined || grid === undefined) return undefined
    return { sql: `SELECT data, compression FROM ${p}grid_storage_data WHERE map = ? AND storage = ? AND x = ? AND z = ?`, params: [map, grid, x, z] }
  })
}

export function bluemapItem(mapId: string, storage: string): Promise<BlueMapData | undefined> {
  const p = useRuntimeConfig().bluemap.prefix
  return find((k) => {
    const map = k.maps.get(mapId)
    const item = k.items.get(storage)
    if (map === undefined || item === undefined) return undefined
    return { sql: `SELECT data, compression FROM ${p}item_storage_data WHERE map = ? AND storage = ?`, params: [map, item] }
  })
}
