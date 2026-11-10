// app/: map.torosaba.net の地図の画面 (Dynmap の web/index.html の代わり)。サーバーで描かず、ブラウザで描く
// server/routes/: 地図のデータを TiDB から返す API (Dynmap と BlueMap)。toro-edge から呼ばれる
export default defineNuxtConfig({
  compatibilityDate: '2026-10-01',
  ssr: false,
  pages: false,
  devtools: { enabled: false },
  telemetry: false,
  // 本番のイメージにソースマップを入れない (ブラウザにも渡さない)
  sourcemap: { server: false, client: false },
  app: {
    // ブラウザで描く前の HTML にも入るので、日本語のページとして扱われる (Dynmap と BlueMap の index.html は en だった)。
    // アイコンなど画面ごとのものは、それぞれの画面 (app/components/DynmapView.vue, app/bluemap/BlueMapView.vue) が足す
    head: {
      title: 'TORO Server',
      htmlAttrs: { lang: 'ja' },
      meta: [
        { name: 'description', content: 'TORO Server (Minecraft) のワールドの地図' },
        { name: 'viewport', content: 'width=device-width, initial-scale=1.0, user-scalable=no, maximum-scale=1' },
      ],
    },
  },
  typescript: {
    // BlueMap の画面は別に確かめる (app/types/bluemap-view.d.ts)
    appTsConfig: {
      compilerOptions: {
        paths: { '~/bluemap/BlueMapView.vue': ['../app/types/bluemap-view.d.ts'] },
      },
      exclude: ['../app/bluemap/**'],
    },
  },
  vite: {
    // 宣言だけのクラスのフィールドで、親のクラスが入れた値を消さない (tsconfig の useDefineForClassFields: false と同じ)。
    // BlueMap の画面は元が JavaScript なので、この前提で書かれている (three.js の Object3D の position なども消えない)
    oxc: {
      typescript: { removeClassFieldsWithoutInitializer: true },
      assumptions: { setPublicClassFields: true },
    },
    plugins: [{
      // three.js の DRACOLoader が既定で指す、使わない Draco の展開のプログラム (draco_decoder.js など、合わせて 1 MB) をビルドに入れない。
      // 3D モデルの看板は glTF 用の小さいもの (DRACO_GLTF_CONFIG) だけを使う (app/bluemap/marumasign/model-load.ts)
      name: 'drop-draco-defaults',
      enforce: 'pre',
      transform(code: string, id: string) {
        if (!/three[\\/]examples[\\/]jsm[\\/]loaders[\\/]DRACOLoader\.js$/.test(id.split('?')[0]!)) return null
        const out = code.replace(/new URL\(\s*'\.\.\/libs\/draco\/draco_[a-z_]+\.(?:js|wasm)',\s*import\.meta\.url\s*\)\.toString\(\)/g, '\'\'')
        if ((code.match(/draco_[a-z_]+\.(?:js|wasm)'/g) ?? []).length - (out.match(/draco_[a-z_]+\.(?:js|wasm)'/g) ?? []).length !== 3) {
          throw new Error('drop-draco-defaults: DRACOLoader.js changed; check the default decoder URLs')
        }
        return { code: out, map: null }
      },
    }],
    // BlueMap の画面の vue-i18n (BlueMap の vite.config.js と同じ)
    define: {
      __VUE_I18N_FULL_INSTALL__: true,
      __VUE_I18N_LEGACY_API__: false,
      __INTLIFY_PROD_DEVTOOLS__: false,
    },
  },
  runtimeConfig: {
    // NUXT_DB_HOST などの環境変数で上書きする
    db: {
      host: 'tidb',
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
      live: 'http://toro-main:8100',
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
      // http(s):// なら HTTP で (Docker では toro-edge。Host は signDataHost)、ほかは BlueMap の web のフォルダ
      signData: 'http://toro-edge',
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
    // /up/ws (ブラウザ) と /live/plugin (TORO-Core) の WebSocket
    experimental: { websocket: true },
  },
  // npm run dev: 地図のデータと Dynmap の css/ images/ は本番 (map.torosaba.net) から借りる。
  // /up/ws は手元で動かす (NUXT_DB_HOST などで DB につなぐ)。TiDB はホストに公開しておらず toro-db の内側だけなので、
  // サーバーで tidb の IP を調べて (docker network inspect toro-db)、ssh -L 4000:<tidb の IP>:4000 でつなぐ
  // BlueMap の画面 (?app=bluemap) では settings.json, lang/, assets/, maps/ などを 3d-map.torosaba.net から借りる
  $development: {
    // 看板データは本番のもの (中継は手元のサーバーが行う)
    runtimeConfig: {
      marumasign: { signData: 'https://3d-map.torosaba.net', signDataHost: '' },
    },
    nitro: {
      devProxy: {
        ...Object.fromEntries(['/up/configuration', '/up/world', '/tiles', '/css', '/images'].map(p => [p, { target: `https://map.torosaba.net${p}`, changeOrigin: true }])),
        ...Object.fromEntries(['/settings.json', '/lang', '/assets', '/maps', '/js', '/marumasign'].map(p => [p, { target: `https://3d-map.torosaba.net${p}`, changeOrigin: true }])),
      },
    },
  },
})
