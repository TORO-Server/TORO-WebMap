// 看板の板 (画像や動画を貼る四角形) と、読めないときなどに貼る種類の絵
import {
  BufferAttribute, BufferGeometry, CanvasTexture, ClampToEdgeWrapping, FrontSide, LinearFilter, LinearMipmapLinearFilter,
  Mesh, MeshBasicMaterial, SRGBColorSpace, type Texture, Vector3,
} from 'three'
import { buildMesh, type MediaKindId } from './core'
import type { RenderContext, Sign } from './types'

/** 前のスクリプトと同じテクスチャの設定 (canvas の 1 行目が絵の上) */
export function setupTexture<T extends Texture>(tex: T, mipmaps = true): T {
  tex.flipY = false
  tex.colorSpace = SRGBColorSpace
  tex.generateMipmaps = mipmaps
  tex.minFilter = mipmaps ? LinearMipmapLinearFilter : LinearFilter
  tex.magFilter = LinearFilter
  tex.wrapS = tex.wrapT = ClampToEdgeWrapping
  return tex
}

/**
 * 看板 1 つの板。MarumaSign 本体と同じ形 (core.ts の buildMesh) で、貼る絵の縦横比に合わせる。
 * 表と裏の 2 枚で、裏向きの面は描かない。
 */
export class Board {
  readonly ctx: RenderContext
  readonly sign: Sign
  mesh: Mesh<BufferGeometry, MeshBasicMaterial> | null = null
  private aspectW = 0
  private aspectH = 0
  /** 押したとき。true を返すと BlueMap の操作に渡さない */
  onClick: () => boolean

  constructor(ctx: RenderContext, sign: Sign) {
    this.ctx = ctx
    this.sign = sign
    this.onClick = () => {
      ctx.showInfo(sign)
      return true
    }
  }

  /** 絵を貼る (大きさが変われば板を作り直す) */
  show(texture: Texture, width: number, height: number, transparent = true): void {
    if (this.mesh && (this.aspectW !== width || this.aspectH !== height)) this.remove()
    if (!this.mesh) {
      const s = this.sign
      const m = buildMesh(s, width, height)
      const geometry = new BufferGeometry()
      geometry.setAttribute('position', new BufferAttribute(m.positions, 3))
      geometry.setAttribute('uv', new BufferAttribute(m.uvs, 2))
      // 表: 0,1,2,3 裏: 4,5,6,7 (MarumaSign 本体と同じ頂点の順。裏向きの面は描かない)
      geometry.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
      geometry.computeBoundingSphere()
      const material = new MeshBasicMaterial({ map: texture, side: FrontSide, transparent, alphaTest: transparent ? 0.02 : 0 })
      const mesh = new Mesh(geometry, material)
      mesh.position.set(s.x, s.y, s.z)
      mesh.frustumCulled = true
      mesh.onClick = () => this.onClick()
      this.mesh = mesh
      this.aspectW = width
      this.aspectH = height
      this.ctx.group.add(mesh)
    }
    else if (this.mesh.material.map !== texture) {
      this.mesh.material.map = texture
      this.mesh.material.needsUpdate = true
    }
    this.ctx.redraw()
  }

  /** 板の下の辺の真ん中 (ワールド座標)。PDF のページ送りの帯を出す場所 */
  bottomCenter(out: Vector3): Vector3 {
    const m = buildMesh(this.sign, this.aspectW || 1, this.aspectH || 1).positions
    // 表の頂点 0 (左下) と 3 (右下)
    return out.set((m[0]! + m[9]!) / 2 + this.sign.x, (m[1]! + m[10]!) / 2 + this.sign.y, (m[2]! + m[11]!) / 2 + this.sign.z)
  }

  /** 板の中心 (ワールド座標) */
  center(out: Vector3): Vector3 {
    const m = buildMesh(this.sign, this.aspectW || 1, this.aspectH || 1).positions
    return out.set((m[0]! + m[6]!) / 2 + this.sign.x, (m[1]! + m[7]!) / 2 + this.sign.y, (m[2]! + m[8]!) / 2 + this.sign.z)
  }

  remove(): void {
    if (!this.mesh) return
    this.ctx.group.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh = null
    this.ctx.redraw()
  }
}

// ---------------------------------------------------------------- 種類の絵 (読み込み中・読めない・音声だけ・まだ描けない種類)

/** MarumaSign 本体の読み込み中の絵 (loading.png) と同じ縦横比 */
export const PLACEHOLDER_WIDTH = 160
export const PLACEHOLDER_HEIGHT = 96

const placeholders = new Map<string, CanvasTexture>()

/**
 * 種類の絵のテクスチャ (すべての看板で共有する。片付けない)。
 * @param state 'loading' 読み込み中、'error' 読めない (CORS が通らない、形式に対応していない、など)、'ok' (音声だけ、止めている動画、まだ描けない種類)
 */
export function placeholder(kind: MediaKindId, state: 'loading' | 'error' | 'ok'): CanvasTexture {
  const key = kind + ':' + state
  let tex = placeholders.get(key)
  if (tex) return tex
  const canvas = document.createElement('canvas')
  canvas.width = PLACEHOLDER_WIDTH * 2
  canvas.height = PLACEHOLDER_HEIGHT * 2
  const g = canvas.getContext('2d')!
  drawPlaceholder(g, canvas.width, canvas.height, kind, state)
  tex = setupTexture(new CanvasTexture(canvas))
  placeholders.set(key, tex)
  return tex
}

