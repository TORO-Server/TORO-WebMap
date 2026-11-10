// 動画・音声・ライブ配信 (HLS, MPEG-DASH, HTTP-FLV, MJPEG) の看板
// ブラウザーが再生できない入れ物 (AVI, WMV など) は FFmpeg (WebAssembly) で変換し (sources/ffmpeg.ts)、MPEG-TS と FLV のファイルは mpegts.js で再生する。
// 直に読めない (CORS がない、転送される) ものは、地図のサーバーを通して読む (fetch.ts)
// MarumaSign 本体 (MediaSession, SignManager) と同じ考え方:
//  - 同じ URL の看板は 1 つの再生を分け合う
//  - 画面に入っている (最近 3 秒以内に入っていた) もののうち、近いものから MAX_PLAYING 個だけ再生し、ほかは止める (最後のコマは残る)
//  - 音は看板から離れるほど小さく (32 ブロックで聞こえなくなる。core.ts の mediaGain)
//  - ライブ配信が途切れたら、2 秒から倍にして 30 秒まで待って、つなぎ直す
// ブラウザーの決まりで、最初は音を消して再生する。画面の左下のボタンで音を出せる (state.ts)
import { CanvasTexture, Vector3, VideoTexture, type Texture } from 'three'
import { Board, placeholder, PLACEHOLDER_HEIGHT, PLACEHOLDER_WIDTH, setupTexture } from '../board'
import {
  extensionOf, HEARING_DISTANCE, mediaGain, mediaKindOf, nearest, reconnectDelay, TRANSCODE_CONTAINERS, type Route, type RouteType,
} from '../core'
import { probe, sniffAsync } from '../fetch'
import { setSoundHandler, signSound } from '../state'
import type { StreamAdapter } from '../sources/streams'
import type { MjpegStream } from '../sources/mjpeg'
import type * as FfmpegModule from '../sources/ffmpeg'
import type { RenderContext, RendererHooks, Sign, SignRenderer } from '../types'

// 同時に再生する数 (MarumaSign 本体は 8。ブラウザーでは重いので 4)
const MAX_PLAYING = 4
// video 要素を持っておく数 (止めたものも最後のコマを見せるために持っておく)
const MAX_ELEMENTS = 8
// この時間 (ミリ秒) 画面に入らなければ止める (MarumaSign 本体と同じ)
const IDLE_MILLIS = 3000
// 使う看板がなくなってから片付けるまで (ミリ秒)
const KEEP_MILLIS = 30000
// 再生できるようになるまで待つ時間 (ミリ秒)
const READY_TIMEOUT = 20000
// FFmpeg で変換するものは、順番待ちと読み込みと変換 (1 つ 90 秒まで) の分も待つ (変換が終わったら READY_TIMEOUT から待ち直す)
const TRANSCODE_READY_TIMEOUT = 10 * 60 * 1000
// ライブ配信で、この時間 (ミリ秒) 再生が進まなければ、止まったものとしてつなぎ直す (MarumaSign 本体と同じ)
const STALL_MILLIS = 15000
// この時間 (ミリ秒) 以上続いた再生のあとは、つなぎ直すまでの待ち時間を最初に戻す
const STABLE_MILLIS = 30000
const SCHEDULE_MILLIS = 400

type SourceType = 'video' | 'hls' | 'dash' | 'flv' | 'mjpeg' | 'mpegts' | 'ffmpeg'

let ffmpeg: typeof FfmpegModule | null = null

