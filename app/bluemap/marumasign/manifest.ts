/*
 * 再生リスト (HLS の .m3u8、MPEG-DASH の .mpd) と glTF (.gltf) に書かれた、ほかのファイルの URL を取り出す。
 * ブラウザー (sources/streams.ts) とサーバー (server/lib/marumasign/) の両方で使う。xml-head.ts のほかは何も import しない (Node の試験でも動かす)。
 *
 * サーバーの中継 (/_marumasign/proxy) は、看板に書かれた URL と、そこから再生リストなどでたどれる URL だけを読む。
 * そのために、たどった先の URL をここで決める (書かれていない URL は読まない)。
 *
 * 中身は外のサーバーが決めるもので、サーバーの主スレッドで読む。大きな本文でも止まらないよう、正規表現の後戻りが増える書き方をしない。
 * 読む手間は本文の長さに比例し、URL の形を確かめる手間は URL の長さに比例する (MAX_SLOTS と MAX_ID_LENGTH で頭打ち)
 */
import { startsAfterXmlHead } from './xml-head.ts'

/** 1 つの再生リストなどから取り出す URL の数の上限 */
export const MAX_CHILDREN = 20000
/** MPEG-DASH の SegmentTemplate (番号や時刻で URL が決まる) の数の上限 */
export const MAX_PATTERNS = 256
/** SegmentTemplate 1 つの置き換える部分の数の上限 ($RepresentationID$ $Number$ $Time$ $Bandwidth$ $SubNumber$ が 1 つずつ) */
export const MAX_SLOTS = 5
/** Representation の id の数と長さの上限 */
export const MAX_IDS = 256
export const MAX_ID_LENGTH = 128
/** 読むのをやめる行の数 (HLS) と字句の数・入れ子の深さ (XML)。普通の再生リストはずっと少ない */
const MAX_LINES = 200000
const MAX_TOKENS = 200000
const MAX_DEPTH = 64
/** タグ 1 つの属性と BaseURL の文字の上限 (URL は 4000 文字までなので、これより長いものは使わない) */
const MAX_ATTRS = 64
const MAX_BASE_TEXT = 8192

/** 置き換える部分の種類: id は Representation の id のどれか、num は数字、any は id が分からないときの「/ ? # 以外」 */
export type UrlSlot = 'id' | 'num' | 'any'

/**
 * 番号などで決まる URL の形 (MPEG-DASH の SegmentTemplate)。
 * parts[0], slots[0], parts[1], slots[1], ... parts[n] の順に並ぶ (parts は slots より 1 つ多い)。真ん中の parts は空でない。
 * 外から来たものから正規表現を作らない (matchPattern が前から確かめる)
 */
export interface UrlPattern {
  parts: string[]
  slots: UrlSlot[]
  /** Representation の id (同じ MPD の形で同じものを使う) */
  ids: ReadonlySet<string>
  /** id の長さの種類 (長い順) */
  idLengths: readonly number[]
}

/** 取り出した URL */
export interface ManifestRefs {
  /** そのまま書かれた URL (絶対 URL、「#」から後ろは除く) */
  urls: string[]
  /** 番号などで決まる URL の形 (MPEG-DASH の SegmentTemplate) */
  patterns: UrlPattern[]
  /** 次も再生リスト (HLS の各画質の .m3u8) かもしれない URL */
  playlists: string[]
}

