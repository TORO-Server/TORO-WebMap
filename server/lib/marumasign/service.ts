/*
 * /_marumasign/resolve と /_marumasign/proxy が共に使うもの (Nuxt の設定を読む)。
 *  - 看板データ (marumasign/<地図>.json) を読んで、読んでよい URL の一覧を作る (nuxt.config.ts の runtimeConfig.marumasign)
 *  - 1 つの IP からの数と量の上限、同時に読む数の上限
 *  - 再生リストをたどった URL (?p=) を確かめる
 */
import { readFile, stat } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { join, resolve, sep } from 'node:path'
import type { H3Event } from 'h3'
import { manifestRefs } from '../../../app/bluemap/marumasign/manifest.ts'
import { AllowList, signUrls } from './allow.ts'
import { classify, MAX_GLTF_PARSE_BYTES, MAX_MANIFEST_BYTES } from './kinds.ts'
import { ByteCache, Gate, limitKey, WindowLimit } from './limits.ts'
import { checkUrl, follow, UpstreamError, type NetOptions } from './net.ts'
import { extensionOf } from '../../../app/bluemap/marumasign/core.ts'

export interface MarumaSignConfig {
  enabled: boolean
  signData: string
  signDataHost: string
  maps: string[]
  refreshSeconds: number
  origins: string[]
  ipHeader: string
  testHosts: Record<string, string>
}

export function msConfig(): MarumaSignConfig {
  const c = useRuntimeConfig().marumasign as Partial<MarumaSignConfig>
  return {
    enabled: c.enabled !== false,
    signData: String(c.signData ?? ''),
    signDataHost: String(c.signDataHost ?? ''),
    maps: Array.isArray(c.maps) ? c.maps.map(String) : [],
    refreshSeconds: Number(c.refreshSeconds) > 0 ? Number(c.refreshSeconds) : 60,
    origins: Array.isArray(c.origins) ? c.origins.map(String) : [],
    ipHeader: String(c.ipHeader ?? 'cf-connecting-ip').toLowerCase(),
    testHosts: c.testHosts && typeof c.testHosts === 'object' ? c.testHosts as Record<string, string> : {},
  }
}

let warnedTest = false

export function netOptions(): NetOptions {
  const testHosts = msConfig().testHosts
  if (Object.keys(testHosts).length && !warnedTest) {
    warnedTest = true
    console.warn('marumasign: testHosts is set (test only, never in production):', Object.keys(testHosts).join(', '))
  }
  return { testHosts }
}

// ---------------------------------------------------------------- 看板データ

export const allow = new AllowList()
const MAX_DATA_BYTES = 64 * 1024 * 1024
let loadedAt = 0
let loading: Promise<void> | null = null
let everLoaded = false

function readLocal(path: string): Promise<Buffer> {
  const base = resolve(msConfig().signData)
  const file = resolve(join(base, path))
  if (!file.startsWith(base + sep)) throw new Error('bad path')
  return stat(file).then((s) => {
    if (s.size > MAX_DATA_BYTES) throw new Error('too large')
    return readFile(file)
  })
}

