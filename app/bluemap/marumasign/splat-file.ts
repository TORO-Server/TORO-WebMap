// ガウシアンスプラッティングのファイルの、ブラウザーに頼らない部分 (座標の向き、.spz の拡張、ばらばらの .sog、zip)。npm test で確かめる
//
// 座標の向き: 看板に置くときは「+X が右、+Y が上、+Z が手前 (正面)」の座標 (RUB。three.js、MarumaSign 本体の SplatCloud と同じ) にそろえる。
//  - .ply .splat .ksplat .sog は 3DGS の撮影の座標 (RDF: +Y が下、+Z が奥) として、X 軸のまわりに半回転させる (MarumaSign 本体と同じ)
//  - .spz は仕様 (nianticlabs/spz) では RUB で入れる。ただし仕様には「座標を書く欄」がなく、変換せずに書く道具
//    (splat-transform 3.x、Spark の writeSpz、from を指定しない spz のライブラリ) は .ply の座標 (RDF) のまま書くので、世の中の .spz は半々。
//    そこで (1) バージョン 4 の拡張 SPZ_ADOBE_coordinate_system (0xADBE0003) があれば、それに従う
//    (2) なければ中身から上を推定する (床や机などの水平な面がどちらの端にあるか。guessSpzUp)
//    (3) それでも分からなければ仕様どおり RUB とする
//  - URL の「#coord=RDF」のように、座標を看板の URL で指定することもできる (どの形式でも。推定より優先)

/** SPZ の CoordinateSystem (nianticlabs/spz の splat-types.h) の値の名前。1 文字目が +X、2 文字目が +Y、3 文字目が +Z の向き */
export const COORDINATE_SYSTEMS = [
  '', 'LDB', 'RDB', 'LUB', 'RUB', 'LDF', 'RDF', 'LUF', 'RUF',
  'LFD', 'RFD', 'LFU', 'RFU', 'LBD', 'RBD', 'LBU', 'RBU',
] as const

const AXIS: Record<string, [number, number, number]> = {
  R: [1, 0, 0], L: [-1, 0, 0], U: [0, 1, 0], D: [0, -1, 0], B: [0, 0, 1], F: [0, 0, -1],
}

/**
 * 座標の名前 (RUB、RDF、RFU など 3 文字) から、その座標の点を RUB に移す 3x3 の行列 (列優先、9 個)。正しくない名前なら null。
 * 列 i はファイルの i 番目の軸が RUB でどちらを向くか。左右が逆の座標 (L で始まる RUB 系など) では行列式が -1 (鏡像) になる
 */
export function coordinateMatrix(name: string): number[] | null {
  if (!/^[RL][UDFB][UDFB]$/i.test(name)) return null
  const up = name.toUpperCase()
  const cols = [AXIS[up[0]!]!, AXIS[up[1]!]!, AXIS[up[2]!]!]
  // 2 つめと 3 つめが同じ軸 (UD、FB) なら座標にならない
  if (Math.abs(cols[1]![0] * cols[2]![0] + cols[1]![1] * cols[2]![1] + cols[1]![2] * cols[2]![2]) > 0) return null
  return [...cols[0]!, ...cols[1]!, ...cols[2]!]
}

/** 名前を正規の形 (大文字) に。正しくなければ null */
export function normalizeCoordinate(name: string): string | null {
  return coordinateMatrix(name) ? name.toUpperCase() : null
}

/** 看板の URL の「#coord=XYZ」(ほかの指定と & で並べてもよい)。なければ null */
export function coordinateFromUrl(url: string): string | null {
  const hash = url.indexOf('#')
  if (hash < 0) return null
  for (const part of url.substring(hash + 1).split('&')) {
    const eq = part.indexOf('=')
    if (eq < 0) continue
    const key = part.substring(0, eq).trim().toLowerCase()
    if (key !== 'coord' && key !== 'coordinates') continue
    return normalizeCoordinate(decodeURIComponent(part.substring(eq + 1).trim()))
  }
  return null
}

