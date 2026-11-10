// Dynmap のブラウザ側 (web/js/*.js) を、見た目を変えずに軽くする。
// toro-edge が index.html の standalone/config.js の前にこのスクリプトを差し込む。leaflet.js, custommarker.js, dynmaputils.js などは読み終わっている。
//
// 1. ズームのたびに Dynmap は全マーカーを外して付け直す (markers.js の updateMarker)。外してすぐ付け直すものは DOM に触らない
// 2. 画面の外 (と周りに半画面ずつ) のマーカーは DOM を作らず、近づいたら作る
// 3. タイルの URL にページを開いた時刻を付けない (毎回違う URL になり、ブラウザにも Cloudflare にもキャッシュが効かない)。描き直したタイルには今までどおり時刻が付く
// 4. 同時に読み込むタイルを 5 枚から 16 枚にする

import type * as Leaflet from 'leaflet'

declare const L: typeof Leaflet & { CustomMarker: typeof Leaflet.Marker }
declare const DynmapTileLayer: { prototype: DynmapTileLayerProto }

interface DynmapTileLayerProto {
  _cachedTileUrls: Record<string, string>
  _loadQueue: HTMLImageElement[]
  _loadingTiles: HTMLImageElement[]
  options: { dynmap: { getTileUrl(name: string): string } }
  getTileUrlFromName(this: DynmapTileLayerProto, tileName: string, timestamp?: number): string
  _tickLoadQueue(this: DynmapTileLayerProto): void
}

type LayerWithId = Leaflet.Layer & { _leaflet_id?: number }
type GroupInternals = Leaflet.LayerGroup & { _map?: Leaflet.Map, _layers: Record<number, Leaflet.Layer> }

const MAX_LOADING_TILES = 16
const CULL_PADDING = 0.5

// ---- 3, 4: タイル ----

DynmapTileLayer.prototype.getTileUrlFromName = function (tileName, timestamp) {
  let url = this._cachedTileUrls[tileName]
  if (!url) this._cachedTileUrls[tileName] = url = this.options.dynmap.getTileUrl(tileName)
  if (timestamp !== undefined) url += (url.includes('?') ? '&' : '?') + 'timestamp=' + timestamp
  return url
}

DynmapTileLayer.prototype._tickLoadQueue = function () {
  while (this._loadingTiles.length < MAX_LOADING_TILES) {
    const next = this._loadQueue.shift()
    if (!next) return
    this._loadingTiles.push(next)
    next.src = (next as HTMLImageElement & { url: string }).url
  }
}

// ---- 1: 外してすぐ付け直すものは DOM に触らない ----

const groupRemove = L.LayerGroup.prototype.removeLayer
const groupAdd = L.LayerGroup.prototype.addLayer
const groupOnRemove = L.LayerGroup.prototype.onRemove
// 地図から外すのを待っているもの (グループごと)
const pendingRemoval = new Map<GroupInternals, Set<Leaflet.Layer>>()
let flushScheduled = false

function flushRemovals(only?: GroupInternals): void {
  for (const [group, layers] of pendingRemoval) {
    if (only && group !== only) continue
    pendingRemoval.delete(group)
    for (const layer of layers) if (group._map) group._map.removeLayer(layer)
  }
}

L.LayerGroup.include({
  removeLayer(this: GroupInternals, layer: Leaflet.Layer | number) {
    const l = typeof layer === 'number' ? this._layers[layer] : layer
    // まだこのグループに入っていないもの (新しく作ったマーカー) は、そのまま渡す
    if (!l || !this._map || !(l instanceof L.Marker) || this._layers[L.Util.stamp(l)] !== l) return groupRemove.call(this, layer as Leaflet.Layer)
    delete this._layers[L.Util.stamp(l)]
    let set = pendingRemoval.get(this)
    if (!set) pendingRemoval.set(this, set = new Set())
    set.add(l)
    if (!flushScheduled) {
      flushScheduled = true
      // 同じ処理の中 (描画の前) に外したままのものだけ、本当に外す
      queueMicrotask(() => { flushScheduled = false; flushRemovals() })
    }
    return this
  },
  addLayer(this: GroupInternals, layer: Leaflet.Layer) {
    const set = pendingRemoval.get(this)
    if (set?.delete(layer)) {
      this._layers[L.Util.stamp(layer)] = layer
      return this
    }
    return groupAdd.call(this, layer)
  },
  onRemove(this: GroupInternals, map: Leaflet.Map) {
    flushRemovals(this)
    return groupOnRemove.call(this, map)
  },
})

