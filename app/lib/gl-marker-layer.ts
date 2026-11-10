import L from 'leaflet'

/**
 * 点のマーカーの絵を WebGL でまとめて描くレイヤー (GPU で描くので、何百あっても動かすのが重くならない)。
 * 見た目は Dynmap の CSS と同じ: アイコンは点を中心に dim の大きさ (8/16/32px)、画素は補間しない (image-rendering: pixelated)。
 * マウスを乗せたマーカーだけ、元の DOM のマーカー (L.Marker) を上に重ねる。名前 (:hover で出る) と吹き出しはそれが今までどおり出す
 */

export interface GLIcon {
  url: string
  /** 表示する大きさ (px) */
  size: number
}

type GLMarker = L.Marker & { glIcon: GLIcon }

interface Atlas {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  cells: Map<string, { u0: number, v0: number, u1: number, v1: number }>
  next: number
  dirty: boolean
}

const ATLAS_SIZE = 2048
// Leaflet のズームの動き (.leaflet-zoom-anim の transition: transform 0.25s cubic-bezier(0,0,0.25,1)) に合わせる
const ZOOM_MS = 250
// アイコンの絵の外側にも足すクリック・ホバーの当たりの余白 (px)。8〜16px の小さなアイコンでも押しやすくする。
// DOM のマーカー側の余白 (markers.ts の HIT_PAD) と同じ値にする
export const HIT_PAD = 10

const VERTEX = `
attribute vec2 a_pos;
attribute vec2 a_uv;
uniform vec2 u_size;
varying vec2 v_uv;
void main() {
  vec2 p = a_pos / u_size * 2.0 - 1.0;
  gl_Position = vec4(p.x, -p.y, 0.0, 1.0);
  v_uv = a_uv;
}`
const FRAGMENT = `
precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
void main() { gl_FragColor = texture2D(u_tex, v_uv); }`

/** cubic-bezier(0, 0, 0.25, 1) の時刻 t (0..1) での進み具合 */
function ease(t: number): number {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const s = (lo + hi) / 2
    const x = 3 * (1 - s) * s * s * 0.25 + s * s * s
    if (x < t) lo = s
    else hi = s
  }
  const s = (lo + hi) / 2
  return 3 * (1 - s) * s * s + s * s * s
}

export function webglAvailable(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl', { premultipliedAlpha: true })
  }
  catch {
    return false
  }
}

export class GLMarkerLayer extends L.Layer {
  private readonly markers = new Set<GLMarker>()
  /** マウスを乗せている、または吹き出しを開いているマーカー (DOM で上に重ねる) */
  private readonly overlay = L.layerGroup()
  private readonly canvas: HTMLCanvasElement = (() => {
    const c = L.DomUtil.create('canvas', 'dynmap-gl-markers') as HTMLCanvasElement
    c.style.position = 'absolute'
    c.style.pointerEvents = 'none'
    c.style.display = 'none'
    return c
  })()
  private gl: WebGLRenderingContext | undefined
  private program!: WebGLProgram
  private buffer!: WebGLBuffer
  private texture!: WebGLTexture
  private atlas!: Atlas
  private images = new Map<string, HTMLImageElement>()
  private failedIcons = new Set<string>()
  private origin = L.point(0, 0)
  private frame = 0
  private anim: { start: number, from: Map<GLMarker, L.Point>, to: Map<GLMarker, L.Point> } | null = null
  /** 最後に描いた位置 (当たり判定に使う。描いた順 = 下から上) */
  private drawn: { marker: GLMarker, x: number, y: number, half: number }[] = []

  addMarker(marker: L.Marker, icon: GLIcon): void {
    const m = marker as GLMarker
    m.glIcon = icon
    this.markers.add(m)
    this.loadIcon(icon)
    this.schedule()
  }

  removeMarker(marker: L.Marker): void {
    const m = marker as GLMarker
    this.markers.delete(m)
    if (this.hovered === m) this.hovered = null
    this.overlay.removeLayer(m)
    this.drawn = this.drawn.filter(d => d.marker !== m)
    this.schedule()
  }

  clearMarkers(): void {
    this.markers.clear()
    this.hovered = null
    this.overlay.clearLayers()
    this.drawn = []
    this.schedule()
  }

