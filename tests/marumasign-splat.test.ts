// ガウシアンスプラッティングのファイルの、ブラウザーに頼らない部分の試験 (座標の向き、.spz の拡張、文字の .ply、ばらばらの .sog): npm test
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sniffSplat } from '../app/bluemap/marumasign/core.ts'
import {
  apply3, coordinateFromUrl, coordinateMatrix, COORDINATE_SYSTEMS, crc32, FLIP_YZ, guessSpzUp, looksLikeSogMeta, parseSpzHeader, percentileBox,
  plyToLittleEndian, sogMetaFiles, storedZip,
} from '../app/bluemap/marumasign/splat-file.ts'

const det3 = (m: number[]): number => m[0]! * (m[4]! * m[8]! - m[7]! * m[5]!) - m[3]! * (m[1]! * m[8]! - m[7]! * m[2]!) + m[6]! * (m[1]! * m[5]! - m[4]! * m[2]!)

test('座標の名前から RUB への行列 (nianticlabs/spz の CoordinateSystem と同じ並び)', () => {
  assert.deepEqual(coordinateMatrix('RUB'), [1, 0, 0, 0, 1, 0, 0, 0, 1])
  // .ply の座標 (RDF) は X 軸のまわりの半回転 (MarumaSign 本体の flipYZ と同じ)
  assert.deepEqual(coordinateMatrix('RDF'), [...FLIP_YZ])
  assert.deepEqual(coordinateMatrix('rdf'), [...FLIP_YZ])
  // Z が上の RFU (Blender など): ファイルの +Y (前) は RUB の -Z、+Z (上) は RUB の +Y
  assert.deepEqual(apply3(coordinateMatrix('RFU')!, 0, 1, 0), [0, 0, -1])
  assert.deepEqual(apply3(coordinateMatrix('RFU')!, 0, 0, 1), [0, 1, 0])
  // 左右が逆の座標は鏡像 (行列式 -1)
  assert.equal(det3(coordinateMatrix('LUB')!), -1)
  assert.equal(det3(coordinateMatrix('RDF')!), 1)
  for (const bad of ['', 'RUU', 'XYZ', 'RU', 'RUBB', 'UFR']) assert.equal(coordinateMatrix(bad), null, bad)
  // 16 個すべてが座標になり、値の並びは spz の enum と同じ (RUB = 4、RDF = 6、LUF = 7、RUF = 8、RFU = 12)
  for (let v = 1; v <= 16; v++) assert.ok(coordinateMatrix(COORDINATE_SYSTEMS[v]!), String(v))
  assert.equal(COORDINATE_SYSTEMS[4], 'RUB')
  assert.equal(COORDINATE_SYSTEMS[6], 'RDF')
  assert.equal(COORDINATE_SYSTEMS[7], 'LUF')
  assert.equal(COORDINATE_SYSTEMS[8], 'RUF')
  assert.equal(COORDINATE_SYSTEMS[12], 'RFU')
})

test('看板の URL の #coord=', () => {
  assert.equal(coordinateFromUrl('https://e.com/a.spz#coord=rdf'), 'RDF')
  assert.equal(coordinateFromUrl('https://e.com/a.ply#page=2&coordinates=RFU'), 'RFU')
  assert.equal(coordinateFromUrl('https://e.com/a.spz'), null)
  assert.equal(coordinateFromUrl('https://e.com/a.spz#coord=up'), null)
})

/** .spz バージョン 4 のヘッダー (拡張の記録つき) */
function spzV4(records: [number, number[]][], flags = records.length ? 2 : 0): Uint8Array {
  const ext: number[] = []
  for (const [type, words] of records) {
    const b = new Uint8Array(8 + words.length * 4)
    const dv = new DataView(b.buffer)
    dv.setUint32(0, type, true)
    dv.setUint32(4, words.length * 4, true)
    words.forEach((w, i) => dv.setUint32(8 + i * 4, w, true))
    ext.push(...b)
  }
  const head = new Uint8Array(32 + ext.length + 16 * 5)
  const dv = new DataView(head.buffer)
  dv.setUint32(0, 0x5053474E, true)
  dv.setUint32(4, 4, true)
  dv.setUint32(8, 10, true)
  head[12] = 3
  head[13] = 12
  head[14] = flags
  head[15] = 5
  dv.setUint32(16, 32 + ext.length, true)
  head.set(ext, 32)
  return head
}

