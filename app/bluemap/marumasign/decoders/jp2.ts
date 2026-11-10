// JPEG 2000 (JP2・JPX の箱と、コードストリームそのもの .j2k)。ブラウザーのものは使わない (Node の試験でも動く)。
// 展開は pdf.js の OpenJPEG (wasm。PDF の看板と同じものを /_nuxt/ から読む) に任せる。そのために、絵を 1 枚だけ置いた PDF に包む
// (透明度・色の一覧・sYCC・色ごとの縮小 (subsampling) も pdf.js が扱う)

/** コードストリームそのもの (FF 4F FF 51) か */
export function isJ2kCodestream(b: Uint8Array): boolean {
  return b.length >= 4 && b[0] === 0xFF && b[1] === 0x4F && b[2] === 0xFF && b[3] === 0x51
}

/** JP2 の箱で始まるか */
export function isJp2Box(b: Uint8Array): boolean {
  return b.length >= 12 && b[0] === 0 && b[1] === 0 && b[2] === 0 && b[3] === 0x0C && b[4] === 0x6A && b[5] === 0x50 && b[6] === 0x20 && b[7] === 0x20
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0
}

/** コードストリームの SIZ から大きさ */
function sizSize(b: Uint8Array, p: number): { width: number, height: number } | null {
  if (p + 24 > b.length || b[p] !== 0xFF || b[p + 1] !== 0x4F || b[p + 2] !== 0xFF || b[p + 3] !== 0x51) return null
  const x = u32(b, p + 8), y = u32(b, p + 12), xo = u32(b, p + 16), yo = u32(b, p + 20)
  return x > xo && y > yo ? { width: x - xo, height: y - yo } : null
}

/**
 * 透明度の入れ方 (JP2 の cdef の箱。1 は透明度、2 は色に透明度を掛けてある)。なければ 0 (コードストリームは分からないので 1)
 */
export function jp2Alpha(b: Uint8Array): 0 | 1 | 2 {
  if (isJ2kCodestream(b)) return 1
  let found: 0 | 1 | 2 = 0
  const walk = (start: number, end: number): void => {
    let p = start
    while (p + 8 <= end) {
      const size = u32(b, p)
      const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!)
      if (size < 8 || p + size > end) return
      if (type === 'jp2h') walk(p + 8, p + size)
      else if (type === 'cdef' && p + 10 <= end) {
        const n = (b[p + 8]! << 8) | b[p + 9]!
        for (let i = 0; i < n && p + 10 + i * 6 + 6 <= p + size; i++) {
          const t = (b[p + 12 + i * 6]! << 8) | b[p + 13 + i * 6]!
          if (t === 1 && found === 0) found = 1
          else if (t === 2) found = 2
        }
      }
      else if (type === 'jp2c') return
      p += size
    }
  }
  if (isJp2Box(b)) walk(0, b.length)
  return found
}

/** 絵の大きさ (JP2 は ihdr、コードストリームは SIZ)。分からなければ null */
export function jp2Size(b: Uint8Array): { width: number, height: number } | null {
  if (isJ2kCodestream(b)) return sizSize(b, 0)
  if (!isJp2Box(b)) return null
  // 箱を順に見て、jp2h の ihdr か、最初の jp2c のコードストリーム
  const walk = (start: number, end: number): { width: number, height: number } | null => {
    let p = start
    while (p + 8 <= end) {
      let size = u32(b, p)
      const type = String.fromCharCode(b[p + 4]!, b[p + 5]!, b[p + 6]!, b[p + 7]!)
      let body = p + 8
      if (size === 1) {
        if (p + 16 > end) return null
        size = u32(b, p + 8) * 4294967296 + u32(b, p + 12)
        body = p + 16
      }
      else if (size === 0) size = end - p
      if (size < body - p) return null
      const stop = Math.min(end, p + size)
      if (type === 'jp2h') {
        const r = walk(body, stop)
        if (r) return r
      }
      else if (type === 'ihdr' && body + 8 <= stop) {
        const height = u32(b, body), width = u32(b, body + 4)
        if (width > 0 && height > 0) return { width, height }
      }
      else if (type === 'jp2c') return sizSize(b, body)
      p += size
    }
    return null
  }
  return walk(0, b.length)
}

/**
 * 絵 (JPX のストリーム) を 1 枚だけ、ページいっぱいに置いた PDF
 * @param alpha 透明度の入れ方 (jp2Alpha)。pdf.js は PDF の SMaskInData で、透明度を使うかと、色に掛けてあるかを決める
 */
export function jpxPdf(jpx: Uint8Array, width: number, height: number, alpha: 0 | 1 | 2 = 1): Uint8Array {
  const enc = new TextEncoder()
  const parts: Uint8Array[] = []
  const offsets: number[] = []
  let length = 0
  const push = (p: Uint8Array | string): void => {
    const bytes = typeof p === 'string' ? enc.encode(p) : p
    parts.push(bytes)
    length += bytes.length
  }
  const object = (n: number, body: string | (Uint8Array | string)[]): void => {
    offsets[n] = length
    push(`${n} 0 obj\n`)
    if (typeof body === 'string') push(body)
    else for (const b of body) push(b)
    push('\nendobj\n')
  }
  const content = `q ${width} 0 0 ${height} 0 0 cm /Im0 Do Q`
  push('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n')
  object(1, '<< /Type /Catalog /Pages 2 0 R >>')
  object(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>')
  object(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`)
  // SMaskInData 1: JPEG 2000 の中の透明度を使う (2 は色に透明度を掛けてあるもの)
  object(4, [`<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height} /Filter /JPXDecode /SMaskInData ${alpha || 1} /Length ${jpx.length} >>\nstream\n`, jpx, '\nendstream'])
  object(5, `<< /Length ${content.length} >>\nstream\n${content}\nendstream`)
  const xref = length
  let table = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) table += String(offsets[i]).padStart(10, '0') + ' 00000 n \n'
  push(table + `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`)
  const out = new Uint8Array(length)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}
