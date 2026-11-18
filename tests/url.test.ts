import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { joinBase } from '../app/lib/url.ts'

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8')

test('joinBase: 基点とパスの間の / は 1 つで、パスの先頭の / は取り除く', () => {
  assert.equal(joinBase('https://assets.torosaba.net/map/v1', 'tiles/world/flat/0_0/0_0.webp'), 'https://assets.torosaba.net/map/v1/tiles/world/flat/0_0/0_0.webp')
  assert.equal(joinBase('https://assets.torosaba.net/map/v1', '/tiles/a.webp'), 'https://assets.torosaba.net/map/v1/tiles/a.webp')
})

test('nuxt.config.ts: タイルの基点は assets のホスト、API の基点は api のホストで、パスは同じ', () => {
  const conf = read('../nuxt.config.ts')
  const api = /apiBase:\s*'([^']+)'/.exec(conf)?.[1]
  const tile = /tileBase:\s*'([^']+)'/.exec(conf)?.[1]
  assert.equal(api, 'https://api.torosaba.net/map/v1')
  assert.equal(tile, 'https://assets.torosaba.net/map/v1')
  assert.equal(new URL(tile!).pathname, new URL(api!).pathname)
})

test('タイル以外 (マーカー、顔) は tileUrl を使わず、タイルだけが tileUrl を使う', () => {
  assert.match(read('../app/lib/tile-layer.ts'), /tileUrl\(`tiles\//)
  assert.doesNotMatch(read('../app/lib/tile-layer.ts'), /apiUrl/)
  assert.doesNotMatch(read('../app/lib/markers.ts'), /tileUrl/)
  assert.doesNotMatch(read('../app/lib/viewer.ts'), /tileUrl/)
})