test('.spz の拡張 SPZ_ADOBE_coordinate_system (0xADBE0003) を読む', () => {
  assert.equal(parseSpzHeader(spzV4([]))!.coordinate, null)
  assert.equal(parseSpzHeader(spzV4([[0xADBE0003, [6]]]))!.coordinate, 'RDF')
  // 知らない拡張は長さで飛ばす
  assert.equal(parseSpzHeader(spzV4([[0xADBE0002, [1, 2, 3]], [0xADBE0003, [12]]]))!.coordinate, 'RFU')
  // 0 (UNSPECIFIED) と範囲外は無いのと同じ
  assert.equal(parseSpzHeader(spzV4([[0xADBE0003, [0]]]))!.coordinate, null)
  assert.equal(parseSpzHeader(spzV4([[0xADBE0003, [17]]]))!.coordinate, null)
  // flags に 0x2 がなければ拡張は読まない
  assert.equal(parseSpzHeader(spzV4([[0xADBE0003, [6]]], 0))!.coordinate, null)
  // 長さが目次を越える記録は捨てる
  const broken = spzV4([[0xADBE0003, [6]]])
  new DataView(broken.buffer).setUint32(36, 4000, true)
  assert.equal(parseSpzHeader(broken)!.coordinate, null)
  const h = parseSpzHeader(spzV4([]))!
  assert.equal(h.version, 4)
  assert.equal(h.numPoints, 10)
  assert.equal(h.shDegree, 3)
  // gzip のもの (v1-3) は展開した先頭 16 バイトで
  const v2 = new Uint8Array(16)
  new DataView(v2.buffer).setUint32(0, 0x5053474E, true)
  v2[4] = 2
  assert.equal(parseSpzHeader(v2)!.version, 2)
  assert.equal(parseSpzHeader(new Uint8Array(16)), null)
})

/** 試験用の場面: 物 (球) と、その下の平たい床。RUB (+Y が上) */
function sceneWithFloor(): { pos: Float32Array, scl: Float32Array, quat: Float32Array, op: Float32Array } {
  const pos: number[] = [], scl: number[] = [], quat: number[] = [], op: number[] = []
  for (let i = 0; i < 200; i++) {
    const a = i * 2.4, y = 1 - 2 * (i + 0.5) / 200, r = Math.sqrt(1 - y * y)
    pos.push(0.5 * r * Math.cos(a), 0.8 + 0.5 * y, 0.5 * r * Math.sin(a))
    scl.push(0.05, 0.05, 0.05)
    quat.push(0, 0, 0, 1)
    op.push(0.9)
  }
  for (let i = 0; i < 300; i++) {
    const a = i * 2.4, r = 1.2 * Math.sqrt((i + 0.5) / 300)
    pos.push(r * Math.cos(a), 0, r * Math.sin(a))
    // 平たい分布 (Y の向きが薄い)。回転は X 軸まわりに少し傾ける
    scl.push(0.1, 0.004, 0.1)
    const t = 0.1
    quat.push(Math.sin(t / 2), 0, 0, Math.cos(t / 2))
    op.push(0.9)
  }
  return { pos: new Float32Array(pos), scl: new Float32Array(scl), quat: new Float32Array(quat), op: new Float32Array(op) }
}

test('宣言のない .spz の上の向きの推定', () => {
  const s = sceneWithFloor()
  assert.equal(guessSpzUp(s.pos, s.scl, s.quat, s.op), 'RUB')
  // 半回転した (+Y が下の) もの: 位置の y と z の符号を変え、回転にも X 軸の半回転を掛ける
  const pos = s.pos.slice(), quat = s.quat.slice()
  for (let i = 0; i < s.op.length; i++) {
    pos[i * 3 + 1] = -pos[i * 3 + 1]!
    pos[i * 3 + 2] = -pos[i * 3 + 2]!
    const x = quat[i * 4]!, y = quat[i * 4 + 1]!, z = quat[i * 4 + 2]!, w = quat[i * 4 + 3]!
    quat.set([w, -z, y, -x], i * 4)
  }
  assert.equal(guessSpzUp(pos, s.scl, quat, s.op), 'RDF')
  // 床がなければ (丸い分布だけ) 分からない
  const n = 200
  assert.equal(guessSpzUp(s.pos.slice(0, n * 3), s.scl.slice(0, n * 3), s.quat.slice(0, n * 4), s.op.slice(0, n)), null)
  // 床の分布が透明に近ければ数えない
  const faint = s.op.slice().fill(0.1, 200)
  assert.equal(guessSpzUp(s.pos, s.scl, s.quat, faint), null)
})

test('外れ値を除いた範囲 (MarumaSign 本体の computePercentileBounds と同じ添字)', () => {
  const n = 201
  const pos = new Float32Array(n * 3)
  for (let i = 0; i < n; i++) pos.set([i, -i, 2 * i], i * 3)
  // lo = floor(200 * 0.01) = 2、hi = ceil(200 * 0.99) = 198
  assert.deepEqual(percentileBox(pos, n), [2, -198, 4, 198, -2, 396])
  assert.deepEqual(percentileBox(new Float32Array(0), 0), [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5])
})

