import L from 'leaflet'
import { sanitizeHtml } from './sanitize-html'

/**
 * 作った要素そのものをマーカーにする (web/js/custommarker.js の CustomIcon と同じ)。
 * L.DivIcon と違い、外側の箱や大きさの指定を足さないので、Dynmap の CSS がそのまま効く
 */
export class ElementIcon extends L.Icon {
  constructor(private readonly create: () => HTMLElement) {
    super({ iconUrl: '' })
  }

  override createIcon(): HTMLElement {
    const el = this.create()
    el.className += ' leaflet-marker-icon'
    return el
  }

  override createShadow(): HTMLElement {
    return null as unknown as HTMLElement
  }
}

/** ElementIcon のマーカー。Dynmap と同じく、クリックできてドラッグできない */
export function elementMarker(latlng: L.LatLng, create: () => HTMLElement): L.Marker {
  return L.marker(latlng, { icon: new ElementIcon(create), interactive: true, draggable: false })
}

/** HTML の文字列を要素の中身にする (Dynmap はマーカーの名前や説明を HTML として表示する) */
export function html(tag: string, className: string, content: string): HTMLElement {
  const el = document.createElement(tag)
  el.className = className
  el.innerHTML = sanitizeHtml(content)
  return el
}
