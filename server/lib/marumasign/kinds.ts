/*
 * 中継 (/_marumasign/proxy) で返してよい中身の種類と、種類ごとの大きさの上限 (MarumaSign 本体と同じ)。
 * 先頭のバイト列で決める (core.ts の sniff。Content-Type は信じない)。HTML は返さない。
 * 返すときの Content-Type は決まったものだけ (画像・動画・音声のほかは application/octet-stream)。本当の種類は X-MarumaSign-Type で知らせる
 * Nuxt に頼らない (Node の試験でも動かす)
 */
import {
  MAX_IMAGE_BYTES, MAX_PDF_BYTES, sniff, type Sniffed,
} from '../../../app/bluemap/marumasign/core.ts'
import { startsAfterXmlHead } from '../../../app/bluemap/marumasign/xml-head.ts'

const MIB = 1024 * 1024
/** 3D モデル・構造物 (MarumaSign 本体の ImageLoader.MAX_MODEL_SIZE, StructureLoader.MAX_SIZE) */
export const MAX_MODEL_BYTES = 64 * MIB
/** ガウシアンスプラッティング (ImageLoader.MAX_SPLAT_SIZE) */
export const MAX_SPLAT_BYTES = 200 * MIB
/** 再生リスト (HLS, MPEG-DASH) */
export const MAX_MANIFEST_BYTES = 4 * MIB
/** 中を読んで URL を取り出す .gltf の大きさの上限 (これより大きなものは中継するが、中の URL は読まない) */
export const MAX_GLTF_PARSE_BYTES = 16 * MIB
/** 動画・音声のファイル 1 つ (MarumaSign 本体は上限なし。1 つの IP から読める量の上限が別にある) */
export const MAX_MEDIA_BYTES = 1024 * MIB
/** 再生リストの中の分割されたファイルや、.gltf の .bin など (中身に目印がない) */
export const MAX_OPAQUE_BYTES = 64 * MIB
/**
 * 再生リストと別のサイトにある、中身に目印のないもの (暗号化された分割ファイルなど)。
 * 看板を置ける人が再生リストに好きな URL を書いて、ただの中継に使えないよう、分割ファイルらしい拡張子のものだけにする
 */
export const MAX_FOREIGN_OPAQUE_BYTES = 16 * MIB
/** 別のサイトの、それ以外の目印のないもの (暗号化の鍵など) */
export const MAX_FOREIGN_SMALL_BYTES = 4 * 1024
const SEGMENT_EXT = new Set(['ts', 'm2ts', 'mts', 'm4s', 'm4v', 'm4a', 'mp4', 'cmfv', 'cmfa', 'cmft', 'aac', 'ac3', 'ec3', 'mp3', 'webm', 'vtt', 'webvtt', 'key'])

export interface Kind {
  /** 種類 (core.ts の RouteType か、opaque) */
  name: string
  /** 大きさの上限 (バイト) */
  cap: number
  /** 返す Content-Type */
  type: string
  /** 中の URL を取り出すもの */
  manifest?: 'hls' | 'dash' | 'gltf'
  /** 終わらない配信 (MJPEG, HTTP-FLV など) かもしれない。遅くても切らない */
  stream?: boolean
}

const NATIVE_IMAGE: Record<string, string> = {
  png: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif',
}
const MEDIA_TYPE: Record<string, string> = {
  mkv: 'video/webm', wav: 'audio/wav', flac: 'audio/flac', ts: 'video/mp2t', flv: 'video/x-flv', '3gp': 'video/mp4',
}

const HTML_TAG = /<(!doctype\s+html|html|head|body|script|iframe|meta|title|style|link|frameset|form|div|p|a)[\s>/]/iy

/** 先頭が HTML らしいか (中継しない) */
export function looksLikeHtml(head: Uint8Array): boolean {
  let s = ''
  for (let i = 0; i < Math.min(head.length, 1024); i++) s += String.fromCharCode(head[i]!)
  s = s.replace(/^(\xEF\xBB\xBF|\xFE\xFF|\xFF\xFE)/, '')
  return startsAfterXmlHead(s, HTML_TAG)
}

function mediaType(s: Sniffed, head: Uint8Array): string {
  if (s.container && MEDIA_TYPE[s.container]) return MEDIA_TYPE[s.container]!
  if (s.container === 'ogg') return s.format === 'audio' ? 'audio/ogg' : 'video/ogg'
  if (!s.container && head[4] === 0x66 && head[5] === 0x74 && head[6] === 0x79 && head[7] === 0x70) return s.format === 'audio' ? 'audio/mp4' : 'video/mp4'
  if (!s.container && s.format === 'audio') return 'audio/mpeg'
  return 'application/octet-stream'
}

/**
 * 中身の種類と上限。返さないものは null
 * @param type 元のサイトの Content-Type の主な部分 (小文字)
 * @param ext URL の拡張子
 * @param child 再生リストや .gltf に書かれていた URL (目印のない中身でもよい)
 * @param foreign その再生リストと別のサイトにある (目印のない中身は、分割ファイルらしいものと小さいものだけ)
 */
export function classify(head: Uint8Array, type: string, ext: string, child: boolean, foreign = false): Kind | null {
  if (looksLikeHtml(head)) return null
  const s = sniff(head, type, ext)
  if (!s) {
    if (type === 'text/html' || type === 'application/xhtml+xml') return null
    if (!child) return null
    const cap = !foreign ? MAX_OPAQUE_BYTES : SEGMENT_EXT.has(ext) ? MAX_FOREIGN_OPAQUE_BYTES : MAX_FOREIGN_SMALL_BYTES
    return { name: 'opaque', cap, type: 'application/octet-stream' }
  }
  const octet = 'application/octet-stream'
  switch (s.route) {
    case 'image': return { name: 'image', cap: MAX_IMAGE_BYTES, type: NATIVE_IMAGE[s.format] ?? octet }
    case 'pdf': return { name: 'pdf', cap: MAX_PDF_BYTES, type: octet }
    case 'model': return { name: 'model', cap: MAX_MODEL_BYTES, type: octet, manifest: s.format === 'gltf' ? 'gltf' : undefined }
    case 'structure': return { name: 'structure', cap: MAX_MODEL_BYTES, type: octet }
    case 'splat': return { name: 'splat', cap: MAX_SPLAT_BYTES, type: octet }
    // gzip の中身は展開しないと分からない (構造物、.spz、.svgz)。大きいほうに合わせる
    case 'probe': return { name: 'gzip', cap: MAX_SPLAT_BYTES, type: octet }
    case 'hls': return { name: 'hls', cap: MAX_MANIFEST_BYTES, type: octet, manifest: 'hls' }
    case 'dash': return { name: 'dash', cap: MAX_MANIFEST_BYTES, type: octet, manifest: 'dash' }
    case 'mjpeg': return { name: 'mjpeg', cap: MAX_MEDIA_BYTES, type: octet, stream: true }
    case 'flv': return { name: 'flv', cap: MAX_MEDIA_BYTES, type: 'video/x-flv', stream: true }
    case 'video': return { name: 'video', cap: MAX_MEDIA_BYTES, type: mediaType(s, head), stream: true }
  }
  return null
}

/** 元のサイトの Content-Type (知らせるだけ)。形の正しいものだけ */
export function cleanType(value: string | undefined): string {
  const t = (value ?? '').split(';')[0]!.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9!#$&^_.+-]{0,63}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,63}$/.test(t) ? t : ''
}
