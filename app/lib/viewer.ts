import L from 'leaflet'
import { reactive, shallowRef } from 'vue'
import { elementMarker } from './element-icon'
import { Markers } from './markers'
import { toLatLng, toLocation } from './projection'
import { sanitizeHtml } from './sanitize-html'
import { HDTileLayer } from './tile-layer'
import { isServerDay } from './time'
import { boolParam, intParam, param } from './url'
import type { ComponentConfig, Configuration, Location, MapConfig, PlayerUpdate, UpdateEvent, WorldConfig, WorldUpdate } from './types'

// Dynmap の地図の画面 (web/js/map.js の DynMap と、playermarkers.js, chat*.js, coord.js, link.js の代わり)
// 見た目は Dynmap の CSS (css/dynmap_style.css) をそのまま使うので、同じクラス名の要素を作る

const URLS = {
  configuration: 'up/configuration',
  update: (world: string, ts: number) => `up/world/${encodeURIComponent(world)}/${ts}`,
  tiles: 'tiles/',
  markers: 'tiles/',
}

// worlds.txt の extrazoomout を増やすと、縮小した段が増え、Leaflet のズームの数 (0 がいちばん縮小) がずれる。
// リンクの zoom= と configuration.txt の defaultzoom は extrazoomout が 2 のときの数のまま扱い、
// 前に共有されたリンクや最初の表示が同じ縮尺になるようにする (それより縮小すると zoom= は負になる)
const LINK_EXTRAZOOMOUT = 2

function zoomOffset(world: WorldConfig): number {
  return Math.max(0, (world.extrazoomout ?? LINK_EXTRAZOOMOUT) - LINK_EXTRAZOOMOUT)
}

export interface Player extends Location {
  account: string
  name: string
  world: string
  health?: number
  armor?: number
  sort: number
}

/** WebSocket で届くプレイヤーの位置 (server/utils/live.ts) */
interface LivePlayer extends Location {
  account: string
  world: string
  health: number
  armor: number
}

export interface ChatRow {
  id: number
  html?: string
  text?: string
  name?: string
  channel?: string
  face?: string
}

export interface ViewerState {
  ready: boolean
  config: Configuration | null
  world: string
  map: string
  players: Player[]
  following: string | null
  currentcount: number
  servertime: number
  hasStorm: boolean
  isThundering: boolean
  updated: number
  alert: string | null
  chat: ChatRow[]
  nogui: boolean
  nocompass: boolean
  nopanel: boolean
  hidechat: boolean
  sidebarMode: string
}

export class DynmapViewer {
  readonly state = reactive<ViewerState>({
    ready: false, config: null, world: '', map: '', players: [], following: null, currentcount: 0,
    servertime: -1, hasStorm: false, isThundering: false, updated: 0, alert: null, chat: [],
    nogui: false, nocompass: false, nopanel: false, hidechat: false, sidebarMode: 'pinned',
  })

  /** 今の地図の設定 (投影に使う) */
  readonly currentMap = shallowRef<MapConfig | null>(null)

  private map!: L.Map
  private config!: Configuration
  private worlds = new Map<string, WorldConfig>()
  private lastCenter = new Map<string, Location>()
  private tileLayer: HDTileLayer | null = null
  private layerControl: L.Control.Layers | null = null
  private overlays: { layer: L.Layer, name: string, priority: number }[] = []
  private markers!: Markers
  private playerGroup = L.layerGroup()
  private playerMarkers = new Map<string, { marker: L.Marker, el: HTMLElement | null }>()
  private balloons = new Map<string, { popup: L.Popup, lines: string[], timer: ReturnType<typeof setTimeout> }>()
  private lasttimestamp = Date.now()
  private ws: WebSocket | null = null
  private live = false
  private wsRetry = 2000
  /** WebSocket でプレイヤーの位置が最後に届いた時刻 (この間は Dynmap の 2 秒ごとの古い位置で戻さない) */
  private liveAt = new Map<string, number>()
  private glides = new Map<L.Marker, { from: L.LatLng, to: L.LatLng, start: number }>()
  private glideFrame = 0
  private missed = 0
  private serverday = false
  private chatId = 0
  private urlTimer: ReturnType<typeof setTimeout> | undefined
  private component<T extends ComponentConfig>(type: string): T | undefined {
    return this.config.components.find(c => c.type === type) as T | undefined
  }

