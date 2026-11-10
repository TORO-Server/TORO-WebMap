// MJPEG の配信 (ネットワークカメラなどの multipart/x-mixed-replace) を、canvas のテクスチャにする
// fetch で読み続け、JPEG の始まり (FF D8) と終わり (FF D9) でコマを切り出して描く。CORS が通らなければ読めない
import { open, type OpenResponse } from '../fetch'

// 1 コマの大きさの上限と、描く大きさの上限 (MarumaSign 本体の MAX_VIDEO_SIZE と同じ)
const MAX_FRAME_BYTES = 4 * 1024 * 1024
const MAX_SIZE = 1280
// 描く間隔の下限 (ミリ秒)。速すぎる配信は間引く
const MIN_INTERVAL = 66

export class MjpegStream {
  readonly canvas = document.createElement('canvas')
  private readonly g = this.canvas.getContext('2d')!
  private o: OpenResponse | null = null
  private stopped = true
  private lastDraw = 0
  private decoding = false
  /** 最初のコマを描いたとき (大きさが分かる) */
  onFrame: (first: boolean) => void = () => {}
  /** 読めなくなったとき (終わった、途切れた) */
  onEnd: (reason: string) => void = () => {}
  private drawn = false
  readonly url: string

  constructor(url: string) {
    this.url = url
    this.canvas.width = 2
    this.canvas.height = 2
  }

  get width(): number {
    return this.canvas.width
  }

  get height(): number {
    return this.canvas.height
  }

  async start(): Promise<void> {
    if (!this.stopped) return
    this.stopped = false
    let o: OpenResponse
    try {
      o = await open(this.url, 'no-store', 15000)
    }
    catch (e) {
      this.stopped = true
      this.onEnd(String(e))
      return
    }
    // 応答が来たら、時間切れの見張りは止める (配信は終わらない)
    o.done()
    if (this.stopped) {
      o.controller.abort()
      return
    }
    this.o = o
    void this.pump(o)
  }

  stop(): void {
    this.stopped = true
    this.o?.controller.abort()
    this.o = null
  }

  private async pump(o: OpenResponse): Promise<void> {
    if (!o.res.body) {
      this.onEnd('no body')
      return
    }
    const reader = o.res.body.getReader()
    let buf = new Uint8Array(0)
    let start = -1
    try {
      for (;;) {
        const r = await reader.read()
        if (r.done || this.stopped) break
        // 前の残りとつなげる
        const next = new Uint8Array(buf.length + r.value.length)
        next.set(buf)
        next.set(r.value, buf.length)
        buf = next
        let scan = start < 0 ? 0 : start + 2
        for (;;) {
          if (start < 0) {
            start = indexOf2(buf, 0xFF, 0xD8, scan)
            if (start < 0) {
              // 始まりが見つからなければ、最後の 1 バイトだけ残す
              buf = buf.subarray(Math.max(0, buf.length - 1))
              break
            }
            scan = start + 2
          }
          const end = indexOf2(buf, 0xFF, 0xD9, scan)
          if (end < 0) {
            if (buf.length - start > MAX_FRAME_BYTES) throw new Error('frame too large')
            // 前を捨てて、始まりからを残す
            buf = buf.subarray(start)
            start = 0
            break
          }
          this.frame(buf.slice(start, end + 2))
          scan = end + 2
          start = -1
        }
      }
      if (!this.stopped) this.onEnd('ended')
    }
    catch (e) {
      if (!this.stopped) this.onEnd(String(e))
    }
    finally {
      try {
        reader.releaseLock()
      }
      catch { /* もう閉じている */ }
    }
  }

  private frame(jpeg: Uint8Array): void {
    const now = performance.now()
    if (this.decoding || now - this.lastDraw < MIN_INTERVAL) return
    this.decoding = true
    this.lastDraw = now
    createImageBitmap(new Blob([jpeg as BlobPart], { type: 'image/jpeg' })).then((bmp) => {
      try {
        if (this.stopped) return
        const scale = Math.min(1, MAX_SIZE / Math.max(bmp.width, bmp.height))
        const w = Math.max(2, Math.round(bmp.width * scale)), h = Math.max(2, Math.round(bmp.height * scale))
        if (this.canvas.width !== w || this.canvas.height !== h) {
          this.canvas.width = w
          this.canvas.height = h
        }
        this.g.drawImage(bmp, 0, 0, w, h)
        const first = !this.drawn
        this.drawn = true
        this.onFrame(first)
      }
      finally {
        bmp.close()
      }
    }, () => { /* 壊れたコマは飛ばす */ }).finally(() => {
      this.decoding = false
    })
  }
}

function indexOf2(b: Uint8Array, x: number, y: number, from: number): number {
  for (let i = Math.max(0, from); i + 1 < b.length; i++) if (b[i] === x && b[i + 1] === y) return i
  return -1
}