/** URL ごとの再生 (同じ URL の看板で分け合う) */
class MediaEntry {
  readonly url: string
  readonly ext: string
  type: SourceType
  /** video 要素に渡す URL (直に読めなければ地図のサーバーの中継、変換したものは blob:) */
  src: string
  /** FFmpeg での変換を試した (もう一度は試さない) */
  transcodeTried = false
  /** 変換したものを使っている */
  transcoded = false
  /** 音声だけかもしれない (拡張子や中身から)。分かれば hasVideo で決まる */
  audioHint: boolean
  readonly users = new Set<MediaRenderer>()
  state: 'idle' | 'probing' | 'loading' | 'ready' | 'failed' = 'idle'
  probed = false
  video: HTMLVideoElement | null = null
  mjpeg: MjpegStream | null = null
  stream: StreamAdapter | null = null
  texture: Texture | null = null
  width = 0
  height = 0
  hasVideo: boolean | null = null
  allowed = false
  lastSeen = 0
  lastUsed = Date.now()
  distance = Infinity
  live = false
  attempts = 0
  playingSince = 0
  lastTime = -1
  lastProgress = 0
  counted = false
  readyTimer: ReturnType<typeof setTimeout> | null = null
  retryTimer: ReturnType<typeof setTimeout> | null = null
  audio: { source: MediaElementAudioSourceNode, gain: GainNode, panner: PannerNode } | null = null
  /** 別の描き方 (画像や PDF) だったとき */
  reroute: Route | null = null
  frameCallback = 0

  constructor(url: string, type: SourceType, audioHint: boolean) {
    this.url = url
    this.src = url
    this.ext = extensionOf(url)
    this.type = type
    this.audioHint = audioHint
    this.live = type !== 'video'
  }

  get isAudio(): boolean {
    return this.hasVideo === false || (this.hasVideo === null && this.audioHint)
  }

  get wanted(): boolean {
    if (this.users.size === 0 || this.state === 'failed' || this.reroute) return false
    // ほかのタブを見ている間は止める
    if (document.hidden) return false
    if (Date.now() - this.lastSeen > IDLE_MILLIS) return false
    // 音声だけのものは、音を出していて、聞こえる距離にあるときだけ再生する
    return !this.isAudio || (signSound.on && this.distance < HEARING_DISTANCE)
  }
}

/** すべての動画の看板で 1 つ */
class MediaPool {
  readonly entries = new Map<string, MediaEntry>()
  ctx: RenderContext = null
  private container: HTMLElement | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private audioContext: AudioContext | null = null
  private readonly tmp = new Vector3()
  private readonly forward = new Vector3()

  init(ctx: RenderContext): void {
    if (this.ctx) return
    this.ctx = ctx
    this.timer = setInterval(() => this.schedule(), SCHEDULE_MILLIS)
    document.addEventListener('visibilitychange', () => this.schedule())
    setSoundHandler(on => this.setSound(on))
    ctx.addStats('media', () => {
      const list = Array.from(this.entries.values())
      return {
        entries: list.length,
        playing: list.filter(e => e.allowed && e.video && !e.video.paused || e.allowed && e.mjpeg).length,
        elements: list.filter(e => e.video || e.mjpeg).length,
        sound: signSound.on,
        detail: list.map(e => ({
          url: e.url.slice(-40), type: e.type, state: e.state, allowed: e.allowed, hasVideo: e.hasVideo,
          size: e.width + 'x' + e.height, distance: Math.round(e.distance), gain: e.audio ? Number(e.audio.gain.gain.value.toFixed(3)) : null,
        })),
      }
    })
  }

  entry(url: string, type: SourceType, audioHint: boolean): MediaEntry {
    let e = this.entries.get(url)
    if (!e) {
      e = new MediaEntry(url, type, audioHint)
      this.entries.set(url, e)
    }
    return e
  }

  // ---- 音

  /** ボタンが押されたとき (押した操作の中で呼ばれる) */
  private setSound(on: boolean): void {
    if (on && !this.audioContext) {
      try {
        this.audioContext = new AudioContext()
      }
      catch (e) {
        console.warn('MarumaSign: no audio', e)
        return
      }
    }
    if (on) void this.audioContext!.resume()
    signSound.on = on
    for (const e of this.entries.values()) {
      if (e.video) {
        if (on) this.connectAudio(e)
        e.video.muted = !on
        // 押した操作の中で再生を始めると、音の出る再生も許される
        if (on && e.allowed && e.video.paused) void e.video.play().catch(() => {})
      }
    }
    this.schedule()
  }

