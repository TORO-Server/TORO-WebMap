/*
 * MarumaSign の看板の、ブラウザーに頼らない計算 (Node の node --test でも確かめる。tests/marumasign.test.ts)。
 * MarumaSign Companion の marumasign3d.js の前半をそのまま TypeScript にしたものと、種類の判別など。
 * ここでは xml-head.ts のほかは何も import しない (Node の型の取り除きだけで動かすため)。
 *
 * 位置・大きさ・回転の計算は、MarumaSign 本体 (SignImage.java) と同じ。
 */
import { startsAfterXmlHead } from './xml-head.ts'

export const MAX_URL_LENGTH = 2000
export const SAFE_PORTS = new Set(['', '80', '443', '8080', '8443'])
// 前のスクリプトと同じ、そのまま画像として読む種類 (Content-Type)
export const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp', 'image/avif'])
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024
export const MAX_IMAGE_PIXELS = 100 * 1000 * 1000
// PDF の大きさの上限 (MarumaSign 本体の PdfFile.MAX_SIZE と同じ)
export const MAX_PDF_BYTES = 64 * 1024 * 1024
// 画像の一辺の上限 (MarumaSign 本体と同じ。アニメーションは 2048 で 512 コマまで)
export const MAX_STATIC_SIZE = 4096
export const MAX_ANIMATION_SIZE = 2048
export const MAX_ANIMATION_FRAMES = 512
// 音が聞こえる距離の上限 (ブロック。MarumaSign 本体の MediaSession と同じ)
export const HEARING_DISTANCE = 32
const FACE_OFFSET = 0.005
const WALL_OFFSET = 0.4375 * 2
const ORDER = [0, 1, 2, 3, 3, 2, 1, 0]
const U = [1, 1, 0, 0]
const V = [1, 0, 0, 1]

/** 看板の大きさと位置のずれの上限 (データファイルの maxSize, maxOffset) */
export interface SignLimits {
  maxSize: number
  maxOffset: number
}

/** 位置・大きさ・回転 (MarumaSign の看板の数値) */
export interface SignShape {
  ox: number
  oy: number
  oz: number
  sx: number
  sy: number
  roll: number
  yaw: number
  pitch: number
  orient: number
}

/** データファイルの 1 件を確かめたもの */
export interface ParsedSign extends SignShape {
  x: number
  y: number
  z: number
  kind: number
  /** プラグインが画像として読んでよいとした URL (https)。なければ null */
  image: string | null
  /** 看板に書かれた URL (http か https) */
  link: string
}

export function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v))
}

/**
 * http(s) の URL として使ってよければ正規化した文字列、だめなら null。
 * @param httpsOnly true なら https のみ
 */
export function safeUrl(value: unknown, httpsOnly: boolean): string | null {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_URL_LENGTH) return null
  for (let i = 0; i < value.length; i++) {
    const c = value.charCodeAt(i)
    if (c <= 0x20 || c === 0x7F || c === 0x22 || c === 0x27 || c === 0x3C || c === 0x3E || c === 0x5C || c === 0x60) return null
  }
  let u: URL
  try {
    u = new URL(value)
  }
  catch {
    return null
  }
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && !httpsOnly)) return null
  if (u.username || u.password) return null
  if (!SAFE_PORTS.has(u.port)) return null
  const host = u.hostname.toLowerCase()
  if (!host || host.indexOf('.') < 0) return null
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')
    || host.endsWith('.lan') || host.endsWith('.home.arpa')) return null
  // IP アドレスそのもののホストは使わない (サーバー側でも除いているが、念のため)
  if (/^[0-9.]+$/.test(host) || host.indexOf(':') >= 0 || host.startsWith('[')) return null
  return u.href
}

/** 表示用に短くしたホスト名 (punycode のまま) */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname
  }
  catch {
    return ''
  }
}

export function shorten(url: string, max: number): string {
  let s = String(url)
  const i = s.indexOf('://')
  if (i >= 0) s = s.substring(i + 3)
  if (s.length <= max) return s
  const head = Math.floor(max * 2 / 3)
  const tail = max - head - 1
  return s.substring(0, head) + '…' + s.substring(s.length - tail)
}

/**
 * 看板データの 1 件を確かめて内部の形にする。だめなら null。
 * 配列: [x, y, z, 向き, 種類, 画像の URL, リンクの URL, 数値 8 つ]
 */
export function parseSign(raw: unknown, kindCount: number, limits: SignLimits): ParsedSign | null {
  if (!Array.isArray(raw) || raw.length < 15) return null
  for (let i = 0; i < 5; i++) if (!Number.isInteger(raw[i])) return null
  if (typeof raw[5] !== 'string' || typeof raw[6] !== 'string') return null
  const v: number[] = []
  for (let i = 7; i < 15; i++) {
    if (!isFiniteNumber(raw[i])) return null
    v.push(clamp(raw[i], -1000, 1000))
  }
  const orient = raw[3] as number
  const kind = raw[4] as number
  if (orient < -1 || orient > 19) return null
  if (kind < 0 || kind >= kindCount) return null
  const link = safeUrl(raw[6], false)
  if (!link) return null
  const image = raw[5] === '' || orient < 0 ? null : safeUrl(raw[5], true)
  return {
    x: raw[0], y: raw[1], z: raw[2],
    orient, kind, image, link,
    // 位置のずれ、横幅、高さ、Z/Y/X 回転。大きさとずれには上限をかける
    ox: clamp(v[0]!, -limits.maxOffset, limits.maxOffset),
    oy: clamp(v[1]!, -limits.maxOffset, limits.maxOffset),
    oz: clamp(v[2]!, -limits.maxOffset, limits.maxOffset),
    sx: clamp(v[3]!, -limits.maxSize, limits.maxSize),
    sy: clamp(v[4]!, -limits.maxSize, limits.maxSize),
    roll: v[5]!, yaw: v[6]!, pitch: v[7]!,
  }
}

export function isWall(orient: number): boolean {
  return orient >= 16
}

export function signYaw(orient: number): number {
  return orient >= 16 ? (orient - 16) * 90 : orient * 22.5
}

/** MarumaSign 本体の SignImage.rotate() */
export function rotatePoint(sign: SignShape, x: number, y: number, z: number): [number, number, number] {
  let a = sign.pitch * Math.PI / 180
  let sin = Math.sin(a), cos = Math.cos(a)
  let ty = y * cos - z * sin
  let tz = y * sin + z * cos
  y = ty
  z = tz

  a = -sign.yaw * Math.PI / 180
  sin = Math.sin(a)
  cos = Math.cos(a)
  let tx = x * cos + z * sin
  tz = -x * sin + z * cos
  x = tx
  z = tz

  a = -sign.roll * Math.PI / 180
  sin = Math.sin(a)
  cos = Math.cos(a)
  tx = x * cos - y * sin
  ty = x * sin + y * cos
  x = tx
  y = ty

  return [x + sign.ox * 2, y + sign.oy * 2, z + sign.oz * 2]
}

