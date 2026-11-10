/*
 * 看板の URL をサーバーから読む (転送の行き先を調べる /_marumasign/resolve と、CORS のないサイトの中継 /_marumasign/proxy)。
 * 看板の URL は誰でも書けるので、サーバーの中や家の中のネットワークを読ませないようにする (SSRF を防ぐ):
 *  - https だけ。ユーザー情報つき・IP アドレスそのもの・怪しいホスト名・怪しいポートは使わない (core.ts の safeUrl と同じ決まり)
 *  - 名前を引いたアドレスのどれかが、手元・家の中・共有アドレス (CGNAT)・リンクローカル・マルチキャスト・IPv6 の固有ローカルなら読まない。
 *    確かめたアドレスにそのままつなぐ (net.connect の lookup で確かめるので、確かめた後に名前の行き先をすり替えられない)
 *  - 転送は自分で追い、行き先ごとに同じ確かめをする (5 回まで)
 *  - Cookie・Referer・ブラウザーの頭書きは送らない
 * Nuxt に頼らない (Node の試験でも動かす。tests/marumasign-proxy.test.ts)
 */
import { lookup as dnsLookup, type LookupAddress } from 'node:dns'
import { request as httpsRequest, Agent, type RequestOptions } from 'node:https'
import type { IncomingMessage } from 'node:http'
import { isIP } from 'node:net'
import type { LookupFunction } from 'node:net'
import { safeUrl, withoutFragment } from '../../../app/bluemap/marumasign/core.ts'

export const MAX_REDIRECTS = 5
export const USER_AGENT = 'Mozilla/5.0 (MarumaSign; +https://3d-map.torosaba.net)'
/** 転送の行き先を調べる全体の時間 (転送の段ごとの時間切れのほかに。遅いサイトで同時に読む枠を埋めさせない) */
export const RESOLVE_MAX_MILLIS = 30_000

/** IP アドレスの生のバイト (IPv4 は 4、IPv6 は 16)。IP アドレスでなければ null */
export function ipBytes(ip: string): number[] | null {
  const addr = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  const kind = isIP(addr)
  if (kind === 4) return addr.split('.').map(Number)
  if (kind !== 6) return null
  let tail: number[] = []
  let text = addr
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    tail = v4[1]!.split('.').map(Number)
    text = text.slice(0, -v4[1]!.length) + '0:0'
  }
  const [head, rest] = text.split('::') as [string, string | undefined]
  const left = head ? head.split(':') : []
  const right = rest !== undefined && rest !== '' ? rest.split(':') : []
  const groups = rest === undefined ? left : [...left, ...Array<string>(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right]
  if (groups.length !== 8) return null
  const out: number[] = []
  for (const g of groups) {
    const n = parseInt(g || '0', 16)
    out.push((n >> 8) & 0xFF, n & 0xFF)
  }
  if (tail.length) for (let i = 0; i < 4; i++) out[12 + i] = tail[i]!
  return out
}

function blockedV4(a: number, b: number, c: number): boolean {
  return a === 0 // 0.0.0.0/8 (どこでもない)
    || a === 10 // 家の中 10.0.0.0/8
    || a === 127 // 手元
    || (a === 100 && (b & 0xC0) === 64) // 共有アドレス (CGNAT) 100.64.0.0/10
    || (a === 169 && b === 254) // リンクローカル (クラウドのメタデータ 169.254.169.254 も)
    || (a === 172 && (b & 0xF0) === 16) // 家の中 172.16.0.0/12 (Docker のネットワークも)
    || (a === 192 && b === 168) // 家の中
    || (a === 192 && b === 0 && c === 0) // IETF の予約 192.0.0.0/24
    || (a === 192 && b === 0 && c === 2) // 説明用 192.0.2.0/24
    || (a === 192 && b === 88 && c === 99) // 6to4 の中継 192.88.99.0/24
    || (a === 198 && (b & 0xFE) === 18) // ベンチマーク用 198.18.0.0/15
    || (a === 198 && b === 51 && c === 100) // 説明用
    || (a === 203 && b === 0 && c === 113) // 説明用
    || a >= 224 // マルチキャスト 224.0.0.0/4、予約 240.0.0.0/4、ブロードキャスト
}

/**
 * つないではいけないアドレスか (MarumaSign 本体の UrlPolicy.isLocal と同じ考え方に、説明用などの予約も足したもの)。
 * IP アドレスでなければ true (確かめられないものは使わない)
 */