  private connectAudio(e: MediaEntry): void {
    const ac = this.audioContext
    if (!ac || !e.video || e.audio) return
    try {
      const source = ac.createMediaElementSource(e.video)
      const gain = ac.createGain()
      gain.gain.value = 0
      // 向きだけを表す (距離による大きさは gain で、MarumaSign 本体と同じ式にする)
      const panner = new PannerNode(ac, { panningModel: 'equalpower', distanceModel: 'linear', rolloffFactor: 0, refDistance: 1, maxDistance: 100000 })
      source.connect(gain).connect(panner).connect(ac.destination)
      e.audio = { source, gain, panner }
    }
    catch (err) {
      console.warn('MarumaSign: audio graph', err)
    }
  }

  private updateAudio(): void {
    const ac = this.audioContext
    const ctx = this.ctx
    if (!ac || !ctx) return
    const cam = ctx.viewer.camera
    const l = ac.listener
    const p = ctx.camera
    cam.getWorldDirection(this.forward)
    const t = ac.currentTime
    if (l.positionX) {
      l.positionX.setTargetAtTime(p.x, t, 0.1)
      l.positionY.setTargetAtTime(p.y, t, 0.1)
      l.positionZ.setTargetAtTime(p.z, t, 0.1)
      l.forwardX.setTargetAtTime(this.forward.x, t, 0.1)
      l.forwardY.setTargetAtTime(this.forward.y, t, 0.1)
      l.forwardZ.setTargetAtTime(this.forward.z, t, 0.1)
      l.upX.value = 0
      l.upY.value = 1
      l.upZ.value = 0
    }
    for (const e of this.entries.values()) {
      if (!e.audio) continue
      const gain = signSound.on && e.allowed ? mediaGain(e.distance, 100) : 0
      e.audio.gain.gain.setTargetAtTime(gain, t, 0.15)
      // いちばん近い看板の位置から聞こえる
      let best: MediaRenderer | null = null
      for (const u of e.users) if (!best || u.distance < best.distance) best = u
      if (best) {
        best.center(this.tmp)
        e.audio.panner.positionX.setTargetAtTime(this.tmp.x, t, 0.1)
        e.audio.panner.positionY.setTargetAtTime(this.tmp.y, t, 0.1)
        e.audio.panner.positionZ.setTargetAtTime(this.tmp.z, t, 0.1)
      }
    }
  }

  // ---- 再生する数の上限

  schedule(): void {
    const now = Date.now()
    let audible = false
    for (const [url, e] of this.entries) {
      let d = Infinity
      for (const u of e.users) d = Math.min(d, u.distance)
      e.distance = d
      if (e.users.size > 0) {
        e.lastUsed = now
        // 音が出るかもしれない看板が近くにある (映像に音が付いているかは、再生するまで分からない)
        if (e.state !== 'failed' && !e.reroute) audible = true
      }
      else if (now - e.lastUsed > KEEP_MILLIS) {
        this.destroy(e)
        this.entries.delete(url)
      }
    }
    signSound.available = audible
    const wanted = Array.from(this.entries.values()).filter(e => e.wanted)
    const allowed = nearest(wanted, e => e.distance, MAX_PLAYING)
    for (const e of this.entries.values()) this.allow(e, allowed.has(e))
    this.updateAudio()
  }

  private allow(e: MediaEntry, value: boolean): void {
    const was = e.allowed
    e.allowed = value
    if (value) {
      if (!was) void this.play(e)
      else this.watch(e)
    }
    else if (was) {
      this.pause(e)
    }
  }

  private async play(e: MediaEntry): Promise<void> {
    if (!e.probed) {
      await this.probe(e)
      if (!e.allowed || e.state === 'failed' || e.reroute) return
    }
    if (e.type === 'mjpeg') {
      await this.playMjpeg(e)
      return
    }
    if (!e.video) {
      this.makeRoom(e)
      await this.createVideo(e)
      if (!e.video) return
    }
    else if (e.stream) {
      e.stream.resume()
    }
    if (!e.allowed) return
    e.video.muted = !signSound.on
    e.playingSince = Date.now()
    e.lastProgress = Date.now()
    e.lastTime = -1
    void e.video.play().catch(() => {
      // 音を出して再生できなければ (操作の外)、音を消して再生し直す
      if (e.video && !e.video.muted) {
        e.video.muted = true
        void e.video.play().catch(() => {})
      }
    })
    this.requestFrames(e)
  }

