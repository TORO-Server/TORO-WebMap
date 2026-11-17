# 設計メモ

概要は [README.md](../README.md) にあります。この文書は、Dynmap の画面の作りをまとめた、ただ 1 つの詳しい文書です。配信の分け方 (静的な画面と API) は [map-deployment.md](map-deployment.md) にあります。他者製の部品の帰属は [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md) にあります。

Dynmap の画面のサイトの画面は `app/` です。Dynmap の `web/index.html` (jQuery と Leaflet 1.7) の代わりに、Vue と Leaflet 1.9 で同じものを描きます。見た目は Dynmap の `css/dynmap_style.css` と `images/` をそのまま使い、同じクラス名の要素を作っています。前の画面は比べるために `/legacy.html` に残してあり、`index.html?worldname=...` のような前のリンクは `/?worldname=...` に転送します。

BlueMap (3D 地図) の画面は、別のリポジトリ [TORO-3D-WebMap](https://github.com/TORO-Server/TORO-3D-WebMap) の静的なサイトです。地図のデータの配信 (Dynmap の DB の読み取り、WebSocket、看板の中継など) は TORO-API が担い、このリポジトリにサーバー側のコードはありません。以前のサーバー側のコードは、タグ `pre-server-removal` で読めます。

地図のデータは、Dynmap が TiDB の DB `dynmap` に書きます (タイル、マーカー、プレイヤーの顔、設定とワールドの更新。`JsonFileClientUpdateComponent` が 2 秒ごとに書き出す)。画面は DB に触らず、TORO-API の `/map/v1/` から取ります。

## 中身

| ファイル | 中身 |
| --- | --- |
| `app/components/DynmapView.vue` | Dynmap の画面。同じ `app/components/` にサイドバー、時計、チャット欄 |
| `app/lib/viewer.ts` | 地図の切り替え、ワールドの更新 (2 秒ごと)、プレイヤー、座標とリンクの表示、チャット (Dynmap の `web/js/map.js` などの代わり) |
| `app/lib/tile-layer.ts`, `projection.ts` | HD 地図のタイルの名前と投影 (`web/js/hdmap.js` と同じ計算) |
| `app/lib/markers.ts` | マーカー (`web/js/markers.js` と同じ見た目) |
| `app/lib/gl-marker-layer.ts` | 点のマーカーの絵を WebGL でまとめて描く。マウスを乗せたものだけ元の DOM のマーカーを重ね、名前と吹き出しはそれが出す |
| `app/lib/culled-group.ts` | 名前を常に出す組と、WebGL が使えないとき (`?gl=0` でも) の DOM のマーカー。画面の近くのものだけ作る |
| `client/dynmap-client.ts` | 前の画面 (`legacy.html`) を軽くするスクリプト。`public/toro/dynmap-client.js` に変換して `/toro/` で返す |
| `client/sw.ts` | Dynmap の画面の Service Worker (ホーム画面に追加してアプリのように開ける PWA)。`public/sw.js` に変換して `/sw.js` で返す。ページはいつもネットから読み、つながらないときは `public/pwa/offline.html`。`/_nuxt/` だけキャッシュし、地図のデータはキャッシュしない |
| `public/pwa/` | 地図ごとの manifest (`map.webmanifest`) とアイコン。アイコンは `node tools/pwa-icons.ts` で作る (TORO のロゴの 2 行目を地図の名前にしたもの) |

新しい画面が前の画面と違うところ (見た目と操作は同じ):

- 点のマーカーは WebGL (GPU) で描き、範囲や線は SVG ではなく Canvas に描く (前の画面はズームのたびに全マーカーの DOM を作り直していた)。
- タイルの URL にページを開いた時刻を付けない (付けると開くたびに URL が変わり、ブラウザにも途中の中継にもキャッシュが効かない)。描き直したタイルには、届いた時刻を付けて読み直す
- タイルの読み込みを 5 枚ずつに絞らない
- jQuery を使わない
- 更新は WebSocket (`/map/v1/ws`) で届く。全員が 2 秒ごとに取りに来る代わりに、サーバーが変わったときだけ送る。
  プレイヤーは TORO-Core の dynmap-live から 0.25 秒ごとに届く位置へ滑らかに動く。つながらないときは前と同じく 2 秒ごとに取りに行く

Dynmap を更新したときは、`up/configuration` と `up/world/...` の形、`web/css/dynmap_style.css` のクラス名が変わっていないか確かめてください。

## もっと縮小できるようにするとき

`main/plugins/dynmap/worlds.txt` のワールドの `extrazoomout` を増やします (main は 7。東西に長く、2 では全体が見えなかった)。

- Dynmap は増えた段のタイルを最初に作らないので、下の段から作って DB に入れる作業が要ります。そのための道具 (縮小タイルを DB に書く手順) は、DB へ書き込むため、このリポジトリから除去しました。必要になったら、タグ `pre-server-removal` から取り出してください (DB につなぐ道具は、このリポジトリに置かない方針です)
- 段が増えると Leaflet のズームの数がずれるので、画面 (`app/lib/viewer.ts` の `LINK_EXTRAZOOMOUT`) は、リンクの `zoom=` と `defaultzoom` を extrazoomout が 2 のときの数として扱います。前に共有されたリンクも同じ縮尺で開き、それより縮小すると `zoom=` は負になります

Dynmap 側の設定 (`main/plugins/dynmap/configuration.txt`):

- `disable-webserver: true`
- `JsonFileClientUpdateComponent` (`InternalClientUpdateComponent` の代わり)
- `url:` で URL を `up/...` と `tiles/...` にしている。タイルが `.webp` の URL のままなので、途中の中継がキャッシュできる

## 開発

```bash
npm ci
npm run build:client
npm run typecheck
npm test
npx nuxt generate
```
