# TORO-WebMap

TORO の Dynmap (Minecraft の地図) の画面と、地図のデータを TiDB (データベース) から返すサーバーです。Nuxt (Vue のアプリの枠組み) と TypeScript で書かれています。

Minecraft サーバーの中の Web サーバーには地図のデータを聞かず、すべて TiDB から返します。Dynmap の画面は、Dynmap 付属の画面と同じ見た目で、Vue と Leaflet (地図の部品) で作り直したものです。BlueMap の 3D 地図の画面は、別のリポジトリ [TORO-3D-WebMap](https://github.com/TORO-Server/TORO-3D-WebMap) に分けました。このリポジトリのサーバー側には、従来の 3D 地図が使うデータの配信が、TORO-API へ移すまで残っています。

## 動かしてみる

```bash
npm ci
npm run typecheck
npm test
npm run build
```

手元で動かすときは `npm run dev` です。設定の既定値の正本は [nuxt.config.ts](nuxt.config.ts) です。

## 関連文書

- 画面とサーバーの作り: [docs/design.md](docs/design.md)
- 静的な画面と API の分け方: [docs/map-deployment.md](docs/map-deployment.md)
- 3D 地図の構成: TORO-3D-WebMap の `docs/deployment.md`
- 他者製の部品の帰属: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