  private pause(e: MediaEntry): void {
    this.setLoading(e, false)
    if (e.video) {
      e.video.pause()
      e.stream?.pause()
    }
    e.mjpeg?.stop()
    if (e.retryTimer) {
      clearTimeout(e.retryTimer)
      e.retryTimer = null
    }
  }

  /** 読み込み中の数 (window.marumasign3d.stats().loading) */
  private setLoading(e: MediaEntry, value: boolean): void {
    if (e.counted === value || !this.ctx) return
    e.counted = value
    this.ctx.loads.loading += value ? 1 : -1
    if (!value && e.readyTimer) {
      clearTimeout(e.readyTimer)
      e.readyTimer = null
    }
  }

  /** 先頭を読んで確かめる (CORS が通るか、転送されないか、中身の種類) */
  private async probe(e: MediaEntry): Promise<void> {
    e.state = 'probing'
    this.setLoading(e, true)
    this.notify(e)
    try {
      const r = await probe(e.url)
      e.probed = true
      e.src = r.src
      const s = await sniffAsync(r.head, r.type, e.ext)
      if (s) {
        if (s.route === 'image' || s.route === 'pdf' || s.route === 'model' || s.route === 'splat' || s.route === 'structure') {
          e.reroute = { type: s.route, url: e.url, ext: e.ext }
        }
        else if (s.route === 'video' || s.route === 'hls' || s.route === 'dash' || s.route === 'flv' || s.route === 'mjpeg') {
          // 拡張子と中身が違えば、中身を信じる (.mp4 の名前の HLS など)
          let type: SourceType = s.route
          if (s.container === 'ts') type = 'mpegts'
          else if (s.container && TRANSCODE_CONTAINERS.has(s.container)) type = 'ffmpeg'
          e.type = type
          // MPEG-TS と FLV は、大きさの分からない (終わらない) ものだけをライブ配信とする
          e.live = type === 'flv' || type === 'mpegts' ? r.length === null : type !== 'video' && type !== 'ffmpeg'
          if (s.format === 'audio') e.audioHint = true
        }
      }
      e.state = 'idle'
    }
    catch (err) {
      console.info('MarumaSign: cannot read', e.url, String(err))
      e.state = 'failed'
    }
    this.setLoading(e, false)
    this.notify(e)
  }

  /** video 要素を持てる数を超えるなら、止めているもののうち最も古く使ったものを片付ける */
  private makeRoom(keep: MediaEntry): void {
    const holding = Array.from(this.entries.values()).filter(e => e !== keep && (e.video || e.mjpeg))
    if (holding.length < MAX_ELEMENTS) return
    const idle = holding.filter(e => !e.allowed).sort((a, b) => a.lastSeen - b.lastSeen)
    for (const e of idle) {
      if (holding.length < MAX_ELEMENTS) break
      this.release(e)
      holding.splice(holding.indexOf(e), 1)
    }
  }

