// MarumaSign 本体が FFmpeg に読ませる形式のうち、自前で読めるもの (DPX、IFF の ILBM・PBM・ACBM、XWD、PGX)。
// 読み方と見え方は FFmpeg (dpx.c, iff.c, xwddec.c, pgxdec.c) に合わせる。ブラウザーのものは使わない (Node の試験でも動く)
import { allocate, type Pixels } from './raster.ts'

function need(b: Uint8Array, end: number): void {
  if (end > b.length) throw new Error('truncated')
}

function clamp8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v)
}

// ---------------------------------------------------------------- DPX

/** DPX の先頭 ("SDPX" はビッグエンディアン、"XPDS" はリトルエンディアン) */
export function looksLikeDpx(b: Uint8Array): boolean {
  return b.length >= 4 && ((b[0] === 0x53 && b[1] === 0x44 && b[2] === 0x50 && b[3] === 0x58) || (b[0] === 0x58 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x53))
}

/**
 * DPX (映画の 1 コマ)。1 つ目の要素の 8・10・12・16 ビットの整数と 32 ビットの浮動小数点、
 * 明るさ・RGB・RGBA・ABGR・YCbCr (4:2:2, 4:4:4) に対応する。値は変換せずそのまま (対数の値も FFmpeg と同じく、そのまま描く)
 */
export function decodeDpx(b: Uint8Array): Pixels {
  if (!looksLikeDpx(b)) throw new Error('not a dpx image')
  need(b, 808)
  const big = b[0] === 0x53
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const u32 = (p: number): number => dv.getUint32(p, !big)
  const u16 = (p: number): number => dv.getUint16(p, !big)
  const offset = u32(4)
  const w = u32(772), h = u32(776)
  const descriptor = b[800]!, colorSpec = b[802]!, bits = b[803]!
  const packing = u16(804), encoding = u16(806)
  if (encoding) throw new Error('unsupported dpx encoding (rle)')
  const px = allocate(w, h)
  let elements: number, yuv = false
  switch (descriptor) {
    case 1: case 2: case 3: case 4: case 6: elements = 1; break
    case 50: elements = 3; break
    case 51: case 52: elements = 4; break
    case 100: elements = 2; yuv = true; break
    case 102: elements = 3; yuv = true; break
    case 103: elements = 4; yuv = true; break
    default: throw new Error('unsupported dpx descriptor: ' + descriptor)
  }
  const n = w * elements
  let stride: number
  switch (bits) {
    case 8: stride = n; break
    case 10:
      if (!packing) throw new Error('dpx 10-bit needs packing')
      stride = Math.floor((n + 2) / 3) * 4
      break
    case 12:
      stride = packing ? n * 2 : Math.ceil(n * 3 / 8) * 8 / 2
      break
    case 16: stride = n * 2; break
    case 32: stride = n * 4; break
    default: throw new Error('unsupported dpx bit depth: ' + bits)
  }
  // 行を 4 バイトにそろえる (そろえるとファイルに収まらないときは、そろえない。FFmpeg と同じ)
  let pitch = Math.ceil(stride / 4) * 4
  if (offset + pitch * h > b.length) pitch = stride
  need(b, offset + pitch * (h - 1) + stride)
  const max = bits === 32 ? 1 : (1 << bits) - 1
  const row = new Float64Array(n)
  for (let y = 0; y < h; y++) {
    const start = offset + y * pitch
    // 1 行の値を、ファイルの並び (R, G, B, A など) のまま読む
    if (bits === 8) for (let i = 0; i < n; i++) row[i] = b[start + i]!
    else if (bits === 16) for (let i = 0; i < n; i++) row[i] = u16(start + i * 2)
    else if (bits === 32) for (let i = 0; i < n; i++) row[i] = dv.getFloat32(start + i * 4, !big)
    else if (bits === 10) {
      // 32 ビットに 3 つ。packing 1 は上に詰めて下の 2 ビットが余り、2 は下に詰める。1 つだけの (明るさの) ものは下の値から並ぶ
      const shift = packing === 1 ? 2 : 0
      for (let i = 0; i < n; i++) {
        const word = u32(start + Math.floor(i / 3) * 4)
        const k = i % 3
        row[i] = elements === 1 ? (word >>> (shift + k * 10)) & 0x3FF : (word >>> (shift + (2 - k) * 10)) & 0x3FF
      }
    }
    else if (packing) {
      // 12 ビットを 16 ビットに 1 つ。packing 1 は上に詰める
      for (let i = 0; i < n; i++) row[i] = (u16(start + i * 2) >> (packing === 1 ? 4 : 0)) & 0xFFF
    }
    else {
      // 12 ビットを隙間なく、32 ビットの下の位から並べる
      for (let i = 0; i < n; i++) {
        const bit = i * 12
        const word = Math.floor(bit / 32), sh = bit % 32
        let v = u32(start + word * 4) >>> sh
        if (sh > 20) v |= u32(start + word * 4 + 4) << (32 - sh)
        row[i] = v & 0xFFF
      }
    }
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      let r: number, g: number, bl: number, a = max
      if (yuv) {
        let Y: number, cb: number, cr: number
        if (elements === 2) {
          // Cb Y0 Cr Y1 の組
          const pair = x & ~1
          cb = row[pair * 2]!
          cr = row[pair * 2 + 2] ?? cb
          Y = row[x * 2 + 1]!
        }
        else {
          cb = row[x * elements]!
          Y = row[x * elements + 1]!
          cr = row[x * elements + 2]!
          if (elements === 4) a = row[x * 4 + 3]!
        }
        const s = max / 255
        const rgb = ycbcr(Y / s, cb / s, cr / s, colorSpec === 6)
        r = rgb[0] * s
        g = rgb[1] * s
        bl = rgb[2] * s
      }
      else if (elements === 1) {
        r = g = bl = row[x]!
      }
      else if (descriptor === 52) {
        a = row[x * 4]!
        bl = row[x * 4 + 1]!
        g = row[x * 4 + 2]!
        r = row[x * 4 + 3]!
      }
      else {
        r = row[x * elements]!
        g = row[x * elements + 1]!
        bl = row[x * elements + 2]!
        if (elements === 4) a = row[x * 4 + 3]!
      }
      px.data[o] = clamp8(r * 255 / max)
      px.data[o + 1] = clamp8(g * 255 / max)
      px.data[o + 2] = clamp8(bl * 255 / max)
      px.data[o + 3] = clamp8(a * 255 / max)
    }
  }
  return px
}

