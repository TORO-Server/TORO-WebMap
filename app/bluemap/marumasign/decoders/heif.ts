// HEIF の箱 (HEIC と、AV1 の入った HEIF・AVIF) を読む。ブラウザーのものは使わない (Node の試験でも動く)。
// 絵そのもの (HEVC と AV1) は、ブラウザーの WebCodecs の VideoDecoder で展開する (heif-decode.ts)。
// 主な絵 (pitm)、格子に並べた絵 (grid)、透明度の絵 (auxl)、回転 (irot)・反転 (imir)・切り抜き (clap) に対応する

export interface HeifTile {
  /** 展開に渡すバイト列 (HEVC は長さつきの NAL の並び、AV1 は OBU の並び) */
  data: Uint8Array
}

export interface HeifImage {
  /** WebCodecs の codec の文字列 */
  codec: string
  /** WebCodecs の description (hvcC か av1C の中身) */
  description: Uint8Array
  /** 1 枚の絵か、格子に並べる絵 (左上から行ごと) */
  tiles: HeifTile[]
  columns: number
  rows: number
  /** 格子の絵の大きさ (1 枚なら ispe の大きさ) */
  width: number
  height: number
}

export interface HeifPicture {
  color: HeifImage
  alpha: HeifImage | null
  /** 回転 (反時計回りに 90 度の何回分) */
  rotation: number
  /** 反転 (0 は左右を、1 は上下を入れ替える。null はなし) */
  mirror: number | null
  /** 切り抜き (左上と大きさ) */
  crop: { x: number, y: number, width: number, height: number } | null
}

interface Box {
  type: string
  start: number
  /** 中身の始まり */
  body: number
  end: number
}

function u16(b: Uint8Array, p: number): number {
  return (b[p]! << 8) | b[p + 1]!
}

function u32(b: Uint8Array, p: number): number {
  return ((b[p]! << 24) | (b[p + 1]! << 16) | (b[p + 2]! << 8) | b[p + 3]!) >>> 0
}

function uN(b: Uint8Array, p: number, size: number): number {
  let v = 0
  for (let i = 0; i < size; i++) v = v * 256 + b[p + i]!
  return v
}

function type4(b: Uint8Array, p: number): string {
  return String.fromCharCode(b[p]!, b[p + 1]!, b[p + 2]!, b[p + 3]!)
}

function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const list: Box[] = []
  let p = start
  while (p + 8 <= end && list.length < 10000) {
    let size = u32(b, p)
    const type = type4(b, p + 4)
    let body = p + 8
    if (size === 1) {
      if (p + 16 > end) break
      size = uN(b, p + 8, 8)
      body = p + 16
    }
    else if (size === 0) size = end - p
    if (size < body - p || p + size > end) break
    list.push({ type, start: p, body, end: p + size })
    p += size
  }
  return list
}

function find(list: Box[], type: string): Box | undefined {
  return list.find(x => x.type === type)
}

interface Item {
  id: number
  type: string
  /** 中身の場所 (ファイルの中か、idat の中) */
  extents: { offset: number, length: number }[]
  fromIdat: boolean
  /** 性質 (ipco の中の箱。順番どおり) */
  props: Box[]
}

