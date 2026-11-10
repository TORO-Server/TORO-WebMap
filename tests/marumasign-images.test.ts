// 画像の形式の試験 (app/bluemap/marumasign/decoders/): npm test
// fixtures/images/ の小さなファイルと、その期待する結果 (.rgba: 幅と高さ (4 バイトずつ、ビッグエンディアン) のあとに RGBA) は、
// MarumaSign 本体の Java のデコーダ (TIFF, DDS) と FFmpeg (DPX, XWD, IFF, PGX。本体が FFmpeg に読ませる形式) に出させたもの
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { sniff } from '../app/bluemap/marumasign/core.ts'
import { bcByteLength, decodeBc } from '../app/bluemap/marumasign/decoders/bcn.ts'
import { decodeDdsPixels, readDdsHeader } from '../app/bluemap/marumasign/decoders/dds.ts'
import { decodeDpx, decodeIlbm, decodePgx, decodeXwd } from '../app/bluemap/marumasign/decoders/extra.ts'
import { av1Codec, hasSequenceHeader, hevcCodec, parseHeif } from '../app/bluemap/marumasign/decoders/heif.ts'
import { jp2Alpha, jp2Size, jpxPdf } from '../app/bluemap/marumasign/decoders/jp2.ts'
import { decodeTiff, lzw } from '../app/bluemap/marumasign/decoders/tiff.ts'
import { parseWebpAnimation } from '../app/bluemap/marumasign/decoders/webp.ts'
import type { Pixels } from '../app/bluemap/marumasign/decoders/raster.ts'

const dir = new URL('./fixtures/images/', import.meta.url)
const file = (name: string): Uint8Array => new Uint8Array(readFileSync(new URL(name, dir)))
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dir), 'utf8')) as { name: string, tolerance: number, note: string }[]

async function decodeByName(name: string, b: Uint8Array): Promise<Pixels> {
  if (name.endsWith('.tif')) return decodeTiff(b)
  if (name.endsWith('.dds')) return decodeDdsPixels(b)
  if (name.endsWith('.dpx')) return decodeDpx(b)
  if (name.endsWith('.xwd')) return decodeXwd(b)
  if (name.endsWith('.pgx')) return decodePgx(b)
  if (name.endsWith('.iff')) return decodeIlbm(b)
  throw new Error('unknown fixture ' + name)
}

for (const { name, tolerance, note } of manifest) {
  test(`${name} は ${note} と同じに読める`, async () => {
    const expected = file(name + '.rgba')
    const w = (expected[0]! << 24 | expected[1]! << 16 | expected[2]! << 8 | expected[3]!) >>> 0
    const h = (expected[4]! << 24 | expected[5]! << 16 | expected[6]! << 8 | expected[7]!) >>> 0
    const px = await decodeByName(name, file(name))
    assert.equal(px.width, w, 'width')
    assert.equal(px.height, h, 'height')
    let worst = 0, at = -1
    for (let i = 0; i < w * h * 4; i++) {
      const d = Math.abs(px.data[i]! - expected[8 + i]!)
      if (d > worst) {
        worst = d
        at = i
      }
    }
    assert.ok(worst <= tolerance, `差 ${worst} (画素 ${Math.floor(at / 4)} のチャンネル ${at % 4}: ${px.data[at]} と ${expected[8 + at]})`)
  })
}

