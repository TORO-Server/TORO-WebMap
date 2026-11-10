// PDF の看板 (MarumaSign 本体の PdfSession, PdfControls と同じ考え方)
//  - 最初は 1 ページ目。URL の末尾の「#page=3」(「#zoom=50&page=3」でもよい) があればそのページから。多すぎれば最後のページ
//  - 同じ URL (#page= の指定も同じ) の看板は、同じページを表示する。ページ送りは自分の画面だけ
//  - 「#」から後ろだけが違う看板は、同じファイルを 1 回だけ読む
//  - 看板にマウスを乗せるか、押す (触る) と、板の下にページ送りの帯が出る
//  - ファイルは 64 MB まで
import { CanvasTexture, Raycaster, Vector2, Vector3, type Mesh, type Texture } from 'three'
import type { PDFDocumentProxy } from 'pdfjs-dist'
import type { OpenedPdf } from '../pdf-engine'
import { Board, placeholder, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH, setupTexture } from '../board'
import { clampPage, MAX_PDF_BYTES, requestedPage, withoutFragment, type Route } from '../core'
import { open, readHead, readRest, sniffAsync, WrongKindError } from '../fetch'
import type { RenderContext, RendererHooks, Sign, SignRenderer } from '../types'
import { CSS2DObject } from '../../js/util/CSS2DRenderer'

// 描き終えたページを覚えておく数 (MarumaSign 本体と同じ)
const CACHED_PAGES = 4
// ページを描く大きさ (長い辺。MarumaSign 本体の PAGE_SIZE と同じ。データファイルの textureSize がもっと小さければそれに合わせる)
const PAGE_SIZE = 1024
// 使う看板がなくなってから、読んだ PDF を片付けるまで (ミリ秒)
const KEEP_MILLIS = 60000
// 押して出した帯を消すまで (ミリ秒)
const BAR_MILLIS = 5000

// ---------------------------------------------------------------- 読んだファイル (URL の「#」より前ごと)

interface PdfFile {
  promise: Promise<OpenedPdf>
  doc: PDFDocumentProxy | null
  refs: number
  timer: ReturnType<typeof setTimeout> | null
  bytes: number
}

const files = new Map<string, PdfFile>()

// 同時に読む数と、読んでおく PDF の合計の大きさの上限 (違う PDF をたくさん並べられても、メモリを使い切らないように)
const MAX_CONCURRENT_LOADS = 2
const MAX_TOTAL_BYTES = 192 * 1024 * 1024
let loadsRunning = 0
const loadWaiters: (() => void)[] = []

async function slot<T>(ctx: RenderContext, job: () => Promise<T>): Promise<T> {
  if (loadsRunning >= MAX_CONCURRENT_LOADS) {
    ctx.loads.queued++
    await new Promise<void>(resolve => loadWaiters.push(resolve))
    ctx.loads.queued--
  }
  loadsRunning++
  try {
    return await job()
  }
  finally {
    loadsRunning--
    loadWaiters.shift()?.()
  }
}

/** bytes を新しく使えるように、使われていない PDF を片付ける。それでも足りなければ false */
function makeRoom(bytes: number): boolean {
  let total = bytes
  for (const f of files.values()) total += f.bytes
  if (total <= MAX_TOTAL_BYTES) return true
  for (const [key, f] of files) {
    if (total <= MAX_TOTAL_BYTES) break
    if (f.refs > 0 || f.bytes === 0) continue
    total -= f.bytes
    if (f.timer) clearTimeout(f.timer)
    files.delete(key)
    void f.promise.then(d => d.destroy(), () => {})
  }
  return total <= MAX_TOTAL_BYTES
}

async function loadFile(url: string, ctx: RenderContext, file: { bytes: number }): Promise<OpenedPdf> {
  return slot(ctx, () => download(url, ctx, file))
}

