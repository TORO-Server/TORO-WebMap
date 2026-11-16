// Dynmap の画面が使う API (設定・ワールドの更新・WebSocket・タイル・マーカー・顔) の URL は、すべてここから作る。
// 基点は nuxt.config.ts の runtimeConfig.public.apiBase (ビルド時に NUXT_PUBLIC_API_BASE で差し替えられる)。
// パスの対応表は docs/map-deployment.md
let base: string | undefined

/** 末尾の / なしの API の基点 */
function apiBase(): string {
  base ??= String(useRuntimeConfig().public.apiBase).replace(/\/+$/, '')
  return base
}

/** API の URL。path は基点からの相対 (例: 'configuration', 'tiles/') */
export function apiUrl(path: string): string {
  return `${apiBase()}/${path.replace(/^\/+/, '')}`
}

/** WebSocket の URL (基点の https → wss、http → ws。基点が相対パスなら、いまのページのオリジンから) */
export function wsUrl(): string {
  const url = new URL(apiUrl('ws'), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
