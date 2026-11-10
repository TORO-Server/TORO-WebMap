// Server-Sent Events (text/event-stream) の読み取り。BlueMap 内蔵の Web サーバーの live/sse を server/utils/bluemap-live.ts が読むために使う
// Nuxt に頼らないので、tests/sse-parse.test.ts からそのまま読める

export interface SseEvent {
  /** event: の値 (なければ "message") */
  event: string
  /** data: の行を改行でつないだもの */
  data: string
}

export class SseParser {
  private buffer = ''
  private event = ''
  private data: string[] = []

  /** 届いた文字を渡す。そろったイベントを返す。途中で切れた行は次の push まで持つ */
  push(chunk: string): SseEvent[] {
    this.buffer += chunk
    const out: SseEvent[] = []
    let start = 0
    for (;;) {
      let end = -1
      let next = 0
      for (let i = start; i < this.buffer.length; i++) {
        const ch = this.buffer[i]
        if (ch === '\n') {
          end = i
          next = i + 1
          break
        }
        if (ch === '\r') {
          // \r\n の \n がまだ届いていないかもしれないので、次の文字を待つ
          if (i + 1 >= this.buffer.length) break
          end = i
          next = this.buffer[i + 1] === '\n' ? i + 2 : i + 1
          break
        }
      }
      if (end < 0) break
      const ev = this.line(this.buffer.slice(start, end))
      if (ev) out.push(ev)
      start = next
    }
    this.buffer = this.buffer.slice(start)
    return out
  }

  private line(line: string): SseEvent | undefined {
    if (line === '') {
      const data = this.data
      const event = this.event
      this.data = []
      this.event = ''
      return data.length > 0 ? { event: event || 'message', data: data.join('\n') } : undefined
    }
    // コメント (: で始まる行。つなぎっぱなしの合図に使われる)
    if (line[0] === ':') return undefined
    const colon = line.indexOf(':')
    const field = colon < 0 ? line : line.slice(0, colon)
    let value = colon < 0 ? '' : line.slice(colon + 1)
    if (value[0] === ' ') value = value.slice(1)
    if (field === 'event') this.event = value
    else if (field === 'data') this.data.push(value)
    return undefined
  }
}