test('中身で形式を決める (本体の StillFormats と同じ)', () => {
  const b = (...parts: (number[] | string)[]): Uint8Array => {
    const out: number[] = []
    for (const p of parts) {
      if (typeof p === 'string') for (const c of p) out.push(c.charCodeAt(0))
      else out.push(...p)
    }
    while (out.length < 64) out.push(0)
    return new Uint8Array(out)
  }
  const fmt = (h: Uint8Array, ext = '', type = ''): string => {
    const s = sniff(h, type, ext)
    return s ? s.route + ':' + s.format : 'null'
  }
  assert.equal(fmt(file('dpx-rgb24.dpx').subarray(0, 64)), 'image:dpx')
  assert.equal(fmt(b('XPDS')), 'image:dpx')
  assert.equal(fmt(file('iff-ilbm4.iff').subarray(0, 64)), 'image:iff')
  assert.equal(fmt(file('iff-pbm.iff').subarray(0, 64)), 'image:iff')
  assert.equal(fmt(file('iff-acbm.iff').subarray(0, 64)), 'image:iff')
  assert.equal(fmt(b('FORM', [0, 0, 0, 4], '8SVX')), 'null')
  assert.equal(fmt(file('j2k-rgb.j2k').subarray(0, 64)), 'image:jp2')
  assert.equal(fmt(file('jp2-rgb.jp2').subarray(0, 64)), 'image:jp2')
  // 拡張子でしか分からないもの
  assert.equal(fmt(file('xwd-rgb24.xwd').subarray(0, 64), 'xwd'), 'image:xwd')
  assert.equal(fmt(file('xwd-rgb24.xwd').subarray(0, 64), ''), 'null')
  assert.equal(fmt(file('pgx-8u.pgx').subarray(0, 64), 'pgx'), 'image:pgx')
  for (const ext of ['tga', 'icb', 'vda', 'vst', 'targa']) assert.equal(fmt(b([0, 0, 2]), ext), 'image:tga', ext)
  assert.equal(fmt(b('<!-- ' + 'x'.repeat(40)), 'svg'), 'image:svg')
  // ISO BMFF のブランド (互換ブランドも見る)
  const ftyp = (major: string, ...compat: string[]): Uint8Array => {
    const size = 16 + compat.length * 4
    return b([0, 0, 0, size], 'ftyp', major, [0, 0, 0, 0], compat.join(''))
  }
  assert.equal(fmt(ftyp('mif1', 'mif1', 'avif', 'miaf')), 'image:avif')
  assert.equal(fmt(ftyp('mif1', 'mif1', 'heic')), 'image:heic')
  assert.equal(fmt(ftyp('heic', 'mif1', 'heic')), 'image:heic')
  assert.equal(fmt(ftyp('msf1', 'msf1', 'hevc')), 'video:video')
  assert.equal(fmt(ftyp('hevc', 'hevc', 'msf1')), 'video:video')
  assert.equal(fmt(ftyp('avis', 'avis', 'msf1', 'avif')), 'image:avif')
  assert.equal(fmt(ftyp('isom', 'isom', 'mp41')), 'video:video')
  assert.equal(fmt(file('heic-rgb.heic').subarray(0, 64)), 'image:heic')
  assert.equal(fmt(file('avif-alpha.avif').subarray(0, 64)), 'image:avif')
})

test('BC の展開の大きさと、壊れたデータ', () => {
  assert.equal(bcByteLength('bc1', 19, 11), 5 * 3 * 8)
  assert.equal(bcByteLength('bc7', 4, 4), 16)
  assert.throws(() => decodeBc('bc7', new Uint8Array(15), 0, 4, 4), /truncated/)
  // BC1 の 2 色 (c0 > c1 は 4 色、c0 <= c1 は 3 色と透明)
  const block = new Uint8Array([0x00, 0xF8, 0x1F, 0x00, 0b11100100, 0, 0, 0])
  const px = decodeBc('bc1', block, 0, 4, 4)
  assert.deepEqual(Array.from(px.subarray(0, 16)), [255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255])
  const three = decodeBc('bc1', new Uint8Array([0x1F, 0x00, 0x00, 0xF8, 0b11000000, 0, 0, 0]), 0, 4, 4)
  assert.deepEqual(Array.from(three.subarray(12, 16)), [0, 0, 0, 0])
  // DDS の見出し
  const h = readDdsHeader(file('dds-bc7.dds'))
  assert.equal(h.bc, 'bc7')
  assert.equal(h.width, 19)
  assert.equal(readDdsHeader(file('dds-bc7-srgb.dds')).srgb, true)
  assert.throws(() => readDdsHeader(new Uint8Array(200)), /not a dds/)
})