/** http(s) の絶対 URL にする (「#」から後ろは除く)。ほかの形式 (data: など) や壊れたものは null */
export function resolveRef(ref: string, base: string): string | null {
  const s = ref.trim()
  if (!s || s.length > 4000) return null
  let u: URL
  try {
    u = new URL(s, base)
  }
  catch {
    return null
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
  u.hash = ''
  return u.href
}

function push(list: string[], seen: Set<string>, url: string | null): void {
  if (!url || seen.has(url) || list.length >= MAX_CHILDREN) return
  seen.add(url)
  list.push(url)
}

/** 先頭が HLS の再生リストか */
export function isHls(text: string): boolean {
  return /^(﻿)?\s*#EXTM3U/.test(text)
}

const MPD_TAG = /<MPD[\s>]/y

/** 先頭が MPEG-DASH の MPD か */
export function isDash(text: string): boolean {
  return startsAfterXmlHead(text, MPD_TAG, { decl: true, doctype: true })
}

/**
 * HLS の再生リストに書かれた URL。
 * タグでない行 (分割されたファイルや、各画質の再生リスト) と、タグの URI="..." (EXT-X-KEY, EXT-X-MAP, EXT-X-MEDIA など)
 * @param base 再生リストの URL (転送されたなら、最後の URL)
 */
export function hlsRefs(text: string, base: string): ManifestRefs {
  const urls: string[] = []
  const playlists: string[] = []
  const seen = new Set<string>()
  let nextIsPlaylist = false
  // 上限まで読めばよいので、全体を行に分けておかない
  let next = 0
  for (let lines = 0; next <= text.length && lines < MAX_LINES && urls.length < MAX_CHILDREN; lines++) {
    let end = text.indexOf('\n', next)
    if (end < 0) end = text.length
    const line = text.slice(next, end).trim()
    next = end + 1
    if (!line) continue
    if (line.startsWith('#')) {
      if (/^#EXT-X-STREAM-INF:/i.test(line)) nextIsPlaylist = true
      const isMedia = /^#EXT-X-(MEDIA|I-FRAME-STREAM-INF|RENDITION-REPORT):/i.test(line)
      for (const m of line.matchAll(/(?:^|[,:])(?:URI|SERVER-URI)="([^"]*)"/gi)) {
        const u = resolveRef(m[1]!, base)
        push(urls, seen, u)
        if (u && isMedia && playlists.length < MAX_CHILDREN) playlists.push(u)
      }
      continue
    }
    const u = resolveRef(line, base)
    push(urls, seen, u)
    if (u && nextIsPlaylist && playlists.length < MAX_CHILDREN) playlists.push(u)
    nextIsPlaylist = false
  }
  return { urls, patterns: [], playlists }
}

// ---------------------------------------------------------------- MPEG-DASH

function decodeXml(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|apos|#x[0-9a-fA-F]+|#[0-9]+);/g, (_m, e: string) => {
    switch (e) {
      case 'lt': return '<'
      case 'gt': return '>'
      case 'amp': return '&'
      case 'quot': return '"'
      case 'apos': return '\''
      default: {
        const n = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : ''
      }
    }
  })
}

/** XML の字句 1 つ (text は文字の参照を解く前。cdata はそのままの文字) */
type XmlToken =
  | { kind: 'text' | 'cdata', text: string }
  | { kind: 'open' | 'close', name: string, attrs: Map<string, string>, empty: boolean }

function isXmlSpace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0A || c === 0x0D
}

function isNameStart(c: number): boolean {
  return (c >= 0x41 && c <= 0x5A) || (c >= 0x61 && c <= 0x7A) || c === 0x5F
}

function isNameChar(c: number): boolean {
  return isNameStart(c) || (c >= 0x30 && c <= 0x39) || c === 0x3A || c === 0x2E || c === 0x2D
}

/** 名前空間の接頭辞は外す (xlink:href など) */
function localName(name: string): string {
  return name.slice(name.lastIndexOf(':') + 1)
}

function skipXmlSpace(xml: string, from: number): number {
  let at = from
  while (at < xml.length && isXmlSpace(xml.charCodeAt(at))) at++
  return at
}

/**
 * XML を前から 1 度だけ読んで、字句に分ける。位置は戻らないので、手間は本文の長さに比例する。
 * 閉じていないコメントなどや引用符があれば、そこで読むのをやめる。タグの形が崩れていれば、そこまでを飛ばして続ける
 */