  async start(container: HTMLElement): Promise<void> {
    const res = await fetch(URLS.configuration)
    if (!res.ok) throw new Error(`Could not retrieve configuration: ${res.status}`)
    this.config = (await res.json()) as Configuration
    this.state.config = this.config
    if (this.config.title) document.title = this.config.title

    for (const w of this.config.worlds) this.worlds.set(w.name, w)
    const first = this.config.worlds[0]!
    let world = this.worlds.get(param('worldname') || this.config.defaultworld || '') ?? first
    const mapName = param('mapname') || this.config.defaultmap || ''
    const map = world.maps.find(m => m.name === mapName) ?? world.maps.find(m => m.name === this.config.defaultmap) ?? world.maps[0]!
    world = { ...world, center: { ...world.center } }
    for (const axis of ['x', 'y', 'z'] as const) {
      const v = intParam(axis)
      if (v !== null) world.center[axis] = v
    }
    this.worlds.set(world.name, world)

    this.state.nogui = param('nogui') === 'true'
    this.state.nocompass = param('nocompass') === 'true'
    this.state.nopanel = param('nopanel') === 'true' || this.state.nogui
    this.state.hidechat = boolParam('hidechat') === true
    const sidebar = param('sidebaropened')
    this.state.sidebarMode = ['false', 'true', 'pinned'].includes(sidebar) ? sidebar : (this.config.sidebaropened ?? 'pinned')
    const showLayerControl = param('showlayercontrol') || this.config.showlayercontrol || 'true'

    this.map = L.map(container, {
      zoom: (intParam('zoom') ?? this.config.defaultzoom ?? 1) + zoomOffset(world),
      center: L.latLng(0, 0),
      zoomAnimation: true,
      zoomControl: !this.state.nogui,
      attributionControl: false,
      crs: L.CRS.Simple,
      worldCopyJump: false,
      // 範囲や線は SVG の代わりに Canvas に描く (ブラウザが GPU で描くので、数百あっても動かすのが軽い)
      preferCanvas: true,
    })
    // Dynmap の CSS が後から読み込まれるなど、窓の大きさを変えずに地図の枠の大きさが変わったときも、中心を保つ
    new ResizeObserver(() => this.map.invalidateSize({ debounceMoveend: true })).observe(container)

    if (showLayerControl !== 'false') {
      this.layerControl = L.control.layers(undefined, undefined, {
        position: 'topleft',
        collapsed: showLayerControl !== 'pinned',
        sortLayers: true,
        sortFunction: (a, b, an, bn) => {
          const pa = this.overlays.find(o => o.layer === a)?.priority ?? 0
          const pb = this.overlays.find(o => o.layer === b)?.priority ?? 0
          return pa !== pb ? pa - pb : an < bn ? -1 : an > bn ? 1 : 0
        },
      })
    }

    const markersConfig = this.component<ComponentConfig & { showlabel?: boolean }>('markers')
    this.markers = new Markers({
      map: this.map,
      toLatLng: loc => this.toLatLng(loc),
      markersUrl: URLS.markers,
      showLabels: markersConfig?.showlabel === true,
      addOverlay: (layer, name, priority, visible) => this.addOverlay(layer, name, priority, visible),
      removeOverlay: layer => this.removeOverlay(layer),
    })

    if (!this.state.nogui) {
      const coord = this.component<ComponentConfig & { label?: string, hidey?: boolean, 'show-mcr'?: boolean, 'show-chunk'?: boolean }>('coord')
      if (coord) this.addCoordControl(coord)
      if (this.component('link')) this.addLinkControl()
      const pm = this.component<ComponentConfig & { hidebydefault?: boolean, label?: string, layerprio?: number }>('playermarkers')
      if (pm) this.addOverlay(this.playerGroup, pm.label || 'Players', pm.layerprio || 0, !pm.hidebydefault)
    }
    this.layerControl?.addTo(this.map)

    this.selectMap(world.name, map.name)
    this.state.ready = true

    this.map.on('moveend zoomend', () => this.updateUrlDebounced())
    // 追従の解除は利用者のドラッグ (dragstart) だけにする。movestart は panTo / setView などプログラムからの移動でも
    // 発火するので、追従中のパンで追従自体が解除されてしまい、解除条件には使えない
    this.map.on('dragstart', () => {
      if (this.state.following) this.state.following = null
    })
    window.addEventListener('popstate', () => {
      if (!this.state.ready) return
      const wName = param('worldname') || this.config.defaultworld || ''
      const mName = param('mapname') || this.config.defaultmap || ''
      const targetWorld = this.worlds.get(wName) ?? this.config.worlds[0]!
      const targetMap = targetWorld.maps.find(m => m.name === mName) ?? targetWorld.maps[0]!
      const x = intParam('x')
      const y = intParam('y')
      const z = intParam('z')
      const loc = (x !== null && z !== null) ? { x, y: y ?? (targetWorld.sealevel ? targetWorld.sealevel + 1 : 64), z } : undefined
      const targetZoom = intParam('zoom')
      if (targetZoom !== null) {
        const leafletZoom = targetZoom + zoomOffset(targetWorld)
        this.map.setZoom(Math.max(0, Math.min(leafletZoom, targetMap.mapzoomin + targetMap.mapzoomout)))
      }
      this.selectMap(targetWorld.name, targetMap.name, loc)
    })

    const follow = param('playername')
    if (follow) this.state.following = follow
    this.connectLive()
    void this.update()
  }

