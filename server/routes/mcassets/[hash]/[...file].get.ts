// 構造物の看板のための Minecraft のリソースのまとめ (server/utils/mcassets.ts)。URL に版 (hash) が入るので、いつまでもキャッシュしてよい
//   /mcassets/<hash>/assets.json       blockstates, models, items, バイオームの色など (brotli か gzip で返す)
//   /mcassets/<hash>/textures.bin      テクスチャの PNG を並べたもの (位置は assets.json の textures)
//   /mcassets/<hash>/unifont/<4 桁の 16 進>.txt  Unifont の 256 文字分 (jar のフォントにない文字)
const IMMUTABLE = 'public, max-age=31536000, immutable'

export default defineEventHandler(async (event) => {
  const hash = getRouterParam(event, 'hash') ?? ''
  const file = getRouterParam(event, 'file') ?? ''
  if (!/^[0-9a-f]{20}$/.test(hash)) throw createError({ statusCode: 404 })
  await mcAssets()
  const a = mcAssetsByHash(hash)
  if (!a) throw createError({ statusCode: 404 })
  if (file === 'assets.json') {
    const accept = getRequestHeader(event, 'accept-encoding') ?? ''
    const [data, encoding] = /\bbr\b/.test(accept) ? [a.jsonBrotli, 'br'] : /\bgzip\b/.test(accept) ? [a.jsonGzip, 'gzip'] : [a.json, undefined]
    return respond(event, { data, type: 'application/json', cache: IMMUTABLE, etag: `"${hash}-${encoding ?? 'id'}"`, encoding })
  }
  if (file === 'textures.bin') {
    return respond(event, { data: a.textures, type: 'application/octet-stream', cache: IMMUTABLE, etag: `"${hash}-t"` })
  }
  const m = /^unifont\/([0-9A-F]{4})\.txt$/.exec(file)
  if (m) {
    const page = a.unifont.get(Number.parseInt(m[1]!, 16))
    if (page === undefined) {
      setResponseHeader(event, 'Cache-Control', IMMUTABLE)
      return sendNoContent(event, 204)
    }
    return respond(event, { data: page, type: 'text/plain; charset=utf-8', cache: IMMUTABLE, etag: `"${hash}-u${m[1]}"` })
  }
  throw createError({ statusCode: 404 })
})
