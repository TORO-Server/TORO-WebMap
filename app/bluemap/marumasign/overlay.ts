/*
 * MarumaSign の看板の画像などを、BlueMap の 3D の空間に置く (MarumaSign Companion の marumasign3d.js の代わり)。
 * 看板データは marumasign/<地図の id>.json (Companion が書く。形は前と同じ)。
 *
 * 安全のための決まり (看板は誰でも書けて、これは公開サイトで動く。前のスクリプトと同じ):
 *  - innerHTML / eval などは使わない。文字は textContent、要素は createElement だけで作る。
 *  - リンクと画像の URL は、https/http (リンクのみ) だけ。ユーザー情報つき・怪しいホスト・怪しいポートは使わない。
 *  - 画像は fetch (CORS・Cookie なし・Referer なし・転送は追わない) で読み、種類と大きさを確かめてから、縮めたテクスチャにする。
 *    動画・音声・ライブ配信・PDF・3D のものも、読む前に同じ決まりで先頭を確かめ、再生する部品 (hls.js など) が読む URL や、
 *    .gltf が参照する外部のファイルも確かめる。3D のファイル (NBT など) は、大きさ・深さ・数に上限をかけて読む。
 *  - 看板の数値は有限の値に収め、画像の大きさと位置のずれには上限をかける (空を覆うような悪戯を防ぐ)。
 *  - 同時に読む数・描く数・テクスチャの量・同時に再生する数に上限をかける。
 */
import { Frustum, Group, Matrix4, type Object3D, Sphere, Vector3, type Mesh } from 'three'
import {
  blockKey, clamp, displayHost, hideBoards, isFiniteNumber, kindIdOf, parseSign, planRoute, safeUrl, shorten, viewDistance,
  type Route,
} from './core'
import { imageCache } from './image-cache'
import { factoryNow, loadFactory } from './renderers/index'
import { setRenderer } from './renderer-ref'
import type { LoadCounter, RenderContext, Settings, Sign, SignRenderer } from './types'
import type { BlueMapApp } from '../js/BlueMapApp'
import type { Tile } from '../js/map/Tile'
import { CSS2DObject } from '../js/util/CSS2DRenderer'

const POLL_MILLIS = 60 * 1000
const UPDATE_MILLIS = 400
const CELL = 32
const LABEL_DISTANCE = 96

/** 表示中の看板 1 つ */
interface Entry {
  renderer: SignRenderer | null
  label: CSS2DObject | null
  /** 有効にしたときの距離 (ラベルを出すかどうか) */
  dist: number
}

/** window.marumasign3d (Wiki の背景の撮影などが使う) */
export interface MarumaSignApi {
  enable(): void
  disable(): void
  reload(): Promise<void>
  /** カメラを動かした直後に、看板の入れ替えをすぐに行う */
  update(): void
  stats(): { signs: number, active: number, textures: number, loading: number, queued: number }
}

declare global {
  interface Window {
    /** MarumaSign の看板の表示 (app/bluemap/marumasign/) */
    marumasign3d?: MarumaSignApi
  }
}

export class MarumaSignOverlay implements RenderContext {
  readonly app: BlueMapApp
  readonly group: Group
  readonly loads: LoadCounter = { loading: 0, queued: 0 }
  readonly camera = new Vector3()
  settings: Settings = null
  private kinds: [string, string][] = []
  private signs: Sign[] = []
  private grid = new Map<string, Sign[]>()
  private boardCells = new Set<string>() // 看板のブロックの位置 (板を消す)
  private mapId: string = null
  private lastText: string = null
  private lastCamera: [number, number, number] = null
  private dirty = true
  private enabled = true
  private readonly active = new Map<Sign, Entry>()
  /** 中身を読んで分かった描き方 (URL ごと) */
  private readonly reroutes = new Map<string, Route>()
  private infoBox: HTMLElement = null
  private readonly frustum = new Frustum()
  private readonly projScreen = new Matrix4()
  private readonly sphere = new Sphere()
  private timers: ReturnType<typeof setInterval>[] = []

  constructor(app: BlueMapApp) {
    this.app = app
    this.group = new Group()
    this.group.name = 'marumasign3d'
  }

  get viewer() {
    return this.app.mapViewer
  }