  // ---- 地図とワールド ----

  selectMap(worldName: string, mapName: string, location?: Location): void {
    const world = this.worlds.get(worldName)
    const map = world?.maps.find(m => m.name === mapName)
    if (!world || !map) return
    if (this.state.world === worldName && this.state.map === mapName) return

    const prevMap = this.currentMap.value
    const worldChanged = this.state.world !== worldName
    const prevWorld = this.worlds.get(this.state.world)
    const projectionChanged = !prevMap || prevMap.worldtomap.join() !== map.worldtomap.join() || prevMap.mapzoomout !== map.mapzoomout || prevMap.tilescale !== map.tilescale
    const defaultY = world.sealevel ? world.sealevel + 1 : 64
    if (worldChanged && prevMap && this.state.world) {
      const prevY = prevWorld?.sealevel ? prevWorld.sealevel + 1 : 64
      this.lastCenter.set(this.state.world, toLocation(prevMap, this.map.getCenter(), prevY))
    }
    const prevCenter = prevMap ? toLocation(prevMap, this.map.getCenter(), defaultY) : null

    if (this.tileLayer) this.map.removeLayer(this.tileLayer)
    this.state.world = worldName
    this.state.map = mapName
    this.currentMap.value = map
    this.tileLayer = new HDTileLayer(map, worldName, URLS.tiles, () => this.serverday)

    const maxZoom = map.mapzoomin + map.mapzoomout
    let zoom = this.map.getZoom()
    if (prevMap) {
      if (worldChanged) {
        const prevOffset = prevWorld ? zoomOffset(prevWorld) : 0
        const newOffset = zoomOffset(world)
        zoom = zoom - prevOffset + newOffset
      }
      if (projectionChanged) {
        zoom += (map.mapzoomout - prevMap.mapzoomout)
      }
    }
    zoom = Math.max(0, Math.min(zoom, maxZoom))
    this.map.setMaxZoom(maxZoom)
    this.map.setMinZoom(0)
    if (projectionChanged || worldChanged || location) {
      const center = location
        ?? (worldChanged ? (this.lastCenter.get(worldName) ?? world.center) : prevCenter ?? world.center)
      this.map.setView(toLatLng(map, center), zoom, { animate: false })
    }
    else this.map.setZoom(zoom)
    this.map.addLayer(this.tileLayer)
    this.updateBackground()
    this.updateUrlDebounced()

    if (worldChanged) {
      void this.markers.load(worldName)
      this.subscribe()
    }
    else if (projectionChanged) this.markers.reproject()
    this.refreshPlayerMarkers()
  }