  override onAdd(map: L.Map): this {
    let pane = map.getPane('dynmapGLMarkers')
    if (!pane) {
      pane = map.createPane('dynmapGLMarkers')
      // 道や範囲 (overlayPane, 400) より上、DOM のマーカー (markerPane, 600) より下
      pane.style.zIndex = '590'
      pane.style.pointerEvents = 'none'
    }
    if (this.canvas.parentElement !== pane) pane.appendChild(this.canvas)
    this.overlay.addTo(map)
    map.on('move zoomend viewreset resize', this.schedule, this)
    map.on('zoomanim', this.onZoomAnim, this)
    map.on('mousemove', this.onMouseMove, this)
    map.on('mouseout', this.onMouseOut, this)
    map.on('click', this.onClick, this)
    this.schedule()
    return this
  }

  override onRemove(map: L.Map): this {
    map.off('move zoomend viewreset resize', this.schedule, this)
    map.off('zoomanim', this.onZoomAnim, this)
    map.off('mousemove', this.onMouseMove, this)
    map.off('mouseout', this.onMouseOut, this)
    map.off('click', this.onClick, this)
    cancelAnimationFrame(this.frame)
    this.frame = 0
    this.unhover(true)
    this.overlay.remove()
    this.canvas.remove()
    return this
  }

  // ---- WebGL ----

