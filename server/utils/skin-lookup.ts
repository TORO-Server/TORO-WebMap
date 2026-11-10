// 構造物の中のプレイヤーの頭で、名前か UUID しか書かれていないもののスキンの URL を、Mojang のサーバーに問い合わせて返す (/mcassets/skin)。
// 問い合わせる先は決まったもの (名前 → UUID は api.mojang.com、だめなら api.minecraftservices.com。UUID → textures は sessionserver.mojang.com) だけで、
// ブラウザーから受け取るのは、形を確かめた名前か UUID だけ (ホストやパスには、ほかのものを入れない)。
// 返すのは textures.minecraft.net のスキンの URL と、細い腕のモデルかどうかだけ。スキンの画像はブラウザーが textures.minecraft.net から読む
// ここは Nuxt の自動 import を使わない (試験から直接使う)
import { WindowLimit } from '../lib/marumasign/limits.ts'

export interface SkinLookup {
  /** https://textures.minecraft.net/texture/<hash>。分からなければ null (ブラウザーは Steve にする) */
  url: string | null
  slim: boolean
}

export const NAME_PATTERN = /^[A-Za-z0-9_]{1,16}$/
const UUID_PATTERN = /^[0-9a-f]{32}$/
const TEXTURE_URL = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{1,128})$/

/** 分かったものを覚えておく時間と、分からなかったもの (失敗も) を覚えておく時間 */
export const POSITIVE_MILLIS = 60 * 60_000
export const NEGATIVE_MILLIS = 10 * 60_000
const CACHE_SIZE = 4096
/** Mojang のサーバーに同時に問い合わせる数と、待たせる数 */
const MAX_UPSTREAM = 4
const MAX_WAITING = 64
const TIMEOUT_MILLIS = 5000
const MAX_RESPONSE_BYTES = 64 * 1024
/** 1 つの IP から、10 分あたりに受け付ける数 (覚えているものを返すだけのもの) と、そのうち Mojang に問い合わせる数 */
const WINDOW_MILLIS = 10 * 60_000
const IP_REQUESTS = 600
const IP_LOOKUPS = 60

/** UUID (区切りありでもなしでも) を 32 桁の小文字にする。形が違えば null */
export function normalizeUuid(value: string): string | null {
  const v = value.trim().toLowerCase()
  const plain = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(v) ? v.replaceAll('-', '') : v
  return UUID_PATTERN.test(plain) ? plain : null
}

/** textures の値 (base64 の JSON) から、スキンの URL とモデル */
export function texturesToSkin(textures: string): SkinLookup {
  try {
    const json = JSON.parse(Buffer.from(textures, 'base64').toString('utf8')) as { textures?: { SKIN?: { url?: unknown, metadata?: { model?: unknown } } } }
    const skin = json?.textures?.SKIN
    const m = typeof skin?.url === 'string' ? TEXTURE_URL.exec(skin.url) : null
    if (!m) return { url: null, slim: false }
    return { url: 'https://textures.minecraft.net/texture/' + m[1], slim: skin?.metadata?.model === 'slim' }
  }
  catch {
    return { url: null, slim: false }
  }
}

export type Fetcher = (url: string, init: RequestInit) => Promise<Response>

export class SkinResolver {
  private readonly cache = new Map<string, { until: number, value: SkinLookup }>()
  private readonly inflight = new Map<string, Promise<SkinLookup>>()
  private readonly requests = new WindowLimit(WINDOW_MILLIS, IP_REQUESTS)
  private readonly lookups = new WindowLimit(WINDOW_MILLIS, IP_LOOKUPS)
  private running = 0
  private readonly waiters: (() => void)[] = []
  private readonly fetcher: Fetcher
  upstreamCalls = 0

  constructor(fetcher: Fetcher = (url, init) => fetch(url, init)) {
    this.fetcher = fetcher
  }

  /** 1 つの IP の数を数える。多すぎれば false */
  private allow(ip: string, lookup: boolean): boolean {
    return !(lookup ? this.lookups : this.requests).hit(ip)
  }

