// 看板の転送先の調べ (/_marumasign/resolve) と中継 (/_marumasign/proxy) の試験: npm test
// アドレスの確かめ (SSRF を防ぐ)、看板データにある URL だけを読むこと、再生リストからたどれる URL、転送の追い方 (手元の HTTPS のサーバーで)
// fixtures/test-cert.pem は試験だけの自己署名の証明書 (試験では、決まった名前だけを手元につなぎ、証明書を確かめない)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createServer, type Server } from 'node:https'
import type { AddressInfo } from 'node:net'
import { checkUrl, follow, isBlockedAddress, resolveRedirects, safeLookup, UpstreamError } from '../server/lib/marumasign/net.ts'
import { AllowList, ALIAS_TTL, signUrls, siteOf } from '../server/lib/marumasign/allow.ts'
import { classify, looksLikeHtml, MAX_FOREIGN_OPAQUE_BYTES, MAX_FOREIGN_SMALL_BYTES, MAX_OPAQUE_BYTES } from '../server/lib/marumasign/kinds.ts'
import { ByteCache, Gate, limitKey, WindowLimit } from '../server/lib/marumasign/limits.ts'
import { dashRefs, gltfRefs, hlsRefs, isDash, manifestRefs, matchPattern, MAX_CHILDREN, MAX_SLOTS, refsInclude, type UrlPattern } from '../app/bluemap/marumasign/manifest.ts'
import { sniff, sniffGzipInner, TRANSCODE_CONTAINERS } from '../app/bluemap/marumasign/core.ts'
import { skipXmlHead } from '../app/bluemap/marumasign/xml-head.ts'

const bytes = (...a: (number | string)[]): Uint8Array => {
  const out: number[] = []
  for (const x of a) {
    if (typeof x === 'number') out.push(x)
    else for (let i = 0; i < x.length; i++) out.push(x.charCodeAt(i))
  }
  while (out.length < 1024) out.push(0)
  return new Uint8Array(out)
}

test('つないではいけないアドレス', () => {
  for (const ip of [
    '127.0.0.1', '127.255.255.254', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.50', '169.254.169.254', '100.64.0.1',
    '100.127.255.255', '0.0.0.0', '0.1.2.3', '224.0.0.1', '239.255.255.250', '255.255.255.255', '240.0.0.1', '198.18.0.1',
    '198.19.255.255', '192.0.2.1', '198.51.100.7', '203.0.113.9', '192.0.0.8', '192.88.99.1',
    '::1', '::', 'fe80::1', 'fe80::1%eth0', 'fc00::1', 'fd12:3456::1', 'ff02::1', 'fec0::1', '::ffff:127.0.0.1', '::ffff:10.1.2.3',
    '::127.0.0.1', '::ffff:0:192.168.1.1', '64:ff9b::7f00:1', '64:ff9b::a00:1', '64:ff9b:1::1', '2002:7f00:1::', '2002:c0a8:1::1',
    '2001::1', '2001:0:4136:e378::1', '2001:db8::1', '2001:10::1', '2001:20::1', '100::1', '3fff::1'.replace('3fff', '4000'),
    'not-an-ip', '', '1.2.3', '[::1]',
  ]) {
    assert.equal(isBlockedAddress(ip), true, ip)
  }
  for (const ip of ['8.8.8.8', '1.1.1.1', '100.128.0.1', '172.32.0.1', '192.169.0.1', '2606:4700:4700::1111', '2001:4860:4860::8888',
    '::ffff:8.8.8.8', '64:ff9b::808:808', '2002:808:808::1', '2400:cb00::1']) {
    assert.equal(isBlockedAddress(ip), false, ip)
  }
})

test('読んでよい URL の形 (https だけ、怪しいホストとポートは使わない)', () => {
  assert.equal(checkUrl('https://example.com/a.png#page=2'), 'https://example.com/a.png')
  assert.equal(checkUrl('https://example.com:8443/a'), 'https://example.com:8443/a')
  for (const bad of [
    'http://example.com/a', 'https://127.0.0.1/a', 'https://[::1]/a', 'https://0x7f.1/a', 'https://localhost/a', 'https://a.local/a',
    'https://tidb./a', 'https://toro-edge/a', 'https://user:pw@example.com/a', 'https://example.com:22/a', 'https://example.com:3000/a',
    'ftp://example.com/a', 'javascript:alert(1)', 'https://example.com/<x>', 'https://a..b.com/x',
  ]) {
    assert.equal(checkUrl(bad), null, bad)
  }
})

test('名前を引いたアドレスが手元なら、つながない', async () => {
  const lookup = safeLookup()
  const r = await new Promise<{ err: NodeJS.ErrnoException | null }>(resolve => lookup('localhost', { all: true }, err => resolve({ err })))
  assert.equal(r.err?.code, 'EBLOCKED')
  const fixed = await new Promise<string>(resolve => safeLookup({ testHosts: { 'x.test': '127.0.0.1' } })('x.test', {}, (_e, a) => resolve(String(a))))
  assert.equal(fixed, '127.0.0.1')
})

