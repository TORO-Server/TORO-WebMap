// Dynmap の中継 (/up/ws): 隠れている人の位置を送らないこと、知らないワールドで DB を読まないこと、送る手間: npm test
import test from 'node:test'
import assert from 'node:assert/strict'
import { LiveHub, livePlayersFor, visiblePlayers, worldNamesOf, type LivePeer, type LivePlayer } from '../server/lib/live-hub.ts'

const CONFIG = JSON.stringify({ worlds: [{ name: 'main' }, { name: 'nether' }] })
// Dynmap が隠す人に使う名前 (ClientUpdateComponent)
const HIDDEN_WORLD = '-some-other-bogus-world-'
const HIDDEN_PLAYER_WORLD = '-hidden-player-'

function live(account: string, world = 'main'): LivePlayer {
  return { account, world, x: 1.5, y: 64, z: -2.5, health: 18, armor: 7 }
}

function update(timestamp: number, players: unknown[]): string {
  return JSON.stringify({ timestamp, players })
}

class FakePeer implements LivePeer {
  id: string
  sent: { type: string, players?: LivePlayer[], world?: string }[] = []
  raw: string[] = []

  constructor(id: string) {
    this.id = id
  }

  send(text: string): void {
    this.raw.push(text)
    this.sent.push(JSON.parse(text))
  }

  lastPlayers(): LivePlayer[] | undefined {
    return this.sent.filter(m => m.type === 'players').at(-1)?.players
  }
}

function setup(files: Record<string, string | undefined>): { hub: LiveHub<FakePeer>, reads: string[] } {
  const reads: string[] = []
  const hub = new LiveHub<FakePeer>(async (name) => {
    reads.push(name)
    return files[name]
  })
  return { hub, reads }
}

test('Dynmap のワールドの一覧', () => {
  assert.deepEqual([...worldNamesOf(CONFIG)!], ['main', 'nether'])
  assert.equal(worldNamesOf('not json'), null)
  assert.equal(worldNamesOf('{"worlds":1}'), null)
  assert.equal(worldNamesOf('null'), null)
  assert.deepEqual([...worldNamesOf('{"worlds":[{"name":1},null,{"name":"a"}]}')!], ['a'])
})

test('Dynmap が隠している人は地図に出ている人に入れない', () => {
  const worlds = new Set(['main', 'nether'])
  const visible = visiblePlayers([
    { account: 'shown', world: 'main', health: 20, armor: 0 },
    { account: 'elsewhere', world: 'nether', health: 0, armor: 0 },
    { account: 'hidden', world: HIDDEN_WORLD, health: 0, armor: 0 },
    { account: 'hiddenplayer', world: HIDDEN_PLAYER_WORLD, health: 0, armor: 0 },
    { account: 'unknownworld', world: 'private', health: 20, armor: 20 },
    { world: 'main' }, null, 'x',
  ], worlds)
  assert.deepEqual([...visible.keys()], ['shown', 'elsewhere'])
  assert.equal(visible.get('shown')?.health, true)
  assert.equal(visible.get('elsewhere')?.health, false)
  assert.equal(visiblePlayers(undefined, worlds).size, 0)
})

test('位置は同じワールドの人だけ、体力と防具は Dynmap が送っている人だけ', () => {
  const positions = new Map([live('a'), live('b'), live('moved', 'private'), live('off')].map(p => [p.account, p]))
  const visible = new Map([
    ['a', { world: 'main', health: true }],
    ['b', { world: 'main', health: false }],
    ['moved', { world: 'main', health: true }],
    ['gone', { world: 'main', health: true }],
  ])
  const list = livePlayersFor(visible, positions)
  assert.deepEqual(list.map(p => p.account), ['a', 'b'])
  assert.equal(list[0]!.health, 18)
  assert.equal(list[0]!.armor, 7)
  assert.equal(list[1]!.health, 0)
  assert.equal(list[1]!.armor, 0)
  assert.equal(list[1]!.x, 1.5)
})

