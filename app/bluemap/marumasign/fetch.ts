// 看板の URL の読み方 (前のスクリプトと同じ決まり: CORS・Cookie なし・Referer なし・転送は追わない、時間と大きさに上限)
// 直に読めない (CORS がない、転送される) ときは、地図のサーバーに頼む (MarumaSign 本体は転送を追い、どのサイトのものでも読むので):
//  1. /_marumasign/resolve で転送の行き先を聞き、行き先が CORS を返すなら、行き先を (同じ決まりで確かめてから) 直に読む
//  2. それでもだめなら /_marumasign/proxy (サーバーが看板の URL とそこからたどれる URL だけを、決まった種類と大きさで中継する)
import { safeUrl, sniff, sniffGzipInner, withoutFragment, type Sniffed } from './core'

export const FETCH_TIMEOUT_MILLIS = 20 * 1000
const RESOLVE_PATH = '/_marumasign/resolve'
const PROXY_PATH = '/_marumasign/proxy'

/** 読み込みを始めた応答と、それを止めるもの */
export interface OpenResponse {
  res: Response
  /** Content-Type の主な部分 (小文字。中継したものは元のサイトの Content-Type) */
  type: string
  controller: AbortController
  /** 読み終えたら (やめたら) 必ず呼ぶ。時間切れの見張りを止める */
  done(): void
  /** 中身の本当の URL (転送されたら行き先。再生リストの中の相対 URL はこれから解決する) */
  url: string
  /** 読んだ URL (video 要素などに渡すもの。中継なら /_marumasign/proxy?...) */
  src: string
  /** どう読んだか */
  via: 'direct' | 'redirect' | 'proxy'
}

/** 読み方の指定 */
export interface OpenOptions {
  /** 付ける頭書き (Range だけ) */
  range?: string
  /** 再生リストなどから来た URL のとき、看板の URL からのたどり方 (先頭が看板の URL)。サーバーが確かめる */
  parents?: string[]
  /** 外から止める */
  signal?: AbortSignal
}

/** HTTP の失敗 (応答は来た) */
export class HttpError extends Error {
  status: number

  constructor(status: number) {
    super('HTTP ' + status)
    this.status = status
  }
}

/** URL ごとに、前に分かった読み方 (直に読めなかったものを毎回直に読もうとしない) */
type Plan = { via: 'direct' } | { via: 'redirect', url: string } | { via: 'proxy' }
const plans = new Map<string, Plan>()
/** 再生リストの中の URL は数が多いので、配信 (看板の URL) とホストごとに覚える */
const hostPlans = new Map<string, 'direct' | 'proxy'>()
/** サーバーに頼めない (404 など) と分かったら、もう頼まない */
let serverMissing = false

function remember<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
  if (map.size > 5000) map.delete(map.keys().next().value!)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  }
  catch {
    return ''
  }
}

/** 中継の URL (同じサイト) */
export function proxyUrl(url: string, parents: string[] = []): string {
  let s = PROXY_PATH + '?u=' + encodeURIComponent(withoutFragment(url))
  for (const p of parents.slice(0, 3)) s += '&p=' + encodeURIComponent(withoutFragment(p))
  return s
}

/** 直に読む (CORS、Cookie なし、Referer なし、転送は追わない) */
async function direct(url: string, cache: RequestCache, timeout: number, options: OpenOptions): Promise<OpenResponse> {
  if (!safeUrl(url, true)) throw new Error('blocked url')
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const outer = options.signal
  const onAbort = (): void => controller.abort()
  outer?.addEventListener('abort', onAbort)
  const done = (): void => {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
  try {
    const res = await fetch(url, {
      mode: 'cors', credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error',
      cache, signal: controller.signal, headers: options.range ? { Range: options.range } : undefined,
    })
    if (!res.ok) throw new HttpError(res.status)
    const type = (res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    return { res, type, controller, done, url, src: url, via: 'direct' }
  }
  catch (e) {
    done()
    controller.abort()
    throw e
  }
}

/** 地図のサーバーの中継で読む */
async function proxied(url: string, timeout: number, options: OpenOptions): Promise<OpenResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  const outer = options.signal
  const onAbort = (): void => controller.abort()
  outer?.addEventListener('abort', onAbort)
  const done = (): void => {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onAbort)
  }
  const src = proxyUrl(url, options.parents)
  try {
    const res = await fetch(src, {
      credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', cache: 'default', signal: controller.signal,
      headers: options.range ? { Range: options.range } : undefined,
    })
    if (res.status === 404 && !res.headers.get('x-marumasign-kind')) {
      const text = await res.text().catch(() => '')
      if (text === 'not found') serverMissing = true
    }
    if (!res.ok) throw new HttpError(res.status)
    const real = res.headers.get('x-marumasign-url')
    // 中継の答えの行き先も、看板の URL と同じ決まりで確かめる
    const finalUrl = real && safeUrl(real, true) ? real : withoutFragment(url)
    const type = (res.headers.get('x-marumasign-type') || res.headers.get('content-type') || '').split(';')[0]!.trim().toLowerCase()
    return { res, type, controller, done, url: finalUrl, src, via: 'proxy' }
  }
  catch (e) {
    done()
    controller.abort()
    throw e
  }
}

