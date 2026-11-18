// Dynmap の画面が使う API (設定・ワールドの更新・WebSocket・タイル・マーカー・顔) の URL は、すべてここから作る。
// 基点は nuxt.config.ts の runtimeConfig.public.apiBase (ビルド時に NUXT_PUBLIC_API_BASE で差し替えられる)。
// パスの対応表は docs/map-deployment.md
import { joinBase } from './url'

let base: string | undefined

/** 末尾の / なしの API の基点 */
function apiBase(): string {
  base ??= String(useRuntimeConfig().public.apiBase).replace(/\/+$/, '')
  return base
}

let tileRoot: string | undefined

/** 末尾の / なしのタイルの基点 (runtimeConfig.public.tileBase) */
function tileBase(): string {
  tileRoot ??= String(useRuntimeConfig().public.tileBase).replace(/\/+$/, '')
  return tileRoot
}

/** 地図のタイルの URL (assets のホスト)。path は基点からの相対 (例: 'tiles/<world>/<map>/<dir>/<zz_x_y>.webp')。タイル以外 (マーカー、顔など) は apiUrl を使う */
export function tileUrl(path: string): string {
  return joinBase(tileBase(), path)
}

/** API の URL。path は基点からの相対 (例: 'configuration', 'tiles/') */
export function apiUrl(path: string): string {
  return joinBase(apiBase(), path)
}

/** WebSocket の URL (基点の https → wss、http → ws。基点が相対パスなら、いまのページのオリジンから) */
export function wsUrl(): string {
  const url = new URL(apiUrl('ws'), window.location.href)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return url.toString()
}
