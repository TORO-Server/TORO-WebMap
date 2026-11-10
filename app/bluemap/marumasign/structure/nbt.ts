// NBT (Minecraft のデータの形式) を読む。Java 版はビッグエンディアン、統合版 (.mcstructure) はリトルエンディアン
// 看板の URL の先のファイルは誰でも作れるので、複合タグは Map にし (__proto__ などの名前でも壊れないように)、深さと長さに上限をかける
// ここは何も import しない (Node の試験と Worker の両方で使う)

/** タグの値。複合タグは Map、リストは配列、long は bigint */
export type Tag = number | bigint | string | Int8Array | Int32Array | BigInt64Array | Tag[] | Compound
export type Compound = Map<string, Tag>

const MAX_DEPTH = 512

export class NbtReader {
  private readonly b: Uint8Array
  private readonly dv: DataView
  private readonly little: boolean
  private p = 0
  private readonly decoder = new TextDecoder()

  constructor(bytes: Uint8Array, little: boolean) {
    this.b = bytes
    this.dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    this.little = little
  }

  private need(n: number): void {
    if (n < 0 || this.p + n > this.b.length) throw new Error('truncated nbt')
  }

  private u8(): number {
    this.need(1)
    return this.b[this.p++]!
  }

  private i16(): number {
    this.need(2)
    const v = this.dv.getInt16(this.p, this.little)
    this.p += 2
    return v
  }

  private i32(): number {
    this.need(4)
    const v = this.dv.getInt32(this.p, this.little)
    this.p += 4
    return v
  }

  private string(): string {
    const n = this.i16() & 0xFFFF
    this.need(n)
    const s = this.decoder.decode(this.b.subarray(this.p, this.p + n))
    this.p += n
    return s
  }

  /** 名前つきの、いちばん外側の複合タグ */
  readRoot(): { name: string, value: Compound } {
    if (this.u8() !== 10) throw new Error('not nbt')
    const name = this.string()
    return { name, value: this.payload(10, 0) as Compound }
  }

  private count(size: number): number {
    const n = this.i32()
    if (n < 0) throw new Error('bad nbt length')
    // 残りのバイト数より多い要素は入らない
    this.need(n * size)
    return n
  }

  private payload(type: number, depth: number): Tag {
    if (depth > MAX_DEPTH) throw new Error('nbt too deep')
    switch (type) {
      case 1: { this.need(1); return this.dv.getInt8(this.p++) }
      case 2: return this.i16()
      case 3: return this.i32()
      case 4: { this.need(8); const v = this.dv.getBigInt64(this.p, this.little); this.p += 8; return v }
      case 5: { this.need(4); const v = this.dv.getFloat32(this.p, this.little); this.p += 4; return v }
      case 6: { this.need(8); const v = this.dv.getFloat64(this.p, this.little); this.p += 8; return v }
      case 7: {
        const n = this.count(1)
        const v = new Int8Array(this.b.buffer, this.b.byteOffset + this.p, n)
        this.p += n
        return v
      }
      case 8: return this.string()
      case 9: {
        const itemType = this.u8()
        const n = this.i32()
        if (n < 0) throw new Error('bad nbt length')
        if (itemType === 0 || n === 0) return []
        // 1 要素は少なくとも 1 バイト
        this.need(Math.min(n, this.b.length))
        if (n > this.b.length - this.p) throw new Error('bad nbt length')
        const list: Tag[] = []
        for (let i = 0; i < n; i++) list.push(this.payload(itemType, depth + 1))
        return list
      }
      case 10: {
        const map: Compound = new Map()
        for (;;) {
          const t = this.u8()
          if (t === 0) return map
          const name = this.string()
          map.set(name, this.payload(t, depth + 1))
        }
      }
      case 11: {
        const n = this.count(4)
        const v = new Int32Array(n)
        for (let i = 0; i < n; i++) v[i] = this.dv.getInt32(this.p + i * 4, this.little)
        this.p += n * 4
        return v
      }
      case 12: {
        const n = this.count(8)
        const v = new BigInt64Array(n)
        for (let i = 0; i < n; i++) v[i] = this.dv.getBigInt64(this.p + i * 8, this.little)
        this.p += n * 8
        return v
      }
      default: throw new Error('bad nbt tag ' + type)
    }
  }
}

// ---- 値を取り出す小さな関数 (形が違えば既定の値)

export function compound(v: Tag | undefined): Compound {
  return v instanceof Map ? v : new Map()
}

export function list(v: Tag | undefined): Tag[] {
  return Array.isArray(v) ? v : []
}

export function int(v: Tag | undefined, def = 0): number {
  if (typeof v === 'number') return Math.trunc(v)
  if (typeof v === 'bigint') return Number(BigInt.asIntN(32, v))
  return def
}

export function str(v: Tag | undefined, def = ''): string {
  return typeof v === 'string' ? v : def
}

/** int の配列 (IntArray か、数のリスト) */
export function ints(v: Tag | undefined): number[] | null {
  if (v instanceof Int32Array) return Array.from(v)
  if (Array.isArray(v)) return v.map(x => int(x as Tag))
  return null
}