/** 看板の板の頂点 (表 4 頂点、裏 4 頂点) と UV */
export interface BoardMesh {
  positions: Float32Array
  uvs: Float32Array
}

/**
 * 看板の画像の頂点 (MarumaSign 本体の SignImage.buildMesh() と同じ。表 4 頂点、裏 4 頂点)。
 * ブロックの角を原点とした座標と UV を返す。
 * @param imgW 画像の横の大きさ (縦横比だけ使う)
 * @param imgH 画像の縦の大きさ
 */
export function buildMesh(sign: SignShape, imgW: number, imgH: number): BoardMesh {
  let max = Math.max(imgW, imgH)
  if (!(max > 0)) max = 1
  const vx = imgW / max * sign.sx
  const vy = imgH / max * sign.sy
  const base = [
    rotatePoint(sign, -vx, -vy, 0),
    rotatePoint(sign, -vx, +vy, 0),
    rotatePoint(sign, +vx, +vy, 0),
    rotatePoint(sign, +vx, -vy, 0),
  ]
  const wall = isWall(sign.orient)
  const moveZ = wall ? WALL_OFFSET : 0
  const angle = (-signYaw(sign.orient) - 180) * Math.PI / 180
  const sin = Math.sin(angle), cos = Math.cos(angle)
  const positions = new Float32Array(8 * 3)
  const uvs = new Float32Array(8 * 2)
  for (let i = 0; i < 8; i++) {
    const v = ORDER[i]!
    const front = i < 4
    const p = base[v]!
    const x = p[0]
    const y = p[1]
    const z = p[2] + moveZ + (front ? FACE_OFFSET : -FACE_OFFSET)
    positions[i * 3] = (x * cos + z * sin) * 0.5 + 0.5
    positions[i * 3 + 1] = y * 0.5 + 0.5
    positions[i * 3 + 2] = (-x * sin + z * cos) * 0.5 + 0.5
    uvs[i * 2] = U[v]!
    uvs[i * 2 + 1] = V[v]!
  }
  return { positions, uvs }
}

/** 看板から見える距離 (MarumaSign 本体の viewDistance と同じ式。上限は設定) */
export function viewDistance(sign: SignShape, cap: number): number {
  let maxSq = 0
  const half = [[-sign.sx, -sign.sy], [-sign.sx, sign.sy], [sign.sx, sign.sy], [sign.sx, -sign.sy]] as const
  for (const p of half) {
    const q = rotatePoint(sign, p[0], p[1], 0)
    maxSq = Math.max(maxSq, q[0] * q[0] + q[1] * q[1] + q[2] * q[2])
  }
  return Math.min(cap, Math.min(512, 64 + Math.sqrt(maxSq) * 2))
}

/** ブロックの位置のキー */
export function blockKey(x: number, y: number, z: number): string {
  return x + ',' + y + ',' + z
}

const BOARD_EPS = 1e-4
/** 三角形の持ち主を決めるとき、重心から裏へ入る長さ (ブロック)。板の厚み (約 0.083) より十分小さい */
const BOARD_NUDGE = 1e-3

/**
 * 看板の板を消す (MarumaSign 本体が、ゲームの中で MarumaSign の看板の板を描かないのと同じ見え方にする)。
 * BlueMap の高精細タイルは、インデックスなしの三角形の並び (ブロックの座標はタイルの位置からの相対)。
 * 看板のブロック (1×1×1) の中にある三角形を、1 点に潰して見えなくする。
 *
 * 看板の板の小口 (板の左右の端) や支柱の底は、ブロックの境界の面にぴったり乗る。
 * 地面の上面や隣のブロックの側面も同じ面に乗るので、位置だけでは見分けられない。
 * そこで、三角形の持ち主を面の向き (頂点の並びから決まる表の向き) で決める。
 * 表の向きから少しだけ裏へ入った点が看板のブロックの中なら看板のもの、外 (隣のブロック) なら隣のもの。
 * 隣のブロックの面は表がこちらを向くので、裏へ入った点は隣のブロックの中になり、残る。
 * 上側の境界の面 (x=1, y=1, z=1) の小口も、表が外を向くので看板のものになる (重心の位置だけだと隣のブロックに入ってしまう)。
 * @param positions 頂点の位置 (x, y, z の並び。3 頂点で 1 つの三角形)
 * @param ox タイルの位置 (ブロック)。oy, oz も同じ
 * @param cells 看板のブロックの位置 (blockKey)
 * @return 潰した三角形の数
 */
export function hideBoards(positions: Float32Array | number[], ox: number, oy: number, oz: number, cells: Set<string>): number {
  let hidden = 0
  const a = positions
  for (let i = 0; i + 8 < a.length; i += 9) {
    if (a[i] === a[i + 3] && a[i] === a[i + 6] && a[i + 1] === a[i + 4] && a[i + 1] === a[i + 7]
      && a[i + 2] === a[i + 5] && a[i + 2] === a[i + 8]) continue // もう潰してある
    // 表の向き (単位ベクトル)。面積のない三角形は持ち主が決まらないので触らない
    const ux = a[i + 3]! - a[i]!, uy = a[i + 4]! - a[i + 1]!, uz = a[i + 5]! - a[i + 2]!
    const vx = a[i + 6]! - a[i]!, vy = a[i + 7]! - a[i + 1]!, vz = a[i + 8]! - a[i + 2]!
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx
    const len = Math.hypot(nx, ny, nz)
    if (!(len > 1e-9)) continue
    nx /= len
    ny /= len
    nz /= len
    // 重心から表の向きと逆へ少し入った点が、持ち主のブロックの中
    const bx = Math.floor((a[i]! + a[i + 3]! + a[i + 6]!) / 3 + ox - nx * BOARD_NUDGE)
    const by = Math.floor((a[i + 1]! + a[i + 4]! + a[i + 7]!) / 3 + oy - ny * BOARD_NUDGE)
    const bz = Math.floor((a[i + 2]! + a[i + 5]! + a[i + 8]!) / 3 + oz - nz * BOARD_NUDGE)
    if (!cells.has(blockKey(bx, by, bz))) continue
    // 3 点とも看板のブロックの中か (はみ出す三角形は看板のものではない)
    let inside = true
    for (let k = 0; k < 9; k += 3) {
      const x = a[i + k]! + ox - bx, y = a[i + k + 1]! + oy - by, z = a[i + k + 2]! + oz - bz
      if (x < -BOARD_EPS || x > 1 + BOARD_EPS || y < -BOARD_EPS || y > 1 + BOARD_EPS || z < -BOARD_EPS || z > 1 + BOARD_EPS) {
        inside = false
        break
      }
    }
    if (!inside) continue
    for (let k = 3; k < 9; k += 3) {
      a[i + k] = a[i]!
      a[i + k + 1] = a[i + 1]!
      a[i + k + 2] = a[i + 2]!
    }
    hidden++
  }
  return hidden
}

