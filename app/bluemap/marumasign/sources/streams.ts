// ライブ配信 (HLS, MPEG-DASH, HTTP-FLV) と、MPEG-TS・FLV のファイルを video 要素につなぐ。部品はその形式の看板が来たときに初めて読み込む
//  - HLS: hls.js (Safari などで MSE がなければ、ブラウザーそのものの再生)
//  - MPEG-DASH: shaka-player の DASH だけの版 (dash.js より小さい)
//  - HTTP-FLV、MPEG-TS・FLV のファイル: mpegts.js
// 再生リストや分割されたファイルも、看板の URL と同じ読み方 (fetch.ts の open: https だけ、CORS・Cookie なし・Referer なし・転送は追わない。
// 直に読めなければ地図のサーバーの中継) で読む。部品そのものの読み込み (XHR や fetch) は使わず、どれも自前の読み込み部品に差し替える。
// 中継を頼むときは、看板の URL からその URL までの再生リストのたどり方 (?p=) を添える (サーバーが読み直して確かめる)
import { safeUrl, withoutFragment } from '../core'
import { HttpError, open, type OpenResponse } from '../fetch'
import { hlsRefs } from '../manifest'

export interface StreamAdapter {
  /** 再生を止めるとき (読み込みも止める) */
  pause(): void
  /** また再生するとき (ライブ配信は今の位置から) */
  resume(): void
  destroy(): void
}

export interface StreamOptions {
  /** 終わらない配信 (false なら、MPEG-TS・FLV のファイル) */
  live: boolean
  /** 続けられない失敗 (つなぎ直すかどうかは呼ぶ側が決める) */
  onFatal(reason: string): void
}

/** 1 回で読む大きさの上限 (再生リスト、分割されたファイル) */
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024
const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024

/**
 * @param type 'mpegts' は MPEG-TS のファイル (ブラウザーの video 要素は再生できない)
 */
export async function attachStream(type: 'hls' | 'dash' | 'flv' | 'mpegts', video: HTMLVideoElement, url: string, options: StreamOptions): Promise<StreamAdapter> {
  switch (type) {
    case 'hls': return attachHls(video, url, options.onFatal)
    case 'dash': return attachDash(video, url, options.onFatal)
    case 'flv': return attachMpegts('flv', video, url, options)
    case 'mpegts': return attachMpegts('mpegts', video, url, options)
  }
}

function check(url: string): void {
  if (!safeUrl(url, true)) throw new Error('blocked url: ' + url.slice(0, 80))
}

/**
 * 1 つの配信の読み込み。読んだ再生リストに書かれた URL を覚えて、その URL を中継で読むときのたどり方にする
 */
class StreamNet {
  readonly root: string
  /** URL → それが書かれていた再生リストの URL */
  private readonly parent = new Map<string, string>()

  constructor(root: string) {
    this.root = withoutFragment(root)
  }

  /** 看板の URL からのたどり方 (先頭が看板の URL かその行き先。3 つまで) */
  chain(url: string): string[] {
    const out: string[] = []
    let u = this.parent.get(withoutFragment(url))
    while (u && out.length < 3) {
      out.unshift(u)
      u = this.parent.get(u)
    }
    return out
  }

  /** 再生リスト (HLS) を読んだら、書かれた URL を覚える */
  learnHls(text: string, url: string): void {
    const base = withoutFragment(url)
    for (const u of hlsRefs(text, base).urls) {
      if (u !== base && !this.parent.has(u)) this.parent.set(u, base)
    }
    // ライブ配信では分割されたファイルの URL が増え続けるので、古いものから忘れる
    while (this.parent.size > 20000) this.parent.delete(this.parent.keys().next().value!)
  }

  /** 決まった親 (MPEG-DASH の MPD) */
  setParent(url: string, parent: string): void {
    const key = withoutFragment(url)
    if (key !== parent && !this.parent.has(key)) this.parent.set(key, withoutFragment(parent))
    while (this.parent.size > 20000) this.parent.delete(this.parent.keys().next().value!)
  }

