import L from 'leaflet'
import type { Location, MapConfig } from './types'

// Dynmap の HD 地図の投影 (web/js/hdmap.js の HDProjection と同じ計算)

export function toLatLng(map: MapConfig, loc: Location): L.LatLng {
  const w = map.worldtomap
  const lat = w[3]! * loc.x + w[4]! * loc.y + w[5]! * loc.z
  const lng = w[0]! * loc.x + w[1]! * loc.y + w[2]! * loc.z
  return L.latLng(-(((128 << map.tilescale) - lat) / (1 << map.mapzoomout)), lng / (1 << map.mapzoomout), loc.y)
}

export function toLocation(map: MapConfig, latlng: L.LatLng, y: number): Location {
  const p = map.maptoworld
  const lat = (128 << map.tilescale) + latlng.lat * (1 << map.mapzoomout)
  const lng = latlng.lng * (1 << map.mapzoomout)
  return {
    x: p[0]! * lng + p[1]! * lat + p[2]! * y,
    y,
    z: p[6]! * lng + p[7]! * lat + p[8]! * y,
  }
}
