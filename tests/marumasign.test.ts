// MarumaSign の看板の表示 (app/bluemap/marumasign/core.ts) の試験: npm test
// MarumaSign Companion の src/test/js/marumasign3d.test.js を TypeScript にしたものと、種類の判別などの試験。
// fixtures/reference-mesh.json は MarumaSign 本体 (SignImage.java) が出した頂点 (別の基準データは MARUMASIGN_REFERENCE で渡せる)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import {
  blockKey, buildMesh, clampPage, displayHost, extensionOf, fitScale, hideBoards, kindIdOf, mediaGain, mediaKindOf, nearest,
  parseSign, planRoute, reconnectDelay, requestedPage, safeUrl, shorten, sniff, viewDistance, withoutFragment,
  type ParsedSign, type SignShape,
} from '../app/bluemap/marumasign/core.ts'

const limits = { maxSize: 64, maxOffset: 64 }
const kindCount = 8
const good = [10, 64, -20, 4, 0, 'https://example.com/a.png', 'https://example.com/a.png', 0, 0, 0, 2, 3, 0, 90, 0]
const reject = (mutate: (a: unknown[]) => void): ParsedSign | null => {
  const a: unknown[] = good.slice()
  mutate(a)
  return parseSign(a, kindCount, limits)
}

test('URL は https/http だけ、怪しいホストやポートは使わない', () => {
  for (const ok of ['https://example.com/a.png', 'https://i.imgur.com///x.png?a=1&b=2', 'https://sub.example.co.jp:8443/x']) {
    assert.ok(safeUrl(ok, true), ok)
  }
  assert.ok(safeUrl('http://example.com/a', false))
  assert.equal(safeUrl('http://example.com/a', true), null, '画像は https のみ')
  for (const bad of [
    'javascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'ftp://example.com/a', '//example.com/a',
    'https://user:pw@example.com/a', 'https://user@example.com/a', 'https://localhost/a', 'https://a.localhost/a',
    'https://127.0.0.1/a', 'https://192.168.0.1/a', 'https://[::1]/a', 'https://2130706433/a', 'https://printer.local/a',
    'https://router/a', 'https://example.com:22/a', 'https://example.com:6379/a', 'https://example.com/a b', 'https://example.com/"x',
    'https://example.com/<x>', 'https://example.com/a\\b', 'https://example.com/a`b', "https://example.com/a'b",
    'https://exa mple.com/', '', null, undefined, 5, {}, 'https://' + 'a'.repeat(2100) + '.com/']) {
    assert.equal(safeUrl(bad, false), null, String(bad))
  }
})

test('データの 1 件', () => {
  const s = parseSign(good, kindCount, limits)
  assert.ok(s)
  assert.equal(s.image, 'https://example.com/a.png')
  assert.equal(reject(a => (a[6] = 'javascript:alert(1)')), null)
  assert.equal(reject(a => (a[0] = 1.5)), null)
  assert.equal(reject(a => (a[0] = '1')), null)
  assert.equal(reject(a => (a[4] = 99)), null)
  assert.equal(reject(a => (a[3] = 20)), null)
  assert.equal(reject(a => (a[9] = NaN)), null)
  assert.equal(reject(a => (a[9] = Infinity)), null)
  assert.equal(reject(a => (a[9] = '0')), null)
  assert.equal(parseSign(good.slice(0, 14), kindCount, limits), null)
  assert.equal(parseSign('x', kindCount, limits), null)
  assert.equal(parseSign(null, kindCount, limits), null)
  // 画像の URL が危なければ、画像だけ使わない (ラベルは残す)。向きが分からなければ画像にしない
  assert.equal(reject(a => (a[5] = 'http://example.com/a.png'))!.image, null)
  assert.equal(reject(a => (a[5] = 'https://127.0.0.1/a.png'))!.image, null)
  assert.equal(reject(a => (a[3] = -1))!.image, null)
  // 大きさと位置のずれには上限がかかる (空を覆うような悪戯を防ぐ)
  const huge = reject((a) => {
    a[7] = 1000; a[8] = -1000; a[9] = 999; a[10] = 1000; a[11] = -1000
  })!
  assert.equal(huge.ox, 64); assert.equal(huge.oy, -64); assert.equal(huge.oz, 64)
  assert.equal(huge.sx, 64); assert.equal(huge.sy, -64)
  assert.equal(reject(a => (a[13] = 99999))!.yaw, 1000)
})

