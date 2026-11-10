// ゲームのコードで形が決まっているもの (チェスト、旗、頭など) の形 (tables/entity_models.txt.gz。MarumaSign 本体の EntityModels と同じもの。
// 本体の tools/blockdata/EntityModelDump.java が作る)。四角形ごとに 4 頂点の x, y, z (ブロック単位), u, v (0 - 1)
// ここは何も import しない

export class EntityModels {
  private readonly models = new Map<string, Float32Array[]>()
  private readonly pivots = new Map<string, number[]>()

  static parse(text: string): EntityModels {
    const r = new EntityModels()
    let current: Float32Array[] | null = null
    let name = ''
    for (const line of text.split('\n')) {
      if (line.startsWith('E ')) {
        name = line.substring(2).trim()
        current = []
        r.models.set(name, current)
      }
      else if (line.startsWith('P ') && current) {
        const p = line.substring(2).trim().split(' ').map(Number)
        r.pivots.set(name, [p[0] ?? 0, p[1] ?? 0, p[2] ?? 0])
      }
      else if (line.startsWith('Q') && current) {
        const parts = line.substring(1).trim().split(' ')
        const q = new Float32Array(20)
        for (let i = 0; i < 20 && i < parts.length; i++) q[i] = Number(parts[i])
        // 面積のない面 (厚さのない箱の側面) は描かない
        if (!degenerate(q)) current.push(q)
      }
    }
    return r
  }

  get(name: string): Float32Array[] {
    const q = this.models.get(name)
    if (!q) throw new Error('Unknown entity model: ' + name)
    return q
  }

  has(name: string): boolean {
    return this.models.has(name)
  }

  /** 部分の位置 (ピクセル単位)。部分ごとに書き出したモデルだけにある */
  pivot(name: string): number[] {
    return this.pivots.get(name) ?? [0, 0, 0]
  }
}

function degenerate(q: Float32Array): boolean {
  const ax = q[5]! - q[0]!, ay = q[6]! - q[1]!, az = q[7]! - q[2]!
  const bx = q[10]! - q[0]!, by = q[11]! - q[1]!, bz = q[12]! - q[2]!
  const cx = q[15]! - q[0]!, cy = q[16]! - q[1]!, cz = q[17]! - q[2]!
  const n1x = ay * bz - az * by, n1y = az * bx - ax * bz, n1z = ax * by - ay * bx
  const n2x = by * cz - bz * cy, n2y = bz * cx - bx * cz, n2z = bx * cy - by * cx
  return n1x * n1x + n1y * n1y + n1z * n1z < 1e-12 && n2x * n2x + n2y * n2y + n2z * n2z < 1e-12
}
