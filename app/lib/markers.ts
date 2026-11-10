import L from 'leaflet'
import { CulledMarkerGroup } from './culled-group'
import { elementMarker, html } from './element-icon'
import { GLMarkerLayer, HIT_PAD, webglAvailable } from './gl-marker-layer'
import type { GLIcon } from './gl-marker-layer'
import type { AreaMarker, CircleMarker, LineMarker, Location, MarkerFile, MarkerSetFile, PointMarker, ShapeStyle, UpdateEvent } from './types'

// Dynmap のマーカー (web/js/markers.js と同じ見た目と動き)
// - マーカーの組ごとにレイヤーを作り、レイヤーの切り替えに出す
// - 点のマーカーの絵は WebGL でまとめて描く (GLMarkerLayer)。名前を常に出す組と、WebGL が使えないときは、
//   画面の近くのものだけ DOM で作る (CulledMarkerGroup)
// - 表示する縮尺 (minzoom/maxzoom) は、範囲を出入りしたものだけ付け外しする (全部を作り直さない)

type Kind = 'marker' | 'area' | 'line' | 'circle'
type PointGroup = CulledMarkerGroup | GLMarkerLayer

// ?gl=0 で WebGL を使わずに描く (比べるときや、WebGL の具合が悪いとき)
const GL = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('gl') !== '0' && webglAvailable()

interface Item {
  kind: Kind
  data: PointMarker | AreaMarker | LineMarker | CircleMarker
  layer: L.Layer
  shown: boolean
}

interface MarkerSet {
  id: string
  label: string
  layerprio: number
  minzoom: number
  maxzoom: number
  showlabels: boolean
  group: L.LayerGroup
  points: PointGroup
  items: Map<string, Item>
}

export interface MarkerHost {
  map: L.Map
  /** 今の地図の投影で、ワールドの座標を地図の座標にする */
  toLatLng(loc: Location): L.LatLng
  /** tiles/ の URL (マーカーの JSON とアイコン) */
  markersUrl: string
  /** マーカーの組の名前を出すか (markers の設定の showlabel) */
  showLabels: boolean
  addOverlay(layer: L.Layer, name: string, priority: number, visible: boolean): void
  removeOverlay(layer: L.Layer): void
}

const key = (kind: Kind, id: string): string => `${kind}:${id}`
// Dynmap は 0 または負数を「指定なし」(-1) として扱う
export const zoomOrNone = (z: number | undefined | null): number => (typeof z === 'number' && z > 0 ? z : -1)

export class Markers {
  private readonly host: MarkerHost
  private readonly sets = new Map<string, MarkerSet>()
  private loading = 0

  constructor(host: MarkerHost) {
    this.host = host
    host.map.on('zoomend', () => this.applyZoom())
  }

  /** ワールドを変えたとき。前のワールドのマーカーを外し、新しいワールドのものを読む */
  async load(world: string): Promise<void> {
    const ticket = ++this.loading
    for (const set of this.sets.values()) this.clearSet(set)
    const res = await fetch(`${this.host.markersUrl}_markers_/marker_${encodeURIComponent(world)}.json`)
    const file = (await res.json()) as MarkerFile
    if (ticket !== this.loading) return

    // 新しいワールドのファイルにない古いマーカーセットを解除
    for (const [id, set] of [...this.sets]) {
      if (!file.sets || !(id in file.sets)) {
        this.clearSet(set)
        this.host.removeOverlay(set.group)
        this.host.map.removeLayer(set.group)
        this.sets.delete(id)
      }
    }

    for (const [id, s] of Object.entries(file.sets ?? {})) {
      const set = this.ensureSet(id, s)
      for (const [mid, m] of Object.entries(s.markers ?? {})) this.put(set, 'marker', mid, m)
      for (const [aid, a] of Object.entries(s.areas ?? {})) this.put(set, 'area', aid, a)
      for (const [lid, l] of Object.entries(s.lines ?? {})) this.put(set, 'line', lid, l)
      for (const [cid, c] of Object.entries(s.circles ?? {})) this.put(set, 'circle', cid, c)
    }
  }

  /** 地図 (投影) を変えたとき。全部を新しい投影で作り直す */
  reproject(): void {
    for (const set of this.sets.values()) {
      for (const [k, item] of set.items) {
        this.hide(set, item)
        set.items.set(k, this.build(set, item.kind, item.data))
      }
    }
    this.applyZoom()
  }