// ---- 2: 画面の外のマーカーは DOM を作らない ----

const mapAdd = L.Map.prototype.addLayer
const mapRemove = L.Map.prototype.removeLayer
const mapHas = L.Map.prototype.hasLayer
const markerSetLatLng = L.Marker.prototype.setLatLng
// 地図には載っている扱いだが、画面の外なので DOM を作っていないもの
const culled = new Map<Leaflet.Map, Set<Leaflet.Marker>>()
// DOM を作ったもの (画面の外に出たら外す)
const shown = new Map<Leaflet.Map, Set<Leaflet.Marker>>()

function setOf(m: Map<Leaflet.Map, Set<Leaflet.Marker>>, map: Leaflet.Map): Set<Leaflet.Marker> {
  let s = m.get(map)
  if (!s) m.set(map, s = new Set())
  return s
}

function cullable(layer: Leaflet.Layer): layer is Leaflet.Marker {
  return layer instanceof L.CustomMarker
}

function visibleBounds(map: Leaflet.Map): Leaflet.LatLngBounds {
  return map.getBounds().pad(CULL_PADDING)
}

// 中心と縮尺が決まる前は画面の範囲が分からないので、間引かない
function ready(map: Leaflet.Map): boolean {
  return (map as Leaflet.Map & { _loaded?: boolean })._loaded === true
}

L.Map.include({
  addLayer(this: Leaflet.Map, layer: Leaflet.Layer) {
    if (cullable(layer) && ready(this) && !visibleBounds(this).contains(layer.getLatLng())) {
      setOf(culled, this).add(layer)
      return this
    }
    if (cullable(layer)) setOf(shown, this).add(layer)
    return mapAdd.call(this, layer)
  },
  removeLayer(this: Leaflet.Map, layer: Leaflet.Layer) {
    if (cullable(layer)) {
      shown.get(this)?.delete(layer)
      if (culled.get(this)?.delete(layer)) return this
    }
    return mapRemove.call(this, layer)
  },
  hasLayer(this: Leaflet.Map, layer: Leaflet.Layer) {
    return (cullable(layer) && !!culled.get(this)?.has(layer)) || mapHas.call(this, layer)
  },
})

// 画面の外にいるあいだに動いたマーカー (プレイヤーなど) が画面に入ったら DOM を作る
L.Marker.include({
  setLatLng(this: Leaflet.Marker, latlng: Leaflet.LatLngExpression) {
    const result = markerSetLatLng.call(this, latlng)
    for (const [map, set] of culled) {
      if (set.has(this) && ready(map) && visibleBounds(map).contains(this.getLatLng())) {
        set.delete(this)
        setOf(shown, map).add(this)
        mapAdd.call(map, this)
      }
    }
    return result
  },
})

function recull(map: Leaflet.Map): void {
  if (!ready(map)) return
  const bounds = visibleBounds(map)
  const hidden = setOf(culled, map)
  const visible = setOf(shown, map)
  for (const marker of hidden) {
    if (bounds.contains(marker.getLatLng())) {
      hidden.delete(marker)
      visible.add(marker)
      mapAdd.call(map, marker)
    }
  }
  for (const marker of visible) {
    // 吹き出しを開いているものは外さない
    if (!bounds.contains(marker.getLatLng()) && !marker.isPopupOpen()) {
      visible.delete(marker)
      mapRemove.call(map, marker)
      hidden.add(marker)
    }
  }
}

L.Map.addInitHook(function (this: Leaflet.Map) {
  let timer: ReturnType<typeof setTimeout> | undefined
  // 動かしている途中も 100ms ごとに確かめ、画面に入る前に作っておく
  const onMove = (): void => {
    if (timer) return
    timer = setTimeout(() => { timer = undefined; recull(this) }, 100)
  }
  this.on('move', onMove)
  this.on('moveend zoomend viewreset resize', () => recull(this))
  this.on('unload', () => { culled.delete(this); shown.delete(this) })
})

export {}
