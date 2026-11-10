import type { RowDataPacket } from 'mysql2/promise'
import { limitKey, WindowLimit } from '../lib/marumasign/limits'

// assets.torosaba.net (MarumaSign の看板の画像などを、MarumaSign Companion がホストしたもの) の DB と、1 つの IP からの数の上限
// 読める人の確かめは server/utils/clients.ts (いまつながっているプレイヤーの IP) と server/routes/_assets/[file].ts (地図のページの Origin)
// 表は MarumaSign Companion (hosting.storage: database) が作って書く。ここは読むだけ
//   <prefix>hosted_file   ホストしているファイル (この行があるものだけ配る。chunks と size を信じる)
//   <prefix>hosted_chunk  ファイルの中身を 1 MiB ずつ

interface FileRow extends RowDataPacket { id: string, ext: string, content_type: string, size: number, chunk_size: number, chunks: number }
interface ChunkRow extends RowDataPacket { data: Buffer }

export interface HostedFile { id: string, ext: string, contentType: string, size: number, chunkSize: number, chunks: number }

const FILE_TTL = 60_000
const MISSING_TTL = 30_000
// 中身のキャッシュ (同じ看板を何人もが読むので、DB を何度も引かない)
const CHUNK_CACHE_BYTES = 256 * 1024 * 1024

const files = new Map<string, { at: number, file: HostedFile | undefined }>()
const chunks = new Map<string, Buffer>()
let chunkBytes = 0

function config() {
  return useRuntimeConfig().assets
}

export async function hostedFile(id: string): Promise<HostedFile | undefined> {
  const hit = files.get(id)
  if (hit && Date.now() - hit.at < (hit.file ? FILE_TTL : MISSING_TTL)) return hit.file
  const { database, prefix } = config()
  const row = await queryOne<FileRow>(database,
    `SELECT id, ext, content_type, size, chunk_size, chunks FROM ${prefix}hosted_file WHERE id = ?`, [id])
  const file = row ? { id: row.id, ext: row.ext, contentType: row.content_type, size: Number(row.size), chunkSize: row.chunk_size, chunks: row.chunks } : undefined
  files.set(id, { at: Date.now(), file })
  if (files.size > 10_000) files.delete(files.keys().next().value!)
  return file
}

export async function hostedChunk(file: HostedFile, seq: number): Promise<Buffer> {
  const key = `${file.id}:${seq}`
  const hit = chunks.get(key)
  if (hit) {
    // 最近使ったものを後ろへ (古いものから消す)
    chunks.delete(key)
    chunks.set(key, hit)
    return hit
  }
  const { database, prefix } = config()
  const row = await queryOne<ChunkRow>(database, `SELECT data FROM ${prefix}hosted_chunk WHERE id = ? AND seq = ?`, [file.id, seq])
  if (!row) throw new Error(`missing chunk ${key}`)
  chunks.set(key, row.data)
  chunkBytes += row.data.length
  for (const [k, v] of chunks) {
    if (chunkBytes <= CHUNK_CACHE_BYTES) break
    chunks.delete(k)
    chunkBytes -= v.length
  }
  return row.data
}

// 1 つの IP から読める数の上限 (10 分あたり)。看板の多い場所に入ると一度に数百枚を読むので、多めにしている
const limit = new WindowLimit(10 * 60_000, 3000)

export function overLimit(ip: string): boolean {
  return limit.hit(limitKey(ip))
}