async function download(url: string, ctx: RenderContext, file: { bytes: number }): Promise<OpenedPdf> {
  ctx.loads.loading++
  try {
    const o = await open(url, 'default')
    try {
      const h = await readHead(o, 1024)
      const s = await sniffAsync(h.head, o.type, 'pdf')
      if (!s || s.route !== 'pdf') {
        o.controller.abort()
        throw new WrongKindError(s ? s.route : 'image', s ? s.format : '')
      }
      const data = await readRest(o, h, MAX_PDF_BYTES)
      // 読んだファイルと、pdf.js の中の写し (おおよそ 2 つ分)
      if (!makeRoom(data.length * 2)) throw new Error('not enough memory for more PDFs')
      file.bytes = data.length * 2
      const { openPdf } = await import('../pdf-engine')
      return await openPdf(data)
    }
    finally {
      o.done()
    }
  }
  finally {
    ctx.loads.loading--
  }
}

function acquireFile(url: string, ctx: RenderContext): PdfFile {
  const key = withoutFragment(url)
  let f = files.get(key)
  if (!f) {
    const file: PdfFile = { promise: null, doc: null, refs: 0, timer: null, bytes: 0 }
    file.promise = loadFile(key, ctx, file)
    file.promise.then(d => (file.doc = d.doc), () => {
      // 読めなかったものは大きさに数えない (使う看板がなくなってしばらくしたら消え、また来たら読み直す)
      file.bytes = 0
    })
    files.set(key, file)
    f = file
  }
  if (f.timer) {
    clearTimeout(f.timer)
    f.timer = null
  }
  f.refs++
  return f
}

function releaseFile(url: string): void {
  const key = withoutFragment(url)
  const f = files.get(key)
  if (!f || --f.refs > 0) return
  f.timer = setTimeout(() => {
    if (f.refs > 0) return
    files.delete(key)
    void f.promise.then(d => d.destroy(), () => {})
  }, KEEP_MILLIS)
}

// ---------------------------------------------------------------- ページを描く順番 (すべての PDF で 1 つずつ。MarumaSign 本体と同じ)

let queue: Promise<unknown> = Promise.resolve()

function serial<T>(job: () => Promise<T>): Promise<T> {
  const p = queue.then(job, job)
  queue = p.catch(() => {})
  return p
}

// ---------------------------------------------------------------- 表示 (URL ごと。「#page=」が違えば別)

class PdfSession {
  readonly url: string
  readonly ctx: RenderContext
  readonly users = new Set<PdfRenderer>()
  file: PdfFile | null = null
  state: 'loading' | 'ready' | 'failed' = 'loading'
  wrong: WrongKindError | null = null
  pageCount = 0
  /** 表示したいページと、テクスチャに入っているページ (0 から) */
  page = 0
  shownPage = -1
  private readonly cache = new Map<number, HTMLCanvasElement>()
  private rendering = -1
  texture: Texture | null = null
  width = 0
  height = 0
  private closed = false

  constructor(url: string, ctx: RenderContext) {
    this.url = url
    this.ctx = ctx
  }

  start(): void {
    if (this.file) return
    this.file = acquireFile(this.url, this.ctx)
    this.file.promise.then(({ doc }) => {
      if (this.closed) return
      this.pageCount = doc.numPages
      if (this.pageCount <= 0) throw new Error('no pages')
      this.page = clampPage(requestedPage(this.url), this.pageCount)
      this.renderNext()
    }).catch((e: unknown) => {
      if (this.closed) return
      if (e instanceof WrongKindError) this.wrong = e
      console.info('MarumaSign: cannot read pdf', this.url, String(e))
      this.state = 'failed'
      this.notify()
    })
  }

  private get size(): number {
    return Math.min(PAGE_SIZE, this.ctx.settings ? this.ctx.settings.textureSize : PAGE_SIZE)
  }

  /** ページを進める (正) か戻す (負)。最初と最後より先へは進まない。変わったら true */
  turn(delta: number): boolean {
    if (this.state !== 'ready') return false
    const next = clampPage(this.page + delta, this.pageCount)
    if (next === this.page) return false
    this.page = next
    const cached = this.cache.get(next)
    if (cached) this.show(next, cached)
    else this.notify()
    this.renderNext()
    return true
  }

