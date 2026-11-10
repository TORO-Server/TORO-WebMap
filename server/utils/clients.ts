import { isIPv4, isIPv6 } from 'node:net'

// いまつながっているプレイヤーの IP。TORO-Proxy (Velocity) が、人の出入りがあったとき (イベント駆動) に /live/clients へ全員分を送ってくる
// 入口の Velocity が見ている接続元なので、Paper の再起動中に limbo で待っている人も含む
// どう確かめるか (ログアウト後の猶予、知らせが途絶えたときの扱い) はここで決める。Velocity や Paper を再起動せずに変えられる
// IP はメモリーにだけ置き、ログにも DB にも残さない

// 知らせが途絶えたら (Velocity が止まった、など)、最後の一覧をこの時間まで信じる
const SNAPSHOT_MAX_AGE = 24 * 60 * 60_000

let online = new Set<string>()
let snapshotAt = 0
const left = new Map<string, number>()

function graceMillis(): number {
  return Number(useRuntimeConfig().assets.graceMinutes) * 60_000
}

/** TORO-Proxy からの全員分の一覧で入れ替える。いなくなった IP は、いなくなった時刻を覚えておく */
export function updateClients(ips: string[]): void {
  const now = Date.now()
  const next = new Set<string>()
  for (const ip of ips) {
    const key = ipBytes(ip)?.toString('hex')
    if (key) next.add(key)
  }
  for (const key of online) if (!next.has(key)) left.set(key, now)
  for (const key of next) left.delete(key)
  const grace = graceMillis()
  for (const [key, at] of left) if (now - at > grace) left.delete(key)
  online = next
  snapshotAt = now
}

/** いまつながっている (またはログアウトしてから grace-minutes 以内の) プレイヤーの IP か */
export function isPlayerAddress(ip: string): boolean {
  const key = ipBytes(ip)?.toString('hex')
  if (!key) return false
  const now = Date.now()
  const grace = graceMillis()
  if (online.has(key)) return now - snapshotAt < SNAPSHOT_MAX_AGE + grace
  const at = left.get(key)
  return at !== undefined && now - at < grace
}

/** IP アドレスの生のバイト (IPv4 は 4、IPv6 は 16。IPv4 を写した IPv6 (::ffff:a.b.c.d) は IPv4 の 4)。同じ人の書き方の違いをそろえる */
export function ipBytes(ip: string): Buffer | undefined {
  const addr = ip.trim().replace(/^\[|\]$/g, '').replace(/%.*$/, '')
  if (isIPv4(addr)) return Buffer.from(addr.split('.').map(Number))
  if (!isIPv6(addr)) return undefined
  let tail: number[] = []
  let text = addr
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text)
  if (v4) {
    tail = v4[1]!.split('.').map(Number)
    text = text.slice(0, -v4[1]!.length) + '0:0'
  }
  const [head, rest] = text.split('::') as [string, string | undefined]
  const leftGroups = head ? head.split(':') : []
  const rightGroups = rest !== undefined && rest !== '' ? rest.split(':') : []
  const groups = rest === undefined ? leftGroups : [...leftGroups, ...Array<string>(8 - leftGroups.length - rightGroups.length).fill('0'), ...rightGroups]
  const out = Buffer.alloc(16)
  groups.forEach((g, i) => out.writeUInt16BE(parseInt(g, 16), i * 2))
  if (tail.length) tail.forEach((b, i) => { out[12 + i] = b })
  const mapped = out.subarray(0, 10).every(b => b === 0) && out[10] === 0xFF && out[11] === 0xFF
  return mapped ? Buffer.from(out.subarray(12)) : out
}