const NGSP = 0x5053474E
/** SPZ_ADOBE_coordinate_system の拡張の種類 */
export const SPZ_EXT_COORDINATE_SYSTEM = 0xADBE0003
/** 拡張の記録を読む上限 (知らない拡張は長さで飛ばす) */
const MAX_SPZ_EXTENSIONS = 64

export interface SpzHeader {
  version: number
  numPoints: number
  shDegree: number
  /** ヘッダーの flags (0x1 = antialiased、0x2 = 拡張あり、0x80 = Spark の LoD) */
  flags: number
  /** バージョン 4 の拡張で宣言された座標の名前 (なければ null) */
  coordinate: string | null
}

function u32(b: Uint8Array, p: number): number {
  return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
}

/**
 * .spz のヘッダー (バージョン 4 は平文。バージョン 1 - 3 は gzip を展開した先頭 16 バイトを渡す)。.spz でなければ null。
 * バージョン 4 で拡張があれば、32 バイト目から目次 (TOC) の手前までの記録 [u32 種類][u32 長さ][中身] を読む
 */
export function parseSpzHeader(b: Uint8Array): SpzHeader | null {
  if (b.length < 16 || u32(b, 0) !== NGSP) return null
  const version = u32(b, 4)
  const numPoints = u32(b, 8)
  const shDegree = b[12]!
  const flags = b[14]!
  if (version < 1 || version > 4 || shDegree > 4) return null
  let coordinate: string | null = null
  if (version === 4 && b.length >= 32 && (flags & 2)) {
    const toc = Math.min(u32(b, 16), b.length)
    let p = 32
    for (let n = 0; n < MAX_SPZ_EXTENSIONS && p + 8 <= toc; n++) {
      const type = u32(b, p), length = u32(b, p + 4)
      const start = p + 8
      if (length > toc - start) break
      if (type === SPZ_EXT_COORDINATE_SYSTEM && length >= 4) {
        const value = u32(b, start)
        // 0 (UNSPECIFIED) は書いていないのと同じ
        if (value >= 1 && value <= 16) coordinate = COORDINATE_SYSTEMS[value]!
      }
      p = start + length
    }
  }
  return { version, numPoints, shDegree, flags, coordinate }
}

/** 半回転 (RDF と RUB の入れ替え。X 軸のまわりに 180 度) */
export const FLIP_YZ: readonly number[] = [1, 0, 0, 0, -1, 0, 0, 0, -1]
export const IDENTITY3: readonly number[] = [1, 0, 0, 0, 1, 0, 0, 0, 1]

/** 3x3 (列優先) で点を移す */
export function apply3(m: readonly number[], x: number, y: number, z: number): [number, number, number] {
  return [m[0]! * x + m[3]! * y + m[6]! * z, m[1]! * x + m[4]! * y + m[7]! * z, m[2]! * x + m[5]! * y + m[8]! * z]
}

/**
 * 中身から上の向きを推定する (宣言のない .spz 用)。+Y が上なら 'RUB'、+Y が下なら 'RDF'、分からなければ null。
 * 撮影したものの多くは、床・机・皿のような水平な面の上にある。平たい分布 (いちばん短い軸が残りより十分に短い) のうち、
 * 面の向きが Y 軸に近いものの面積が、Y の範囲の下の端と上の端のどちらに多いかで決める。差が小さいときは、中央より上か下かでも見る。
 * 実物の .spz (Spark の作例 10 個。どれも RDF) で 8 個が正しく、1 個 (床のない蝶) は分からず、1 個 (上に明かりが多い夜の通り) は外れた。
 * 上下を逆にしても同じ数え方なので、RUB のファイルでも同じだけ当たる。中身に手がかりのないもの (棒だけの試験の場面など) は分からない
 * @param positions 選んだ分布の位置 (ファイルの座標。x, y, z の並び)
 * @param scales 大きさ (x, y, z の並び)
 * @param quats 回転 (x, y, z, w の並び)
 * @param opacity 不透明度 (0 - 1)
 */
