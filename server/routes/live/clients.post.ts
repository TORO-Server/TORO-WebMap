import { tokenMatches } from '../../lib/token'

// TORO-Proxy (Velocity) が、いまつながっているプレイヤーの IP を全員分送ってくる ({"ips": [...]})。toro-edge は外に出さない
// 合言葉は X-Toro-Token (NUXT_CLIENTS_TOKEN)。空のときは受け付けない

const MAX_IPS = 2000

export default defineEventHandler(async (event) => {
  if (!tokenMatches(getRequestHeader(event, 'x-toro-token'), useRuntimeConfig().clientsToken)) {
    throw createError({ statusCode: 403 })
  }
  const body = await readBody<{ ips?: unknown }>(event)
  const ips = body?.ips
  if (!Array.isArray(ips) || ips.length > MAX_IPS || !ips.every(ip => typeof ip === 'string' && ip.length <= 64)) {
    throw createError({ statusCode: 400 })
  }
  updateClients(ips as string[])
  return sendNoContent(event, 204)
})