export function isBlockedAddress(ip: string): boolean {
  const b = ipBytes(ip)
  if (!b) return true
  if (b.length === 4) return blockedV4(b[0]!, b[1]!, b[2]!)
  const zero = (from: number, to: number): boolean => b.slice(from, to).every(x => x === 0)
  // :: と ::1
  if (zero(0, 15) && (b[15] === 0 || b[15] === 1)) return true
  // IPv4 を写したもの ::ffff:a.b.c.d と、古い書き方の ::a.b.c.d、IPv4 を訳すもの ::ffff:0:a.b.c.d
  if (zero(0, 10) && ((b[10] === 0xFF && b[11] === 0xFF) || (b[10] === 0 && b[11] === 0))) return blockedV4(b[12]!, b[13]!, b[14]!)
  if (zero(0, 8) && b[8] === 0xFF && b[9] === 0xFF && b[10] === 0 && b[11] === 0) return blockedV4(b[12]!, b[13]!, b[14]!)
  // NAT64 64:ff9b::/96 は埋め込まれた IPv4 で。手元の NAT64 64:ff9b:1::/48 は使わない
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xFF && b[3] === 0x9B) {
    if (b[4] === 0 && b[5] === 1) return true
    return zero(4, 12) ? blockedV4(b[12]!, b[13]!, b[14]!) : true
  }
  // 6to4 2002::/16 は埋め込まれた IPv4 で
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b[2]!, b[3]!, b[4]!)
  // Teredo 2001:0::/32 (埋め込まれた IPv4 が分かりにくいので使わない)、説明用 2001:db8::/32、ORCHID など 2001:10::/28, 2001:20::/28
  if (b[0] === 0x20 && b[1] === 0x01) {
    if (b[2] === 0 && b[3] === 0) return true
    if (b[2] === 0x0D && b[3] === 0xB8) return true
    if (b[2] === 0 && b[3]! >= 0x10 && b[3]! <= 0x2F) return true
  }
  // 捨てる 100::/64
  if (b[0] === 1 && zero(1, 8)) return true
  // 固有ローカル fc00::/7、リンクローカル fe80::/10、古いサイトローカル fec0::/10、マルチキャスト ff00::/8
  if ((b[0]! & 0xFE) === 0xFC) return true
  if (b[0] === 0xFE && (b[1]! & 0xC0) === 0x80) return true
  if (b[0] === 0xFE && (b[1]! & 0xC0) === 0xC0) return true
  if (b[0] === 0xFF) return true
  // 割り当てられているのは 2000::/3 だけ
  return (b[0]! & 0xE0) !== 0x20
}

/** 試験のときだけ、決まった名前を決まったアドレス (「アドレス:ポート」でもよい) につなぐ (本番では空。名前ごとに証明書の確かめも外す) */
export interface NetOptions {
  testHosts?: Record<string, string>
}

/** 試験の名前のつなぎ先 */
function testTarget(options: NetOptions, hostname: string): { address: string, port: number | null } | null {
  const v = options.testHosts?.[hostname.toLowerCase()]
  if (!v) return null
  const m = /^(.+):(\d{1,5})$/.exec(v)
  if (m && isIP(m[1]!) === 4) return { address: m[1]!, port: Number(m[2]) }
  return { address: v.replace(/^\[|\]$/g, ''), port: null }
}

/**
 * 読んでよい URL の形か (https、core.ts の safeUrl と同じ決まり)。だめなら null、よければ「#」を除いた URL。
 * 名前の末尾の「.」(DNS の完全な名前の書き方) は使わない
 */
export function checkUrl(value: string): string | null {
  const u = safeUrl(value, true)
  if (!u) return null
  const parsed = new URL(u)
  if (parsed.hostname.endsWith('.') || parsed.hostname.includes('..')) return null
  return withoutFragment(u)
}

/** 名前を引いて、どれかがつないではいけないアドレスなら失敗にする (net.connect の lookup) */
export function safeLookup(options: NetOptions = {}): LookupFunction {
  return ((hostname: string, opts: { all?: boolean, family?: number | string }, cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void => {
    const fixed = testTarget(options, hostname)
    if (fixed) {
      const family = isIP(fixed.address)
      if (opts && opts.all) cb(null, [{ address: fixed.address, family }])
      else cb(null, fixed.address, family)
      return
    }
    dnsLookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
      if (err) return cb(err, '', 0)
      const list = addresses as LookupAddress[]
      if (!list.length) return cb(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '', 0)
      const bad = list.find(a => isBlockedAddress(a.address))
      if (bad) return cb(Object.assign(new Error('blocked address for ' + hostname), { code: 'EBLOCKED' }), '', 0)
      if (opts && opts.all) return cb(null, list)
      const want = opts && (opts.family === 4 || opts.family === 'IPv4') ? 4 : opts && (opts.family === 6 || opts.family === 'IPv6') ? 6 : 0
      const pick = list.find(a => !want || a.family === want) ?? list[0]!
      cb(null, pick.address, pick.family)
    })
  }) as LookupFunction
}

const agent = new Agent({ keepAlive: true, maxSockets: 8, maxFreeSockets: 4, timeout: 30000 })