test('TIFF の LZW と、壊れたファイル', async () => {
  // 256 (最初の表) 65 66 257 (終わり) を 9 ビットずつ
  const bits = [256, 65, 66, 258, 257].map(v => v.toString(2).padStart(9, '0')).join('')
  const bytes = new Uint8Array(Math.ceil(bits.length / 8))
  for (let i = 0; i < bits.length; i++) if (bits[i] === '1') bytes[i >> 3]! |= 0x80 >> (i & 7)
  assert.deepEqual(Array.from(lzw(bytes, 4)), [65, 66, 65, 66])
  await assert.rejects(decodeTiff(new Uint8Array([0x49, 0x49, 42, 0, 8, 0, 0, 0, 0xFF, 0xFF])), /directory|image/)
  const bad = new Uint8Array(file('tiff-lzw.tif'))
  await assert.rejects(decodeTiff(bad.subarray(0, 40)))
})

test('アニメーションの WebP のコマ', () => {
  const a = parseWebpAnimation(file('webp-anim-lossless.webp'), 512)!
  assert.ok(a)
  assert.equal(a.width, 64)
  assert.equal(a.height, 40)
  assert.equal(a.loops, 3)
  assert.equal(a.frames.length, 3)
  // 0 は 100 ミリ秒、20 より短いものは 20 (本体と同じ)
  assert.deepEqual(a.frames.map(f => f.delay), [100, 300, 100])
  for (const f of a.frames) {
    assert.equal(String.fromCharCode(...f.file.subarray(0, 4)), 'RIFF')
    assert.equal(String.fromCharCode(...f.file.subarray(8, 12)), 'WEBP')
    const size = f.file[4]! | (f.file[5]! << 8) | (f.file[6]! << 16) | (f.file[7]! << 24)
    assert.equal(size + 8, f.file.length)
    assert.ok(f.x + f.width <= a.width && f.y + f.height <= a.height)
  }
  const lossy = parseWebpAnimation(file('webp-anim-lossy.webp'), 512)!
  assert.equal(lossy.loops, 0)
  assert.equal(lossy.frames.length, 3)
  // 透明度のある非可逆のコマは、ALPH と VP8 を VP8X の形で包む
  const withAlpha = lossy.frames.find(f => String.fromCharCode(...f.file.subarray(12, 16)) === 'VP8X')
  assert.ok(withAlpha, 'VP8X で包んだコマがある')
  assert.equal(String.fromCharCode(...withAlpha.file.subarray(30, 34)), 'ALPH')
  assert.equal(parseWebpAnimation(file('webp-anim-lossy.webp'), 2)!.frames.length, 2)
  // アニメーションでない WebP
  assert.equal(parseWebpAnimation(new Uint8Array([...'RIFF\x1a\0\0\0WEBPVP8L'].map(c => c.charCodeAt(0)).concat(new Array(20).fill(0))), 512), null)
})

test('HEIF の箱 (HEIC と AVIF)', () => {
  const heic = parseHeif(file('heic-rgb.heic'))
  assert.match(heic.color.codec, /^hvc1\.\d+\.[0-9A-F]+\.[LH]\d+(\.[0-9A-F]+)*$/)
  assert.equal(heic.color.tiles.length, 1)
  // x265 は 64 の倍数の大きさで符号化し、clap で切り抜く
  assert.equal(heic.color.width, 64)
  assert.equal(heic.color.height, 64)
  assert.deepEqual(heic.crop, { x: 0, y: 0, width: 64, height: 40 })
  assert.equal(heic.alpha, null)
  // hvcC の長さつきの NAL (先頭 4 バイトが長さ)
  const t = heic.color.tiles[0]!.data
  const len = (t[0]! << 24 | t[1]! << 16 | t[2]! << 8 | t[3]!) >>> 0
  assert.ok(len > 0 && len + 4 <= t.length)
  const alpha = parseHeif(file('heic-alpha.heic'))
  assert.ok(alpha.alpha, '透明度の絵がある')
  assert.equal(alpha.alpha.width, 64)
  const avif = parseHeif(file('avif-alpha.avif'))
  assert.match(avif.color.codec, /^av01\.\d\.\d\d[MH]\.(08|10|12)$/)
  assert.equal(avif.color.width, 64)
  assert.equal(avif.color.height, 40)
  assert.ok(avif.alpha)
  assert.throws(() => parseHeif(file('jp2-rgb.jp2')), /heif/)
  // codec の文字列 (ISO/IEC 14496-15 の付録 E の例)
  const hvcC = new Uint8Array(23)
  hvcC[0] = 1
  hvcC[1] = 0x01 // 主な profile 1 (Main)
  hvcC[2] = 0x60 // 互換性の印 (1 と 2)
  hvcC[6] = 0x90 // 制約の印
  hvcC[12] = 93
  assert.equal(hevcCodec(hvcC), 'hvc1.1.6.L93.90')
  assert.equal(av1Codec(new Uint8Array([0x81, 0x08, 0x0C, 0])), 'av01.0.08M.08')
  assert.equal(av1Codec(new Uint8Array([0x81, 0x4D, 0xC0, 0])), 'av01.2.13H.10')
})