export function guessSpzUp(positions: Float32Array, scales: Float32Array, quats: Float32Array, opacity: Float32Array): 'RUB' | 'RDF' | null {
  const n = opacity.length
  if (n < 16) return null
  const ys = new Float32Array(n)
  for (let i = 0; i < n; i++) ys[i] = positions[i * 3 + 1]!
  const sorted = ys.slice().sort()
  const lo = sorted[Math.floor(n * 0.02)]!, hi = sorted[Math.floor(n * 0.98)]!
  const med = sorted[n >> 1]!
  const spread = Math.max(1e-9, (sorted[Math.floor(n * 0.75)]! - sorted[Math.floor(n * 0.25)]!) / 2)
  const band = (hi - lo) * 0.15
  if (!(band > 0)) return null
  let total = 0, horizontal = 0, low = 0, high = 0, side = 0
  for (let i = 0; i < n; i++) {
    const sx = Math.abs(scales[i * 3]!), sy = Math.abs(scales[i * 3 + 1]!), sz = Math.abs(scales[i * 3 + 2]!)
    // いちばん短い軸と、残りの 2 つ
    let a = 0, s0 = sx, s1 = sy, s2 = sz
    if (sy < s0) { a = 1; s0 = sy; s1 = sx; s2 = sz }
    if (sz < s0) { a = 2; s0 = sz; s1 = sx; s2 = sy }
    const mid = Math.min(s1, s2), big = Math.max(s1, s2)
    const w = opacity[i]! * mid * big
    if (!(w > 0)) continue
    total += w
    if (s0 > 0.35 * mid || opacity[i]! < 0.3) continue
    // 短い軸 (面の向き) の Y 成分: 回転行列の a 列目の y
    const len = Math.hypot(quats[i * 4]!, quats[i * 4 + 1]!, quats[i * 4 + 2]!, quats[i * 4 + 3]!)
    if (!(len > 0)) continue
    const x = quats[i * 4]! / len, y = quats[i * 4 + 1]! / len, z = quats[i * 4 + 2]! / len, qw = quats[i * 4 + 3]! / len
    const ny = a === 0 ? 2 * (x * y + qw * z) : a === 1 ? 1 - 2 * (x * x + z * z) : 2 * (y * z - qw * x)
    if (Math.abs(ny) < 0.85) continue
    horizontal += w
    const yy = ys[i]!
    if (yy <= lo + band) low += w
    if (yy >= hi - band) high += w
    side += w * Math.max(-2, Math.min(2, (yy - med) / spread))
  }
  if (!(total > 0) || horizontal < 0.02 * total) return null
  // 端の比べ方 (+ なら上の端に水平な面が多い = ファイルの +Y は下)
  if (low + high >= 0.01 * total) {
    const extreme = (high - low) / (high + low)
    if (Math.abs(extreme) >= 0.25) return extreme > 0 ? 'RDF' : 'RUB'
  }
  const center = side / horizontal
  if (Math.abs(center) >= 0.5) return center > 0 ? 'RDF' : 'RUB'
  return null
}

/**
 * 外れ値を除いたモデルの範囲 (各軸の 1 - 99 パーセンタイル。MarumaSign 本体の SplatScene.computePercentileBounds と同じ)
 * @param positions 置く座標 (RUB) の位置 (x, y, z の並び)
 */
export function percentileBox(positions: Float32Array, count: number): number[] {
  if (count <= 0) return [-0.5, -0.5, -0.5, 0.5, 0.5, 0.5]
  const lo = Math.floor((count - 1) * 0.01), hi = Math.ceil((count - 1) * 0.99)
  const box = new Array<number>(6)
  const v = new Float32Array(count)
  for (let axis = 0; axis < 3; axis++) {
    for (let i = 0; i < count; i++) v[i] = positions[i * 3 + axis]!
    v.sort()
    box[axis] = v[lo]!
    box[axis + 3] = v[hi]!
  }
  return box
}

// ---------------------------------------------------------------- 文字 (ascii) とビッグエンディアンの .ply