/** 1 回の要求 (転送は追わない) */
export interface UpstreamRequest {
  method?: 'GET' | 'HEAD'
  headers?: Record<string, string>
  /** 応答の頭が来るまでの時間 (ミリ秒) */
  timeout?: number
  signal?: AbortSignal
}

/**
 * 1 回だけ https で要求する。URL はもう checkUrl で確かめたもの
 */
export function requestOnce(url: string, req: UpstreamRequest, options: NetOptions = {}): Promise<IncomingMessage> {
  const u = new URL(url)
  const test = testTarget(options, u.hostname)
  const headers: Record<string, string> = {
    'Host': u.host,
    'User-Agent': USER_AGENT,
    'Accept': '*/*',
    'Accept-Encoding': 'identity',
    ...req.headers,
  }
  const opts: RequestOptions = {
    protocol: 'https:',
    hostname: u.hostname,
    port: test?.port ?? (u.port || 443),
    path: u.pathname + u.search,
    method: req.method ?? 'GET',
    headers,
    lookup: safeLookup(options),
    servername: u.hostname,
    agent: test ? undefined : agent,
    rejectUnauthorized: !test,
    timeout: req.timeout ?? 15000,
    signal: req.signal,
    insecureHTTPParser: false,
    maxHeaderSize: 32 * 1024,
  }
  return new Promise((resolve, reject) => {
    const r = httpsRequest(opts, resolve)
    r.on('timeout', () => r.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })))
    r.on('error', reject)
    r.end()
  })
}

/** 転送を追った結果 */
export interface Followed {
  res: IncomingMessage
  /** 最後の URL */
  url: string
  /** 通った URL (最初を含む) */
  chain: string[]
}

export class UpstreamError extends Error {
  status: number

  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

/** 転送の行き先を調べた結果 */
export interface Resolved {
  /** 最後の URL */
  url: string
  chain: string[]
  /** 最後の応答の状態 */
  status: number
  /** 最後の URL が、origin のページに CORS を返すか (返すなら、ブラウザーが直に読める) */
  cors: boolean
  /** 最後の応答の Content-Type (主な部分、小文字) */
  type: string
}

/**
 * 転送 (URL の短縮サービスなど) の行き先を調べる。HEAD で聞き、HEAD に答えないサイトには GET の先頭 1 バイトだけを聞く
 * @param origin CORS を確かめるページの Origin
 * @param maxMillis 全体の時間
 */
export async function resolveRedirects(url: string, origin: string, options: NetOptions = {}, maxMillis = RESOLVE_MAX_MILLIS): Promise<Resolved> {
  const headers = { Origin: origin }
  const signal = AbortSignal.timeout(maxMillis)
  let f = await follow(url, { method: 'HEAD', headers, timeout: 10000, signal }, options)
  f.res.resume()
  f.res.destroy()
  let status = f.res.statusCode ?? 0
  if (status === 405 || status === 501 || status === 400 || status === 403 || status === 404) {
    f = await follow(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, timeout: 10000, signal }, options)
    f.res.destroy()
    status = f.res.statusCode ?? 0
  }
  const acao = String(f.res.headers['access-control-allow-origin'] ?? '').trim()
  const type = String(f.res.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase()
  return { url: f.url, chain: f.chain, status, cors: acao === '*' || acao === origin, type }
}

/**
 * 転送を追って読む (MarumaSign 本体の Http.download と同じく 5 回まで。行き先ごとに URL とアドレスを確かめ直す)
 */
export async function follow(url: string, req: UpstreamRequest, options: NetOptions = {}): Promise<Followed> {
  let current = checkUrl(url)
  if (!current) throw new UpstreamError('blocked url', 403)
  const chain = [current]
  for (let hop = 0; ; hop++) {
    let res: IncomingMessage
    try {
      res = await requestOnce(current, req, options)
    }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'EBLOCKED') throw new UpstreamError('blocked address', 403)
      if (code === 'ETIMEDOUT' || req.signal?.reason?.name === 'TimeoutError') throw new UpstreamError('upstream timeout', 504)
      throw new UpstreamError('upstream error: ' + (code ?? (e as Error).message), 502)
    }
    const status = res.statusCode ?? 0
    if ([301, 302, 303, 307, 308].includes(status)) {
      res.resume()
      res.destroy()
      if (hop >= MAX_REDIRECTS) throw new UpstreamError('too many redirects', 508)
      const location = res.headers.location
      if (!location) throw new UpstreamError('redirect without location', 502)
      let next: string
      try {
        next = new URL(location, current).href
      }
      catch {
        throw new UpstreamError('bad redirect', 502)
      }
      const checked = checkUrl(next)
      if (!checked) throw new UpstreamError('blocked redirect', 403)
      current = checked
      chain.push(current)
      continue
    }
    return { res, url: current, chain }
  }
}