  open(url: string, options: { range?: string, signal?: AbortSignal, timeout?: number, parents?: string[] }): Promise<OpenResponse> {
    check(url)
    const parents = options.parents ?? this.chain(url)
    return open(url, 'no-store', options.timeout ?? 20000, { range: options.range, signal: options.signal, parents: parents.length ? parents : undefined })
  }
}

/** 本文を上限まで読む */
async function readBody(o: OpenResponse, max: number): Promise<ArrayBuffer> {
  const length = Number(o.res.headers.get('content-length'))
  if (length > max) {
    o.controller.abort()
    throw new Error('too large')
  }
  if (!o.res.body) return o.res.arrayBuffer()
  const reader = o.res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    total += r.value.length
    if (total > max) {
      o.controller.abort()
      throw new Error('too large')
    }
    chunks.push(r.value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out.buffer
}

function headersOf(res: Response): Record<string, string> {
  const h: Record<string, string> = {}
  res.headers.forEach((v, k) => {
    // 中継の頭書きは、元のサイトのものではないので渡さない
    if (!k.startsWith('x-marumasign-')) h[k] = v
  })
  return h
}

// ---------------------------------------------------------------- HLS

/** hls.js の読み込み部品の、使う部分だけの型 */
interface HlsContext {
  url: string
  responseType: string
  type: string
  rangeStart?: number
  rangeEnd?: number
}
interface HlsStats {
  aborted: boolean
  loaded: number
  retry: number
  total: number
  chunkCount: number
  bwEstimate: number
  loading: { start: number, first: number, end: number }
  parsing: { start: number, end: number }
  buffering: { start: number, first: number, end: number }
}
interface HlsCallbacks {
  onSuccess(response: { url: string, data?: string | ArrayBuffer, code?: number }, stats: HlsStats, context: HlsContext, details: unknown): void
  onError(error: { code: number, text: string }, context: HlsContext, details: unknown, stats: HlsStats): void
  onTimeout(stats: HlsStats, context: HlsContext, details: unknown): void
  onAbort?(stats: HlsStats, context: HlsContext, details: unknown): void
}
interface HlsLoaderConfig {
  timeout?: number
  loadPolicy?: { maxLoadTimeMs?: number }
}

function newStats(): HlsStats {
  return {
    aborted: false, loaded: 0, retry: 0, total: 0, chunkCount: 0, bwEstimate: 0,
    loading: { start: 0, first: 0, end: 0 }, parsing: { start: 0, end: 0 }, buffering: { start: 0, first: 0, end: 0 },
  }
}

const PLAYLIST_TYPES = new Set(['manifest', 'level', 'audioTrack', 'subtitleTrack', 'steering-manifest', 'interstitial-asset-list'])

/** hls.js の読み込み部品 (fetch.ts の open で読む) */
function hlsLoader(net: StreamNet): new () => object {
  return class SafeHlsLoader {
    context: HlsContext | null = null
    stats: HlsStats = newStats()
    private controller: AbortController | null = null
    private headers: Record<string, string> = {}
    private timedOut = false

    load(context: HlsContext, config: HlsLoaderConfig, callbacks: HlsCallbacks): void {
      this.context = context
      this.stats = newStats()
      const stats = this.stats
      stats.loading.start = performance.now()
      const controller = new AbortController()
      this.controller = controller
      const timeout = config.loadPolicy?.maxLoadTimeMs || config.timeout || 20000
      const timer = setTimeout(() => {
        this.timedOut = true
        controller.abort()
      }, timeout)
      let range: string | undefined
      if (context.rangeEnd) {
        // hls.js の rangeEnd は終わりの次のバイト (hls.js の読み込み部品と同じく、終わりがあるときだけ)
        range = 'bytes=' + (context.rangeStart ?? 0) + '-' + (context.rangeEnd - 1)
      }
      const playlist = PLAYLIST_TYPES.has(context.type)
      void net.open(context.url, { range, signal: controller.signal, timeout }).then(async (o) => {
        try {
          stats.loading.first = Math.max(performance.now(), stats.loading.start)
          this.headers = headersOf(o.res)
          const buffer = await readBody(o, playlist ? MAX_PLAYLIST_BYTES : MAX_SEGMENT_BYTES)
          stats.loading.end = Math.max(performance.now(), stats.loading.first)
          stats.loaded = stats.total = buffer.byteLength
          stats.chunkCount = 1
          let data: string | ArrayBuffer = buffer
          if (context.responseType !== 'arraybuffer') {
            const text = new TextDecoder().decode(buffer)
            data = text
            if (playlist) net.learnHls(text, o.url)
          }
          if (controller.signal.aborted) return
          callbacks.onSuccess({ url: o.url, data, code: o.res.status }, stats, context, null)
        }
        finally {
          o.done()
        }
      }).catch((e: unknown) => {
        clearTimeout(timer)
        if (this.timedOut) {
          callbacks.onTimeout(stats, context, null)
          return
        }
        if (controller.signal.aborted) {
          stats.aborted = true
          callbacks.onAbort?.(stats, context, null)
          return
        }
        callbacks.onError({ code: e instanceof HttpError ? e.status : 0, text: String(e) }, context, null, stats)
      }).finally(() => clearTimeout(timer))
    }

    abort(): void {
      this.stats.aborted = true
      this.controller?.abort()
    }

    destroy(): void {
      this.controller?.abort()
      this.controller = null
      this.context = null
    }

    getResponseHeader(name: string): string | null {
      return this.headers[name.toLowerCase()] ?? null
    }

    getCacheAge(): number | null {
      const age = Number(this.headers.age)
      return Number.isFinite(age) ? age : null
    }
  }
}

async function attachHls(video: HTMLVideoElement, url: string, onFatal: (reason: string) => void): Promise<StreamAdapter> {
  const { default: Hls } = await import('hls.js')
  if (!Hls.isSupported()) {
    // MSE がない (iPhone の Safari の古い版など)。ブラウザーそのものが HLS を読めるなら任せる (分割されたファイルの転送はブラウザーが追う)
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      check(url)
      video.src = url
      return { pause() {}, resume() {}, destroy() {} }
    }
    throw new Error('HLS is not supported')
  }
  const net = new StreamNet(url)
  const hls = new Hls({
    // Worker は使わない (ESM の版では別のファイルが要る。看板は同時に 4 つまでなので、主のスレッドで足りる)
    enableWorker: false,
    lowLatencyMode: false,
    maxBufferLength: 10,
    maxMaxBufferLength: 30,
    backBufferLength: 10,
    // すべての読み込み (再生リスト、分割されたファイル、鍵) を自前の部品で
    loader: hlsLoader(net) as unknown as typeof Hls.DefaultConfig.loader,
  })
  hls.on(Hls.Events.ERROR, (_event, data) => {
    if (data.fatal) onFatal('hls: ' + data.details)
  })
  hls.loadSource(url)
  hls.attachMedia(video)
  return {
    pause: () => hls.stopLoad(),
    resume: () => {
      hls.startLoad(-1)
      const live = hls.liveSyncPosition
      if (live !== null && Number.isFinite(live)) video.currentTime = live
    },
    destroy: () => hls.destroy(),
  }
}

