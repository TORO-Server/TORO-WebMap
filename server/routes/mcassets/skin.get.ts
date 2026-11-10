// 構造物の中のプレイヤーの頭 (名前か UUID しか書かれていないもの) のスキン: GET /mcassets/skin?name=<名前> か ?uuid=<UUID>
// 返すのは {"url": "https://textures.minecraft.net/texture/<hash>" か null, "slim": true/false} だけ (server/utils/skin-lookup.ts)
import { limitKey } from '../../lib/marumasign/limits.ts'
import { NAME_PATTERN, NEGATIVE_MILLIS, normalizeUuid, POSITIVE_MILLIS, SkinResolver } from '../../utils/skin-lookup.ts'

const resolver = new SkinResolver()

export default defineEventHandler(async (event) => {
  const q = getQuery(event)
  const name = typeof q.name === 'string' ? q.name : null
  const uuidText = typeof q.uuid === 'string' ? q.uuid : null
  if ((name === null) === (uuidText === null)) throw createError({ statusCode: 400, statusMessage: 'name or uuid' })
  let query: { name: string } | { uuid: string }
  if (name !== null) {
    if (!NAME_PATTERN.test(name)) throw createError({ statusCode: 400, statusMessage: 'bad name' })
    query = { name }
  }
  else {
    const uuid = normalizeUuid(uuidText!)
    if (!uuid) throw createError({ statusCode: 400, statusMessage: 'bad uuid' })
    query = { uuid }
  }
  // Cloudflare が付けるクライアントの IP (toro-edge には Tunnel からしか届かない)
  const ip = getRequestHeader(event, 'cf-connecting-ip') || getRequestIP(event, { xForwardedFor: true }) || 'unknown'
  const r = await resolver.resolve(query, limitKey(ip))
  if (r === 'rate' || r === 'busy') {
    setResponseHeaders(event, { 'Cache-Control': 'no-store', 'Retry-After': '60' })
    throw createError({ statusCode: r === 'rate' ? 429 : 503 })
  }
  return respond(event, {
    data: JSON.stringify(r),
    type: 'application/json',
    cache: `public, max-age=${(r.url ? POSITIVE_MILLIS : NEGATIVE_MILLIS) / 1000}`,
  })
})