// ---------------------------------------------------------------- 種類の判別 (ここからは前のスクリプトになかったもの)

/** 看板の URL が表すものの種類 (MarumaSign Companion の MediaKind と同じ並び) */
export type MediaKindId = 'image' | 'video' | 'audio' | 'model' | 'splat' | 'pdf' | 'structure' | 'other'

export const MEDIA_KIND_IDS: readonly MediaKindId[] = ['image', 'video', 'audio', 'model', 'splat', 'pdf', 'structure', 'other']
// MediaKind の icon と label (データファイルの kinds) から種類を引く。並びが変わっても困らないように
const KIND_BY_ICON: Record<string, MediaKindId> = {
  '🖼': 'image', '🎬': 'video', '🎵': 'audio', '🧊': 'model', '✨': 'splat', '📄': 'pdf', '🏗': 'structure', '🔗': 'other',
}
const KIND_BY_LABEL: Record<string, MediaKindId> = {
  '画像': 'image', '動画': 'video', '音声': 'audio', '3Dモデル': 'model', 'ガウシアンスプラッティング': 'splat',
  'PDF': 'pdf', '構造物': 'structure', 'リンク': 'other',
}

/** データファイルの kinds の 1 つ ([icon, label]) と、その位置から種類を決める */
export function kindIdOf(entry: readonly [string, string] | undefined, index: number): MediaKindId {
  if (entry) {
    const icon = entry[0].replace(/️/g, '').trim()
    const byIcon = KIND_BY_ICON[icon]
    if (byIcon) return byIcon
    const byLabel = KIND_BY_LABEL[entry[1].trim()]
    if (byLabel) return byLabel
  }
  return MEDIA_KIND_IDS[index] ?? 'other'
}

// MarumaSign Companion の MediaKind と同じ拡張子の組
const VIDEO_EXT = new Set(['mp4', 'webm', 'mkv', 'mov', 'avi', 'm3u8', 'mpd'])
const AUDIO_EXT = new Set(['mp3', 'ogg', 'wav', 'flac', 'm4a', 'aac', 'opus'])
const MODEL_EXT = new Set(['glb', 'gltf'])
const SPLAT_EXT = new Set(['ply', 'spz', 'sog', 'splat', 'ksplat'])
const STRUCTURE_EXT = new Set(['schem', 'litematic', 'nbt', 'mcstructure', 'schematic'])
const IMAGE_EXT = new Set([
  'png', 'apng', 'gif', 'jpg', 'jpeg', 'bmp', 'webp', 'tif', 'tiff', 'svg', 'svgz', 'ico', 'cur', 'ani', 'icns', 'psd',
  'psb', 'tga', 'qoi', 'dds', 'ktx2', 'pcx', 'pbm', 'pgm', 'ppm', 'pnm', 'pam', 'pfm', 'sgi', 'rgb', 'ras', 'xbm',
  'xpm', 'wbmp', 'ff', 'hdr', 'fits', 'avif', 'heic', 'heif', 'jxl', 'jp2', 'exr', 'dpx', 'iff', 'xwd', 'pgx',
])

// TGA の拡張子 (MarumaSign 本体の StillFormats.detectByExtension と同じ)
const TGA_EXT = new Set(['tga', 'icb', 'vda', 'vst', 'targa'])

/** URL のパスの拡張子 (小文字。なければ空文字。MediaKind.extension と同じ) */
export function extensionOf(url: string): string {
  let path: string
  try {
    path = new URL(url).pathname
  }
  catch {
    return ''
  }
  const name = path.substring(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  if (dot < 0 || dot === name.length - 1) return ''
  return name.substring(dot + 1).toLowerCase()
}

/** 拡張子から種類 (MediaKind.of と同じ) */
export function mediaKindOf(ext: string): MediaKindId {
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  if (MODEL_EXT.has(ext)) return 'model'
  if (SPLAT_EXT.has(ext)) return 'splat'
  if (ext === 'pdf') return 'pdf'
  if (STRUCTURE_EXT.has(ext)) return 'structure'
  if (IMAGE_EXT.has(ext)) return 'image'
  return 'other'
}

/**
 * 看板をどう描くか (renderers/ のどれを使うか)。
 *  - image: 画像 (legacy は前のスクリプトと同じく、プラグインが画像の URL を書いたもの)
 *  - video / hls / dash / flv / mjpeg: 動画・音声とライブ配信
 *  - pdf: PDF
 *  - probe: 拡張子から分からないので、中身を見て決める
 *  - model / splat / structure: 3D のもの (いまは種類の絵の板だけ。後で足す)
 */
export type RouteType = 'image' | 'video' | 'hls' | 'dash' | 'flv' | 'mjpeg' | 'pdf' | 'probe' | 'model' | 'splat' | 'structure'

export interface Route {
  type: RouteType
  url: string
  /** プラグインが画像として書いた URL を、前のスクリプトと同じ読み方で読む */
  legacy?: boolean
  /** 拡張子 (小文字) */
  ext: string
}

/**
 * 看板の描き方を決める。描かない (ラベルだけ) なら null。
 * @param kind データファイルの種類
 */
export function planRoute(sign: Pick<ParsedSign, 'image' | 'link' | 'orient'>, kind: MediaKindId): Route | null {
  // 向きが分からなければ、前のスクリプトと同じく絵にしない
  if (sign.orient < 0) return null
  if (sign.image) {
    const ext = extensionOf(sign.image)
    // 拡張子のない URL (プラグインは「リンク」として、画像かもしれないと書く) は、読んで中身を見る
    return { type: kind === 'other' ? 'probe' : 'image', url: sign.image, legacy: true, ext }
  }
  // 画像以外を読むのも https だけ (http は https のページに混ぜて読めず、途中で書き換えられるおそれもある)
  const url = safeUrl(sign.link, true)
  if (!url) return null
  const ext = extensionOf(url)
  // 拡張子が種類と食い違うとき (プラグインの許す拡張子の設定による) は、拡張子を信じる
  const byExt = ext ? mediaKindOf(ext) : 'other'
  const k = byExt !== 'other' ? byExt : kind
  switch (k) {
    case 'image': return { type: 'image', url, ext }
    case 'video':
      if (ext === 'm3u8') return { type: 'hls', url, ext }
      if (ext === 'mpd') return { type: 'dash', url, ext }
      return { type: 'video', url, ext }
    case 'audio': return { type: 'video', url, ext }
    case 'pdf': return { type: 'pdf', url, ext }
    case 'model': return { type: 'model', url, ext }
    case 'splat': return { type: 'splat', url, ext }
    case 'structure': return { type: 'structure', url, ext }
    default:
      if (ext === 'flv') return { type: 'flv', url, ext }
      return { type: 'probe', url, ext }
  }
}

/** 中身から分かった形式 */
export interface Sniffed {
  route: RouteType
  /** 画像なら形式の名前 (decoders/ の名前)。動画なら 'audio' か 'video' (分からなければ 'video') */
  format: string
  /** 動画・音声の入れ物の形式 (分かったときだけ。ブラウザーが再生できないものは renderers/media.ts が FFmpeg で変換する) */
  container?: string
}

/**
 * 動画・音声の入れ物の形式 (sniff の container) のうち、ブラウザー (video 要素) では再生できないもの。
 * MarumaSign 本体は FFmpeg で何でも再生するので、Web では FFmpeg (WebAssembly) で再生できる形に変換する (sources/ffmpeg.ts)。
 * ts と flv はブラウザーの video 要素では再生できないが、mpegts.js で再生する
 */
export const TRANSCODE_CONTAINERS: ReadonlySet<string> = new Set([
  'avi', 'asf', 'mpegps', 'mpegvideo', 'm2ts', 'rm', 'amr', 'aiff', 'au', 'caf', 'ape', 'wv', 'mpc', 'ac3', 'dts', 'mxf', 'y4m',
  'ogg-theora', 'tta', 'voc', 'nut', 'ivf', 'dv',
])

function ascii(b: Uint8Array, at: number, s: string): boolean {
  if (at + s.length > b.length) return false
  for (let i = 0; i < s.length; i++) if (b[at + i] !== s.charCodeAt(i)) return false
  return true
}

function findAscii(b: Uint8Array, s: string, limit: number): number {
  const end = Math.min(b.length, limit) - s.length
  for (let i = 0; i <= end; i++) if (ascii(b, i, s)) return i
  return -1
}

function textHead(b: Uint8Array, limit: number): string {
  let s = ''
  const n = Math.min(b.length, limit)
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]!)
  return s
}

