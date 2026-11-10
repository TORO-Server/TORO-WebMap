# TORO-WebMap — 地図の Web を Minecraft サーバーの外で動かす

map.torosaba.net (Dynmap) と 3d-map.torosaba.net (BlueMap) は、Cloudflare Tunnel から `toro-edge:80` (TORO-Server/TORO-Edge (非公開) の README) に来ます。Minecraft サーバーの中の Web サーバーには地図のデータを聞きません。

| コンテナ | 役割 |
| --- | --- |
| `toro-edge` | Dynmap の `css/` と `images/`、BlueMap の `settings.json`、`lang/`、`assets/`、`js/` (`main/bluemap/web/`) をメモリから返す。`toro-webmap` の返事をメモリにためる。経路は TORO-Server/TORO-Edge (非公開) の `sites.go` |
| `toro-webmap` | このディレクトリ。Nuxt のアプリで、map.torosaba.net と 3d-map.torosaba.net の地図の画面と、地図のデータ (TiDB) を返す API。言語は TypeScript |

map.torosaba.net の画面は `app/` です。Dynmap の `web/index.html` (jQuery と Leaflet 1.7) の代わりに、Vue と Leaflet 1.9 で同じものを描きます。見た目は Dynmap の `css/dynmap_style.css` と `images/` をそのまま使い、同じクラス名の要素を作っています。前の画面は比べるために `https://map.torosaba.net/legacy.html` に残してあり、`index.html?worldname=...` のような前のリンクは `/?worldname=...` に転送します。

3d-map.torosaba.net の画面は `app/bluemap/` です。BlueMap 5.29 の webapp (`common/webapp/src`、MIT ライセンス) を TypeScript にしたもので、見た目と動きは元と同じです。`app/app.vue` がホスト名で 2 つの画面を切り替え、開いたほうのコードだけを読み込みます (手元では `?app=bluemap`)。Wiki の背景の撮影 (TORO-Wiki の `scripts/render-background.ts`) が使う `window.bluemap` も元と同じです。

MarumaSign の看板 (画像・動画・音声・ライブ配信・PDF) を 3D の地図に置くのは `app/bluemap/marumasign/` です。前は MarumaSign Companion が `js/marumasign3d.js` を BlueMap の web に書き、`settings.json` の `scripts` に足していました (直すたびに Minecraft のサーバーの再起動が要った)。いまは Companion がそれを足していても読まず (`BlueMapApp.ts` の `isReplacedScript`)、この画面が同じことをします。看板のデータ `marumasign/<地図>.json` は前と同じく Companion が書きます。

地図のデータはすべて TiDB にあります。

- Dynmap: DB `dynmap`。タイル、マーカー、プレイヤーの顔、設定とワールドの更新 (`JsonFileClientUpdateComponent` が 2 秒ごとに書き出す)
- BlueMap: DB `bluemap` (BlueMap 5.x の SQL 保存)。タイル、描いた範囲の記録、テクスチャ、プレイヤーの顔。プレイヤーの位置などのライブ情報だけは BlueMap 内蔵の Web サーバー (`toro-main:8100`) に聞く

## 中身