  /** ワールドの更新で届いたマーカーの変更 (type: component, ctype: markers) */
  handle(msg: UpdateEvent): void {
    // 届いたものは、マーカーの JSON の 1 件と同じ項目を持っている
    const m = msg as unknown
    const set = this.sets.get(String(msg.set ?? ''))
    switch (msg.msg) {
      case 'markerupdated':
        if (set) this.put(set, 'marker', String(msg.id), { ...(m as PointMarker), dim: (msg.dim as string) || '16x16' })
        break
      case 'areaupdated':
        if (set) this.put(set, 'area', String(msg.id), m as AreaMarker)
        break
      case 'lineupdated':
        if (set) this.put(set, 'line', String(msg.id), m as LineMarker)
        break
      case 'circleupdated':
        if (set) this.put(set, 'circle', String(msg.id), m as CircleMarker)
        break
      case 'markerdeleted':
      case 'areadeleted':
      case 'linedeleted':
      case 'circledeleted':
        if (set) this.remove(set, key(String(msg.msg).replace('deleted', '') as Kind, String(msg.id)))
        break
      case 'setupdated':
        this.updateSet(String(msg.id), m as MarkerSetFile)
        break
      case 'setdeleted': {
        const s = this.sets.get(String(msg.id))
        if (s) {
          this.clearSet(s)
          this.host.removeOverlay(s.group)
          this.host.map.removeLayer(s.group)
          this.sets.delete(s.id)
        }
        break
      }
    }
  }

  private ensureSet(id: string, s: MarkerSetFile): MarkerSet {
    let set = this.sets.get(id)
    if (!set) {
      const showlabels = s.showlabels ?? this.host.showLabels
      const points = this.pointGroup(showlabels)
      const group = L.layerGroup([points])
      set = {
        id, label: s.label, layerprio: s.layerprio ?? 0,
        minzoom: zoomOrNone(s.minzoom), maxzoom: zoomOrNone(s.maxzoom),
        showlabels, group, points, items: new Map(),
      }
      this.sets.set(id, set)
      this.host.addOverlay(group, set.label, set.layerprio, !s.hide)
    }
    else {
      if (set.label !== s.label) {
        set.label = s.label
        this.host.addOverlay(set.group, set.label, set.layerprio, this.host.map.hasLayer(set.group))
      }
      set.minzoom = zoomOrNone(s.minzoom)
      set.maxzoom = zoomOrNone(s.maxzoom)
      this.setShowLabels(set, s.showlabels ?? this.host.showLabels)
    }
    return set
  }

  /** 名前を常に出す組は DOM で (名前の札を WebGL では描かない)、それ以外は WebGL で描く */
  private pointGroup(showlabels: boolean): PointGroup {
    return GL && !showlabels ? new GLMarkerLayer() : new CulledMarkerGroup()
  }

  private setShowLabels(set: MarkerSet, showlabels: boolean): void {
    if (set.showlabels === showlabels) return
    set.showlabels = showlabels
    const points = this.pointGroup(showlabels)
    if (points.constructor === set.points.constructor) return
    for (const item of set.items.values()) {
      if (item.kind === 'marker' && item.shown) {
        set.points.removeMarker(item.layer as L.Marker)
        item.shown = false
      }
    }
    set.group.removeLayer(set.points)
    set.points = points
    set.group.addLayer(points)
    this.applyZoom(set)
  }

  private iconOf(item: Item): GLIcon {
    const m = item.data as PointMarker
    return { url: `${this.host.markersUrl}_markers_/${m.icon}.png`, size: Number.parseInt(m.dim, 10) || 16 }
  }

  private updateSet(id: string, s: MarkerSetFile): void {
    const set = this.sets.get(id)
    if (!set) {
      this.ensureSet(id, s)
      return
    }
    const showlabels = s.showlabels ?? this.host.showLabels
    if (set.label !== s.label || set.layerprio !== (s.layerprio ?? 0) || set.showlabels !== showlabels) {
      set.label = s.label
      set.layerprio = s.layerprio ?? 0
      this.setShowLabels(set, showlabels)
      this.host.addOverlay(set.group, set.label, set.layerprio, this.host.map.hasLayer(set.group))
    }
    set.minzoom = zoomOrNone(s.minzoom)
    set.maxzoom = zoomOrNone(s.maxzoom)
    this.applyZoom(set)
  }

