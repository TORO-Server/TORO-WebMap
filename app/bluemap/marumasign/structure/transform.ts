// 4x4 の変換 (行の順の 16 個)。右から順に掛けたものが先に効く (Minecraft の PoseStack と同じ。MarumaSign 本体の Transform)
// ここは何も import しない

export class Transform {
  readonly m: Float64Array

  private constructor(m: Float64Array) {
    this.m = m
  }

  static identity(): Transform {
    return new Transform(Float64Array.of(1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1))
  }

  static fromRows(m: ArrayLike<number>): Transform {
    return new Transform(Float64Array.from(m))
  }

  copy(): Transform {
    return new Transform(this.m.slice())
  }

  /** this = this * other */
  multiply(o: ArrayLike<number>): this {
    const a = this.m, r = new Float64Array(16)
    for (let row = 0; row < 4; row++) {
      for (let col = 0; col < 4; col++) {
        let sum = 0
        for (let k = 0; k < 4; k++) sum += a[row * 4 + k]! * o[k * 4 + col]!
        r[row * 4 + col] = sum
      }
    }
    a.set(r)
    return this
  }

  translate(x: number, y: number, z: number): this {
    return this.multiply([1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1])
  }

  scale(x: number, y: number, z: number): this {
    return this.multiply([x, 0, 0, 0, 0, y, 0, 0, 0, 0, z, 0, 0, 0, 0, 1])
  }

  rotateX(deg: number): this {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
    return this.multiply([1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1])
  }

  rotateY(deg: number): this {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
    return this.multiply([c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1])
  }

  rotateZ(deg: number): this {
    const a = deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a)
    return this.multiply([c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1])
  }

  /** 四元数 (x, y, z, w) の回転 */
  rotateQuaternion(x: number, y: number, z: number, w: number): this {
    const l = Math.sqrt(x * x + y * y + z * z + w * w)
    if (!(l > 0)) return this
    x /= l
    y /= l
    z /= l
    w /= l
    return this.multiply([
      1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 0,
      2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 0,
      2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y), 0,
      0, 0, 0, 1])
  }

  /** X, Y, Z の順の角度 (度) の回転 (Quaternionf.rotationXYZ と同じ) */
  rotateXYZ(x: number, y: number, z: number): this {
    return this.rotateX(x).rotateY(y).rotateZ(z)
  }

  /** 点 (cx, cy, cz) を中心に、縦の軸で回す */
  rotateYAround(deg: number, cx: number, cy: number, cz: number): this {
    return this.translate(cx, cy, cz).rotateY(deg).translate(-cx, -cy, -cz)
  }

  apply(x: number, y: number, z: number, out: Float32Array | number[], offset: number): void {
    const m = this.m
    out[offset] = m[0]! * x + m[1]! * y + m[2]! * z + m[3]!
    out[offset + 1] = m[4]! * x + m[5]! * y + m[6]! * z + m[7]!
    out[offset + 2] = m[8]! * x + m[9]! * y + m[10]! * z + m[11]!
  }

  /** 裏返す変換 (行列式が負) か */
  flips(): boolean {
    const m = this.m
    const det = m[0]! * (m[5]! * m[10]! - m[6]! * m[9]!) - m[1]! * (m[4]! * m[10]! - m[6]! * m[8]!) + m[2]! * (m[4]! * m[9]! - m[5]! * m[8]!)
    return det < 0
  }

  /** 有限の値だけか (壊れたデータの変換で、描く位置が決まらないものを除く) */
  finite(): boolean {
    for (let i = 0; i < 16; i++) if (!Number.isFinite(this.m[i]!)) return false
    return true
  }
}
