// PNG を RGBA の並びにする (Minecraft のテクスチャとプレイヤーのスキン)。
// ブラウザーの画像の読み込み (canvas) は、半透明のピクセルの色を変えてしまう (乗算済みのアルファ) ので、自分で読む。
// 展開は DecompressionStream (Worker と Node の両方にある)。ここはほかに何も import しない

export interface DecodedPng {
  width: number
  height: number
  /** RGBA (1 ピクセル 4 バイト、上の行から) */
  pixels: Uint8Array
}

const MAX_SIDE = 8192
const MAX_PIXELS = 16 * 1024 * 1024

async function inflate(data: Uint8Array, max: number): Promise<Uint8Array> {
  const reader = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream('deflate')).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    total += r.value.length
    if (total > max) {
      await reader.cancel()
      throw new Error('png: too large')
    }
    chunks.push(r.value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

/** PNG を読む。PNG でなければ、または壊れていれば失敗 */
export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  const sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]
  for (let i = 0; i < 8; i++) if (bytes[i] !== sig[i]) throw new Error('png: not a png')
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let p = 8
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0
  let palette: Uint8Array | null = null
  let trns: Uint8Array | null = null
  const idat: Uint8Array[] = []
  let idatLength = 0
  while (p + 8 <= bytes.length) {
    const length = dv.getUint32(p)
    const type = String.fromCharCode(bytes[p + 4]!, bytes[p + 5]!, bytes[p + 6]!, bytes[p + 7]!)
    const start = p + 8
    if (start + length > bytes.length) throw new Error('png: truncated')
    const body = bytes.subarray(start, start + length)
    if (type === 'IHDR') {
      width = dv.getUint32(start)
      height = dv.getUint32(start + 4)
      depth = body[8]!
      color = body[9]!
      interlace = body[12]!
    }
    else if (type === 'PLTE') palette = body
    else if (type === 'tRNS') trns = body
    else if (type === 'IDAT') {
      idat.push(body)
      idatLength += length
    }
    else if (type === 'IEND') break
    p = start + length + 4
  }
  if (!width || !height || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_PIXELS) throw new Error('png: bad size')
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 3 ? 1 : color === 4 ? 2 : color === 6 ? 4 : 0
  if (!channels || ![1, 2, 4, 8, 16].includes(depth)) throw new Error('png: unsupported format')
  if (color === 3 && !palette) throw new Error('png: no palette')
  const joined = new Uint8Array(idatLength)
  let at = 0
  for (const c of idat) {
    joined.set(c, at)
    at += c.length
  }
  const bitsPerPixel = channels * depth
  const bpp = Math.max(1, bitsPerPixel >> 3)
  // 展開したあとの大きさの見積もり (行ごとのフィルターの 1 バイトを含む。インターレースの分は少し多め)
  const expected = (Math.ceil(width * bitsPerPixel / 8) + 1) * height * (interlace ? 2 : 1) + 1024
  const raw = await inflate(joined, expected)
  const out = new Uint8Array(width * height * 4)

  const passes = interlace
    ? [[0, 0, 8, 8], [4, 0, 8, 8], [0, 4, 4, 8], [2, 0, 4, 4], [0, 2, 2, 4], [1, 0, 2, 2], [0, 1, 1, 2]]
    : [[0, 0, 1, 1]]
  let offset = 0
  for (const [x0, y0, dx, dy] of passes as [number, number, number, number][]) {
    const pw = Math.ceil((width - x0) / dx), ph = Math.ceil((height - y0) / dy)
    if (pw <= 0 || ph <= 0) continue
    const stride = Math.ceil(pw * bitsPerPixel / 8)
    let prev = new Uint8Array(stride)
    let line = new Uint8Array(stride)
    for (let y = 0; y < ph; y++) {
      if (offset + 1 + stride > raw.length) throw new Error('png: truncated data')
      const filter = raw[offset]!
      const src = raw.subarray(offset + 1, offset + 1 + stride)
      offset += 1 + stride
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp]! : 0
        const b = prev[i]!
        const c = i >= bpp ? prev[i - bpp]! : 0
        let v = src[i]!
        switch (filter) {
          case 1: v += a; break
          case 2: v += b; break
          case 3: v += (a + b) >> 1; break
          case 4: {
            const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c)
            v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c
            break
          }
        }
        line[i] = v & 255
      }
      const yy = y0 + y * dy
      for (let x = 0; x < pw; x++) {
        const o = ((yy * width) + x0 + x * dx) * 4
        let r: number, g: number, bl: number, al = 255
        const sample = (index: number): number => {
          if (depth === 8) return line[index]!
          if (depth === 16) return line[index * 2]!
          const bit = index * depth
          const byte = line[bit >> 3]!
          const v = (byte >> (8 - depth - (bit & 7))) & ((1 << depth) - 1)
          return v
        }
        if (color === 3) {
          const idx = sample(x)
          r = palette![idx * 3] ?? 0
          g = palette![idx * 3 + 1] ?? 0
          bl = palette![idx * 3 + 2] ?? 0
          al = trns && idx < trns.length ? trns[idx]! : 255
        }
        else if (color === 0 || color === 4) {
          let v = sample(x * channels)
          if (depth < 8) v = Math.round(v * 255 / ((1 << depth) - 1))
          r = g = bl = v
          if (color === 4) al = sample(x * channels + 1)
          else if (trns && trns.length >= 2) {
            const t = depth === 16 ? (trns[0]! << 8 | trns[1]!) : trns[1]!
            const raw16 = depth === 16 ? (line[x * 2]! << 8 | line[x * 2 + 1]!) : sample(x)
            if (raw16 === t) al = 0
          }
        }
        else {
          r = sample(x * channels)
          g = sample(x * channels + 1)
          bl = sample(x * channels + 2)
          if (color === 6) al = sample(x * channels + 3)
          else if (trns && trns.length >= 6 && depth === 8 && r === trns[1] && g === trns[3] && bl === trns[5]) al = 0
        }
        out[o] = r
        out[o + 1] = g
        out[o + 2] = bl
        out[o + 3] = al
      }
      const t = prev
      prev = line
      line = t
    }
  }
  return { width, height, pixels: out }
}
