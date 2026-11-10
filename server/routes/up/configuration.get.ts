// Dynmap のブラウザ側が最初に読む設定 (ログインは使っていないので、書き出されたものをそのまま返す)
export default defineEventHandler(async (event) => {
  const config = await dynmapStandaloneFile('dynmap_config.json')
  if (config === undefined) throw createError({ statusCode: 503, statusMessage: 'Dynmap has not written its configuration yet' })
  return respond(event, { data: config, type: 'application/json; charset=utf-8', cache: 'no-cache' })
})
