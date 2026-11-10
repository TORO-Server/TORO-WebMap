// 構造物のブロックを、絵ごとの四角形の並びにする (簡単にした形。/mcassets/ がないときだけ使う。あるときは vanilla.ts)
// MarumaSign 本体と同じく、隣の不透明なブロックに接する面は描かず、面の向きで明るさを変える (上 1.0、北と南 0.8、東と西 0.6、下 0.5)。
// 四角形が 15 万枚を超えるときは、2 x 2 x 2 ブロックを 1 つにまとめて (halve) やり直す
// ここは何も import しない (Node の試験と Worker の両方で使う) が、形の決め方 (blocks.ts) と並び (formats.ts) は使う
import { blockModel, DOWN, EAST, NORTH, SOUTH, TextureResolver, UP, WEST, type BlockModel, type RenderMode } from './blocks.ts'
import type { Structure } from './formats.ts'

/** 描く四角形の数の上限 (MarumaSign 本体と同じ) */
export const MAX_QUADS = 150000

const SHADE = [1.0, 0.5, 0.8, 0.8, 0.6, 0.6]

export interface MeshGroup {
  /** 絵の名前 (地図のテクスチャの resourcePath) か、色 (#rrggbb) */
  key: string
  render: RenderMode
  positions: Float32Array
  uvs: Float32Array
  colors: Float32Array
  indices: Uint32Array
}

export interface MeshResult {
  groups: MeshGroup[]
  quads: number
  /** 描いたものを囲む直方体 (ブロック単位) */
  box: number[]
  /** まとめた結果の 1 ます目の大きさ (ブロック) */
  step: number
}

class Builder {
  positions: number[] = []
  uvs: number[] = []
  colors: number[] = []
  quads = 0
}

/**
 * 構造物を四角形にする。四角形が多すぎれば null (呼ぶ側が halve してやり直す)
 */