test('文字とビッグエンディアンの .ply をリトルエンディアンに書き直す', () => {
  const header = (format: string): string => `ply\nformat ${format} 1.0\ncomment test\nelement vertex 2\nproperty float x\nproperty uchar r\nproperty double d\nend_header\n`
  const ascii = new TextEncoder().encode(header('ascii') + '1.5 200 -2.25\n-3 7 1e-3\n')
  const le = plyToLittleEndian(ascii)!
  const text = new TextDecoder('latin1').decode(le)
  assert.match(text, /format binary_little_endian 1\.0\ncomment test\n/)
  const at = text.indexOf('end_header\n') + 11
  const dv = new DataView(le.buffer, le.byteOffset + at)
  assert.equal(le.length - at, 2 * 13)
  assert.equal(dv.getFloat32(0, true), 1.5)
  assert.equal(dv.getUint8(4), 200)
  assert.equal(dv.getFloat64(5, true), -2.25)
  assert.equal(dv.getFloat32(13, true), -3)
  assert.equal(dv.getFloat64(18, true), 1e-3)
  // ビッグエンディアン
  const hb = new TextEncoder().encode(header('binary_big_endian'))
  const be = new Uint8Array(hb.length + 26)
  be.set(hb)
  const bv = new DataView(be.buffer, hb.length)
  bv.setFloat32(0, 1.5, false); bv.setUint8(4, 200); bv.setFloat64(5, -2.25, false)
  bv.setFloat32(13, -3, false); bv.setUint8(17, 7); bv.setFloat64(18, 1e-3, false)
  const out = plyToLittleEndian(be)!
  assert.deepEqual(Array.from(out.subarray(out.length - 26)), Array.from(le.subarray(le.length - 26)))
  // もともとリトルエンディアンなら書き直さない
  assert.equal(plyToLittleEndian(new TextEncoder().encode(header('binary_little_endian'))), null)
  // リストの項目は読まない (本体と同じ)
  assert.throws(() => plyToLittleEndian(new TextEncoder().encode('ply\nformat ascii 1.0\nelement face 1\nproperty list uchar int idx\nend_header\n3 0 1 2\n')))
  assert.throws(() => plyToLittleEndian(new TextEncoder().encode(header('ascii') + '1 2\n')), /truncated/)
})

test('ばらばらの .sog の meta.json', () => {
  const v2 = JSON.stringify({ version: 2, count: 3, means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ['means_l.webp', 'means_u.webp'] }, scales: { codebook: [], files: ['scales.webp'] }, quats: { files: ['quats.webp'] }, sh0: { codebook: [], files: ['sh0.webp'] }, shN: { count: 1, bands: 3, codebook: [], files: ['shN_centroids.webp', 'shN_labels.webp'] } })
  assert.deepEqual(sogMetaFiles(v2), ['means_l.webp', 'means_u.webp', 'scales.webp', 'quats.webp', 'sh0.webp', 'shN_centroids.webp', 'shN_labels.webp'])
  const v1 = JSON.stringify({ means: { shape: [3, 3], mins: [0, 0, 0], maxs: [1, 1, 1], files: ['a.webp', 'b.webp'] }, scales: { shape: [3, 3], mins: [0, 0, 0], maxs: [1, 1, 1], files: ['c.webp'] }, quats: { shape: [3, 4], files: ['d.webp'] }, sh0: { shape: [3, 1, 4], mins: [0, 0, 0, 0], maxs: [1, 1, 1, 1], files: ['e.webp'] } })
  assert.deepEqual(sogMetaFiles(v1), ['a.webp', 'b.webp', 'c.webp', 'd.webp', 'e.webp'])
  assert.equal(sogMetaFiles('{"version":3,"means":{}}'), null)
  assert.equal(sogMetaFiles('{"means":{"files":["a"]}}'), null, '足りない')
  assert.equal(sogMetaFiles('not json'), null)
  assert.equal(sogMetaFiles(v2.replace('"quats.webp"', '1')), null)
  assert.ok(looksLikeSogMeta(v2))
  assert.ok(looksLikeSogMeta('﻿' + v1))
  assert.ok(!looksLikeSogMeta('{"asset":{"version":"2.0"}}'))
  // 中身で種類を決める (glTF の JSON より先に)
  const head = new TextEncoder().encode(v2)
  assert.equal(sniffSplat(head, 'json'), 'sog-meta')
  assert.equal(sniffSplat(new TextEncoder().encode('{"asset":{"version":"2.0"},"meshes":[]}'), 'gltf'), null)
})

test('圧縮しない zip (Spark に .sog として渡す)', () => {
  const a = new TextEncoder().encode('{"x":1}'), b = new Uint8Array([1, 2, 3, 4, 5])
  const zip = storedZip([{ name: 'meta.json', data: a }, { name: 'file0.webp', data: b }])
  const dv = new DataView(zip.buffer)
  const eocd = zip.length - 22
  assert.equal(dv.getUint32(eocd, true), 0x06054B50)
  assert.equal(dv.getUint16(eocd + 10, true), 2)
  // 中央ディレクトリから 2 つめを引く
  let p = dv.getUint32(eocd + 16, true)
  p += 46 + dv.getUint16(p + 28, true)
  assert.equal(dv.getUint32(p, true), 0x02014B50)
  const local = dv.getUint32(p + 42, true)
  const start = local + 30 + dv.getUint16(local + 26, true)
  assert.deepEqual(Array.from(zip.subarray(start, start + 5)), [1, 2, 3, 4, 5])
  assert.equal(dv.getUint32(p + 16, true), crc32(b))
  // 既知の CRC-32
  assert.equal(crc32(new TextEncoder().encode('123456789')), 0xCBF43926)
  assert.equal(sniffSplat(zip, ''), 'sog')
})