  private clearSet(set: MarkerSet): void {
    for (const item of set.items.values()) this.hide(set, item)
    set.items.clear()
    set.points.clearMarkers()
  }

  private put(set: MarkerSet, kind: Kind, id: string, data: Item['data']): void {
    this.remove(set, key(kind, id))
    if ('minzoom' in data) (data as { minzoom?: number }).minzoom = zoomOrNone((data as { minzoom?: number }).minzoom)
    if ('maxzoom' in data) (data as { maxzoom?: number }).maxzoom = zoomOrNone((data as { maxzoom?: number }).maxzoom)
    const item = this.build(set, kind, data)
    set.items.set(key(kind, id), item)
    this.applyZoomTo(set, item, this.host.map.getZoom())
  }

  private remove(set: MarkerSet, k: string): void {
    const item = set.items.get(k)
    if (!item) return
    this.hide(set, item)
    set.items.delete(k)
  }

  private applyZoom(only?: MarkerSet): void {
    const zoom = this.host.map.getZoom()
    for (const set of only ? [only] : this.sets.values()) {
      for (const item of set.items.values()) this.applyZoomTo(set, item, zoom)
    }
  }

  private applyZoomTo(set: MarkerSet, item: Item, zoom: number): void {
    // マーカーごとの指定が組の指定より優先
    const itemMin = zoomOrNone((item.data as { minzoom?: number }).minzoom)
    const itemMax = zoomOrNone((item.data as { maxzoom?: number }).maxzoom)
    const minzoom = itemMin >= 0 ? itemMin : set.minzoom
    let maxzoom = itemMax >= 0 ? itemMax : set.maxzoom
    if (maxzoom < 0) maxzoom = 100
    const show = (minzoom < 0 || zoom >= minzoom) && (maxzoom < 0 || zoom <= maxzoom)
    if (show && !item.shown) {
      if (item.kind === 'marker') set.points.addMarker(item.layer as L.Marker, this.iconOf(item))
      else set.group.addLayer(item.layer)
      item.shown = true
    }
    else if (!show && item.shown) this.hide(set, item)
  }

  private hide(set: MarkerSet, item: Item): void {
    if (!item.shown) return
    if (item.kind === 'marker') set.points.removeMarker(item.layer as L.Marker)
    else set.group.removeLayer(item.layer)
    item.shown = false
  }

  private build(set: MarkerSet, kind: Kind, data: Item['data']): Item {
    const layer = kind === 'marker'
      ? this.pointLayer(set, data as PointMarker)
      : this.shapeLayer(kind, data as AreaMarker | LineMarker | CircleMarker)
    return { kind, data, layer, shown: false }
  }

  private pointLayer(set: MarkerSet, m: PointMarker): L.Marker {
    const marker = elementMarker(this.host.toLatLng(m), () => {
      const div = document.createElement('div')
      div.className = 'Marker mapMarker'
      const img = document.createElement('img')
      img.className = 'markerIcon' + m.dim
      img.src = `${this.host.markersUrl}_markers_/${m.icon}.png`
      div.appendChild(img)
      // アイコンの外側にも透明な当たりを足して、押しやすくする (名前は :hover で出るので、余白にマウスが乗っても出る)
      const pad = document.createElement('span')
      pad.className = 'markerHitPad'
      pad.style.cssText = `position:absolute;left:-${HIT_PAD}px;top:-${HIT_PAD}px;right:-${HIT_PAD}px;bottom:-${HIT_PAD}px;`
      div.appendChild(pad)
      if (m.label !== '') {
        div.appendChild(html('span', `${set.showlabels ? 'markerName-show' : 'markerName'} markerName_${set.id} markerName${m.dim}`, m.label))
      }
      return div
    })
    if (m.desc) marker.bindPopup(html('div', 'MarkerPopup', m.desc), {})
    return marker
  }

