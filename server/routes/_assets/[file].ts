import { Readable } from 'node:stream'
import type { H3Event } from 'h3'
import type { HostedFile } from '../../utils/assets'

// assets.torosaba.net/<id>.<拡張子> (toro-edge が /_assets/ に付け替えて送ってくる)。MarumaSign Companion がホストした看板の画像など
// 読めるのは、次のどちらかだけ (ほかのサイトに貼られたり、ただの置き場として使われたりしないように)
//   - いま TORO で遊んでいるプレイヤーの IP から (MarumaSign の Mod が看板を読む)。IP は Cloudflare の CF-Connecting-IP、
//     遊んでいる人の IP は TORO-Proxy (Velocity) が知らせてくる (server/utils/clients.ts)
//   - 地図のページ (map. / 3d-map.torosaba.net) から。ブラウザが付ける Origin (MarumaSign の 3D の看板は CORS で読む) か Referer
// Origin と Referer はブラウザでないものなら自由に書けるので、これはほかのサイトへの貼り付けの抑止で、非公開にする仕組みではない。
// 看板の画像は地図で誰でも見られる前提のもの (id も公開の看板データにある)。見せたくないものを置くなら、期限付きの署名 URL が要る
// 確かめるのは毎回ここなので、Cloudflare にはキャッシュさせない (ブラウザには持たせる)

const PATH = /^([a-z2-7]{12})\.([a-z0-9]{1,10})$/
const RANGE = /^bytes=(\d{0,19})-(\d{0,19})$/

export default defineEventHandler(async (event) => {
  const method = event.method
  setResponseHeaders(event, {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    // SVG などにスクリプトがあっても動かさない
    'Content-Security-Policy': 'default-src \'none\'; style-src \'unsafe-inline\'; sandbox',
    'Vary': 'Origin',
    'CDN-Cache-Control': 'no-store',
  })
  if (method !== 'GET' && method !== 'HEAD') {
    setResponseHeader(event, 'Allow', 'GET, HEAD')
    return deny(event, 405, 'method not allowed')
  }

  const m = PATH.exec(getRouterParam(event, 'file') ?? '')
  if (!m) return deny(event, 404, 'not found')

  const ip = getRequestHeader(event, 'x-toro-client-ip') ?? ''
  if (overLimit(ip)) return deny(event, 429, 'too many requests')

  const originHeader = getRequestHeader(event, 'origin')
  const referer = getRequestHeader(event, 'referer')
  const origin = allowedOrigin(originHeader, referer)
  // MarumaSign の Mod は Origin も Referer も付けない。付いていて地図のページでなければ、ほかのサイトに貼られたもの (遊んでいる人のブラウザでも断る)
  const fromOtherSite = !origin && (originHeader !== undefined || referer !== undefined)
  if (fromOtherSite || (!origin && !isPlayerAddress(ip))) {
    return deny(event, 403, 'TORO Server で遊んでいるプレイヤーか、TORO Server の地図からだけ読めます')
  }
  let file: HostedFile | undefined
  try {
    file = await hostedFile(m[1]!)
  }
  catch (e) {
    // DB が止まっている、Companion がまだ表を作っていない、など
    console.error('assets:', (e as Error).message)
    return deny(event, 503, 'temporarily unavailable')
  }
  if (origin) setResponseHeader(event, 'Access-Control-Allow-Origin', origin)
  if (!file || file.ext !== m[2]) return deny(event, 404, 'not found')

  const etag = `"${file.id}"`
  setResponseHeaders(event, {
    'Content-Type': file.contentType,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'ETag': etag,
    'Accept-Ranges': 'bytes',
  })
  if (getRequestHeader(event, 'if-none-match') === etag) {
    setResponseStatus(event, 304)
    return ''
  }

  const range = parseRange(getRequestHeader(event, 'range'), file.size)
  if (range === 'invalid') {
    setResponseHeader(event, 'Content-Range', `bytes */${file.size}`)
    return deny(event, 416, 'range not satisfiable')
  }
  const [start, end] = range ?? [0, file.size - 1]
  const length = file.size === 0 ? 0 : end - start + 1
  if (range) {
    setResponseStatus(event, 206)
    setResponseHeader(event, 'Content-Range', `bytes ${start}-${end}/${file.size}`)
  }
  setResponseHeader(event, 'Content-Length', length)
  if (method === 'HEAD' || length === 0) return ''
  return sendStream(event, Readable.from(slices(file, start, end)))
})

async function* slices(file: HostedFile, start: number, end: number): AsyncGenerator<Buffer> {
  for (let seq = Math.floor(start / file.chunkSize); seq * file.chunkSize <= end && seq < file.chunks; seq++) {
    const chunk = await hostedChunk(file, seq)
    const base = seq * file.chunkSize
    yield chunk.subarray(Math.max(0, start - base), Math.min(chunk.length, end - base + 1))
  }
}

function allowedOrigin(origin: string | undefined, referer: string | undefined): string | undefined {
  const origins = useRuntimeConfig().assets.origins as string[]
  if (origin) return origins.includes(origin) ? origin : undefined
  if (!referer) return undefined
  try {
    const o = new URL(referer).origin
    return origins.includes(o) ? o : undefined
  }
  catch {
    return undefined
  }
}

/** Range (1 つの範囲だけ)。なし・対応しない形は undefined (全体)、範囲外は invalid。Companion の HostingServer と同じ */
function parseRange(header: string | undefined, size: number): [number, number] | 'invalid' | undefined {
  const m = header ? RANGE.exec(header.trim()) : null
  if (!m) return undefined
  const [, a, b] = m as unknown as [string, string, string]
  if (!a && !b) return undefined
  if (size === 0) return 'invalid'
  if (!a) {
    const suffix = Number(b)
    return suffix === 0 ? 'invalid' : [Math.max(0, size - suffix), size - 1]
  }
  const first = Number(a)
  if (first >= size) return 'invalid'
  if (!b) return [first, size - 1]
  const last = Number(b)
  return last < first ? 'invalid' : [first, Math.min(last, size - 1)]
}

function deny(event: H3Event, status: number, message: string): string {
  setResponseStatus(event, status)
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return message
}
