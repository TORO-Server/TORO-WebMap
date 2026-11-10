// ブラウザ (map.torosaba.net / 3d-map.torosaba.net の画面) との WebSocket。
// map.torosaba.net (Dynmap): 見ているワールドを {"subscribe": "<world>"} で知らせてもらい、そのワールドの更新とプレイヤーの位置を送る (server/utils/live.ts)
// 3d-map.torosaba.net (BlueMap): 見ている地図を {"bluemap": "<map>"} で知らせてもらい、BlueMap のライブ情報を送る (server/utils/bluemap-live.ts)
const messageTimestamps = new Map<string, number[]>()
// 届くのは名前が 1 つだけの短いもの (全体の上限は server/lib/ws-options.ts)。これより長いものは解かない
const MAX_MESSAGE_CHARS = 512

export default defineWebSocketHandler({
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
