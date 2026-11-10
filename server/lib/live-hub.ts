// Dynmap の地図をブラウザへすぐ届けるための中継 (WebSocket)。Nuxt に頼らない (Node の試験でも動かす。server/utils/live.ts が使う)
//
// - ワールドの更新 (描き直したタイル、マーカー、チャットなど): Dynmap が DB に 2 秒ごとに書き出すものを、ここで 1 秒ごとに 1 度だけ読み、
//   変わったときに、そのワールドを見ているブラウザ全員へ送る (今までは全員がそれぞれ 2 秒ごとに取りに来ていた)。
//   読むのは dynmap_config.json にあるワールドだけ。何人が見ていても、ワールドごとに 1 秒に 1 度
// - プレイヤーの位置: TORO-Core の dynmap-live が 0.25 秒ごとに送ってくる全員の本当の位置を、Dynmap が地図に出している人の分だけ、すぐ送る。
//   Dynmap は隠す人 (透明化、スペクテイター、スニーク、影や地下の条件、protected-player-info、位置を送らないワールドなど) も players に残し、
//   world を実在しない名前に、座標をダミーにして送る。だから world が実在のワールドで、dynmap-live の位置と同じワールドの人だけを通す。
//   Dynmap が次の更新を書くまで (2 秒ほど) は、隠れ始めた人の位置が届くことがある
// - 体力と防具: Dynmap は送らない設定 (sendhealth) や隠す人では 0 にする。0 のときは dynmap-live の値も送らない

export interface LivePlayer {
  account: string
  world: string
  x: number
  y: number
  z: number
  health: number
  armor: number
}

export interface LivePeer {
  id: string
  send(text: string): unknown
}

/** Dynmap が地図に出している人 */
interface Visible {
  world: string
  /** Dynmap が体力と防具を送っているか */
  health: boolean
}

interface WorldState {
  /** 最後に読んだ更新の timestamp */
  timestamp: number
  visible: Map<string, Visible>
  lastRaw?: string
  lastFetchedAt: number
}

const CONFIG_FILE = 'dynmap_config.json'
/** ワールドの一覧を読み直す間隔 (ミリ秒) */
const WORLDS_MAX_AGE = 30_000
/** 知らない名前が来たときや、読めなかったときに、読み直すまでの間 (でたらめな名前で毎回 DB を読ませない) */
const WORLDS_RETRY_MILLIS = 5000
const POLL_MILLIS = 1000

/** dynmap_config.json のワールドの名前。形が違えば null */
export function worldNamesOf(raw: string): Set<string> | null {
  let config: { worlds?: unknown }
  try {
    config = JSON.parse(raw)
  }
  catch {
    return null
  }
  if (!config || !Array.isArray(config.worlds)) return null
  const names = new Set<string>()
  for (const w of config.worlds) {
    const name = w && typeof w === 'object' ? (w as { name?: unknown }).name : undefined
    if (typeof name === 'string') names.add(name)
  }
  return names
}

/** Dynmap の更新の players から、地図に出している人 (world が実在のワールドの人) を取り出す */
export function visiblePlayers(players: unknown, worlds: ReadonlySet<string>): Map<string, Visible> {
  const visible = new Map<string, Visible>()
  if (!Array.isArray(players)) return visible
  for (const p of players as { account?: unknown, world?: unknown, health?: unknown, armor?: unknown }[]) {
    if (!p || typeof p.account !== 'string' || typeof p.world !== 'string' || !worlds.has(p.world)) continue
    visible.set(p.account, { world: p.world, health: Number(p.health) > 0 || Number(p.armor) > 0 })
  }
  return visible
}

/** dynmap-live の全員の位置のうち、Dynmap が地図に出している人の分 */
export function livePlayersFor(visible: ReadonlyMap<string, Visible>, positions: ReadonlyMap<string, LivePlayer>): LivePlayer[] {
  const list: LivePlayer[] = []
  for (const [account, v] of visible) {
    const p = positions.get(account)
    if (!p || p.world !== v.world) continue
    list.push(v.health ? p : { ...p, health: 0, armor: 0 })
  }
  return list
}

export class LiveHub<P extends LivePeer = LivePeer> {
  private readonly viewers = new Map<P, string>()
  private readonly worlds = new Map<string, WorldState>()
  private readonly reading = new Map<string, Promise<string | undefined>>()
  private readonly readFile: (name: string) => Promise<string | undefined>
  private positions = new Map<string, LivePlayer>()
  private readonly lastPlayers = new Map<string, string>()
  private timer: ReturnType<typeof setInterval> | undefined
  private known: Set<string> | undefined
  private knownAt = 0
  private triedAt = Number.NEGATIVE_INFINITY
  private loadingKnown: Promise<void> | undefined
  now: () => number = Date.now

  /** @param readFile Dynmap が DB に書き出したファイルを読む */
  constructor(readFile: (name: string) => Promise<string | undefined>) {
    this.readFile = readFile
  }

  private send(peer: P, text: string): void {
    try {
      peer.send(text)
    }
    catch {
      this.viewers.delete(peer)
    }
  }