test('看板データから読んでよい URL を取り出す', () => {
  const kinds = 8
  const sign = (image: string, link: string): unknown[] => [0, 64, 0, 0, 0, image, link, 0, 0, 0, 1, 1, 0, 0, 0]
  const data = {
    format: 1, kinds: new Array(kinds).fill(['', '']),
    signs: [
      sign('https://img.example.com/a.png', 'https://img.example.com/a.png'),
      sign('', 'https://is.gd/abc'),
      sign('', 'https://example.com/doc.pdf#page=3'),
      sign('', 'http://example.com/insecure.png'),
      sign('', 'https://127.0.0.1/x'),
      'garbage', [1, 2],
    ],
  }
  const urls = signUrls(data)
  assert.deepEqual([...urls].sort(), ['https://example.com/doc.pdf', 'https://img.example.com/a.png', 'https://is.gd/abc'])
  assert.equal(signUrls({ format: 2, signs: [sign('', 'https://a.example/x')] }).size, 0)
})

/** SegmentTemplate 1 つから URL の形を作る */
function template(media: string, ids: string[] = []): UrlPattern {
  const reps = ids.map(id => `<Representation id="${id}"/>`).join('')
  const refs = dashRefs(`<MPD>${reps}<SegmentTemplate media="${media}"/></MPD>`, 'https://base.example/manifest.mpd')
  assert.equal(refs.patterns.length, 1, media)
  return refs.patterns[0]!
}

test('読んでよい URL の一覧 (看板の URL、転送先、再生リストに書かれた URL)', () => {
  const allow = new AllowList()
  let now = 1_000_000
  allow.now = () => now
  allow.setRoots(new Set(['https://a.example/live.m3u8']))
  assert.equal(allow.allowed('https://a.example/live.m3u8'), 'root')
  assert.equal(allow.allowed('https://a.example/other'), null)
  allow.addAlias('https://cdn.example/live.m3u8')
  assert.equal(allow.allowed('https://cdn.example/live.m3u8'), 'alias')
  allow.addRefs({ urls: ['https://cdn.example/seg1.ts'], patterns: [template('https://cdn.example/v/seg-$Number$.m4s')], playlists: [] }, 'https://cdn.example/live.m3u8')
  assert.equal(allow.allowed('https://cdn.example/seg1.ts'), 'child')
  assert.equal(allow.allowed('https://cdn.example/v/seg-00042.m4s'), 'child')
  assert.equal(allow.allowed('https://cdn.example/v/seg-x.m4s'), null)
  assert.equal(allow.allowed('https://cdn.example/v/seg-1.m4s?evil=https://x'), null)
  now += ALIAS_TTL + 1
  assert.equal(allow.allowed('https://cdn.example/live.m3u8'), null, '転送先は時間で忘れる')
  assert.equal(allow.allowed('https://cdn.example/seg1.ts'), null)
  allow.setRoots(new Set())
  assert.equal(allow.allowed('https://a.example/live.m3u8'), null, '看板から消えたら読まない')
})

test('HLS の再生リストに書かれた URL', () => {
  const master = [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="ja",URI="audio/ja.m3u8"',
    '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud"',
    'low/index.m3u8',
    '#EXT-X-STREAM-INF:BANDWIDTH=2000000',
    'https://cdn.example/high/index.m3u8?token=1#frag',
    '#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=1,URI="iframe.m3u8"',
  ].join('\n')
  const m = hlsRefs(master, 'https://a.example/live/master.m3u8')
  assert.deepEqual(m.urls, [
    'https://a.example/live/audio/ja.m3u8', 'https://a.example/live/low/index.m3u8', 'https://cdn.example/high/index.m3u8?token=1',
    'https://a.example/live/iframe.m3u8',
  ])
  assert.ok(m.playlists.includes('https://a.example/live/low/index.m3u8'))
  const media = [
    '#EXTM3U', '#EXT-X-TARGETDURATION:6', '#EXT-X-KEY:METHOD=AES-128,URI="https://keys.example/k1",IV=0x1',
    '#EXT-X-MAP:URI="init.mp4"', '#EXTINF:6,', 'seg0.m4s', '#EXTINF:6,', '../shared/seg1.m4s', '#EXT-X-ENDLIST', '',
  ].join('\r\n')
  assert.deepEqual(hlsRefs(media, 'https://a.example/live/low/index.m3u8').urls, [
    'https://keys.example/k1', 'https://a.example/live/low/init.mp4', 'https://a.example/live/low/seg0.m4s', 'https://a.example/live/shared/seg1.m4s',
  ])
  assert.deepEqual(hlsRefs('#EXTM3U\ndata:text/plain,x\njavascript:alert(1)\n', 'https://a.example/x.m3u8').urls, [])
})