| ファイル | 中身 |
| --- | --- |
| `app/app.vue` | ホスト名で Dynmap と BlueMap の画面を選ぶ |
| `app/components/DynmapView.vue` | Dynmap の画面。同じ `app/components/` にサイドバー、時計、チャット欄 |
| `app/bluemap/` | BlueMap の画面。`BlueMapView.vue` が元の `main.js` と `index.html` の代わり。型は `app/bluemap/tsconfig.json` で別に確かめる (元が JavaScript なので null の確認までは求めない)。クラスのフィールドは `useDefineForClassFields: false` の前提 (`nuxt.config.ts` の `vite.oxc`) |
| `app/bluemap/marumasign/` | MarumaSign の看板。`overlay.ts` がデータを読んでカメラの近くの看板を出し、種類ごとの描き方 (`renderers/`。`SignRenderer` を実装する) に任せる。画像のほかは、その種類の看板が近くに来たときに初めて読み込む (動画は hls.js・shaka-player・mpegts.js、PDF は pdf.js、3D モデルは three.js の GLTFLoader、ガウシアンスプラッティングは Spark、構造物は Worker で四角形にして描く (下の「構造物」)、珍しい画像の形式は `decoders/`)。計算と判別は `core.ts`、構造物の読み込みと四角形にする処理は `structure/` (どちらも `npm test` で確かめる)。音のボタンは `components/Controls/SignSoundButton.vue`。構造物の古い番号と統合版の表 (`structure/tables/` の legacy と bedrock) は minecraft-data (MIT) から、ブロックの性質の表 (blocks) とブロックエンティティの形 (entity_models) はゲームから、どれも MarumaSign 本体 (MIT) が作ったもの |
| `app/lib/viewer.ts` | 地図の切り替え、ワールドの更新 (2 秒ごと)、プレイヤー、座標とリンクの表示、チャット (Dynmap の `web/js/map.js` などの代わり) |
| `app/lib/tile-layer.ts`, `projection.ts` | HD 地図のタイルの名前と投影 (`web/js/hdmap.js` と同じ計算) |
| `app/lib/markers.ts` | マーカー (`web/js/markers.js` と同じ見た目) |
| `app/lib/gl-marker-layer.ts` | 点のマーカーの絵を WebGL でまとめて描く。マウスを乗せたものだけ元の DOM のマーカーを重ね、名前と吹き出しはそれが出す |
| `app/lib/culled-group.ts` | 名前を常に出す組と、WebGL が使えないとき (`?gl=0` でも) の DOM のマーカー。画面の近くのものだけ作る |
| `server/routes/tiles/[...path].get.ts` | Dynmap の `/tiles/...` (タイル、マーカー、アイコン、プレイヤーの顔) |
| `server/routes/up/configuration.get.ts` | Dynmap の `/up/configuration` |
| `server/routes/up/world/[world]/[ts].get.ts` | Dynmap の `/up/world/<world>/<時刻>` |
| `server/routes/maps/[...path].get.ts` | BlueMap の `/maps/<map>/...` |
| `server/routes/maps/[map]/live/markers.json.get.ts`, `server/utils/dynmap-markers.ts` | BlueMap のマーカー。BlueMap 内蔵の Web サーバーのマーカーに、Dynmap で最初から出している組の点のマーカー (駅や IC など) を足す。中身が空の html マーカーなので 3D の画面には描かず、一覧にだけ出る (選ぶとカメラが動く)。地図とワールドの対応は `nuxt.config.ts` の `bluemap.dynmapWorlds` |
| `server/routes/up/ws.ts`, `server/utils/live.ts`, `server/lib/live-hub.ts` | ブラウザへの WebSocket (`/up/ws`)。Dynmap の更新を DB から 1 秒ごとに 1 度だけ読んで、変わったときに送る (読むのは `dynmap_config.json` にあるワールドだけ)。プレイヤーの位置は dynmap-live から届いたものをすぐ送る。送るのは、Dynmap の更新の `players` で `world` が実在のワールドで、dynmap-live の位置と同じワールドの人だけ (Dynmap は隠す人の `world` を実在しない名前にして送る)。体力と防具も Dynmap が送っているときだけ。どのくらい隠すかは Dynmap の `configuration.txt` の `ClientUpdateComponent` の設定で決まる。1 つのメッセージの大きさの上限は `server/lib/ws-options.ts` |
| `server/routes/live/plugin.ts` | TORO-Core の dynmap-live からの WebSocket (`/live/plugin`)。toro-edge は外に出さず、`NUXT_LIVE_TOKEN` (配備側の env ファイル `webmap.env`) で確かめる |
| `client/dynmap-client.ts` | 前の画面 (`legacy.html`) を軽くするスクリプト。`public/toro/dynmap-client.js` に変換して `/toro/` で返す |
| `client/sw.ts` | 2 つの地図の Service Worker (ホーム画面に追加してアプリのように開ける PWA)。`public/sw.js` に変換して `/sw.js` で返す。ページはいつもネットから読み、つながらないときは `public/pwa/offline.html`。`/_nuxt/` だけキャッシュし、地図のデータはキャッシュしない |
| `server/routes/mcassets/`, `server/utils/mcassets.ts`, `mcassets-build.ts`, `zip.ts` | 構造物の看板を描くための Minecraft のリソースのまとめ (`/mcassets/`)。下の「構造物」。手元で中身と大きさを見るときは `node --experimental-strip-types tools/mcassets.ts <jar>` |
| `public/pwa/` | 地図ごとの manifest (`map.webmanifest`, `3d-map.webmanifest`) とアイコン。アイコンは `node tools/pwa-icons.ts` で作る (TORO のロゴの 2 行目を地図の名前にしたもの) |

