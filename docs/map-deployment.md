# map.torosaba.net の静的/API 分離 (正本)

この文書が、地図 (Dynmap の画面) の静的/API 分離の唯一の説明です。対応表・基点・公開の流れ・戻し方はここだけに書きます。

## 構成

```
ブラウザ ─ https://map.torosaba.net/        静的な画面 (GitHub Pages。nuxt generate の出力)
        └ https://api.torosaba.net/map/v1/*  API (既存の toro-webmap。toro-edge 経由)
```

- 静的 (Pages): `index.html`, `_nuxt/`, `sw.js`, `pwa/`, `images/`, `css/` (すべて `public/` と `app/` から機械生成。出力はコミットしない)。
- API (toro-webmap): 設定、ワールドの更新、WebSocket、タイル/マーカー/顔。TiDB を読む。実装は `server/utils/dynmap-api.ts` の 1 か所で、旧パスと新パスのルートファイルが同じ値を `export default` する。
- 3d-map.torosaba.net (BlueMap) はこの分離の対象外。従来どおり toro-edge から配信する (Pages はリポジトリごとにカスタムドメイン 1 つ)。
- `/live/plugin`, `/live/clients` は内部専用。api には出さない。

## パスの対応

| 旧パス (map.torosaba.net) | 新パス (api.torosaba.net) |
| --- | --- |
| `/up/configuration` | `/map/v1/configuration` |
| `/up/world/{world}/{ts}` | `/map/v1/world/{world}/{ts}` |
| `/up/ws` (WebSocket) | `/map/v1/ws` |
| `/tiles/{world}/{prefix}/{x_y}/{zoom_x_y}.{ext}` | `/map/v1/tiles/{world}/{prefix}/{x_y}/{zoom_x_y}.{ext}` |
| `/tiles/_markers_/marker_{world}.json` | `/map/v1/tiles/_markers_/marker_{world}.json` |
| `/tiles/_markers_/{icon}.png` | `/map/v1/tiles/_markers_/{icon}.png` |
| `/tiles/faces/{type}/{name}.png` | `/map/v1/tiles/faces/{type}/{name}.png` |
| `/images/*`, `/css/*` | 静的 (Pages) の `/images/*`, `/css/*`。正本は `public/images/`, `public/css/` |

旧パスは移行が済むまで toro-webmap に残す。Cache-Control と CORS (`Access-Control-Allow-Origin: *`) は旧パスと同じ (同じハンドラ)。

## API の基点 (apiBase)

- 正本は `nuxt.config.ts` の `runtimeConfig.public.apiBase` (既定 `https://api.torosaba.net/map/v1`)。
- 画面は `app/lib/api.ts` の `apiUrl(path)` と `wsUrl()` だけで API に触る。ほかの場所に URL を書かない。
- ビルド時に差し替えるときは `NUXT_PUBLIC_API_BASE` (CI ではリポジトリの変数 `API_BASE`。secret ではない)。

## ビルドと公開

- `.github/workflows/pages.yml`: main への push と手動実行で `npm ci` → `npm run build:client` → `nuxt generate` → Pages に配備。
- カスタムドメイン `map.torosaba.net` はリポジトリの Settings > Pages で設定する。Actions による配備では `public/CNAME` は使われない。
- API 側 (toro-webmap) のイメージは従来どおり `image.yml` が作る。
- Pages は全ファイルに `Cache-Control: max-age=600` を付ける。画面の更新が反映されるまで最大 10 分かかる。

## 本番に反映する手順

1. toro-webmap のイメージを新しい版にして再作成 (`/map/v1/*` が加わる。旧パスは残る)。運営の再起動窓に従う。
2. toro-edge の新しい版 (api ホストの `/map/v1/*` を toro-webmap へ通すルール入り) に更新。
3. Cloudflare Tunnel の `api.torosaba.net` に、パス `/map/*` → toro-edge のルールを足す (ほかのパスは toro-api のまま)。不可なら TORO-API を中継にする案へ切り替える (その場合は別途設計)。
4. 確認 (GET のみ): `https://api.torosaba.net/map/v1/configuration` が 200 で `Access-Control-Allow-Origin` を返す。
5. 新しい画面を Pages に配備 (main へマージ)。Settings > Pages で Source = GitHub Actions、カスタムドメイン `map.torosaba.net`、ドメイン検証。
6. DNS: `map.torosaba.net` を `CNAME toro-server.github.io` (DNS のみ) に切り替え、HTTPS の強制を有効にする。証明書の発行が終わるまで待つ。
7. 安定したら、map ホストの旧ルート (`/up`, `/tiles`) を撤去する。

## 戻し方

- DNS の `map.torosaba.net` を切り替え前のレコードに戻す。旧ルートを撤去するまでは、これだけで元に戻る。
- 切り替える前に、現行のレコードの種類と値を記録しておく。
