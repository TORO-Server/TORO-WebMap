// /_marumasign/proxy?u=<URL>[&p=<再生リストの URL>...]: CORS を返さないサイトの看板の画像・動画・PDF などを、サーバーが代わりに読んで返す
// MarumaSign 本体はどのサイトのものでも読むが、ブラウザーは CORS のないサイトのものを WebGL に描けない。ブラウザーはまず直に読み、だめならここを使う。
// ただの中継 (オープンプロキシ) にならないように:
//  - 読むのは、看板データにいまある URL、その転送先、それらの再生リスト (HLS, MPEG-DASH) と .gltf に書かれた URL だけ (server/lib/marumasign/allow.ts)。
//    ?p= は、看板の URL から再生リストをたどった道筋 (サーバーが自分で読み直して確かめる)
//  - https だけ。行き先ごとに名前を引いたアドレスを確かめ、サーバーの中・家の中・共有アドレスなどは読まない (server/lib/marumasign/net.ts)
//  - 中身は先頭のバイト列で種類を決め、画像・動画・音声・PDF・3D のもの・再生リストだけを返す。HTML は返さない。
//    大きさは種類ごとに MarumaSign 本体と同じ上限 (server/lib/marumasign/kinds.ts)。
//    再生リストの中の目印のないものは、再生リストと別のサイトなら分割ファイルらしいものと小さいものだけ
//  - 返すものは、このサイトのページとして開けない (CSP sandbox、nosniff、決まった Content-Type、Content-Disposition: attachment)
//  - 地図のページからだけ (Sec-Fetch-Site, Origin。ブラウザーでないものは避けられるので、貼り付けの抑止にとどまる)。
//    1 つの IP からの数と量、全体の量、同時に読む数に上限
//  - Cookie・Referer・ブラウザーの頭書きは送らない
// 動画は Range (1 つの範囲) に対応する (video 要素が途中から読む)
import { PassThrough, pipeline, type Readable } from 'node:stream'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import type { IncomingMessage } from 'node:http'
import type { H3Event } from 'h3'
import { extensionOf } from '../../../app/bluemap/marumasign/core'
import { manifestRefs } from '../../../app/bluemap/marumasign/manifest'
import { follow, UpstreamError } from '../../lib/marumasign/net'
import { classify, cleanType, MAX_GLTF_PARSE_BYTES, type Kind } from '../../lib/marumasign/kinds'
import { ByteCache } from '../../lib/marumasign/limits'
import {
  allow, bodyCache, clientIp, countBytes, deny, ensureSigns, fromMapPage, gate, isAllowed, MAX_CACHED_BODY, msConfig, netOptions,
  overBytes, queryUrls, requestLimit, safeHeaders,
} from '../../lib/marumasign/service'

const RANGE = /^bytes=(\d{1,15})-(\d{0,15})$/
const CONTENT_RANGE = /^bytes (\d{1,15})-(\d{1,15})\/(\d{1,15}|\*)$/
const CACHE_TTL = 5 * 60_000
// 終わらない配信を 1 回でつないでおける時間
const STREAM_MAX_MILLIS = 30 * 60_000
// 終わる種類のファイルを読み終えるまでの時間
const FILE_MAX_MILLIS = 3 * 60_000
// 転送を追って先頭のバイト列を読むまでの時間 (少しずつ送ってくるサイトで、同時に読む枠を埋めさせない)
const START_MAX_MILLIS = 30_000
// 途中から読むときに使う、前に見た種類 (URL ごと)。判定したときの foreign の区別も一緒に覚え、
// 区別が違うときは使わない (別のサイトのものとして判定し直す)
const kinds = new ByteCache<{ bytes: number, kind: Kind, foreign: boolean }>(4 * 1024 * 1024, 20_000)

/** 前に見た種類 (判定したときの foreign の区別が同じときに限る) */
function cachedKind(url: string, foreign: boolean): Kind | null {
  const hit = kinds.get(url)
  return hit && hit.foreign === foreign ? hit.kind : null
}

function rememberKind(url: string, kind: Kind, foreign: boolean): void {
  kinds.set(url, { bytes: 200, kind, foreign }, 30 * 60_000)
}