/** HEIF のファイルを読む。HEIF でなければ (主な絵が読めなければ) 失敗にする */
export function parseHeif(b: Uint8Array): HeifPicture {
  const top = boxes(b, 0, b.length)
  const meta = find(top, 'meta')
  if (!meta) throw new Error('heif has no meta')
  // meta は FullBox (版と flags の 4 バイトのあとに子の箱)
  const children = boxes(b, meta.body + 4, meta.end)
  const pitm = find(children, 'pitm')
  const iloc = find(children, 'iloc')
  const iinf = find(children, 'iinf')
  const iprp = find(children, 'iprp')
  if (!pitm || !iloc || !iinf || !iprp) throw new Error('heif is missing boxes')
  const primary = b[pitm.body] === 0 ? u16(b, pitm.body + 4) : u32(b, pitm.body + 4)
  const items = new Map<number, Item>()

  // 項目の種類 (infe)
  const iv = b[iinf.body]!
  const infeStart = iinf.body + 4 + (iv === 0 ? 2 : 4)
  for (const infe of boxes(b, infeStart, iinf.end)) {
    if (infe.type !== 'infe') continue
    const v = b[infe.body]!
    if (v < 2) continue
    const p = infe.body + 4
    const id = v === 2 ? u16(b, p) : u32(b, p)
    const q = p + (v === 2 ? 2 : 4) + 2
    items.set(id, { id, type: type4(b, q), extents: [], fromIdat: false, props: [] })
  }

  // 中身の場所 (iloc)
  {
    const v = b[iloc.body]!
    let p = iloc.body + 4
    const offsetSize = b[p]! >> 4, lengthSize = b[p]! & 15
    const baseSize = b[p + 1]! >> 4, indexSize = v === 1 || v === 2 ? b[p + 1]! & 15 : 0
    p += 2
    const count = v < 2 ? u16(b, p) : u32(b, p)
    p += v < 2 ? 2 : 4
    for (let i = 0; i < count && p < iloc.end; i++) {
      const id = v < 2 ? u16(b, p) : u32(b, p)
      p += v < 2 ? 2 : 4
      let method = 0
      if (v === 1 || v === 2) {
        method = u16(b, p) & 15
        p += 2
      }
      p += 2 // data_reference_index
      const base = uN(b, p, baseSize)
      p += baseSize
      const extentCount = u16(b, p)
      p += 2
      const extents: { offset: number, length: number }[] = []
      for (let e = 0; e < extentCount; e++) {
        p += indexSize
        const offset = uN(b, p, offsetSize)
        p += offsetSize
        const length = uN(b, p, lengthSize)
        p += lengthSize
        extents.push({ offset: base + offset, length })
      }
      const item = items.get(id)
      if (item) {
        item.extents = extents
        item.fromIdat = method === 1
      }
    }
  }

  // 性質 (ipco) とその割り当て (ipma)
  const iprpChildren = boxes(b, iprp.body, iprp.end)
  const ipco = find(iprpChildren, 'ipco')
  const props = ipco ? boxes(b, ipco.body, ipco.end) : []
  for (const ipma of iprpChildren.filter(x => x.type === 'ipma')) {
    const v = b[ipma.body]!, flags = b[ipma.body + 3]!
    let p = ipma.body + 4
    const count = u32(b, p)
    p += 4
    for (let i = 0; i < count && p < ipma.end; i++) {
      const id = v < 1 ? u16(b, p) : u32(b, p)
      p += v < 1 ? 2 : 4
      const n = b[p++]!
      const item = items.get(id)
      for (let k = 0; k < n; k++) {
        const index = flags & 1 ? u16(b, p) & 0x7FFF : b[p]! & 0x7F
        p += flags & 1 ? 2 : 1
        const prop = props[index - 1]
        if (item && prop) item.props.push(prop)
      }
    }
  }

  // 項目どうしのつながり (iref)
  const refs: { type: string, from: number, to: number[] }[] = []
  const iref = find(children, 'iref')
  if (iref) {
    const v = b[iref.body]!
    for (const r of boxes(b, iref.body + 4, iref.end)) {
      let p = r.body
      const from = v === 0 ? u16(b, p) : u32(b, p)
      p += v === 0 ? 2 : 4
      const n = u16(b, p)
      p += 2
      const to: number[] = []
      for (let k = 0; k < n && p < r.end; k++) {
        to.push(v === 0 ? u16(b, p) : u32(b, p))
        p += v === 0 ? 2 : 4
      }
      refs.push({ type: r.type, from, to })
    }
  }
  const idat = find(children, 'idat')

  const dataOf = (item: Item): Uint8Array => {
    let total = 0
    for (const e of item.extents) total += e.length
    const out = new Uint8Array(total)
    let at = 0
    for (const e of item.extents) {
      const start = item.fromIdat ? (idat ? idat.body : 0) + e.offset : e.offset
      const end = item.fromIdat ? Math.min(idat ? idat.end : 0, start + e.length) : start + e.length
      if (start < 0 || end > b.length || end < start) throw new Error('heif item data is outside the file')
      out.set(b.subarray(start, end), at)
      at += end - start
    }
    return out
  }
  const prop = (item: Item, type: string): Box | undefined => item.props.find(x => x.type === type)

  // AV1 の絵は、展開に渡すときに sequence header の OBU が要る (av1C にだけ入っていることがあるので、なければ前に足す)
  const tileData = (item: Item, description: Uint8Array): Uint8Array => {
    const data = dataOf(item)
    if (item.type !== 'av01' || description.length <= 4 || hasSequenceHeader(data)) return data
    const config = description.subarray(4)
    const out = new Uint8Array(config.length + data.length)
    out.set(config)
    out.set(data, config.length)
    return out
  }
  const imageOf = (id: number): HeifImage => {
    const item = items.get(id)
    if (!item) throw new Error('heif item not found: ' + id)
    if (item.type === 'grid') {
      const g = dataOf(item)
      const big = (g[1]! & 1) !== 0
      const rows = g[2]! + 1, columns = g[3]! + 1
      const width = big ? u32(g, 4) : u16(g, 4)
      const height = big ? u32(g, 8) : u16(g, 6)
      const tileIds = refs.find(r => r.type === 'dimg' && r.from === id)?.to ?? []
      if (tileIds.length < rows * columns) throw new Error('heif grid is missing tiles')
      const tiles = tileIds.slice(0, rows * columns).map(t => items.get(t))
      const first = tiles[0]
      if (!first) throw new Error('heif grid tile not found')
      const { codec, description } = codecOf(first)
      return { codec, description, tiles: tiles.map(t => ({ data: tileData(t!, description) })), columns, rows, width, height }
    }
    const { codec, description } = codecOf(item)
    const ispe = prop(item, 'ispe')
    const width = ispe ? u32(b, ispe.body + 4) : 0, height = ispe ? u32(b, ispe.body + 8) : 0
    return { codec, description, tiles: [{ data: tileData(item, description) }], columns: 1, rows: 1, width, height }
  }
  const codecOf = (item: Item): { codec: string, description: Uint8Array } => {
    if (item.type === 'hvc1') {
      const c = prop(item, 'hvcC')
      if (!c) throw new Error('heif has no hvcC')
      const d = b.subarray(c.body, c.end)
      return { codec: hevcCodec(d), description: d }
    }
    if (item.type === 'av01') {
      const c = prop(item, 'av1C')
      if (!c) throw new Error('heif has no av1C')
      const d = b.subarray(c.body, c.end)
      return { codec: av1Codec(d), description: d }
    }
    throw new Error('unsupported heif item type: ' + item.type)
  }

  const main = items.get(primary)
  if (!main) throw new Error('heif primary item not found')
  const color = imageOf(primary)
  // 透明度: 主な絵を指す auxl のうち、透明度の印 (auxC) のあるもの
  let alpha: HeifImage | null = null
  for (const r of refs) {
    if (r.type !== 'auxl' || !r.to.includes(primary)) continue
    const item = items.get(r.from)
    const auxC = item && prop(item, 'auxC')
    if (!item || !auxC) continue
    let s = ''
    for (let p = auxC.body + 4; p < auxC.end && b[p] !== 0; p++) s += String.fromCharCode(b[p]!)
    if (s === 'urn:mpeg:hevc:2015:auxid:1' || s === 'urn:mpeg:mpegB:cicp:systems:auxiliary:alpha') {
      try {
        alpha = imageOf(r.from)
      }
      catch { /* 透明度なしで描く */ }
      break
    }
  }
  let rotation = 0, mirror: number | null = null
  let crop: HeifPicture['crop'] = null
  for (const p of main.props) {
    if (p.type === 'irot') rotation = b[p.body]! & 3
    else if (p.type === 'imir') mirror = b[p.body]! & 1
    else if (p.type === 'clap' && p.end - p.body >= 32 && color.width && color.height) {
      const r = (k: number): number => {
        const n = u32(b, p.body + k * 8) | 0, d = u32(b, p.body + k * 8 + 4) | 0
        return d ? n / d : 0
      }
      const cw = Math.round(r(0)), ch = Math.round(r(1))
      const x = Math.round(r(2) + (color.width - 1) / 2 - (cw - 1) / 2)
      const y = Math.round(r(3) + (color.height - 1) / 2 - (ch - 1) / 2)
      if (cw > 0 && ch > 0 && x >= 0 && y >= 0 && x + cw <= color.width && y + ch <= color.height) crop = { x, y, width: cw, height: ch }
    }
  }
  return { color, alpha, rotation, mirror, crop }
}