新しい画面が前の画面と違うところ (見た目と操作は同じ):

- 点のマーカーは WebGL (GPU) で描き、範囲や線は SVG ではなく Canvas に描く (前の画面はズームのたびに全マーカーの DOM を作り直していた)。
  全体を縮小して 800 個が見えているとき、ズーム 1 段の処理は DOM の 10ms から 4.6ms (うち WebGL 0.9ms) になった
- タイルの URL にページを開いた時刻を付けない (付けると開くたびに URL が変わり、ブラウザにも Cloudflare にもキャッシュが効かない)。描き直したタイルには、届いた時刻を付けて読み直す
- タイルの読み込みを 5 枚ずつに絞らない
- jQuery を使わない
- 更新は WebSocket (`/up/ws`) で届く。全員が 2 秒ごとに取りに来る代わりに、サーバーが変わったときだけ送る。
  プレイヤーは TORO-Core の dynmap-live から 0.25 秒ごとに届く位置へ滑らかに動く。つながらないときは前と同じく 2 秒ごとに取りに行く

Dynmap を更新したときは、`up/configuration` と `up/world/...` の形、`web/css/dynmap_style.css` のクラス名が変わっていないか確かめてください。

## もっと縮小できるようにするとき

`main/plugins/dynmap/worlds.txt` のワールドの `extrazoomout` を増やします (main は 7。東西に長く、2 では全体が見えなかった)。

- Dynmap は増えた段のタイルを最初に作らないので、`tools/dynmap-zoomout.ts` で 1 つ下の段から作って DB に入れます。あとは下の段が変わるたびに Dynmap が作り直します
  ```bash
  node --experimental-strip-types tools/dynmap-zoomout.ts main flat 10   # 最後の数は up/configuration の mapzoomout
  node --experimental-strip-types tools/dynmap-zoomout.ts main surface 12 --check   # 書き込まずに、Dynmap の作ったものと比べるだけ
  ```
  (`sharp` と `mysql2` が要る。サーバーでは `node:22-alpine` のコンテナで動かした)
- 段が増えると Leaflet のズームの数がずれるので、画面 (`app/lib/viewer.ts` の `LINK_EXTRAZOOMOUT`) は、リンクの `zoom=` と `defaultzoom` を extrazoomout が 2 のときの数として扱います。前に共有されたリンクも同じ縮尺で開き、それより縮小すると `zoom=` は負になります

開発するとき (`npm run dev`) は、地図のデータと Dynmap の `css/` `images/` を本番 (map.torosaba.net) から借ります (`nuxt.config.ts` の `$development`)。

Dynmap 側の設定 (`main/plugins/dynmap/configuration.txt`):

- `disable-webserver: true`
- `JsonFileClientUpdateComponent` (`InternalClientUpdateComponent` の代わり)
- `url:` で URL を `up/...` と `tiles/...` にしている。タイルが `.webp` の URL のままなので Cloudflare がキャッシュできる