test('隠れている人の位置は、匿名の閲覧者に届かない', async (t) => {
  const { hub } = setup({
    'dynmap_config.json': CONFIG,
    'dynmap_main.json': update(1, [
      { account: 'shown', world: 'main', health: 20, armor: 5 },
      { account: 'nohealth', world: 'nether', health: 0, armor: 0 },
      { account: 'hidden', world: HIDDEN_WORLD, x: 0, y: 64, z: 0, health: 0, armor: 0 },
    ]),
  })
  t.after(() => hub.stop())
  const peer = new FakePeer('p1')
  await hub.subscribe(peer, 'main')
  assert.equal(peer.sent[0]?.type, 'update')
  // dynmap-live は全員の本当の位置を送ってくる
  hub.setPositions([live('shown'), live('nohealth', 'nether'), live('hidden'), live('notonmap')])
  const players = peer.lastPlayers()!
  assert.deepEqual(players.map(p => p.account), ['shown', 'nohealth'])
  assert.equal(players[0]!.health, 18)
  assert.equal(players[1]!.health, 0)
  // Dynmap の更新はダミーの座標のまま届く。本当の座標は位置の知らせにも入らない
  for (const text of peer.raw.filter(s => s.startsWith('{"type":"players"'))) assert.ok(!text.includes('hidden') && !text.includes('notonmap'), text)
})

test('Dynmap のワールドと位置のワールドが違うあいだは送らない', async (t) => {
  const { hub } = setup({
    'dynmap_config.json': CONFIG,
    'dynmap_main.json': update(1, [{ account: 'a', world: 'main', health: 20, armor: 0 }]),
  })
  t.after(() => hub.stop())
  const peer = new FakePeer('p1')
  await hub.subscribe(peer, 'main')
  hub.setPositions([live('a')])
  assert.deepEqual(peer.lastPlayers()?.map(p => p.account), ['a'])
  // 位置を送らないワールドへ移った。Dynmap が次の更新を書くまでも、移った先の位置は送らない
  hub.setPositions([live('a', 'private')])
  assert.deepEqual(peer.lastPlayers(), [])
})

test('知らないワールドの名前では DB を読まない', async (t) => {
  const { hub, reads } = setup({ 'dynmap_config.json': CONFIG, 'dynmap_main.json': update(1, []) })
  t.after(() => hub.stop())
  let now = 1_000_000
  hub.now = () => now
  const peers = Array.from({ length: 50 }, (_, i) => new FakePeer('p' + i))
  await Promise.all(peers.map((p, i) => hub.subscribe(p, 'nothing' + i)))
  assert.deepEqual(reads, ['dynmap_config.json'], 'でたらめな名前でも、一覧を 1 度読むだけ')
  assert.equal(peers[0]!.sent.length, 0)
  await hub.tick()
  assert.deepEqual(reads, ['dynmap_config.json'], '断った名前は読みに行かない')

  // 少し間を置けば読み直す (増えたばかりのワールド)
  now += 6000
  await hub.subscribe(peers[0]!, 'nothing')
  assert.equal(reads.filter(r => r === 'dynmap_config.json').length, 2)
  await hub.subscribe(peers[0]!, 'nothing')
  assert.equal(reads.filter(r => r === 'dynmap_config.json').length, 2, 'すぐには読み直さない')
})

test('増えたばかりのワールドは、読み直してから見られる', async (t) => {
  const files: Record<string, string | undefined> = { 'dynmap_config.json': CONFIG, 'dynmap_new.json': update(1, []) }
  const { hub } = setup(files)
  t.after(() => hub.stop())
  let now = 1_000_000
  hub.now = () => now
  await hub.worldNames()
  files['dynmap_config.json'] = JSON.stringify({ worlds: [{ name: 'main' }, { name: 'new' }] })
  now += 6000
  const peer = new FakePeer('p1')
  await hub.subscribe(peer, 'new')
  assert.equal(peer.sent[0]?.type, 'update')
})

test('一覧が読めないあいだは待ち、読めたら送る', async (t) => {
  const files: Record<string, string | undefined> = { 'dynmap_main.json': update(1, []) }
  const { hub, reads } = setup(files)
  t.after(() => hub.stop())
  let now = 1_000_000
  hub.now = () => now
  const peer = new FakePeer('p1')
  const stranger = new FakePeer('p2')
  await hub.subscribe(peer, 'main')
  await hub.subscribe(stranger, 'nothing')
  assert.equal(peer.sent.length, 0)
  assert.ok(!reads.includes('dynmap_main.json'), '一覧が読めるまでワールドを読まない')
  await hub.tick()
  assert.ok(!reads.includes('dynmap_main.json'))
  files['dynmap_config.json'] = CONFIG
  now += 6000
  await hub.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(peer.sent[0]?.type, 'update', '読めたら送る')
  assert.equal(stranger.sent.length, 0, '知らない名前は、読めたときに外す')
  const before = reads.length
  now += 1000
  await hub.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(reads.filter(r => r === 'dynmap_nothing.json').length, 0)
  assert.equal(reads.length - before, 1, '残っているワールドだけを読む')
})

