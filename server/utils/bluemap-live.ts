import type { Peer } from 'crossws'

// BlueMap (3d-map.torosaba.net) のライブ情報 (プレイヤーの位置、描き直したタイル、マーカーの変更) を、ブラウザへ WebSocket (/up/ws) で届ける中継
//
// - BlueMap 内蔵の Web サーバー (toro-main:8100) の live/sse を、見ている地図ごとに 1 本だけつなぎ、届いたイベントをその地図を見ているブラウザ全員へ送る
//   (今までは、見ている人の数だけ toro-main へつないでいた)
// - 送るのは {"type":"bluemap","map":"<地図>","event":"player|tile|marker","data":"<BlueMap が送った JSON の文字列そのまま>"}。
//   画面 (app/bluemap/js/BlueMapApp.ts) は、SSE のときと同じ処理でこれを受ける
// - BlueMap 本体とつながっているかは {"type":"bluemap","map":"<地図>","state":"open|error"} で知らせる。
//   画面は open のあいだ 1 秒ごとの取りに行きをやめ、error (toro-main の再起動中など) のあいだは取りに行く
// - つなぎっぱなしのとき WebSocket が黙らないよう (toro-edge は 120 秒何も流れないつなぎを切る)、30 秒ごとに {"type":"ping"} を送る

interface Upstream {
  open: boolean
  stopped: boolean
  abort: AbortController
}

const EVENTS = new Set(['player', 'tile', 'marker'])
const HEARTBEAT_MS = 30_000
const MAX_RETRY_MS = 15_000

/** 見ている人と、その人が見ている地図 */
const viewers = new Map<Peer, string>()
const upstreams = new Map<string, Upstream>()
let heartbeat: ReturnType<typeof setInterval> | undefined

function send(peer: Peer, text: string): void {
  try {
    peer.send(text)
  }
  catch {
    viewers.delete(peer)
  }
}

function broadcast(mapId: string, text: string): void {
  for (const [peer, id] of viewers) {
    if (id === mapId) send(peer, text)
  }
}

function stateText(mapId: string, open: boolean): string {
  return JSON.stringify({ type: 'bluemap', map: mapId, state: open ? 'open' : 'error' })
}

function setOpen(mapId: string, up: Upstream, open: boolean): void {
  if (up.open === open) return
  up.open = open
  broadcast(mapId, stateText(mapId, open))
}

/** toro-main の live/sse を読み続ける。切れたら間を置いてつなぎ直す。見る人がいなくなる (up.stopped) まで */
async function run(mapId: string, up: Upstream): Promise<void> {
  const { bluemap } = useRuntimeConfig()
  const url = `${bluemap.live}/maps/${encodeURIComponent(mapId)}/live/sse`
  let retry = 1000
  while (!up.stopped) {
    try {
      const res = await fetch(url, { headers: { accept: 'text/event-stream' }, signal: up.abort.signal })
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`)
      setOpen(mapId, up, true)
      retry = 1000
      const parser = new SseParser()
      const decoder = new TextDecoder()
      const reader = res.body.getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        for (const ev of parser.push(decoder.decode(value, { stream: true }))) {
          if (EVENTS.has(ev.event)) broadcast(mapId, JSON.stringify({ type: 'bluemap', map: mapId, event: ev.event, data: ev.data }))
        }
      }
    }
    catch {
      // toro-main の再起動中など。つなぎ直す
    }
    if (up.stopped) return
    setOpen(mapId, up, false)
    await new Promise(resolve => setTimeout(resolve, retry))
    retry = Math.min(retry * 2, MAX_RETRY_MS)
  }
}

function startUpstream(mapId: string): Upstream {
  let up = upstreams.get(mapId)
  if (!up) {
    up = { open: false, stopped: false, abort: new AbortController() }
    upstreams.set(mapId, up)
    void run(mapId, up)
  }
  return up
}

/** その地図を見ている人がいなくなったら、BlueMap とのつなぎをやめる */
function release(mapId: string): void {
  for (const id of viewers.values()) {
    if (id === mapId) return
  }
  const up = upstreams.get(mapId)
  if (!up) return
  up.stopped = true
  up.abort.abort()
  upstreams.delete(mapId)
}

function startHeartbeat(): void {
  heartbeat ??= setInterval(() => {
    if (viewers.size === 0) {
      clearInterval(heartbeat)
      heartbeat = undefined
      return
    }
    for (const peer of viewers.keys()) send(peer, '{"type":"ping"}')
  }, HEARTBEAT_MS)
}

/** ブラウザが {"bluemap": "<地図>"} で、見る地図を知らせてきた */
export async function bluemapSubscribe(peer: Peer, mapId: string): Promise<void> {
  const previous = viewers.get(peer)
  if (previous === mapId) return
  viewers.set(peer, mapId)
  if (previous !== undefined) release(previous)
  startHeartbeat()
  // 知らない地図の名前で、BlueMap へつなぎに行かない
  if (!await bluemapMapExists(mapId)) {
    if (viewers.get(peer) === mapId) {
      viewers.delete(peer)
      send(peer, JSON.stringify({ type: 'bluemap', map: mapId, state: 'error' }))
    }
    return
  }
  // 調べているあいだに、閉じた・別の地図に変えたときは何もしない
  if (viewers.get(peer) !== mapId) {
    release(mapId)
    return
  }
  const up = startUpstream(mapId)
  send(peer, stateText(mapId, up.open))
}

export function bluemapLeave(peer: Peer): void {
  const previous = viewers.get(peer)
  if (previous === undefined) return
  viewers.delete(peer)
  release(previous)
}
