// WebSocket のサーバーの設定 (server/plugins/websocket.ts が使う)。ws の既定は 1 つのメッセージで 100 MiB まで受けて、メモリにためる。
// 1 つの設定で全部の経路に効くので、いちばん大きいもの (TORO-Core の dynmap-live からの全員の位置。1 人 110 バイトほどで、2000 人でも足りる長さ) に合わせる。
// ブラウザから届くものは短い (server/routes/up/ws.ts がさらに短いものだけを解く)

export const WS_MAX_PAYLOAD = 256 * 1024

export const WS_SERVER_OPTIONS = {
  maxPayload: WS_MAX_PAYLOAD,
  perMessageDeflate: false,
}