function build(st: Structure, models: BlockModel[]): { builders: Map<string, Builder>, quads: number, box: number[] } | null {
  const builders = new Map<string, Builder>()
  let quads = 0
  const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
  const s = st.step
  const builder = (key: string, render: RenderMode): Builder => {
    const k = render + '|' + key
    let b = builders.get(k)
    if (!b) builders.set(k, b = new Builder())
    return b
  }
  const push = (b: Builder, v: number[], uv: number[], c: number): void => {
    for (let i = 0; i < 4; i++) {
      const x = v[i * 3]! * s, y = v[i * 3 + 1]! * s, z = v[i * 3 + 2]! * s
      b.positions.push(x, y, z)
      if (x < box[0]!) box[0] = x
      if (y < box[1]!) box[1] = y
      if (z < box[2]!) box[2] = z
      if (x > box[3]!) box[3] = x
      if (y > box[4]!) box[4] = y
      if (z > box[5]!) box[5] = z
      b.uvs.push(uv[i * 2]!, uv[i * 2 + 1]!)
      b.colors.push(((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255)
    }
    b.quads++
    quads++
  }
  const color = (m: BlockModel, face: number): number => {
    const shade = SHADE[face]!
    const t = (m.tintFaces >> face) & 1 ? m.tint : 0xFFFFFF
    return (Math.round(((t >> 16) & 255) * shade) << 16) | (Math.round(((t >> 8) & 255) * shade) << 8) | Math.round((t & 255) * shade)
  }
  const sx = st.sizeX, sy = st.sizeY, sz = st.sizeZ
  for (let y = 0; y < sy; y++) {
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const id = st.blocks[(y * sz + z) * sx + x]!
        if (!id) continue
        const m = models[id]!
        if (m.air) continue
        if (m.cross) {
          // 交差した 2 枚 (両面)
          const b = builder(m.tex[0]!, m.render)
          const c = color(m, NORTH)
          const d = 0.15, e = 0.85
          const planes = [
            [x + d, y, z + d, x + e, y, z + e, x + e, y + 1, z + e, x + d, y + 1, z + d],
            [x + e, y, z + d, x + d, y, z + e, x + d, y + 1, z + e, x + e, y + 1, z + d],
          ]
          for (const p of planes) {
            push(b, p, [0, 1, 1, 1, 1, 0, 0, 0], c)
            push(b, [p[9]!, p[10]!, p[11]!, p[6]!, p[7]!, p[8]!, p[3]!, p[4]!, p[5]!, p[0]!, p[1]!, p[2]!], [0, 0, 1, 0, 1, 1, 0, 1], c)
          }
          if (quads > MAX_QUADS) return null
          continue
        }
        for (const bx of m.boxes) {
          const [x0, y0, z0, x1, y1, z1] = bx as [number, number, number, number, number, number]
          for (let face = 0; face < 6; face++) {
            // ブロックの境目にある面は、隣が隠すなら描かない
            let nx = x, ny = y, nz = z, onEdge = false
            switch (face) {
              case UP: ny++; onEdge = y1 >= 1; break
              case DOWN: ny--; onEdge = y0 <= 0; break
              case NORTH: nz--; onEdge = z0 <= 0; break
              case SOUTH: nz++; onEdge = z1 >= 1; break
              case WEST: nx--; onEdge = x0 <= 0; break
              case EAST: nx++; onEdge = x1 >= 1; break
            }
            if (onEdge && nx >= 0 && ny >= 0 && nz >= 0 && nx < sx && ny < sy && nz < sz) {
              const nid = st.blocks[(ny * sz + nz) * sx + nx]!
              if (nid) {
                const n = models[nid]!
                if (n.occludes) continue
                if (m.cullSame && n.cullSame === m.cullSame) continue
              }
            }
            const X0 = x + x0, X1 = x + x1, Y0 = y + y0, Y1 = y + y1, Z0 = z + z0, Z1 = z + z1
            let v: number[], uv: number[]
            // 頂点は外から見て反時計回り。絵の上 (v = 0) がブロックの上
            switch (face) {
              case UP: v = [X0, Y1, Z0, X0, Y1, Z1, X1, Y1, Z1, X1, Y1, Z0]; uv = [x0, z0, x0, z1, x1, z1, x1, z0]; break
              case DOWN: v = [X0, Y0, Z0, X1, Y0, Z0, X1, Y0, Z1, X0, Y0, Z1]; uv = [x0, 1 - z0, x1, 1 - z0, x1, 1 - z1, x0, 1 - z1]; break
              case NORTH: v = [X1, Y0, Z0, X0, Y0, Z0, X0, Y1, Z0, X1, Y1, Z0]; uv = [1 - x1, 1 - y0, 1 - x0, 1 - y0, 1 - x0, 1 - y1, 1 - x1, 1 - y1]; break
              case SOUTH: v = [X0, Y0, Z1, X1, Y0, Z1, X1, Y1, Z1, X0, Y1, Z1]; uv = [x0, 1 - y0, x1, 1 - y0, x1, 1 - y1, x0, 1 - y1]; break
              case WEST: v = [X0, Y0, Z0, X0, Y0, Z1, X0, Y1, Z1, X0, Y1, Z0]; uv = [z0, 1 - y0, z1, 1 - y0, z1, 1 - y1, z0, 1 - y1]; break
              default: v = [X1, Y0, Z1, X1, Y0, Z0, X1, Y1, Z0, X1, Y1, Z1]; uv = [1 - z1, 1 - y0, 1 - z0, 1 - y0, 1 - z0, 1 - y1, 1 - z1, 1 - y1]
            }
            push(builder(m.tex[face]!, m.render), v, uv, color(m, face))
          }
          if (quads > MAX_QUADS) return null
        }
      }
    }
  }
  return { builders, quads, box }
}

/**
 * 構造物を、絵ごとの四角形の並びにする。
 * @param textures 地図にある絵の名前 (resourcePath)
 */
export function meshStructure(structure: Structure, textures: Iterable<string>): MeshResult {
  const resolver = new TextureResolver(textures)
  let st = structure
  for (;;) {
    const models = st.palette.map(p => blockModel(p, resolver))
    const r = build(st, models)
    if (r) {
      if (r.quads === 0) throw new Error('Structure has no visible blocks')
      const groups: MeshGroup[] = []
      for (const [k, b] of r.builders) {
        const bar = k.indexOf('|')
        const indices = new Uint32Array(b.quads * 6)
        for (let q = 0; q < b.quads; q++) {
          const o = q * 4
          indices.set([o, o + 1, o + 2, o, o + 2, o + 3], q * 6)
        }
        groups.push({
          key: k.substring(bar + 1), render: k.substring(0, bar) as RenderMode,
          positions: new Float32Array(b.positions), uvs: new Float32Array(b.uvs), colors: new Float32Array(b.colors), indices,
        })
      }
      return { groups, quads: r.quads, box: r.box, step: st.step }
    }
    if (st.sizeX * st.sizeY * st.sizeZ <= 1) throw new Error('Structure is too complex')
    st = st.halve()
  }
}