  selectWorldAndPan(worldName: string, location: Location): void {
    if (this.state.world === worldName) {
      this.map.panTo(this.toLatLng(location))
      return
    }
    const world = this.worlds.get(worldName)
    if (!world) return
    const map = world.maps.find(m => m.name === this.config.defaultmap) ?? world.maps[0]!
    this.selectMap(worldName, map.name, location)
  }

  toLatLng(loc: Location): L.LatLng {
    return toLatLng(this.currentMap.value!, loc)
  }

  /** Dynmap の「リンク」と同じ URL */
  getLink(): string {
    const map = this.currentMap.value
    if (!map) return window.location.pathname
    const world = this.worlds.get(this.state.world)
    const y = world?.sealevel ? world.sealevel + 1 : 64
    const c = toLocation(map, this.map.getCenter(), y)
    const r = this.config['round-coordinates'] ? (n: number) => n : Math.round
    const offset = world ? zoomOffset(world) : 0
    const zoom = this.map.getZoom() - offset
    return `${window.location.pathname}?worldname=${this.state.world}&mapname=${this.state.map}&zoom=${zoom}&x=${r(c.x)}&y=${r(c.y)}&z=${r(c.z)}`
  }

  updateUrlDebounced(): void {
    if (this.urlTimer) clearTimeout(this.urlTimer)
    this.urlTimer = setTimeout(() => {
      if (!this.state.ready || !this.currentMap.value) return
      const link = this.getLink()
      window.history.replaceState(null, '', link)
    }, 500)
  }

  private updateBackground(): void {
    const map = this.currentMap.value
    if (!map) return
    const color = (this.serverday ? map.backgroundday : map.backgroundnight) || map.background || '#000000'
    this.map.getContainer().style.background = color
  }

  // ---- レイヤーの切り替え (Dynmap は layerprio、次に名前の順に並べる) ----

  private addOverlay(layer: L.Layer, name: string, priority: number, visible: boolean): void {
    const existing = this.overlays.find(o => o.layer === layer)
    if (existing) {
      existing.name = name
      existing.priority = priority
      this.layerControl?.removeLayer(layer)
    }
    else {
      this.overlays.push({ layer, name, priority })
      if (visible) this.map.addLayer(layer)
    }
    // Leaflet は名前を HTML として入れる (マーカーの名前や説明と同じように無害にしてから渡す)
    this.layerControl?.addOverlay(layer, sanitizeHtml(name))
  }

  private removeOverlay(layer: L.Layer): void {
    this.overlays = this.overlays.filter(o => o.layer !== layer)
    this.layerControl?.removeLayer(layer)
  }

  // ---- 左上の座標と左下のリンク ----

  private addCoordControl(cfg: { label?: string, hidey?: boolean, 'show-mcr'?: boolean, 'show-chunk'?: boolean }): void {
    const empty = cfg.hidey ? '---,---' : '---,---,---'
    const value = document.createElement('span')
    const mcr = document.createElement('span')
    const chunk = document.createElement('span')
    const Coord = L.Control.extend({
      onAdd: () => {
        const c = L.DomUtil.create('div', cfg.hidey ? 'coord-control coord-control-noy' : 'coord-control')
        const label = L.DomUtil.create('span', 'coord-control-label', c)
        label.textContent = `${cfg.label || 'x,y,z'}: `
        c.appendChild(document.createElement('br'))
        value.className = 'coord-control-value'
        value.textContent = empty
        c.appendChild(value)
        if (cfg['show-mcr']) {
          c.appendChild(document.createElement('br'))
          mcr.className = 'coord-control-value'
          mcr.textContent = '--------'
          c.appendChild(mcr)
        }
        if (cfg['show-chunk']) {
          c.appendChild(document.createElement('br'))
          chunk.className = 'coord-control-value'
          chunk.textContent = 'Chunk: ---,---'
          c.appendChild(chunk)
        }
        return c
      },
    })
    new Coord({ position: 'topleft' }).addTo(this.map)
    this.map.on('mousemove', (e: L.LeafletMouseEvent) => {
      const world = this.worlds.get(this.state.world)
      const map = this.currentMap.value
      if (!world || !map) return
      const loc = toLocation(map, e.latlng, world.sealevel + 1)
      value.textContent = cfg.hidey ? `${Math.round(loc.x)},${Math.round(loc.z)}` : `${Math.round(loc.x)},${loc.y},${Math.round(loc.z)}`
      if (cfg['show-mcr']) mcr.textContent = `r.${Math.floor(loc.x / 512)}.${Math.floor(loc.z / 512)}.mca`
      if (cfg['show-chunk']) chunk.textContent = `Chunk: ${Math.floor(loc.x / 16)},${Math.floor(loc.z / 16)}`
    })
    this.map.on('mouseout', () => {
      value.textContent = empty
      mcr.textContent = '--------'
      chunk.textContent = 'Chunk: ---,---'
    })
  }