test('表示用', () => {
  assert.equal(displayHost('https://Example.com:8443/a?b#c'), 'example.com')
  assert.equal(displayHost('not a url'), '')
  assert.ok(shorten('https://example.com/' + 'a'.repeat(200), 36).length <= 36)
})

test('幾何: 基本のケース', () => {
  // 回転 0 の立て看板、1x1 の正方形: 看板の南側から見える。ブロックの中心 (x 0..1, y 0..1, z ≈ 0.4975)
  const sign: SignShape = { ox: 0, oy: 0, oz: 0, sx: 1, sy: 1, roll: 0, yaw: 0, pitch: 0, orient: 0 }
  const p = buildMesh(sign, 100, 100).positions
  const xs: number[] = [], ys: number[] = []
  for (let i = 0; i < 4; i++) {
    xs.push(p[i * 3]!)
    ys.push(p[i * 3 + 1]!)
    assert.ok(Math.abs(p[i * 3 + 2]! - 0.4975) < 1e-6)
  }
  assert.ok(Math.abs(Math.min(...xs)) < 1e-6 && Math.abs(Math.max(...xs) - 1) < 1e-6)
  assert.ok(Math.abs(Math.min(...ys)) < 1e-6 && Math.abs(Math.max(...ys) - 1) < 1e-6)
  // 壁掛け (南向き): 北側の壁に付く
  const wall = buildMesh({ ...sign, orient: 16 }, 100, 100)
  assert.ok(Math.abs(wall.positions[2]! - (0.5 - 0.4375 - 0.0025)) < 1e-6, String(wall.positions[2]))
  // 縦横比: 200x100 は横が 2 倍 (長い辺が指定の大きさ)
  const wide = buildMesh(sign, 200, 100).positions
  const wx = [wide[0]!, wide[3]!, wide[6]!, wide[9]!]
  assert.ok(Math.abs(Math.max(...wx) - Math.min(...wx) - 1) < 1e-6)
  // 見える距離 (MarumaSign 本体と同じ式。上限は設定)
  assert.ok(Math.abs(viewDistance(sign, 192) - (64 + Math.SQRT2 * 2)) < 1e-9)
  assert.equal(viewDistance({ ...sign, sx: 1000, sy: 1000 }, 192), 192)
})