function* xmlTokens(xml: string): Generator<XmlToken> {
  let at = 0
  while (at < xml.length) {
    const lt = xml.indexOf('<', at)
    if (lt !== at) {
      const end = lt < 0 ? xml.length : lt
      yield { kind: 'text', text: xml.slice(at, end) }
      at = end
      continue
    }
    if (xml.startsWith('<!--', at)) {
      const end = xml.indexOf('-->', at + 4)
      if (end < 0) return
      at = end + 3
      continue
    }
    if (xml.startsWith('<![CDATA[', at)) {
      const end = xml.indexOf(']]>', at + 9)
      if (end < 0) return
      yield { kind: 'cdata', text: xml.slice(at + 9, end) }
      at = end + 3
      continue
    }
    if (xml.startsWith('<?', at)) {
      const end = xml.indexOf('?>', at + 2)
      if (end < 0) return
      at = end + 2
      continue
    }
    if (xml.startsWith('<!DOCTYPE', at)) {
      const end = xml.indexOf('>', at)
      if (end < 0) return
      at = end + 1
      continue
    }
    // タグ
    let p = at + 1
    const closing = xml[p] === '/'
    if (closing) p++
    const nameStart = p
    if (p >= xml.length || !isNameStart(xml.charCodeAt(p))) {
      at = p
      continue
    }
    while (p < xml.length && isNameChar(xml.charCodeAt(p))) p++
    const name = localName(xml.slice(nameStart, p))
    const attrs = new Map<string, string>()
    let done = false
    let empty = false
    while (!done) {
      const before = p
      p = skipXmlSpace(xml, p)
      if (p >= xml.length) return
      if (xml[p] === '>') {
        p++
        done = true
        break
      }
      if (xml[p] === '/' && xml[p + 1] === '>') {
        p += 2
        empty = true
        done = true
        break
      }
      // 属性の前には空白が要る
      if (p === before) break
      const attrStart = p
      while (p < xml.length && !isXmlSpace(xml.charCodeAt(p)) && !'=>/<"\''.includes(xml[p]!)) p++
      if (p === attrStart) break
      const attrName = xml.slice(attrStart, p)
      p = skipXmlSpace(xml, p)
      if (xml[p] !== '=') break
      p = skipXmlSpace(xml, p + 1)
      const quote = xml[p]
      if (quote !== '"' && quote !== '\'') break
      const close = xml.indexOf(quote, p + 1)
      if (close < 0) return
      if (attrs.size < MAX_ATTRS && isNameStart(attrName.charCodeAt(0))) attrs.set(localName(attrName), decodeXml(xml.slice(p + 1, close)))
      p = close + 1
    }
    // 崩れたタグは飛ばす (見たところには戻らない)
    if (done) yield { kind: closing ? 'close' : 'open', name, attrs, empty }
    at = Math.max(p, at + 1)
  }
}

interface Element {
  name: string
  base: string
  /** この中の BaseURL の文字 (読み終えたら base を決める) */
  text: string
}

/** SegmentTemplate 1 つを URL の形にする。置き換える部分がなければ、その URL。使えないものは null */
function templatePattern(template: string, base: string, ids: ReadonlySet<string>, idLengths: readonly number[]): UrlPattern | string | null {
  // 置き換える部分を、URL として解決しても変わらない目印にしてから解決する
  const marks: string[] = []
  const marked = template.replace(/\$(RepresentationID|Number|Time|Bandwidth|SubNumber)(%0?\d*[dxXo])?\$|\$\$/g, (s) => {
    marks.push(s)
    return 'MSMARK' + (marks.length - 1) + 'X'
  })
  const u = resolveRef(marked, base)
  if (!u) return null
  const parts: string[] = []
  const slots: UrlSlot[] = []
  let text = ''
  let last = 0
  for (const m of u.matchAll(/MSMARK(\d+)X/g)) {
    const mark = marks[Number(m[1])]
    if (mark === undefined) return null
    text += u.slice(last, m.index)
    last = m.index + m[0].length
    if (mark === '$$') {
      text += '$'
      continue
    }
    // 置き換える部分が隣り合うものは、区切りが決まらないので使わない
    if (slots.length > 0 && text === '') return null
    parts.push(text)
    text = ''
    slots.push(mark.startsWith('$RepresentationID') ? (ids.size ? 'id' : 'any') : 'num')
    if (slots.length > MAX_SLOTS) return null
  }
  parts.push(text + u.slice(last))
  if (!slots.length) return parts[0]!
  // 置き換える部分はパスより後ろだけ
  if (!parts[0]!.startsWith(new URL(u).origin + '/')) return null
  return { parts, slots, ids, idLengths }
}