// ---------------------------------------------------------------- MPEG-DASH (shaka-player)

/** shaka-player の使う部分だけの型 */
interface ShakaRequest {
  uris: string[]
  headers: Record<string, string>
  allowCrossSiteCredentials: boolean
  retryParameters?: { timeout?: number }
}
interface ShakaResponse {
  uri: string
  originalUri: string
  data: ArrayBuffer
  status: number
  headers: Record<string, string>
  timeMs?: number
  fromCache?: boolean
  originalRequest: ShakaRequest
}
type ShakaPlugin = (uri: string, request: ShakaRequest, requestType: number, progressUpdated: unknown, headersReceived?: (headers: Record<string, string>) => void) => unknown
interface ShakaPlayer {
  attach(video: HTMLMediaElement): Promise<void>
  configure(config: object): boolean
  load(url: string): Promise<void>
  destroy(): Promise<void>
  getNetworkingEngine(): { registerRequestFilter(filter: (type: number, request: ShakaRequest) => void): void } | null
  addEventListener(type: string, listener: (event: Event & { detail?: { severity?: number, code?: number } }) => void): void
  seekRange(): { start: number, end: number }
  isLive(): boolean
}
interface ShakaNamespace {
  polyfill: { installAll(): void }
  Player: { new (): ShakaPlayer, isBrowserSupported(): boolean }
  net: { NetworkingEngine: { registerScheme(scheme: string, plugin: ShakaPlugin, priority?: number, progressSupport?: boolean): void, PluginPriority: { APPLICATION: number } } }
  util: {
    AbortableOperation: new (promise: Promise<ShakaResponse>, onAbort: () => Promise<void>) => unknown
    Error: new (severity: number, category: number, code: number, ...data: unknown[]) => Error
  }
}