BlueMap 側の設定 (`main/plugins/BlueMap/`): `maps/overworld.conf` の `storage: "sql"`、`storages/sql.conf` の `connection-url: "jdbc:mysql://tidb:4000/bluemap"`。

## 変えたとき

```bash
# イメージは GitHub Actions が作る (型と試験が通らないとイメージにならない)。
# main に入れる → タグ vX.Y.Z を打つ → docker-compose.yaml の toro-webmap のタグを上げる → 本番で:
docker compose pull toro-webmap && docker compose up -d --no-deps toro-webmap
```

edge のキャッシュは `docker run --rm --network container:toro-edge curlimages/curl -fsS -X POST http://127.0.0.1:8081/purge` で空にできます (TORO-Server/TORO-Edge (非公開) の README)。

`toro-webmap` のコンテナには、ほかのサービスと同じように `mem_limit` を付けます (つなぎっぱなしの WebSocket の数だけメモリが増えるので、ホスト全体のメモリ不足を Minecraft に波及させない)。

手元で試すとき:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

### MarumaSign の看板

- 看板の URL は誰でも書けるので、`overlay.ts` の先頭の決まり (innerHTML を使わない、https だけ、CORS・Cookie なし・Referer なし・転送を追わない、大きさと数の上限) を守る
- 外のサイトの画像や動画は、まずブラウザーが直に読む (CORS、転送は追わない)。読めなければ (CORS がない、転送される) 地図のサーバーに頼む (`fetch.ts`)。assets.torosaba.net は `Origin: https://3d-map.torosaba.net` に CORS を返すので直に読める。assets.torosaba.net の読める人の確かめ (遊んでいるプレイヤーの IP か、地図のページの `Origin` と `Referer`) は、ほかのサイトへの貼り付けの抑止で、非公開にする仕組みではない (`Origin` と `Referer` はブラウザーでないものなら自由に書ける)。看板の資産は公開前提
  - `/_marumasign/resolve?u=` (`server/routes/_marumasign/resolve.get.ts`): 転送 (URL の短縮サービスなど) を追って行き先を教える。行き先が CORS を返せば、ブラウザーは行き先を (同じ決まりで確かめてから) 直に読む
  - `/_marumasign/proxy?u=[&p=]` (`server/routes/_marumasign/proxy.ts`): CORS のないサイトのものを中継する。動画は Range に対応。ライブ配信の再生リストや分割されたファイルも (hls.js・shaka-player・mpegts.js の読み込みは、どれも `fetch.ts` の読み方に差し替えてある。分割されたファイルの転送もブラウザーには追わせない)
  - どちらも、看板データ (`marumasign/<地図>.json`) にいまある URL と、その転送先、それらの再生リスト (HLS, MPEG-DASH) と .gltf に書かれた URL だけを読む (ただの中継にならないように。`server/lib/marumasign/allow.ts`)。看板データは `nuxt.config.ts` の `runtimeConfig.marumasign.signData` から読む (Docker では `http://toro-edge`、Host は `3d-map.torosaba.net`。`NUXT_MARUMASIGN_SIGN_DATA`)
  - 再生リストの中身は外のサーバーが決めるので、主スレッドを止めないよう、外から来たものから正規表現を作らない (`manifest.ts` の `matchPattern`。前から 1 度だけ見る)。XML も前から 1 度だけ読む
  - 再生リストと別のサイト (登録できるドメインが違う) に書かれた URL は、中身の目印がなければ、分割ファイルらしい拡張子のものは 16 MiB まで、それ以外は 4 KiB (暗号化の鍵など) までしか中継しない。看板に書ける画像や動画などの種類は、これまでどおり
  - https だけ。転送の行き先ごとに名前を引いたアドレスを確かめ、手元・家の中・Docker のネットワーク・共有アドレス (CGNAT)・リンクローカル・マルチキャスト・IPv6 の固有ローカルなどにはつながない (`server/lib/marumasign/net.ts`。つなぐときの名前引きで確かめるので、確かめた後にすり替えられない)
  - 返すのは先頭のバイト列で分かった種類 (画像・動画・音声・PDF・3D のもの・再生リスト) だけで、大きさは種類ごとに MarumaSign 本体と同じ上限。HTML は返さない。返すものは `Content-Security-Policy: sandbox`、`nosniff`、`Content-Disposition: attachment`、決まった Content-Type で、このサイトのページとして開けない (`server/lib/marumasign/kinds.ts`)
  - 地図のページからだけ (`Sec-Fetch-Site`、`Origin`。ブラウザーでないものは避けられるので、貼り付けの抑止にとどまる)。1 つの IP (`CF-Connecting-IP`。IPv6 は /64 ごと) から 10 分あたりの数と量、全体の 10 分あたりの量、同時に読む数に上限
  - toro-edge は `/_marumasign/` を toro-webmap に送り、そこではためない (`streamHandler`)
