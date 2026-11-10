import L from 'leaflet'

/**
 * 画面の中 (と周りに半画面ずつ) にあるマーカーだけを地図に載せるグループ。
 * 画面の外のマーカーは DOM を作らないので、マーカーが何百あっても動かすのが重くならない。
 * 動かしている途中も 100ms ごとに確かめ、画面に入る前に作っておく
 */
export class CulledMarkerGroup extends L.LayerGroup {
  private readonly all = new Set<L.Marker>()
  private timer: ReturnType<typeof setTimeout> | undefined
  private readonly onMove = (): void => {
    if (this.timer) return
    this.timer = setTimeout(() => { this.timer = undefined; this.refresh() }, 100)
  }

  private readonly onSettle = (): void => this.refresh()

  // 2 つ目の引数は GLMarkerLayer と同じ形にするためのもの (DOM ではアイコンをマーカー自身が描く)
  addMarker(marker: L.Marker, _icon?: unknown): void {
    this.all.add(marker)
    const bounds = this.bounds()
    if (bounds?.contains(marker.getLatLng())) super.addLayer(marker)
  }

  removeMarker(marker: L.Marker): void {
    this.all.delete(marker)
    super.removeLayer(marker)
  }

  clearMarkers(): void {
    this.all.clear()
    super.clearLayers()
  }

  override onAdd(map: L.Map): this {
    super.onAdd(map)
    map.on('move', this.onMove)
    map.on('moveend zoomend viewreset resize', this.onSettle)
    this.refresh()
    return this
  }

  override onRemove(map: L.Map): this {
    map.off('move', this.onMove)
    map.off('moveend zoomend viewreset resize', this.onSettle)
    clearTimeout(this.timer)
    this.timer = undefined
    super.onRemove(map)
    return this
  }

  refresh(): void {
    const bounds = this.bounds()
    if (!bounds) return
    for (const marker of this.all) {
      const show = bounds.contains(marker.getLatLng())
      const shown = this.hasLayer(marker)
      if (show && !shown) super.addLayer(marker)
      // 吹き出しを開いているものは外さない
      else if (!show && shown && !marker.isPopupOpen()) super.removeLayer(marker)
    }
  }

  private bounds(): L.LatLngBounds | undefined {
    const map = (this as unknown as { _map?: L.Map & { _loaded?: boolean } })._map
    // 中心と縮尺が決まる前は画面の範囲が分からない
    if (!map?._loaded) return undefined
    return map.getBounds().pad(0.5)
  }
}