test('一覧を前に読めていれば、読めなくなっても前のものを使う', async (t) => {
  const reads: string[] = []
  let broken = false
  const hub = new LiveHub<FakePeer>(async (name) => {
    reads.push(name)
    if (broken) throw new Error('db down')
    return name === 'dynmap_config.json' ? CONFIG : update(1, [])
  })
  t.after(() => hub.stop())
  let now = 1_000_000
  hub.now = () => now
  assert.ok((await hub.worldNames())?.has('main'))
  broken = true
  now += 60_000
  assert.ok((await hub.worldNames())?.has('main'))
  const count = reads.length
  assert.ok((await hub.worldNames())?.has('main'))
  assert.equal(reads.length, count, '失敗のあと、すぐには読み直さない')
})

test('何人が見始めても、同じワールドを同時に読まない', async (t) => {
  const { hub, reads } = setup({ 'dynmap_config.json': CONFIG, 'dynmap_main.json': update(1, []) })
  t.after(() => hub.stop())
  const peers = Array.from({ length: 100 }, (_, i) => new FakePeer('p' + i))
  await Promise.all(peers.map(p => hub.subscribe(p, 'main')))
  assert.equal(reads.filter(r => r === 'dynmap_main.json').length, 1)
  for (const p of peers) assert.equal(p.sent[0]?.type, 'update', '全員に今の状態を送る')
  // 読んだばかりなら、新しく見始めた人にも読まずに送る
  const late = new FakePeer('late')
  await hub.subscribe(late, 'main')
  assert.equal(reads.filter(r => r === 'dynmap_main.json').length, 1)
  assert.equal(late.sent[0]?.type, 'update')
})

test('位置の JSON はワールドごとに 1 度だけ作り、変わらなければ送らない', async (t) => {
  const { hub } = setup({
    'dynmap_config.json': CONFIG,
    'dynmap_main.json': update(1, [{ account: 'a', world: 'main', health: 20, armor: 0 }]),
    'dynmap_nether.json': update(1, [{ account: 'a', world: 'main', health: 0, armor: 0 }]),
  })
  t.after(() => hub.stop())
  const a = new FakePeer('a')
  const b = new FakePeer('b')
  const c = new FakePeer('c')
  await hub.subscribe(a, 'main')
  await hub.subscribe(b, 'main')
  await hub.subscribe(c, 'nether')
  hub.setPositions([live('a')])
  assert.equal(a.raw.at(-1), b.raw.at(-1))
  assert.equal(a.lastPlayers()![0]!.health, 18)
  assert.equal(c.lastPlayers()![0]!.health, 0, 'ワールドごとの更新で決まる')
  const sent = a.raw.length
  hub.setPositions([live('a')])
  assert.equal(a.raw.length, sent)
})

test('壊れた位置を受けても止まらない。閉じた人には送らない', async (t) => {
  const { hub } = setup({
    'dynmap_config.json': CONFIG,
    'dynmap_main.json': update(1, [{ account: 'a', world: 'main', health: 20, armor: 0 }]),
  })
  t.after(() => hub.stop())
  const peer = new FakePeer('p1')
  await hub.subscribe(peer, 'main')
  hub.setPositions([null, 1, { account: 1 }, { account: 'x' }, live('a')])
  assert.deepEqual(peer.lastPlayers()?.map(p => p.account), ['a'])
  hub.leave(peer)
  const sent = peer.raw.length
  hub.setPositions([{ ...live('a'), x: 9 }])
  assert.equal(peer.raw.length, sent)
  // 調べているあいだに閉じた人を、あとから足さない
  const quick = new FakePeer('p2')
  const pending = hub.subscribe(quick, 'main')
  hub.leave(quick)
  await pending
  hub.setPositions([{ ...live('a'), x: 10 }])
  assert.equal(quick.raw.length, 0)
})

test('見ている人がいなくなったら読むのをやめる', async () => {
  const { hub, reads } = setup({ 'dynmap_config.json': CONFIG, 'dynmap_main.json': update(1, []) })
  const peer = new FakePeer('p1')
  await hub.subscribe(peer, 'main')
  hub.leave(peer)
  await hub.tick()
  const before = reads.length
  await hub.tick()
  assert.equal(reads.length, before)
  hub.stop()
})