- ブラウザーが再生できない動画・音声の入れ物 (AVI, WMV/ASF, MPEG-1/2 の PS, 3GP, Ogg Theora, RealMedia, AIFF, AMR, AC-3 など。MarumaSign 本体は FFmpeg で再生する) は、FFmpeg の WebAssembly 版 (`@ffmpeg/core` の 1 スレッドの版、GPL-2.0-or-later。`sources/ffmpeg.ts`) で再生できる MP4 にする。そうした看板が来たときに初めて約 31 MB を読む。変換は 1 つずつ、1 回 90 秒まで、映像を作り直すときは最初の 60 秒を幅 640 まで。MPEG-TS と FLV のファイルは mpegts.js で再生する
- 画像の形式は MarumaSign 本体と同じものを読む。ブラウザーが読めないものは `decoders/` (その形式の看板が近くに来たときに初めて読み込む):
  - TIFF・BigTIFF (`tiff.ts`。本体の TiffDecoder と同じ。Zstandard は fzstd、TIFF の中の JPEG は jpeg-js。読めなければ three.js の UTIF でも試す)
  - DDS と KTX2 の BC1 - BC7 (`dds.ts`, `bcn.ts`)。GPU が対応していれば圧縮のまま、対応していなければ (スマートフォンの多く) CPU で RGBA にする。`bcn.ts` の `decodeBc` と `dds.ts` の `decodeDdsPixels` は 3D モデルのテクスチャにも使える
  - DPX・IFF (ILBM・PBM・ACBM、HAM・EHB)・XWD・PGX (`extra.ts`)。本体は FFmpeg で読むので、見え方は FFmpeg に合わせた
  - JPEG 2000 (`jp2.ts`, `codecs.ts`)。PDF の看板と同じ pdf.js の OpenJPEG (wasm) で、絵を 1 枚だけ置いた PDF にして描く。relaxed SIMD の wasm を読めないブラウザー (Safari など) では、pdf.js の wasm を使わない版を直接呼ぶ
  - HEIC・HEIF (`heif.ts`, `codecs.ts`)。Safari はそのまま読む。ほかは箱 (格子・透明度・回転・切り抜き) を自前で読み、HEVC と AV1 をブラウザーの WebCodecs で展開する。AV1 の HEIF は、ブランドを AVIF にしてブラウザーに読ませる。WebCodecs が HEVC を展開できない (Firefox、GPU が対応していない Chrome、Linux) か、透明度の白黒の HEVC を展開できないときは、libheif-js (LGPL-3.0、下の「外のもの」) で読む
  - JPEG XL (`codecs.ts`。ブラウザーが読めなければ jxl-oxide の wasm)
  - ImageDecoder のないブラウザーでの、アニメーションの WebP (`webp.ts`, `animation.ts`。コマごとに WebP に包み直して読み、重ねる)
  - 試験の材料 (`tests/fixtures/images/`) の期待する結果は、本体の Java のデコーダ (TIFF・DDS) と FFmpeg (DPX・XWD・IFF・PGX) が出したもの