// 1 つの配信の読み込みを、shaka-player の要求に付けた目印で見分ける (読み込み部品は全体で 1 つしか登録できない)
const STREAM_HEADER = 'x-marumasign-stream'
const dashNets = new Map<string, DashNet>()
let dashNextId = 1
let schemeRegistered = false

function registerDashScheme(shaka: ShakaNamespace): void {
  if (schemeRegistered) return
  schemeRegistered = true
  const E = shaka.util.Error
  const plugin: ShakaPlugin = (uri, request, requestType, _progress, headersReceived) => {
    const id = request.headers[STREAM_HEADER] ?? ''
    const headers: Record<string, string> = {}
    for (const [k, v] of Object.entries(request.headers)) if (k.toLowerCase() !== STREAM_HEADER) headers[k] = v
    const net = dashNets.get(id)
    const controller = new AbortController()
    const started = performance.now()
    const promise = (async (): Promise<ShakaResponse> => {
      if (!net) throw new E(2, 1, 1002, uri, new Error('unknown stream'), requestType)
      const range = Object.entries(headers).find(([k]) => k.toLowerCase() === 'range')?.[1]
      let o: OpenResponse
      try {
        // MPD (0) は看板の URL か、その行き先。分割されたファイルなど (1) は MPD に書かれたもの
        o = await net.open(uri, { range, signal: controller.signal, timeout: request.retryParameters?.timeout || 20000, parents: requestType === 0 ? [] : undefined })
      }
      catch (e) {
        if (controller.signal.aborted) throw new E(2, 7, 7001)
        if (e instanceof HttpError) throw new E(e.status >= 500 ? 1 : 2, 1, 1001, uri, e.status, '', {}, requestType)
        throw new E(1, 1, 1002, uri, e, requestType)
      }
      try {
        const h = headersOf(o.res)
        headersReceived?.(h)
        const data = await readBody(o, requestType === 0 ? MAX_PLAYLIST_BYTES : MAX_SEGMENT_BYTES)
        if (requestType === 0) net.manifest = withoutFragment(o.url)
        return { uri: o.url, originalUri: uri, data, status: o.res.status, headers: h, timeMs: performance.now() - started, fromCache: false, originalRequest: request }
      }
      finally {
        o.done()
      }
    })()
    return new shaka.util.AbortableOperation(promise, () => {
      controller.abort()
      return Promise.resolve()
    })
  }
  shaka.net.NetworkingEngine.registerScheme('https', plugin, shaka.net.NetworkingEngine.PluginPriority.APPLICATION, false)
  // http は使わない (https のページに混ぜて読めない)
  shaka.net.NetworkingEngine.registerScheme('http', uri => new shaka.util.AbortableOperation(Promise.reject(new E(2, 1, 1000, uri)), () => Promise.resolve()),
    shaka.net.NetworkingEngine.PluginPriority.APPLICATION, false)
}

