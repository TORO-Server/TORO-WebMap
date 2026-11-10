// アニメーションの WebP の中身 (RIFF の ANIM と ANMF の塊) を読む。ブラウザーのものは使わない (Node の試験でも動く)。
// 1 コマずつ、それだけの WebP に包み直して返す (ブラウザーに 1 枚の絵として読ませる。animation.ts)

export interface WebpFrame {
  x: number
  y: number
  width: number
  height: number
  /** 表示する時間 (ミリ秒。MarumaSign 本体と同じく、0 は 100、20 より短いものは 20) */
  delay: number
  /** 重ねる (false なら、その範囲を置き換える) */
  blend: boolean
  /** 表示したあとに、その範囲を透明に戻す */
  dispose: boolean
  /** このコマだけの WebP ファイル */
  file: Uint8Array
}

export interface WebpAnimation {
  width: number
  height: number
  /** 繰り返す回数 (0 はずっと) */
  loops: number
  frames: WebpFrame[]
}

function u24(b: Uint8Array, p: number): number {
  return b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16)
}

function u32(b: Uint8Array, p: number): number {
  return (b[p]! | (b[p + 1]! << 8) | (b[p + 2]! << 16) | (b[p + 3]! << 24)) >>> 0
}

function id(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!)
}

function header(fourcc: string, length: number): Uint8Array {
  const h = new Uint8Array(8)
  for (let i = 0; i < 4; i++) h[i] = fourcc.charCodeAt(i)
  h[4] = length & 255
  h[5] = (length >> 8) & 255
  h[6] = (length >> 16) & 255
  h[7] = (length >>> 24) & 255
  return h
}

function join(parts: Uint8Array[]): Uint8Array {
  let n = 0
  for (const p of parts) n += p.length
  const out = new Uint8Array(n)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** 塊の並び (ALPH と VP8、または VP8L) を、それだけの WebP ファイルにする */
function wrap(chunks: Uint8Array[], width: number, height: number, alpha: boolean): Uint8Array {
  const parts: Uint8Array[] = []
  if (alpha) {
    // 透明度が別の塊 (ALPH) にあるときは、拡張形式 (VP8X) にする
    const x = new Uint8Array(10)
    x[0] = 0x10
    x[4] = (width - 1) & 255
    x[5] = ((width - 1) >> 8) & 255
    x[6] = ((width - 1) >> 16) & 255
    x[7] = (height - 1) & 255
    x[8] = ((height - 1) >> 8) & 255
    x[9] = ((height - 1) >> 16) & 255
    parts.push(header('VP8X', 10), x)
  }
  parts.push(...chunks)
  const body = join(parts)
  const riff = header('RIFF', body.length + 4)
  return join([riff, new Uint8Array([0x57, 0x45, 0x42, 0x50]), body])
}

/**
 * アニメーションの WebP を読む。アニメーションでなければ null。
 * @param maxFrames 読むコマの数の上限
 */
export function parseWebpAnimation(b: Uint8Array, maxFrames: number): WebpAnimation | null {
  if (b.length < 30 || id(b, 0) !== 'RIFF' || id(b, 8) !== 'WEBP' || id(b, 12) !== 'VP8X') return null
  if ((b[20]! & 0x02) === 0) return null
  const end = Math.min(b.length, 8 + u32(b, 4))
  const width = 1 + u24(b, 24), height = 1 + u24(b, 27)
  let loops = 0
  const frames: WebpFrame[] = []
  let p = 12 + 8 + u32(b, 16)
  p += p & 1
  while (p + 8 <= end && frames.length < maxFrames) {
    const type = id(b, p)
    const len = u32(b, p + 4)
    const start = p + 8
    const stop = Math.min(end, start + len)
    if (type === 'ANIM' && len >= 6) {
      loops = b[start + 4]! | (b[start + 5]! << 8)
    }
    else if (type === 'ANMF' && len >= 16) {
      const x = 2 * u24(b, start), y = 2 * u24(b, start + 3)
      const fw = 1 + u24(b, start + 6), fh = 1 + u24(b, start + 9)
      const duration = u24(b, start + 12)
      const flags = b[start + 15]!
      if (x + fw > width || y + fh > height) throw new Error('webp frame is outside the canvas')
      // コマの中の塊 (ALPH と VP8、または VP8L)
      const chunks: Uint8Array[] = []
      let alpha = false
      for (let q = start + 16; q + 8 <= stop;) {
        const t = id(b, q)
        const l = u32(b, q + 4)
        const whole = b.subarray(q, Math.min(stop, q + 8 + l + (l & 1)))
        if (t === 'ALPH') {
          alpha = true
          chunks.push(whole)
        }
        else if (t === 'VP8 ' || t === 'VP8L') {
          chunks.push(whole)
          break
        }
        q += 8 + l + (l & 1)
      }
      if (chunks.length) {
        frames.push({
          x, y, width: fw, height: fh,
          delay: duration === 0 ? 100 : Math.max(duration, 20),
          blend: (flags & 0x02) === 0,
          dispose: (flags & 0x01) !== 0,
          file: wrap(chunks, fw, fh, alpha),
        })
      }
    }
    p = start + len + (len & 1)
  }
  if (frames.length === 0) return null
  return { width, height, loops, frames }
}
