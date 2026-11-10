// サーバーの細かな守り: npm test
// WebSocket のメッセージの大きさの上限 (Nitro が使うのと同じ crossws の Node のアダプターで確かめる)、合言葉の比べ方、壊れたパス
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import crossws from 'crossws/adapters/node'
import { tokenMatches } from '../server/lib/token.ts'
import { WS_MAX_PAYLOAD, WS_SERVER_OPTIONS } from '../server/lib/ws-options.ts'
import { decodePathParam } from '../server/lib/path-param.ts'
import { isOpenableLink } from '../app/lib/url.ts'

test('WebSocket のメッセージの大きさの上限が効く', async () => {
  const received: number[] = []
  const ws = crossws({
    serverOptions: WS_SERVER_OPTIONS,
    hooks: { message: (_peer, message) => void received.push(message.text().length) },
  })
  const server = createServer()
  server.on('upgrade', (req, socket, head) => void ws.handleUpgrade(req, socket, head))
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}/`
  try {
    const open = (): Promise<WebSocket> => new Promise((ok, fail) => {
      const client = new WebSocket(url)
      client.onopen = () => ok(client)
      client.onerror = () => fail(new Error('cannot connect'))
    })
    const closed = (client: WebSocket): Promise<number> => new Promise(ok => client.addEventListener('close', e => ok(e.code)))

    const small = await open()
    small.send('x'.repeat(WS_MAX_PAYLOAD))
    for (let i = 0; i < 200 && received.length === 0; i++) await new Promise(ok => setTimeout(ok, 5))
    assert.deepEqual(received, [WS_MAX_PAYLOAD], '上限までは届く')
    small.close()

    const big = await open()
    const code = closed(big)
    big.send('x'.repeat(WS_MAX_PAYLOAD + 1))
    assert.equal(await code, 1009, '上限を超えたら切る')
    assert.equal(received.length, 1)
  }
  finally {
    server.closeAllConnections()
    await new Promise<void>(ok => server.close(() => ok()))
  }
})

test('合言葉を比べる', () => {
  assert.equal(tokenMatches('secret', 'secret'), true)
  assert.equal(tokenMatches('secret2', 'secret'), false)
  assert.equal(tokenMatches('', 'secret'), false)
  assert.equal(tokenMatches(null, 'secret'), false)
  assert.equal(tokenMatches(undefined, 'secret'), false)
  // 決めていなければ、どんな値も通さない
  assert.equal(tokenMatches('', ''), false)
  assert.equal(tokenMatches(null, null), false)
  assert.equal(tokenMatches('x', undefined), false)
  // 文字数が同じでバイト数が違っても、例外にしない
  assert.equal(tokenMatches('あ', 'a'), false)
  assert.equal(tokenMatches('a', 'あ'), false)
})

test('マーカーのリンクとして開いてよいもの', () => {
  const base = 'https://3d-map.torosaba.net/'
  for (const link of ['https://example.com/', 'http://example.com/a', '/maps', 'a/b', '?x=1']) assert.equal(isOpenableLink(link, base), true, link)
  for (const link of ['javascript:alert(1)', ' JavaScript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'http://[']) assert.equal(isOpenableLink(link, base), false, link)
})

test('壊れたエンコードのパス', () => {
  assert.equal(decodePathParam('a%20b'), 'a b')
  assert.equal(decodePathParam('a/b'), 'a/b')
  assert.equal(decodePathParam('%E3%81%82'), 'あ')
  assert.equal(decodePathParam('%zz'), null)
  assert.equal(decodePathParam('%E3'), null)
})