  get renderer() {
    return this.app.mapViewer.renderer
  }

  redraw = (): void => {
    try {
      this.app.mapViewer.redraw()
    }
    catch { /* 描き直しを頼めなくても動く */ }
  }

  private readonly extraStats = new Map<string, () => unknown>()

  addStats(name: string, stats: () => unknown): void {
    this.extraStats.set(name, stats)
  }

  kindLabel(s: Sign): string {
    const kind = this.kinds[s.kind] || ['', '']
    return (kind[0] + ' ' + kind[1]).trim()
  }

  inView(object: Object3D | null): boolean {
    const mesh = object as Mesh
    if (!mesh || !mesh.geometry) return false
    if (!mesh.geometry.boundingSphere) mesh.geometry.computeBoundingSphere()
    mesh.updateWorldMatrix(true, false)
    this.sphere.copy(mesh.geometry.boundingSphere).applyMatrix4(mesh.matrixWorld)
    return this.frustum.intersectsSphere(this.sphere)
  }

  sphereInView(sphere: Sphere): boolean {
    return this.frustum.intersectsSphere(sphere)
  }

  // ---- 起動

  start(): void {
    setRenderer(this.renderer)
    this.attach()
    const events = this.app.events
    events.addEventListener('bluemapMapChanged', () => {
      this.attach()
      this.clearSigns()
      void this.loadData()
    })
    // 高精細タイルが読み込まれるたびに、その中の看板の板を消す
    events.addEventListener('bluemapMapTileLoaded', (ev: Event) => {
      const d = (ev as CustomEvent<{ layer: string, tile: Tile }>).detail
      if (d && d.layer === 'hires') this.hideBoardsInTile(d.tile)
    })
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') this.closeInfo()
    })
    this.timers.push(setInterval((): void => void this.loadData(), POLL_MILLIS))
    this.timers.push(setInterval(this.update, UPDATE_MILLIS))
    requestAnimationFrame(this.frame)
    void this.loadData()
  }

  private attach(): void {
    const markers = this.app.mapViewer.markers
    if (this.group.parent !== markers) markers.add(this.group)
  }

  /** 描くフレームごと (アニメーションと動画) */
  private frame = (now: number): void => {
    requestAnimationFrame(this.frame)
    if (!this.enabled) return
    let changed = imageCache.tick(now)
    for (const e of this.active.values()) {
      try {
        if (e.renderer?.frame?.(now)) changed = true
      }
      catch { /* 1 件の失敗で他を止めない */ }
    }
    if (changed) this.redraw()
  }

  api(): MarumaSignApi {
    return {
      enable: () => {
        this.enabled = true
        this.group.visible = true
        this.dirty = true
        this.redraw()
      },
      disable: () => {
        this.enabled = false
        this.group.visible = false
        this.redraw()
      },
      reload: () => {
        this.lastText = null
        return this.loadData()
      },
      update: () => {
        this.dirty = true
        this.update()
      },
      // signs, active, textures, loading, queued は前のスクリプトと同じ (Wiki の背景の撮影が、loading と queued が 0 になるのを待つ)。
      // loading と queued には、画像のほか、動画・PDF などの読み込みも入る
      stats: () => {
        const s: ReturnType<MarumaSignApi['stats']> = {
          signs: this.signs.length,
          active: this.active.size,
          textures: imageCache.textures.size,
          loading: imageCache.loading + this.loads.loading,
          queued: imageCache.queued + this.loads.queued,
        }
        for (const [name, f] of this.extraStats) (s as unknown as Record<string, unknown>)[name] = f()
        return s
      },
    }
  }

  // ---- データ

  private dataUrl(id: string): string {
    return 'marumasign/' + encodeURIComponent(id) + '.json'
  }

  loadData(): Promise<void> {
    const map = this.app.mapViewer.map
    if (!map || !map.data || typeof map.data.id !== 'string') return Promise.resolve()
    const id = map.data.id
    return fetch(this.dataUrl(id), { cache: 'no-cache', credentials: 'same-origin' })
      .then((res) => {
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return res.text()
      })
      .then((text) => {
        if (id === this.mapId && text === this.lastText) return
        const json: unknown = JSON.parse(text)
        this.applyData(id, json)
        this.lastText = text
      })
      .catch(() => {
        if (id !== this.mapId) this.clearSigns()
      })
  }

  private applyData(id: string, data: unknown): void {
    const json = data as Record<string, unknown>
    if (!json || json.format !== 1 || !Array.isArray(json.signs) || !Array.isArray(json.kinds)) throw new Error('bad data')
    const num = (v: unknown, def: number, lo: number, hi: number): number => isFiniteNumber(v) ? clamp(v, lo, hi) : def
    const limits = {
      maxSize: num(json.maxSize, 64, 1, 1000),
      maxOffset: num(json.maxOffset, 64, 1, 1000),
    }
    this.settings = {
      drawDistance: num(json.drawDistance, 192, 16, 512),
      maxActive: num(json.maxActive, 200, 10, 1000),
      textureSize: num(json.textureSize, 1024, 64, 4096),
      // 古いプラグインのデータには無いので、そのときは従来どおり (板は残し、ラベルは出す)
      hideBoards: json.hideBoards === true,
      labels: json.labels !== false,
      fullDrawDistance: json.fullDrawDistance === true,
      limits,
    }
    imageCache.size = this.settings.textureSize
    this.kinds = (json.kinds as unknown[]).map((k): [string, string] =>
      Array.isArray(k) ? [String(k[0]).slice(0, 8), String(k[1]).slice(0, 40)] : ['', ''])
    const parsed: Sign[] = []
    for (const raw of json.signs as unknown[]) {
      const p = parseSign(raw, this.kinds.length, limits)
      if (!p) continue
      const kindId = kindIdOf(this.kinds[p.kind], p.kind)
      parsed.push({ ...p, kindId, route: planRoute(p, kindId), cap: 0 })
    }
    this.clearSigns()
    this.mapId = id
    this.signs = parsed
    this.grid = new Map()
    this.boardCells = new Set()
    for (const s of this.signs) {
      s.cap = this.settings.fullDrawDistance ? this.settings.drawDistance : viewDistance(s, this.settings.drawDistance)
      const key = this.cellKey(Math.floor(s.x / CELL), Math.floor(s.z / CELL))
      let list = this.grid.get(key)
      if (!list) this.grid.set(key, list = [])
      list.push(s)
      this.boardCells.add(blockKey(s.x, s.y, s.z))
    }
    this.dirty = true
    this.hideBoardsInLoadedTiles()
  }

  // ---- 看板の板を消す (BlueMap が描いた地形のうち、看板のブロックの中の面)

  private hideBoardsInTile(tile: Tile): void {
    if (!this.enabled || !this.settings || !this.settings.hideBoards || this.boardCells.size === 0) return
    const model = tile && (tile.model as Mesh)
    const geometry = model && model.geometry
    const position = geometry && geometry.attributes && geometry.attributes.position
    if (!position || !position.array || geometry.index) return
    if (hideBoards(position.array as Float32Array, model.position.x, model.position.y, model.position.z, this.boardCells) > 0) {
      position.needsUpdate = true
      this.redraw()
    }
  }

  private hideBoardsInLoadedTiles(): void {
    const map = this.app.mapViewer.map
    const tiles = map && map.hiresTileManager && map.hiresTileManager.tiles
    if (!tiles || typeof tiles.values !== 'function') return
    for (const tile of tiles.values()) this.hideBoardsInTile(tile)
  }

  private cellKey(cx: number, cz: number): string {
    return cx + ',' + cz
  }

  private clearSigns(): void {
    for (const s of Array.from(this.active.keys())) this.deactivate(s)
    this.signs = []
    this.grid = new Map()
    this.boardCells = new Set()
    this.mapId = null
    this.lastText = null
    this.redraw()
  }

  // ---- 種類ごとの描き方

  private startRenderer(entry: Entry, s: Sign, route: Route): void {
    const known = this.reroutes.get(route.url)
    if (known && known.type !== route.type) route = known
    const create = (factory: NonNullable<ReturnType<typeof factoryNow>>): void => {
      if (this.active.get(s) !== entry) return
      const renderer = factory(this, s, route, {
        shown: () => {
          if (this.active.get(s) !== entry) return
          this.removeLabel(entry)
          this.redraw()
        },
        failed: () => {
          if (this.active.get(s) === entry && entry.dist < LABEL_DISTANCE) this.addLabel(entry, s)
        },
        reroute: (next: Route) => {
          if (this.active.get(s) !== entry || entry.renderer !== renderer) return
          // 同じ URL のほかの看板も、次からは初めから正しい描き方にする
          this.reroutes.set(next.url, next)
          renderer.dispose()
          entry.renderer = null
          this.startRenderer(entry, s, next)
        },
      })
      entry.renderer = renderer
      try {
        renderer.start()
        renderer.update(entry.dist)
      }
      catch (e) {
        console.warn('MarumaSign:', e)
      }
    }
    const now = factoryNow(route.type)
    if (now) {
      create(now)
      return
    }
    // その種類の描き方を、初めて使うときに読み込む
    this.loads.loading++
    loadFactory(route.type).then(create, (e: unknown) => {
      console.warn('MarumaSign: could not load renderer', e)
      if (this.active.get(s) === entry && entry.dist < LABEL_DISTANCE) this.addLabel(entry, s)
    }).finally(() => {
      this.loads.loading--
    })
  }

  // ---- 画像にできない看板のラベル

  private makeLabel(s: Sign): HTMLElement {
    const box = document.createElement('div')
    box.style.cssText = 'background:rgba(30,30,30,.85);color:#fff;padding:3px 7px;border-radius:4px;font:12px/1.3 sans-serif;'
      + 'white-space:nowrap;box-shadow:0 1px 4px rgba(0,0,0,.6);pointer-events:auto;cursor:pointer'
    const title = document.createElement('div')
    title.textContent = this.kindLabel(s)
    const sub = document.createElement('div')
    sub.style.cssText = 'font-size:10px;opacity:.8'
    sub.textContent = shorten(s.link, 36)
    box.appendChild(title)
    box.appendChild(sub)
    box.addEventListener('click', (ev) => {
      ev.stopPropagation()
      this.showInfo(s)
    })
    return box
  }

  private addLabel(entry: Entry, s: Sign): void {
    if (!this.settings || !this.settings.labels) return
    if (entry.label) return
    // CSS2DObject は、親のある要素を包む作りなので、入れ物に入れてから渡す
    const holder = document.createElement('div')
    const el = this.makeLabel(s)
    holder.appendChild(el)
    const obj = new CSS2DObject(el)
    obj.position.set(s.x + 0.5, s.y + 0.5, s.z + 0.5)
    entry.label = obj
    this.group.add(obj)
  }

  private removeLabel(entry: Entry): void {
    if (entry.label) {
      this.group.remove(entry.label)
      entry.label = null
    }
  }

  private activate(s: Sign, dist: number): void {
    const entry: Entry = { renderer: null, label: null, dist }
    this.active.set(s, entry)
    if (s.route) {
      this.startRenderer(entry, s, s.route)
    }
    else if (dist < LABEL_DISTANCE) {
      this.addLabel(entry, s)
    }
  }

  private deactivate(s: Sign): void {
    const entry = this.active.get(s)
    if (!entry) return
    this.active.delete(s)
    if (entry.renderer) {
      try {
        entry.renderer.dispose()
      }
      catch (e) {
        console.warn('MarumaSign:', e)
      }
      entry.renderer = null
    }
    this.removeLabel(entry)
  }

  // ---- クリックしたときの案内 (自動では開かない。開く前にホスト名を見せる)

  showInfo(s: Sign): void {
    this.closeInfo()
    const link = safeUrl(s.link, false)
    if (!link) return
    const box = document.createElement('div')
    box.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:2147483000;max-width:min(92vw,520px);'
      + 'background:rgba(25,25,28,.96);color:#fff;border-radius:8px;padding:10px 14px;font:13px/1.4 sans-serif;'
      + 'box-shadow:0 4px 16px rgba(0,0,0,.6)'
    const head = document.createElement('div')
    head.style.cssText = 'font-weight:bold;margin-bottom:4px'
    head.textContent = this.kindLabel(s) + ' (' + s.x + ', ' + s.y + ', ' + s.z + ')'
    const host = document.createElement('div')
    host.style.cssText = 'opacity:.85;word-break:break-all'
    host.textContent = displayHost(link)
    const path = document.createElement('div')
    path.style.cssText = 'opacity:.6;font-size:11px;word-break:break-all;margin-bottom:8px'
    path.textContent = shorten(link, 90)
    const open = document.createElement('a')
    open.textContent = '開く / Open'
    open.href = link
    open.target = '_blank'
    open.rel = 'noopener noreferrer nofollow'
    open.style.cssText = 'color:#8cf;margin-right:16px'
    const close = document.createElement('a')
    close.textContent = '閉じる / Close'
    close.href = '#'
    close.style.cssText = 'color:#ccc'
    close.addEventListener('click', (ev) => {
      ev.preventDefault()
      this.closeInfo()
    })
    box.appendChild(head)
    box.appendChild(host)
    box.appendChild(path)
    box.appendChild(open)
    box.appendChild(close)
    document.body.appendChild(box)
    this.infoBox = box
  }

  private closeInfo(): void {
    if (this.infoBox && this.infoBox.parentNode) this.infoBox.parentNode.removeChild(this.infoBox)
    this.infoBox = null
  }

  // ---- カメラの近くの看板だけを出す

  update = (): void => {
    if (!this.enabled || !this.settings) return
    const cam = this.app.mapViewer.camera
    if (!cam || !cam.position) return
    const p = cam.position
    if (!isFiniteNumber(p.x) || !isFiniteNumber(p.y) || !isFiniteNumber(p.z)) return
    this.camera.copy(p)
    cam.updateMatrixWorld()
    this.projScreen.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse)
    this.frustum.setFromProjectionMatrix(this.projScreen)
    // 動画などは、カメラの向きが変わっただけでも、画面に入っているかを確かめ直す
    for (const [s, e] of this.active) {
      if (!e.renderer) continue
      const dx = s.x + 0.5 - p.x, dy = s.y + 0.5 - p.y, dz = s.z + 0.5 - p.z
      try {
        e.renderer.update(Math.sqrt(dx * dx + dy * dy + dz * dz))
      }
      catch { /* 1 件の失敗で他を止めない */ }
    }
    const last = this.lastCamera
    if (!this.dirty && last && Math.abs(last[0] - p.x) < 2 && Math.abs(last[1] - p.y) < 2 && Math.abs(last[2] - p.z) < 2) return
    this.lastCamera = [p.x, p.y, p.z]
    this.dirty = false

    const reach = Math.min(512, this.settings.drawDistance)
    const minX = Math.floor((p.x - reach) / CELL), maxX = Math.floor((p.x + reach) / CELL)
    const minZ = Math.floor((p.z - reach) / CELL), maxZ = Math.floor((p.z + reach) / CELL)
    const near: [number, Sign][] = []
    if ((maxX - minX + 1) * (maxZ - minZ + 1) > 4096) return
    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const list = this.grid.get(this.cellKey(cx, cz))
        if (!list) continue
        for (const s of list) {
          const dx = s.x + 0.5 - p.x, dy = s.y + 0.5 - p.y, dz = s.z + 0.5 - p.z
          const d = Math.sqrt(dx * dx + dy * dy + dz * dz)
          if (d <= s.cap) near.push([d, s])
        }
      }
    }
    near.sort((a, b) => a[0] - b[0])
    if (near.length > this.settings.maxActive) near.length = this.settings.maxActive

    const keep = new Set<Sign>()
    for (const n of near) keep.add(n[1])
    for (const s of Array.from(this.active.keys())) if (!keep.has(s)) this.deactivate(s)
    // 近いものから先に読み込みを頼む (読み込みは新しく頼んだものから始まるので、遠いものを先に頼む)
    for (let i = near.length - 1; i >= 0; i--) {
      const s = near[i]![1]
      if (!this.active.has(s)) this.activate(s, near[i]![0])
    }
    this.redraw()
  }
}

/**
 * 看板の表示を始める (BlueMapView.vue が、地図を読み込んだあとに呼ぶ)。
 * URL に ?marumasign3d=off があれば何もしない (前のスクリプトと同じ)
 */
export function startMarumaSign(app: BlueMapApp): MarumaSignApi | null {
  if (window.marumasign3d) return window.marumasign3d
  if (/[?&]marumasign3d=off\b/.test(window.location.search)) return null
  const overlay = new MarumaSignOverlay(app)
  const api = overlay.api()
  window.marumasign3d = api
  overlay.start()
  return api
}
