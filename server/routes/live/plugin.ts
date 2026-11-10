import { tokenMatches } from '../../lib/token'

// TORO-Core の dynmap-live (Minecraft サーバーの中) からの WebSocket。全員の位置と体力が 0.25 秒ごとに届く
// toro-edge はここを外に出さない (Docker の中のネットワークからだけ)。さらに NUXT_LIVE_TOKEN で確かめる
export default defineWebSocketHandler({
  upgrade(request) {
    if (!tokenMatches(request.headers.get('x-toro-token'), useRuntimeConfig().liveToken)) {
      return new Response('Forbidden', { status: 403 })
    }
  },
  message(_peer, message) {
    let data: { t?: string, players?: unknown } | null
    try {
      data = message.json()
    }
    catch {
      return
    }
    if (data && data.t === 'players' && Array.isArray(data.players)) livePositions(data.players)
  },
})