  /**
   * dynmap_config.json のワールドの名前。読めないときは前に読めたもの (1 度も読めていなければ undefined)
   * @param maxAge これより古ければ読み直す
   */
  async worldNames(maxAge = WORLDS_MAX_AGE): Promise<Set<string> | undefined> {
    const now = this.now()
    if (this.known && now - this.knownAt < maxAge) return this.known
    if (!this.loadingKnown && now - this.triedAt >= WORLDS_RETRY_MILLIS) {
      this.triedAt = now
      this.loadingKnown = this.readFile(CONFIG_FILE).then((raw) => {
        const names = raw === undefined ? null : worldNamesOf(raw)
        if (names) {
          this.known = names
          this.knownAt = this.now()
        }
      }, () => {}).finally(() => {
        this.loadingKnown = undefined
      })
    }
    if (this.loadingKnown) await this.loadingKnown
    return this.known
  }

  /** world を確かめるための一覧。一覧にない名前なら、増えたばかりかもしれないので読み直す (読み直すのは少し間を置いてから) */
  async namesFor(world: string): Promise<Set<string> | undefined> {
    const names = await this.worldNames()
    return names && !names.has(world) ? await this.worldNames(WORLDS_RETRY_MILLIS) : names
  }

  /** 同じワールドを同時に読まない */
  private read(world: string): Promise<string | undefined> {
    let p = this.reading.get(world)
    if (!p) {
      p = this.readFile(`dynmap_${world}.json`).finally(() => this.reading.delete(world))
      this.reading.set(world, p)
    }
    return p
  }

  /** DB の更新を読み、変わっていれば見ている人へ送る */
  private async poll(world: string, names: ReadonlySet<string>, only?: P): Promise<void> {
    const existing = this.worlds.get(world)
    let raw: string | undefined
    if (only && existing?.lastRaw && this.now() - existing.lastFetchedAt < POLL_MILLIS) {
      raw = existing.lastRaw
    }
    else {
      raw = await this.read(world)
    }
    if (raw === undefined) return
    let parsed: { timestamp: number, players?: unknown }
    try {
      parsed = JSON.parse(raw)
    }
    catch {
      return
    }
    const state = this.worlds.get(world) ?? { timestamp: 0, visible: new Map<string, Visible>(), lastFetchedAt: 0 }
    const changed = parsed.timestamp !== state.timestamp
    state.timestamp = parsed.timestamp
    state.visible = visiblePlayers(parsed.players, names)
    state.lastRaw = raw
    state.lastFetchedAt = this.now()
    this.worlds.set(world, state)
    if (!changed && !only) return
    const text = `{"type":"update","world":${JSON.stringify(world)},"update":${raw}}`
    for (const [peer, w] of this.viewers) {
      if (w === world && (!only || peer === only)) this.send(peer, text)
    }
  }

  /** 1 秒ごと: 見ている人のいるワールドを読む */
  async tick(): Promise<void> {
    const watched = new Set(this.viewers.values())
    if (watched.size === 0) {
      clearInterval(this.timer)
      this.timer = undefined
      return
    }
    const names = await this.worldNames()
    if (!names) return
    for (const world of watched) {
      if (names.has(world)) void this.poll(world, names).catch(() => {})
      else this.dropViewers(world)
    }
  }

  private dropViewers(world: string): void {
    for (const [peer, w] of this.viewers) {
      if (w === world) this.leave(peer)
    }
  }

  private startPolling(): void {
    this.timer ??= setInterval(() => void this.tick().catch(() => {}), POLL_MILLIS)
  }

  /** 見るワールドを知らせてきた。dynmap_config.json にない名前は断る (DB を読まない) */
  async subscribe(peer: P, world: string): Promise<void> {
    this.viewers.set(peer, world)
    this.lastPlayers.delete(peer.id)
    this.startPolling()
    const names = await this.namesFor(world)
    // 調べているあいだに、閉じた・別のワールドに変えたときは何もしない
    if (this.viewers.get(peer) !== world) return
    if (!names) return // 一覧が読めるまで、1 秒ごとに読み直す (読めたら tick が送る)
    if (!names.has(world)) {
      this.leave(peer)
      return
    }
    // 見始めたときは、今の状態をすぐ送る
    await this.poll(world, names, peer)
  }

  leave(peer: P): void {
    this.viewers.delete(peer)
    this.lastPlayers.delete(peer.id)
  }

  /** dynmap-live から届いた全員の位置 */
  setPositions(players: unknown[]): void {
    const positions = new Map<string, LivePlayer>()
    for (const p of players as LivePlayer[]) {
      if (p && typeof p.account === 'string' && typeof p.world === 'string') positions.set(p.account, p)
    }
    this.positions = positions
    // JSON はワールドごとに 1 度だけ作る
    const texts = new Map<string, string>()
    for (const [peer, world] of this.viewers) {
      let text = texts.get(world)
      if (text === undefined) {
        const state = this.worlds.get(world)
        if (!state) continue
        text = `{"type":"players","players":${JSON.stringify(livePlayersFor(state.visible, positions))}}`
        texts.set(world, text)
      }
      // 前に送ったものと同じなら送らない
      if (this.lastPlayers.get(peer.id) === text) continue
      this.lastPlayers.set(peer.id, text)
      this.send(peer, text)
    }
  }

  /** 止める (試験のあと) */
  stop(): void {
    clearInterval(this.timer)
    this.timer = undefined
  }
}