- 3d-map.torosaba.net の CSP に `media-src 'self' https: blob:` が要る (動画・音声・ライブ配信。ライブ配信は MediaSource の `blob:` で再生する)
- Wiki の背景の撮影で、看板ごとの見える距離 (大きさから決まる) を使わずに `drawDistance` まで描くときは、データの JSON に `"fullDrawDistance": true` を足す。カメラを動かしたあとは `window.marumasign3d.update()`、読み込みが落ち着いたかは `window.marumasign3d.stats()` の `loading` と `queued`
- 3D モデルの陰影は MarumaSign 本体 (`GltfLight.java`) と同じ式で、材質のシェーダーの中で計算する (`model-shading.ts`。three.js の光源は使わない)。
  モデルに固定の空・太陽・映り込みと、モデルの中の光源 (`KHR_lights_punctual`) は、そのモデルだけを照らす。
  three.js にない拡張 (`KHR_animation_pointer`、`EXT_lights_image_based`、`KHR_materials_diffuse_transmission`、`KHR_node_visibility` など) は `model-ext.ts`、
  DDS (`MSFT_texture_dds`、BC1 - BC7) は `model-dds.ts` (GPU が描けない形式は `decoders/bcn.ts` で CPU で展開する)
- 3D のもの (3D モデル・ガウシアンスプラッティング・構造物) の大きさと数の上限は MarumaSign 本体と同じ (三角形 15 万枚、分布 15 万個、四角形 15 万枚。超える構造物はまとめて粗くする)。そのうえで、読んでおく量と同時に置く数にも上限がある (`renderers/model.ts` などの先頭)
- ガウシアンスプラッティング (`renderers/splat.ts`、`splat-file.ts`) の座標の向き: .ply .splat .ksplat .sog は撮影の座標 (+Y が下) として半回転させる (本体と同じ)。.spz は仕様では +Y が上 (RUB) だが、splat-transform 3.x や Spark など変換せずに .ply の座標のまま書く道具が多く、ファイルにも書かれない。そこで、バージョン 4 の拡張 `SPZ_ADOBE_coordinate_system` があればそれに従い、なければ中身 (水平な面がどちらの端にあるか) から推定し、分からなければ仕様どおり RUB とする。看板の URL に `#coord=RDF` のように書けば、どの形式でも座標を指定できる。zip にしていない .sog は、meta.json (かフォルダ) の URL を書けば、WebP を同じ決まりで集めて読む。文字とビッグエンディアンの .ply、球面調和関数が 4 次の .spz は、Spark が読める形に書き直して読む
- 前のスクリプトと見比べるときは、`npm run dev` で `?app=bluemap&marumasign=legacy` を開く (前のスクリプトだけが動く)

### 構造物

構造物の看板 (.schem .litematic .nbt .mcstructure .schematic) は、MarumaSign 本体と同じく Minecraft のクライアントの jar (本体と同じ 26.3) のブロックのモデルとテクスチャで描きます。本体の `core/.../structure/` (StructureMesher、BlockModels、SpecialModels、Entities など) を `structure/` に TypeScript で移したもので、同じ構造物から本体と同じ四角形 (位置・UV・色) ができることを、本体のクラスで書き出したものと突き合わせて確かめています。

