// Dynmap が返す JSON の形 (up/configuration, up/world/<world>/<時刻>, tiles/_markers_/marker_<world>.json)

export interface Location {
  x: number
  y: number
  z: number
}

export interface MapConfig {
  type: string
  name: string
  title: string
  prefix: string
  icon: string | null
  compassview: string
  nightandday: boolean
  background: string | null
  backgroundday: string | null
  backgroundnight: string | null
  mapzoomin: number
  mapzoomout: number
  tilescale: number
  worldtomap: number[]
  maptoworld: number[]
  'image-format'?: string
  append_to_world?: string
}

export interface WorldConfig {
  name: string
  title: string
  center: Location
  sealevel: number
  worldheight: number
  extrazoomout: number
  maps: MapConfig[]
}

export interface ComponentConfig {
  type: string
  [option: string]: unknown
}

export interface Configuration {
  updaterate: number
  components: ComponentConfig[]
  worlds: WorldConfig[]
  title?: string
  defaultworld?: string
  defaultmap?: string
  defaultzoom?: number
  sidebaropened?: string
  showlayercontrol?: string
  maxcount: number
  confighash: number
  jsonfile?: boolean
  showplayerfacesinmenu?: boolean
  grayplayerswhenhidden?: boolean
  joinmessage: string
  quitmessage: string
  followmap?: string
  followzoom?: number
  cyrillic?: boolean
  'round-coordinates'?: boolean
  'msg-maptypes': string
  'msg-players': string
  'msg-hiddennamejoin': string
  'msg-hiddennamequit': string
}

export interface PlayerUpdate {
  account: string
  name: string
  world: string
  x: number
  y: number
  z: number
  health?: number
  armor?: number
  sort?: number
}

export interface UpdateEvent {
  type: string
  timestamp: number
  name?: string
  playerName?: string
  ctype?: string
  source?: string
  message?: string
  account?: string
  channel?: string
  [field: string]: unknown
}

export interface WorldUpdate {
  timestamp: number
  servertime: number
  hasStorm: boolean
  isThundering: boolean
  currentcount: number
  confighash: number
  players: PlayerUpdate[]
  updates: UpdateEvent[]
  error?: string
}

interface Zoomable {
  label: string
  markup?: boolean
  desc?: string | null
  minzoom?: number
  maxzoom?: number
}

export interface PointMarker extends Zoomable, Location {
  icon: string
  dim: string
}

export interface ShapeStyle {
  color: string
  weight: number
  opacity: number
  fillcolor?: string
  fillopacity?: number
}

export interface AreaMarker extends Zoomable, ShapeStyle {
  x: number[]
  z: number[]
  ytop: number
  ybottom: number
}

export interface LineMarker extends Zoomable, ShapeStyle {
  x: number[]
  y: number[]
  z: number[]
}

export interface CircleMarker extends Zoomable, ShapeStyle, Location {
  xr: number
  zr: number
}

export interface MarkerSetFile {
  label: string
  hide?: boolean
  layerprio?: number
  minzoom?: number
  maxzoom?: number
  showlabels?: boolean | null
  markers?: Record<string, PointMarker>
  areas?: Record<string, AreaMarker>
  lines?: Record<string, LineMarker>
  circles?: Record<string, CircleMarker>
}

export interface MarkerFile {
  timestamp?: number
  sets?: Record<string, MarkerSetFile>
}
