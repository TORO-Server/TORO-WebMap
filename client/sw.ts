/// <reference lib="webworker" />
// map.torosaba.net と 3d-map.torosaba.net の Service Worker。public/sw.js に変換して /sw.js で返す (app/app.vue が登録する)
// ホーム画面に追加してアプリのように開けるようにするためのもの。地図のデータ (tiles/, up/, maps/ など) はキャッシュしない
// (変わり続けるうえに量が多い。toro-edge と Cloudflare がまとめている)
// - ページを開くとき: いつもネットから。つながらないときはオフラインのページ (public/pwa/offline.html)
// - /_nuxt/ の js と css: 名前に版が入っていて中身が変わらないので、一度読んだものはキャッシュから
// モジュールにして、self を Service Worker の型で宣言し直す
export {}
declare const self: ServiceWorkerGlobalScope

// 変えたら数を上げる (古いキャッシュは activate で消える)
const VERSION = 1
const SHELL = `toro-map-shell-${VERSION}`
const ASSETS = `toro-map-assets-${VERSION}`
const OFFLINE = '/pwa/offline.html'
// /_nuxt/ のキャッシュに残す数 (更新のたびに名前が変わるので、古いものから消す)
const MAX_ASSETS = 120

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL)
    await cache.add(new Request(OFFLINE, { cache: 'reload' }))
    await self.skipWaiting()
  })())
})

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    for (const key of await caches.keys()) {
      if (key.startsWith('toro-map-') && key !== SHELL && key !== ASSETS) await caches.delete(key)
    }
    await self.clients.claim()
  })())
})

self.addEventListener('fetch', (event) => {
  const request = event.request
  if (request.method !== 'GET') return
  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === 'navigate') {
    event.respondWith(fetch(request).catch(async () => (await caches.match(OFFLINE, { cacheName: SHELL })) ?? Response.error()))
    return
  }
  if (url.pathname.startsWith('/_nuxt/')) event.respondWith(cacheFirst(request))
})

async function cacheFirst(request: Request): Promise<Response> {
  const cache = await caches.open(ASSETS)
  const hit = await cache.match(request)
  if (hit) return hit
  const response = await fetch(request)
  if (response.ok && response.type === 'basic') {
    await cache.put(request, response.clone())
    const keys = await cache.keys()
    for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ASSETS))) await cache.delete(key)
  }
  return response
}