const SVG_TAG = /<svg[\s>]/iy

/** 前置き (<?xml ...>、コメント、DOCTYPE) のあとが <svg か */
function startsWithSvg(text: string): boolean {
  return startsAfterXmlHead(text, SVG_TAG, { decl: true, doctype: true })
}

/**
 * 先頭のバイト列 (と Content-Type と拡張子) から、何として描くかを決める。分からなければ null。
 * MarumaSign 本体と同じく、拡張子ではなく中身で判別する (目印のない TGA・WBMP・XBM だけは拡張子も使う)。
 * @param type Content-Type の主な部分 (小文字。なければ空文字)
 */
export function sniff(head: Uint8Array, type: string, ext: string): Sniffed | null {
  const b = head
  // ---- 画像
  if (b[0] === 0x89 && ascii(b, 1, 'PNG')) return { route: 'image', format: 'png' }
  if (ascii(b, 0, 'GIF8')) return { route: 'image', format: 'gif' }
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return { route: 'image', format: 'jpeg' }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WEBP')) return { route: 'image', format: 'webp' }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'ACON')) return { route: 'image', format: 'ani' }
  if (ascii(b, 0, 'BM') && b.length >= 18) return { route: 'image', format: 'bmp' }
  if (b[0] === 0 && b[1] === 0 && (b[2] === 1 || b[2] === 2) && b[3] === 0 && b.length >= 6 && (b[4]! | b[5]!) !== 0) {
    return { route: 'image', format: b[2] === 1 ? 'ico' : 'cur' }
  }
  if (ascii(b, 0, 'icns')) return { route: 'image', format: 'icns' }
  if (ascii(b, 0, '8BPS')) return { route: 'image', format: 'psd' }
  if (ascii(b, 0, 'qoif')) return { route: 'image', format: 'qoi' }
  if (ascii(b, 0, 'DDS ')) return { route: 'image', format: 'dds' }
  if (b[0] === 0xAB && ascii(b, 1, 'KTX 20')) return { route: 'image', format: 'ktx2' }
  if ((ascii(b, 0, 'II') && b[2] === 42 && b[3] === 0) || (ascii(b, 0, 'MM') && b[2] === 0 && b[3] === 42)
    || (ascii(b, 0, 'II') && b[2] === 43 && b[3] === 0) || (ascii(b, 0, 'MM') && b[2] === 0 && b[3] === 43)) return { route: 'image', format: 'tiff' }
  if (ascii(b, 0, 'farbfeld')) return { route: 'image', format: 'farbfeld' }
  if (ascii(b, 0, '#?RADIANCE') || ascii(b, 0, '#?RGBE')) return { route: 'image', format: 'hdr' }
  if (b[0] === 0x76 && b[1] === 0x2F && b[2] === 0x31 && b[3] === 0x01) return { route: 'image', format: 'exr' }
  if (b[0] === 0x01 && b[1] === 0xDA && (b[2] === 0 || b[2] === 1)) return { route: 'image', format: 'sgi' }
  if (b[0] === 0x59 && b[1] === 0xA6 && b[2] === 0x6A && b[3] === 0x95) return { route: 'image', format: 'ras' }
  if (b[0] === 0x0A && b[1]! <= 5 && b[2] === 1 && b.length >= 128) return { route: 'image', format: 'pcx' }
  if (b[0] === 0x50 && b[1]! >= 0x31 && b[1]! <= 0x37 && (b[2] === 0x0A || b[2] === 0x0D || b[2] === 0x20 || b[2] === 0x09)) {
    return { route: 'image', format: 'pnm' }
  }
  if (b[0] === 0x50 && (b[1] === 0x66 || b[1] === 0x46) && (b[2] === 0x0A || b[2] === 0x0D || b[2] === 0x20)) return { route: 'image', format: 'pfm' }
  if (ascii(b, 4, 'ftyp')) {
    const brand = textHead(b.subarray(8, 12), 4)
    if (brand === 'M4A ' || brand === 'M4B ') return { route: 'video', format: 'audio' }
    const image = isoImage(b)
    if (image) return { route: 'image', format: image }
    // 3GP (携帯電話の動画。H.263 や AMR のものはブラウザーで再生できないので、再生できなければ変換する)
    if (brand.startsWith('3g')) return { route: 'video', format: 'video', container: '3gp' }
    return { route: 'video', format: 'video' }
  }
  if ((b[0] === 0xFF && b[1] === 0x0A) || (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0C && ascii(b, 4, 'JXL '))) {
    return { route: 'image', format: 'jxl' }
  }
  // JPEG 2000: JP2 の箱と、コードストリームそのもの (FF 4F FF 51。.j2k)
  if (b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0C && ascii(b, 4, 'jP  ')) return { route: 'image', format: 'jp2' }
  if (b[0] === 0xFF && b[1] === 0x4F && b[2] === 0xFF && b[3] === 0x51) return { route: 'image', format: 'jp2' }
  if (ascii(b, 0, 'SIMPLE  =')) return { route: 'image', format: 'fits' }
  // DPX と IFF (ILBM・PBM・ACBM)。MarumaSign 本体は FFmpeg で読む
  if (ascii(b, 0, 'SDPX') || ascii(b, 0, 'XPDS')) return { route: 'image', format: 'dpx' }
  if (ascii(b, 0, 'FORM') && (ascii(b, 8, 'ILBM') || ascii(b, 8, 'PBM ') || ascii(b, 8, 'ACBM'))) return { route: 'image', format: 'iff' }
  // ---- PDF (仕様では先頭に置くが、前に余計なバイトが付いたファイルも多いので、先頭の近くから探す。PdfFile.isPdf と同じ)
  if (findAscii(b, '%PDF-', 1024) >= 0) return { route: 'pdf', format: 'pdf' }
  // ---- 動画・音声・ライブ配信
  if (ascii(b, 0, '#EXTM3U')) return { route: 'hls', format: 'video' }
  if (ascii(b, 0, 'FLV') && b[3] === 1) return { route: 'flv', format: 'video', container: 'flv' }
  if (b[0] === 0x1A && b[1] === 0x45 && b[2] === 0xDF && b[3] === 0xA3) return { route: 'video', format: 'video', container: 'mkv' }
  if (ascii(b, 0, 'OggS')) {
    // Theora の映像は Chrome が再生しなくなった
    if (findAscii(b, 'theora', 512) >= 0) return { route: 'video', format: 'video', container: 'ogg-theora' }
    return { route: 'video', format: type.startsWith('video/') ? 'video' : 'audio', container: 'ogg' }
  }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'WAVE')) return { route: 'video', format: 'audio', container: 'wav' }
  if (ascii(b, 0, 'RIFF') && ascii(b, 8, 'AVI ')) return { route: 'video', format: 'video', container: 'avi' }
  if (ascii(b, 0, 'fLaC')) return { route: 'video', format: 'audio', container: 'flac' }
  if (ascii(b, 0, 'ID3') || (b[0] === 0xFF && (b[1]! & 0xE0) === 0xE0 && b.length >= 4 && (type.startsWith('audio/') || ext === 'mp3' || ext === 'aac'))) {
    return { route: 'video', format: 'audio' }
  }
  if (b[0] === 0x47 && b.length >= 189 && b[188] === 0x47) return { route: 'video', format: 'video', container: 'ts' }
  // ---- ブラウザーが再生できない入れ物 (MarumaSign 本体は FFmpeg で再生する。Web では変換して再生する)
  const media = sniffOtherMedia(b, type, ext)
  if (media) return media
  // ---- 3D (MarumaSign 本体の ImageLoader と同じ順: 3D モデル、構造物、ガウシアンスプラッティング)
  if (ascii(b, 0, 'glTF')) return { route: 'model', format: 'glb' }
  if (looksLikeNbt(b, false) || looksLikeNbt(b, true)) return { route: 'structure', format: 'nbt' }
  if (b[0] === 0x1F && b[1] === 0x8B && b[2] === 8) {
    if (ext === 'svgz') return { route: 'image', format: 'svgz' }
    if (STRUCTURE_EXT.has(ext)) return { route: 'structure', format: 'nbt' }
    if (ext === 'spz') return { route: 'splat', format: 'spz' }
    // 中を展開してみないと分からない (構造物、.spz、.svgz)。fetch.ts の refineGzip で決める
    return { route: 'probe', format: 'gzip' }
  }
  const splat = sniffSplat(b, ext)
  if (splat) return { route: 'splat', format: splat }
  // ---- 文字の形式
  const text = textHead(b, 1024)
  if (startsWithSvg(text)) return { route: 'image', format: 'svg' }
  if (/^\s*(<\?xml[^>]*>\s*)?<MPD[\s>]/.test(text)) return { route: 'dash', format: 'video' }
  if (/^\/\*\s*XPM\s*\*\//.test(text)) return { route: 'image', format: 'xpm' }
  if (/^\s*#define\s+\S+_width\s+\d+/.test(text) && (ext === 'xbm' || type === 'image/x-xbitmap')) return { route: 'image', format: 'xbm' }
  // .gltf (JSON)。MarumaSign 本体と同じく、JSON らしければ 3D モデルとして読んでみる (読めなければ失敗)
  if (/^(ï»¿)?\s*\{/.test(text)) return { route: 'model', format: 'gltf' }
  // ---- Content-Type (中身に目印がないもの)
  if (type === 'multipart/x-mixed-replace') return { route: 'mjpeg', format: 'video' }
  if (type === 'application/vnd.apple.mpegurl' || type === 'application/x-mpegurl' || type === 'audio/mpegurl' || type === 'audio/x-mpegurl') {
    return { route: 'hls', format: 'video' }
  }
  if (type === 'application/dash+xml') return { route: 'dash', format: 'video' }
  if (type === 'video/x-flv') return { route: 'flv', format: 'video' }
  if (type === 'image/svg+xml') return { route: 'image', format: 'svg' }
  // ---- 目印のない画像は拡張子で (MarumaSign 本体と同じ)
  if (TGA_EXT.has(ext) || type === 'image/x-tga' || type === 'image/x-targa') return { route: 'image', format: 'tga' }
  if (ext === 'wbmp' || type === 'image/vnd.wap.wbmp') return { route: 'image', format: 'wbmp' }
  // XWD と PGX も拡張子で (MarumaSign 本体と同じ。中身の目印を少しだけ確かめる)
  if ((ext === 'xwd' || type === 'image/x-xwindowdump') && b.length >= 8 && b[4] === 0 && b[5] === 0 && b[6] === 0 && b[7] === 7) return { route: 'image', format: 'xwd' }
  if (ext === 'pgx' && ascii(b, 0, 'PG')) return { route: 'image', format: 'pgx' }
  // 先頭に長いコメントなどがあって、最初の 1024 バイトに <svg が出てこない SVG
  if (ext === 'svg' && b.length > 0 && (b[0] === 0x3C || b[0] === 0xEF || b[0]! <= 0x20)) return { route: 'image', format: 'svg' }
  if (type.startsWith('video/')) return { route: 'video', format: 'video' }
  if (type.startsWith('audio/')) return { route: 'video', format: 'audio' }
  return null
}

const ASF_GUID = [0x30, 0x26, 0xB2, 0x75, 0x8E, 0x66, 0xCF, 0x11, 0xA6, 0xD9, 0x00, 0xAA, 0x00, 0x62, 0xCE, 0x6C]
const AUDIO_ONLY_EXT = new Set(['wma', 'amr', 'aif', 'aiff', 'aifc', 'au', 'snd', 'caf', 'ape', 'wv', 'mpc', 'ac3', 'eac3', 'dts', 'tta', 'voc', 'ra'])

/**
 * ブラウザーが再生できない動画・音声の入れ物 (MarumaSign 本体は FFmpeg で読む)。
 * 目印の弱いもの (AC-3) は Content-Type か拡張子も見る
 */
function sniffOtherMedia(b: Uint8Array, type: string, ext: string): Sniffed | null {
  const audio = type.startsWith('audio/') || AUDIO_ONLY_EXT.has(ext)
  const av = (container: string): Sniffed => ({ route: 'video', format: audio ? 'audio' : 'video', container })
  const a = (container: string): Sniffed => ({ route: 'video', format: 'audio', container })
  if (b.length >= 16 && ASF_GUID.every((v, i) => b[i] === v)) return av('asf')
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xBA) return av('mpegps')
  if (b[0] === 0 && b[1] === 0 && b[2] === 1 && b[3] === 0xB3) return { route: 'video', format: 'video', container: 'mpegvideo' }
  // Blu-ray などの 192 バイトずつの MPEG-TS
  if (b.length >= 197 && b[4] === 0x47 && b[196] === 0x47) return { route: 'video', format: 'video', container: 'm2ts' }
  if (ascii(b, 0, '.RMF')) return av('rm')
  if (ascii(b, 0, '.ra\xFD')) return a('rm')
  if (ascii(b, 0, '#!AMR')) return a('amr')
  if (ascii(b, 0, 'FORM') && (ascii(b, 8, 'AIFF') || ascii(b, 8, 'AIFC'))) return a('aiff')
  if (ascii(b, 0, '.snd')) return a('au')
  if (ascii(b, 0, 'caff')) return a('caf')
  if (ascii(b, 0, 'MAC ')) return a('ape')
  if (ascii(b, 0, 'wvpk')) return a('wv')
  if (ascii(b, 0, 'MPCK') || ascii(b, 0, 'MP+')) return a('mpc')
  if (ascii(b, 0, 'TTA1')) return a('tta')
  if (ascii(b, 0, 'Creative Voice File')) return a('voc')
  if (b[0] === 0x7F && b[1] === 0xFE && b[2] === 0x80 && b[3] === 0x01) return a('dts')
  if (b[0] === 0x0B && b[1] === 0x77 && (ext === 'ac3' || ext === 'eac3' || type === 'audio/ac3' || type === 'audio/eac3')) return a('ac3')
  if (b[0] === 0x06 && b[1] === 0x0E && b[2] === 0x2B && b[3] === 0x34) return av('mxf')
  if (ascii(b, 0, 'YUV4MPEG2')) return { route: 'video', format: 'video', container: 'y4m' }
  if (ascii(b, 0, 'nut/multimedia container')) return av('nut')
  if (ascii(b, 0, 'DKIF')) return { route: 'video', format: 'video', container: 'ivf' }
  // DV (ext か Content-Type も見る。目印が短い)
  if (b[0] === 0x1F && b[1] === 0x07 && b[2] === 0x00 && (ext === 'dv' || type === 'video/dv')) return { route: 'video', format: 'video', container: 'dv' }
  return null
}

/**
 * ISO BMFF (ftyp) の画像の形式 (MarumaSign 本体の StillFormats.isoImage と同じく、主なブランドと互換ブランドを見る)。
 * HEVC の連続した画像 (msf1, hevc, hevx) は動画。AVIF の連続した画像 (avis) は、ここではアニメーションの画像として読む
 * (ImageDecoder でコマごとに読める。MarumaSign 本体は動画として扱う)
 */
function isoImage(b: Uint8Array): 'avif' | 'heic' | null {
  const size = ((b[0]! << 24) | (b[1]! << 16) | (b[2]! << 8) | b[3]!) >>> 0
  const end = Math.min(b.length, size > 0 ? size : b.length)
  let avif = false, heic = false, avis = false, sequence = false
  for (let i = 8; i + 4 <= end; i += 4) {
    // 先頭の 4 バイトは主なブランド、そのあと 4 バイト (版) を挟んで、互換ブランドが並ぶ
    if (i === 12) continue
    const brand = textHead(b.subarray(i, i + 4), 4)
    if (brand === 'avis') avis = true
    else if (brand === 'msf1' || brand === 'hevc' || brand === 'hevx') sequence = true
    else if (brand === 'avif') avif = true
    else if (brand === 'heic' || brand === 'heix' || brand === 'heim' || brand === 'heis' || brand === 'mif1') heic = true
  }
  if (avis) return 'avif'
  if (sequence) return null
  return avif ? 'avif' : heic ? 'heic' : null
}

function u16(b: Uint8Array, p: number, little: boolean): number {
  return little ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!
}

function i32le(b: Uint8Array, p: number): number {
  return b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)
}