test('MPEG-DASH の MPD に書かれた URL と、番号で決まる URL の形', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static">
  <BaseURL>https://cdn.example/content/</BaseURL>
  <Period>
    <AdaptationSet mimeType="video/mp4">
      <SegmentTemplate initialization="init-$RepresentationID$.m4s" media="chunk-$RepresentationID$-$Number%05d$.m4s" startNumber="1"/>
      <Representation id="v720" bandwidth="1"/>
      <Representation id="v1080" bandwidth="2"/>
    </AdaptationSet>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a1" bandwidth="1">
        <BaseURL>audio/</BaseURL>
        <SegmentList><Initialization sourceURL="init.mp4"/><SegmentURL media="s1.m4s"/><SegmentURL media="s2.m4s"/></SegmentList>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`
  const r = dashRefs(mpd, 'https://a.example/manifest.mpd')
  assert.deepEqual(r.urls, ['https://cdn.example/content/audio/init.mp4', 'https://cdn.example/content/audio/s1.m4s', 'https://cdn.example/content/audio/s2.m4s'])
  assert.ok(refsInclude(r, 'https://cdn.example/content/chunk-v720-00007.m4s'))
  assert.ok(refsInclude(r, 'https://cdn.example/content/init-v1080.m4s'))
  assert.ok(!refsInclude(r, 'https://cdn.example/content/chunk-other-00007.m4s'))
  assert.ok(!refsInclude(r, 'https://cdn.example/content/chunk-v720-7.m4s/../../../x'))
  assert.ok(!refsInclude(r, 'https://evil.example/content/chunk-v720-00007.m4s'))
  // 試験用のサーバーの形 (ffmpeg の dash の出力)
  const ff = '<MPD><Period><AdaptationSet><Representation id="0"><SegmentTemplate initialization="init-stream$RepresentationID$.m4s" media="chunk-stream$RepresentationID$-$Number%05d$.m4s"/></Representation></AdaptationSet></Period></MPD>'
  assert.ok(refsInclude(dashRefs(ff, 'https://m.example/dash/manifest.mpd'), 'https://m.example/dash/chunk-stream0-00001.m4s'))
})

test('URL の形を確かめる (数字、Representation の id、固定の部分)', () => {
  const num = template('https://cdn.example/a/$Number%05d$.m4s?x=$Time$&y=1')
  assert.ok(matchPattern(num, 'https://cdn.example/a/00042.m4s?x=7&y=1'))
  assert.ok(!matchPattern(num, 'https://cdn.example/a/x.m4s?x=7&y=1'), '数字でない')
  assert.ok(!matchPattern(num, 'https://cdn.example/a/.m4s?x=7&y=1'), '空')
  assert.ok(!matchPattern(num, `https://cdn.example/a/${'1'.repeat(21)}.m4s?x=7&y=1`), '21 桁')
  assert.ok(matchPattern(num, `https://cdn.example/a/${'1'.repeat(20)}.m4s?x=7&y=1`), '20 桁')
  assert.ok(!matchPattern(num, 'https://cdn.example/a/1.m4s?x=7&y=1&z'), '後ろに余分')
  assert.ok(!matchPattern(num, 'https://evil.example/a/1.m4s?x=7&y=1'), '別のホスト')
  const tail = template('$Number$')
  assert.ok(matchPattern(tail, 'https://base.example/12'))
  assert.ok(!matchPattern(tail, 'https://base.example/12/3'))

  // ほかの id で始まる id と、区切りの文字を含む id
  const ids = template('https://cdn.example/$RepresentationID$-$Number$.m4s', ['1', '10', 'video-1', 'video'])
  for (const u of ['1-5', '10-5', 'video-1-7', 'video-7']) assert.ok(matchPattern(ids, `https://cdn.example/${u}.m4s`), u)
  for (const u of ['2-5', '100-5', 'video-2-7-8', 'audio-1']) assert.ok(!matchPattern(ids, `https://cdn.example/${u}.m4s`), u)

  // 数字のすぐ後ろに固定の数字
  const digit = template('https://cdn.example/$Number$0.m4s')
  assert.ok(matchPattern(digit, 'https://cdn.example/120.m4s'))
  assert.ok(!matchPattern(digit, 'https://cdn.example/121.m4s'))
  assert.ok(!matchPattern(digit, 'https://cdn.example/0.m4s'))

  // $$ は「$」そのもの
  const dollar = template('https://cdn.example/a$$b/$Number$.m4s')
  assert.ok(matchPattern(dollar, 'https://cdn.example/a$b/1.m4s'))

  // Representation の id がない MPD の $RepresentationID$ は「/ ? #」以外
  const any = template('https://cdn.example/$RepresentationID$/$Number$.m4s')
  assert.ok(matchPattern(any, 'https://cdn.example/x_y-z/1.m4s'))
  assert.ok(!matchPattern(any, 'https://cdn.example/x/y/1.m4s'))
  assert.ok(!matchPattern(any, 'https://cdn.example/x?y/1.m4s'))
})

test('使わない URL の形 (置き換える部分が隣り合う、多すぎる、ホストの中)', () => {
  const refs = (media: string): ReturnType<typeof dashRefs> => dashRefs(`<MPD><SegmentTemplate media="${media}"/></MPD>`, 'https://base.example/m.mpd')
  assert.equal(refs('$Number$$Time$.m4s').patterns.length, 0, '隣り合う')
  assert.equal(refs('$Number$$RepresentationID$').patterns.length, 0, '隣り合う')
  assert.equal(refs('a$Number$'.repeat(MAX_SLOTS + 1)).patterns.length, 0, '多すぎる')
  assert.equal(refs('a$Number$'.repeat(MAX_SLOTS)).patterns.length, 1)
  assert.equal(refs('https://$Number$.example/a').patterns.length, 0, 'ホストの中')
  assert.equal(refs('https://base.example:$Number$/a').patterns.length, 0, 'ポートの中')
  assert.equal(refs('MSMARK9X$Number$').patterns.length, 0, '目印と同じ文字')
  // 置き換える部分がないものは、そのままの URL
  assert.deepEqual(refs('a$$b.m4s').urls, ['https://base.example/a$b.m4s'])
})

