import type { Peer } from 'crossws'
import { LiveHub } from '../lib/live-hub'

// Dynmap の地図をブラウザへすぐ届けるための中継 (WebSocket)。中身は server/lib/live-hub.ts

const hub = new LiveHub<Peer>(name => dynmapStandaloneFile(name))

export function liveSubscribe(peer: Peer, world: string): void {
  void hub.subscribe(peer, world).catch(() => {})
}

export function liveLeave(peer: Peer): void {
  hub.leave(peer)
}

/** dynmap-live から届いた全員の位置 */
export function livePositions(players: unknown[]): void {
  hub.setPositions(players)
}

/** dynmap_config.json にあるワールドか。一覧が読めなければ undefined */
export async function dynmapWorldKnown(world: string): Promise<boolean | undefined> {
  return (await hub.namesFor(world))?.has(world)
}