/** 映像の範囲 (16 - 235) の YCbCr を RGB (0 - 255) にする */
function ycbcr(y: number, cb: number, cr: number, bt709: boolean): [number, number, number] {
  const yy = (y - 16) * 255 / 219, u = (cb - 128) * 255 / 224, v = (cr - 128) * 255 / 224
  if (bt709) return [yy + 1.5748 * v, yy - 0.1873 * u - 0.4681 * v, yy + 1.8556 * u]
  return [yy + 1.402 * v, yy - 0.344136 * u - 0.714136 * v, yy + 1.772 * u]
}

// ---------------------------------------------------------------- IFF (ILBM, PBM, ACBM)

function fourcc(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!)
}

/** IFF の画像 (FORM の ILBM・PBM・ACBM) か */
export function looksLikeIlbm(b: Uint8Array): boolean {
  if (b.length < 12 || fourcc(b, 0) !== 'FORM') return false
  const t = fourcc(b, 8)
  return t === 'ILBM' || t === 'PBM ' || t === 'ACBM'
}

/** ByteRun1 (PackBits) を expected バイトまで展開する */
function byteRun1(src: Uint8Array, expected: number): Uint8Array {
  const out = new Uint8Array(expected)
  let p = 0, o = 0
  while (o < expected && p < src.length) {
    const n = (src[p++]! << 24) >> 24
    if (n >= 0) {
      const end = Math.min(expected - o, n + 1, src.length - p)
      out.set(src.subarray(p, p + end), o)
      p += n + 1
      o += end
    }
    else if (n !== -128) {
      const v = src[p++] ?? 0
      const end = Math.min(expected, o + 1 - n)
      out.fill(v, o, end)
      o = end
    }
  }
  return out
}

/**
 * Amiga の IFF の画像。ILBM (面ごと) と PBM (1 画素 1 バイト) と ACBM (面を続けて並べたもの)、
 * 1 - 8 面の色の一覧 (EHB を含む)、HAM6・HAM8、24・32 面のフルカラー、マスクの面と透明色、ByteRun1 の圧縮に対応する
 */