test('MPD を読む (CDATA、コメント、文字の参照、崩れたタグ、閉じていないもの)', () => {
  const base = 'https://a.example/m.mpd'
  const urls = (xml: string): string[] => dashRefs(xml, base).urls
  assert.deepEqual(urls('<MPD><BaseURL><![CDATA[https://c.example/x/]]></BaseURL><SegmentList><SegmentURL media="a.m4s"/></SegmentList></MPD>'), ['https://c.example/x/a.m4s'])
  assert.deepEqual(urls('<MPD><BaseURL>https://c.example/?a=1&amp;b=2/</BaseURL><SegmentURL media="a.m4s"/></MPD>'), ['https://c.example/a.m4s'])
  assert.deepEqual(urls(`<?xml version="1.0"?><!-- <SegmentURL media="no.m4s"/> --><!DOCTYPE MPD><MPD xmlns:x="u"><x:SegmentURL x:media='q&#46;m4s' /></MPD>`), ['https://a.example/q.m4s'])
  assert.deepEqual(urls('<MPD><SegmentURL media="a>b.m4s"/></MPD>'), ['https://a.example/a%3Eb.m4s'])
  assert.deepEqual(urls('<MPD><SegmentURL media="a.m4s"/><!-- 閉じていない <SegmentURL media="b.m4s"/>'), ['https://a.example/a.m4s'])
  assert.deepEqual(urls('<MPD><SegmentURL media="a.m4s"/><SegmentURL media="b.m4s'), ['https://a.example/a.m4s'], '閉じていない引用符')
  assert.deepEqual(urls('<MPD><SegmentURL media a=1/><1 x="y"/>< SegmentURL media="c.m4s"/><SegmentURL media="b.m4s"/></MPD>'), ['https://a.example/b.m4s'], '崩れたタグは飛ばす')
  // 閉じるタグの順が崩れていても、入れ子の BaseURL は外側に戻る
  assert.deepEqual(urls('<MPD><BaseURL>https://c.example/o/</BaseURL><Period><BaseURL>in/</BaseURL><x><SegmentURL media="a.m4s"/></Period><SegmentURL media="b.m4s"/></MPD>'), ['https://c.example/o/in/a.m4s', 'https://c.example/o/b.m4s'])
})

test('外から来た本文でも、読む手間は長さに比例する', () => {
  // どれも、前の正規表現では長さの 2 乗以上の時間がかかった形。ここでは短い時間で読み終える
  const within = (name: string, fn: () => void): void => {
    const start = performance.now()
    fn()
    const ms = performance.now() - start
    assert.ok(ms < 2000, `${name}: ${ms} ms`)
  }
  const base = 'https://a.example/m.mpd'
  const big = 2 * 1024 * 1024
  const fill = (unit: string): string => unit.repeat(Math.ceil(big / unit.length))
  within('閉じていないコメント', () => assert.deepEqual(dashRefs('<MPD>' + fill('<!--'), base).urls, []))
  within('閉じていない CDATA', () => dashRefs('<MPD>' + fill('<![CDATA['), base))
  within('閉じていない処理命令', () => dashRefs('<MPD>' + fill('<?a'), base))
  within('閉じていない引用符', () => dashRefs('<MPD>' + fill('<a b="'), base))
  within('崩れたタグ', () => dashRefs('<MPD>' + fill('<a b=1 '), base))
  within('深い入れ子', () => dashRefs(fill('<a>') + fill('</a>'), base))
  within('閉じるタグだけ', () => dashRefs('<MPD>' + fill('</a>'), base))
  within('長い空白', () => dashRefs('<MPD' + fill(' ') + 'x', base))
  within('たくさんの URL', () => assert.equal(dashRefs('<MPD>' + Array.from({ length: 30000 }, (_, i) => `<SegmentURL media="s${i}"/>`).join(''), base).urls.length, MAX_CHILDREN))
  within('HLS の短い行', () => hlsRefs('#EXTM3U\n' + fill('a\n'), base))
  within('HLS のたくさんの URL', () => assert.equal(hlsRefs('#EXTM3U\n' + Array.from({ length: 30000 }, (_, i) => `s${i}`).join('\n'), base).urls.length, MAX_CHILDREN))
})

test('コメントが続く先頭でも、種類を決めるのに時間がかからない', () => {
  // 先頭のコメントの数の指数で時間がかからないこと。この数で後戻りするなら終わらない
  const comments = '<!---->'.repeat(140)
  const start = performance.now()
  assert.equal(looksLikeHtml(bytes(comments + 'x')), false)
  assert.equal(looksLikeHtml(bytes(comments + '<html>')), true)
  assert.equal(isDash(comments + 'x'), false)
  assert.equal(isDash(comments + '<MPD>'), true)
  assert.equal(sniff(bytes(comments + 'x'), '', ''), null)
  assert.equal(sniff(bytes(comments + '<svg>'), '', '')?.format, 'svg')
  assert.equal(sniffGzipInner(bytes(comments + 'x'), ''), null)
  assert.equal(sniffGzipInner(bytes(comments + '<svg>'), '')?.format, 'svgz')
  assert.ok(performance.now() - start < 2000)
})

