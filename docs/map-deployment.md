# 地図の静的な画面と API の分け方 (正本)

この文書が、Dynmap の画面を「静的な画面」と「API」に分ける仕組みの、ただ 1 つの説明です。公開するパス、API の基点、ビルドと公開の流れはここだけに書き、ほかの文書には写さず、ここを指します。サービス全体の構成と運用の手順は、[ServerImage-TORO の docs/architecture.md](https://github.com/TORO-Server/ServerImage-TORO/blob/main/docs/architecture.md) と [docs/RUNBOOK.md](https://github.com/TORO-Server/ServerImage-TORO/blob/main/docs/RUNBOOK.md) が正本です。ここには、ホスト名、内部のポート、中継サービスの設定は書きません。

## 分け方

- 静的な画面: `index.html`、`_nuxt/`、`sw.js`、`pwa/`、`images/`、`css/`。すべて `public/` と `app/` から機械で作ります (`nuxt generate`)。出力はコミットしません。静的なファイルの置き場 (GitHub Pages) から配ります。
- API: 設定、ワールドの更新、WebSocket、タイル、マーカー、プレイヤーの顔。TiDB を読みます。実装は `server/utils/dynmap-api.ts` の 1 か所です。
- BlueMap の画面は、この分け方の対象外です。従来どおり、このアプリが返します。
- `/live/plugin` と `/live/clients` は内部専用 (共有の合言葉で守ります) で、API の公開側には出しません。

## API の公開するパス

API は `/map/v1/` の下で、次の 4 種類だけを返します。

| パス | 備考 |
| --- | --- |
| `/map/v1/configuration` | |
| `/map/v1/world/{world}/{ts}` | |
| `/map/v1/ws` (WebSocket) | |
| `/map/v1/tiles/...` | タイル、マーカー (`_markers_/`)、プレイヤーの顔 (`faces/`) |

BlueMap の画面は、ライブ情報のために `/up/ws` (WebSocket) を、同じ接続先へ読みに行きます (`app/bluemap/js/BlueMapApp.ts`)。この経路は撤去しません。

`Cache-Control` と `Access-Control-Allow-Origin: *` は `server/utils/http.ts` が付けます。

## API の基点 (apiBase)

- 正本は `nuxt.config.ts` の `runtimeConfig.public.apiBase` です。
- 画面は `app/lib/api.ts` の `apiUrl(path)` と `wsUrl()` だけで API に触ります。ほかの場所に URL を書きません。
- ビルド時に差し替えるときは `NUXT_PUBLIC_API_BASE` を使います (自動処理では置き場の変数 `API_BASE`。秘密ではありません)。

## ビルドと公開

- `.github/workflows/pages.yml`: `main` への反映と手動実行で、`npm ci` → `npm run build:client` → `nuxt generate` → 静的な置き場へ公開します。
- API 側のイメージは `.github/workflows/image.yml` が作ります。
- 画面だけを変えたときは `main` へ反映するだけです。API を変えたときの本番への反映と戻し方は、ServerImage-TORO の RUNBOOK に従います。
