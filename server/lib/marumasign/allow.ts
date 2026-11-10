/*
 * サーバーが看板のために読んでよい URL の一覧 (/_marumasign/resolve と /_marumasign/proxy がただの中継にならないように)。
 *  - 看板に書かれた URL (marumasign/<地図>.json にいまあるもの)
 *  - その転送の行き先 (サーバーが自分で追って確かめたもの)
 *  - それらの再生リスト (HLS, MPEG-DASH) と .gltf に書かれた URL (サーバーが自分で読んで取り出したもの)。
 *    再生リストと別のサイトのものは、中継できる中身をさらに絞る (kinds.ts の classify)
 * Nuxt に頼らない (Node の試験でも動かす)
 */
import { safeUrl, withoutFragment } from '../../../app/bluemap/marumasign/core.ts'
import { matchPattern, patternEdgesMatch, type ManifestRefs, type UrlPattern } from '../../../app/bluemap/marumasign/manifest.ts'

/** 看板データ 1 つ (marumasign/<地図>.json) から、読むかもしれない URL (https のもの、「#」を除く) */
export function signUrls(data: unknown, into: Set<string> = new Set()): Set<string> {
  const json = data as { format?: unknown, signs?: unknown }
  if (!json || json.format !== 1 || !Array.isArray(json.signs)) return into
  for (const raw of json.signs as unknown[]) {
    if (!Array.isArray(raw) || raw.length < 7) continue
    for (const v of [raw[5], raw[6]]) {
      const u = safeUrl(v, true)
      if (u) into.add(withoutFragment(u))
    }
  }
  return into
}

/** 取り出した URL を覚えておく時間 (ミリ秒) */
export const CHILD_TTL = 10 * 60_000
export const ALIAS_TTL = 30 * 60_000
const MAX_CHILDREN = 200_000
const MAX_ALIASES = 50_000
/** 覚えておく URL の形の数 (全体と、1 つのオリジンごと) */
const MAX_PATTERNS = 1000
const MAX_PATTERNS_PER_ORIGIN = 256
/** 1 つの URL について、前と後ろが合った形をいくつまで詳しく確かめるか (主スレッドで確かめる手間の上限。普通の MPD はずっと少ない) */
const MAX_PATTERN_TRIES = 16

/** 読んでよい理由。child は看板やその再生リストと同じサイト、foreign は再生リストと別のサイトに書かれていたもの */
export type Allowed = 'root' | 'alias' | 'child' | 'foreign' | null

/** URL のスキームとホスト (確かめた URL だけを渡す。new URL より軽い) */
function originOf(url: string): string {
  const slash = url.indexOf('/', url.indexOf('://') + 3)
  return slash < 0 ? url : url.slice(0, slash)
}

/**
 * 共有ホスティングの公開接尾辞 (借り手ごとにホスト名が分かれるもの)。
 * 公開接尾辞の全体の一覧 (Public Suffix List) は持たないが、よく知られたものだけを挙げる。
 * ここに挙げた接尾辞では、借り手の段までをサイトとする (借り手が違うと別のサイト)
 */
const SHARED_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'codeberg.page',
  'pages.dev', 'workers.dev', 'netlify.app', 'vercel.app', 'herokuapp.com',
  'firebaseapp.com', 'web.app', 'azurewebsites.net', 'glitch.me', 'surge.sh',
  'deno.dev', 'fly.dev', 'onrender.com', 'hf.space', 'pythonanywhere.com',
  'streamlit.app', 'repl.co', 'replit.app',
])

/**
 * URL のサイト (登録できるドメイン)。公開接尾辞の一覧は持たないので、co.jp や com.au のような 2 段のものだけを見分ける。
 * 共有ホスティング (SHARED_SUFFIXES) では、借り手の段までをサイトとする。
 * 間違えても、別のサイトと見たものは中継できる中身が絞られ、同じサイトと見たものは大きさの上限が変わるだけ
 */
export function siteOf(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname
  }
  catch {
    return url
  }
  const labels = host.split('.')
  if (labels.length <= 2) return host
  const short = labels[labels.length - 1]!.length === 2 && labels[labels.length - 2]!.length <= 3
  let take = short ? 3 : 2
  if (SHARED_SUFFIXES.has(labels.slice(-take).join('.'))) take++
  return labels.slice(-take).join('.')
}

