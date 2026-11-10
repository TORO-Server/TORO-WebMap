import { WS_SERVER_OPTIONS } from '../lib/ws-options'

// WebSocket のサーバーを作る前に (Nitro は、プラグインを動かしてから nitroApp.h3App.websocket で作る)、上限を渡す
export default defineNitroPlugin((nitroApp) => {
  Object.assign(nitroApp.h3App.websocket, { serverOptions: WS_SERVER_OPTIONS })
})