export default defineEventHandler(async (event) => {
  safeHeaders(event)
  setResponseHeader(event, 'Content-Disposition', 'attachment')
  const method = event.method
  if (method !== 'GET' && method !== 'HEAD') {
    setResponseHeader(event, 'Allow', 'GET, HEAD')
    return deny(event, 405, 'method not allowed')
  }
  if (!msConfig().enabled) return deny(event, 404, 'not found')
  if (!fromMapPage(event)) return deny(event, 403, 'forbidden')
  const ip = clientIp(event)
  if (requestLimit.hit(ip) || overBytes(ip)) return deny(event, 429, 'too many requests')
  const q = queryUrls(event)
  if (!q) return deny(event, 400, 'bad url')
  await ensureSigns()
  const why = await isAllowed(q.url, q.parents)
  if (!why) return deny(event, 403, 'not a sign url')
  const child = why === 'child' || why === 'foreign'
  const foreign = why === 'foreign'

  const rangeHeader = getRequestHeader(event, 'range')
  let range: { start: number, end: number | null } | null = null
  if (rangeHeader) {
    const m = RANGE.exec(rangeHeader.trim())
    // 対応しない形 (いくつもの範囲、末尾から) は全体を返す
    if (m) range = { start: Number(m[1]), end: m[2] ? Number(m[2]) : null }
    if (range && range.end !== null && range.end < range.start) return deny(event, 416, 'bad range')
  }

  const cached = bodyCache.get(q.url)
  if (cached) return sendBody(event, cached.body, cached.type, cached.upstreamType, cached.url, cached.kind, range, method)

  const leave = gate.enter(ip)
  if (!leave) return deny(event, 503, 'busy')
  const ac = new AbortController()
  const onClose = (): void => ac.abort()
  event.node.res.on('close', onClose)
  let timedOut = false
  const startTimer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, START_MAX_MILLIS)
  let res: IncomingMessage | null = null
  let streaming = false
  try {
    let kind = cachedKind(q.url, foreign)
    // 途中から読むときは、中身の種類を先に確かめる
    if (range && range.start > 0 && !kind) {
      kind = await sniffOnly(q.url, child, foreign, ac.signal)
      if (!kind) return deny(event, 415, 'unsupported content')
    }
    const headers: Record<string, string> = {
      'accept-encoding': 'identity',
    }
    if (range) headers.Range = 'bytes=' + range.start + '-' + (range.end ?? '')
    const f = await follow(q.url, { headers, timeout: 15000, signal: ac.signal }, netOptions())
    for (const hop of f.chain.slice(1)) allow.addAlias(hop)
    res = f.res
    const status = res.statusCode ?? 0
    if (status !== 200 && status !== 206) {
      return deny(event, status === 404 || status === 410 ? 404 : 502, 'upstream ' + status)
    }
    const encoding = String(res.headers['content-encoding'] ?? 'identity').toLowerCase()
    let body: Readable = res
    let length = Number(res.headers['content-length'])
    if (encoding !== 'identity') {
      if (status === 206) return deny(event, 502, 'encoded range')
      const d = encoding === 'gzip' || encoding === 'x-gzip' ? createGunzip() : encoding === 'deflate' ? createInflate() : encoding === 'br' ? createBrotliDecompress() : null
      if (!d) return deny(event, 502, 'unknown encoding')
      pipeline(res, d, () => {})
      body = d
      length = NaN
    }
    const upstreamType = cleanType(res.headers['content-type'])
    let contentRange: { start: number, end: number, total: number | null } | null = null
    if (status === 206) {
      const m = CONTENT_RANGE.exec(String(res.headers['content-range'] ?? ''))
      if (!m) return deny(event, 502, 'bad upstream range')
      contentRange = { start: Number(m[1]), end: Number(m[2]), total: m[3] === '*' ? null : Number(m[3]) }
    }
    const fromStart = !contentRange || contentRange.start === 0
    const reader = new HeadReader(body)
    let head: Buffer = Buffer.alloc(0)
    if (fromStart) {
      head = await reader.read(4096)
      const k = classify(head, upstreamType, extensionOf(f.url), child, foreign)
      if (!k) return deny(event, 415, 'unsupported content')
      kind = k
      rememberKind(q.url, k, foreign)
    }
    // ここからは、読む種類ごとの時間で区切る
    clearTimeout(startTimer)
    if (!kind) return deny(event, 415, 'unsupported content')
    const total = contentRange ? contentRange.total : (Number.isFinite(length) ? length : null)
    if (total !== null && total > kind.cap) return deny(event, 413, 'too large')

    // 再生リストと .gltf (16 MB まで) は全部読んで、書かれた URL を一覧に足す
    const parse = kind.manifest !== undefined && fromStart && status === 200
      && (kind.manifest !== 'gltf' || (total !== null && total <= MAX_GLTF_PARSE_BYTES))
    const small = status === 200 && !kind.stream && total !== null && total <= MAX_CACHED_BODY
    if (parse || small) {
      const limit = parse ? Math.min(kind.cap, MAX_GLTF_PARSE_BYTES) : MAX_CACHED_BODY
      const all = await reader.readAll(head, limit, FILE_MAX_MILLIS, ac.signal)
      if (parse && all.length <= MAX_GLTF_PARSE_BYTES) {
        const refs = manifestRefs(all.toString('utf8'), f.url)
        if (refs) allow.addRefs(refs, f.url)
      }
      if (countBytes(ip, all.length)) return deny(event, 429, 'too many bytes')
      // 再生リストはライブ配信で書き換わるので覚えない
      if (kind.manifest !== 'hls' && kind.manifest !== 'dash' && all.length <= MAX_CACHED_BODY) {
        bodyCache.set(q.url, { bytes: all.length, body: all, type: kind.type, upstreamType, url: f.url, kind: kind.name }, CACHE_TTL)
      }
      return sendBody(event, all, kind.type, upstreamType, f.url, kind.name, range, method, kind.manifest === 'hls' || kind.manifest === 'dash')
    }

    // そのまま流す (動画、大きなファイル、配信)
    setResponseHeaders(event, {
      'Content-Type': kind.type,
      'X-MarumaSign-Type': upstreamType,
      'X-MarumaSign-Url': f.url,
      'X-MarumaSign-Kind': kind.name,
      'Cache-Control': kind.stream && total === null ? 'no-store' : 'private, max-age=300',
      'Accept-Ranges': kind.stream ? 'bytes' : 'none',
    })
    if (contentRange) {
      setResponseStatus(event, 206)
      setResponseHeader(event, 'Content-Range', `bytes ${contentRange.start}-${contentRange.end}/${contentRange.total ?? '*'}`)
      setResponseHeader(event, 'Content-Length', contentRange.end - contentRange.start + 1)
    }
    else if (total !== null) {
      setResponseHeader(event, 'Content-Length', total)
    }
    if (method === 'HEAD') return ''
    const out = new PassThrough()
    const cap = contentRange ? contentRange.end - contentRange.start + 1 : kind.cap
    const deadline = setTimeout(() => ac.abort(), kind.stream ? STREAM_MAX_MILLIS : FILE_MAX_MILLIS)
    let sent = 0
    const upstream = res
    const count = (n: number): boolean => {
      sent += n
      return sent <= cap && !countBytes(ip, n)
    }
    const finish = (): void => {
      clearTimeout(deadline)
      upstream.destroy()
      leave()
    }
    out.on('close', finish)
    if (head.length) {
      if (!count(head.length)) {
        finish()
        return deny(event, 413, 'too large')
      }
      out.write(head)
    }
    reader.pipeRest(out, count, ac.signal)
    // ここからは、閉じるのも出るのも finish
    streaming = true
    event.node.res.off('close', onClose)
    event.node.res.on('close', () => {
      ac.abort()
      out.destroy()
    })
    return sendStream(event, out)
  }
  catch (e) {
    if (timedOut) return deny(event, 504, 'upstream timeout')
    if (ac.signal.aborted) return ''
    if (e instanceof UpstreamError) return deny(event, e.status === 403 ? 403 : e.status >= 500 ? e.status : 502, e.message)
    if ((e as Error).message === 'too large') return deny(event, 413, 'too large')
    console.warn('marumasign proxy:', (e as Error).message)
    return deny(event, 502, 'upstream error')
  }
  finally {
    clearTimeout(startTimer)
    if (!streaming) {
      res?.destroy()
      leave()
      event.node.res.off('close', onClose)
    }
  }
})