  get loadingPage(): boolean {
    return this.shownPage !== this.page
  }

  /** 表示したいページ、その次、前の順に、まだ描いていないものを 1 つ描く */
  private renderNext(): void {
    const doc = this.file?.doc
    if (this.closed || this.rendering >= 0 || !doc) return
    let target = -1
    if (!this.cache.has(this.page)) target = this.page
    else if (this.page + 1 < this.pageCount && !this.cache.has(this.page + 1)) target = this.page + 1
    else if (this.page > 0 && !this.cache.has(this.page - 1)) target = this.page - 1
    if (target < 0) return
    this.rendering = target
    const first = this.state === 'loading'
    if (first) this.ctx.loads.loading++
    void serial(async () => {
      if (this.closed) return null
      return renderPage(doc, target, this.size)
    }).then((canvas) => {
      this.rendered(target, canvas)
    }, (e: unknown) => {
      console.info('MarumaSign: cannot draw page', target + 1, this.url, String(e))
      this.rendered(target, null)
    }).finally(() => {
      if (first) this.ctx.loads.loading--
    })
  }

  private rendered(index: number, canvas: HTMLCanvasElement | null): void {
    this.rendering = -1
    if (this.closed) return
    if (!canvas) {
      // 描けなかったページは白紙にして、同じページを何度も描こうとしないようにする
      canvas = document.createElement('canvas')
      canvas.width = Math.max(1, this.width || this.size)
      canvas.height = Math.max(1, this.height || this.size)
      const g = canvas.getContext('2d')!
      g.fillStyle = '#fff'
      g.fillRect(0, 0, canvas.width, canvas.height)
    }
    this.cache.set(index, canvas)
    while (this.cache.size > CACHED_PAGES) {
      // 表示中のページと、そのすぐ隣は残す
      let removed = false
      for (const key of this.cache.keys()) {
        if (Math.abs(key - this.page) > 1) {
          this.cache.delete(key)
          removed = true
          break
        }
      }
      if (!removed) break
    }
    if (index === this.page) this.show(index, canvas)
    this.renderNext()
  }

  private show(index: number, canvas: HTMLCanvasElement): void {
    if (this.closed) return
    if (this.texture && this.width === canvas.width && this.height === canvas.height) {
      this.texture.image = canvas
      this.texture.needsUpdate = true
    }
    else {
      const old = this.texture
      this.texture = setupTexture(new CanvasTexture(canvas))
      this.width = canvas.width
      this.height = canvas.height
      // 看板が新しいテクスチャを使うようになってから、前のものを消す
      if (old) queueMicrotask(() => old.dispose())
    }
    this.shownPage = index
    this.state = 'ready'
    this.notify()
    this.ctx.redraw()
  }

  notify(): void {
    for (const u of this.users) u.refresh()
  }

  close(): void {
    this.closed = true
    this.cache.clear()
    this.texture?.dispose()
    this.texture = null
    if (this.file) releaseFile(this.url)
    this.file = null
  }
}

async function renderPage(doc: PDFDocumentProxy, index: number, size: number): Promise<HTMLCanvasElement> {
  const engine = await import('../pdf-engine')
  return engine.renderPage(doc, index, size)
}

const sessions = new Map<string, PdfSession>()

function acquireSession(url: string, ctx: RenderContext): PdfSession {
  let s = sessions.get(url)
  if (!s) {
    s = new PdfSession(url, ctx)
    sessions.set(url, s)
  }
  return s
}

function releaseSession(s: PdfSession): void {
  if (s.users.size > 0) return
  sessions.delete(s.url)
  s.close()
}

// ---------------------------------------------------------------- ページ送りの帯

class PageBar {
  private ctx: RenderContext | null = null
  private object: CSS2DObject | null = null
  private label: HTMLElement | null = null
  private prev: HTMLButtonElement | null = null
  private next: HTMLButtonElement | null = null
  owner: PdfRenderer | null = null
  private hideTimer: ReturnType<typeof setTimeout> | null = null
  private hovering = false
  private readonly raycaster = new Raycaster()
  private readonly pointer = new Vector2()
  private lastMove = 0

