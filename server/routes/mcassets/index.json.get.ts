// 構造物の看板のための Minecraft のリソースのまとめの、いまの版 (hash)。中身は /mcassets/<hash>/... (いつまでもキャッシュしてよい)
export default defineEventHandler(async (event) => {
  const a = await mcAssets()
  if (!a) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    throw createError({ statusCode: 503, statusMessage: 'Minecraft assets are not available' })
  }
  return respond(event, {
    data: JSON.stringify({ format: a.meta.format, hash: a.hash, version: a.meta.version, unifont: a.meta.unifont }),
    type: 'application/json',
    // jar を差し替えたときに、5 分ほどで新しい版に移る
    cache: 'public, max-age=300',
  })
})