- 形: blockstates (variants / multipart) と models (継承、要素の回転と拡大、uvlock、cullface、tintindex)。階段の角や柵のつながりは、ファイルに書かれたもの (1.12 までの形式と統合版は、本体と同じくまわりから計算する)。不透明・切り抜き・半透明は、テクスチャの透明度で決める
- 明るさ: なめらかな明るさ (環境光の遮蔽) と面の向きの明るさ。本体と同じく、昼の屋外 (ブロックの光は使わない)。チェストなどは、ゲームがエンティティを描くときの 2 つの光の向き
- 色: 草・葉・水の色は、構造物のファイルに書かれたバイオーム (Sponge Schematic 2 / 3。まわり 5 x 5 の平均)。書かれていなければ平原 (本体と同じ。看板のある場所のバイオームは使わない)
- 動くテクスチャ (水、溶岩、火、シーランタンなど): .mcmeta の通り 1 秒に 20 回進める (interpolate も)。画面に入っているときだけ
- 遠くでちらつかないように、ゲームと同じく 4 段のミップマップを、テクスチャごとに縮めて作る (ゲームの MipmapGenerator と同じ混ぜ方。切り抜きの形を保つ)。まとめた画像の中でテクスチャを 16 ピクセルごとの位置にそろえ、まわりに端の色の余白を置くので、隣のテクスチャと混ざらない。近くはピクセルのまま (NEAREST_MIPMAP_LINEAR)
- ブロックエンティティ: チェスト (1 つ・2 つ、トラップ、エンダー、銅)、シュルカーボックス、旗 (模様)、看板と吊り看板の文字 (表と裏、色、光る文字。jar のフォントにない文字は Unifont)、頭 (プレイヤーの頭はスキン)、飾り壺 (陶片)、鐘、書見台の本、コンジット、エンチャント台の本、エンドポータル、銅のゴーレムの像、動いているピストン
- エンティティ: 絵画、額縁と輝く額縁 (中のアイテムも。アイテムの定義とモデルで描く)、防具立て (姿勢と装備)、ブロック・アイテム・文字のディスプレイ
- 構造物の中の MarumaSign の看板: 画像・PDF・3D モデル・構造物を、ほかの看板と同じ描き方 (`renderers/`) で、構造物の中に置く。本体と同じく、深さは 2 段まで (同じ URL はたどらない)、1 つの構造物で 16 個まで、20 秒で描けないものと面が 3 万を超えるものはやめる。動画・音声・ガウシアンスプラッティングは描かない (板は消える)
- プレイヤーの頭のスキンは、`https://textures.minecraft.net/texture/<hash>` の画像だけを、ブラウザーが Cookie・Referer なしで読む (このサーバーは CORS を返す)。名前や UUID しか書かれていないものは、このサーバーの `/mcassets/skin?name=` / `?uuid=` に聞く。サーバーは形を確かめた名前か UUID で、決まったホスト (名前 → UUID は api.mojang.com、だめなら api.minecraftservices.com。UUID → textures は sessionserver.mojang.com) だけに問い合わせ、スキンの URL と腕のモデルだけを返す (分かったものは 1 時間、分からなかったものと失敗は 10 分覚える。4096 件まで。1 つの IP から 10 分に 600 回、そのうち問い合わせは 60 回まで (CF-Connecting-IP)。同時に 4 つ、待たせるのは 64 まで。5 秒で時間切れ、Cookie なし、転送は追わない)。分からなければ Steve

リソースは、TORO-WebMap が起動したときに jar から作ってメモリに持ち (1 秒ほど)、`/mcassets/<hash>/` で返します (`assets.json` = blockstates, models, アイテムの定義、バイオームの色など、`textures.bin` = 使うテクスチャの PNG を並べたもの、`unifont/<ページ>.txt`)。URL に版が入るので、ブラウザーも Cloudflare もいつまでも持ってよく、`/mcassets/index.json` (5 分) がいまの版を返します。Mojang のファイルは git にも Docker のイメージにも入れず、jar は読むだけでマウントします。BlueMap のリソースパック (`main/plugins/BlueMap/packs`) もマウントすれば、名前の順に上書きします (本体は使わないので、同じ見た目にするならマウントしない)。Unifont は jar になく、初めてのときに Mojang の配布元から hash を確かめて 1 度だけ読み、`NUXT_MCASSETS_CACHE` に置きます。