test('先頭の前置きを飛ばす', () => {
  assert.equal(skipXmlHead('  <a>'), 2)
  assert.equal(skipXmlHead('<!-- x -->\n<!-- y -->  <a>'), 23)
  assert.equal(skipXmlHead('<!-- x'), -1, '閉じていない')
  assert.equal(skipXmlHead('<?xml version="1.0"?><a>'), 0, '指定しなければ飛ばさない')
  assert.equal(skipXmlHead('<?XML version="1.0"?> <a>', { decl: true }), 22)
  assert.equal(skipXmlHead('<?xml', { decl: true }), -1)
  assert.equal(skipXmlHead('<!DOCTYPE a><a>'), 0)
  assert.equal(skipXmlHead('<!doctype a> <!-- b --><a>', { doctype: true }), 23)
  assert.equal(skipXmlHead('<!DOCTYPE', { doctype: true }), -1)
  assert.equal(looksLikeHtml(bytes('\xEF\xBB\xBF<!-- c --><script>')), true)
  assert.equal(looksLikeHtml(bytes('<?xml version="1.0"?><html>')), false, 'XML の宣言のあとは HTML と見ない (これまでどおり)')
  assert.equal(isDash('﻿<?xml version="1.0"?>\n<!-- c --><MPD type="static">'), true)
  assert.equal(isDash('<?xml version="1.0"?><!DOCTYPE MPD><MPD type="static">'), true, 'DOCTYPE があっても MPD と分かる')
  assert.equal(isDash('<!DOCTYPE MPD><MPD>'), true)
  assert.equal(isDash('<MPDX>'), false)
  assert.equal(isDash('<mpd>'), false)
  assert.equal(sniff(bytes('<?xml version="1.0"?><!-- c --><!DOCTYPE svg PUBLIC "x"><SVG xmlns="y">'), '', '')?.format, 'svg')
})

test('URL の形は決まった数だけ覚え、オリジンごとに分けて確かめる', () => {
  const allow = new AllowList()
  const parent = 'https://cdn.example/m.mpd'
  const many = Array.from({ length: 2000 }, (_, i) => template(`https://cdn.example/p${i}/$Number$.m4s`))
  allow.addRefs({ urls: [], patterns: many, playlists: [] }, parent)
  assert.equal(allow.allowed('https://cdn.example/p1999/1.m4s'), 'child', '新しいものは残る')
  assert.equal(allow.allowed('https://cdn.example/p0/1.m4s'), null, '1 つのオリジンの上限を超えたら古いものから消す')
  // 別のオリジンのものは消えない
  allow.addRefs({ urls: [], patterns: [template('https://other.example/a/$Number$.m4s')], playlists: [] }, 'https://other.example/m.mpd')
  allow.addRefs({ urls: [], patterns: Array.from({ length: 300 }, (_, i) => template(`https://cdn.example/q${i}/$Number$.m4s`)), playlists: [] }, parent)
  assert.equal(allow.allowed('https://other.example/a/1.m4s'), 'child')
  // 全体の上限 (オリジンをいくつ使っても増え続けない)
  for (let i = 0; i < 40; i++) {
    const origin = `https://host${i}.test`
    allow.addRefs({ urls: [], patterns: Array.from({ length: 100 }, (_, j) => template(`${origin}/${j}/$Number$.m4s`)), playlists: [] }, origin + '/m.mpd')
  }
  assert.equal(allow.allowed('https://host39.test/99/1.m4s'), 'child', '新しいものは残る')
  assert.equal(allow.allowed('https://host0.test/0/1.m4s'), null, '全体の上限を超えたら古いオリジンのものから消す')
  // 時間で忘れる
  let now = Date.now()
  allow.now = () => now
  now += 11 * 60_000
  assert.equal(allow.allowed('https://host39.test/99/1.m4s'), null)
})

test('前と後ろの固定の部分が合う形が多すぎるものは、確かめるのをやめる', () => {
  const allow = new AllowList()
  const ids = Array.from({ length: 100 }, (_, i) => 'i'.repeat(i + 1))
  const patterns = Array.from({ length: 200 }, (_, i) => template(`https://cdn.example/$RepresentationID$-$Number$-${i}x$Number$.m4s`, ids))
  allow.addRefs({ urls: [], patterns, playlists: [] }, 'https://cdn.example/m.mpd')
  const url = `https://cdn.example/${'i'.repeat(50)}-1-199x2.m4s`
  const start = performance.now()
  for (let i = 0; i < 1000; i++) allow.allowed(url)
  assert.ok(performance.now() - start < 2000, '手間に上限がある')
  assert.equal(allow.allowed(url), null, '16 個を超えて合うものは読まない')
  assert.equal(allow.allowed(`https://cdn.example/${'i'.repeat(50)}-1-0x2.m4s`), 'child', '先に合うものは読む')
})

