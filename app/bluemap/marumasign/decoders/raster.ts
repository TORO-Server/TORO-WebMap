// ブラウザーが読めない画像の形式を、自前でピクセルにする (MarumaSign 本体の image/format/ と同じ形式)
// どれも RGBA (1 行目が絵の上) を返す。壊れたファイルでも、決まった大きさより多くは確保しない

/** RGBA のピクセル (1 行目が絵の上) */
export interface Pixels {
  width: number
  height: number
  data: Uint8ClampedArray
}

// 一辺と面積の上限 (MarumaSign 本体は 4096 まで縮めて読む。元の大きさはこれまで受け付ける)。
// 小さなファイルでも大きな絵を表せる形式 (QOI の繰り返しなど) で、メモリを使い切らないようにする (32M ピクセル = 128 MB)
const MAX_SIDE = 8192
const MAX_AREA = 32 * 1024 * 1024

export function allocate(width: number, height: number): Pixels {
  if (!(Number.isInteger(width) && Number.isInteger(height)) || width <= 0 || height <= 0 || width > MAX_SIDE || height > MAX_SIDE || width * height > MAX_AREA) {
    throw new Error('bad size')
  }
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

function need(b: Uint8Array, end: number): void {
  if (end > b.length) throw new Error('truncated')
}

/** 線形の値 (0 - 1 を超えてもよい) を sRGB の 8 ビットにする (MarumaSign 本体の FormatUtil.srgb と同じ考え方) */
export function srgb(v: number): number {
  if (!(v > 0)) return 0
  if (v >= 1) return 255
  return Math.round((v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055) * 255)
}

// ---------------------------------------------------------------- QOI

export function decodeQoi(b: Uint8Array): Pixels {
  need(b, 14)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const px = allocate(dv.getUint32(4), dv.getUint32(8))
  const out = px.data
  const index = new Uint8Array(64 * 4)
  let r = 0, g = 0, bl = 0, a = 255
  let p = 14
  const end = b.length - 8
  for (let o = 0; o < out.length; o += 4) {
    if (p >= end) break
    const c = b[p++]!
    if (c === 0xFE) {
      r = b[p++]!; g = b[p++]!; bl = b[p++]!
    }
    else if (c === 0xFF) {
      r = b[p++]!; g = b[p++]!; bl = b[p++]!; a = b[p++]!
    }
    else if ((c & 0xC0) === 0x00) {
      const i = c * 4
      r = index[i]!; g = index[i + 1]!; bl = index[i + 2]!; a = index[i + 3]!
    }
    else if ((c & 0xC0) === 0x40) {
      r = (r + ((c >> 4) & 3) - 2) & 255
      g = (g + ((c >> 2) & 3) - 2) & 255
      bl = (bl + (c & 3) - 2) & 255
    }
    else if ((c & 0xC0) === 0x80) {
      const d = b[p++]!
      const dg = (c & 0x3F) - 32
      r = (r + dg - 8 + ((d >> 4) & 15)) & 255
      g = (g + dg) & 255
      bl = (bl + dg - 8 + (d & 15)) & 255
    }
    else {
      let run = c & 0x3F
      while (run-- > 0 && o < out.length - 4) {
        out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a
        o += 4
      }
    }
    const i = ((r * 3 + g * 5 + bl * 7 + a * 11) % 64) * 4
    index[i] = r; index[i + 1] = g; index[i + 2] = bl; index[i + 3] = a
    out[o] = r; out[o + 1] = g; out[o + 2] = bl; out[o + 3] = a
  }
  return px
}

// ---------------------------------------------------------------- PSD / PSB (統合した画像)

export function decodePsd(b: Uint8Array): Pixels {
  need(b, 26)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const version = dv.getUint16(4)
  const psb = version === 2
  const channels = dv.getUint16(12)
  const height = dv.getUint32(14), width = dv.getUint32(18)
  const depth = dv.getUint16(22), mode = dv.getUint16(24)
  if (depth !== 1 && depth !== 8 && depth !== 16) throw new Error('unsupported depth')
  const px = allocate(width, height)
  let p = 26
  need(b, p + 4)
  const colorLen = dv.getUint32(p)
  const palette = b.subarray(p + 4, p + 4 + colorLen)
  p += 4 + colorLen
  need(b, p + 4)
  p += 4 + dv.getUint32(p)
  need(b, p + (psb ? 8 : 4))
  const layerLen = psb ? Number(dv.getBigUint64(p)) : dv.getUint32(p)
  p += (psb ? 8 : 4) + layerLen
  need(b, p + 2)
  const compression = dv.getUint16(p)
  p += 2
  const bytesPerRow = depth === 1 ? Math.ceil(width / 8) : width * (depth / 8)
  const planes = Math.min(channels, mode === 4 ? 5 : 4)
  const plane = (i: number): Uint8Array => new Uint8Array(bytesPerRow * height)
  const data: Uint8Array[] = []
  for (let i = 0; i < planes; i++) data.push(plane(i))
  if (compression === 0) {
    for (let c = 0; c < planes; c++) {
      need(b, p + bytesPerRow * height)
      data[c]!.set(b.subarray(p, p + bytesPerRow * height))
      p += bytesPerRow * height
    }
  }
  else if (compression === 1) {
    const countSize = psb ? 4 : 2
    const counts = p
    p += channels * height * countSize
    for (let c = 0; c < channels; c++) {
      for (let y = 0; y < height; y++) {
        const at = counts + (c * height + y) * countSize
        need(b, at + countSize)
        const len = psb ? dv.getUint32(at) : dv.getUint16(at)
        if (c < planes) {
          const row = data[c]!.subarray(y * bytesPerRow, (y + 1) * bytesPerRow)
          let q = p, o = 0
          const end = Math.min(b.length, p + len)
          while (q < end && o < row.length) {
            const n = b[q++]!
            if (n < 128) {
              for (let k = 0; k <= n && q < end && o < row.length; k++) row[o++] = b[q++]!
            }
            else if (n > 128) {
              const v = b[q++]!
              for (let k = 0; k < 257 - n && o < row.length; k++) row[o++] = v
            }
          }
        }
        p += len
      }
    }
  }
  else {
    throw new Error('unsupported compression')
  }
  const out = px.data
  const step = depth === 16 ? 2 : 1
  const at = (c: number, i: number): number => data[c] ? data[c]![i * step]! : 255
  for (let i = 0; i < width * height; i++) {
    const o = i * 4
    switch (mode) {
      case 0: { // Bitmap (1 ビット。1 が黒)
        const y = Math.floor(i / width), x = i % width
        const v = (data[0]![y * bytesPerRow + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255
        out[o] = out[o + 1] = out[o + 2] = v
        out[o + 3] = 255
        break
      }
      case 1: case 8: { // Grayscale, Duotone
        out[o] = out[o + 1] = out[o + 2] = at(0, i)
        out[o + 3] = channels >= 2 ? at(1, i) : 255
        break
      }
      case 2: { // Indexed
        const c = at(0, i)
        out[o] = palette[c] ?? 0
        out[o + 1] = palette[c + 256] ?? 0
        out[o + 2] = palette[c + 512] ?? 0
        out[o + 3] = 255
        break
      }
      case 4: { // CMYK (PSD では値が反転している)
        const k = at(3, i) / 255
        out[o] = at(0, i) * k
        out[o + 1] = at(1, i) * k
        out[o + 2] = at(2, i) * k
        out[o + 3] = channels >= 5 ? at(4, i) : 255
        break
      }
      default: { // RGB (と Lab などは RGB として読む)
        out[o] = at(0, i)
        out[o + 1] = at(1, i)
        out[o + 2] = at(2, i)
        out[o + 3] = channels >= 4 ? at(3, i) : 255
      }
    }
  }
  return px
}

// ---------------------------------------------------------------- PNM (pbm, pgm, ppm, pnm, pam), PFM, farbfeld

/** 空白とコメント (#) を飛ばして、次の語を読む */
function token(b: Uint8Array, pos: { p: number }): string {
  let p = pos.p
  for (;;) {
    while (p < b.length && (b[p] === 0x20 || b[p] === 0x09 || b[p] === 0x0A || b[p] === 0x0D)) p++
    if (b[p] === 0x23) {
      while (p < b.length && b[p] !== 0x0A) p++
      continue
    }
    break
  }
  let s = ''
  while (p < b.length && !(b[p] === 0x20 || b[p] === 0x09 || b[p] === 0x0A || b[p] === 0x0D)) s += String.fromCharCode(b[p++]!)
  pos.p = p
  return s
}

function int(s: string): number {
  if (!/^\d{1,9}$/.test(s)) throw new Error('bad header')
  return Number(s)
}

export function decodePnm(b: Uint8Array): Pixels {
  const kind = b[1]! - 0x30
  const pos = { p: 2 }
  let width: number, height: number, depth: number, maxval: number
  if (kind === 7) {
    width = height = depth = 0
    maxval = 255
    for (;;) {
      const t = token(b, pos)
      if (t === 'ENDHDR' || t === '') break
      if (t === 'WIDTH') width = int(token(b, pos))
      else if (t === 'HEIGHT') height = int(token(b, pos))
      else if (t === 'DEPTH') depth = int(token(b, pos))
      else if (t === 'MAXVAL') maxval = int(token(b, pos))
      else if (t === 'TUPLTYPE') token(b, pos)
    }
  }
  else {
    width = int(token(b, pos))
    height = int(token(b, pos))
    maxval = kind === 1 || kind === 4 ? 1 : int(token(b, pos))
    depth = kind === 3 || kind === 6 ? 3 : 1
  }
  if (maxval < 1 || maxval > 65535 || depth < 1 || depth > 4) throw new Error('bad header')
  const px = allocate(width, height)
  const out = px.data
  // 2 バイトの値は上位から
  const wide = maxval > 255
  pos.p++
  const n = width * height
  if (kind <= 3) {
    // 文字で書かれた値
    for (let i = 0; i < n; i++) {
      const o = i * 4
      if (kind === 1) {
        // P1 は 1 文字ずつ (空白なしで並ぶこともある)。1 が黒
        let c = 0
        while (pos.p < b.length && (c = b[pos.p]!) !== 0x30 && c !== 0x31) pos.p++
        pos.p++
        const v = c === 0x31 ? 0 : 255
        out[o] = out[o + 1] = out[o + 2] = v
      }
      else if (kind === 2) {
        out[o] = out[o + 1] = out[o + 2] = int(token(b, pos)) * 255 / maxval
      }
      else {
        out[o] = int(token(b, pos)) * 255 / maxval
        out[o + 1] = int(token(b, pos)) * 255 / maxval
        out[o + 2] = int(token(b, pos)) * 255 / maxval
      }
      out[o + 3] = 255
    }
    return px
  }
  let p = pos.p
  if (kind === 4) {
    const row = Math.ceil(width / 8)
    need(b, p + row * height)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const o = (y * width + x) * 4
        const v = (b[p + y * row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255
        out[o] = out[o + 1] = out[o + 2] = v
        out[o + 3] = 255
      }
    }
    return px
  }
  const size = wide ? 2 : 1
  need(b, p + n * depth * size)
  const read = (): number => {
    const v = wide ? (b[p]! << 8) | b[p + 1]! : b[p]!
    p += size
    return v * 255 / maxval
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4
    if (depth <= 2) {
      out[o] = out[o + 1] = out[o + 2] = read()
      out[o + 3] = depth === 2 ? read() : 255
    }
    else {
      out[o] = read()
      out[o + 1] = read()
      out[o + 2] = read()
      out[o + 3] = depth === 4 ? read() : 255
    }
  }
  return px
}

export function decodePfm(b: Uint8Array): Pixels {
  const color = b[1] === 0x46
  const pos = { p: 2 }
  const width = int(token(b, pos))
  const height = int(token(b, pos))
  const scale = Number(token(b, pos))
  if (!Number.isFinite(scale) || scale === 0) throw new Error('bad header')
  pos.p++
  const little = scale < 0
  const ch = color ? 3 : 1
  const px = allocate(width, height)
  need(b, pos.p + width * height * ch * 4)
  const dv = new DataView(b.buffer, b.byteOffset + pos.p)
  const out = px.data
  // 行は下から上
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((height - 1 - y) * width + x) * ch * 4
      const o = (y * width + x) * 4
      // 多くのツールと同じく、値をそのまま 0 から 1 の明るさとして扱う (MarumaSign 本体と同じ)
      for (let c = 0; c < 3; c++) out[o + c] = dv.getFloat32(src + (color ? c : 0) * 4, little) * 255
      out[o + 3] = 255
    }
  }
  return px
}

export function decodeFarbfeld(b: Uint8Array): Pixels {
  need(b, 16)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const px = allocate(dv.getUint32(8), dv.getUint32(12))
  need(b, 16 + px.width * px.height * 8)
  const out = px.data
  for (let i = 0; i < out.length; i++) out[i] = b[16 + i * 2]!
  return px
}

// ---------------------------------------------------------------- PCX

export function decodePcx(b: Uint8Array): Pixels {
  need(b, 128)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const bpp = b[3]!
  const width = dv.getUint16(8, true) - dv.getUint16(4, true) + 1
  const height = dv.getUint16(10, true) - dv.getUint16(6, true) + 1
  const planes = b[65]!
  const bpl = dv.getUint16(66, true)
  const px = allocate(width, height)
  const scan = bpl * planes
  const raw = new Uint8Array(scan * height)
  let p = 128, o = 0
  if (b[2] === 1) {
    while (o < raw.length && p < b.length) {
      const c = b[p++]!
      if ((c & 0xC0) === 0xC0) {
        const v = b[p++]!
        for (let k = c & 0x3F; k > 0 && o < raw.length; k--) raw[o++] = v
      }
      else raw[o++] = c
    }
  }
  else {
    raw.set(b.subarray(p, p + raw.length))
  }
  const out = px.data
  const vga = b.length >= 769 && b[b.length - 769] === 0x0C ? b.subarray(b.length - 768) : null
  for (let y = 0; y < height; y++) {
    const row = raw.subarray(y * scan, (y + 1) * scan)
    for (let x = 0; x < width; x++) {
      const q = (y * width + x) * 4
      if (bpp === 8 && planes >= 3) {
        out[q] = row[x]!
        out[q + 1] = row[bpl + x]!
        out[q + 2] = row[bpl * 2 + x]!
        out[q + 3] = planes >= 4 ? row[bpl * 3 + x]! : 255
      }
      else if (bpp === 8 && planes === 1) {
        const c = row[x]!
        if (vga) {
          out[q] = vga[c * 3]!; out[q + 1] = vga[c * 3 + 1]!; out[q + 2] = vga[c * 3 + 2]!
        }
        else out[q] = out[q + 1] = out[q + 2] = c
        out[q + 3] = 255
      }
      else if (bpp === 1) {
        // 1 ビットの面がいくつか (4 面で 16 色)。色はヘッダーの 16 色の表
        let c = 0
        for (let pl = 0; pl < planes; pl++) c |= ((row[pl * bpl + (x >> 3)]! >> (7 - (x & 7))) & 1) << pl
        if (planes === 1) {
          out[q] = out[q + 1] = out[q + 2] = c ? 255 : 0
        }
        else {
          out[q] = b[16 + c * 3]!; out[q + 1] = b[17 + c * 3]!; out[q + 2] = b[18 + c * 3]!
        }
        out[q + 3] = 255
      }
      else if (bpp === 4 && planes === 1) {
        const c = (row[x >> 1]! >> (x & 1 ? 0 : 4)) & 15
        out[q] = b[16 + c * 3]!; out[q + 1] = b[17 + c * 3]!; out[q + 2] = b[18 + c * 3]!
        out[q + 3] = 255
      }
      else throw new Error('unsupported pcx')
    }
  }
  return px
}

// ---------------------------------------------------------------- SGI

export function decodeSgi(b: Uint8Array): Pixels {
  need(b, 512)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const rle = b[2] === 1
  const bpc = b[3]!
  const width = dv.getUint16(6), height = dv.getUint16(8)
  const zsize = Math.max(1, dv.getUint16(10))
  if (bpc !== 1 && bpc !== 2) throw new Error('bad sgi')
  const px = allocate(width, height)
  const out = px.data
  const ch = Math.min(zsize, 4)
  const value = (q: number): number => bpc === 2 ? b[q]! : b[q]!
  for (let c = 0; c < ch; c++) {
    for (let row = 0; row < height; row++) {
      // 行は下から上
      const y = height - 1 - row
      const set = (x: number, v: number): void => {
        const o = (y * width + x) * 4
        if (zsize <= 2 && c === 0) out[o] = out[o + 1] = out[o + 2] = v
        else if (zsize === 2 && c === 1) out[o + 3] = v
        else out[o + c] = v
      }
      if (rle) {
        const start = dv.getUint32(512 + (c * height + row) * 4)
        let p = start, x = 0
        while (x < width && p + bpc <= b.length) {
          const n = bpc === 2 ? dv.getUint16(p) : b[p]!
          p += bpc
          const count = n & 0x7F
          if (count === 0) break
          if (n & 0x80) {
            for (let k = 0; k < count && x < width; k++, p += bpc) set(x++, value(p))
          }
          else {
            const v = value(p)
            p += bpc
            for (let k = 0; k < count && x < width; k++) set(x++, v)
          }
        }
      }
      else {
        const base = 512 + ((c * height + row) * width) * bpc
        need(b, base + width * bpc)
        for (let x = 0; x < width; x++) set(x, value(base + x * bpc))
      }
    }
  }
  for (let i = 3; i < out.length; i += 4) if (zsize !== 2 && zsize < 4) out[i] = 255
  return px
}

// ---------------------------------------------------------------- Sun Raster

export function decodeRas(b: Uint8Array): Pixels {
  need(b, 32)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const width = dv.getUint32(4), height = dv.getUint32(8), depth = dv.getUint32(12)
  const type = dv.getUint32(20), mapLength = dv.getUint32(28)
  const px = allocate(width, height)
  const map = b.subarray(32, 32 + mapLength)
  let p = 32 + mapLength
  const rowBytes = Math.ceil(width * depth / 8 / 2) * 2
  let data = b.subarray(p)
  if (type === 2) {
    const raw = new Uint8Array(rowBytes * height)
    let o = 0
    while (o < raw.length && p < b.length) {
      const c = b[p++]!
      if (c !== 0x80) raw[o++] = c
      else {
        const n = b[p++]!
        if (n === 0) raw[o++] = 0x80
        else {
          const v = b[p++]!
          for (let k = 0; k <= n && o < raw.length; k++) raw[o++] = v
        }
      }
    }
    data = raw
  }
  need(data, rowBytes * height)
  const out = px.data
  const colors = mapLength / 3
  for (let y = 0; y < height; y++) {
    const row = y * rowBytes
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      out[o + 3] = 255
      if (depth === 1) {
        const v = (data[row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 0 : 255
        out[o] = out[o + 1] = out[o + 2] = v
      }
      else if (depth === 8) {
        const c = data[row + x]!
        if (colors > 0) {
          out[o] = map[c]!; out[o + 1] = map[colors + c]!; out[o + 2] = map[colors * 2 + c]!
        }
        else out[o] = out[o + 1] = out[o + 2] = c
      }
      else {
        const n = depth / 8
        const q = row + x * n + (n === 4 ? 1 : 0)
        // 種類 3 (RGB) のほかは BGR の順
        if (type === 3) {
          out[o] = data[q]!; out[o + 1] = data[q + 1]!; out[o + 2] = data[q + 2]!
        }
        else {
          out[o] = data[q + 2]!; out[o + 1] = data[q + 1]!; out[o + 2] = data[q]!
        }
      }
    }
  }
  return px
}

// ---------------------------------------------------------------- WBMP, XBM, XPM

function mbInt(b: Uint8Array, pos: { p: number }): number {
  let v = 0
  for (let i = 0; i < 5; i++) {
    const c = b[pos.p++]!
    v = (v << 7) | (c & 0x7F)
    if (!(c & 0x80)) return v
  }
  throw new Error('bad wbmp')
}

export function decodeWbmp(b: Uint8Array): Pixels {
  const pos = { p: 0 }
  if (mbInt(b, pos) !== 0) throw new Error('bad wbmp')
  pos.p++
  const width = mbInt(b, pos), height = mbInt(b, pos)
  const px = allocate(width, height)
  const row = Math.ceil(width / 8)
  need(b, pos.p + row * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      const v = (b[pos.p + y * row + (x >> 3)]! >> (7 - (x & 7))) & 1 ? 255 : 0
      px.data[o] = px.data[o + 1] = px.data[o + 2] = v
      px.data[o + 3] = 255
    }
  }
  return px
}

function latin1(b: Uint8Array, max: number): string {
  let s = ''
  const n = Math.min(b.length, max)
  for (let i = 0; i < n; i++) s += String.fromCharCode(b[i]!)
  return s
}

export function decodeXbm(b: Uint8Array): Pixels {
  const text = latin1(b, 16 * 1024 * 1024)
  const w = /#define\s+\S*?width\s+(\d+)/.exec(text)
  const h = /#define\s+\S*?height\s+(\d+)/.exec(text)
  const brace = text.indexOf('{')
  if (!w || !h || brace < 0) throw new Error('bad xbm')
  const px = allocate(Number(w[1]), Number(h[1]))
  const bytes = text.substring(brace).match(/0[xX][0-9a-fA-F]+/g) ?? []
  const row = Math.ceil(px.width / 8)
  for (let y = 0; y < px.height; y++) {
    for (let x = 0; x < px.width; x++) {
      const v = parseInt(bytes[y * row + (x >> 3)] ?? '0', 16)
      const o = (y * px.width + x) * 4
      // 下位のビットから。1 が黒
      const on = (v >> (x & 7)) & 1
      px.data[o] = px.data[o + 1] = px.data[o + 2] = on ? 0 : 255
      px.data[o + 3] = 255
    }
  }
  return px
}

/** 色の名前や #rgb を [r, g, b, a] にする (canvas の色の読み方を使う) */
function cssColor(name: string, g: CanvasRenderingContext2D): [number, number, number, number] {
  const n = name.trim()
  if (/^none$/i.test(n)) return [0, 0, 0, 0]
  // X11 の #RRRRGGGGBBBB のような長い書き方は、上位の 2 桁ずつにする
  const hex = /^#([0-9a-f]+)$/i.exec(n)
  if (hex && hex[1]!.length % 3 === 0 && hex[1]!.length > 6) {
    const k = hex[1]!.length / 3
    return [parseInt(hex[1]!.substr(0, 2), 16), parseInt(hex[1]!.substr(k, 2), 16), parseInt(hex[1]!.substr(2 * k, 2), 16), 255]
  }
  g.fillStyle = '#000000'
  g.fillStyle = n.replace(/\s+/g, '')
  const s = String(g.fillStyle)
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(s)
  if (m) return [parseInt(m[1]!, 16), parseInt(m[2]!, 16), parseInt(m[3]!, 16), 255]
  return [0, 0, 0, 255]
}

export function decodeXpm(b: Uint8Array): Pixels {
  const text = latin1(b, 16 * 1024 * 1024)
  const strings: string[] = []
  const re = /"((?:[^"\\]|\\.)*)"/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) strings.push(m[1]!)
  const head = (strings[0] ?? '').trim().split(/\s+/).map(Number)
  const [width, height, ncolors, cpp] = head as [number, number, number, number]
  if (!(ncolors > 0 && ncolors <= 1 << 20 && cpp > 0 && cpp <= 4)) throw new Error('bad xpm')
  const px = allocate(width, height)
  const g = document.createElement('canvas').getContext('2d')!
  const table = new Map<string, [number, number, number, number]>()
  for (let i = 1; i <= ncolors; i++) {
    const line = strings[i] ?? ''
    const key = line.substring(0, cpp)
    const rest = line.substring(cpp)
    // 「c 色」を使う (なければ最後の色)
    const c = /(?:^|\s)c\s+(.+?)(?=\s+(?:m|s|g4|g)\s|$)/.exec(rest) ?? /\s(\S+)\s*$/.exec(rest)
    table.set(key, cssColor(c ? c[1]! : 'black', g))
  }
  for (let y = 0; y < height; y++) {
    const line = strings[1 + ncolors + y] ?? ''
    for (let x = 0; x < width; x++) {
      const c = table.get(line.substr(x * cpp, cpp)) ?? [0, 0, 0, 0]
      const o = (y * width + x) * 4
      px.data[o] = c[0]; px.data[o + 1] = c[1]; px.data[o + 2] = c[2]; px.data[o + 3] = c[3]
    }
  }
  return px
}

