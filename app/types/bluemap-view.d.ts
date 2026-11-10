// Nuxt の型の確かめ (npm run typecheck の nuxt typecheck) では、BlueMap の画面をこの型として見る。
// BlueMap の画面 (app/bluemap/) は元が JavaScript なので、別の設定 (app/bluemap/tsconfig.json) で確かめる
import type { DefineComponent } from 'vue'

declare const BlueMapView: DefineComponent
export default BlueMapView