  private async createVideo(e: MediaEntry): Promise<void> {
    if (!this.container) {
      // 画面の外の見えない入れ物 (iPhone の Safari は、ページにない video 要素の絵を更新しないことがある)
      const c = document.createElement('div')
      c.style.cssText = 'position:fixed;left:0;top:0;width:1px;height:1px;overflow:hidden;opacity:0;pointer-events:none;z-index:-1'
      c.setAttribute('aria-hidden', 'true')
      document.body.appendChild(c)
      this.container = c
    }
    const v = document.createElement('video')
    v.crossOrigin = 'anonymous'
    v.muted = true
    v.playsInline = true
    v.setAttribute('playsinline', '')
    v.preload = 'auto'
    v.loop = !e.live
    v.disableRemotePlayback = true
    v.width = 2
    v.height = 2
    this.container.appendChild(v)
    e.video = v
    e.state = 'loading'
    this.setLoading(e, true)
    e.readyTimer = setTimeout(() => {
      if (e.state === 'loading') this.fail(e, 'timeout')
    }, e.type === 'ffmpeg' ? TRANSCODE_READY_TIMEOUT : READY_TIMEOUT)
    this.notify(e)
    v.addEventListener('loadedmetadata', () => {
      e.hasVideo = v.videoWidth > 0 && v.videoHeight > 0
      if (!e.hasVideo) this.ready(e)
    })
    v.addEventListener('loadeddata', () => this.ready(e))
    v.addEventListener('resize', () => {
      if (e.state === 'ready' && v.videoWidth > 0 && (v.videoWidth !== e.width || v.videoHeight !== e.height)) {
        e.width = v.videoWidth
        e.height = v.videoHeight
        this.notify(e)
      }
    })
    v.addEventListener('error', () => {
      if (e.video !== v) return
      const code = v.error?.code ?? 0
      // 3: 映像や音声を読めない、4: 形式に対応していない。ファイルなら FFmpeg で変換してみる
      if ((code === 3 || code === 4) && this.canTranscode(e)) this.transcodeInstead(e, 'media error ' + code)
      else if (e.live && e.state === 'ready') this.reconnect(e, 'error')
      else this.fail(e, 'media error ' + code)
    })
    v.addEventListener('ended', () => {
      if (e.video !== v) return
      if (e.live) this.reconnect(e, 'ended')
      // mpegts.js で再生したファイルは、loop では頭に戻らないので、つなぎ直す
      else if (e.stream) void this.reattach(e)
    })
    try {
      await this.attach(e, v)
    }
    catch (err) {
      if (e.video !== v) return
      if (this.canTranscode(e)) this.transcodeInstead(e, String(err))
      else this.fail(e, String(err))
    }
  }

  /** video 要素に中身をつなぐ */
  private async attach(e: MediaEntry, v: HTMLVideoElement): Promise<void> {
    if (e.type === 'video') {
      v.src = e.src
    }
    else if (e.type === 'ffmpeg') {
      e.transcodeTried = true
      ffmpeg ??= await import('../sources/ffmpeg')
      if (e.video !== v) return
      const t = await ffmpeg.transcode(e.url)
      if (e.video !== v) {
        ffmpeg.release(e.url)
        return
      }
      if (!e.transcoded) {
        e.transcoded = true
        if (t.audioOnly) e.hasVideo = false
      }
      e.src = t.src
      v.src = t.src
      // ここからは、ほかのものと同じだけ待つ
      if (e.readyTimer) {
        clearTimeout(e.readyTimer)
        e.readyTimer = setTimeout(() => {
          if (e.state === 'loading' && e.video === v) this.fail(e, 'timeout')
        }, READY_TIMEOUT)
      }
    }
    else {
      const { attachStream } = await import('../sources/streams')
      if (e.video !== v) return
      e.stream = await attachStream(e.type as 'hls' | 'dash' | 'flv' | 'mpegts', v, e.url, {
        live: e.live,
        onFatal: (reason) => {
          if (e.video !== v) return
          if (this.canTranscode(e) && e.state !== 'ready') this.transcodeInstead(e, reason)
          else this.reconnect(e, reason)
        },
      })
      if (e.video !== v) {
        e.stream?.destroy()
      }
    }
  }

  /** ブラウザーで再生できなかったファイルを、FFmpeg で変換して再生し直せるか */
  private canTranscode(e: MediaEntry): boolean {
    return !e.transcodeTried && !e.live && (e.type === 'video' || e.type === 'mpegts' || e.type === 'flv')
  }

  private transcodeInstead(e: MediaEntry, reason: string): void {
    console.info('MarumaSign: cannot play in the browser, converting', e.url, reason)
    e.transcodeTried = true
    this.release(e)
    e.type = 'ffmpeg'
    e.state = 'idle'
    e.hasVideo = null
    this.notify(e)
    if (e.allowed) void this.play(e)
  }

