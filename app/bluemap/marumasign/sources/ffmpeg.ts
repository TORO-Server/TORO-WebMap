// ブラウザーが再生できない動画・音声 (AVI, WMV/ASF, MPEG-1/2 の PS, 3GP の H.263/AMR, Ogg Theora, RealMedia, AIFF など。
// MarumaSign 本体は FFmpeg で何でも再生する) を、FFmpeg (WebAssembly, sources/ffmpeg-worker.ts) で再生できる MP4 にして、blob: の URL で video 要素に渡す。
// FFmpeg (約 31 MB) は、そうした看板が来たときに初めて読み込む。重いので:
//  - 変換は全体で 1 つずつ。待つのは 8 つまで (video 要素を持つ数と同じ。それより多ければ失敗にする)
//  - 1 回の変換に使う時間は 90 秒まで (それを過ぎたら、そこまでの分を再生する)。映像を作り直すときは最初の 60 秒、幅 640 まで
//  - 読むファイルは 128 MB まで (それより大きいものは最初の 128 MB だけ)、書き出しは 96 MB まで
//  - 変換したものは 3 つまで覚えておく。使わなくなって 60 秒で Worker を止める (メモリを返す)
import { open } from '../fetch'

const MAX_INPUT_BYTES = 128 * 1024 * 1024
const MAX_OUTPUT_BYTES = 96 * 1024 * 1024
const BUDGET_MILLIS = 90 * 1000
const MAX_VIDEO_SECONDS = 60
const MAX_COPY_SECONDS = 600
const MAX_WIDTH = 640
const MAX_QUEUE = 8
const MAX_RESULTS = 3
const IDLE_MILLIS = 60 * 1000

export interface Transcoded {
  /** video 要素に渡す URL (blob:) */
  src: string
  audioOnly: boolean
  partial: boolean
  bytes: number
}

interface Result { id: number, output?: Uint8Array, error?: string, partial?: boolean, audioOnly?: boolean, plan?: string }

let worker: Worker | null = null
let nextId = 1
let idleTimer: ReturnType<typeof setTimeout> | null = null
const waiting = new Map<number, (r: Result) => void>()
let running: Promise<unknown> = Promise.resolve()
let queued = 0
const results = new Map<string, { promise: Promise<Transcoded>, users: number }>()

function getWorker(): Worker {
  if (idleTimer) {
    clearTimeout(idleTimer)
    idleTimer = null
  }
  if (worker) return worker
  const w = new Worker(new URL('./ffmpeg-worker.ts', import.meta.url), { type: 'module', name: 'marumasign-ffmpeg' })
  w.onmessage = (ev: MessageEvent<Result>) => {
    const done = waiting.get(ev.data.id)
    waiting.delete(ev.data.id)
    done?.(ev.data)
  }
  w.onerror = (ev) => {
    for (const [id, done] of waiting) done({ id, error: 'worker error: ' + (ev.message || '') })
    waiting.clear()
    w.terminate()
    if (worker === w) worker = null
  }
  worker = w
  return w
}

function scheduleIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = setTimeout(() => {
    if (waiting.size === 0 && worker) {
      worker.terminate()
      worker = null
    }
  }, IDLE_MILLIS)
}

/** 先頭から max バイトまで読む (それより大きなファイルは、そこで止める。多くの形式は途中までも読める) */
async function download(url: string): Promise<{ data: Uint8Array, truncated: boolean }> {
  const o = await open(url, 'default', 120000)
  try {
    if (!o.res.body) throw new Error('no body')
    const reader = o.res.body.getReader()
    const chunks: Uint8Array[] = []
    let total = 0
    let truncated = false
    for (;;) {
      const r = await reader.read()
      if (r.done) break
      chunks.push(r.value)
      total += r.value.length
      if (total >= MAX_INPUT_BYTES) {
        truncated = true
        o.controller.abort()
        break
      }
    }
    const data = new Uint8Array(Math.min(total, MAX_INPUT_BYTES))
    let at = 0
    for (const c of chunks) {
      const part = c.subarray(0, Math.min(c.length, data.length - at))
      data.set(part, at)
      at += part.length
      if (at >= data.length) break
    }
    return { data, truncated }
  }
  finally {
    o.done()
  }
}

async function convert(url: string): Promise<Transcoded> {
  if (queued >= MAX_QUEUE) throw new Error('ffmpeg busy')
  queued++
  const job = running.then(async () => {
    const { data, truncated } = await download(url)
    const id = nextId++
    const w = getWorker()
    const r = await new Promise<Result>((resolve) => {
      waiting.set(id, resolve)
      w.postMessage({
        id, input: data, budget: BUDGET_MILLIS, maxVideoSeconds: MAX_VIDEO_SECONDS, maxCopySeconds: MAX_COPY_SECONDS,
        maxWidth: MAX_WIDTH, maxOutput: MAX_OUTPUT_BYTES,
      }, [data.buffer])
    })
    if (r.plan) console.info('MarumaSign: ffmpeg', url, r.plan, r.partial ? '(partial)' : '', truncated ? '(input truncated)' : '')
    if (!r.output) throw new Error(r.error || 'ffmpeg failed')
    const blob = new Blob([r.output as BlobPart], { type: r.audioOnly ? 'audio/mp4' : 'video/mp4' })
    return { src: URL.createObjectURL(blob), audioOnly: !!r.audioOnly, partial: !!r.partial || truncated, bytes: blob.size }
  })
  running = job.catch(() => {}).finally(() => {
    queued--
    if (waiting.size === 0) scheduleIdle()
  })
  return job
}

/**
 * URL の動画・音声を、再生できる MP4 にする (同じ URL は 1 回だけ。使い終えたら release を呼ぶ)
 */
export function transcode(url: string): Promise<Transcoded> {
  let r = results.get(url)
  if (!r) {
    r = { promise: convert(url), users: 0 }
    results.set(url, r)
    const entry = r
    r.promise.catch(() => {
      if (results.get(url) === entry) results.delete(url)
    })
  }
  r.users++
  // 覚えておく数を超えたら、使われていない古いものを消す
  if (results.size > MAX_RESULTS) {
    for (const [key, v] of results) {
      if (results.size <= MAX_RESULTS) break
      if (v.users > 0 || key === url) continue
      results.delete(key)
      void v.promise.then(t => URL.revokeObjectURL(t.src), () => {})
    }
  }
  return r.promise
}

export function release(url: string): void {
  const r = results.get(url)
  if (r && r.users > 0) r.users--
}