function readHttp(path: string): Promise<Buffer> {
  const c = msConfig()
  const url = new URL(path, c.signData.replace(/\/*$/, '/'))
  const req = url.protocol === 'https:' ? httpsRequest : httpRequest
  return new Promise((ok, fail) => {
    const r = req(url, { headers: c.signDataHost ? { Host: c.signDataHost } : {}, timeout: 10000 }, (res) => {
      if (res.statusCode !== 200) {
        res.resume()
        return fail(new Error('HTTP ' + res.statusCode + ' ' + path))
      }
      const chunks: Buffer[] = []
      let n = 0
      res.on('data', (d: Buffer) => {
        n += d.length
        if (n > MAX_DATA_BYTES) r.destroy(new Error('too large'))
        else chunks.push(d)
      })
      res.on('end', () => ok(Buffer.concat(chunks)))
      res.on('error', fail)
    })
    r.on('timeout', () => r.destroy(new Error('timeout')))
    r.on('error', fail)
    r.end()
  })
}

async function readJson(path: string): Promise<unknown> {
  const c = msConfig()
  const data = /^https?:\/\//.test(c.signData) ? await readHttp(path) : await readLocal(path)
  return JSON.parse(data.toString('utf8'))
}

async function loadSigns(): Promise<void> {
  const c = msConfig()
  let maps = c.maps
  if (!maps.length) {
    const settings = await readJson('settings.json') as { maps?: unknown }
    maps = Array.isArray(settings?.maps) ? settings.maps.filter((m): m is string => typeof m === 'string') : []
  }
  const urls = new Set<string>()
  let ok = 0
  for (const id of maps.slice(0, 64)) {
    if (!/^[\w.-]{1,64}$/.test(id)) continue
    try {
      signUrls(await readJson('marumasign/' + encodeURIComponent(id) + '.json'), urls)
      ok++
    }
    catch (e) {
      // 看板のない地図 (ファイルがない) もある
      if (!/HTTP 404|ENOENT/.test(String(e))) console.warn('marumasign: sign data', id, String(e))
    }
  }
  if (ok === 0 && maps.length) throw new Error('no sign data')
  allow.setRoots(urls)
  everLoaded = true
}

/**
 * 看板データを、古ければ読み直す (はじめて読むときは読み終わるまで待つ)
 * @param maxAge この時間 (ミリ秒) より古ければ読み直して、読み終わるまで待つ (知らない URL が来たとき。置いたばかりの看板)
 */
export async function ensureSigns(maxAge?: number): Promise<void> {
  const c = msConfig()
  const age = Date.now() - loadedAt
  if (!c.signData) return
  if (maxAge !== undefined) {
    if (age < maxAge) {
      if (loading) await loading
      return
    }
  }
  else if (age < c.refreshSeconds * 1000) return
  if (!loading) {
    loadedAt = Date.now()
    loading = loadSigns().catch((e: unknown) => {
      console.warn('marumasign: cannot read sign data:', String(e))
      // 読めなければ前のものを使い続け、少し後にやり直す
      loadedAt = Date.now() - c.refreshSeconds * 1000 + 10_000
    }).finally(() => {
      loading = null
    })
  }
  if (!everLoaded || maxAge !== undefined) await loading
}

// ---------------------------------------------------------------- 上限

const WINDOW = 10 * 60_000
/** 1 つの IP から 10 分あたり。看板の多い場所や、ライブ配信の分割されたファイルで数が増えるので多め */
export const requestLimit = new WindowLimit(WINDOW, 4000)
export const resolveLimit = new WindowLimit(WINDOW, 1500)
/** 1 つの IP から 10 分あたりに中継する量 */
export const byteLimit = new WindowLimit(WINDOW, 3 * 1024 * 1024 * 1024)
/** 全体で 10 分あたりに中継する量 (平均 160 Mbps ほど。IP をいくつ使われても、家の回線を使い切らせない) */
export const totalByteLimit = new WindowLimit(WINDOW, 12 * 1024 * 1024 * 1024)
const ALL = 'all'
/** n バイト中継したことを数える。上限を超えたら true */
export function countBytes(ip: string, n: number): boolean {
  const overIp = byteLimit.hit(ip, n)
  return totalByteLimit.hit(ALL, n) || overIp
}
/** もう中継する量の上限を超えているか */
export function overBytes(ip: string): boolean {
  return byteLimit.over(ip) || totalByteLimit.over(ALL)
}
/** 同時に元のサイトへつなぐ数 (全体、1 つの IP) */
export const gate = new Gate(64, 16)
/** 中身を覚えておく (同じ看板を何人もが見る)。1 つ 4 MB まで、合わせて 160 MB */
export const bodyCache = new ByteCache<{ bytes: number, body: Buffer, type: string, upstreamType: string, url: string, kind: string }>(160 * 1024 * 1024)
export const MAX_CACHED_BODY = 4 * 1024 * 1024

/** 上限を数える単位 (limitKey)。ブラウザーの IP の頭書きから */
export function clientIp(event: H3Event): string {
  const toroIp = getRequestHeader(event, 'x-toro-client-ip')
  if (toroIp && toroIp.trim()) return limitKey(toroIp.split(',')[0]!)
  const cfIp = getRequestHeader(event, 'cf-connecting-ip')
  if (cfIp && cfIp.trim()) return limitKey(cfIp.split(',')[0]!)
  const header = msConfig().ipHeader
  const v = header ? getRequestHeader(event, header) : undefined
  return limitKey((v ?? '').split(',')[0]!.trim() || event.node.req.socket.remoteAddress || 'unknown')
}

/**
 * 地図のページから来たか。ほかのサイトのページから (画像や動画として貼られて) 来たものは断る。
 * ブラウザーの Sec-Fetch-Site と Origin を見る
 */
export function fromMapPage(event: H3Event): boolean {
  const site = getRequestHeader(event, 'sec-fetch-site')
  const origin = getRequestHeader(event, 'origin')
  if (!site && !origin) return false
  if (site && site !== 'same-origin' && site !== 'none') return false
  if (origin && origin !== 'null') {
    const self = getRequestURL(event).origin
    if (origin !== self && !msConfig().origins.includes(origin)) return false
  }
  return true
}

/** 中継・転送の答えに付ける頭書き (返したものを、このサイトのページとして開かせない) */
export function safeHeaders(event: H3Event): void {
  setResponseHeaders(event, {
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': 'default-src \'none\'; sandbox',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'CDN-Cache-Control': 'no-store',
  })
}

export function deny(event: H3Event, status: number, message: string): string {
  setResponseStatus(event, status)
  setResponseHeader(event, 'Content-Type', 'text/plain; charset=utf-8')
  setResponseHeader(event, 'Cache-Control', 'no-store')
  return message
}

/** ?u= と ?p= の URL (checkUrl で確かめたもの)。だめなら null */
export function queryUrls(event: H3Event): { url: string, parents: string[] } | null {
  const q = getQuery(event)
  const url = typeof q.u === 'string' ? checkUrl(q.u) : null
  if (!url) return null
  const raw = q.p === undefined ? [] : Array.isArray(q.p) ? q.p : [q.p]
  if (raw.length > 3) return null
  const parents: string[] = []
  for (const p of raw) {
    const c = typeof p === 'string' ? checkUrl(p) : null
    if (!c) return null
    parents.push(c)
  }
  return { url, parents }
}

// ---------------------------------------------------------------- 再生リストをたどる (?p=)

/** 確かめるために読んだ再生リスト (同じものを何度も読まない。ライブ配信は書き換わるので短く) */
const manifestReads = new Map<string, { at: number, promise: Promise<void> }>()
const MANIFEST_READ_MILLIS = 4000
/** 再生リスト 1 つを読み終えるまでの時間 (少しずつ送ってくるサイトで、同時に読む枠を埋めさせない) */
const MANIFEST_MAX_MILLIS = 30_000

/** 再生リストなど 1 つを読んで、書かれた URL を一覧に足す */
export async function readManifest(url: string): Promise<void> {
  const hit = manifestReads.get(url)
  if (hit && Date.now() - hit.at < MANIFEST_READ_MILLIS) return hit.promise
  const leave = gate.enter('manifest')
  if (!leave) throw new UpstreamError('busy', 503)
  const promise = (async () => {
    const f = await follow(url, { timeout: 15000, signal: AbortSignal.timeout(MANIFEST_MAX_MILLIS) }, netOptions())
    for (const hop of f.chain.slice(1)) allow.addAlias(hop)
    const res = f.res
    try {
      if (res.statusCode !== 200) throw new UpstreamError('upstream ' + res.statusCode, 502)
      const chunks: Buffer[] = []
      let n = 0
      for await (const c of res as AsyncIterable<Buffer>) {
        n += c.length
        if (n > MAX_GLTF_PARSE_BYTES) throw new UpstreamError('manifest too large', 413)
        chunks.push(c)
      }
      const body = Buffer.concat(chunks)
      const kind = classify(body.subarray(0, 4096), '', extensionOf(f.url), true)
      if (!kind || !kind.manifest) return
      if (kind.manifest !== 'gltf' && body.length > MAX_MANIFEST_BYTES) return
      const refs = manifestRefs(body.toString('utf8'), f.url)
      if (refs) allow.addRefs(refs, f.url)
    }
    finally {
      res.destroy()
    }
  })().finally(leave)
  manifestReads.set(url, { at: Date.now(), promise })
  if (manifestReads.size > 2000) {
    for (const [k, v] of manifestReads) if (Date.now() - v.at > MANIFEST_READ_MILLIS) manifestReads.delete(k)
  }
  promise.catch(() => {})
  return promise
}

/**
 * 読んでよい URL か。看板の URL・その転送先・知っている再生リストに書かれた URL ならそのまま。
 * そうでなければ、parents (看板の URL からの再生リストのたどり方。ブラウザーが知らせる) を、サーバーが自分で読んで確かめる
 */
export async function isAllowed(url: string, parents: string[]): Promise<ReturnType<AllowList['allowed']>> {
  let now = allow.allowed(url)
  if (now) return now
  // 置いたばかりの看板かもしれない (看板データを 5 秒より前に読んだなら、読み直す)
  if (!parents.length || !allow.allowed(parents[0]!)) {
    await ensureSigns(5000)
    now = allow.allowed(url)
    if (now || !parents.length) return now
  }
  if (!allow.allowed(parents[0]!)) return null
  for (let i = 0; i < parents.length; i++) {
    const p = parents[i]!
    if (!allow.allowed(p)) return null
    try {
      await readManifest(p)
    }
    catch {
      return null
    }
  }
  return allow.allowed(url)
}
