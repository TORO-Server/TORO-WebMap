/// <reference lib="webworker" />
// FFmpeg (WebAssembly、@ffmpeg/core の 1 スレッドの版。GPL-2.0-or-later) で、ブラウザーが再生できない動画・音声を、再生できる MP4 にする Worker。
// SharedArrayBuffer は使わない (使うにはページを cross-origin isolated にする必要があり、ほかのサイトの画像などが読めなくなる)。
// FFmpeg の本体と wasm は、ビルドに入れて同じサイト (/_nuxt/) から読む。FFmpeg にはネットワークを使わせない (読むのは渡したファイルだけ)
import coreUrl from '@ffmpeg/core?url'
import wasmUrl from '@ffmpeg/core/wasm?url'

interface Core {
  exec(...args: string[]): number
  setTimeout(ms: number): void
  setLogger(logger: (data: { type: string, message: string }) => void): void
  reset(): void
  ret: number
  FS: {
    writeFile(path: string, data: Uint8Array): void
    readFile(path: string): Uint8Array
    unlink(path: string): void
    stat(path: string): { size: number }
  }
}

export interface TranscodeRequest {
  id: number
  input: Uint8Array
  /** 変換に使ってよい時間 (ミリ秒) */
  budget: number
  /** 映像を作り直すとき (再生できない形式) の長さの上限 (秒) */
  maxVideoSeconds: number
  /** 写し替えるだけ・音声だけのときの長さの上限 (秒) */
  maxCopySeconds: number
  /** 映像の幅の上限 */
  maxWidth: number
  /** 書き出す大きさの上限 (バイト) */
  maxOutput: number
}

export interface TranscodeResult {
  id: number
  output?: Uint8Array
  error?: string
  /** 時間か大きさの上限で、途中までになった */
  partial?: boolean
  audioOnly?: boolean
  /** 何をしたか (記録用) */
  plan?: string
}

let core: Core | null = null
let log: string[] = []

async function load(): Promise<Core> {
  if (core) return core
  const abs = (u: string): string => new URL(u, self.location.href).href
  const mod = await import(/* @vite-ignore */ abs(coreUrl)) as { default: (args: object) => Promise<Core> }
  // wasm の場所は、URL の「#」の後ろに書いて渡す (@ffmpeg/core の決まり)
  const c = await mod.default({ mainScriptUrlOrBlob: abs(coreUrl) + '#' + btoa(JSON.stringify({ wasmURL: abs(wasmUrl), workerURL: '' })) })
  c.setLogger((d) => {
    if (log.length < 400) log.push(d.message)
  })
  core = c
  return c
}

interface StreamInfo {
  kind: 'video' | 'audio'
  codec: string
  line: string
  width: number
  height: number
  fps: number
}

/** ffmpeg -i の記録から、映像と音声の形式 */
function parseStreams(lines: string[]): StreamInfo[] {
  const out: StreamInfo[] = []
  for (const line of lines) {
    const m = /Stream #\d+:\d+.*?: (Video|Audio): ([a-z0-9_]+)/.exec(line)
    if (!m) continue
    // 音声ファイルの表紙の画像は映像として数えない
    if (m[1] === 'Video' && /attached pic/.test(line)) continue
    const size = /, (\d{1,5})x(\d{1,5})[ ,]/.exec(line)
    const fps = / (\d+(?:\.\d+)?) fps/.exec(line)
    out.push({
      kind: m[1] === 'Video' ? 'video' : 'audio', codec: m[2]!, line,
      width: size ? Number(size[1]) : 0, height: size ? Number(size[2]) : 0, fps: fps ? Number(fps[1]) : 0,
    })
  }
  return out
}

// ブラウザーがそのまま再生できる形式 (MP4 に写し替えるだけでよいもの)
const COPY_VIDEO = new Set(['h264', 'vp9', 'av1'])
const COPY_AUDIO = new Set(['aac', 'mp3', 'opus', 'flac'])

/**
 * 中身が、ほかのファイルや URL を読ませる再生リスト (HLS、DASH、ffconcat、IMF) か (MarumaSign 本体の Ffmpeg.isPlaylist と同じ)。
 * FFmpeg には渡さない (渡したファイルのほかは読ませない)
 */
