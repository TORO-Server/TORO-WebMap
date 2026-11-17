# 設計メモ

概要は [README.md](../README.md) にあります。この文書は、Dynmap の画面とサーバーの作りをまとめた、ただ 1 つの詳しい文書です。配信の分け方 (静的な画面と API) は [map-deployment.md](map-deployment.md) にあります。他者製の部品の帰属は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) にあります。

Dynmap の画面のサイトの画面は `app/` です。Dynmap の `web/index.html` (jQuery と Leaflet 1.7) の代わりに、Vue と Leaflet 1.9 で同じものを描きます。見た目は Dynmap の `css/dynmap_style.css` と `images/` をそのまま使い、同じクラス名の要素を作っています。前の画面は比べるために `/legacy.html` に残してあり、`index.html?worldname=...` のような前のリンクは `/?worldname=...` に転送します。

BlueMap (3D 地図) の画面は、別のリポジトリ [TORO-3D-WebMap](https://github.com/TORO-Server/TORO-3D-WebMap) の静的なサイトになりました。このリポジトリには、従来の 3D 地図が使っているサーバー側 (地図のデータの配信、看板の中継、Minecraft のリソース) が、TORO-API へ移すまで現行の動的な部分として残っています。`server/lib/marumasign/` の `core.ts`、`manifest.ts`、`xml-head.ts` は、画面側と共有していたものを TORO-3D-WebMap と同じ内容で写したものです。

地図のデータはすべて TiDB にあります。

- Dynmap: DB `dynmap`。タイル、マーカー、プレイヤーの顔、設定とワールドの更新 (`JsonFileClientUpdateComponent` が 2 秒ごとに書き出す)
- BlueMap: DB `bluemap` (BlueMap 5.x の SQL 保存)。タイル、描いた範囲の記録、テクスチャ、プレイヤーの顔。プレイヤーの位置などのライブ情報だけは BlueMap 内蔵の Web サーバー に聞く

## 中身

| ファイル | 中身 |
| --- | --- |
| `app/components/DynmapView.vue` | Dynmap の画面。同じ `app/components/` にサイドバー、時計、チャット欄 |
| `app/lib/viewer.ts` | 地図の切り替え、ワールドの更新 (2 秒ごと)、プレイヤー、座標とリンクの表示、チャット (Dynmap の `web/js/map.js` などの代わり) |
| `app/lib/tile-layer.ts`, `projection.ts` | HD 地図のタイルの名前と投影 (`web/js/hdmap.js` と同じ計算) |
| `app/lib/markers.ts` | マーカー (`web/js/markers.js` と同じ見た目) |
| `app/lib/gl-marker-layer.ts` | 点のマーカーの絵を WebGL でまとめて描く。マウスを乗せたものだけ元の DOM のマーカーを重ね、名前と吹き出しはそれが出す |
| `app/lib/culled-group.ts` | 名前を常に出す組と、WebGL が使えないとき (`?gl=0` でも) の DOM のマーカー。画面の近くのものだけ作る |
| `server/routes/map/v1/**` | 上の `/up/*` `/tiles/*` と同じ実装 (`server/utils/dynmap-api.ts`) を API 用のホストの `/map/v1/*` で返す。静的/API 分離は `docs/map-deployment.md` |
| `server/routes/maps/[...path].get.ts` | BlueMap の `/maps/<map>/...` |
| `server/routes/maps/[map]/live/markers.json.get.ts`, `server/utils/dynmap-markers.ts` | BlueMap のマーカー。BlueMap 内蔵の Web サーバーのマーカーに、Dynmap で最初から出している組の点のマーカー (駅や IC など) を足す。中身が空の html マーカーなので 3D の画面には描かず、一覧にだけ出る (選ぶとカメラが動く)。地図とワールドの対応は `nuxt.config.ts` の `bluemap.dynmapWorlds` |
| `server/routes/up/ws.ts`, `server/utils/live.ts`, `server/lib/live-hub.ts` | ブラウザへの WebSocket (`/up/ws`)。Dynmap の更新を DB から 1 秒ごとに 1 度だけ読んで、変わったときに送る (読むのは `dynmap_config.json` にあるワールドだけ)。プレイヤーの位置は dynmap-live から届いたものをすぐ送る。送るのは、Dynmap の更新の `players` で `world` が実在のワールドで、dynmap-live の位置と同じワールドの人だけ (Dynmap は隠す人の `world` を実在しない名前にして送る)。体力と防具も Dynmap が送っているときだけ。どのくらい隠すかは Dynmap の `configuration.txt` の `ClientUpdateComponent` の設定で決まる。1 つのメッセージの大きさの上限は `server/lib/ws-options.ts` |
| `server/routes/live/plugin.ts` | TORO-Core の dynmap-live からの WebSocket (`/live/plugin`)。外には出さず、`NUXT_LIVE_TOKEN` で確かめる |
| `client/dynmap-client.ts` | 前の画面 (`legacy.html`) を軽くするスクリプト。`public/toro/dynmap-client.js` に変換して `/toro/` で返す |
| `client/sw.ts` | Dynmap の画面の Service Worker (ホーム画面に追加してアプリのように開ける PWA)。`public/sw.js` に変換して `/sw.js` で返す。ページはいつもネットから読み、つながらないときは `public/pwa/offline.html`。`/_nuxt/` だけキャッシュし、地図のデータはキャッシュしない |
| `server/routes/mcassets/`, `server/utils/mcassets.ts`, `mcassets-build.ts`, `zip.ts` | 構造物の看板を描くための Minecraft のリソースのまとめ (`/mcassets/`)。下の「構造物」。手元で中身と大きさを見るときは `node --experimental-strip-types tools/mcassets.ts <jar>` |
| `public/pwa/` | 地図ごとの manifest (`map.webmanifest`) とアイコン。アイコンは `node tools/pwa-icons.ts` で作る (TORO のロゴの 2 行目を地図の名前にしたもの) |

新しい画面が前の画面と違うところ (見た目と操作は同じ):

- 点のマーカーは WebGL (GPU) で描き、範囲や線は SVG ではなく Canvas に描く (前の画面はズームのたびに全マーカーの DOM を作り直していた)。
- タイルの URL にページを開いた時刻を付けない (付けると開くたびに URL が変わり、ブラウザにも途中の中継にもキャッシュが効かない)。描き直したタイルには、届いた時刻を付けて読み直す
- タイルの読み込みを 5 枚ずつに絞らない
- jQuery を使わない
- 更新は WebSocket (`/map/v1/ws`。3d-map の画面は `/up/ws`) で届く。全員が 2 秒ごとに取りに来る代わりに、サーバーが変わったときだけ送る。
  プレイヤーは TORO-Core の dynmap-live から 0.25 秒ごとに届く位置へ滑らかに動く。つながらないときは前と同じく 2 秒ごとに取りに行く

Dynmap を更新したときは、`up/configuration` と `up/world/...` の形、`web/css/dynmap_style.css` のクラス名が変わっていないか確かめてください。

## もっと縮小できるようにするとき

`main/plugins/dynmap/worlds.txt` のワールドの `extrazoomout` を増やします (main は 7。東西に長く、2 では全体が見えなかった)。

- Dynmap は増えた段のタイルを最初に作らないので、`tools/dynmap-zoomout.ts` で 1 つ下の段から作って DB に入れます。あとは下の段が変わるたびに Dynmap が作り直します
  ```bash
  node --experimental-strip-types tools/dynmap-zoomout.ts main flat 10   # 最後の数は up/configuration の mapzoomout
  node --experimental-strip-types tools/dynmap-zoomout.ts main surface 12 --check   # 書き込まずに、Dynmap の作ったものと比べるだけ
  ```
  (`sharp` と `mysql2` が要る)
- 段が増えると Leaflet のズームの数がずれるので、画面 (`app/lib/viewer.ts` の `LINK_EXTRAZOOMOUT`) は、リンクの `zoom=` と `defaultzoom` を extrazoomout が 2 のときの数として扱います。前に共有されたリンクも同じ縮尺で開き、それより縮小すると `zoom=` は負になります

Dynmap 側の設定 (`main/plugins/dynmap/configuration.txt`):

- `disable-webserver: true`
- `JsonFileClientUpdateComponent` (`InternalClientUpdateComponent` の代わり)
- `url:` で URL を `up/...` と `tiles/...` にしている。タイルが `.webp` の URL のままなので、途中の中継がキャッシュできる

BlueMap 側の設定 (`main/plugins/BlueMap/`): `maps/overworld.conf` の `storage: "sql"`、`storages/sql.conf` の `connection-url` を TiDB の `bluemap` に向ける。

## 開発

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### 3D 地図の動的な部分 (サーバー側)

3D 地図の画面と、看板の表示の作りは TORO-3D-WebMap の文書にあります。ここには、このアプリのサーバー側が守っていることを残します。

- 外のサイトの画像や動画は、まず画面が直に読み、読めなければ (CORS がない、転送される) このサーバーに頼みます。
  - `/_marumasign/resolve?u=` (`server/routes/_marumasign/resolve.get.ts`): 転送 (URL の短縮サービスなど) を追って行き先を教える。行き先が CORS を返せば、ブラウザーは行き先を (同じ決まりで確かめてから) 直に読む
  - `/_marumasign/proxy?u=[&p=]` (`server/routes/_marumasign/proxy.ts`): CORS のないサイトのものを中継する。動画は Range に対応。ライブ配信の再生リストや分割されたファイルも (hls.js・shaka-player・mpegts.js の読み込みは、どれも `fetch.ts` の読み方に差し替えてある。分割されたファイルの転送もブラウザーには追わせない)
  - どちらも、看板データ (`marumasign/<地図>.json`) にいまある URL と、その転送先、それらの再生リスト (HLS, MPEG-DASH) と .gltf に書かれた URL だけを読む (ただの中継にならないように。`server/lib/marumasign/allow.ts`)。看板データは `nuxt.config.ts` の `runtimeConfig.marumasign.signData` から読む (設定は `NUXT_MARUMASIGN_SIGN_DATA` と `signDataHost`)
  - 再生リストの中身は外のサーバーが決めるので、主スレッドを止めないよう、外から来たものから正規表現を作らない (`manifest.ts` の `matchPattern`。前から 1 度だけ見る)。XML も前から 1 度だけ読む
  - 再生リストと別のサイト (登録できるドメインが違う) に書かれた URL は、中身の目印がなければ、分割ファイルらしい拡張子のものは 16 MiB まで、それ以外は 4 KiB (暗号化の鍵など) までしか中継しない。看板に書ける画像や動画などの種類は、これまでどおり
  - https だけ。転送の行き先ごとに名前を引いたアドレスを確かめ、手元・家の中・内部のネットワーク・共有アドレス (CGNAT)・リンクローカル・マルチキャスト・IPv6 の固有ローカルなどにはつながない (`server/lib/marumasign/net.ts`。つなぐときの名前引きで確かめるので、確かめた後にすり替えられない)
  - 返すのは先頭のバイト列で分かった種類 (画像・動画・音声・PDF・3D のもの・再生リスト) だけで、大きさは種類ごとに MarumaSign 本体と同じ上限。HTML は返さない。返すものは `Content-Security-Policy: sandbox`、`nosniff`、`Content-Disposition: attachment`、決まった Content-Type で、このサイトのページとして開けない (`server/lib/marumasign/kinds.ts`)
  - 地図のページからだけ (`Sec-Fetch-Site`、`Origin`。ブラウザーでないものは避けられるので、貼り付けの抑止にとどまる)。1 つの IP (`CF-Connecting-IP`。IPv6 は /64 ごと) から 10 分あたりの数と量、全体の 10 分あたりの量、同時に読む数に上限
  - 入り口のプロキシは `/_marumasign/` をこのアプリに送り、そこではためない (`streamHandler`)
- プレイヤーの頭のスキン (建築データ): 名前や UUID しか書かれていないものは、このサーバーの `/mcassets/skin?name=` / `?uuid=` に聞かれる。サーバーは形を確かめた名前か UUID で、決まったホスト (名前 → UUID は api.mojang.com、だめなら api.minecraftservices.com。UUID → textures は sessionserver.mojang.com) だけに問い合わせ、スキンの URL と腕のモデルだけを返す (分かったものは 1 時間、分からなかったものと失敗は 10 分覚える。4096 件まで。1 つの IP から 10 分に 600 回、そのうち問い合わせは 60 回まで (CF-Connecting-IP)。同時に 4 つ、待たせるのは 64 まで。5 秒で時間切れ、Cookie なし、転送は追わない)。分からなければ Steve

リソースは、TORO-WebMap が起動したときに jar から作ってメモリに持ち (1 秒ほど)、`/mcassets/<hash>/` で返します (`assets.json` = blockstates, models, アイテムの定義、バイオームの色など、`textures.bin` = 使うテクスチャの PNG を並べたもの、`unifont/<ページ>.txt`)。URL に内容を表す識別子が入るので、ブラウザーも途中の中継もいつまでも持ってよく、`/mcassets/index.json` (5 分) がいまの識別子を返します。Mojang のファイルは git にも Docker のイメージにも入れず、jar は読むだけでマウントします。BlueMap のリソースパックもマウントすれば、名前の順に上書きします (本体は使わないので、同じ見た目にするならマウントしない)。Unifont は jar になく、初めてのときに Mojang の配布元から hash を確かめて 1 度だけ読み、`NUXT_MCASSETS_CACHE` に置きます。

入り口のプロキシには、`/mcassets/` (`/mcassets/skin` も) をこのアプリに渡す規則が要ります (中身は Cache-Control のとおり持ってよい)。新しい jar が増えたら、10 分ごとの確かめで作り直します。jar がないとき (`/mcassets/index.json` が 503) は、前と同じ簡単にした形を地図のテクスチャで描きます (`structure/mesher.ts`)。