/** 転送の行き先を地図のサーバーに聞く。分からなければ null */
async function resolveRedirect(url: string, parents: string[] | undefined): Promise<{ url: string, cors: boolean } | null> {
  let q = RESOLVE_PATH + '?u=' + encodeURIComponent(withoutFragment(url))
  for (const p of (parents ?? []).slice(0, 3)) q += '&p=' + encodeURIComponent(withoutFragment(p))
  try {
    const res = await fetch(q, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', signal: AbortSignal.timeout(15000) })
    if (res.status === 404) serverMissing = true
    if (!res.ok) return null
    const j = await res.json() as { url?: unknown, redirected?: unknown, cors?: unknown }
    // 行き先も、看板の URL と同じ決まりで確かめる
    const next = typeof j.url === 'string' ? safeUrl(j.url, true) : null
    if (!next || j.redirected !== true) return null
    return { url: next, cors: j.cors === true }
  }
  catch {
    return null
  }
}

/** 種類が違ったとき (画像だと思って読んだら動画だった、など)。route に正しい描き方を入れる */
export class WrongKindError extends Error {
  route: string
  format: string

  constructor(route: string, format: string) {
    super('wrong kind: ' + route)
    this.route = route
    this.format = format
  }
}

/**
 * 看板の URL を読み始める。直に読めなければ、地図のサーバーに転送の行き先を聞くか、中継を頼む (この先頭の説明)。
 * @param cache 画像は force-cache (前のスクリプトと同じ)。ほかは default
 */
export async function open(url: string, cache: RequestCache = 'force-cache', timeout = FETCH_TIMEOUT_MILLIS, options: OpenOptions = {}): Promise<OpenResponse> {
  // 呼ぶ側でも確かめているが、念のためここでも https だけにする
  if (!safeUrl(url, true)) throw new Error('blocked url')
  const key = withoutFragment(url)
  const child = !!options.parents?.length
  const host = hostOf(key) + '|' + (options.parents?.[0] ?? '')
  let plan = plans.get(key)
  if (!plan && child && hostPlans.get(host) === 'proxy') plan = { via: 'proxy' }
  if (plan?.via === 'proxy' && !serverMissing) return proxied(url, timeout, options)
  if (plan?.via === 'redirect') {
    try {
      const o = await direct(plan.url, cache, timeout, options)
      return { ...o, via: 'redirect' }
    }
    catch (e) {
      if (e instanceof HttpError || options.signal?.aborted) throw e
    }
  }
  let first: unknown
  if (!plan || plan.via === 'direct') {
    try {
      const o = await direct(url, cache, timeout, options)
      if (!plan) remember(plans, key, { via: 'direct' })
      if (child && !hostPlans.has(host)) remember(hostPlans, host, 'direct')
      return o
    }
    catch (e) {
      // 応答が来た失敗 (404 など) と、止めたときは、サーバーに頼んでも同じ
      if (e instanceof HttpError || options.signal?.aborted || serverMissing) throw e
      first = e
    }
  }
  // 直に読めない (CORS がない、転送される、つながらない)。転送なら、行き先が CORS を返せば直に読む
  if (!child) {
    const r = await resolveRedirect(key, options.parents)
    if (r && r.cors && r.url !== key) {
      try {
        const o = await direct(r.url, cache, timeout, options)
        remember(plans, key, { via: 'redirect', url: r.url })
        return { ...o, via: 'redirect' }
      }
      catch (e) {
        if (e instanceof HttpError || options.signal?.aborted) throw e
      }
    }
  }
  if (serverMissing) throw first ?? new Error('cannot read')
  const o = await proxied(url, timeout, options)
  remember(plans, key, { via: 'proxy' })
  if (child) remember(hostPlans, host, 'proxy')
  return o
}

/** 本文を max バイトまで読む (前のスクリプトの readLimited と同じ)。超えたら止めて失敗にする */
export async function readLimited(o: OpenResponse, max: number, already: Uint8Array[] = []): Promise<Uint8Array[]> {
  const length = Number(o.res.headers.get('content-length'))
  if (length > max) {
    o.controller.abort()
    throw new Error('too large')
  }
  if (!o.res.body || !o.res.body.getReader) throw new Error('no stream')
  const reader = o.res.body.getReader()
  const chunks = already
  let total = 0
  for (const c of chunks) total += c.length
  for (;;) {
    const r = await reader.read()
    if (r.done) return chunks
    total += r.value.length
    if (total > max) {
      o.controller.abort()
      throw new Error('too large')
    }
    chunks.push(r.value)
  }
}

/**
 * 先頭だけを読む (少なくとも min バイト。中身で種類を決めるため)。
 * 読んだ分は chunks に入れて返すので、続きを読むときは readRest に渡す。
 */
export async function readHead(o: OpenResponse, min: number): Promise<{ head: Uint8Array, chunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>, ended: boolean }> {
  if (!o.res.body || !o.res.body.getReader) throw new Error('no stream')
  const reader = o.res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  let ended = false
  while (total < min) {
    const r = await reader.read()
    if (r.done) {
      ended = true
      break
    }
    chunks.push(r.value)
    total += r.value.length
  }
  return { head: concat(chunks, Math.min(total, 4096)), chunks, reader, ended }
}

/** readHead の続きを max バイトまで読む */
export async function readRest(o: OpenResponse, h: { chunks: Uint8Array[], reader: ReadableStreamDefaultReader<Uint8Array>, ended: boolean }, max: number): Promise<Uint8Array> {
  const length = Number(o.res.headers.get('content-length'))
  if (length > max) {
    o.controller.abort()
    throw new Error('too large')
  }
  let total = 0
  for (const c of h.chunks) total += c.length
  if (total > max) {
    o.controller.abort()
    throw new Error('too large')
  }
  while (!h.ended) {
    const r = await h.reader.read()
    if (r.done) break
    total += r.value.length
    if (total > max) {
      o.controller.abort()
      throw new Error('too large')
    }
    h.chunks.push(r.value)
  }
  return concat(h.chunks, total)
}

/** つなげた 1 つのバイト列 (先頭 limit バイトまで) */
export function concat(chunks: Uint8Array[], limit = Infinity): Uint8Array {
  let total = 0
  for (const c of chunks) total += c.length
  const n = Math.min(total, limit)
  const out = new Uint8Array(n)
  let at = 0
  for (const c of chunks) {
    if (at >= n) break
    const part = c.length > n - at ? c.subarray(0, n - at) : c
    out.set(part, at)
    at += part.length
  }
  return out
}

/**
 * 先頭のバイト列から形式を決める。gzip なら中身の先頭を展開して決める (構造物、.spz、.svgz)
 * @param ext URL の拡張子
 */
export async function sniffAsync(head: Uint8Array, type: string, ext: string): Promise<Sniffed | null> {
  const s = sniff(head, type, ext)
  if (!s || s.format !== 'gzip') return s
  return sniffGzipInner(await gunzipHead(head, 256), ext)
}

/** gzip の先頭だけを展開する (途中までのデータでよい。壊れていれば空) */
export async function gunzipHead(head: Uint8Array, max: number): Promise<Uint8Array> {
  const out: Uint8Array[] = []
  let total = 0
  try {
    const stream = new Blob([head as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'))
    const reader = stream.getReader()
    while (total < max) {
      const r = await reader.read()
      if (r.done) break
      out.push(r.value)
      total += r.value.length
    }
    void reader.cancel().catch(() => {})
  }
  catch { /* 先頭だけなので、途中で終わるのは普通 */ }
  return concat(out, max)
}

/**
 * 動画やライブ配信を再生する前に、先頭だけを読んで確かめる (CORS が通るか、転送されないか、中身の種類)。
 * 再生そのものは video 要素や hls.js が読む。
 */
export async function probe(url: string): Promise<{ type: string, head: Uint8Array, src: string, url: string, via: OpenResponse['via'], length: number | null }> {
  const o = await open(url, 'no-store', 15000)
  try {
    const h = await readHead(o, 1024)
    const n = Number(o.res.headers.get('content-length'))
    return { type: o.type, head: h.head, src: o.src, url: o.url, via: o.via, length: o.res.headers.get('content-length') !== null && Number.isFinite(n) ? n : null }
  }
  finally {
    o.done()
    o.controller.abort()
  }
}