test('再生リストと別のサイトに書かれた URL', () => {
  assert.equal(siteOf('https://a.example.com/x'), 'example.com')
  assert.equal(siteOf('https://b.c.example.com/x'), 'example.com')
  assert.equal(siteOf('https://example.com/x'), 'example.com')
  assert.equal(siteOf('https://a.example.co.jp/x'), 'example.co.jp')
  assert.equal(siteOf('https://other.co.jp/x'), 'other.co.jp')
  assert.equal(siteOf('https://a.github.io/x'), 'a.github.io', '共有ホスティングは借り手がサイト')
  assert.equal(siteOf('https://b.github.io/x'), 'b.github.io')
  assert.equal(siteOf('https://a.b.github.io/x'), 'b.github.io')
  assert.equal(siteOf('https://a.gitlab.io/x'), 'a.gitlab.io')
  assert.equal(siteOf('https://a.pages.dev/x'), 'a.pages.dev')
  assert.equal(siteOf('not a url'), 'not a url')

  const allow = new AllowList()
  const parent = 'https://live.example.com/master.m3u8'
  allow.addRefs(hlsRefs('#EXTM3U\nhttps://cdn.example.com/same-site.ts\nlocal.ts\nhttps://other.example/foreign.ts\n', parent), parent)
  assert.equal(allow.allowed('https://live.example.com/local.ts'), 'child')
  assert.equal(allow.allowed('https://cdn.example.com/same-site.ts'), 'child', '同じドメインの別のホスト')
  assert.equal(allow.allowed('https://other.example/foreign.ts'), 'foreign')
  allow.addRefs(dashRefs('<MPD><SegmentTemplate media="https://other.example/$Number$.m4s" initialization="https://live.example.com/$Number$.init"/></MPD>', parent), parent)
  assert.equal(allow.allowed('https://other.example/1.m4s'), 'foreign')
  assert.equal(allow.allowed('https://live.example.com/1.init'), 'child')
  // 共有ホスティングでは、借り手が違うホストは別のサイト
  const gh = 'https://a.github.io/m.m3u8'
  allow.addRefs(hlsRefs('#EXTM3U\nhttps://a.github.io/s.ts\nhttps://b.github.io/s.ts\n', gh), gh)
  assert.equal(allow.allowed('https://a.github.io/s.ts'), 'child')
  assert.equal(allow.allowed('https://b.github.io/s.ts'), 'foreign', '借り手が違うと別のサイト')
  // 同じサイトの再生リストにも書かれたら、同じサイトのものとして扱う
  const other = 'https://other.example/m.m3u8'
  allow.addRefs(hlsRefs('#EXTM3U\nforeign.ts\n', other), other)
  assert.equal(allow.allowed('https://other.example/foreign.ts'), 'child')

  // 目印のない中身は、別のサイトなら分割ファイルらしいものと小さいものだけ
  const noMark = bytes(0xDE, 0xAD, 0xBE, 0xEF)
  assert.equal(classify(noMark, '', 'bin', true)?.cap, MAX_OPAQUE_BYTES)
  assert.equal(classify(noMark, '', 'ts', true, true)?.cap, MAX_FOREIGN_OPAQUE_BYTES)
  assert.equal(classify(noMark, '', 'm4s', true, true)?.cap, MAX_FOREIGN_OPAQUE_BYTES)
  assert.equal(classify(noMark, '', 'json', true, true)?.cap, MAX_FOREIGN_SMALL_BYTES)
  assert.equal(classify(noMark, '', '', true, true)?.cap, MAX_FOREIGN_SMALL_BYTES, '暗号化の鍵は拡張子がないこともある')
  assert.equal(classify(bytes('hello'), 'text/html', 'ts', true, true), null, 'HTML は返さない')
  assert.equal(classify(bytes('<html>'), '', 'ts', true, true), null, 'HTML は返さない')
  // 目印のあるものは、看板に書けるものと同じ
  assert.equal(classify(bytes(0x89, 'PNG\r\n\x1a\n'), '', '', true, true)?.name, 'image')
  assert.equal(classify(bytes('#EXTM3U\n'), '', '', true, true)?.manifest, 'hls')
})

test('上限を数える単位 (IPv6 は /64 にまとめる)', () => {
  assert.equal(limitKey('203.0.113.9'), '203.0.113.9')
  assert.equal(limitKey(' 203.0.113.9 '), '203.0.113.9')
  assert.equal(limitKey('2001:db8:1:2:3:4:5:6'), '20010db800010002/64')
  assert.equal(limitKey('2001:db8:1:2:ffff::1'), '20010db800010002/64')
  assert.notEqual(limitKey('2001:db8:1:3::1'), limitKey('2001:db8:1:2::1'))
  assert.equal(limitKey('2001:0DB8:0001:0002::1'), limitKey('2001:db8:1:2::2'))
  assert.equal(limitKey('::ffff:203.0.113.9'), '203.0.113.9')
  assert.equal(limitKey('unknown'), 'unknown')
  assert.equal(limitKey('x'.repeat(100)).length, 64)
})

test('数える鍵の数には上限がある', () => {
  const w = new WindowLimit(1000, 1, 100)
  let now = 0
  w.now = () => now
  for (let i = 0; i < 1000; i++) w.hit('k' + i)
  assert.equal(w.size, 100, '時間内のものでも、古いものから忘れる')
  w.hit('new')
  assert.equal(w.hit('new'), true, '新しいものは数えている')
  // 時間の過ぎたものは、まとめて消す
  now = 20_000
  w.hit('later')
  assert.equal(w.size, 1)
})

test('glTF が参照するファイル', () => {
  const g = JSON.stringify({ asset: { version: '2.0' }, buffers: [{ uri: 'Duck.bin' }, { uri: 'data:application/octet-stream;base64,AAAA' }], images: [{ uri: 'tex/DuckCM.png' }, { bufferView: 1 }] })
  assert.deepEqual(gltfRefs(g, 'https://a.example/m/Duck.gltf').urls, ['https://a.example/m/Duck.bin', 'https://a.example/m/tex/DuckCM.png'])
  assert.deepEqual(manifestRefs(g, 'https://a.example/m/Duck.gltf')?.urls.length, 2)
  assert.equal(manifestRefs('{"not":"gltf"}', 'https://a.example/x.json'), null)
  assert.equal(manifestRefs('<html></html>', 'https://a.example/x'), null)
})

