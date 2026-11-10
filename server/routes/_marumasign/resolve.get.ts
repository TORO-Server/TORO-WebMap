// /_marumasign/resolve?u=<看板の URL>: 転送 (URL の短縮サービスなど) の行き先を調べる
// MarumaSign 本体は転送を追うが、ブラウザーは看板の URL の転送を追わない (fetch の redirect: 'error')。代わりにサーバーが追って、行き先を教える。
// 調べるのは、看板データにいまある URL (と、再生リストなどからたどれると分かっている URL) だけ。行き先ごとにアドレスを確かめる (server/lib/marumasign/net.ts)
// 答え: { url: 最後の URL, redirected, cors: ブラウザーが直に読めるか, status, type }。ブラウザーは最後の URL も看板の URL と同じ決まりで確かめ直す
import { resolveRedirects, UpstreamError } from '../../lib/marumasign/net'
import {
  allow, clientIp, deny, ensureSigns, fromMapPage, gate, isAllowed, msConfig, netOptions, queryUrls, resolveLimit, safeHeaders,
} from '../../lib/marumasign/service'
import { ByteCache } from '../../lib/marumasign/limits'

interface Answer { bytes: number, json: string, status: number }

const cache = new ByteCache<Answer>(8 * 1024 * 1024, 20_000)
const OK_TTL = 10 * 60_000
const FAIL_TTL = 60_000
const pending = new Map<string, Promise<Answer>>()

export default defineEventHandler(async (event) => {
  safeHeaders(event)
  if (!msConfig().enabled) return deny(event, 404, 'not found')
  if (!fromMapPage(event)) return deny(event, 403, 'forbidden')
  const ip = clientIp(event)
  if (resolveLimit.hit(ip)) return deny(event, 429, 'too many requests')
  const q = queryUrls(event)
  if (!q) return deny(event, 400, 'bad url')
  await ensureSigns()
  if (!(await isAllowed(q.url, q.parents))) return deny(event, 403, 'not a sign url')

  let answer = cache.get(q.url)
  if (!answer) {
    let p = pending.get(q.url)
    if (!p) {
      const leave = gate.enter(ip)
      if (!leave) return deny(event, 503, 'busy')
      p = lookup(q.url).finally(() => {
        leave()
        pending.delete(q.url)
      })
      pending.set(q.url, p)
    }
    answer = await p
  }
  setResponseStatus(event, answer.status)
  setResponseHeader(event, 'Content-Type', 'application/json; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'private, max-age=300')
  return answer.json
})

async function lookup(url: string): Promise<Answer> {
  const origins = msConfig().origins
  try {
    const r = await resolveRedirects(url, origins[0] ?? 'https://3d-map.torosaba.net', netOptions())
    // 行き先も読んでよい (中継でも)
    for (const hop of r.chain.slice(1)) allow.addAlias(hop)
    const json = JSON.stringify({ url: r.url, redirected: r.chain.length > 1, cors: r.cors, status: r.status, type: r.type })
    const a = { bytes: json.length, json, status: 200 }
    cache.set(url, a, OK_TTL)
    return a
  }
  catch (e) {
    const status = e instanceof UpstreamError ? e.status : 502
    const json = JSON.stringify({ error: e instanceof Error ? e.message : 'error' })
    const a = { bytes: json.length, json, status: status === 403 ? 403 : 502 }
    cache.set(url, a, FAIL_TTL)
    return a
  }
}