/** MPEG-DASH の配信の読み込み (MPD に書かれた URL は、MPD をたどり方にする) */
class DashNet extends StreamNet {
  manifest: string

  constructor(root: string) {
    super(root)
    this.manifest = this.root
  }

  override chain(url: string): string[] {
    const key = withoutFragment(url)
    if (key === this.root || key === this.manifest) return []
    return [this.manifest]
  }
}

async function attachDash(video: HTMLVideoElement, url: string, onFatal: (reason: string) => void): Promise<StreamAdapter> {
  check(url)
  const mod = await import('shaka-player/dist/shaka-player.dash-es2021.js') as unknown as { default?: ShakaNamespace } & Partial<ShakaNamespace>
  const shaka = (mod.Player ? mod : mod.default) as ShakaNamespace
  shaka.polyfill.installAll()
  if (!shaka.Player.isBrowserSupported()) throw new Error('DASH is not supported')
  registerDashScheme(shaka)
  const id = String(dashNextId++)
  const net = new DashNet(url)
  dashNets.set(id, net)
  const player = new shaka.Player()
  await player.attach(video)
  player.configure({
    streaming: {
      bufferingGoal: 10,
      rebufferingGoal: 2,
      bufferBehind: 10,
      retryParameters: { maxAttempts: 2, timeout: 15000 },
    },
    manifest: { retryParameters: { maxAttempts: 2, timeout: 15000 } },
  })
  player.getNetworkingEngine()?.registerRequestFilter((_type, request) => {
    for (const u of request.uris) check(u)
    request.allowCrossSiteCredentials = false
    request.headers[STREAM_HEADER] = id
  })
  player.addEventListener('error', (e) => {
    // 2 は CRITICAL (続けられない)
    if (e.detail?.severity === 2) onFatal('dash: ' + e.detail.code)
  })
  try {
    await player.load(url)
  }
  catch (e) {
    dashNets.delete(id)
    void player.destroy()
    throw e
  }
  return {
    pause: () => {},
    resume: () => {
      if (player.isLive()) video.currentTime = player.seekRange().end
    },
    destroy: () => {
      dashNets.delete(id)
      void player.destroy()
    },
  }
}

// ---------------------------------------------------------------- HTTP-FLV と、MPEG-TS・FLV のファイル (mpegts.js)

/** mpegts.js の読み込み部品の、使う部分だけの型 */
interface MpegtsSeekHandler {
  getConfig(url: string, range: { from: number, to: number }): { url: string, headers: Record<string, string> }
}

