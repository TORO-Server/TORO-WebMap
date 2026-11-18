// app/: map.torosaba.net の地図の画面 (Dynmap の web/index.html の代わり)。サーバーで描かず、ブラウザで描く静的なサイト (nuxt generate)。
// 地図のデータの API は TORO-API (api.torosaba.net/map/v1)。このリポジトリにサーバー側のコードはない (docs/map-deployment.md)
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: false,
  pages: false,
  devtools: { enabled: false },
  telemetry: false,
  sourcemap: { server: false, client: false },
  app: {
    // ブラウザで描く前の HTML にも入るので、日本語のページとして扱われる (Dynmap の index.html は en だった)。
    // アイコンなどは画面 (app/components/DynmapView.vue) が足す
    head: {
      title: 'TORO Server',
      htmlAttrs: { lang: 'ja' },
      meta: [
        { name: 'description', content: 'TORO Server (Minecraft) のワールドの地図' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1' },
      ],
    },
  },
  runtimeConfig: {
    public: {
      // Dynmap の画面が読む API の基点 (app/lib/api.ts)。この文字列の正本はここ 1 か所。
      // 静的な画面 (GitHub Pages) のビルドで NUXT_PUBLIC_API_BASE を設定すると差し替えられる。docs/map-deployment.md
      apiBase: 'https://api.torosaba.net/map/v1',
      // 地図のタイル (HD 地図の画像) だけを読む基点 (app/lib/api.ts の tileUrl)。パスは apiBase と同じで、ホスト名だけが assets。
      // この文字列の正本もここ 1 か所。ビルド時に NUXT_PUBLIC_TILE_BASE で差し替えられる。docs/map-deployment.md
      tileBase: 'https://assets.torosaba.net/map/v1',
    },
  },
  nitro: {
    // public/toro/dynmap-client.js (client/dynmap-client.ts を esbuild で変換したもの。古い画面 legacy.html 用)
    publicAssets: [{ dir: 'public', maxAge: 300 }],
  },
  // npm run dev: Dynmap の画面の API は既定の apiBase (本番の API) を使う。css/ images/ は public/ にある。
  // 手元の API を使うなら NUXT_PUBLIC_API_BASE で手元の TORO-API (…/map/v1) を指す
})