export function decodeIlbm(b: Uint8Array): Pixels {
  if (!looksLikeIlbm(b)) throw new Error('not an iff image')
  const type = fourcc(b, 8)
  const end = Math.min(b.length, 8 + ((b[4]! << 24 | b[5]! << 16 | b[6]! << 8 | b[7]!) >>> 0))
  let bmhd: Uint8Array | null = null
  let cmap: Uint8Array | null = null
  let body: Uint8Array | null = null
  let camg = 0
  for (let p = 12; p + 8 <= end;) {
    const id = fourcc(b, p)
    const len = (b[p + 4]! << 24 | b[p + 5]! << 16 | b[p + 6]! << 8 | b[p + 7]!) >>> 0
    const data = b.subarray(p + 8, Math.min(end, p + 8 + len))
    if (id === 'BMHD') bmhd = data
    else if (id === 'CMAP') cmap = data
    else if (id === 'CAMG' && data.length >= 4) camg = (data[0]! << 24 | data[1]! << 16 | data[2]! << 8 | data[3]!) >>> 0
    else if (id === 'BODY' || id === 'ABIT') body = data
    p += 8 + len + (len & 1)
  }
  if (!bmhd || bmhd.length < 20 || !body) throw new Error('iff has no image')
  const w = (bmhd[0]! << 8) | bmhd[1]!, h = (bmhd[2]! << 8) | bmhd[3]!
  const planes = bmhd[8]!, masking = bmhd[9]!, compression = bmhd[10]!
  const transparent = (bmhd[12]! << 8) | bmhd[13]!
  const px = allocate(w, h)
  if (planes < 1 || (planes > 8 && planes !== 24 && planes !== 32)) throw new Error('unsupported iff planes: ' + planes)
  if (compression > 1) throw new Error('unsupported iff compression: ' + compression)
  const ham = (camg & 0x800) !== 0 && (planes === 6 || planes === 8)
  const ehb = (camg & 0x80) !== 0
  const hasMask = masking === 1 && type === 'ILBM'

  // 色の一覧 (なければ灰色の段階)
  const colors = planes <= 8 ? 1 << planes : 0
  const palette = new Uint8Array(Math.max(colors, 64) * 4)
  if (colors) {
    const count = cmap ? Math.min(Math.floor(cmap.length / 3), 256) : 0
    for (let i = 0; i < Math.max(colors, 64); i++) {
      if (cmap && i < count) {
        palette[i * 4] = cmap[i * 3]!
        palette[i * 4 + 1] = cmap[i * 3 + 1]!
        palette[i * 4 + 2] = cmap[i * 3 + 2]!
      }
      else if (!cmap) {
        // 色の一覧がなければ灰色の段階 (FFmpeg と同じ計算)
        palette[i * 4] = palette[i * 4 + 1] = palette[i * 4 + 2] = Math.min(255, (i * 255) >> planes)
      }
      palette[i * 4 + 3] = 255
    }
    // EHB: 後ろの 32 色は、前の 32 色の半分の明るさ
    if (ehb && !ham && planes === 6) {
      for (let i = 0; i < 32; i++) for (let c = 0; c < 3; c++) palette[(i + 32) * 4 + c] = palette[i * 4 + c]! >> 1
    }
    if (masking === 2 && transparent < colors && !ham) palette[transparent * 4 + 3] = 0
  }

  if (type === 'PBM ') {
    // 1 画素 1 バイト (行は偶数のバイトにそろえる)
    const rowBytes = w + (w & 1)
    const data = compression ? byteRun1(body, rowBytes * h) : body
    need(data, rowBytes * (h - 1) + w)
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = data[y * rowBytes + x]!
        px.data.set(palette.subarray(i * 4, i * 4 + 4), (y * w + x) * 4)
      }
    }
    return px
  }

  const planeBytes = ((w + 15) >> 4) * 2
  const rowPlanes = planes + (hasMask ? 1 : 0)
  let data: Uint8Array
  // その面のその行の始まり
  let at: (plane: number, y: number) => number
  if (type === 'ACBM') {
    // 面ごとに、すべての行が続く (圧縮なし)
    data = body
    need(data, planeBytes * h * planes)
    at = (plane, y) => (plane * h + y) * planeBytes
  }
  else {
    data = compression ? byteRun1(body, planeBytes * rowPlanes * h) : body
    need(data, planeBytes * rowPlanes * h)
    at = (plane, y) => (y * rowPlanes + plane) * planeBytes
  }
  const bit = (plane: number, y: number, x: number): number => (data[at(plane, y) + (x >> 3)]! >> (7 - (x & 7))) & 1
  for (let y = 0; y < h; y++) {
    // HAM は行ごとに、背景の色 (0 番) から始める
    let r = palette[0]!, g = palette[1]!, bl = palette[2]!
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      let v = 0
      if (planes <= 8) {
        for (let p = 0; p < planes; p++) v |= bit(p, y, x) << p
      }
      if (planes === 24 || planes === 32) {
        for (let c = 0; c < planes / 8; c++) {
          let comp = 0
          for (let p = 0; p < 8; p++) comp |= bit(c * 8 + p, y, x) << p
          px.data[o + c] = comp
        }
        if (planes === 24) px.data[o + 3] = 255
      }
      else if (ham) {
        const valueBits = planes - 2
        const control = v >> valueBits, value = v & ((1 << valueBits) - 1)
        // 値を 8 ビットにする (HAM6 は 4 ビット、HAM8 は 6 ビット)
        const full = valueBits === 4 ? value * 17 : (value << 2) | (value >> 4)
        if (control === 0) {
          r = palette[value * 4]!
          g = palette[value * 4 + 1]!
          bl = palette[value * 4 + 2]!
        }
        else if (control === 1) bl = full
        else if (control === 2) r = full
        else g = full
        px.data[o] = r
        px.data[o + 1] = g
        px.data[o + 2] = bl
        px.data[o + 3] = 255
      }
      else {
        px.data.set(palette.subarray(v * 4, v * 4 + 4), o)
      }
      if (hasMask) px.data[o + 3] = bit(planes, y, x) ? px.data[o + 3]! : 0
    }
  }
  return px
}