  init(ctx: RenderContext): void {
    if (this.ctx) return
    this.ctx = ctx
    // マウスを乗せたとき (押さなくても出す)。触る操作は、看板を押したとき (onClick) に出す
    ctx.renderer.domElement.addEventListener('pointermove', (ev) => {
      if (ev.pointerType !== 'mouse' || registry.size === 0) return
      const now = performance.now()
      if (now - this.lastMove < 100) return
      this.lastMove = now
      const hit = this.pick(ev.clientX, ev.clientY)
      if (hit) this.show(hit, 0)
      else if (this.owner && !this.hovering) this.scheduleHide(800)
    })
  }

  /** 画面の位置にある PDF の看板 */
  private pick(x: number, y: number): PdfRenderer | null {
    const ctx = this.ctx
    if (!ctx) return null
    const el = ctx.renderer.domElement
    const rect = el.getBoundingClientRect()
    this.pointer.set((x - rect.left) / rect.width * 2 - 1, -((y - rect.top) / rect.height) * 2 + 1)
    const cam = ctx.viewer.camera
    cam.updateMatrixWorld()
    this.raycaster.setFromCamera(this.pointer, cam)
    const meshes: Mesh[] = []
    const owners = new Map<Mesh, PdfRenderer>()
    for (const r of registry) {
      const m = r.mesh
      if (m && r.ready) {
        meshes.push(m)
        owners.set(m, r)
      }
    }
    const hits = this.raycaster.intersectObjects(meshes, false)
    return hits.length ? owners.get(hits[0]!.object as Mesh) ?? null : null
  }

  /**
   * 帯を出す。
   * @param hideAfter この時間 (ミリ秒) で消す。0 ならマウスが離れたときに消す
   */
  show(owner: PdfRenderer, hideAfter: number): void {
    const ctx = this.ctx
    if (!ctx) return
    if (this.hideTimer) {
      clearTimeout(this.hideTimer)
      this.hideTimer = null
    }
    if (this.owner !== owner) {
      this.remove()
      this.owner = owner
      this.build(owner)
    }
    this.refresh()
    if (hideAfter > 0) this.scheduleHide(hideAfter)
  }

  private build(owner: PdfRenderer): void {
    const ctx = this.ctx!
    const holder = document.createElement('div')
    const bar = document.createElement('div')
    bar.style.cssText = 'transform:translate(-50%,6px);display:flex;align-items:center;gap:4px;padding:3px;border-radius:6px;'
      + 'background:rgba(25,25,28,.88);color:#fff;font:13px/1 sans-serif;box-shadow:0 1px 6px rgba(0,0,0,.6);pointer-events:auto;'
      + 'user-select:none;-webkit-user-select:none;white-space:nowrap;touch-action:manipulation'
    const button = (text: string, title: string, delta: number): HTMLButtonElement => {
      const b = document.createElement('button')
      b.type = 'button'
      b.textContent = text
      b.title = title
      b.style.cssText = 'min-width:2.4em;height:2em;border:0;border-radius:4px;background:#3c3c3c;color:#fff;font:inherit;cursor:pointer;padding:0 6px'
      b.addEventListener('click', (ev) => {
        ev.preventDefault()
        ev.stopPropagation()
        owner.session.turn(delta)
        this.refresh()
        // 押したあとは少しのあいだ出しておく
        if (!this.hovering) this.scheduleHide(BAR_MILLIS)
      })
      for (const type of ['pointerdown', 'mousedown', 'touchstart', 'wheel'] as const) b.addEventListener(type, ev => ev.stopPropagation(), { passive: true })
      return b
    }
    this.prev = button('◀', '前のページ', -1)
    this.next = button('▶', '次のページ', 1)
    const label = document.createElement('span')
    label.style.cssText = 'min-width:4.5em;text-align:center;padding:0 4px'
    this.label = label
    bar.appendChild(this.prev)
    bar.appendChild(label)
    bar.appendChild(this.next)
    bar.addEventListener('pointerenter', () => {
      this.hovering = true
      if (this.hideTimer) {
        clearTimeout(this.hideTimer)
        this.hideTimer = null
      }
    })
    bar.addEventListener('pointerleave', () => {
      this.hovering = false
      this.scheduleHide(1500)
    })
    // 帯を押しても、看板の案内や BlueMap の操作にしない
    bar.addEventListener('click', ev => ev.stopPropagation())
    holder.appendChild(bar)
    const obj = new CSS2DObject(bar)
    obj.disableDepthTest = true
    owner.bottomCenter(obj.position)
    ctx.group.add(obj)
    this.object = obj
    ctx.redraw()
  }

