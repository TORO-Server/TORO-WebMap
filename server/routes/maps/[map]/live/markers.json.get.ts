import { gunzipSync, inflateSync } from 'node:zlib'

// BlueMap (3d-map.torosaba.net) の /maps/<map>/live/markers.json
// BlueMap のマーカー (BlueMap 内蔵の Web サーバーに聞く。止まっているときは DB の最後の版) に、
// Dynmap (map.torosaba.net) の地点 (駅や IC など) を足して返す。足した地点は 3D の画面には描かず、マーカーの一覧にだけ出る
// (3D の画面では建物そのものが見えるため。一覧で選ぶと、カメラがそこへ動く)

type MarkerSets = Record<string, unknown>

export default defineEventHandler(async (event) => {
  const mapId = getRouterParam(event, 'map') ?? ''
  const [bluemap, dynmap] = await Promise.all([bluemapMarkers(mapId), dynmapListedMarkers(mapId)])
  return respond(event, {
    data: JSON.stringify({ ...dynmap, ...bluemap }),
    type: 'application/json',
    cache: 'no-cache',
  })
})

async function bluemapMarkers(mapId: string): Promise<MarkerSets> {
  const { bluemap } = useRuntimeConfig()
  try {
    const res = await fetch(`${bluemap.live}/maps/${encodeURIComponent(mapId)}/live/markers.json`, { signal: AbortSignal.timeout(2000) })
    if (res.ok) return await res.json() as MarkerSets
  }
  catch {
    // toro-main の再起動中など。DB の最後の版にする
  }
  const found = await bluemapItem(mapId, 'bluemap:markers')
  if (!found) return {}
  try {
    const raw = found.compression === 'bluemap:gzip' ? gunzipSync(found.data)
      : found.compression === 'bluemap:deflate' ? inflateSync(found.data)
        : found.data
    return JSON.parse(raw.toString()) as MarkerSets
  }
  catch {
    return {}
  }
}