test('看板の板を消す', () => {
  // タイルの位置 (-30, 0, -2014)。看板はブロック (-28, 69, -2010) = タイルの中では (2, 69, 4)
  const cells = new Set([blockKey(-28, 69, -2010)])
  const positions = new Float32Array([
    // 看板の板 (ブロックの中): 消す
    2.1, 69.5, 4.875, 2.9, 69.5, 4.875, 2.9, 69.9, 4.875,
    // 地面の上面 (ブロックの下の境界 y=69 に乗る。表は上): 残す
    2, 69, 4, 3, 69, 5, 3, 69, 4,
    // 隣のブロックの側面 (x=2 の境界に乗る。表は +x、看板のほうを向く): 残す
    2, 69, 4, 2, 70, 4, 2, 70, 5,
    // 看板でないブロックの中: 残す
    5.1, 69.5, 4.5, 5.9, 69.5, 4.5, 5.9, 69.9, 4.5,
    // ブロックからはみ出す三角形: 残す
    1.5, 69.5, 4.5, 2.9, 69.5, 4.5, 2.9, 69.9, 4.5,
    // 板の小口 (左の端、x=2 の境界に乗る。表は -x): 消す
    2, 69.3, 4.1, 2, 69.8, 4.9, 2, 69.8, 4.1,
    // 板の小口 (右の端、x=3 の境界に乗る。表は +x。重心が隣のブロックに入るが看板のもの): 消す
    3, 69.3, 4.1, 3, 69.8, 4.1, 3, 69.8, 4.9,
    // 隣のブロックの側面 (x=3 の境界に乗る。表は -x、看板のほうを向く): 残す
    3, 69, 4, 3, 70, 5, 3, 70, 4,
  ])
  const before = Array.from(positions)
  assert.equal(hideBoards(positions, -30, 0, -2014, cells), 3)
  // 消した三角形は 1 点に潰れている
  assert.deepEqual(Array.from(positions.slice(0, 9)), [2.1, 69.5, 4.875, 2.1, 69.5, 4.875, 2.1, 69.5, 4.875].map(Math.fround))
  assert.deepEqual(Array.from(positions.slice(45, 54)), [2, 69.3, 4.1, 2, 69.3, 4.1, 2, 69.3, 4.1].map(Math.fround))
  assert.deepEqual(Array.from(positions.slice(54, 63)), [3, 69.3, 4.1, 3, 69.3, 4.1, 3, 69.3, 4.1].map(Math.fround))
  assert.deepEqual(Array.from(positions.slice(9, 45)), before.slice(9, 45), 'ほかの三角形はそのまま')
  assert.deepEqual(Array.from(positions.slice(63)), before.slice(63), '隣のブロックの面はそのまま')
  // 2 回目は何もしない
  assert.equal(hideBoards(positions, -30, 0, -2014, cells), 0)
  assert.equal(hideBoards(new Float32Array(before), -30, 0, -2014, new Set()), 0, '看板がなければ何もしない')
})

test('MarumaSign 本体 (SignImage.java) との突き合わせ', (t) => {
  const ref = process.env.MARUMASIGN_REFERENCE || new URL('./fixtures/reference-mesh.json', import.meta.url)
  if (!existsSync(ref)) {
    t.skip('基準データがない')
    return
  }
  const cases = JSON.parse(readFileSync(ref, 'utf8')) as { v: number[], w: number, h: number, orient: number, mesh: number[] }[]
  let worst = 0
  for (const c of cases) {
    const sign: SignShape = { ox: c.v[0]!, oy: c.v[1]!, oz: c.v[2]!, sx: c.v[3]!, sy: c.v[4]!, roll: c.v[5]!, yaw: c.v[6]!, pitch: c.v[7]!, orient: c.orient }
    const out = buildMesh(sign, c.w, c.h)
    for (let i = 0; i < 8; i++) {
      const o = i * 8 // x, y, z, u, v, nx, ny, nz
      const exp = [c.mesh[o]!, c.mesh[o + 1]!, c.mesh[o + 2]!, c.mesh[o + 3]!, c.mesh[o + 4]!]
      const got = [out.positions[i * 3]!, out.positions[i * 3 + 1]!, out.positions[i * 3 + 2]!, out.uvs[i * 2]!, out.uvs[i * 2 + 1]!]
      for (let k = 0; k < 5; k++) {
        const d = Math.abs(exp[k]! - got[k]!)
        worst = Math.max(worst, d)
        assert.ok(d < 2e-4, `case ${JSON.stringify(c.v)} orient ${c.orient} vertex ${i} component ${k}: expected ${exp[k]} got ${got[k]}`)
      }
    }
  }
  t.diagnostic(`${cases.length} cases match MarumaSign (max difference ${worst.toExponential(2)})`)
})

// ---------------------------------------------------------------- ここからは前のスクリプトになかったもの

test('データファイルの kinds から種類を決める (並びが変わっても困らない)', () => {
  assert.equal(kindIdOf(['🖼', '画像'], 0), 'image')
  assert.equal(kindIdOf(['🎬', '動画'], 5), 'video', 'icon で決める')
  assert.equal(kindIdOf(['📄️', 'x'], 0), 'pdf', '異体字セレクタは無視')
  assert.equal(kindIdOf(['?', '音声'], 0), 'audio', 'label で決める')
  assert.equal(kindIdOf(['?', '?'], 6), 'structure', 'どちらも分からなければ位置で')
  assert.equal(kindIdOf(undefined, 99), 'other')
})