/**
 * MPEG-DASH の MPD に書かれた URL と、SegmentTemplate から決まる URL の形。
 * BaseURL は入れ子ごとに解決する。$RepresentationID$ は MPD にある Representation の id のどれか、
 * $Number$ $Time$ $Bandwidth$ $SubNumber$ は数字 (%05d のような書式つきも)
 * @param base MPD の URL (転送されたなら、最後の URL)
 */
export function dashRefs(xml: string, base: string): ManifestRefs {
  const urls: string[] = []
  const seen = new Set<string>()
  const templates: { template: string, base: string }[] = []
  const ids = new Set<string>()
  const stack: Element[] = [{ name: '#root', base, text: '' }]
  let count = 0
  for (const t of xmlTokens(xml)) {
    if (++count > MAX_TOKENS) break
    const top = stack[stack.length - 1]!
    if ('text' in t) {
      // 文字 (BaseURL の中身だけを使う)
      if (top.name === 'BaseURL' && top.text.length < MAX_BASE_TEXT) {
        const text = t.text.slice(0, MAX_BASE_TEXT)
        top.text += t.kind === 'text' ? decodeXml(text) : text
      }
      continue
    }
    if (t.kind === 'close') {
      let i = stack.length - 1
      while (i > 0 && stack[i]!.name !== t.name) i--
      if (i <= 0) continue
      const closed = stack[i]!
      stack.length = i
      if (closed.name === 'BaseURL') {
        const parent = stack[stack.length - 1]!
        const u = resolveRef(closed.text, parent.base)
        if (u) parent.base = u
      }
      continue
    }
    const { name, attrs: a } = t
    const inherited = top.base
    if (name === 'Representation') {
      const id = a.get('id')
      if (id && id.length <= MAX_ID_LENGTH && ids.size < MAX_IDS) ids.add(id)
    }
    const add = (value: string | undefined): void => {
      if (!value) return
      if (value.includes('$')) {
        if (templates.length < MAX_PATTERNS) templates.push({ template: value, base: inherited })
      }
      else if (urls.length < MAX_CHILDREN) {
        push(urls, seen, resolveRef(value, inherited))
      }
    }
    if (name === 'SegmentTemplate') {
      add(a.get('media'))
      add(a.get('initialization'))
      add(a.get('index'))
    }
    else if (name === 'SegmentURL') {
      add(a.get('media'))
      add(a.get('index'))
    }
    else if (name === 'Initialization' || name === 'RepresentationIndex') {
      add(a.get('sourceURL'))
    }
    else if (name === 'Location' || name === 'PatchLocation') {
      // 文字で書かれるが、ここでは使わない (MPD を読み直す先。読むなら看板の URL と同じ扱いにならないので読まない)
    }
    if (!t.empty) {
      if (stack.length >= MAX_DEPTH) break
      stack.push({ name, base: inherited, text: '' })
    }
    // SegmentTemplate などの入れ子の base は親と同じ。BaseURL が来たら閉じるときに親を変える
  }
  const patterns: UrlPattern[] = []
  const idLengths = [...new Set(Array.from(ids, id => id.length))].sort((a, b) => b - a)
  for (const t of templates) {
    const p = templatePattern(t.template, t.base, ids, idLengths)
    if (typeof p === 'string') push(urls, seen, p)
    else if (p) patterns.push(p)
  }
  return { urls, patterns, playlists: [] }
}

/** url の前と後ろが、形の固定の部分に合うか (ここで落ちるものがほとんどなので先に見る) */
export function patternEdgesMatch(p: UrlPattern, url: string): boolean {
  const first = p.parts[0]!
  const last = p.parts[p.slots.length]!
  return url.length >= first.length + last.length && url.startsWith(first) && url.endsWith(last)
}

