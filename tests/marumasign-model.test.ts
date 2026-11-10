// 3D モデルの看板のうち、ブラウザーに頼らない部分の試験: npm test
// BC1 - BC7 の CPU での展開 (decoders/bcn.ts。GPU が S3TC・BPTC を描けないときに使う)
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bcnByteLength, decodeBcnToRgba, type BcnFormat } from '../app/bluemap/marumasign/decoders/bcn.ts'

/** 決まった並びのでたらめなバイト (xorshift32) */
function random(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s ^= s << 13
    s >>>= 0
    s ^= s >>> 17
    s ^= s << 5
    s >>>= 0
    return s & 255
  }
}

const hash = (a: Uint8Array | Uint16Array): string => createHash('sha256').update(Buffer.from(a.buffer, a.byteOffset, a.byteLength)).digest('hex').slice(0, 16)

test('BCn: でたらめなブロック (すべてのモード) の展開の結果が変わらない', () => {
  // 32x32 のでたらめなブロックを展開した結果。作ったときに次の 2 つと比べてある:
  //  - Pillow 12.2 の展開 (BC1 - BC5、BC6H、BC7 の決まったモード。差は 1 まで)
  //  - GPU (Direct3D 11 の S3TC・BPTC) で描いた色 (rnd_*.glb を GPU と CPU で描いて比べた)
  // 符号つきの BC4S・BC5S は MarumaSign 本体 (DdsDecoder.java) と同じ計算 (+128 して切り捨て。Pillow とは 1 ほど違う)
  const expected: Record<BcnFormat, string> = {
    BC1: '42979edd0363d950', BC2: 'da6af7481cb00c2b', BC3: '594a58fba65af95d', BC4: '4378738c573a3443', BC4S: 'd8940cf922e7b033',
    BC5: '838282ad3b0665e4', BC5S: 'd3304eeff549918e', BC6H: '59bddea316ceaf64', BC6HS: '5fd2265a5d7dac63', BC7: '5d9c93220171a6af',
  }
  for (const [i, f] of (Object.keys(expected) as BcnFormat[]).entries()) {
    const r = random(0x9E3779B9 ^ (i * 7919))
    const data = new Uint8Array(bcnByteLength(f, 32, 32)).map(() => r())
    const px = decodeBcnToRgba(f, 32, 32, data)
    assert.equal(px.length, 32 * 32 * 4)
    assert.equal(hash(px), expected[f], f)
  }
})

test('BCn: 決まった色のブロック', () => {
  // BC1: 赤 (0xF800) と青 (0x001F) の 4 色。番号は画素ごとに 0, 1, 2, 3 の繰り返し
  const bc1 = new Uint8Array([0x00, 0xF8, 0x1F, 0x00, 0xE4, 0xE4, 0xE4, 0xE4])
  const p = decodeBcnToRgba('BC1', 4, 4, bc1)
  assert.deepEqual(Array.from(p.subarray(0, 16)), [255, 0, 0, 255, 0, 0, 255, 255, 170, 0, 85, 255, 85, 0, 170, 255])
  // BC1 の 3 色 (c0 <= c1) の番号 3 は透明な黒
  const transparent = decodeBcnToRgba('BC1', 4, 4, new Uint8Array([0x1F, 0x00, 0x00, 0xF8, 0xFF, 0xFF, 0xFF, 0xFF]))
  assert.deepEqual(Array.from(transparent.subarray(0, 4)), [0, 0, 0, 0])
  // BC4 は灰色 (MarumaSign 本体と同じ)
  const bc4 = decodeBcnToRgba('BC4', 4, 4, new Uint8Array([200, 100, 0, 0, 0, 0, 0, 0]))
  assert.deepEqual(Array.from(bc4.subarray(0, 4)), [200, 200, 200, 255])
  // BC5 は R と G に、法線の Z を B に足す (真上を向いた法線)
  const bc5 = decodeBcnToRgba('BC5', 4, 4, new Uint8Array([128, 128, 0, 0, 0, 0, 0, 0, 128, 128, 0, 0, 0, 0, 0, 0]))
  assert.deepEqual(Array.from(bc5.subarray(0, 4)), [128, 128, 255, 255])
  // 符号つきの BC4 は 0 - 255 に寄せる (-128 は -127 と同じ)
  const bc4s = decodeBcnToRgba('BC4S', 4, 4, new Uint8Array([0x7F, 0x81, 0, 0, 0, 0, 0, 0]))
  assert.equal(bc4s[0], 255)
  // BC7 の決まっていないモード (最初の 8 ビットが 0) は透明な黒
  const bc7 = decodeBcnToRgba('BC7', 4, 4, new Uint8Array(16))
  assert.ok(bc7.every(v => v === 0))
  // BC7 モード 6: 両端が黒と白、番号がすべて 15 (最初の画素は 3 ビットで 7) なら白に近い
  const m6 = new Uint8Array(16)
  // モード 6 の目印 (7 ビット目)、R0 R1 G0 G1 B0 B1 A0 A1 を 7 ビットずつ (0 と 127)、P ビットは 1
  const bits: [number, number][] = [[0x40, 7], [0, 7], [127, 7], [0, 7], [127, 7], [0, 7], [127, 7], [127, 7], [127, 7], [1, 1], [1, 1], [7, 3]]
  for (let i = 0; i < 15; i++) bits.push([15, 4])
  let pos = 0
  for (const [v, n] of bits) {
    for (let b = 0; b < n; b++) {
      if ((v >> b) & 1) m6[(pos + b) >> 3]! |= 1 << ((pos + b) & 7)
    }
    pos += n
  }
  assert.equal(pos, 128)
  const white = decodeBcnToRgba('BC7', 4, 4, m6)
  assert.deepEqual(Array.from(white.subarray(4, 8)), [255, 255, 255, 255])
  // BC6H の決まっていないモード (0b10011) は黒 (不透明)
  const bc6 = decodeBcnToRgba('BC6H', 4, 4, new Uint8Array([0b10011, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])) as Uint16Array
  assert.deepEqual(Array.from(bc6.subarray(0, 4)), [0, 0, 0, 0x3C00])
})

test('BCn: 大きさの扱い (4 の倍数でない画像、足りないデータ)', () => {
  // 5x3 の画像は 2x1 のブロック。はみ出した画素は捨てる
  const data = new Uint8Array(bcnByteLength('BC1', 5, 3))
  assert.equal(data.length, 16)
  assert.equal(decodeBcnToRgba('BC1', 5, 3, data).length, 5 * 3 * 4)
  assert.throws(() => decodeBcnToRgba('BC7', 8, 8, new Uint8Array(63)), /truncated/)
  assert.throws(() => decodeBcnToRgba('BC1', 0, 4, new Uint8Array(8)), /bad size/)
})