test('拡張子と種類 (MarumaSign Companion の MediaKind と同じ)', () => {
  assert.equal(extensionOf('https://a.example/x/IMG.PNG?x=1#page=2'), 'png')
  assert.equal(extensionOf('https://a.example/x/'), '')
  assert.equal(extensionOf('https://a.example/x.'), '')
  assert.equal(extensionOf('https://a.example/a.b/file'), '')
  assert.equal(mediaKindOf('m3u8'), 'video')
  assert.equal(mediaKindOf('opus'), 'audio')
  assert.equal(mediaKindOf('ksplat'), 'splat')
  assert.equal(mediaKindOf('litematic'), 'structure')
  assert.equal(mediaKindOf('qoi'), 'image')
  assert.equal(mediaKindOf('pdf'), 'pdf')
  assert.equal(mediaKindOf('exe'), 'other')
})

test('描き方を決める', () => {
  const sign = (image: string | null, link: string, orient = 0) => ({ image, link, orient })
  // プラグインが画像の URL を書いたものは、前と同じ読み方
  assert.deepEqual(planRoute(sign('https://e.example/a.png', 'https://e.example/a.png'), 'image'), { type: 'image', url: 'https://e.example/a.png', legacy: true, ext: 'png' })
  // 拡張子のない「リンク」は中身を見る
  assert.equal(planRoute(sign('https://e.example/a', 'https://e.example/a'), 'other')!.type, 'probe')
  assert.equal(planRoute(sign(null, 'https://e.example/live'), 'other')!.type, 'probe')
  // 向きが分からなければ絵にしない
  assert.equal(planRoute(sign('https://e.example/a.png', 'https://e.example/a.png', -1), 'image'), null)
  // http は描かない (ラベルだけ)
  assert.equal(planRoute(sign(null, 'http://e.example/a.mp4'), 'video'), null)
  assert.equal(planRoute(sign(null, 'https://e.example/a.mp4'), 'video')!.type, 'video')
  assert.equal(planRoute(sign(null, 'https://e.example/a.mp3'), 'audio')!.type, 'video')
  assert.equal(planRoute(sign(null, 'https://e.example/live.m3u8'), 'video')!.type, 'hls')
  assert.equal(planRoute(sign(null, 'https://e.example/live.mpd'), 'video')!.type, 'dash')
  assert.equal(planRoute(sign(null, 'https://e.example/live.flv'), 'other')!.type, 'flv')
  assert.equal(planRoute(sign(null, 'https://e.example/doc.pdf#page=3'), 'pdf')!.type, 'pdf')
  assert.equal(planRoute(sign(null, 'https://e.example/a.tga'), 'image')!.type, 'image')
  assert.equal(planRoute(sign(null, 'https://e.example/a.glb'), 'model')!.type, 'model')
  assert.equal(planRoute(sign(null, 'https://e.example/a.ply'), 'splat')!.type, 'splat')
  assert.equal(planRoute(sign(null, 'https://e.example/a.schem'), 'structure')!.type, 'structure')
})