// ---------------------------------------------------------------- XWD

/**
 * X Window System の画面の写し (X11 の XWD、版 7)。ZPixmap の 1・8・16・24・32 ビットと XYBitmap、
 * 灰色・色の一覧 (PseudoColor など)・TrueColor (マスクで並びを決める) に対応する
 */
export function decodeXwd(b: Uint8Array): Pixels {
  need(b, 100)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const f = (i: number): number => dv.getUint32(i * 4, false)
  const headerSize = f(0), version = f(1)
  if (version !== 7 || headerSize < 100 || headerSize > b.length) throw new Error('not an xwd image')
  const format = f(2), depth = f(3), w = f(4), h = f(5)
  const byteOrder = f(7), bitOrder = f(9), bpp = f(11), lineBytes = f(12), visual = f(13)
  const masks = [f(14), f(15), f(16)]
  const ncolors = f(19)
  if (byteOrder > 1 || bitOrder > 1 || ncolors > 65536) throw new Error('bad xwd header')
  const px = allocate(w, h)
  if (format !== 2 && !(format === 0 && bpp === 1)) throw new Error('unsupported xwd pixmap format: ' + format)
  if (![1, 8, 16, 24, 32].includes(bpp)) throw new Error('unsupported xwd bits per pixel: ' + bpp)
  if (lineBytes < Math.ceil(w * bpp / 8)) throw new Error('bad xwd line size')
  const cmapAt = headerSize
  const start = cmapAt + ncolors * 12
  need(b, start + lineBytes * (h - 1) + Math.ceil(w * bpp / 8))
  // 色の一覧 (番号の順。それぞれ 16 ビットの赤・緑・青の上の 8 ビット)
  const palette = new Uint8Array(256 * 3)
  for (let i = 0; i < Math.min(ncolors, 256); i++) {
    const e = cmapAt + i * 12
    palette[i * 3] = b[e + 4]!
    palette[i * 3 + 1] = b[e + 6]!
    palette[i * 3 + 2] = b[e + 8]!
  }
  const gray = visual <= 1
  const trueColor = visual >= 4
  const shift = (m: number): number => {
    if (!m) return 0
    let s = 0
    while (((m >>> s) & 1) === 0) s++
    return s
  }
  const sh = masks.map(shift)
  const width = masks.map((m, i) => {
    let n = 0
    for (let v = m >>> sh[i]!; v & 1; v >>>= 1) n++
    return n
  })
  // n ビットの値を 8 ビットにする (FFmpeg と同じく、上のビットを下に繰り返す)
  const to8 = (v: number, n: number): number => {
    if (n >= 8) return v >>> (n - 8)
    let r = 0
    for (let filled = 0; filled < 8; filled += n) r = (r << n) | v
    return (r >>> (Math.ceil(8 / n) * n - 8)) & 255
  }
  // 32 ビットのものは、色のマスクの外の 8 ビットが透明度 (FFmpeg と同じ)。
  // ただし X のサーバーの写しは、そこがすべて 0 (使っていない) ことが多いので、そのときは不透明にする
  let alphaMask = trueColor && bpp === 32 ? (~(masks[0]! | masks[1]! | masks[2]!)) >>> 0 : 0
  if (alphaMask) {
    let any = false
    for (let y = 0; y < h && !any; y++) {
      for (let x = 0; x < w; x++) {
        const p = start + y * lineBytes + x * 4
        const v = byteOrder ? ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0 : ((b[p + 3]! << 24) | (b[p + 2]! << 16) | (b[p + 1]! << 8) | b[p]!) >>> 0
        if ((v & alphaMask) !== 0) {
          any = true
          break
        }
      }
    }
    if (!any) alphaMask = 0
  }
  const alphaShift = shift(alphaMask)
  for (let y = 0; y < h; y++) {
    const row = start + y * lineBytes
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4
      let v: number
      if (bpp === 1) {
        const byte = b[row + (x >> 3)]!
        v = bitOrder ? (byte >> (7 - (x & 7))) & 1 : (byte >> (x & 7)) & 1
      }
      else if (bpp === 8) v = b[row + x]!
      else {
        const n = bpp >> 3
        const p = row + x * n
        v = 0
        for (let k = 0; k < n; k++) v = v * 256 + b[byteOrder ? p + k : p + n - 1 - k]!
      }
      let r: number, g: number, bl: number, a = 255
      if (trueColor && bpp >= 8) {
        const c = [0, 1, 2].map(i => width[i] ? to8(((v & masks[i]!) >>> 0) >>> sh[i]!, width[i]!) : 0)
        r = c[0]!
        g = c[1]!
        bl = c[2]!
        if (alphaMask) a = (((v & alphaMask) >>> 0) >>> alphaShift) & 255
      }
      else if (bpp === 1 && (gray || ncolors < 2)) {
        // 白黒 (0 が白)
        r = g = bl = v ? 0 : 255
      }
      else if (gray && ncolors === 0) {
        r = g = bl = depth < 8 ? Math.round(v * 255 / ((1 << depth) - 1)) : v & 255
      }
      else {
        const i = Math.min(v, 255)
        r = palette[i * 3]!
        g = palette[i * 3 + 1]!
        bl = palette[i * 3 + 2]!
      }
      px.data[o] = r
      px.data[o + 1] = g
      px.data[o + 2] = bl
      px.data[o + 3] = a
    }
  }
  return px
}