  private remember(key: string, value: SkinLookup): void {
    this.cache.delete(key)
    this.cache.set(key, { until: Date.now() + (value.url ? POSITIVE_MILLIS : NEGATIVE_MILLIS), value })
    while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value!)
  }

  /**
   * 名前か UUID のスキン。'rate' (その IP からの数が多すぎる) か 'busy' (問い合わせが混んでいる) なら、その文字列
   * @param query { name } か { uuid } (呼ぶ側で形を確かめたもの)
   */
  async resolve(query: { name: string } | { uuid: string }, ip: string): Promise<SkinLookup | 'rate' | 'busy'> {
    const key = 'name' in query ? 'n:' + query.name.toLowerCase() : 'u:' + query.uuid
    if (!this.allow(ip, false)) return 'rate'
    const hit = this.cache.get(key)
    if (hit && hit.until > Date.now()) {
      // 最近使ったものを後ろへ (古いものから消す)
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit.value
    }
    let p = this.inflight.get(key)
    if (!p) {
      if (!this.allow(ip, true)) return 'rate'
      if (this.running >= MAX_UPSTREAM && this.waiters.length >= MAX_WAITING) return 'busy'
      p = this.lookup(query).then((value) => {
        this.remember(key, value)
        return value
      }, () => {
        // 失敗も 10 分は覚えておく (Mojang のサーバーに何度も問い合わせない)
        const value = { url: null, slim: false }
        this.remember(key, value)
        return value
      }).finally(() => this.inflight.delete(key))
      this.inflight.set(key, p)
    }
    return p
  }

  private async lookup(query: { name: string } | { uuid: string }): Promise<SkinLookup> {
    let uuid: string | null = 'uuid' in query ? query.uuid : null
    if (!uuid) {
      const name = (query as { name: string }).name
      if (!NAME_PATTERN.test(name)) return { url: null, slim: false }
      let profile: unknown
      try {
        profile = await this.get('https://api.mojang.com/users/profiles/minecraft/' + name)
      }
      catch {
        profile = await this.get('https://api.minecraftservices.com/minecraft/profile/lookup/name/' + name)
      }
      const id = profile && typeof (profile as { id?: unknown }).id === 'string' ? normalizeUuid((profile as { id: string }).id) : null
      if (!id) return { url: null, slim: false }
      uuid = id
    }
    if (!UUID_PATTERN.test(uuid)) return { url: null, slim: false }
    const session = await this.get('https://sessionserver.mojang.com/session/minecraft/profile/' + uuid) as { properties?: unknown } | null
    const properties = session && Array.isArray(session.properties) ? session.properties : []
    for (const p of properties) {
      if (p && typeof p === 'object' && (p as { name?: unknown }).name === 'textures' && typeof (p as { value?: unknown }).value === 'string') {
        return texturesToSkin((p as { value: string }).value)
      }
    }
    return { url: null, slim: false }
  }

  /** 決まった URL を GET する (Cookie なし、転送は追わない、時間切れあり)。見つからなければ null */
  private async get(url: string): Promise<unknown> {
    if (this.running >= MAX_UPSTREAM) {
      if (this.waiters.length >= MAX_WAITING) throw new Error('busy')
      await new Promise<void>(resolve => this.waiters.push(resolve))
    }
    this.running++
    this.upstreamCalls++
    try {
      const res = await this.fetcher(url, {
        redirect: 'error', credentials: 'omit', signal: AbortSignal.timeout(TIMEOUT_MILLIS),
        headers: { 'accept': 'application/json', 'user-agent': 'toro-webmap (3d-map.torosaba.net)' },
      })
      if (res.status === 204 || res.status === 404) return null
      if (!res.ok) throw new Error('HTTP ' + res.status)
      const len = Number(res.headers.get('content-length') ?? '0')
      if (len > MAX_RESPONSE_BYTES) throw new Error('too large')
      const body = Buffer.from(await res.arrayBuffer())
      if (body.length > MAX_RESPONSE_BYTES) throw new Error('too large')
      return body.length ? JSON.parse(body.toString('utf8')) : null
    }
    finally {
      this.running--
      this.waiters.shift()?.()
    }
  }
}