function isDigit(c: number): boolean {
  return c >= 0x30 && c <= 0x39
}

function leadingDigits(s: string): number {
  let n = 0
  while (n < s.length && isDigit(s.charCodeAt(n))) n++
  return n
}

/**
 * 置き換える部分の終わりの位置。合わなければ -1。
 * @param next 次の固定の部分。最後の置き換える部分なら null (stop まで全部)
 */
function slotEnd(p: UrlPattern, slot: UrlSlot, url: string, at: number, stop: number, next: string | null): number {
  const fits = (end: number): boolean => next === null ? end === stop : url.startsWith(next, end)
  if (slot === 'num') {
    let end = at
    while (end < stop && isDigit(url.charCodeAt(end))) end++
    // 次の固定の部分が数字で始まるなら、その分を戻す
    if (next !== null) end -= leadingDigits(next)
    return end > at && end - at <= 20 && fits(end) ? end : -1
  }
  if (slot === 'id') {
    // 長い id から試す (ほかの id で始まる id があっても、次の固定の部分まで合うものを選ぶ)
    for (const length of p.idLengths) {
      const end = at + length
      if (end <= stop && p.ids.has(url.slice(at, end)) && fits(end)) return end
    }
    return -1
  }
  const end = next === null ? stop : url.indexOf(next, at)
  if (end < 0 || end > stop) return -1
  for (let i = at; i < end; i++) {
    const c = url.charCodeAt(i)
    if (c === 0x2F || c === 0x3F || c === 0x23) return -1
  }
  return end
}

/** url が形に合うか。前から 1 度だけ見て戻らない */
export function matchPattern(p: UrlPattern, url: string): boolean {
  if (!patternEdgesMatch(p, url)) return false
  const count = p.slots.length
  const stop = url.length - p.parts[count]!.length
  let at = p.parts[0]!.length
  for (let i = 0; i < count; i++) {
    const next = i === count - 1 ? null : p.parts[i + 1]!
    const end = slotEnd(p, p.slots[i]!, url, at, stop, next)
    if (end < 0) return false
    at = end + (next?.length ?? 0)
  }
  return at === stop
}

// ---------------------------------------------------------------- glTF

/**
 * .gltf (JSON) が参照するファイル (buffers と images の uri)。data: の URL は除く
 * @param base .gltf の URL
 */
export function gltfRefs(json: string, base: string): ManifestRefs {
  const urls: string[] = []
  const seen = new Set<string>()
  let data: unknown
  try {
    data = JSON.parse(json.replace(/^﻿/, ''))
  }
  catch {
    return { urls, patterns: [], playlists: [] }
  }
  const d = data as { buffers?: unknown, images?: unknown }
  for (const list of [d.buffers, d.images]) {
    if (!Array.isArray(list)) continue
    for (const item of list) {
      if (urls.length >= MAX_CHILDREN) break
      const uri = item && typeof item === 'object' ? (item as { uri?: unknown }).uri : undefined
      if (typeof uri !== 'string' || /^data:/i.test(uri)) continue
      push(urls, seen, resolveRef(uri, base))
    }
  }
  return { urls, patterns: [], playlists: [] }
}

/**
 * 本文から種類を見分けて、参照している URL を取り出す。再生リストでも glTF でもなければ null
 * @param base その本文の URL (転送されたなら、最後の URL)
 */
export function manifestRefs(text: string, base: string): ManifestRefs | null {
  if (isHls(text)) return hlsRefs(text, base)
  if (isDash(text)) return dashRefs(text, base)
  if (/^(﻿)?\s*\{/.test(text) && /"asset"\s*:/.test(text)) return gltfRefs(text, base)
  return null
}

/** url が refs に書かれているか (番号などで決まる形も見る) */
export function refsInclude(refs: ManifestRefs, url: string): boolean {
  return refs.urls.includes(url) || refs.patterns.some(p => matchPattern(p, url))
}
