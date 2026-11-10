// Dynmap のブラウザ側が 2 秒ごとに読むワールドの更新 (プレイヤーの位置、描き直したタイルなど)
// 中身は時刻によらず同じ。どの更新が新しいかはブラウザ側が timestamp で選ぶ
export default defineEventHandler(async (event) => {
  const world = getRouterParam(event, 'world') ?? ''
  if (world.includes('/') || world.includes('\\')) return respond(event, { data: '{ "error": "invalid-world" }', type: 'application/json; charset=utf-8', cache: 'no-cache' })
  // 知らないワールドの名前で DB を読まない (一覧が読めないときは、これまでどおり読みに行く)
  if (await dynmapWorldKnown(world) === false) throw createError({ statusCode: 404 })
  const update = await dynmapStandaloneFile(`dynmap_${world}.json`)
  if (update === undefined) throw createError({ statusCode: 503, statusMessage: 'Database unavailable' })
  return respond(event, { data: update, type: 'application/json; charset=utf-8', cache: 'no-cache' })
})