/** 返す (全部読んだもの。Range にも対応) */
function sendBody(event: H3Event, body: Buffer, type: string, upstreamType: string, url: string, kind: string, range: { start: number, end: number | null } | null, method: string, live = false): Buffer | string {
  setResponseHeaders(event, {
    'Content-Type': type,
    'X-MarumaSign-Type': upstreamType,
    'X-MarumaSign-Url': url,
    'X-MarumaSign-Kind': kind,
    'Cache-Control': live ? 'no-store' : 'private, max-age=300',
    'Accept-Ranges': 'bytes',
  })
  let out = body
  if (range) {
    if (range.start >= body.length) {
      setResponseHeader(event, 'Content-Range', `bytes */${body.length}`)
      return deny(event, 416, 'range not satisfiable')
    }
    const end = Math.min(range.end ?? body.length - 1, body.length - 1)
    out = body.subarray(range.start, end + 1)
    setResponseStatus(event, 206)
    setResponseHeader(event, 'Content-Range', `bytes ${range.start}-${end}/${body.length}`)
  }
  setResponseHeader(event, 'Content-Length', out.length)
  return method === 'HEAD' ? '' : out
}

/** 先頭だけを読んで種類を決める (途中から読むとき) */
async function sniffOnly(url: string, child: boolean, foreign: boolean, signal: AbortSignal): Promise<Kind | null> {
  const f = await follow(url, { headers: { Range: 'bytes=0-4095' }, timeout: 15000, signal }, netOptions())
  try {
    const status = f.res.statusCode ?? 0
    if (status !== 200 && status !== 206) return null
    if (String(f.res.headers['content-encoding'] ?? 'identity').toLowerCase() !== 'identity') return null
    const head = await new HeadReader(f.res).read(4096)
    const k = classify(head, cleanType(f.res.headers['content-type']), extensionOf(f.url), child, foreign)
    if (k) rememberKind(url, k, foreign)
    return k
  }
  finally {
    f.res.destroy()
  }
}