/** AV1 の OBU の並びに sequence header (種類 1) があるか (frame の OBU より前に) */
export function hasSequenceHeader(d: Uint8Array): boolean {
  let p = 0
  while (p < d.length) {
    const header = d[p]!
    const type = (header >> 3) & 15
    if (type === 1) return true
    if (type === 3 || type === 6) return false
    const ext = (header >> 2) & 1, hasSize = (header >> 1) & 1
    p += 1 + ext
    if (!hasSize) return false
    // leb128 の大きさ
    let size = 0
    for (let i = 0; i < 8 && p < d.length; i++) {
      const byte = d[p++]!
      size += (byte & 0x7F) * Math.pow(2, i * 7)
      if (!(byte & 0x80)) break
    }
    p += size
  }
  return false
}

/** hvcC から WebCodecs の codec の文字列 (ISO/IEC 14496-15 の付録 E。例: hvc1.1.6.L93.B0) */
export function hevcCodec(c: Uint8Array): string {
  if (c.length < 13) throw new Error('bad hvcC')
  const space = c[1]! >> 6, tier = (c[1]! >> 5) & 1, profile = c[1]! & 31
  // 互換性の印は、ビットの並びを逆にして 16 進で書く
  const compat = u32(c, 2)
  let reversed = 0
  for (let i = 0; i < 32; i++) if (compat & (1 << i)) reversed |= 1 << (31 - i)
  const level = c[12]!
  let s = `hvc1.${['', 'A', 'B', 'C'][space]}${profile}.${(reversed >>> 0).toString(16).toUpperCase()}.${tier ? 'H' : 'L'}${level}`
  // 制約の印 (6 バイト)。後ろの 0 は省く
  const constraints = Array.from(c.subarray(6, 12))
  while (constraints.length && constraints[constraints.length - 1] === 0) constraints.pop()
  for (const v of constraints) s += '.' + v.toString(16).toUpperCase()
  return s
}

/** av1C から WebCodecs の codec の文字列 (例: av01.0.04M.08) */
export function av1Codec(c: Uint8Array): string {
  if (c.length < 4) throw new Error('bad av1C')
  const profile = c[1]! >> 5, level = c[1]! & 31
  const tier = c[2]! >> 7, high = (c[2]! >> 6) & 1, twelve = (c[2]! >> 5) & 1
  const depth = profile === 2 && high ? (twelve ? 12 : 10) : high ? 10 : 8
  return `av01.${profile}.${String(level).padStart(2, '0')}${tier ? 'H' : 'M'}.${String(depth).padStart(2, '0')}`
}