test('中身で形式を決める', () => {
  const b = (...parts: (string | number[])[]): Uint8Array => {
    const out: number[] = []
    for (const p of parts) {
      if (typeof p === 'string') for (const ch of p) out.push(ch.charCodeAt(0))
      else out.push(...p)
    }
    return new Uint8Array(out)
  }
  const fmt = (head: Uint8Array, type = '', ext = '') => {
    const s = sniff(head, type, ext)
    return s ? s.route + ':' + s.format : null
  }
  assert.equal(fmt(b([0x89], 'PNG\r\n')), 'image:png')
  assert.equal(fmt(b('GIF89a')), 'image:gif')
  assert.equal(fmt(b([0xFF, 0xD8, 0xFF, 0xE0])), 'image:jpeg')
  assert.equal(fmt(b('RIFF', [0, 0, 0, 0], 'WEBPVP8 ')), 'image:webp')
  assert.equal(fmt(b('RIFF', [0, 0, 0, 0], 'ACONanih')), 'image:ani')
  assert.equal(fmt(b([0, 0, 1, 0, 1, 0])), 'image:ico')
  assert.equal(fmt(b([0, 0, 2, 0, 1, 0])), 'image:cur')
  assert.equal(fmt(b('8BPS')), 'image:psd')
  assert.equal(fmt(b('qoif')), 'image:qoi')
  assert.equal(fmt(b('DDS ')), 'image:dds')
  assert.equal(fmt(b([0xAB], 'KTX 20')), 'image:ktx2')
  assert.equal(fmt(b('II', [42, 0])), 'image:tiff')
  assert.equal(fmt(b('MM', [0, 42])), 'image:tiff')
  assert.equal(fmt(b('#?RADIANCE\n')), 'image:hdr')
  assert.equal(fmt(b([0x76, 0x2F, 0x31, 0x01])), 'image:exr')
  assert.equal(fmt(b('P6\n')), 'image:pnm')
  assert.equal(fmt(b('Pf\n')), 'image:pfm')
  assert.equal(fmt(b('farbfeld')), 'image:farbfeld')
  assert.equal(fmt(b([0, 0, 0, 0], 'ftypavif')), 'image:avif')
  assert.equal(fmt(b([0, 0, 0, 0], 'ftypheic')), 'image:heic')
  assert.equal(fmt(b([0, 0, 0, 0], 'ftypisom')), 'video:video')
  assert.equal(fmt(b([0, 0, 0, 0], 'ftypM4A ')), 'video:audio')
  assert.equal(fmt(b('<?xml version="1.0"?>\n<!-- c -->\n<svg xmlns="http://www.w3.org/2000/svg">')), 'image:svg')
  assert.equal(fmt(b('  <svg>')), 'image:svg')
  assert.equal(fmt(b([0x1F, 0x8B, 8]), '', 'svgz'), 'image:svgz')
  assert.equal(fmt(b('/* XPM */')), 'image:xpm')
  assert.equal(fmt(b('#define x_width 8\n'), '', 'xbm'), 'image:xbm')
  assert.equal(fmt(b('#define x_width 8\n')), null, 'XBM は拡張子がなければ決めない')
  // 目印のない形式は拡張子で
  assert.equal(fmt(b([0, 0, 2, 0]), '', 'tga'), 'image:tga')
  assert.equal(fmt(b([0, 0, 8, 8]), '', 'wbmp'), 'image:wbmp')
  assert.equal(fmt(b([0, 0, 2, 0])), null)
  // PDF は先頭の近くから探す
  assert.equal(fmt(b('junk\n%PDF-1.7')), 'pdf:pdf')
  // 動画・音声・ライブ配信
  assert.equal(fmt(b('#EXTM3U\n')), 'hls:video')
  assert.equal(fmt(b('<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011">')), 'dash:video')
  assert.equal(fmt(b('FLV', [1, 5])), 'flv:video')
  assert.equal(fmt(b([0x1A, 0x45, 0xDF, 0xA3])), 'video:video')
  assert.equal(fmt(b('OggS')), 'video:audio')
  assert.equal(fmt(b('OggS'), 'video/ogg'), 'video:video')
  assert.equal(fmt(b('RIFF', [0, 0, 0, 0], 'WAVE')), 'video:audio')
  assert.equal(fmt(b('fLaC')), 'video:audio')
  assert.equal(fmt(b('ID3', [4, 0])), 'video:audio')
  assert.equal(fmt(b('--frame\r\n'), 'multipart/x-mixed-replace'), 'mjpeg:video')
  assert.equal(fmt(b('x'), 'application/vnd.apple.mpegurl'), 'hls:video')
  assert.equal(fmt(b('x'), 'video/x-flv'), 'flv:video')
  // 3D
  assert.equal(fmt(b('glTF')), 'model:glb')
  assert.equal(fmt(b('ply\nformat binary_little_endian 1.0\nelement vertex 3\nproperty float x\nproperty float f_dc_0\nend_header\n')), 'splat:ply')
  assert.equal(fmt(b('ply\nformat ascii 1.0\nelement vertex 3\nproperty float x\nend_header\n')), null, 'ガウス分布の項目がない .ply (ふつうの点群) は読まない')
  assert.equal(fmt(b('{"asset":{"version":"2.0"}}')), 'model:gltf')
  assert.equal(fmt(b([0xEF, 0xBB, 0xBF], '  {"asset":{}}')), 'model:gltf')
  // HTML のページなどは何でもない
  assert.equal(fmt(b('<!DOCTYPE html><html>'), 'text/html'), null)
})

