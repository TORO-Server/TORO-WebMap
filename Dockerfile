# map.torosaba.net (Dynmap) と 3d-map.torosaba.net (BlueMap) の地図データを TiDB から返す Nuxt (Nitro) サーバー
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /src
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# 型と試験 (CI の target: test。実行用のイメージには入らない)
FROM build AS test
RUN npm run typecheck && npm test

# 実行するだけなら Node.js の本体があればよい。公式の node イメージに入っている npm / yarn / corepack / ヘッダーを持ち込まない。
# Alpine のパッケージの Node.js は ICU を分けてあり (サーバーの処理は Intl を使わないので en だけで足りる)、本体も小さい。
# 版の大きな番号は、上の build と同じにする
FROM alpine:3.24.3@sha256:be2656061b536c1883c4034790e21d0a09c5aaaf51968b89368a3c0371ea2c9a
RUN apk add --no-cache nodejs
WORKDIR /app
COPY --from=build /src/.output ./
# 非 root で動かす。書く場所 (/var/cache/webmap など) は、実行する側がマウントして渡す
USER 65532:65532
ENV NODE_ENV=production PORT=3000 HOST=0.0.0.0
EXPOSE 3000
CMD ["node", "server/index.mjs"]