/** 流れから先頭を読み、残りを流す */
class HeadReader {
  private readonly stream: Readable
  private readonly iterator: AsyncIterator<Buffer>
  private ended = false

  constructor(stream: Readable) {
    this.stream = stream
    this.iterator = (stream as AsyncIterable<Buffer>)[Symbol.asyncIterator]()
  }

  /** 少なくとも min バイト (終わればそこまで) */
  async read(min: number): Promise<Buffer> {
    const chunks: Buffer[] = []
    let n = 0
    while (n < min) {
      const r = await this.iterator.next()
      if (r.done) {
        this.ended = true
        break
      }
      chunks.push(r.value)
      n += r.value.length
    }
    return Buffer.concat(chunks)
  }

  async readAll(head: Buffer, max: number, timeout: number, signal: AbortSignal): Promise<Buffer> {
    const chunks: Buffer[] = [head]
    let n = head.length
    if (n > max) throw new Error('too large')
    const timer = setTimeout(() => this.stream.destroy(new Error('timeout')), timeout)
    try {
      while (!this.ended) {
        if (signal.aborted) throw new Error('aborted')
        const r = await this.iterator.next()
        if (r.done) break
        n += r.value.length
        if (n > max) throw new Error('too large')
        chunks.push(r.value)
      }
    }
    finally {
      clearTimeout(timer)
    }
    return Buffer.concat(chunks)
  }

  /** 残りを out に流す。count が false を返したら止める */
  pipeRest(out: PassThrough, count: (n: number) => boolean, signal: AbortSignal): void {
    void (async () => {
      try {
        while (!this.ended && !signal.aborted) {
          const r = await this.iterator.next()
          if (r.done) break
          if (!count(r.value.length)) throw new Error('limit')
          if (!out.write(r.value)) await new Promise<void>((ok) => {
            const done = (): void => {
              out.off('drain', done)
              out.off('close', done)
              ok()
            }
            out.on('drain', done)
            out.on('close', done)
          })
          if (out.destroyed) break
        }
        out.end()
      }
      catch {
        out.destroy()
      }
    })()
  }
}