function patternKey(p: UrlPattern): string {
  return JSON.stringify([p.parts, p.slots, [...p.ids]])
}

export class AllowList {
  private roots = new Set<string>()
  private readonly aliases = new Map<string, number>()
  private readonly children = new Map<string, number>()
  private readonly foreign = new Map<string, number>()
  private readonly patterns = new Map<string, Map<string, { pattern: UrlPattern, until: number, foreign: boolean }>>()
  private patternCount = 0
  now: () => number = Date.now

  /** 看板に書かれた URL を入れ替える (看板データを読み直したとき) */
  setRoots(urls: Set<string>): void {
    this.roots = urls
  }

  get rootCount(): number {
    return this.roots.size
  }

  isRoot(url: string): boolean {
    return this.roots.has(url)
  }

  /** 看板の URL (か、その行き先) から転送された先 */
  addAlias(url: string): void {
    this.aliases.delete(url)
    this.aliases.set(url, this.now() + ALIAS_TTL)
    trim(this.aliases, MAX_ALIASES)
  }

  /**
   * 読んでよいと分かっている再生リストなどに書かれていた URL
   * @param parent その再生リストなどの URL (転送されたなら、最後の URL)
   */
  addRefs(refs: ManifestRefs, parent: string): void {
    const until = this.now() + CHILD_TTL
    const site = siteOf(parent)
    // オリジンごとに 1 度だけ調べる
    const sameSite = new Map<string, boolean>()
    const isSameSite = (url: string): boolean => {
      const origin = originOf(url)
      let same = sameSite.get(origin)
      if (same === undefined) {
        same = siteOf(url) === site
        sameSite.set(origin, same)
      }
      return same
    }
    for (const u of refs.urls) {
      const list = isSameSite(u) ? this.children : this.foreign
      list.delete(u)
      list.set(u, until)
    }
    trim(this.children, MAX_CHILDREN)
    trim(this.foreign, MAX_CHILDREN)
    for (const p of refs.patterns) {
      const first = p.parts[0]!
      const origin = originOf(first)
      const foreign = !isSameSite(first)
      let list = this.patterns.get(origin)
      if (!list) this.patterns.set(origin, list = new Map())
      const key = patternKey(p)
      const old = list.get(key)
      if (old) {
        old.until = until
        old.foreign &&= foreign
        continue
      }
      list.set(key, { pattern: p, until, foreign })
      this.patternCount++
      if (list.size > MAX_PATTERNS_PER_ORIGIN) {
        list.delete(list.keys().next().value!)
        this.patternCount--
      }
    }
    if (this.patternCount > MAX_PATTERNS) this.trimPatterns()
  }

  private trimPatterns(): void {
    const now = this.now()
    for (const [origin, list] of this.patterns) {
      for (const [k, v] of list) {
        if (v.until < now) {
          list.delete(k)
          this.patternCount--
        }
      }
      if (!list.size) this.patterns.delete(origin)
    }
    // 古くからあるオリジンのものから消す (消したものは、再生リストを読み直せばまた入る)
    for (const [origin, list] of this.patterns) {
      for (const k of list.keys()) {
        if (this.patternCount <= MAX_PATTERNS) return
        list.delete(k)
        this.patternCount--
      }
      this.patterns.delete(origin)
    }
  }

  /** 読んでよいか (どの理由で) */
  allowed(url: string): Allowed {
    if (this.roots.has(url)) return 'root'
    const now = this.now()
    const a = this.aliases.get(url)
    if (a !== undefined && a > now) return 'alias'
    const c = this.children.get(url)
    if (c !== undefined && c > now) return 'child'
    const f = this.foreign.get(url)
    if (f !== undefined && f > now) return 'foreign'
    const list = this.patterns.get(originOf(url))
    if (!list) return null
    let tries = 0
    for (const p of list.values()) {
      if (p.until <= now || !patternEdgesMatch(p.pattern, url)) continue
      if (++tries > MAX_PATTERN_TRIES) return null
      if (matchPattern(p.pattern, url)) return p.foreign ? 'foreign' : 'child'
    }
    return null
  }
}

function trim(map: Map<string, number>, max: number): void {
  if (map.size <= max) return
  const now = Date.now()
  for (const [k, v] of map) {
    if (map.size <= max) return
    if (v < now) map.delete(k)
  }
  while (map.size > max) map.delete(map.keys().next().value!)
}