  refresh(): void {
    const owner = this.owner
    if (!owner || !this.label) return
    const s = owner.session
    this.label.textContent = s.state === 'ready' ? (s.page + 1) + ' / ' + s.pageCount + (s.loadingPage ? ' …' : '') : '…'
    this.prev!.disabled = s.page <= 0
    this.next!.disabled = s.page >= s.pageCount - 1
    this.prev!.style.opacity = this.prev!.disabled ? '.4' : '1'
    this.next!.style.opacity = this.next!.disabled ? '.4' : '1'
    if (this.object) owner.bottomCenter(this.object.position)
    this.ctx?.redraw()
  }

  private scheduleHide(ms: number): void {
    if (this.hideTimer) clearTimeout(this.hideTimer)
    this.hideTimer = setTimeout(() => {
      this.hideTimer = null
      if (!this.hovering) this.remove()
    }, ms)
  }

  remove(): void {
    if (this.object && this.ctx) {
      this.ctx.group.remove(this.object)
      this.ctx.redraw()
    }
    this.object = null
    this.label = this.prev = this.next = null
    this.owner = null
    this.hovering = false
  }
}

const bar = new PageBar()
const registry = new Set<PdfRenderer>()

// ---------------------------------------------------------------- 看板 1 つ

export class PdfRenderer implements SignRenderer {
  readonly sign: Sign
  readonly session: PdfSession
  private readonly ctx: RenderContext
  private readonly hooks: RendererHooks
  private readonly board: Board
  private readonly route: Route
  private shownKey = ''

  constructor(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks) {
    this.ctx = ctx
    this.sign = sign
    this.route = route
    this.hooks = hooks
    this.board = new Board(ctx, sign)
    this.session = acquireSession(route.url, ctx)
    bar.init(ctx)
    // 押す (触る) と、リンクの案内と一緒に、ページ送りの帯を出す
    this.board.onClick = () => {
      ctx.showInfo(sign)
      if (this.ready) bar.show(this, BAR_MILLIS)
      return true
    }
  }

  get mesh(): Mesh | null {
    return this.board.mesh
  }

  get ready(): boolean {
    return this.session.state === 'ready' && this.session.texture !== null
  }

  bottomCenter(out: Vector3): Vector3 {
    return this.board.bottomCenter(out)
  }

  start(): void {
    registry.add(this)
    this.session.users.add(this)
    this.session.start()
    this.refresh()
  }

  update(): void {}

  refresh(): void {
    const s = this.session
    if (s.wrong) {
      this.hooks.reroute({ type: s.wrong.route as Route['type'], url: this.route.url, ext: this.route.ext })
      return
    }
    const key = s.state === 'ready' && s.texture ? 'page:' + s.width + 'x' + s.height + ':' + s.texture.id : s.state
    if (bar.owner === this) bar.refresh()
    if (key === this.shownKey) return
    this.shownKey = key
    if (s.state === 'ready' && s.texture) {
      this.board.show(s.texture, s.width, s.height, false)
    }
    else {
      this.board.show(placeholder('pdf', s.state === 'failed' ? 'error' : 'loading'), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    }
    this.hooks.shown()
  }

  dispose(): void {
    registry.delete(this)
    if (bar.owner === this) bar.remove()
    this.session.users.delete(this)
    releaseSession(this.session)
    this.board.remove()
  }
}

export function createPdfRenderer(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks): SignRenderer {
  return new PdfRenderer(ctx, sign, route, hooks)
}