test('XWD の 32 ビットの透明度 (すべて 0 なら不透明にする)', () => {
  const b = new Uint8Array(file('xwd-bgra.xwd'))
  const dv = new DataView(b.buffer)
  const header = dv.getUint32(0), lineBytes = dv.getUint32(48)
  for (let y = 0; y < 11; y++) for (let x = 0; x < 19; x++) b[header + y * lineBytes + x * 4 + 3] = 0
  const px = decodeXwd(b)
  for (let i = 3; i < px.data.length; i += 4) assert.equal(px.data[i], 255)
})

test('HEIF の AV1 の OBU', () => {
  // temporal delimiter (種類 2) と sequence header (種類 1)
  assert.equal(hasSequenceHeader(new Uint8Array([0x12, 0x00, 0x0A, 0x02, 0xAA, 0xBB])), true)
  // temporal delimiter のあとにすぐ frame (種類 6)
  assert.equal(hasSequenceHeader(new Uint8Array([0x12, 0x00, 0x32, 0x01, 0x00])), false)
  // HEIF の中の AV1 の絵には、展開に渡す sequence header がある (なければ av1C から足す)
  const avif = parseHeif(file('avif-alpha.avif'))
  assert.ok(hasSequenceHeader(avif.color.tiles[0]!.data))
})

test('JPEG 2000 の大きさと、それを包む PDF', () => {
  assert.equal(jp2Alpha(file('jp2-rgba.jp2')), 1)
  assert.equal(jp2Alpha(file('jp2-rgb.jp2')), 0)
  assert.equal(jp2Alpha(file('j2k-rgb.j2k')), 1)
  assert.deepEqual(jp2Size(file('jp2-rgb.jp2')), { width: 64, height: 40 })
  assert.deepEqual(jp2Size(file('j2k-rgb.j2k')), { width: 64, height: 40 })
  assert.equal(jp2Size(new Uint8Array(16)), null)
  const jpx = file('jp2-rgba.jp2')
  const pdf = jpxPdf(jpx, 64, 40)
  const text = new TextDecoder('latin1').decode(pdf)
  assert.ok(text.startsWith('%PDF-1.7'))
  assert.match(text, /\/Filter \/JPXDecode \/SMaskInData 1 \/Length 746 >>/)
  // xref の位置と、それぞれの obj の位置が合っている
  const startxref = Number(/startxref\n(\d+)/.exec(text)![1])
  assert.ok(text.startsWith('xref', startxref))
  const offsets = [...text.substring(startxref).matchAll(/^(\d{10}) 00000 n $/gm)].map(m => Number(m[1]))
  offsets.forEach((o, i) => assert.ok(text.startsWith(`${i + 1} 0 obj`, o), `obj ${i + 1}`))
  // 絵のバイト列がそのまま入っている
  const at = text.indexOf('stream\n', text.indexOf('/JPXDecode')) + 7
  assert.deepEqual(pdf.subarray(at, at + jpx.length), jpx)
})