const PLY_TYPES: Record<string, [number, string]> = {
  char: [1, 'Int8'], int8: [1, 'Int8'], uchar: [1, 'Uint8'], uint8: [1, 'Uint8'],
  short: [2, 'Int16'], int16: [2, 'Int16'], ushort: [2, 'Uint16'], uint16: [2, 'Uint16'],
  int: [4, 'Int32'], int32: [4, 'Int32'], uint: [4, 'Uint32'], uint32: [4, 'Uint32'],
  float: [4, 'Float32'], float32: [4, 'Float32'], double: [8, 'Float64'], float64: [8, 'Float64'],
}
/** .ply の要素の数の上限 (MarumaSign 本体と同じ) */
const MAX_PLY_ELEMENTS = 50_000_000

/**
 * 文字 (ascii) かビッグエンディアンの .ply を、Spark が読むリトルエンディアンに書き直す (MarumaSign 本体は 3 つとも読む)。
 * もともとリトルエンディアンなら null。読めない形 (リストの項目など。本体も読まない) なら例外
 */
export function plyToLittleEndian(b: Uint8Array): Uint8Array | null {
  const limit = Math.min(b.length, 65536)
  let text = ''
  for (let i = 0; i < limit; i++) text += String.fromCharCode(b[i]!)
  const m = /^ply\r?\n/.exec(text)
  const endMatch = /(^|\n)end_header\r?\n/.exec(text)
  if (!m || !endMatch) throw new Error('bad ply header')
  const dataStart = endMatch.index + endMatch[0].length
  const lines = text.substring(m[0].length, endMatch.index + endMatch[1]!.length).split(/\r?\n/)
  let format = ''
  const out: string[] = ['ply']
  const elements: { count: number, props: [number, string][] }[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    const t = line.split(/\s+/)
    if (t[0] === 'format') {
      format = t[1] ?? ''
      out.push('format binary_little_endian 1.0')
      continue
    }
    if (t[0] === 'element') {
      const count = Number(t[2])
      if (!Number.isInteger(count) || count < 0 || count > MAX_PLY_ELEMENTS) throw new Error('bad ply element')
      elements.push({ count, props: [] })
    }
    else if (t[0] === 'property') {
      const type = PLY_TYPES[t[1] ?? '']
      if (!type || t.length !== 3 || elements.length === 0) throw new Error('unsupported ply property')
      elements[elements.length - 1]!.props.push(type)
    }
    else if (t[0] !== 'comment' && t[0] !== 'obj_info') throw new Error('bad ply header')
    out.push(line)
  }
  out.push('end_header')
  if (format === 'binary_little_endian') return null
  if (format !== 'binary_big_endian' && format !== 'ascii') throw new Error('bad ply format')
  let size = 0
  for (const e of elements) for (const p of e.props) size += p[0] * e.count
  const header = new TextEncoder().encode(out.join('\n') + '\n')
  const result = new Uint8Array(header.length + size)
  result.set(header)
  const dv = new DataView(result.buffer)
  let at = header.length
  if (format === 'binary_big_endian') {
    if (dataStart + size > b.length) throw new Error('truncated ply')
    let from = dataStart
    for (const e of elements) {
      for (let r = 0; r < e.count; r++) {
        for (const [bytes] of e.props) {
          for (let k = 0; k < bytes; k++) result[at + k] = b[from + bytes - 1 - k]!
          at += bytes
          from += bytes
        }
      }
    }
    return result
  }
  // 文字: 空白で区切った数を、項目の型で書く
  let p = dataStart
  const next = (): number => {
    while (p < b.length && b[p]! <= 0x20) p++
    const start = p
    while (p < b.length && b[p]! > 0x20) p++
    if (start === p) throw new Error('truncated ply')
    let s = ''
    for (let i = start; i < p; i++) s += String.fromCharCode(b[i]!)
    const v = Number(s)
    if (Number.isNaN(v) && !/^[-+]?nan$/i.test(s)) throw new Error('bad ply number')
    return v
  }
  for (const e of elements) {
    for (let r = 0; r < e.count; r++) {
      for (const [bytes, type] of e.props) {
        const v = next()
        switch (type) {
          case 'Float32': dv.setFloat32(at, v, true); break
          case 'Float64': dv.setFloat64(at, v, true); break
          case 'Int8': dv.setInt8(at, v); break
          case 'Uint8': dv.setUint8(at, v); break
          case 'Int16': dv.setInt16(at, v, true); break
          case 'Uint16': dv.setUint16(at, v, true); break
          case 'Int32': dv.setInt32(at, v, true); break
          default: dv.setUint32(at, v, true)
        }
        at += bytes
      }
    }
  }
  return result
}

