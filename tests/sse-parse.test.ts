import test from 'node:test'
import assert from 'node:assert/strict'
import { SseParser } from '../server/utils/sse-parse.ts'

test('SSE: event と data が 1 つのイベントになる', () => {
  const p = new SseParser()
  assert.deepEqual(p.push('event: player\ndata: {"a":1}\n\n'), [{ event: 'player', data: '{"a":1}' }])
})

test('SSE: event がなければ message、: の後の空白は 1 つだけ取る', () => {
  const p = new SseParser()
  assert.deepEqual(p.push('data:  x\n\n'), [{ event: 'message', data: ' x' }])
})

test('SSE: data が複数行なら改行でつなぐ', () => {
  const p = new SseParser()
  assert.deepEqual(p.push('event: marker\ndata: a\ndata: b\n\n'), [{ event: 'marker', data: 'a\nb' }])
})

test('SSE: コメントと data のないイベントは捨てる', () => {
  const p = new SseParser()
  assert.deepEqual(p.push(': keep-alive\n\nevent: tile\n\n'), [])
  // 捨てたイベントの event 名は次に持ち越さない
  assert.deepEqual(p.push('data: 1\n\n'), [{ event: 'message', data: '1' }])
})

test('SSE: どこで切れて届いても同じ結果になる (\\r\\n の間も)', () => {
  const text = 'event: tile\r\ndata: {"lod":0}\r\n\r\nevent: player\ndata: {}\n\n'
  const expected = [
    { event: 'tile', data: '{"lod":0}' },
    { event: 'player', data: '{}' },
  ]
  for (let cut = 0; cut <= text.length; cut++) {
    const p = new SseParser()
    const got = [...p.push(text.slice(0, cut)), ...p.push(text.slice(cut))]
    assert.deepEqual(got, expected, `cut at ${cut}`)
  }
  // 1 文字ずつ
  const p = new SseParser()
  const got = [...text].flatMap(ch => p.push(ch))
  assert.deepEqual(got, expected)
})

test('SSE: 行末が \\r だけでもよい', () => {
  const p = new SseParser()
  // 末尾の \r は、このあとに \n が続くかもしれないので、次の文字が届くまで行の終わりとしない
  assert.deepEqual(p.push('event: a\rdata: b\r\rx'), [{ event: 'a', data: 'b' }])
})