  private ready(e: MediaEntry): void {
    const v = e.video
    if (!v || e.state === 'ready') return
    e.state = 'ready'
    this.setLoading(e, false)
    if (e.hasVideo === null) e.hasVideo = v.videoWidth > 0
    if (e.hasVideo) {
      e.width = v.videoWidth
      e.height = v.videoHeight
      if (!e.texture) e.texture = setupTexture(new VideoTexture(v), false)
    }
    if (signSound.on) this.connectAudio(e)
    this.notify(e)
    this.schedule()
  }

  private fail(e: MediaEntry, reason: string): void {
    console.info('MarumaSign: cannot play', e.url, reason)
    this.release(e)
    e.state = 'failed'
    this.notify(e)
  }

  /** ライブ配信をつなぎ直す (再生していなければ、次に再生するときにつなぐ) */
  private reconnect(e: MediaEntry, reason: string): void {
    if (!e.live) {
      this.fail(e, reason)
      return
    }
    if (e.retryTimer) return
    if (Date.now() - e.playingSince > STABLE_MILLIS) e.attempts = 0
    const wait = reconnectDelay(e.attempts++)
    console.info('MarumaSign: reconnecting', e.url, reason, wait + 'ms')
    // 最後のコマは残したまま、つなぎ直す
    e.stream?.destroy()
    e.stream = null
    e.mjpeg?.stop()
    const v = e.video
    if (v) {
      v.pause()
      v.removeAttribute('src')
      v.load()
    }
    e.retryTimer = setTimeout(() => {
      e.retryTimer = null
      if (!e.allowed) return
      if (e.type === 'mjpeg') {
        void e.mjpeg?.start()
        return
      }
      if (!e.video) return
      void this.reattach(e)
    }, wait)
  }

  private async reattach(e: MediaEntry): Promise<void> {
    const v = e.video
    if (!v) return
    try {
      e.stream?.destroy()
      e.stream = null
      if (e.type === 'video' || e.type === 'ffmpeg') v.src = e.src
      else await this.attach(e, v)
      e.playingSince = Date.now()
      e.lastProgress = Date.now()
      void v.play().catch(() => {})
    }
    catch (err) {
      this.reconnect(e, String(err))
    }
  }

  /** 再生しているものが止まっていないかを見る */
  private watch(e: MediaEntry): void {
    const v = e.video
    if (!e.live || !v || e.state !== 'ready' || e.retryTimer) return
    const now = Date.now()
    if (v.currentTime !== e.lastTime) {
      e.lastTime = v.currentTime
      e.lastProgress = now
    }
    else if (now - e.lastProgress > STALL_MILLIS) {
      e.lastProgress = now
      this.reconnect(e, 'stalled')
    }
  }

  private async playMjpeg(e: MediaEntry): Promise<void> {
    if (!e.mjpeg) {
      this.makeRoom(e)
      const { MjpegStream } = await import('../sources/mjpeg')
      if (e.mjpeg || !e.allowed) return
      const m = new MjpegStream(e.url)
      e.mjpeg = m
      e.state = 'loading'
      e.hasVideo = true
      this.setLoading(e, true)
      e.readyTimer = setTimeout(() => {
        if (e.state === 'loading') this.fail(e, 'timeout')
      }, READY_TIMEOUT)
      this.notify(e)
      const tex = setupTexture(new CanvasTexture(m.canvas), false)
      m.onFrame = (first) => {
        tex.needsUpdate = true
        if (first || m.width !== e.width || m.height !== e.height) {
          e.width = m.width
          e.height = m.height
          if (e.state !== 'ready') {
            e.state = 'ready'
            e.texture = tex
            this.setLoading(e, false)
          }
          this.notify(e)
        }
        this.ctx?.redraw()
      }
      m.onEnd = (reason) => {
        if (e.state === 'ready') this.reconnect(e, reason)
        else this.fail(e, reason)
      }
    }
    e.playingSince = Date.now()
    await e.mjpeg.start()
  }

