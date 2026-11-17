# TORO-WebMap

TORO の地図 (Dynmap と BlueMap) の画面と、地図のデータを TiDB から返すサーバーです。Nuxt (Vue のアプリの枠組み) と TypeScript で書かれています。

Minecraft サーバーの中の Web サーバーには地図のデータを聞かず、すべて TiDB から返します。Dynmap の画面は、Dynmap 付属の画面と同じ見た目で、Vue と Leaflet (地図の部品) で作り直したものです。BlueMap の画面は、BlueMap 付属の画面を TypeScript にしたもので、MarumaSign の看板 (画像・動画・音声・PDF・3D モデル・構造物) も表示します。

## 動かしてみる

```bash
npm ci
npm run typecheck
npm test
npm run build
```

手元で動かすときは `npm run dev` です。設定の既定値の正本は [nuxt.config.ts](nuxt.config.ts) です。

## 関連文書

- 画面とサーバーの作り、MarumaSign の看板の扱い、構造物の描き方: [docs/design.md](docs/design.md)
- 静的な画面と API の分け方: [docs/map-deployment.md](docs/map-deployment.md)
- 他者製の部品の帰属: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
