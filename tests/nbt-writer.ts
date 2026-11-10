// 試験用の小さな NBT の書き出し (構造物のファイルを作る)
export interface W {
  t: number
  v: unknown
}

export const B = (v: number): W => ({ t: 1, v })
export const Sh = (v: number): W => ({ t: 2, v })
export const I = (v: number): W => ({ t: 3, v })
export const Lg = (v: bigint): W => ({ t: 4, v })
export const F = (v: number): W => ({ t: 5, v })
export const D = (v: number): W => ({ t: 6, v })
export const S = (v: string): W => ({ t: 8, v })
export const BA = (v: number[] | Uint8Array): W => ({ t: 7, v: Array.from(v) })
export const IA = (v: number[]): W => ({ t: 11, v })
export const LA = (v: bigint[]): W => ({ t: 12, v })
export const L = (type: number, items: W[]): W => ({ t: 9, v: { type, items } })
export const C = (entries: Record<string, W>): W => ({ t: 10, v: entries })

export function encode(root: W, little = false, name = ''): Uint8Array {
  const out: number[] = []
  const u16 = (n: number): void => {
    if (little) out.push(n & 255, (n >> 8) & 255)
    else out.push((n >> 8) & 255, n & 255)
  }
  const i32 = (n: number): void => {
    const b = [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
    out.push(...(little ? b.reverse() : b))
  }
  const i64 = (n: bigint): void => {
    const u = BigInt.asUintN(64, n)
    const b: number[] = []
    for (let i = 7; i >= 0; i--) b.push(Number((u >> BigInt(i * 8)) & 255n))
    out.push(...(little ? b.reverse() : b))
  }
  const str = (s: string): void => {
    const bytes = new TextEncoder().encode(s)
    u16(bytes.length)
    out.push(...bytes)
  }
  const payload = (w: W): void => {
    switch (w.t) {
      case 1: out.push((w.v as number) & 255); break
      case 2: u16((w.v as number) & 0xFFFF); break
      case 3: i32(w.v as number); break
      case 4: i64(w.v as bigint); break
      case 5: { const b = new Uint8Array(new Float32Array([w.v as number]).buffer); out.push(...(little ? Array.from(b) : Array.from(b).reverse())); break }
      case 6: { const b = new Uint8Array(new Float64Array([w.v as number]).buffer); out.push(...(little ? Array.from(b) : Array.from(b).reverse())); break }
      case 7: { const a = w.v as number[]; i32(a.length); out.push(...a.map(x => x & 255)); break }
      case 8: str(w.v as string); break
      case 9: { const l = w.v as { type: number, items: W[] }; out.push(l.type); i32(l.items.length); for (const it of l.items) payload(it); break }
      case 10: {
        for (const [k, v] of Object.entries(w.v as Record<string, W>)) {
          out.push(v.t)
          str(k)
          payload(v)
        }
        out.push(0)
        break
      }
      case 11: { const a = w.v as number[]; i32(a.length); for (const x of a) i32(x); break }
      case 12: { const a = w.v as bigint[]; i32(a.length); for (const x of a) i64(x); break }
    }
  }
  out.push(10)
  str(name)
  payload(root)
  return new Uint8Array(out)
}
