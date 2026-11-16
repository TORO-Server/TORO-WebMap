# map.torosaba.net の静的/API 分離 (正本)

この文書が、地図 (Dynmap の画面) の静的/API 分離の運用の唯一の説明です。公開するパス・基点・どこで何を管理するか・公開の流れ・戻し方はここだけに書きます (ほかのリポジトリや作業記録には写さず、ここを指す)。

## 構成

```
ブラウザ ─ https://map.torosaba.net/          静的な画面 (GitHub Pages。nuxt generate の出力)
        └ https://api.torosaba.net/map/v1/*    API (toro-webmap。Cloudflare Tunnel → toro-edge → toro-webmap)
3d-map.torosaba.net (BlueMap) は分離の対象外。従来どおり Tunnel → toro-edge から配信する
```

- 静的 (Pages): `index.html`, `_nuxt/`, `sw.js`, `pwa/`, `images/`, `css/` (すべて `public/` と `app/` から機械生成。出力はコミットしない)。
- API (toro-webmap): 設定、ワールドの更新、WebSocket、タイル/マーカー/顔。TiDB を読む。実装は `server/utils/dynmap-api.ts` の 1 か所。
- `/live/plugin`, `/live/clients` は内部専用 (共有の合言葉)。api には出さない (toro-edge の api の規則が `/map/v1/` の下の 4 種類のほかを 404 にする)。

## 公開するパス

| 場所 | パス | 備考 |
| --- | --- | --- |
| api.torosaba.net | `/map/v1/configuration` | |
| | `/map/v1/world/{world}/{ts}` | |
| | `/map/v1/ws` (WebSocket) | |
| | `/map/v1/tiles/{world}/{prefix}/{x_y}/{zoom_x_y}.{ext}`, `/map/v1/tiles/_markers_/marker_{world}.json`, `/map/v1/tiles/_markers_/{icon}.png`, `/map/v1/tiles/faces/{type}/{name}.png` | |
| 3d-map.torosaba.net | `/up/ws` (WebSocket) | BlueMap の画面のライブ情報。同じオリジンへつなぐ (`app/bluemap/js/BlueMapApp.ts`)。**撤去しない** |
| map.torosaba.net (Pages) | `/images/*`, `/css/*` ほか静的ファイルのみ | 正本は `public/` |

`Cache-Control` と `Access-Control-Allow-Origin: *` は `server/utils/http.ts` が付け、toro-edge はそのまま返す。

旧パス (`/up/configuration`, `/up/world/*`, `/tiles/*`) は toro-webmap から撤去した (map ホストは Pages に移り、api ホストにも出ていない)。toro-edge の map ホスト向けの規則 (`sites.go` の mapRules) は DNS が Pages に移ったので使われない。撤去は TORO-Edge 側の課題。

## API の基点 (apiBase)

- 正本は `nuxt.config.ts` の `runtimeConfig.public.apiBase`。
- 画面は `app/lib/api.ts` の `apiUrl(path)` と `wsUrl()` だけで API に触る。ほかの場所に URL を書かない。
- ビルド時に差し替えるときは `NUXT_PUBLIC_API_BASE` (CI ではリポジトリの変数 `API_BASE`。secret ではない)。

## どこで何を管理するか

| 対象 | 正本 | 管理の方法 |
| --- | --- | --- |
| 静的な画面 | このリポジトリの `app/` `public/` | `pages.yml` が配備 |
| Pages の設定 (カスタムドメイン `map.torosaba.net`、HTTPS の強制) | GitHub の Settings > Pages | 手作業 (Actions の配備では `public/CNAME` は使われない) |
| DNS (`map` は `CNAME toro-server.github.io`、DNS のみ。`api` は Tunnel) | TORO-Domain の `main.tf` | Terraform (PR → apply) |
| Tunnel の公開ルール | Cloudflare ダッシュボード (Zero Trust > Networks > Tunnels の `torosaba.net` > 公開アプリケーション) | **手作業 (この 1 か所が例外)**。Tunnel は設定をダッシュボードで持つ方式 (cloudflared は `tunnel run` のトークン起動) で、Terraform の対象外。ホスト名ごとの規則はすべて同じ扱い |
| イメージの版 (タグとダイジェスト) | ServerImage-TORO の `docker-compose.yaml` | PR → 本番で `docker compose up -d --no-deps <サービス>` |
| toro-edge の経路の規則 | TORO-Edge の `sites.go` | PR → イメージ → compose |

### Tunnel の公開ルール (api.torosaba.net)

| 順 | ホスト名 | パス (正規表現) | 送り先 |
| --- | --- | --- | --- |
| 前 | `api.torosaba.net` | `^/map/` | `http://toro-edge:80` |
| 後 | `api.torosaba.net` | (なし) | `http://toro-api:8080` |

- パスの欄は正規表現。`^/map/` を、パス指定なしの規則より**上**に置く (上から順に最初に合うものが使われる)。追加直後は末尾に入るので、並べ替える。
- 確認 (GET のみ): `/map/v1/configuration` が 200、`/server/status` が toro-api の 200。
- 変更したら、cloudflared のログの `Updated to new configuration` (version が上がる) に出る規則の並びで確かめる。

## ビルドと公開

- `.github/workflows/pages.yml`: main への push と手動実行で `npm ci` → `npm run build:client` → `nuxt generate` → Pages に配備。
- API 側 (toro-webmap) のイメージは `image.yml` が作る (タグ `vX.Y.Z` → イメージ `X.Y.Z`)。タグはイメージを作ったものだけを残す。
- Pages は全ファイルに `Cache-Control: max-age=600` を付ける。画面の更新が反映されるまで最大 10 分かかる。

## 本番に反映する手順 (API を変えたとき)

1. toro-webmap / toro-edge のイメージを作り、ServerImage-TORO の `docker-compose.yaml` の版 (タグとダイジェスト) を PR で更新する。
2. 本番で `docker compose up -d --no-deps toro-webmap toro-edge` (toro-main は再作成しない。`stop.sh` / `start.sh` は使わない)。
3. 確認 (GET のみ): `https://api.torosaba.net/map/v1/configuration` が 200 で `Access-Control-Allow-Origin` を返す。`/live/plugin` `/live/clients` `/map/v1/live/plugin` が 404。
4. 画面だけを変えたときは main へマージするだけ (Pages が配備)。

## 戻し方

- 画面: 前のコミットを main へ戻す (Pages が再配備)。
- API: ServerImage-TORO の `docker-compose.yaml` の版を前のものへ戻し、本番で `docker compose up -d --no-deps toro-webmap toro-edge`。
- map の DNS を Tunnel へ戻す (Pages をやめる): 旧パスを撤去する前の toro-webmap (イメージ `1.2.1`) へ compose を戻したうえで、TORO-Domain の map のレコードを PR で戻して apply し、Tunnel に `map.torosaba.net` → `http://toro-edge:80` の規則があることを確かめる。
- Tunnel の `api.torosaba.net` の `^/map/` を消せば、api の `/map/*` は toro-api へ戻る (404)。