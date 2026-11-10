// 数と量の上限 (1 つの IP からの数・量、同時に読む数) と、読んだものの置き場 (古いものから消す)。Nuxt に頼らない
import { ipBytes } from './net.ts'

/**
 * 上限を数える単位。IPv6 は /64 にまとめる (1 つの回線に /64 が丸ごと割り当てられるので、/128 で数えても意味がない)。
 * IPv4 を写した IPv6 は IPv4 と同じ。IP アドレスでないものはそのまま
 */
export function limitKey(ip: string): string {
  const b = ipBytes(ip)
  if (!b) return ip.trim().slice(0, 64)
  if (b.length === 4) return b.join('.')
  if (b.slice(0, 10).every(x => x === 0) && b[10] === 0xFF && b[11] === 0xFF) return b.slice(12).join('.')
  return b.slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('') + '/64'
}

/** 数える鍵の数の上限 (ばらばらの鍵でメモリを増やさせない。超えたら古いものから忘れる) */
const MAX_KEYS = 50_000
/** 時間の過ぎたものをまとめて消す間隔 (鍵が増え続けても、毎回全部を見ない) */
const SWEEP_MILLIS = 10_000

/** 決まった時間ごとの数の上限 (時間ごとに数え直す) */
export class WindowLimit {
  private readonly counts = new Map<string, { start: number, n: number }>()
  private sweptAt = 0
  readonly window: number
  readonly limit: number
  readonly maxKeys: number
  now: () => number = Date.now

  constructor(windowMillis: number, limit: number, maxKeys = MAX_KEYS) {
    this.window = windowMillis
    this.limit = limit
    this.maxKeys = maxKeys
  }

  /** n 足して、上限を超えたら true */
  hit(key: string, n = 1): boolean {
    const c = this.entry(key)
    c.n += n
    return c.n > this.limit
  }

  /** 足さずに、もう上限を超えているか */
  over(key: string): boolean {
    return this.entry(key).n > this.limit
  }

  private entry(key: string): { start: number, n: number } {
    const now = this.now()
    let c = this.counts.get(key)
    if (!c || now - c.start > this.window) {
      c = { start: now, n: 0 }
      this.counts.set(key, c)
      if (this.counts.size > this.maxKeys) {
        if (now - this.sweptAt > SWEEP_MILLIS) {
          this.sweptAt = now
          for (const [k, v] of this.counts) if (now - v.start > this.window) this.counts.delete(k)
        }
        while (this.counts.size > this.maxKeys) this.counts.delete(this.counts.keys().next().value!)
      }
    }
    return c
  }

  get size(): number {
    return this.counts.size
  }
}

/** 同時に行う数の上限 (空くのを待たずに断る) */
export class Gate {
  private readonly running = new Map<string, number>()
  private total = 0
  readonly max: number
  readonly maxPerKey: number

  constructor(max: number, maxPerKey: number) {
    this.max = max
    this.maxPerKey = maxPerKey
  }

  /** 入れたら、出るときに呼ぶものを返す。いっぱいなら null */
  enter(key: string): (() => void) | null {
    const n = this.running.get(key) ?? 0
    if (this.total >= this.max || n >= this.maxPerKey) return null
    this.total++
    this.running.set(key, n + 1)
    let left = false
    return () => {
      if (left) return
      left = true
      this.total--
      const m = (this.running.get(key) ?? 1) - 1
      if (m <= 0) this.running.delete(key)
      else this.running.set(key, m)
    }
  }

  get size(): number {
    return this.total
  }
}

/** 大きさの合計に上限のある、時間で切れる置き場 (最近使ったものを残す) */
export class ByteCache<T extends { bytes: number }> {
  private readonly map = new Map<string, { value: T, until: number }>()
  private total = 0
  readonly maxBytes: number
  readonly maxEntries: number

  constructor(maxBytes: number, maxEntries = 10_000) {
    this.maxBytes = maxBytes
    this.maxEntries = maxEntries
  }

  get(key: string): T | undefined {
    const e = this.map.get(key)
    if (!e) return undefined
    if (e.until < Date.now()) {
      this.delete(key)
      return undefined
    }
    this.map.delete(key)
    this.map.set(key, e)
    return e.value
  }

  set(key: string, value: T, ttl: number): void {
    if (value.bytes > this.maxBytes) return
    this.delete(key)
    this.map.set(key, { value, until: Date.now() + ttl })
    this.total += value.bytes
    for (const k of this.map.keys()) {
      if (this.total <= this.maxBytes && this.map.size <= this.maxEntries) break
      this.delete(k)
    }
  }

  delete(key: string): void {
    const e = this.map.get(key)
    if (!e) return
    this.map.delete(key)
    this.total -= e.value.bytes
  }
}