  private addLinkControl(): void {
    const Link = L.Control.extend({
      onAdd: () => {
        const c = L.DomUtil.create('div', 'dynmap-link')
        const a = L.DomUtil.create('a', 'dynmap-link-button', c)
        a.href = '#'
        a.title = 'Link'
        a.onmouseover = () => { a.href = this.getLink() }
        L.DomEvent.disableClickPropagation(a)
        L.DomEvent.on(a, 'click', (e) => {
          L.DomEvent.preventDefault(e)
          const link = this.getLink()
          window.history.replaceState(null, '', link)
          if (navigator.clipboard) {
            navigator.clipboard.writeText(window.location.origin + link).catch(() => {})
          }
        })
        return c
      },
    })
    new Link({ position: 'bottomleft' }).addTo(this.map)
  }

  // ---- ワールドの更新 ----
  // WebSocket (/up/ws) につながっているあいだは、更新とプレイヤーの位置が届くのを待つ (server/utils/live.ts)。
  // つながらないときは、Dynmap の画面と同じく updaterate ごとに up/world/... を取りに行く

  private connectLive(): void {
    if (typeof WebSocket === 'undefined') return
    const ws = new WebSocket(`${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/up/ws`)
    this.ws = ws
    ws.onopen = () => {
      this.live = true
      this.wsRetry = 2000
      this.subscribe()
    }
    ws.onmessage = (e: MessageEvent<string>) => {
      let msg: { type?: string, world?: string, update?: WorldUpdate, players?: LivePlayer[] }
      try {
        msg = JSON.parse(e.data)
      }
      catch {
        return
      }
      if (msg.type === 'update' && msg.world === this.state.world && msg.update) this.receive(msg.update)
      else if (msg.type === 'players' && msg.players) this.livePlayers(msg.players)
    }
    ws.onclose = () => {
      this.live = false
      this.ws = null
      setTimeout(() => this.connectLive(), this.wsRetry)
      this.wsRetry = Math.min(this.wsRetry * 2, 60000)
    }
  }