  /** 新しいコマが来たら描き直す */
  private requestFrames(e: MediaEntry): void {
    const v = e.video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }
    if (!v || !v.requestVideoFrameCallback || e.frameCallback) return
    const loop = (): void => {
      e.frameCallback = 0
      if (e.video !== v || !e.allowed) return
      this.ctx?.redraw()
      e.frameCallback = v.requestVideoFrameCallback!(loop)
    }
    e.frameCallback = v.requestVideoFrameCallback(loop)
  }

  /** video 要素などを片付ける (最後のコマも消え、次に再生するときは読み直す) */
  private release(e: MediaEntry): void {
    this.setLoading(e, false)
    if (e.retryTimer) {
      clearTimeout(e.retryTimer)
      e.retryTimer = null
    }
    e.stream?.destroy()
    e.stream = null
    e.mjpeg?.stop()
    e.mjpeg = null
    if (e.transcoded) {
      // 変換したものは sources/ffmpeg.ts が覚えている (次に再生するときに使い直す)
      e.transcoded = false
      ffmpeg?.release(e.url)
    }
    if (e.audio) {
      try {
        e.audio.source.disconnect()
        e.audio.gain.disconnect()
        e.audio.panner.disconnect()
      }
      catch { /* もう外れている */ }
      e.audio = null
    }
    const v = e.video
    if (v) {
      v.pause()
      v.removeAttribute('src')
      v.load()
      v.remove()
    }
    e.video = null
    e.texture?.dispose()
    e.texture = null
    e.frameCallback = 0
    if (e.state !== 'failed') e.state = 'idle'
    this.notify(e)
  }

  private destroy(e: MediaEntry): void {
    e.allowed = false
    this.release(e)
  }

  private notify(e: MediaEntry): void {
    for (const u of e.users) u.refresh()
  }
}

const pool = new MediaPool()

const STREAM_TYPES = new Set<RouteType>(['video', 'hls', 'dash', 'flv', 'mjpeg'])

/** 看板 1 つ */
export class MediaRenderer implements SignRenderer {
  readonly sign: Sign
  private readonly ctx: RenderContext
  private readonly hooks: RendererHooks
  private readonly board: Board
  private readonly entry: MediaEntry
  distance = Infinity
  private shownState = ''

  constructor(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks) {
    this.ctx = ctx
    this.sign = sign
    this.hooks = hooks
    this.board = new Board(ctx, sign)
    pool.init(ctx)
    const type = (STREAM_TYPES.has(route.type) ? route.type : 'video') as SourceType
    const audio = sign.kindId === 'audio' || mediaKindOf(route.ext) === 'audio'
    this.entry = pool.entry(route.url, type, audio)
  }

  start(): void {
    this.entry.users.add(this)
    this.refresh()
  }

  update(distance: number): void {
    this.distance = distance
    if (!this.board.mesh || this.ctx.inView(this.board.mesh)) this.entry.lastSeen = Date.now()
  }

  center(out: Vector3): Vector3 {
    return this.board.center(out)
  }

  /** 再生の状態が変わったとき */
  refresh(): void {
    const e = this.entry
    if (e.reroute) {
      this.hooks.reroute(e.reroute)
      return
    }
    const kind = e.isAudio ? 'audio' : 'video'
    let key: string
    if (e.state === 'ready' && e.hasVideo && e.texture) key = 'tex:' + e.width + 'x' + e.height
    else if (e.state === 'failed') key = kind + ':error'
    else if (e.state === 'probing' || e.state === 'loading') key = kind + ':loading'
    else key = kind + ':ok'
    if (key === this.shownState) return
    this.shownState = key
    if (key.startsWith('tex:')) {
      this.board.show(e.texture!, e.width, e.height, false)
    }
    else {
      const state = e.state === 'failed' ? 'error' : e.state === 'probing' || e.state === 'loading' ? 'loading' : 'ok'
      this.board.show(placeholder(kind, state), PLACEHOLDER_WIDTH, PLACEHOLDER_HEIGHT)
    }
    this.hooks.shown()
  }

  dispose(): void {
    this.entry.users.delete(this)
    this.board.remove()
  }
}

export function createMediaRenderer(ctx: RenderContext, sign: Sign, route: Route, hooks: RendererHooks): SignRenderer {
  return new MediaRenderer(ctx, sign, route, hooks)
}
