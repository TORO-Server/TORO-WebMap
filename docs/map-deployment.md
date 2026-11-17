# 地図の静的な画面と API の分け方 (正本)

この文書が、Dynmap の画面を「静的な画面」と「API」に分ける仕組みの、ただ 1 つの説明です。公開するパス、API の基点、データの流れ、入り口の振り分け、切り戻しの手順、許容している違いはここだけに書き、ほかの文書には写さず、ここを指します。ここには、ホスト名、内部の番号 (ポート)、秘密の値は書きません。

用語: 「API」は、画面が地図のデータを頼むためのコネクタです。「データベース」は、Dynmap がタイルやマーカーを保存している場所 (TiDB) です。「WebSocket」は、画面とサーバーが常時つながったまま、更新をすぐ届け合う通信です。

## 分け方

- 静的な画面: `index.html`、`_nuxt/`、`sw.js`、`pwa/`、`images/`、`css/`。すべて `public/` と `app/` から機械で作ります (`nuxt generate`)。出力はコミットしません。静的なファイルの置き場 (GitHub Pages) から配ります。
- API: 設定、ワールドの更新、WebSocket、タイル、マーカー、プレイヤーの顔。**すべて TORO-API が返します。** データベースとのやり取りも TORO-API だけが担います。
- 3D 地図 (BlueMap) の画面は、この分け方とは別に、リポジトリ [TORO-3D-WebMap](https://github.com/TORO-Server/TORO-3D-WebMap) の静的なサイトになりました。公開のホスト名は `3d-map.torosaba.net` で、`3d.torosaba.net` は存在しません。構成の正本はそちらの docs/deployment.md です (写しは作りません)。このアプリのサーバー側の 3D 部分は、TORO-API へ移すまで、従来の 3D 地図の動的な部分として残します。
- `/live/plugin` と `/live/clients` は内部専用 (共有の合言葉で守ります) で、API の公開側には出しません。

## データの流れ

- データの唯一の情報元は、Dynmap のデータベースです。Dynmap が書き込みます。
- そのデータベースを読むのは TORO-API だけです。読み取りしかできない専用の利用者 (権限は `dynmap` の読み取りのみ) で接続します。このアプリは、通常のときは Dynmap のデータベースを読みません (3D 地図の動的な部分が BlueMap のデータベースを読むのは、この文書の対象外です)。
- 設定、ワールドの更新、タイル、マーカー、プレイヤーの顔は、TORO-API が読んだデータベースの内容をそのまま返します。
- プレイヤーの位置は、Minecraft サーバーの TORO-Core の `dynmap-live` が、TORO-API の内部専用の受け口 (`/live/plugin`) へ送ります。TORO-API は、これと Dynmap の更新を合わせて、`/map/v1/ws` (WebSocket) で画面へ流します。内部専用の受け口は、公開の受け口とは別の番号で待ち受け、公開の入り口 (Tunnel) の対象に入れません。公開側では `/live/*` は 404 です。
- 送信側 (`dynmap-live`) の設定は、`main/plugins/TORO-Core/dynmap-live/config.yml` の `endpoint` (送り先) と `token` (共有の合言葉。TORO-API の `MAP_LIVE_TOKEN` と同じ値) です。

## 入り口の振り分け (toro-edge)

公開の入り口 (toro-edge。自前のリバースプロキシで、リクエストを中の各サービスへ振り分けます) は、API 用のホストの `/map/v1/` を、環境変数 `EDGE_API_BACKEND` で決めた送り先へ渡します。

- `EDGE_API_BACKEND` を設定すると (`ホスト名:番号` の形)、`/map/v1/` の通常の通信 (設定、ワールド、タイル) と WebSocket が、その送り先へ行きます。本番では TORO-API に設定しています。
- **未設定のときの既定値は、従来の送り先 (toro-webmap、環境変数 `EDGE_MAPWEB` の値) です。** つまり、変数を取り除くだけで従来の動きに戻ります。
- 地図の画面のサイトと 3D 地図のサイトの送り先は、この変数では変わりません。
- toro-edge は 1.4.0 以降でこの変数に対応しています。

## API の公開するパス

API は `/map/v1/` の下で、次の 4 種類だけを返します。

| パス | 備考 |
| --- | --- |
| `/map/v1/configuration` | |
| `/map/v1/world/{world}/{ts}` | |
| `/map/v1/ws` (WebSocket) | |
| `/map/v1/tiles/...` | タイル、マーカー (`_markers_/`)、プレイヤーの顔 (`faces/`) |

これ以外のパスは 404 です (本文は JSON)。従来の 3D 地図の画面は、ライブ情報のために `/up/ws` (WebSocket) を読みに来ます。この経路は、新しい 3D 地図へ切り替わり、TORO-API へ移るまで撤去しません。

`Cache-Control` と `Access-Control-Allow-Origin: *` は TORO-API が付けます。

## API の基点 (apiBase)

- 正本は `nuxt.config.ts` の `runtimeConfig.public.apiBase` です。
- 画面は `app/lib/api.ts` の `apiUrl(path)` と `wsUrl()` だけで API に触ります。ほかの場所に URL を書きません。
- ビルド時に差し替えるときは `NUXT_PUBLIC_API_BASE` を使います (自動処理では置き場の変数 `API_BASE`。秘密ではありません)。

## ビルドと公開

- `.github/workflows/pages.yml`: `main` への反映と手動実行で、`npm ci` → `npm run build:client` → `nuxt generate` → 静的な置き場へ公開します。
- このアプリのサーバー側のイメージ (動かすための一式) は `.github/workflows/image.yml` が作ります。地図の API の実装とイメージは TORO-API のリポジトリにあります。
- 画面だけを変えたときは `main` へ反映するだけです。
- このリポジトリに残っている従来の API の実装 (`server/utils/dynmap-api.ts` など) は、切り戻しの送り先として、当面そのまま残します。

## 切り戻し手順

切り替えた後に重大な食い違いが出たときは、次の順に戻します。Minecraft サーバー本体は再起動しません。

1. toro-edge の設定から `EDGE_API_BACKEND` を取り除き、toro-edge だけを作り直します (`docker compose up -d --no-deps toro-edge`)。ほかのサービスは作り直しません。
2. `dynmap-live` の `endpoint` を従来の送り先 (toro-webmap の `/live/plugin`) に戻し、`/torocore reload dynmap-live` で再読み込みします。
3. 確認: 公開の `/map/v1/configuration` が従来の応答 (200) に戻ること。存在しないワールドの 404 の本文が、JSON から従来の HTML に戻ることでも、従来の送り先に戻ったと判別できます。位置情報 (WebSocket の `players`) が流れることも確かめます。

## 許容している違い

従来の送り先 (toro-webmap) と TORO-API の応答には、次の違いがあります。いずれも地図の画面の動作には影響しないため、許容しています。

従来から許容しているもの:

1. 存在しないワールドの 404 の本文: 従来は Nitro (従来のサーバーの枠組み) のエラー画面の HTML、いまは `{"error":"Not Found"}` (JSON) です。
2. `X-Content-Type-Options: nosniff` を付けています。ブラウザに、中身の種類を勝手に推測させないための指定です。
3. タイルのファイルの更新を確かめる印 (ETag) は、従来と同じ `"0"` のままです。

切り替えの前の比較で見つかり、後から許容したもの (#1〜#5):

| # | 内容 | 従来の送り先 | TORO-API | 公開側での見え方 |
| --- | --- | --- | --- | --- |
| 1 | `GET /map/v1/tiles/` (末尾のスラッシュだけ) | 画面の HTML を 200 で返す | 404 (JSON) | 見える。意味のない応答が 404 になるだけで、画面は使いません |
| 2 | 定義のないパス (`/map/v1`、`/map/v1/foo`、`/map/v1/world/main` など) | 画面の HTML を 200 で返す | 404 (JSON) | 見えない (入り口が先に 404 を返します) |
| 3 | `GET`・`HEAD` 以外のメソッド (`POST`、`PUT`、`DELETE`、`PATCH`、`OPTIONS`) | 画面の HTML を 200 で返す | 405 (`Allow: GET, HEAD`) | 見えない (入り口が先に 405 を返します) |
| 4 | `HEAD` (ワールド、タイル) | 画面の HTML の見出しを返す | 正しい種類と ETag などを返す (こちらが正しい) | 見えない (入り口が処理します) |
| 5 | 入り口に規則のないパス (`/`、`/healthz`、`/live/*`) と、WebSocket の接続要求 | 従来の別の応答 | JSON の 404 や 200 (`/live/*` は 404) | 見えない (入り口に規則がなく、`/live/*` は公開で 404。WebSocket は入り口が処理します) |

根拠: #1 は、従来の送り先が「定義のないパスにも画面の HTML を返す」作り (Nuxt の catch-all) から来る応答で、地図の API の仕様ではありません。API の名前空間で定義のないパスが JSON の 404 を返すのが正しい動きです。#2〜#5 は、公開側では入り口が先に処理するため、利用者からは見えないことを実測で確かめました。

## 判断の変更の経緯

当初は、TORO-API に「データベースを持たせない」ことを原則にしていました。また、TORO-API にもデータベースを読ませる案は採りませんでした。理由は、Dynmap のデータベースの知識 (表の構造や読み方) が、TORO-WebMap と TORO-API の 2 か所に分かれてしまうからです。

今回の判断では、この前提が変わりました。

- 不採用の理由は、TORO-API に読み取りを「追加」して、このアプリも読み続ける場合に成り立つものです。いまは、API を TORO-API へ「移す」ので、データベースを読むのは TORO-API だけになります。知識は 1 か所に集まり、理由は成り立ちません。
- TORO-API の「データベースを持たない」原則は、TORO-API の役割が「地図の API を担う」ことに変わったため、解消しました。読み取り専用の利用者に限る、という決まりに置き換えています。
- 位置情報の受け口 (`/live/plugin`) も、データベース由来の表示対象と合わせて配るために、WebSocket と同じ TORO-API に置きます。