test('中継で返してよい中身 (HTML は返さない、Content-Type は決まったもの)', () => {
  assert.equal(looksLikeHtml(bytes('<!DOCTYPE html><html>')), true)
  assert.equal(looksLikeHtml(bytes('  <html lang="ja">')), true)
  assert.equal(looksLikeHtml(bytes('<!-- x --><script>alert(1)</script>')), true)
  assert.equal(looksLikeHtml(bytes('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), false)
  assert.equal(classify(bytes('<!doctype html><title>x</title>'), 'image/png', 'png', true), null, 'HTML は名前や種類が何でも返さない')
  assert.deepEqual(classify(bytes(0x89, 'PNG\r\n\x1a\n'), 'text/html', '', false)?.type, 'image/png')
  const svg = classify(bytes('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/svg+xml', 'svg', false)
  assert.equal(svg?.type, 'application/octet-stream', 'SVG は画像として開けない形で返す')
  assert.equal(classify(bytes('%PDF-1.7'), 'application/pdf', 'pdf', false)?.type, 'application/octet-stream')
  assert.equal(classify(bytes(0, 0, 0, 0x18, 'ftypmp42'), '', 'mp4', false)?.type, 'video/mp4')
  assert.equal(classify(bytes('#EXTM3U\n'), '', 'm3u8', false)?.manifest, 'hls')
  assert.equal(classify(bytes('hello world'), 'text/plain', 'txt', false), null, '看板の URL そのものは、分かる種類だけ')
  assert.equal(classify(bytes(0xDE, 0xAD, 0xBE, 0xEF), '', 'bin', true)?.name, 'opaque', '再生リストや .gltf の中のものは目印がなくてもよい')
  assert.equal(classify(bytes('hello'), 'text/html', '', true), null)
})

test('ブラウザーが再生できない入れ物を見分ける', () => {
  const c = (b: Uint8Array, type = '', ext = ''): string | undefined => sniff(b, type, ext)?.container
  assert.equal(c(bytes(0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C)), 'asf')
  assert.equal(c(bytes('RIFF\0\0\0\0AVI LIST')), 'avi')
  assert.equal(c(bytes(0, 0, 1, 0xBA, 0x44)), 'mpegps')
  assert.equal(c(bytes(0, 0, 1, 0xB3, 0x14)), 'mpegvideo')
  assert.equal(c(bytes(0, 0, 0, 0x14, 'ftyp3gp4')), '3gp')
  assert.equal(c(bytes('OggS\0\x02', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '\x80theora')), 'ogg-theora')
  assert.equal(c(bytes('OggS\0\x02', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, '\x01vorbis')), 'ogg')
  assert.equal(c(bytes('.RMF\0\0\0\x12')), 'rm')
  assert.equal(c(bytes('#!AMR\n')), 'amr')
  assert.equal(c(bytes('FORM\0\0\0\0AIFFCOMM')), 'aiff')
  assert.equal(c(bytes('FLV\x01\x05')), 'flv')
  const ts = new Uint8Array(1024)
  ts[0] = 0x47
  ts[188] = 0x47
  assert.equal(c(ts), 'ts')
  for (const name of ['asf', 'avi', 'mpegps', 'rm', 'amr', 'aiff', 'ogg-theora']) assert.ok(TRANSCODE_CONTAINERS.has(name), name)
  for (const name of ['ts', 'flv', 'mkv', '3gp', 'ogg', 'wav']) assert.ok(!TRANSCODE_CONTAINERS.has(name), name)
  assert.equal(sniff(bytes(0x0B, 0x77, 1, 2), '', 'bin'), null, 'AC-3 の目印は短いので、拡張子か種類がなければ決めない')
  assert.equal(sniff(bytes(0x0B, 0x77, 1, 2), '', 'ac3')?.format, 'audio')
})

test('数と量の上限', () => {
  const w = new WindowLimit(1000, 3)
  let now = 0
  w.now = () => now
  assert.equal(w.hit('a'), false)
  assert.equal(w.hit('a', 2), false)
  assert.equal(w.hit('a'), true)
  assert.equal(w.hit('b'), false)
  now = 2000
  assert.equal(w.hit('a'), false, '時間が過ぎたら数え直す')
  const g = new Gate(2, 1)
  const l1 = g.enter('x')
  assert.ok(l1)
  assert.equal(g.enter('x'), null, '1 つの IP からは 1 つまで')
  const l2 = g.enter('y')
  assert.ok(l2)
  assert.equal(g.enter('z'), null, '全体で 2 つまで')
  l1()
  l1()
  assert.equal(g.size, 1, '2 度出ても 1 つ')
  const c = new ByteCache<{ bytes: number }>(10)
  c.set('a', { bytes: 6 }, 10000)
  c.set('b', { bytes: 6 }, 10000)
  assert.equal(c.get('a'), undefined, '合計が上限を超えたら古いものから消す')
  assert.ok(c.get('b'))
  c.set('big', { bytes: 11 }, 10000)
  assert.equal(c.get('big'), undefined)
})

// ---------------------------------------------------------------- 手元の HTTPS のサーバーで、転送の追い方

const cert = readFileSync(new URL('./fixtures/test-cert.pem', import.meta.url))
const key = readFileSync(new URL('./fixtures/test-key.pem', import.meta.url))

/** 手元の HTTPS のサーバー。a.test と b.test (ポートなし = 443) を、試験の名前としてここにつなぐ */
async function withServer(fn: (testHosts: Record<string, string>, hits: string[]) => Promise<void>): Promise<void> {
  const hits: string[] = []
  const server: Server = createServer({ cert, key }, (req, res) => {
    const u = new URL(req.url ?? '/', 'https://x')
    hits.push(req.method + ' ' + req.headers.host + u.pathname + (req.headers.cookie ? ' cookie!' : '') + (req.headers.referer ? ' referer!' : ''))
    switch (u.pathname) {
      case '/short': return void res.writeHead(301, { Location: 'https://b.test/mid' }).end()
      case '/mid': return void res.writeHead(302, { Location: '/final.png' }).end()
      case '/final.png':
        res.writeHead(200, { 'Content-Type': 'image/png', 'Access-Control-Allow-Origin': '*' })
        return void res.end(req.method === 'HEAD' ? undefined : 'png')
      case '/nocors': return void res.writeHead(200, { 'Content-Type': 'image/png' }).end()
      case '/nohead':
        if (req.method === 'HEAD') return void res.writeHead(405).end()
        return void res.writeHead(302, { Location: '/final.png' }).end()
      case '/loop': return void res.writeHead(302, { Location: '/loop' }).end()
      case '/to-http': return void res.writeHead(302, { Location: 'http://a.test/final.png' }).end()
      case '/to-local': return void res.writeHead(302, { Location: 'https://localhost/final.png' }).end()
      case '/to-ip': return void res.writeHead(302, { Location: 'https://127.0.0.1/final.png' }).end()
      case '/to-port': return void res.writeHead(302, { Location: 'https://b.test:6379/final.png' }).end()
      case '/to-userinfo': return void res.writeHead(302, { Location: 'https://user:pw@b.test/final.png' }).end()
      case '/slow-redirect': return void setTimeout(() => res.writeHead(302, { Location: '/slow-redirect' }).end(), 60)
      case '/dribble': {
        // 頭書きのあと、本文を少しずつ送り続ける
        res.writeHead(200, { 'Content-Type': 'application/octet-stream' })
        const timer = setInterval(() => res.write('x'), 20)
        res.on('close', () => clearInterval(timer))
        return
      }
    }
    res.writeHead(404).end()
  })
  await new Promise<void>(ok => server.listen(0, '127.0.0.1', ok))
  const port = (server.address() as AddressInfo).port
  try {
    await fn({ 'a.test': '127.0.0.1:' + port, 'b.test': '127.0.0.1:' + port }, hits)
  }
  finally {
    server.closeAllConnections()
    await new Promise<void>(ok => server.close(() => ok()))
  }
}

test('転送を追って行き先を調べる (URL の短縮サービスなど)', async () => {
  await withServer(async (testHosts, hits) => {
    const origin = 'https://3d-map.torosaba.net'
    const r = await resolveRedirects('https://a.test/short', origin, { testHosts })
    assert.equal(r.url, 'https://b.test/final.png')
    assert.deepEqual(r.chain, ['https://a.test/short', 'https://b.test/mid', 'https://b.test/final.png'])
    assert.equal(r.cors, true)
    assert.equal(r.type, 'image/png')
    assert.ok(hits.length >= 3 && hits.every(h => !h.includes('cookie!') && !h.includes('referer!')), 'Cookie と Referer は送らない')
    assert.equal((await resolveRedirects('https://a.test/nocors', origin, { testHosts })).cors, false)
    // HEAD に答えないサイトは GET で
    assert.equal((await resolveRedirects('https://a.test/nohead', origin, { testHosts })).url, 'https://a.test/final.png')
    const before = hits.length
    for (const [path, status] of [['/loop', 508], ['/to-http', 403], ['/to-local', 403], ['/to-ip', 403], ['/to-port', 403], ['/to-userinfo', 403]] as const) {
      await assert.rejects(follow('https://a.test' + path, { method: 'HEAD' }, { testHosts }), (e: unknown) => {
        assert.ok(e instanceof UpstreamError, path)
        assert.equal(e.status, status, path)
        return true
      })
    }
    // 断った行き先にはつながない (転送を返したものだけ。/loop は 6 回)
    assert.equal(hits.length - before, 6 + 5)
  })
})

test('少しずつ送ってくるサイトでも、全体の時間で読むのをやめる', async () => {
  await withServer(async (testHosts) => {
    // 中継と再生リストの読み取りは、この signal で全体の時間を区切る。頭書きのあとの本文にも効く
    const f = await follow('https://a.test/dribble', { signal: AbortSignal.timeout(150) }, { testHosts })
    const start = performance.now()
    await assert.rejects(async () => {
      for await (const _chunk of f.res) { /* 読み続ける */ }
    })
    assert.ok(performance.now() - start < 2000)
    // 転送の行き先を調べるときは、転送が続いても全体の時間で区切る
    await assert.rejects(resolveRedirects('https://a.test/slow-redirect', 'https://3d-map.torosaba.net', { testHosts }, 100), (e: unknown) => {
      assert.ok(e instanceof UpstreamError)
      assert.equal(e.status, 504)
      return true
    })
  })
})

test('名前を引いて手元を指すなら、つながる前に断る', async () => {
  // localtest.me は 127.0.0.1 を指す公開の名前 (名前を引けないところでは確かめられないので飛ばす)
  try {
    await follow('https://localtest.me/', { method: 'HEAD', timeout: 5000 })
    assert.fail('つながってはいけない')
  }
  catch (e) {
    assert.ok(e instanceof UpstreamError)
    if (e.status === 502 && /ENOTFOUND|EAI_AGAIN/.test(e.message)) return
    assert.equal(e.status, 403, e.message)
  }
})