// ---------------------------------------------------------------- BMP の中身 (ICO と CUR の中の絵)

/** ICO の中の BMP (BITMAPINFOHEADER から。高さは XOR と AND の 2 つ分) */
export function decodeDib(b: Uint8Array): Pixels {
  need(b, 40)
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength)
  const header = dv.getUint32(0, true)
  const width = dv.getInt32(4, true)
  const topDown = dv.getInt32(8, true) < 0
  const height = Math.abs(dv.getInt32(8, true)) / 2
  const bpp = dv.getUint16(14, true)
  const compression = dv.getUint32(16, true)
  if (compression !== 0 && compression !== 3) throw new Error('unsupported dib')
  const px = allocate(width, Math.floor(height))
  let colors = dv.getUint32(32, true)
  if (bpp <= 8 && colors === 0) colors = 1 << bpp
  let p = header + (compression === 3 && header === 40 ? 12 : 0)
  const palette = b.subarray(p, p + colors * 4)
  p += bpp <= 8 ? colors * 4 : 0
  const stride = Math.ceil(width * bpp / 32) * 4
  const maskStride = Math.ceil(width / 32) * 4
  const h = px.height
  need(b, p + stride * h)
  const mask = p + stride * h
  const out = px.data
  let anyAlpha = false
  for (let row = 0; row < h; row++) {
    const y = topDown ? row : h - 1 - row
    const base = p + row * stride
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4
      if (bpp === 32) {
        out[o] = b[base + x * 4 + 2]!; out[o + 1] = b[base + x * 4 + 1]!; out[o + 2] = b[base + x * 4]!; out[o + 3] = b[base + x * 4 + 3]!
        if (out[o + 3]) anyAlpha = true
      }
      else if (bpp === 24) {
        out[o] = b[base + x * 3 + 2]!; out[o + 1] = b[base + x * 3 + 1]!; out[o + 2] = b[base + x * 3]!; out[o + 3] = 255
      }
      else if (bpp <= 8) {
        const perByte = 8 / bpp
        const c = (b[base + Math.floor(x / perByte)]! >> ((perByte - 1 - (x % perByte)) * bpp)) & ((1 << bpp) - 1)
        out[o] = palette[c * 4 + 2] ?? 0; out[o + 1] = palette[c * 4 + 1] ?? 0; out[o + 2] = palette[c * 4] ?? 0; out[o + 3] = 255
      }
      else throw new Error('unsupported dib')
    }
    // AND の面 (1 が透明)。32 ビットで透明度があるときは使わない
    if (bpp !== 32 && mask + (row + 1) * maskStride <= b.length) {
      for (let x = 0; x < width; x++) {
        if ((b[mask + row * maskStride + (x >> 3)]! >> (7 - (x & 7))) & 1) out[(y * width + x) * 4 + 3] = 0
      }
    }
  }
  if (bpp === 32 && !anyAlpha) for (let i = 3; i < out.length; i += 4) out[i] = 255
  return px
}