  private shapeLayer(kind: Kind, s: AreaMarker | LineMarker | CircleMarker): L.Path {
    const ll = (x: number, y: number, z: number): L.LatLng => this.host.toLatLng({ x, y, z })
    const style: L.PolylineOptions & { fillOpacity?: number, fillColor?: string } = {
      color: s.color, opacity: s.opacity, weight: s.weight, smoothFactor: 0,
    }
    if (kind !== 'line') {
      style.fillOpacity = (s as ShapeStyle).fillopacity
      style.fillColor = (s as ShapeStyle).fillcolor
    }
    let layer: L.Path
    if (kind === 'line') {
      const l = s as LineMarker
      layer = L.polyline(l.x.map((x, i) => ll(x, l.y[i]!, l.z[i]!)), style)
    }
    else if (kind === 'circle') {
      const c = s as CircleMarker
      const xs: number[] = []
      const zs: number[] = []
      for (let i = 0; i < 360; i++) {
        const rad = i * Math.PI / 180
        xs.push(c.xr * Math.sin(rad) + c.x)
        zs.push(c.zr * Math.cos(rad) + c.z)
      }
      delete style.smoothFactor
      layer = outline2D(xs, c.y, zs, style, ll)
    }
    else {
      const a = s as AreaMarker
      if (a.x.length === 2) {
        layer = a.ytop === a.ybottom
          ? box2D(a.x[0]!, a.x[1]!, a.ytop, a.ybottom, a.z[0]!, a.z[1]!, style, ll)
          : box3D(a.x[0]!, a.x[1]!, a.ytop, a.ybottom, a.z[0]!, a.z[1]!, style, ll)
      }
      else {
        layer = a.ytop === a.ybottom
          ? outline2D(a.x, a.ybottom, a.z, style, ll)
          : outline3D(a.x, a.ytop, a.ybottom, a.z, style, ll)
      }
    }
    if (s.label !== '') {
      const cls = kind === 'area' ? 'AreaPopup' : kind === 'line' ? 'LinePopup' : 'CirclePopup'
      layer.bindPopup(html('span', cls, s.desc || s.label).innerHTML, {})
    }
    return layer
  }
}

type LL = (x: number, y: number, z: number) => L.LatLng
type Style = L.PolylineOptions & { fillOpacity?: number }

function box3D(maxx: number, minx: number, maxy: number, miny: number, maxz: number, minz: number, style: Style, ll: LL): L.Path {
  return L.polygon([
    [ll(minx, miny, minz), ll(maxx, miny, minz), ll(maxx, miny, maxz), ll(minx, miny, maxz)],
    [ll(minx, maxy, minz), ll(maxx, maxy, minz), ll(maxx, maxy, maxz), ll(minx, maxy, maxz)],
    [ll(minx, miny, minz), ll(minx, maxy, minz), ll(maxx, maxy, minz), ll(maxx, miny, minz)],
    [ll(maxx, miny, minz), ll(maxx, maxy, minz), ll(maxx, maxy, maxz), ll(maxx, miny, maxz)],
    [ll(minx, miny, maxz), ll(minx, maxy, maxz), ll(maxx, maxy, maxz), ll(maxx, miny, maxz)],
    [ll(minx, miny, minz), ll(minx, maxy, minz), ll(minx, maxy, maxz), ll(minx, miny, maxz)],
  ], style)
}

function box2D(maxx: number, minx: number, _maxy: number, miny: number, maxz: number, minz: number, style: Style, ll: LL): L.Path {
  const ring = [ll(minx, miny, minz), ll(maxx, miny, minz), ll(maxx, miny, maxz), ll(minx, miny, maxz)]
  return (style.fillOpacity ?? 0) <= 0 ? L.polyline([...ring, ring[0]!], style) : L.polygon(ring, style)
}

function outline3D(xs: number[], maxy: number, miny: number, zs: number[], style: Style, ll: LL): L.Path {
  const top = xs.map((x, i) => ll(x, maxy, zs[i]!))
  const bottom = xs.map((x, i) => ll(x, miny, zs[i]!))
  const sides = xs.map((_, i) => {
    const j = (i + 1) % xs.length
    return [top[i]!, bottom[i]!, bottom[j]!, top[j]!]
  })
  return L.polygon([...sides, bottom, top], style)
}

function outline2D(xs: number[], y: number, zs: number[], style: Style, ll: LL): L.Path {
  const ring = xs.map((x, i) => ll(x, y, zs[i]!))
  return (style.fillOpacity ?? 0) <= 0 ? L.polyline([...ring, ring[0]!], style) : L.polygon(ring, style)
}