/** mpegts.js の読み込み部品 (fetch.ts の open で読み、少しずつ渡す) */
function mpegtsLoader(net: StreamNet): new (seekHandler: MpegtsSeekHandler) => object {
  return class SafeMpegtsLoader {
    _status = 0
    _needStash = true
    private readonly seekHandler: MpegtsSeekHandler
    private controller: AbortController | null = null
    private range = { from: 0, to: -1 }
    private received = 0
    onContentLengthKnown: ((length: number) => void) | null = null
    onURLRedirect: ((url: string) => void) | null = null
    onDataArrival: ((chunk: ArrayBuffer, byteStart: number, receivedLength?: number) => void) | null = null
    onError: ((type: string, info: { code: number, msg: string }) => void) | null = null
    onComplete: ((from: number, to: number) => void) | null = null

    constructor(seekHandler: MpegtsSeekHandler) {
      this.seekHandler = seekHandler
    }

    get type(): string {
      return 'marumasign-loader'
    }

    get status(): number {
      return this._status
    }

    get needStashBuffer(): boolean {
      return this._needStash
    }

    isWorking(): boolean {
      return this._status === 1 || this._status === 2
    }

    open(dataSource: { url: string }, range: { from: number, to: number }): void {
      this.range = range
      this.received = 0
      const seek = this.seekHandler.getConfig(dataSource.url, range)
      const rangeHeader = Object.entries(seek.headers || {}).find(([k]) => k.toLowerCase() === 'range')?.[1]
      const controller = new AbortController()
      this.controller = controller
      this._status = 1
      void net.open(seek.url, { range: rangeHeader, signal: controller.signal, timeout: 15000 }).then(async (o) => {
        // 応答が来たら時間切れの見張りは止める (配信は終わらない)
        o.done()
        const length = Number(o.res.headers.get('content-length'))
        if (o.res.headers.get('content-length') !== null && length > 0) this.onContentLengthKnown?.(length)
        if (!o.res.body) throw new Error('no body')
        const reader = o.res.body.getReader()
        this._status = 2
        for (;;) {
          const r = await reader.read()
          if (controller.signal.aborted) return
          if (r.done) break
          const chunk = r.value.buffer.slice(r.value.byteOffset, r.value.byteOffset + r.value.byteLength) as ArrayBuffer
          const start = this.range.from + this.received
          this.received += chunk.byteLength
          this.onDataArrival?.(chunk, start, this.received)
        }
        this._status = 4
        this.onComplete?.(this.range.from, this.range.from + this.received - 1)
      }).catch((e: unknown) => {
        if (controller.signal.aborted) return
        this._status = 3
        if (e instanceof HttpError) this.onError?.('HttpStatusCodeInvalid', { code: e.status, msg: e.message })
        else this.onError?.('Exception', { code: -1, msg: String(e) })
      })
    }

    abort(): void {
      this.controller?.abort()
      this.controller = null
      if (this._status !== 4) this._status = 0
    }

    destroy(): void {
      this.abort()
      this._status = 0
      this.onContentLengthKnown = this.onURLRedirect = this.onDataArrival = this.onError = this.onComplete = null
    }
  }
}

async function attachMpegts(type: 'flv' | 'mpegts', video: HTMLVideoElement, url: string, options: StreamOptions): Promise<StreamAdapter> {
  check(url)
  const { default: mpegts } = await import('mpegts.js')
  const features = mpegts.getFeatureList()
  if (!mpegts.isSupported() || (options.live && !features.mseLivePlayback)) throw new Error(type + ' is not supported')
  // 細かな記録はコンソールに出さない (警告と失敗だけ)
  mpegts.LoggingControl.enableVerbose = false
  mpegts.LoggingControl.enableDebug = false
  mpegts.LoggingControl.enableInfo = false
  const net = new StreamNet(url)
  const player = mpegts.createPlayer({ type, isLive: options.live, url, cors: true, withCredentials: false }, {
    enableWorker: false,
    lazyLoad: false,
    liveBufferLatencyChasing: options.live,
    autoCleanupSourceBuffer: true,
    referrerPolicy: 'no-referrer',
    seekType: 'range',
    customLoader: mpegtsLoader(net) as unknown as NonNullable<Parameters<typeof mpegts.createPlayer>[1]>['customLoader'],
  })
  player.on(mpegts.Events.ERROR, (errorType: string, detail: string) => options.onFatal(type + ': ' + errorType + ' ' + detail))
  // ライブ配信が終わった (送り手が止まった)。ファイルは読み終えただけ
  if (options.live) player.on(mpegts.Events.LOADING_COMPLETE, () => options.onFatal(type + ': ended'))
  player.attachMediaElement(video)
  player.load()
  return {
    pause: () => {
      if (options.live) player.unload()
    },
    resume: () => {
      if (options.live) player.load()
    },
    destroy: () => {
      player.unload()
      player.detachMediaElement()
      player.destroy()
    },
  }
}