// ---------------------------------------------------------------- FITS (天文の形式。白黒を明るさの幅に合わせて広げる)

export function decodeFits(b: Uint8Array): Pixels {
  const cards: Record<string, string> = {}
  let p = 0
  for (; p + 80 <= b.length; p += 80) {
    const card = latin1(b.subarray(p, p + 80), 80)
    const key = card.substring(0, 8).trim()
    if (key === 'END') {
      p += 80
      break
    }
    if (card[8] === '=') cards[key] = card.substring(10).split('/')[0]!.trim()
  }
  p = Math.ceil(p / 2880) * 2880
  const bitpix = Number(cards.BITPIX)
  const width = Number(cards.NAXIS1), height = Number(cards.NAXIS2)
  const planes = Number(cards.NAXIS) >= 3 && Number(cards.NAXIS3) === 3 ? 3 : 1
  const bscale = cards.BSCALE ? Number(cards.BSCALE) : 1
  const bzero = cards.BZERO ? Number(cards.BZERO) : 0
  const size = Math.abs(bitpix) / 8
  if (![8, 16, 32, -32, -64].includes(bitpix)) throw new Error('bad fits')
  const px = allocate(width, height)
  const n = width * height
  need(b, p + n * planes * size)
  const dv = new DataView(b.buffer, b.byteOffset + p)
  const read = (i: number): number => {
    const q = i * size
    const v = bitpix === 8 ? dv.getUint8(q) : bitpix === 16 ? dv.getInt16(q) : bitpix === 32 ? dv.getInt32(q) : bitpix === -32 ? dv.getFloat32(q) : dv.getFloat64(q)
    return v * bscale + bzero
  }
  let lo = Infinity, hi = -Infinity
  for (let i = 0; i < n * planes; i++) {
    const v = read(i)
    if (Number.isFinite(v)) {
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
  }
  const range = hi > lo ? hi - lo : 1
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 行は下から上
      const src = (height - 1 - y) * width + x
      const o = (y * width + x) * 4
      for (let c = 0; c < 3; c++) {
        const v = read(src + (planes === 3 ? c * n : 0))
        px.data[o + c] = Number.isFinite(v) ? (v - lo) / range * 255 : 0
      }
      px.data[o + 3] = 255
    }
  }
  return px
}