/**
 * 先頭が NBT (名前つきの複合タグ) らしいか (MarumaSign 本体の Nbt.looksLikeNbt と同じ)。
 * @param little リトルエンディアン (統合版の .mcstructure)
 */
export function looksLikeNbt(b: Uint8Array, little: boolean): boolean {
  if (b.length < 6 || b[0] !== 10) return false
  const nameLength = u16(b, 1, little)
  if (nameLength > 64) return false
  let p = 3
  for (let i = 0; i < nameLength; i++, p++) {
    if (p >= b.length) return true
    if (b[p]! < 0x20 || b[p]! > 0x7E) return false
  }
  if (p + 3 > b.length) return true
  const type = b[p]!
  if (type < 1 || type > 12) return false
  const childLength = u16(b, p + 1, little)
  if (childLength === 0 || childLength > 64) return false
  for (let i = 0; i < childLength && p + 3 + i < b.length; i++) {
    if (b[p + 3 + i]! < 0x20 || b[p + 3 + i]! > 0x7E) return false
  }
  return true
}

/** ガウシアンスプラッティングの形式 (MarumaSign 本体の SplatLoader.isSplat と同じ判定)。違えば null */
export function sniffSplat(b: Uint8Array, ext: string): string | null {
  // .ply: ヘッダーにガウス分布の項目 (f_dc_0 か、圧縮された形式の packed_position) がある
  if (ascii(b, 0, 'ply\n') || ascii(b, 0, 'ply\r\n')) {
    const head = textHead(b, Math.min(b.length, 64 * 1024))
    const end = head.indexOf('end_header')
    const header = end >= 0 ? head.substring(0, end) : head
    if (/property\s+\S+\s+(f_dc_0|packed_position)\s*$/m.test(header)) return 'ply'
    return null
  }
  // .spz のバージョン 4 (先頭が平文の NGSP)。バージョン 2・3 は gzip の中 (fetch.ts の refineGzip)
  if (ascii(b, 0, 'NGSP') && b.length >= 32 && i32le(b, 4) === 4) return 'spz'
  // .sog (PlayCanvas。zip の中に meta.json と webp)
  if (b[0] === 0x50 && b[1] === 0x4B && b[2] === 3 && b[3] === 4) {
    if (ext === 'sog') return 'sog'
    if (b.length >= 30) {
      const nameLength = u16(b, 26, true)
      const name = textHead(b.subarray(30, 30 + nameLength), nameLength)
      const base = name.substring(name.lastIndexOf('/') + 1)
      if (base === 'meta.json' || base.endsWith('.webp')) return 'sog'
    }
    return null
  }
  // .ksplat と .splat は目印がないので、拡張子と中身の形で
  if (ext === 'ksplat' && b.length >= 44 && b[0] === 0 && b[1]! >= 1) {
    const sections = i32le(b, 4), max = i32le(b, 12), count = i32le(b, 16), mode = u16(b, 20, true)
    if (sections > 0 && sections <= 1024 && count >= 0 && max >= 0 && (count || max) > 0 && mode <= 2) return 'ksplat'
    return null
  }
  if (ext === 'splat' && b.length >= 32) {
    const dv = new DataView(b.buffer, b.byteOffset, 24)
    for (let i = 0; i < 6; i++) if (!Number.isFinite(dv.getFloat32(i * 4, true))) return null
    return 'splat'
  }
  // zip にしていない .sog の meta.json (WebP は同じフォルダ。renderers/splat.ts が集めて読む。MarumaSign 本体は読まない)
  if (b[0] === 0x7B || b[0] === 0xEF || b[0] === 0x20 || b[0] === 0x0A || b[0] === 0x0D || b[0] === 0x09) {
    const text = textHead(b, 4096)
    if (/^(ï»¿)?\s*\{/.test(text) && /"means"\s*:\s*\{[^{}]*"files"\s*:\s*\[/.test(text)) return 'sog-meta'
  }
  return null
}

/**
 * gzip の中身の先頭から、何かを決める (MarumaSign 本体と同じく、展開した先頭を見る)。
 * @param inner 展開した先頭のバイト列
 */
export function sniffGzipInner(inner: Uint8Array, ext: string): Sniffed | null {
  if (inner.length >= 4 && ascii(inner, 0, 'NGSP')) return { route: 'splat', format: 'spz' }
  if (looksLikeNbt(inner, false)) return { route: 'structure', format: 'nbt' }
  const text = textHead(inner, 1024)
  if (startsWithSvg(text) || ext === 'svgz') return { route: 'image', format: 'svgz' }
  return null
}

// ---------------------------------------------------------------- 3D のものの置き方 (MarumaSign 本体の SignImage と同じ)

/**
 * 3D モデル・構造物・ガウシアンスプラッティングの、モデルの座標からブロックの角を原点とした座標への変換 (列優先の 4x4)。
 * MarumaSign 本体の SignImage.computePlacement と同じ: モデルを囲む直方体の最も長い辺が、画像の長い辺と同じ大きさになり、
 * 正面 (+Z) が看板の正面を向く。壁掛けの看板では、モデルの背面が壁に付く。
 * @param box モデルを囲む直方体 [minX, minY, minZ, maxX, maxY, maxZ]
 */
export function modelPlacement(sign: SignShape, box: readonly number[]): number[] {
  const cx = (box[0]! + box[3]!) / 2, cy = (box[1]! + box[4]!) / 2, cz = (box[2]! + box[5]!) / 2
  const extent = Math.max(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!)
  const fit = extent > 0 ? 2 / extent : 1
  const depth = (box[5]! - box[2]!) / 2 * fit * Math.abs(sign.sx)
  const wall = isWall(sign.orient)
  const angle = (-signYaw(sign.orient) - 180) * Math.PI / 180
  const sin = Math.sin(angle), cos = Math.cos(angle)
  const moveZ = wall ? WALL_OFFSET - depth : 0
  const place = (x: number, y: number, z: number): [number, number, number] => {
    // モデルの正面 (+Z) が看板の正面を向くように、縦の軸で半回転させる
    const p = rotatePoint(sign, -(x - cx) * fit * sign.sx, (y - cy) * fit * sign.sy, -(z - cz) * fit * sign.sx)
    const px = p[0], pz = p[2] + moveZ
    return [(px * cos + pz * sin) * 0.5 + 0.5, p[1] * 0.5 + 0.5, (-px * sin + pz * cos) * 0.5 + 0.5]
  }
  const origin = place(0, 0, 0)
  const m = new Array<number>(16).fill(0)
  for (let axis = 0; axis < 3; axis++) {
    const q = place(axis === 0 ? 1 : 0, axis === 1 ? 1 : 0, axis === 2 ? 1 : 0)
    for (let k = 0; k < 3; k++) m[axis * 4 + k] = q[k]! - origin[k]!
  }
  m[12] = origin[0]
  m[13] = origin[1]
  m[14] = origin[2]
  m[15] = 1
  return m
}

/** 看板から見える距離 (3D のもの。MarumaSign 本体と同じく、置いたモデルの角の遠さから) */
export function modelViewDistance(sign: SignShape, box: readonly number[], cap: number): number {
  const cx = (box[0]! + box[3]!) / 2, cy = (box[1]! + box[4]!) / 2, cz = (box[2]! + box[5]!) / 2
  const extent = Math.max(box[3]! - box[0]!, box[4]! - box[1]!, box[5]! - box[2]!)
  const fit = extent > 0 ? 2 / extent : 1
  let maxSq = 0
  for (let corner = 0; corner < 8; corner++) {
    const x = box[(corner & 1) * 3]!, y = box[1 + ((corner >> 1) & 1) * 3]!, z = box[2 + ((corner >> 2) & 1) * 3]!
    const q = rotatePoint(sign, -(x - cx) * fit * sign.sx, (y - cy) * fit * sign.sy, -(z - cz) * fit * sign.sx)
    maxSq = Math.max(maxSq, q[0] * q[0] + q[1] * q[1] + q[2] * q[2])
  }
  return Math.min(cap, Math.min(512, 64 + Math.sqrt(maxSq) * 2))
}

// ---------------------------------------------------------------- ガウシアンスプラッティング (MarumaSign 本体の SplatLoader と同じ)

/** 1 つの看板で表示するガウス分布の数の上限 (MarumaSign 本体と同じ) */
export const MAX_SPLATS = 150000
/** 背景の遠い分布を切り落とす、中心からの距離の中央値に対する倍率 */
export const SPLAT_CROP_FACTOR = 4

/** 目立つ度合い。不透明度と、分布の広がり (おおよその表面積) の平方根の積 */
export function splatImportance(opacity: number, sx: number, sy: number, sz: number): number {
  const area = sx * sy + sy * sz + sz * sx
  if (!(area > 0) || !(opacity > 0)) return 0
  return opacity * Math.sqrt(area)
}

function median(values: Float32Array): number {
  const sorted = values.slice().sort()
  return sorted[sorted.length >> 1]!
}

/**
 * 残す分布の添字を昇順で返す (MarumaSign 本体の SplatLoader.select と同じ)。
 * 背景の遠い分布 (中心からの距離が中央値の 4 倍より遠いもの) を切り落とし、残ったものから目立つ順に最大 max 個を選ぶ。
 * 切り落とすと半分より少なくなるときは、切り落とさない。
 * @param positions 位置 (x, y, z の並び)
 */
export function selectSplats(importance: Float32Array, positions: Float32Array, count: number, max: number, crop = true): Uint32Array {
  if (count <= 0) return new Uint32Array(0)
  let candidates: Uint32Array | null = null
  if (crop && count > 1) {
    const coords = new Float32Array(count)
    const center = [0, 0, 0]
    for (let axis = 0; axis < 3; axis++) {
      for (let i = 0; i < count; i++) coords[i] = positions[i * 3 + axis]!
      center[axis] = median(coords)
    }
    const dists = new Float32Array(count)
    for (let i = 0; i < count; i++) {
      const dx = positions[i * 3]! - center[0]!, dy = positions[i * 3 + 1]! - center[1]!, dz = positions[i * 3 + 2]! - center[2]!
      dists[i] = Math.sqrt(dx * dx + dy * dy + dz * dz)
    }
    const maxDist = SPLAT_CROP_FACTOR * median(dists)
    let kept = 0
    for (let i = 0; i < count; i++) if (dists[i]! <= maxDist) kept++
    if (kept >= (count + 1) >> 1 && kept < count) {
      candidates = new Uint32Array(kept)
      let n = 0
      for (let i = 0; i < count; i++) if (dists[i]! <= maxDist) candidates[n++] = i
    }
  }
  const candCount = candidates ? candidates.length : count
  const at = (i: number): number => candidates ? candidates[i]! : i
  if (candCount <= max) {
    if (candidates) return candidates
    const all = new Uint32Array(count)
    for (let i = 0; i < count; i++) all[i] = i
    return all
  }
  const imp = new Float32Array(candCount)
  for (let i = 0; i < candCount; i++) imp[i] = importance[at(i)]!
  imp.sort()
  const threshold = imp[candCount - max]!
  const selected = new Uint32Array(max)
  let n = 0
  for (let i = 0; i < candCount && n < max; i++) if (importance[at(i)]! > threshold) selected[n++] = at(i)
  for (let i = 0; i < candCount && n < max; i++) if (importance[at(i)] === threshold) selected[n++] = at(i)
  selected.sort()
  return selected
}

/**
 * URL の末尾の「#page=ページ番号」から、最初に表示するページ (0 から始まる) を求める (MarumaSign 本体の PdfFile.requestedPage と同じ)。
 * ブラウザの PDF ビューアと同じ書き方 (RFC 8118) で、「#zoom=50&page=3」のようにほかの指定と並んでいてもよい。
 * 指定がないか、正しくない値なら 0。ページの数は見ないので、範囲に収めるのは clampPage で行う
 */
export function requestedPage(url: string): number {
  const hash = url.indexOf('#')
  if (hash < 0) return 0
  for (const parameter of url.substring(hash + 1).split('&')) {
    const equals = parameter.indexOf('=')
    if (equals < 0 || parameter.substring(0, equals).trim().toLowerCase() !== 'page') continue
    // 「007」のような先頭の 0 は数の大きさに関係しないので除く
    const value = parameter.substring(equals + 1).trim().replace(/^0+(?=\d)/, '')
    if (value === '' || !/^[0-9]+$/.test(value)) return 0
    // int に収まらないほど大きな値は、最後のページを指したものとして扱う
    if (value.length > 9) return 2147483647
    const n = Number(value)
    return n >= 1 ? n - 1 : 0
  }
  return 0
}

/** ページ番号 (0 から始まる) を、ページの範囲に収める。多すぎれば最後のページ */
export function clampPage(index: number, pageCount: number): number {
  return Math.max(0, Math.min(pageCount - 1, index))
}

/** URL の「#」から後ろを除く (読み込むファイルは同じ) */
export function withoutFragment(url: string): string {
  const hash = url.indexOf('#')
  return hash < 0 ? url : url.substring(0, hash)
}

/**
 * 看板までの距離と音量から、再生する音の大きさ (0 - 1) を求める (MarumaSign 本体の MediaSession.gain と同じ)。
 * @param distance 看板までの距離 (ブロック)。分からなければ Infinity で、音は出さない
 * @param volume 音量 (0 - 100)
 */
export function mediaGain(distance: number, volume: number): number {
  const falloff = Math.max(0, 1 - distance / HEARING_DISTANCE)
  return falloff * falloff * volume / 100
}

/**
 * 近いものから limit 個だけを選ぶ (同時に再生する数の上限。MarumaSign 本体の allowNearestMedia と同じ考え方)。
 * @return 選んだものの集合
 */
export function nearest<T>(items: Iterable<T>, distance: (item: T) => number, limit: number): Set<T> {
  const list = Array.from(items).map(item => [distance(item), item] as const).filter(e => Number.isFinite(e[0]))
  list.sort((a, b) => a[0] - b[0])
  return new Set(list.slice(0, Math.max(0, limit)).map(e => e[1]))
}

/**
 * 画像を縮める倍率。一辺は size まで、アニメーションは全部のコマのピクセルの合計が budget まで。
 */
export function fitScale(width: number, height: number, size: number, frames = 1, budget = Infinity): number {
  const longest = Math.max(width, height)
  if (!(longest > 0)) return 1
  let scale = Math.min(1, size / longest)
  const total = width * height * frames * scale * scale
  if (total > budget) scale *= Math.sqrt(budget / total)
  return scale
}

/** ライブ配信をつなぎ直すまでの待ち時間 (ミリ秒。MarumaSign 本体の MediaPlayer と同じく 2 秒から倍にして 30 秒まで) */
export function reconnectDelay(attempt: number): number {
  return Math.min(30000, 2000 * Math.pow(2, Math.max(0, Math.min(attempt, 10))))
}
