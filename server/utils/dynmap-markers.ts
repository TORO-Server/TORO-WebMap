import type { RowDataPacket } from 'mysql2/promise'

// Dynmap のマーカー (DB の MarkerFiles) を、BlueMap の markers.json の形にする
// 対象は、Dynmap で最初から出している組 (hide が false) の点のマーカーだけ (MarumaSign のリンク切れなど、直す人向けの組は入れない)
// BlueMap の html マーカーの中身を空にして、3D の画面には何も描かず、マーカーの一覧にだけ名前と座標を出す

interface ContentRow extends RowDataPacket { Content: string }

interface DynmapPoint { label?: string, markup?: boolean, x: number, y: number, z: number }
interface DynmapSet { label?: string, hide?: boolean, layerprio?: number, markers?: Record<string, DynmapPoint> }
interface DynmapMarkerFile { sets?: Record<string, DynmapSet> }

// 英語のままの組の名前を、一覧で日本語にする
const SET_LABELS: Record<string, string> = { markers: '地点' }
const MAX_AGE = 30_000

const cache = new Map<string, { at: number, sets: Record<string, unknown> }>()

export async function dynmapListedMarkers(mapId: string): Promise<Record<string, unknown>> {
  const { bluemap, dynmap } = useRuntimeConfig()
  const world = (bluemap.dynmapWorlds as Record<string, string>)[mapId]
  if (!world) return {}
  const hit = cache.get(world)
  if (hit && Date.now() - hit.at < MAX_AGE) return hit.sets

  const row = await queryOne<ContentRow>(dynmap.database, `SELECT Content FROM ${dynmap.prefix}MarkerFiles WHERE FileName = ?`, [world])
  const sets: Record<string, unknown> = {}
  if (row) {
    const file = JSON.parse(row.Content) as DynmapMarkerFile
    for (const [setId, set] of Object.entries(file.sets ?? {})) {
      if (set.hide) continue
      const markers: Record<string, unknown> = {}
      for (const [id, m] of Object.entries(set.markers ?? {})) {
        const label = plainLabel(m)
        if (!label) continue
        markers[`dynmap-${id}`] = {
          type: 'html',
          position: { x: m.x, y: m.y, z: m.z },
          label,
          html: '',
          classes: [],
          anchor: { x: 0, y: 0 },
          listed: true,
          sorting: 0,
        }
      }
      if (Object.keys(markers).length === 0) continue
      sets[`dynmap-${setId}`] = {
        label: SET_LABELS[setId] ?? set.label ?? setId,
        // 3D の画面に何も描かないので、表示の切り替えはいらない
        toggleable: false,
        defaultHidden: false,
        sorting: set.layerprio ?? 0,
        markers,
        markerSets: {},
      }
    }
  }
  cache.set(world, { at: Date.now(), sets })
  return sets
}

/** markup が true の名前は HTML なので、文字だけにする */
function plainLabel(m: DynmapPoint): string {
  const label = m.label ?? ''
  const text = m.markup ? label.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"') : label
  return text.replace(/\s+/g, ' ').trim()
}
