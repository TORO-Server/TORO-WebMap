// java.util.Random (と Minecraft の Mth.getSeed)。モデルの選び方 (重み付きのモデル、multipart) をゲームと同じにするため
// ここは何も import しない

const MULT = 0x5DEECE66Dn
const MASK = (1n << 48n) - 1n

export class JavaRandom {
  private s = 0n

  setSeed(seed: bigint): void {
    this.s = (seed ^ MULT) & MASK
  }

  private next(bits: number): number {
    this.s = (this.s * MULT + 0xBn) & MASK
    return Number(BigInt.asIntN(32, this.s >> BigInt(48 - bits)))
  }

  nextInt(bound: number): number {
    let r = this.next(31)
    const m = bound - 1
    if ((bound & m) === 0) return Number((BigInt(bound) * BigInt(r)) >> 31n)
    for (let u = r; ((u - (r = u % bound) + m) | 0) < 0; u = this.next(31)) { /* やり直す */ }
    return r
  }

  nextLong(): bigint {
    return BigInt.asIntN(64, (BigInt(this.next(32)) << 32n) + BigInt(this.next(32)))
  }
}

/** Mth.getSeed */
export function blockSeed(x: number, y: number, z: number): bigint {
  let seed = BigInt(Math.imul(x, 3129871)) ^ (BigInt(z) * 116129781n) ^ BigInt(y)
  seed = BigInt.asIntN(64, seed)
  seed = BigInt.asIntN(64, seed * seed * 42317861n + seed * 11n)
  return seed >> 16n
}
