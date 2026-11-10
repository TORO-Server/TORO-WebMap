// zip (jar) の中のファイルを読む小さなもの (Minecraft のクライアントの jar と、リソースパックの zip)。
// 中央ディレクトリだけを先に読み、ファイルはそのつど位置を指定して読む (jar 全体をメモリに載せない)
// ここは Nuxt の自動 import を使わない (tools/ の試験からも node で直接使う)
import { open, type FileHandle } from 'node:fs/promises'
import { inflateRawSync } from 'node:zlib'

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  size: number
  offset: number
  crc: number
}

/** 1 つのファイルの展開後の大きさの上限 (壊れた zip で大きなメモリを使わないように) */
const MAX_ENTRY = 64 * 1024 * 1024
const MAX_ENTRIES = 200000

export class ZipFile {
  readonly entries = new Map<string, ZipEntry>()
  private readonly file: FileHandle
  readonly size: number

  private constructor(file: FileHandle, size: number) {
    this.file = file
    this.size = size
  }

  static async open(path: string): Promise<ZipFile> {
    const file = await open(path, 'r')
    try {
      const size = (await file.stat()).size
      const zip = new ZipFile(file, size)
      await zip.readDirectory()
      return zip
    }
    catch (e) {
      await file.close()
      throw e
    }
  }

  async close(): Promise<void> {
    await this.file.close()
  }

  private async read(position: number, length: number): Promise<Buffer> {
    const buf = Buffer.alloc(length)
    let done = 0
    while (done < length) {
      const { bytesRead } = await this.file.read(buf, done, length - done, position + done)
      if (bytesRead <= 0) throw new Error('zip: unexpected end of file')
      done += bytesRead
    }
    return buf
  }

  private async readDirectory(): Promise<void> {
    // 中央ディレクトリの終わり (EOCD) を後ろから探す (コメントは最大 65535 バイト)
    const tail = Math.min(this.size, 65557)
    const end = await this.read(this.size - tail, tail)
    let at = -1
    for (let i = end.length - 22; i >= 0; i--) {
      if (end.readUInt32LE(i) === 0x06054B50) {
        at = i
        break
      }
    }
    if (at < 0) throw new Error('zip: no end of central directory')
    let count = end.readUInt16LE(at + 10)
    let dirSize = end.readUInt32LE(at + 12)
    let dirOffset = end.readUInt32LE(at + 16)
    // zip64
    if (dirOffset === 0xFFFFFFFF || count === 0xFFFF) {
      const locator = at - 20
      if (locator >= 0 && end.readUInt32LE(locator) === 0x07064B50) {
        const eocd64 = Number(end.readBigUInt64LE(locator + 8))
        const rec = await this.read(eocd64, 56)
        if (rec.readUInt32LE(0) !== 0x06064B50) throw new Error('zip: bad zip64 record')
        count = Number(rec.readBigUInt64LE(32))
        dirSize = Number(rec.readBigUInt64LE(40))
        dirOffset = Number(rec.readBigUInt64LE(48))
      }
    }
    if (count > MAX_ENTRIES || dirSize > 64 * 1024 * 1024 || dirOffset + dirSize > this.size) throw new Error('zip: bad central directory')
    const dir = await this.read(dirOffset, dirSize)
    let p = 0
    for (let i = 0; i < count; i++) {
      if (p + 46 > dir.length || dir.readUInt32LE(p) !== 0x02014B50) throw new Error('zip: bad central directory entry')
      const method = dir.readUInt16LE(p + 10)
      const crc = dir.readUInt32LE(p + 16)
      let compressedSize = dir.readUInt32LE(p + 20)
      let size = dir.readUInt32LE(p + 24)
      const nameLength = dir.readUInt16LE(p + 28)
      const extraLength = dir.readUInt16LE(p + 30)
      const commentLength = dir.readUInt16LE(p + 32)
      let offset = dir.readUInt32LE(p + 42)
      const name = dir.toString('utf8', p + 46, p + 46 + nameLength)
      // zip64 の追加の欄
      let e = p + 46 + nameLength
      const extraEnd = e + extraLength
      while (e + 4 <= extraEnd) {
        const id = dir.readUInt16LE(e), len = dir.readUInt16LE(e + 2)
        if (id === 1) {
          let q = e + 4
          if (size === 0xFFFFFFFF) { size = Number(dir.readBigUInt64LE(q)); q += 8 }
          if (compressedSize === 0xFFFFFFFF) { compressedSize = Number(dir.readBigUInt64LE(q)); q += 8 }
          if (offset === 0xFFFFFFFF) { offset = Number(dir.readBigUInt64LE(q)); q += 8 }
        }
        e += 4 + len
      }
      p = extraEnd + commentLength
      if (name.endsWith('/')) continue
      this.entries.set(name, { name, method, compressedSize, size, offset, crc })
    }
  }

  /** ファイルの中身。なければ null */
  async get(name: string): Promise<Buffer | null> {
    const e = this.entries.get(name)
    if (!e) return null
    if (e.size > MAX_ENTRY || e.compressedSize > MAX_ENTRY) throw new Error('zip: entry too large: ' + name)
    const head = await this.read(e.offset, 30)
    if (head.readUInt32LE(0) !== 0x04034B50) throw new Error('zip: bad local header: ' + name)
    const start = e.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28)
    const raw = await this.read(start, e.compressedSize)
    if (e.method === 0) return raw
    if (e.method === 8) {
      const out = inflateRawSync(raw, { maxOutputLength: MAX_ENTRY })
      if (out.length !== e.size) throw new Error('zip: size mismatch: ' + name)
      return out
    }
    throw new Error('zip: unsupported method ' + e.method + ': ' + name)
  }
}