function drawPlaceholder(g: CanvasRenderingContext2D, w: number, h: number, kind: MediaKindId, state: 'loading' | 'error' | 'ok'): void {
  // MarumaSign 本体の音声の絵と同じ色 (暗い灰色に緑)。読めないときは赤みのある色
  g.fillStyle = state === 'error' ? '#4a3434' : '#3c3c3c'
  g.fillRect(0, 0, w, h)
  g.strokeStyle = 'rgba(255,255,255,0.25)'
  g.lineWidth = 4
  g.strokeRect(2, 2, w - 4, h - 4)
  const color = state === 'error' ? '#d9776f' : '#6abe30'
  g.fillStyle = color
  g.strokeStyle = color
  g.lineCap = 'round'
  g.lineJoin = 'round'
  const cx = w / 2, cy = h / 2 - h * 0.06
  const u = h / 8
  g.save()
  if (state === 'loading') g.globalAlpha = 0.6
  switch (kind) {
    case 'audio': {
      // スピーカー (MarumaSign 本体の speakerIcon と同じ形)
      const x = cx - h / 6
      g.fillRect(x - u * 2, cy - u, u, u * 2)
      g.beginPath()
      g.moveTo(x - u, cy - u)
      g.lineTo(x + u, cy - u * 2.5)
      g.lineTo(x + u, cy + u * 2.5)
      g.lineTo(x - u, cy + u)
      g.closePath()
      g.fill()
      g.lineWidth = Math.max(2, u / 2)
      for (let i = 1; i <= 3; i++) {
        const r = u * (i + 1)
        g.beginPath()
        g.arc(x + u - r / 2 + r, cy, r, -40 * Math.PI / 180, 40 * Math.PI / 180)
        g.stroke()
      }
      break
    }
    case 'video': {
      // 再生の三角
      g.beginPath()
      g.moveTo(cx - u * 1.6, cy - u * 2)
      g.lineTo(cx + u * 2, cy)
      g.lineTo(cx - u * 1.6, cy + u * 2)
      g.closePath()
      g.fill()
      break
    }
    case 'pdf': {
      // 紙
      g.lineWidth = u / 2.5
      g.beginPath()
      g.moveTo(cx - u * 1.6, cy - u * 2.4)
      g.lineTo(cx + u * 0.8, cy - u * 2.4)
      g.lineTo(cx + u * 1.6, cy - u * 1.6)
      g.lineTo(cx + u * 1.6, cy + u * 2.4)
      g.lineTo(cx - u * 1.6, cy + u * 2.4)
      g.closePath()
      g.stroke()
      for (let i = -1; i <= 1; i++) g.fillRect(cx - u, cy + i * u * 1.1 - u * 0.15, u * 2, u * 0.3)
      break
    }
    case 'model':
    case 'structure': {
      // 立方体
      g.lineWidth = u / 2.5
      const s = u * 1.8
      g.beginPath()
      g.moveTo(cx, cy - s * 1.2)
      g.lineTo(cx + s, cy - s * 0.6)
      g.lineTo(cx + s, cy + s * 0.6)
      g.lineTo(cx, cy + s * 1.2)
      g.lineTo(cx - s, cy + s * 0.6)
      g.lineTo(cx - s, cy - s * 0.6)
      g.closePath()
      g.moveTo(cx - s, cy - s * 0.6)
      g.lineTo(cx, cy)
      g.lineTo(cx + s, cy - s * 0.6)
      g.moveTo(cx, cy)
      g.lineTo(cx, cy + s * 1.2)
      g.stroke()
      break
    }
    case 'splat': {
      for (const [dx, dy, r] of [[0, 0, 1.2], [-1.6, -1, 0.7], [1.5, -1.2, 0.6], [1.2, 1.3, 0.8], [-1.3, 1.4, 0.5]] as const) {
        g.globalAlpha = state === 'loading' ? 0.4 : 0.8
        g.beginPath()
        g.ellipse(cx + dx * u, cy + dy * u, r * u, r * u * 0.7, 0.5, 0, Math.PI * 2)
        g.fill()
      }
      break
    }
    default: {
      // 絵 (山と太陽)
      g.lineWidth = u / 2.5
      g.strokeRect(cx - u * 2.4, cy - u * 1.8, u * 4.8, u * 3.6)
      g.beginPath()
      g.moveTo(cx - u * 2, cy + u * 1.4)
      g.lineTo(cx - u * 0.6, cy - u * 0.2)
      g.lineTo(cx + u * 0.4, cy + u * 0.8)
      g.lineTo(cx + u, cy + u * 0.2)
      g.lineTo(cx + u * 2, cy + u * 1.4)
      g.closePath()
      g.fill()
      g.beginPath()
      g.arc(cx + u * 1.2, cy - u * 0.8, u * 0.5, 0, Math.PI * 2)
      g.fill()
    }
  }
  g.restore()
  if (state !== 'ok') {
    // 下に小さく状態を書く (読み込み中は点 3 つ、読めないときは ×)
    g.fillStyle = color
    const y = h - u * 1.1
    if (state === 'loading') {
      for (let i = -1; i <= 1; i++) {
        g.beginPath()
        g.arc(cx + i * u * 0.8, y, u * 0.22, 0, Math.PI * 2)
        g.fill()
      }
    }
    else {
      g.lineWidth = u / 3
      g.beginPath()
      g.moveTo(cx - u * 0.45, y - u * 0.45)
      g.lineTo(cx + u * 0.45, y + u * 0.45)
      g.moveTo(cx + u * 0.45, y - u * 0.45)
      g.lineTo(cx - u * 0.45, y + u * 0.45)
      g.stroke()
    }
  }
}
