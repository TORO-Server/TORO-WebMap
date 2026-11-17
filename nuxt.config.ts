// app/: map.torosaba.net の地図の画面 (Dynmap の web/index.html の代わり)。サーバーで描かず、ブラウザで描く
// server/routes/: 地図のデータを TiDB から返す API (Dynmap と BlueMap)。入り口のプロキシから呼ばれる。BlueMap (3D 地図) の画面は TORO-3D-WebMap
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: false,
  pages: false,
  devtools: { enabled: false },
  telemetry: false,
  // 本番のイメージにソースマップを入れない (ブラウザにも渡さない)
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
    },
    // NUXT_DB_HOST などの環境変数で上書きする
    db: {
      host: 'localhost',
      port: 4000,
      user: 'root',
      password: '',
    },
    dynmap: {
      database: 'dynmap',
      prefix: 'dynmap_',
      // Dynmap の web/ (blank.png を読む)
      web: '/srv/dynmap-web',
    },
    bluemap: {
      database: 'bluemap',
      prefix: 'bluemap_',
      // BlueMap 内蔵の Web サーバー (ライブ情報)
      live: 'http://localhost:8100',
      // BlueMap の地図ごとに、マーカーの一覧へ地点を足す Dynmap のワールド
      dynmapWorlds: { overworld: 'main' },
    },
    // TORO-Core の dynmap-live が /live/plugin につなぐときの合言葉 (NUXT_LIVE_TOKEN)。空のときはつながせない
    liveToken: '',
    // assets.torosaba.net (MarumaSign Companion がホストした看板の画像など。server/routes/_assets/)
    assets: {
      database: 'marumasign',
      prefix: 'msc_',
      // ここからのページは読める (ブラウザの Origin / Referer)
      origins: ['https://map.torosaba.net', 'https://3d-map.torosaba.net'],
      // ログアウトしてからも、その IP から読めるようにしておく時間 (分)
      graceMinutes: 10,
    },
    // TORO-Proxy が /live/clients に、いまつながっているプレイヤーの IP を送るときの合言葉 (NUXT_CLIENTS_TOKEN)。空のときは受け付けない
    clientsToken: '',
    // MarumaSign の看板の転送先を調べる /_marumasign/resolve と、CORS のないサイトの中継 /_marumasign/proxy (server/routes/_marumasign/)。
    // 読むのは看板データにある URL (とそこからたどれるもの) だけ。NUXT_MARUMASIGN_SIGN_DATA などで上書きする
    marumasign: {
      enabled: true,
      // 看板データ (marumasign/<地図>.json) と、地図の一覧 (settings.json) の読み場所。
      // http(s):// なら HTTP で (Host は signDataHost。空なら看板データは読まない。NUXT_MARUMASIGN_SIGN_DATA で指定する)、ほかは BlueMap の web のフォルダ
      signData: '',
      signDataHost: '3d-map.torosaba.net',
      // 地図の id。空なら settings.json の maps
      maps: [] as string[],
      // 看板データを読み直す間隔 (秒。ブラウザーと同じ 60 秒)
      refreshSeconds: 60,
      // ここからのページの Origin は使える (同じサイトのページのほかに)
      origins: ['https://3d-map.torosaba.net'],
      // 1 つの IP からの数と量の上限に使う、ブラウザーの IP の頭書き (Cloudflare が付ける)
      ipHeader: 'cf-connecting-ip',
      // 試験だけ: 名前とアドレスの対応 (アドレスの確かめと証明書の確かめを外す)。本番では空にする
      testHosts: {} as Record<string, string>,
    },
    // 構造物の看板を描くための Minecraft のリソース (server/utils/mcassets.ts、/mcassets/)。
    // jar は BlueMap が使っているクライアントの jar を読むだけでマウントする (NUXT_MCASSETS_JAR)。空なら構造物は簡単な形で描く。
    // フォルダ (BlueMap の main/bluemap) を渡すと、その中の minecraft-client-<版>.jar のうち最も新しい版を使う
    mcassets: {
      jar: '',
      // BlueMap のリソースパックのフォルダ (main/plugins/BlueMap/packs。NUXT_MCASSETS_PACKS)。空なら使わない
      packs: '',
      // Unifont (jar にない文字) を置いておく場所 (NUXT_MCASSETS_CACHE)
      cache: '/tmp/webmap-mcassets',
      // Unifont: 'download' (Mojang の配布元から 1 度だけ読む)、zip のファイルの場所、'off'
      unifont: 'download',
    },
  },
  nitro: {
    // public/toro/dynmap-client.js (client/dynmap-client.ts を esbuild で変換したもの。古い画面 legacy.html 用)
    publicAssets: [{ dir: 'public', maxAge: 300 }],
    // /map/v1/ws と /up/ws (ブラウザ。/up/ws は従来の 3d-map の画面用。TORO-API へ移すまで残す) と /live/plugin (TORO-Core) の WebSocket
    experimental: { websocket: true },
  },
  // npm run dev: Dynmap の画面の API は既定の apiBase (本番の API) を使う。css/ images/ は public/ にある。
  // 手元の API を使うなら NUXT_PUBLIC_API_BASE=/map/v1 で手元のサーバーを指す (NUXT_DB_HOST などで DB につなぐ)。TiDB はホストに公開していないことが多いので、
  // サーバーで DB の IP を調べて、ssh -L 4000:<DB の IP>:4000 でつなぐ
  $development: {
    // 看板データは本番のもの (中継は手元のサーバーが行う)
    runtimeConfig: {
      marumasign: { signData: 'https://3d-map.torosaba.net', signDataHost: '' },
    },
  },
})