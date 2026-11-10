import L from 'leaflet'
import type { MapConfig } from './types'

// Dynmap の HD 地図のタイル (web/js/hdmap.js の HDMapType と dynmaputils.js の DynmapTileLayer と同じ名前のタイルを読む)
// - 描き直したタイルは、ワールドの更新で届いた時刻を ?timestamp= に付けて読み直す
// - それ以外のタイルには時刻を付けない (毎回同じ URL なので、ブラウザと Cloudflare にキャッシュが効く)

type TileImage = HTMLImageElement & { tileName?: string }

export class HDTileLayer extends L.TileLayer {
  private readonly named = new Map<string, TileImage>()

  constructor(
    private readonly map: MapConfig,
    private readonly worldName: string,
    private readonly tilesUrl: string,
    private readonly isDay: () => boolean,
  ) {
    super('', {
      minZoom: 0,
      maxZoom: map.mapzoomin + map.mapzoomout,
      maxNativeZoom: map.mapzoomout,
      tileSize: 128 << (map.tilescale || 0),
      zoomReverse: true,
      errorTileUrl: 'images/blank.png',
    })
  }

  override createTile(coords: L.Coords, done: L.DoneCallback): HTMLElement {
    const tile: TileImage = document.createElement('img')
    tile.alt = ''
    tile.setAttribute('role', 'presentation')
    const name = this.tileName(coords)
    tile.tileName = name
    this.named.set(name, tile)
    // 描き直しで src を変えたときにも load が来るので、Leaflet には最初の 1 回だけ知らせる
    let first = true
    const finish = (error?: Error): void => {
      if (first) done(error, tile)
      first = false
    }
    L.DomEvent.on(tile, 'load', () => finish())
    L.DomEvent.on(tile, 'error', () => {
      const blank = this.options.errorTileUrl
      if (blank && !tile.src.endsWith(blank)) tile.src = blank
      finish(new Error('tile'))
    })
    tile.src = this.urlFor(name)
    return tile
  }

  // Leaflet の内部 (タイルを外すとき) に合わせて、名前の表からも外す
  _removeTile(key: string): void {
    const tile = (this as unknown as { _tiles: Record<string, { el: TileImage }> })._tiles[key]
    if (tile?.el.tileName && this.named.get(tile.el.tileName) === tile.el) this.named.delete(tile.el.tileName)
    // @ts-expect-error Leaflet の内部のメソッド
    super._removeTile(key)
  }

  /** ワールドの更新で「このタイルを描き直した」と届いたとき */
  updateNamedTile(name: string, timestamp: number): void {
    const tile = this.named.get(name)
    if (tile) tile.src = this.urlFor(name, timestamp)
  }

  private urlFor(name: string, timestamp?: number): string {
    const url = this.tilesUrl + encodeURIComponent(this.worldName) + '/' + name
    return timestamp === undefined ? url : `${url}?timestamp=${timestamp}`
  }

  private tileName(coords: L.Coords): string {
    // zoomReverse を反映した縮小の段
    const izoom: number = this._getZoomForUrl()
    const zoomout = Math.max(0, izoom - this.map.mapzoomin)
    const scale = 1 << zoomout
    const x = scale * coords.x
    // HD 地図は y が逆
    const y = -(scale * coords.y)
    const zoom = zoomout === 0 ? '' : 'z'.repeat(zoomout) + '_'
    const day = this.map.nightandday && this.isDay() ? '_day' : ''
    return `${this.map.prefix}${day}/${x >> 5}_${y >> 5}/${zoom}${x}_${y}.${this.map['image-format'] || 'png'}`
  }
}