  private subscribe(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ subscribe: this.state.world }))
  }

  private async update(): Promise<void> {
    const again = (): void => { setTimeout(() => void this.update(), this.config.updaterate) }
    if (this.live || document.visibilityState === 'hidden') return again()
    try {
      const res = await fetch(URLS.update(this.state.world, this.lasttimestamp))
      if (!res.ok) throw new Error(res.statusText || String(res.status))
      if (!this.receive((await res.json()) as WorldUpdate | null)) return
    }
    catch (e) {
      this.lasttimestamp--
      this.missed++
      if (this.missed > 2) this.state.alert = `Could not update map: ${(e as Error).message || 'Could not connect to server'}`
    }
    again()
  }

  /** 届いた更新を反映する。続けられないとき (エラー、設定が変わって読み直すとき) は false */
  private receive(update: WorldUpdate | null): boolean {
    if (!update) return true
    this.state.alert = null
    if (update.error) {
      this.state.alert = update.error
      return false
    }
    if (this.lasttimestamp === update.timestamp) return true
    if (this.config.confighash !== update.confighash) {
      window.location.href = this.getLink()
      return false
    }
    this.applyUpdate(update)
    this.lasttimestamp = update.timestamp
    this.missed = 0
    return true
  }

  private applyUpdate(update: WorldUpdate): void {
    this.state.currentcount = update.currentcount
    this.state.servertime = update.servertime
    this.state.hasStorm = update.hasStorm
    this.state.isThundering = update.isThundering
    this.state.updated = Date.now()
    const day = isServerDay(update.servertime)
    if (day !== this.serverday) {
      this.serverday = day
      this.updateBackground()
      // 昼と夜で別のタイルを持つ地図は読み直す
      if (this.currentMap.value?.nightandday && this.tileLayer) this.tileLayer.redraw()
    }
    this.applyPlayers(update.players)

    for (const ev of update.updates) {
      // jsonfile では、前に読んだより新しいものだけを扱う
      if (this.config.jsonfile && ev.timestamp < this.lasttimestamp) continue
      switch (ev.type) {
        case 'tile':
          if (ev.name) this.tileLayer?.updateNamedTile(ev.name, ev.timestamp)
          break
        case 'playerjoin':
          this.joinQuit(ev.playerName ?? '', this.config.joinmessage, this.config['msg-hiddennamejoin'])
          break
        case 'playerquit':
          this.joinQuit(ev.playerName ?? '', this.config.quitmessage, this.config['msg-hiddennamequit'])
          break
        case 'chat':
          this.chat(ev)
          break
        case 'component':
          if (ev.ctype === 'markers') this.markers.handle(ev)
          break
      }
    }
  }

  // ---- プレイヤー ----

  private applyPlayers(updates: PlayerUpdate[]): void {
    const seen = new Set<string>()
    for (const u of updates) {
      seen.add(u.account)
      const i = this.state.players.findIndex(q => q.account === u.account)
      const prev = i >= 0 ? this.state.players[i] : undefined
      // WebSocket で新しい位置が届いている人は、位置と体力をそちらのままにする
      const fresh = prev && Date.now() - (this.liveAt.get(u.account) ?? 0) < 3000
      const p: Player = fresh
        ? { ...prev, name: u.name, sort: u.sort ?? 0 }
        : {
            account: u.account, name: u.name, world: u.world,
            x: Number(u.x), y: Number(u.y), z: Number(u.z),
            health: u.health, armor: u.armor, sort: u.sort ?? 0,
          }
      if (i >= 0) this.state.players[i] = p
      else this.state.players.push(p)
      this.updatePlayerMarker(p)
      this.balloons.get(p.account)?.popup.setLatLng(this.toLatLng(p))
      if (this.state.following === p.account) this.selectWorldAndPan(p.world, p)
    }
    for (const p of [...this.state.players]) {
      if (!seen.has(p.account)) {
        this.state.players.splice(this.state.players.indexOf(p), 1)
        const m = this.playerMarkers.get(p.account)
        if (m) this.playerGroup.removeLayer(m.marker)
        this.playerMarkers.delete(p.account)
      }
    }
    // Dynmap と同じく sort の順、同じなら名前の文字コード順
    this.state.players.sort((a, b) => {
      if (a.sort !== b.sort) return a.sort - b.sort
      const an = a.name.toLowerCase()
      const bn = b.name.toLowerCase()
      return an < bn ? -1 : an > bn ? 1 : 0
    })
  }

  /** WebSocket で届いた位置 (TORO-Core の dynmap-live が 0.25 秒ごとに送る)。地図に出ている人の分だけ届く */
  private livePlayers(list: LivePlayer[]): void {
    const now = Date.now()
    for (const lp of list) {
      const i = this.state.players.findIndex(q => q.account === lp.account)
      if (i < 0) continue
      const p: Player = { ...this.state.players[i]!, world: lp.world, x: lp.x, y: lp.y, z: lp.z, health: lp.health, armor: lp.armor }
      this.state.players[i] = p
      this.liveAt.set(p.account, now)
      this.updatePlayerMarker(p, true)
      this.balloons.get(p.account)?.popup.setLatLng(this.toLatLng(p))
      if (this.state.following === p.account) this.selectWorldAndPan(p.world, p)
    }
  }

  /** 次の位置が届くまでの 0.25 秒で、マーカーを滑らかに動かす (遠くへ移ったときは跳ぶ) */
  private glide(marker: L.Marker, to: L.LatLng): void {
    const from = marker.getLatLng()
    if (this.map.latLngToLayerPoint(from).distanceTo(this.map.latLngToLayerPoint(to)) > 200) {
      this.glides.delete(marker)
      marker.setLatLng(to)
      return
    }
    this.glides.set(marker, { from, to, start: performance.now() })
    if (!this.glideFrame) this.glideFrame = requestAnimationFrame(this.stepGlides)
  }

  private readonly stepGlides = (now: number): void => {
    this.glideFrame = 0
    for (const [marker, g] of this.glides) {
      const k = Math.min(1, (now - g.start) / 250)
      marker.setLatLng(L.latLng(g.from.lat + (g.to.lat - g.from.lat) * k, g.from.lng + (g.to.lng - g.from.lng) * k))
      if (k >= 1) this.glides.delete(marker)
    }
    if (this.glides.size) this.glideFrame = requestAnimationFrame(this.stepGlides)
  }

  followPlayer(account: string | null): void {
    this.state.following = account
    const p = account ? this.state.players.find(q => q.account === account) : undefined
    if (!p) return
    this.selectWorldAndPan(p.world, p)
    if (this.config.followmap) {
      const world = this.worlds.get(p.world)
      if (world?.maps.some(m => m.name === this.config.followmap)) this.selectMap(p.world, this.config.followmap)
    }
    if (this.config.followzoom) this.map.setZoom(this.config.followzoom)
  }

  centerOnPlayer(account: string): void {
    if (this.state.following !== account) this.state.following = null
    const p = this.state.players.find(q => q.account === account)
    if (p) this.selectWorldAndPan(p.world, p)
  }

  faceUrl(account: string, size: 8 | 16 | 32 | 'body'): string {
    const dir = size === 'body' ? 'body' : `${size}x${size}`
    return `${URLS.markers}faces/${dir}/${encodeURIComponent(account)}.png`
  }

  private playerConfig(): { showplayerfaces?: boolean, smallplayerfaces?: boolean, largeplayerfaces?: boolean, showplayerbody?: boolean, showplayerhealth?: boolean } {
    return (this.component('playermarkers') ?? {}) as ReturnType<DynmapViewer['playerConfig']>
  }

  private updatePlayerMarker(p: Player, smooth = false): void {
    if (!this.component('playermarkers')) return
    let entry = this.playerMarkers.get(p.account)
    if (!entry) {
      const created: { marker: L.Marker, el: HTMLElement | null } = { marker: null as unknown as L.Marker, el: null }
      created.marker = elementMarker(this.toLatLng(p), () => {
        created.el = this.playerElement(p.account)
        this.fillPlayerElement(created.el, this.state.players.find(q => q.account === p.account) ?? p)
        return created.el
      })
      entry = created
      this.playerMarkers.set(p.account, entry)
    }
    if (p.world === this.state.world) {
      const shown = this.playerGroup.hasLayer(entry.marker)
      if (smooth && shown) this.glide(entry.marker, this.toLatLng(p))
      else {
        this.glides.delete(entry.marker)
        entry.marker.setLatLng(this.toLatLng(p))
      }
      if (!shown) this.playerGroup.addLayer(entry.marker)
      if (entry.el) this.fillPlayerElement(entry.el, p)
    }
    else this.playerGroup.removeLayer(entry.marker)
  }

  private refreshPlayerMarkers(): void {
    for (const p of this.state.players) this.updatePlayerMarker(p)
  }

  private playerElement(account: string): HTMLElement {
    const cfg = this.playerConfig()
    const size = cfg.smallplayerfaces ? 'Sm' : cfg.largeplayerfaces ? 'Lg' : ''
    const div = document.createElement('div')
    div.className = 'Marker playerMarker'
    const img = document.createElement('img')
    img.className = `playerIcon${size}`
    img.src = 'images/player.png'
    if (cfg.showplayerfaces) {
      const face = new Image()
      face.className = `playerIcon${size}`
      face.onload = () => img.replaceWith(face)
      face.src = this.faceUrl(account, cfg.smallplayerfaces ? 16 : cfg.largeplayerfaces ? 32 : cfg.showplayerbody ? 'body' : 32)
    }
    div.appendChild(img)
    const name = document.createElement('span')
    name.className = `playerName${size}`
    div.appendChild(name)
    if (cfg.showplayerhealth) {
      const health = document.createElement('div')
      health.className = `healthContainer${size}`
      health.innerHTML = '<div class="playerHealthBackground"><div class="playerHealth"></div></div><div class="playerArmorBackground"><div class="playerArmor"></div></div>'
      div.appendChild(health)
    }
    else name.classList.add('playerNameNoHealth')
    return div
  }

  private fillPlayerElement(el: HTMLElement, p: Player): void {
    const name = el.querySelector<HTMLElement>('[class^="playerName"]')
    if (name && name.textContent !== p.name) name.textContent = p.name
    const health = el.querySelector<HTMLElement>('[class^="healthContainer"]')
    if (!health) return
    if (p.health !== undefined && p.armor !== undefined) {
      health.style.display = 'block'
      health.querySelector<HTMLElement>('.playerHealth')!.style.width = `${Math.ceil(p.health * 2.5)}px`
      health.querySelector<HTMLElement>('.playerArmor')!.style.width = `${Math.ceil(p.armor * 2.5)}px`
    }
    else health.style.display = 'none'
  }

  // ---- チャット (左下の欄と、プレイヤーの上の吹き出し) ----

  private escapeHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!))
  }

  private joinQuit(playerName: string, message: string, hidden: string): void {
    if (message.length > 0 && playerName.length > 0) this.addChat({ html: sanitizeHtml(message.replace('%playername%', () => this.escapeHtml(playerName))) })
    else if (hidden.length > 0 && playerName.length === 0) this.addChat({ html: sanitizeHtml(hidden) })
  }

  private chat(ev: UpdateEvent): void {
    const box = this.component<ComponentConfig & { showplayerfaces?: boolean }>('chatbox')
    if (this.state.hidechat) return
    if (box) {
      this.addChat({
        name: ev.playerName || undefined,
        text: ev.message ?? '',
        channel: ev.channel || undefined,
        face: ev.source === 'player' && box.showplayerfaces && ev.account ? this.faceUrl(ev.account, 16) : undefined,
      })
    }
    if (this.component('chatballoon') && ev.source === 'player' && ev.account) this.balloon(ev.account, ev.message ?? '')
  }

  private addChat(row: Omit<ChatRow, 'id'>): void {
    const ttl = Number(this.component<ComponentConfig & { messagettl?: number }>('chatbox')?.messagettl ?? 5)
    const entry = { id: ++this.chatId, ...row }
    this.state.chat.push(entry)
    setTimeout(() => {
      const i = this.state.chat.findIndex(r => r.id === entry.id)
      if (i >= 0) this.state.chat.splice(i, 1)
    }, ttl * 1000)
  }

  private balloon(account: string, text: string): void {
    const p = this.state.players.find(q => q.account === account)
    if (!p || p.world !== this.state.world) return
    const focus = this.component<ComponentConfig & { focuschatballoons?: boolean }>('chatballoon')?.focuschatballoons === true
    let b = this.balloons.get(account)
    if (!b) {
      const popup = L.popup({ autoPan: focus, closeButton: false }).setLatLng(this.toLatLng(p))
      b = { popup, lines: [], timer: setTimeout(() => {}, 0) }
      this.balloons.set(account, b)
      this.map.addLayer(popup)
    }
    b.lines.push(text)
    if (b.lines.length > 5) b.lines.shift()
    const content = document.createElement('div')
    content.className = 'balloonmessages'
    for (const line of b.lines) {
      const d = document.createElement('div')
      d.className = 'balloonmessage'
      d.textContent = line
      content.appendChild(d)
    }
    b.popup.setContent(content.innerHTML)
    clearTimeout(b.timer)
    const entry = b
    b.timer = setTimeout(() => {
      this.map.removeLayer(entry.popup)
      this.balloons.delete(account)
    }, 8000)
    if (focus) this.map.panTo(this.toLatLng(p))
  }
}