// ---------------------------------------------------------------- PGX

/** PGX (JPEG 2000 の試験の灰色の画像)。"PG ML" (ビッグエンディアン) と "PG LM"、符号、1 - 16 ビット */
export function decodePgx(b: Uint8Array): Pixels {
  need(b, 12)
  const text = String.fromCharCode(...b.subarray(0, Math.min(b.length, 64)))
  const m = /^PG[ \t]+(ML|LM)[ \t]*([+-]?)[ \t]*(\d+)[ \t]+(\d+)[ \t]+(\d+)[ \t]*\r?\n?/.exec(text)
  if (!m) throw new Error('not a pgx image')
  const little = m[1] === 'LM', signed = m[2] === '-'
  const depth = Number(m[3]), w = Number(m[4]), h = Number(m[5])
  if (depth < 1 || depth > 16) throw new Error('unsupported pgx depth: ' + depth)
  const px = allocate(w, h)
  const start = m[0].length
  const bytes = depth <= 8 ? 1 : 2
  need(b, start + w * h * bytes)
  for (let i = 0; i < w * h; i++) {
    let v: number
    if (bytes === 1) {
      // FFmpeg と同じく、上の位に寄せてから符号を直す
      v = ((b[start + i]! << (8 - depth)) & 0xFF) ^ (signed ? 0x80 : 0)
    }
    else {
      const p = start + i * 2
      const raw = little ? b[p]! | (b[p + 1]! << 8) : (b[p]! << 8) | b[p + 1]!
      v = (((raw << (16 - depth)) & 0xFFFF) ^ (signed ? 0x8000 : 0)) >> 8
    }
    px.data[i * 4] = px.data[i * 4 + 1] = px.data[i * 4 + 2] = v
    px.data[i * 4 + 3] = 255
  }
  return px
}