test('PDF のページの指定 (MarumaSign 本体の PdfFile.requestedPage と同じ)', () => {
  assert.equal(requestedPage('https://e.example/a.pdf'), 0)
  assert.equal(requestedPage('https://e.example/a.pdf#page=3'), 2)
  assert.equal(requestedPage('https://e.example/a.pdf#zoom=50&page=3'), 2)
  assert.equal(requestedPage('https://e.example/a.pdf#page=3&zoom=50'), 2)
  assert.equal(requestedPage('https://e.example/a.pdf#PAGE=007'), 6)
  assert.equal(requestedPage('https://e.example/a.pdf#page=0'), 0, '正しくない番号は最初のページ')
  assert.equal(requestedPage('https://e.example/a.pdf#page=abc'), 0)
  assert.equal(requestedPage('https://e.example/a.pdf#page='), 0)
  assert.equal(requestedPage('https://e.example/a.pdf#page=-2'), 0)
  assert.equal(requestedPage('https://e.example/a.pdf#page=99999999999'), 2147483647, '大きすぎれば最後のページを指す')
  assert.equal(clampPage(requestedPage('https://e.example/a.pdf#page=99'), 5), 4, 'ページの数より大きければ最後のページ')
  assert.equal(clampPage(-3, 5), 0)
  assert.equal(withoutFragment('https://e.example/a.pdf#page=3'), 'https://e.example/a.pdf')
  assert.equal(withoutFragment('https://e.example/a.pdf'), 'https://e.example/a.pdf')
})

test('音の大きさ (MarumaSign 本体の MediaSession.gain と同じ)', () => {
  assert.equal(mediaGain(0, 100), 1)
  assert.equal(mediaGain(16, 100), 0.25)
  assert.equal(mediaGain(32, 100), 0)
  assert.equal(mediaGain(100, 100), 0)
  assert.equal(mediaGain(Infinity, 100), 0)
  assert.equal(mediaGain(16, 50), 0.125)
})

test('近いものから選ぶ (同時に再生する数の上限)', () => {
  const items = [{ d: 30 }, { d: 5 }, { d: Infinity }, { d: 12 }, { d: 50 }]
  const chosen = nearest(items, i => i.d, 2)
  assert.deepEqual(Array.from(chosen).map(i => i.d).sort((a, b) => a - b), [5, 12])
  assert.equal(nearest(items, i => i.d, 10).size, 4, '距離の分からないものは選ばない')
  assert.equal(nearest(items, i => i.d, 0).size, 0)
})

test('縮める倍率と、つなぎ直すまでの待ち時間', () => {
  assert.equal(fitScale(100, 50, 1024), 1)
  assert.equal(fitScale(2048, 1024, 1024), 0.5)
  // アニメーション: 全部のコマで上限まで
  const s = fitScale(1000, 1000, 1024, 100, 10_000_000)
  assert.ok(Math.abs(1000 * 1000 * 100 * s * s - 10_000_000) < 1)
  assert.equal(reconnectDelay(0), 2000)
  assert.equal(reconnectDelay(1), 4000)
  assert.equal(reconnectDelay(3), 16000)
  assert.equal(reconnectDelay(4), 30000)
  assert.equal(reconnectDelay(100), 30000)
})