// ---------------------------------------------------------------- ばらばらの .sog (meta.json と WebP)

/** meta.json の大きさの上限 (Spark が zip の中で読む上限と同じ) */
export const MAX_SOG_META_BYTES = 65536
/** meta.json が参照するファイルの数の上限 (v2 で 7 個) */
export const MAX_SOG_FILES = 16

/**
 * PlayCanvas の SOG の meta.json (v1 か v2) なら、参照するファイルの名前 (重複なし)。違えば null。
 * 名前は meta.json からの相対の位置 (URL として解決するのは呼ぶ側)
 */
export function sogMetaFiles(text: string): string[] | null {
  if (text.length > MAX_SOG_META_BYTES) return null
  let json: unknown
  try {
    json = JSON.parse(text)
  }
  catch {
    return null
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const meta = json as Record<string, unknown>
  const v2 = meta.version === 2
  if (meta.version !== undefined && !v2) return null
  const names: string[] = []
  for (const key of ['means', 'scales', 'quats', 'sh0', 'shN']) {
    const part = meta[key]
    if (part === undefined && key === 'shN') continue
    if (!part || typeof part !== 'object' || Array.isArray(part)) return null
    const files = (part as Record<string, unknown>).files
    if (!Array.isArray(files) || files.length === 0) return null
    for (const f of files) {
      if (typeof f !== 'string' || f.length === 0 || f.length > 256) return null
      if (!names.includes(f)) names.push(f)
    }
  }
  if (names.length > MAX_SOG_FILES) return null
  return names
}

/** 先頭のバイト列が SOG の meta.json らしいか (中身で種類を決めるとき。全部は読んでいないので、means の files まで) */
export function looksLikeSogMeta(text: string): boolean {
  return /^(﻿|ï»¿)?\s*\{/.test(text) && /"means"\s*:\s*\{[^{}]*"files"\s*:\s*\[/.test(text)
}

let crcTable: Uint32Array | null = null
export function crc32(b: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256)
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c >>> 0
    }
  }
  let c = 0xFFFFFFFF
  for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]!) & 255]! ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

/** 圧縮しない zip (Spark に .sog として渡すため) */
export function storedZip(entries: { name: string, data: Uint8Array }[]): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const e of entries) {
    const name = enc.encode(e.name)
    const crc = crc32(e.data)
    const local = new Uint8Array(30)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034B50, true)
    lv.setUint16(4, 20, true)
    lv.setUint32(14, crc, true)
    lv.setUint32(18, e.data.length, true)
    lv.setUint32(22, e.data.length, true)
    lv.setUint16(26, name.length, true)
    const head = new Uint8Array(46)
    const cv = new DataView(head.buffer)
    cv.setUint32(0, 0x02014B50, true)
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, e.data.length, true)
    cv.setUint32(24, e.data.length, true)
    cv.setUint16(28, name.length, true)
    cv.setUint32(42, offset, true)
    parts.push(local, name, e.data)
    central.push(head, name)
    offset += 30 + name.length + e.data.length
  }
  let cdSize = 0
  for (const c of central) cdSize += c.length
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054B50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, cdSize, true)
  ev.setUint32(16, offset, true)
  const all = [...parts, ...central, end]
  let total = 0
  for (const p of all) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of all) {
    out.set(p, at)
    at += p.length
  }
  return out
}