  // 点のマーカーが無い組 (範囲や線だけの組) では WebGL を使わない
  private initGL(): void {
    if (this.gl) return
    const gl = this.canvas.getContext('webgl', { premultipliedAlpha: true, antialias: false })
    if (!gl) return
    this.gl = gl

    this.canvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      cancelAnimationFrame(this.frame)
      this.frame = 0
    })
    this.canvas.addEventListener('webglcontextrestored', () => {
      this.gl = undefined
      this.schedule()
    })

    const shader = (type: number, src: string): WebGLShader => {
      const s = gl.createShader(type)!
      gl.shaderSource(s, src)
      gl.compileShader(s)
      return s
    }
    const p = gl.createProgram()!
    gl.attachShader(p, shader(gl.VERTEX_SHADER, VERTEX))
    gl.attachShader(p, shader(gl.FRAGMENT_SHADER, FRAGMENT))
    gl.linkProgram(p)
    this.program = p
    this.buffer = gl.createBuffer()!
    this.texture = gl.createTexture()!
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = ATLAS_SIZE
    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    this.atlas = { canvas, ctx, cells: new Map(), next: 0, dirty: true }
  }

  private loadIcon(icon: GLIcon): void {
    if (this.images.has(icon.url) || this.failedIcons.has(icon.url)) return
    const img = new Image()
    img.onload = () => {
      // 地図帳を描き直す (大きさの決まった枠に順に詰めているので、読めた絵が増えたら最初から)
      if (this.atlas) {
        this.atlas.cells.clear()
        this.atlas.next = 0
      }
      this.schedule()
    }
    img.onerror = () => {
      this.failedIcons.add(icon.url)
      this.schedule()
    }
    img.src = icon.url
    this.images.set(icon.url, img)
  }

  /** アイコンを画面の画素の大きさで地図帳 (1 枚のテクスチャ) に描く */
  private cell(icon: GLIcon, dpr: number): { u0: number, v0: number, u1: number, v1: number } | undefined {
    const isFailed = this.failedIcons.has(icon.url)
    const img = this.images.get(icon.url)
    if (!isFailed && (!img?.complete || img.naturalWidth === 0)) return undefined
    const px = Math.round(icon.size * dpr)
    const key = `${icon.url}@${px}`
    let c = this.atlas.cells.get(key)
    if (!c) {
      const slot = 100
      const perRow = Math.floor(ATLAS_SIZE / slot)
      const i = this.atlas.next++
      if (i >= perRow * perRow) return undefined
      const x = (i % perRow) * slot
      const y = Math.floor(i / perRow) * slot
      this.atlas.ctx.clearRect(x, y, slot, slot)
      if (isFailed || !img) {
        // 画像読み込み失敗時のフォールバック (赤いマーカー風のプレースホルダー)
        this.atlas.ctx.fillStyle = '#e74c3c'
        this.atlas.ctx.fillRect(x + 2, y + 2, Math.max(4, px - 4), Math.max(4, px - 4))
        this.atlas.ctx.strokeStyle = '#c0392b'
        this.atlas.ctx.lineWidth = 1
        this.atlas.ctx.strokeRect(x + 2, y + 2, Math.max(4, px - 4), Math.max(4, px - 4))
      }
      else {
        this.atlas.ctx.drawImage(img, x, y, px, px)
      }
      c = { u0: x / ATLAS_SIZE, v0: y / ATLAS_SIZE, u1: (x + px) / ATLAS_SIZE, v1: (y + px) / ATLAS_SIZE }
      this.atlas.cells.set(key, c)
      this.atlas.dirty = true
    }
    return c
  }

  private schedule(): void {
    if (this.frame) return
    this.frame = requestAnimationFrame(() => {
      this.frame = 0
      this.draw()
    })
  }

  private draw(): void {
    const map = (this as unknown as { _map?: L.Map & { _loaded?: boolean } })._map
    if (!map?._loaded) return
    if (this.markers.size === 0) {
      this.canvas.style.display = 'none'
      return
    }
    if (!this.gl) {
      this.initGL()
      if (!this.gl) return
    }
    this.canvas.style.display = ''
    const size = map.getSize()
    const dpr = window.devicePixelRatio || 1
    // 画面とその周りに半画面ずつ描いておき、動かしているあいだも端が欠けないようにする
    const pad = size.multiplyBy(0.5).round()
    this.origin = map.containerPointToLayerPoint(pad.multiplyBy(-1)).round()
    const full = size.add(pad.multiplyBy(2))
    L.DomUtil.setPosition(this.canvas, this.origin)
    this.canvas.style.width = `${full.x}px`
    this.canvas.style.height = `${full.y}px`
    const w = Math.round(full.x * dpr)
    const h = Math.round(full.y * dpr)
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w
      this.canvas.height = h
    }

    let t = 1
    if (this.anim) {
      t = Math.min(1, (performance.now() - this.anim.start) / ZOOM_MS)
      if (t >= 1) this.anim = null
      else this.schedule()
    }

    // 下にあるマーカーほど上に描く (Leaflet は y で重なりの順を決める)
    const items: { marker: GLMarker, p: L.Point }[] = []
    const bounds = L.bounds(L.point(-48, -48), full.add(L.point(48, 48)))
    for (const marker of this.markers) {
      let p: L.Point
      if (this.anim) {
        const a = this.anim.from.get(marker)
        const b = this.anim.to.get(marker)
        p = a && b ? a.add(b.subtract(a).multiplyBy(ease(t))) : map.latLngToLayerPoint(marker.getLatLng())
      }
      else p = map.latLngToLayerPoint(marker.getLatLng())
      p = p.subtract(this.origin).round()
      if (bounds.contains(p)) items.push({ marker, p })
    }
    items.sort((a, b) => a.p.y - b.p.y)

    const verts = new Float32Array(items.length * 24)
    let n = 0
    this.drawn = []
    for (const { marker, p } of items) {
      const icon = marker.glIcon
      const c = this.cell(icon, dpr)
      // アイコンは点を中心に置く (CSS の translate(-50%, -50%))
      const half = icon.size / 2
      this.drawn.push({ marker, x: p.x - pad.x, y: p.y - pad.y, half })
      // 吹き出しを開いているもの・マウスを乗せているものは DOM で描くので、ここでは描かない
      if (!c || this.overlay.hasLayer(marker)) continue
      const x0 = Math.round((p.x - half) * dpr)
      const y0 = Math.round((p.y - half) * dpr)
      const x1 = x0 + Math.round(icon.size * dpr)
      const y1 = y0 + Math.round(icon.size * dpr)
      verts.set([x0, y0, c.u0, c.v0, x1, y0, c.u1, c.v0, x0, y1, c.u0, c.v1, x0, y1, c.u0, c.v1, x1, y0, c.u1, c.v0, x1, y1, c.u1, c.v1], n * 24)
      n++
    }

    const gl = this.gl!
    gl.viewport(0, 0, w, h)
    gl.clearColor(0, 0, 0, 0)
    gl.clear(gl.COLOR_BUFFER_BIT)
    if (n === 0) return
    gl.useProgram(this.program)
    gl.bindTexture(gl.TEXTURE_2D, this.texture)
    if (this.atlas.dirty) {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.atlas.canvas)
      this.atlas.dirty = false
    }
    gl.enable(gl.BLEND)
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer)
    gl.bufferData(gl.ARRAY_BUFFER, verts.subarray(0, n * 24), gl.DYNAMIC_DRAW)
    const pos = gl.getAttribLocation(this.program, 'a_pos')
    const uv = gl.getAttribLocation(this.program, 'a_uv')
    gl.enableVertexAttribArray(pos)
    gl.enableVertexAttribArray(uv)
    gl.vertexAttribPointer(pos, 2, gl.FLOAT, false, 16, 0)
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8)
    gl.uniform2f(gl.getUniformLocation(this.program, 'u_size'), w, h)
    gl.drawArrays(gl.TRIANGLES, 0, n * 6)
  }

  /** ズームの動きのあいだ、マーカーを今の位置から新しい縮尺での位置へ滑らかに動かす (DOM のマーカーと同じ) */
  private onZoomAnim(e: L.ZoomAnimEvent): void {
    const map = (this as unknown as { _map: L.Map & { _latLngToNewLayerPoint(ll: L.LatLng, zoom: number, center: L.LatLng): L.Point } })._map
    const from = new Map<GLMarker, L.Point>()
    const to = new Map<GLMarker, L.Point>()
    for (const m of this.markers) {
      from.set(m, map.latLngToLayerPoint(m.getLatLng()))
      to.set(m, map._latLngToNewLayerPoint(m.getLatLng(), e.zoom, e.center))
    }
    this.anim = { start: performance.now(), from, to }
    this.schedule()
  }

  // ---- マウスとタップ ----

  /** 画面上の点 (container の座標) にある、いちばん上のマーカー */
  private hit(p: L.Point): GLMarker | undefined {
    // 現在ホバー中のマーカーがあり、そのマーカーの判定範囲内にいる場合はそれを維持
    if (this.hovered) {
      const hd = this.drawn.find(x => x.marker === this.hovered)
      if (hd && this.hitArea(hd.marker, p, true)) return hd.marker
    }
    for (let i = this.drawn.length - 1; i >= 0; i--) {
      const d = this.drawn[i]!
      if (this.hitArea(d.marker, p, false)) return d.marker
    }
    return undefined
  }

  /** マウスを乗せているマーカー (DOM で重ねている) */
  private hovered: GLMarker | null = null

  private show(marker: GLMarker): void {
    if (this.hovered === marker) return
    this.unhover()
    this.hovered = marker
    if (this.overlay.hasLayer(marker)) return
    this.overlay.addLayer(marker)
    // 吹き出しを閉じたとき、マウスが離れていれば外す
    marker.once('popupclose', () => {
      if (this.hovered !== marker) this.drop(marker)
    })
    this.schedule()
  }

  private isElementHovered(marker: GLMarker): boolean {
    try {
      const el = marker.getElement()
      return !!el && el.matches(':hover')
    }
    catch {
      return false
    }
  }

  /** マウスが離れたマーカーを外す (吹き出しを開いているものや DOM にマウスがあるものは残す) */
  private unhover(force = false): void {
    const m = this.hovered
    if (!m) return
    if (!force && (this.isElementHovered(m) || m.isPopupOpen())) return
    this.hovered = null
    this.drop(m)
  }

  private drop(marker: GLMarker): void {
    this.overlay.removeLayer(marker)
    this.schedule()
  }

  /** マーカーの当たりの範囲: アイコンの絵 (点を中心に size 四方) と、ラベル表示領域 */
  private hitArea(marker: GLMarker, p: L.Point, isHovered: boolean): boolean {
    const d = this.drawn.find(x => x.marker === marker)
    if (!d) return false
    const dx = p.x - d.x
    const dy = p.y - d.y
    const reach = d.half + HIT_PAD
    const inIcon = Math.abs(dx) <= reach && Math.abs(dy) <= reach
    if (inIcon) return true
    if (isHovered) {
      // ホバー中に出る名前ラベル (.markerName: top -12px, left 12px) の領域も許容
      return dx >= -reach && dx <= Math.max(d.half * 2, 280) && dy >= -24 && dy <= reach + 6
    }
    return false
  }

  // DOM のマーカーの上でも地図の mousemove は来るので、これだけで出入りを決める
  private onMouseMove(e: L.LeafletMouseEvent): void {
    if (this.anim) return
    const m = this.hit(e.containerPoint)
    if (m) this.show(m)
    else this.unhover()
  }

  private onMouseOut(): void {
    this.unhover()
  }

  private onClick(e: L.LeafletMouseEvent): void {
    // マウスでは重ねた DOM のマーカーがクリックを受けるので、ここに来るのはタップのときなど
    const m = this.hit(e.containerPoint)
    if (!m) return
    this.show(m)
    m.openPopup()
  }
}