```yaml
  toro-webmap:
    volumes:
      - "./main/bluemap:/srv/bluemap-data:ro"         # BlueMap がダウンロードする minecraft-client-<版>.jar のフォルダ
      - "./webmap-cache:/var/cache/webmap"          # Unifont (なくても動く。毎回読み直すだけ)
    environment:
      - NUXT_MCASSETS_JAR=/srv/bluemap-data         # フォルダなら最も新しい版の jar を使う (Minecraft を更新しても変えなくてよい。jar の場所を直接書いてもよい)
      - NUXT_MCASSETS_CACHE=/var/cache/webmap
      # - NUXT_MCASSETS_PACKS=/srv/minecraft/packs    # BlueMap のリソースパックも使うとき (上に ./main/plugins/BlueMap/packs:/srv/minecraft/packs:ro も)
```

toro-edge (3d-map.torosaba.net の経路) には `/mcassets/` (`/mcassets/skin` も) を toro-webmap に渡す規則が要ります (TORO-Server/TORO-Edge (非公開) の `sites.go`) (中身は Cache-Control のとおり持ってよい)。新しい jar が増えたら、10 分ごとの確かめで作り直します。jar がないとき (`/mcassets/index.json` が 503) は、前と同じ簡単にした形を地図のテクスチャで描きます (`structure/mesher.ts`)。

## 外のもの (サードパーティ)

看板の画像・動画の形式のために使っているもの。どれも、その形式の看板が近くに来たときに初めて、別のファイル (`/_nuxt/` の js と wasm) として読み込む。

| 名前 | 版 | ライセンス | 元 | 使い方 |
| --- | --- | --- | --- | --- |
| @ffmpeg/core (1 スレッドの版) | 0.12.10 | GPL-2.0-or-later | https://github.com/ffmpegwasm/ffmpeg.wasm (FFmpeg https://ffmpeg.org/、x264、x265 などを含む) | ブラウザーが再生できない動画・音声を MP4 にする。`ffmpeg-core.js` と `ffmpeg-core.wasm` はそのまま別のファイルとして置き、`sources/ffmpeg-worker.ts` (自前の Worker) から呼ぶ。ソースは元のリポジトリの v0.12.10 のタグ |
| libheif-js | 1.23.5 | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js | HEIC を WebCodecs で読めないとき。中の libheif 1.23 (LGPL-3.0, https://github.com/strukturag/libheif) と libde265 (LGPL-3.0, https://github.com/strukturag/libde265) を含む。`libheif-wasm/libheif.js` と `libheif.wasm` のソースには手を加えず、ほかのコードと別のファイルとして使う (置き換えられる)。wasm はそのままのバイト列を `/_nuxt/libheif.<hash>.wasm` に置く。js はビルドで ES モジュールに包んで縮めるだけ (処理は同じ。`/_nuxt/` の別の chunk になる)。wasm は `decoders/codecs.ts` が取ってきてコンパイルし、Emscripten の `instantiateWasm` で渡す。ライセンスの全文は npm のパッケージの `LICENSE` と `libheif-wasm/LICENSE` |
| jxl-oxide-wasm | 0.12.6 | MIT または Apache-2.0 | https://github.com/tirr-c/jxl-oxide | JPEG XL をブラウザーが読めないとき |
| fzstd | 0.1.1 | MIT | https://github.com/101arrowz/fzstd | TIFF の Zstandard |
| jpeg-js | 0.4.4 | BSD-3-Clause | https://github.com/eugeneware/jpeg-js | TIFF の中の JPEG |
| pdfjs-dist の OpenJPEG | 6.4.299 | Apache-2.0 (pdf.js)、BSD-2-Clause (OpenJPEG) | https://github.com/mozilla/pdf.js | JPEG 2000 (PDF の看板と同じもの。wasm と、wasm を使わない版 `openjpeg_nowasm_fallback.js`) |
| bcdec (書き直したもの) | — | MIT (Copyright (c) 2022 Sergii Kudlai) | https://github.com/iOrange/bcdec | `decoders/bcn.ts` の BC6H と BC7 (MarumaSign 本体の Bptc.java と同じ) |
