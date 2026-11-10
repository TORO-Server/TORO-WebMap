import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'
import { createSanitizer } from '../app/lib/sanitize-html.ts'

const sanitize = createSanitizer(new JSDOM('').window as unknown as Parameters<typeof createSanitizer>[0])

test('スクリプトになるものを取り除く', () => {
  const attacks = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    '<IMG SRC=x OnError = "alert(1)">',
    '<a href="javascript:alert(1)">x</a>',
    '<a href="jav&#x09;ascript:alert(1)">x</a>',
    '<svg><script>alert(1)</script></svg>',
    '<svg onload=alert(1)>',
    '<math><mtext><table><mglyph><style><img src=x onerror=alert(1)>',
    '<iframe src="javascript:alert(1)"></iframe>',
    '<object data="javascript:alert(1)"></object>',
    '<embed src="javascript:alert(1)">',
    '<body onload=alert(1)>',
    '<div onmouseover="alert(1)">x</div>',
    // 以前の正規表現の処理では残っていたもの
    '<scr<script></script>ipt>alert(1)</scr<script></script>ipt>',
    '<script>alert(1)</script foo>',
    '<img src=x onerror\n=alert(1)>',
    '<img/src=x/onerror=alert(1)>',
  ]
  for (const attack of attacks) {
    const clean = sanitize(attack)
    const doc = new JSDOM(`<div id="r">${clean}</div>`).window.document
    assert.equal(doc.querySelector('#r script, #r iframe, #r object, #r embed, #r svg, #r math'), null, attack)
    for (const el of doc.querySelectorAll('#r *')) {
      for (const attr of el.attributes) {
        assert.ok(!attr.name.startsWith('on'), `${attack} -> ${clean}`)
        assert.ok(!/^\s*javascript:/i.test(attr.value), `${attack} -> ${clean}`)
      }
    }
  }
})

test('偽装に使える入力の部品を入れない', () => {
  assert.equal(sanitize('<form action="https://evil.example"><input name="p"><button>送信</button></form>'), '送信')
  assert.equal(sanitize('<style>body{display:none}</style>'), '')
})

test('本番のマーカーが使っている HTML は変わらない', () => {
  const desc = '<div style="font:13px / 1.5 sans-serif;max-width:360px"><div><span style="background:#c0392b;color:#fff;border-radius:3px;padding:1px 6px;font-weight:bold">リンク切れ</span></div><br><code>https://example.com/a?b=1&amp;c=2</code></div>'
  assert.equal(sanitize(desc), desc)
})

test('リンクと画像は残す', () => {
  assert.match(sanitize('<a href="https://example.com/">x</a>'), /href="https:\/\/example\.com\/"/)
  assert.match(sanitize('<img src="https://example.com/a.png" alt="a">'), /src="https:\/\/example\.com\/a\.png"/)
})

test('BlueMap の POI マーカーの枠は変わらない', () => {
  const clean = sanitize('<img src="" alt="POI Icon (x)" class="bm-marker-poi-icon" draggable="false" style="pointer-events: auto"><div class="bm-marker-poi-label"></div>')
  const doc = new JSDOM(clean).window.document
  const img = doc.querySelector('img')
  assert.equal(img?.className, 'bm-marker-poi-icon')
  assert.equal(img?.getAttribute('draggable'), 'false')
  assert.equal(img?.getAttribute('style'), 'pointer-events: auto')
  assert.equal(doc.querySelector('div')?.className, 'bm-marker-poi-label')
})

test('レイヤーの一覧に渡すマーカーの組の名前 (Leaflet が HTML として入れる)', () => {
  assert.equal(sanitize('駅と IC'), '駅と IC')
  assert.equal(sanitize('<b>太字</b>'), '<b>太字</b>')
  const clean = sanitize('<img src=x onerror=alert(1)>名前')
  assert.ok(!clean.includes('onerror'), clean)
})

test('空のときは空を返す', () => {
  assert.equal(sanitize(''), '')
  assert.equal(sanitize(null), '')
  assert.equal(sanitize(undefined), '')
})