function isPlaylist(data: Uint8Array): boolean {
  let end = 0
  while (end < data.length && end < 65536 && data[end] !== 0) end++
  let text = ''
  for (let i = 0; i < end; i++) text += String.fromCharCode(data[i]!)
  text = text.toLowerCase()
  return text.includes('#extm3u') || text.includes('<mpd') || text.includes('ffconcat') || text.includes('<compositionplaylist')
}

function run(req: TranscodeRequest): TranscodeResult {
  if (isPlaylist(req.input)) return { id: req.id, error: 'playlist is not allowed' }
  const c = core!
  try {
    c.FS.unlink('in')
  }
  catch { /* なかった */ }
  try {
    c.FS.unlink('out.mp4')
  }
  catch { /* なかった */ }
  c.FS.writeFile('in', req.input)
  // 中身を調べる (出力を書かないので失敗の終わり方をするが、記録に形式が出る)
  log = []
  c.setTimeout(15000)
  c.exec('-hide_banner', '-nostdin', '-protocol_whitelist', 'file', '-i', 'in')
  c.reset()
  const streams = parseStreams(log)
  const v = streams.find(s => s.kind === 'video')
  const a = streams.find(s => s.kind === 'audio')
  if (!v && !a) return { id: req.id, error: 'no playable stream: ' + log.slice(-3).join(' | ').slice(0, 300) }
  const copyVideo = !!v && COPY_VIDEO.has(v.codec) && /yuvj?420p[ ,(]/.test(v.line) && v.width <= 4096 && v.height <= 4096
  const copyAudio = !!a && COPY_AUDIO.has(a.codec)
  const seconds = v && !copyVideo ? req.maxVideoSeconds : req.maxCopySeconds
  const args = ['-hide_banner', '-nostdin', '-y', '-protocol_whitelist', 'file', '-i', 'in', '-t', String(seconds)]
  if (v) args.push('-map', '0:v:0')
  if (a) args.push('-map', '0:a:0')
  if (v) {
    if (copyVideo) args.push('-c:v', 'copy')
    else {
      args.push(
        '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-pix_fmt', 'yuv420p', '-g', '60',
        '-vf', `scale='trunc(min(${req.maxWidth},iw)/2)*2':-2:flags=fast_bilinear`,
      )
      if (v.fps > 30) args.push('-r', '30')
    }
  }
  if (a) {
    if (copyAudio) args.push('-c:a', 'copy')
    else args.push('-c:a', 'aac', '-b:a', '128k', '-ac', '2')
  }
  // 細切れの MP4 にする (時間切れで途中までになっても、そこまでは再生できる)
  args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-fs', String(req.maxOutput), '-f', 'mp4', 'out.mp4')
  log = []
  c.setTimeout(req.budget)
  const started = Date.now()
  const ret = c.exec(...args)
  c.reset()
  const elapsed = Date.now() - started
  let output: Uint8Array | null = null
  try {
    output = c.FS.readFile('out.mp4')
  }
  catch { /* 書けなかった */ }
  try {
    c.FS.unlink('in')
    c.FS.unlink('out.mp4')
  }
  catch { /* もうない */ }
  const plan = (v ? (copyVideo ? 'v:copy(' + v.codec + ')' : 'v:x264(' + v.codec + ')') : 'v:none') + ' '
    + (a ? (copyAudio ? 'a:copy(' + a.codec + ')' : 'a:aac(' + a.codec + ')') : 'a:none') + ' ' + elapsed + 'ms'
  if (!output || output.length < 1024) return { id: req.id, error: 'ffmpeg failed (' + ret + '): ' + log.slice(-3).join(' | ').slice(0, 300), plan }
  return { id: req.id, output, partial: ret !== 0 || elapsed >= req.budget, audioOnly: !v, plan }
}

self.onmessage = async (ev: MessageEvent<TranscodeRequest>) => {
  const req = ev.data
  try {
    await load()
    const r = run(req)
    const transfer: Transferable[] = r.output ? [r.output.buffer as ArrayBuffer] : []
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage(r, transfer)
  }
  catch (e) {
    ;(self as unknown as DedicatedWorkerGlobalScope).postMessage({ id: req.id, error: String(e) } satisfies TranscodeResult)
  }
}
