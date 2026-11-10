// 構造物を読んで四角形にする Worker (重い処理で画面を止めないように。renderers/structure.ts が 1 つずつ頼む)
// 入力: ファイルの中身 (圧縮されたままでよい)、表のファイルの URL、Minecraft のリソースのまとめ (/mcassets/<hash>/) の URL
// 出力: リソースのまとめがあれば、Minecraft と同じ形 (vanilla.ts) の、テクスチャをまとめた画像と四角形。
//       なければ、地図にある絵の名前で簡単にした形 (mesher.ts) の、絵ごとの四角形
import { type AtlasPage, type AtlasPart } from './atlas.ts'
import { GameAssets, type McBundle } from './assets.ts'
import { BlockData } from './block-data.ts'
import { EntityModels } from './entity-models.ts'
import { MAX_DECOMPRESSED, parseTables, readStructure, type BlockTables } from './formats.ts'
import { meshStructure, type MeshResult } from './mesher.ts'
import type { NestedPlacement } from './nested.ts'
import { skinUrl } from './skins.ts'
import type { SpecialCounts } from './special.ts'
import { meshVanilla } from './vanilla.ts'

export interface StructureJob {
  bytes: ArrayBuffer
  textures: string[]
  /** 表のファイルの URL (同じサイト) */
  tables: { legacy: string, bedrock: string, blocks: string, entityModels: string }
  /** Minecraft のリソースのまとめ (/mcassets/<hash>/。同じサイト)。なければ null */
  mcassets: string | null
}

export interface VanillaReply {
  mode: 'vanilla'
  pages: AtlasPage[]
  parts: AtlasPart[]
  quads: number
  box: number[]
  step: number
  nested: NestedPlacement[]
  counts: SpecialCounts
  missing: string[]
}

export type StructureReply = ({ ok: true } & ((MeshResult & { mode: 'simple' }) | VanillaReply)) | { ok: false, error: string }

/** 展開する (gzip か zlib。どちらでもなければそのまま)。max バイトを超えたら失敗 */
async function decompress(bytes: Uint8Array, max: number): Promise<Uint8Array> {
  let format: CompressionFormat | null = null
  if (bytes[0] === 0x1F && bytes[1] === 0x8B) format = 'gzip'
  else if (bytes[0] === 0x78 && ((bytes[0]! << 8) | bytes[1]!) % 31 === 0) format = 'deflate'
  if (!format) return bytes
  const reader = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream(format)).getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const r = await reader.read()
    if (r.done) break
    total += r.value.length
    if (total > max) {
      await reader.cancel()
      throw new Error('Structure is too large when decompressed')
    }
    chunks.push(r.value)
  }
  const out = new Uint8Array(total)
  let at = 0
  for (const c of chunks) {
    out.set(c, at)
    at += c.length
  }
  return out
}

async function fetchBytes(url: string, max: number): Promise<Uint8Array> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error('HTTP ' + res.status)
  const b = new Uint8Array(await res.arrayBuffer())
  if (b.length > max) throw new Error('too large')
  return b
}

async function fetchText(url: string): Promise<string> {
  // サーバーが gzip のまま返しても、展開して返しても読めるように
  return new TextDecoder().decode(await decompress(await fetchBytes(url, 16 * 1024 * 1024), 16 * 1024 * 1024))
}

/** 失敗したら次に頼まれたときにやり直す、1 度だけの読み込み */
function once<T>(load: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null
  return () => {
    if (!p) {
      p = load()
      p.catch(() => {
        p = null
      })
    }
    return p
  }
}

let tablesUrls: StructureJob['tables'] | null = null
const tables = once<BlockTables>(() => Promise.all([fetchText(tablesUrls!.legacy), fetchText(tablesUrls!.bedrock)]).then(([l, b]) => parseTables(l, b)))
const blockData = once<BlockData>(() => fetchText(tablesUrls!.blocks).then(t => BlockData.parse(t)))
const entityModels = once<EntityModels>(() => fetchText(tablesUrls!.entityModels).then(t => EntityModels.parse(t)))

/** プレイヤーのスキンの画像の大きさの上限 */
const MAX_SKIN_BYTES = 256 * 1024

let assetsBase = ''
let assetsPromise: Promise<GameAssets> | null = null

function gameAssets(base: string): Promise<GameAssets> {
  if (assetsPromise && assetsBase === base) return assetsPromise
  assetsBase = base
  let texturesPromise: Promise<Uint8Array> | null = null
  const textures = (): Promise<Uint8Array> => {
    if (!texturesPromise) {
      texturesPromise = fetchBytes(base + 'textures.bin', 256 * 1024 * 1024)
      texturesPromise.catch(() => {
        texturesPromise = null
      })
    }
    return texturesPromise
  }
  const p = fetch(base + 'assets.json', { credentials: 'same-origin' }).then(async (res) => {
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const bundle = await res.json() as McBundle
    return new GameAssets(bundle, {
      png: async (_id, offset, length) => {
        const all = await textures()
        if (offset < 0 || length <= 0 || offset + length > all.length) return null
        return all.slice(offset, offset + length)
      },
      unifont: async (page) => {
        const res = await fetch(base + 'unifont/' + page.toString(16).toUpperCase().padStart(4, '0') + '.txt', { credentials: 'same-origin' })
        if (res.status === 204 || res.status === 404) return null
        if (!res.ok) throw new Error('HTTP ' + res.status)
        return await res.text()
      },
      lookup: async (query) => {
        // 問い合わせは skins.ts が作ったもの (形を確かめた name=... か uuid=...) だけ
        if (!/^(name=[A-Za-z0-9_]{1,16}|uuid=[0-9a-f]{32})$/.test(query)) return null
        const res = await fetch('/mcassets/skin?' + query, { credentials: 'same-origin' })
        if (!res.ok) return null
        const j = await res.json() as { url?: unknown, slim?: unknown }
        return { url: typeof j.url === 'string' ? j.url : null, slim: j.slim === true }
      },
      skin: async (url) => {
        // Mojang のスキンのサーバーだけ (skins.ts で確かめた URL をもう一度確かめる)。Cookie・Referer なし、転送は追わない
        const m = /^https:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{1,128})$/.exec(url)
        if (!m) return null
        const encoded = btoa(JSON.stringify({ textures: { SKIN: { url } } }))
        if (skinUrl(encoded) !== url) return null
        const res = await fetch(url, { credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'error', mode: 'cors', cache: 'force-cache' })
        if (!res.ok) return null
        const len = Number(res.headers.get('content-length') ?? '0')
        if (len > MAX_SKIN_BYTES) return null
        const b = new Uint8Array(await res.arrayBuffer())
        return b.length <= MAX_SKIN_BYTES ? b : null
      },
    })
  })
  assetsPromise = p
  p.catch(() => {
    if (assetsPromise === p) assetsPromise = null
  })
  return p
}

self.onmessage = async (event: MessageEvent<StructureJob>) => {
  const job = event.data
  const reply = (self as unknown as { postMessage(message: unknown, transfer?: Transferable[]): void })
  try {
    tablesUrls = job.tables
    const data = await decompress(new Uint8Array(job.bytes), MAX_DECOMPRESSED)
    const structure = await readStructure(data, tables)
    if (job.mcassets) {
      const [assets, bd, em] = await Promise.all([gameAssets(job.mcassets), blockData(), entityModels()])
      // 統合版の植木鉢の中身を直すのに表を使う (統合版のときだけ読む)
      const t = structure.source === 'bedrock' ? await tables() : null
      const r = await meshVanilla(structure, { assets, data: bd, entityModels: em, tables: t })
      const transfer: Transferable[] = []
      for (const p of r.pages) {
        transfer.push(p.pixels.buffer)
        for (const m of p.mips) transfer.push(m.buffer)
        for (const s of p.animated ?? []) for (const f of s.frames) transfer.push(f.buffer)
      }
      for (const p of r.parts) transfer.push(p.positions.buffer, p.uvs.buffer, p.colors.buffer)
      reply.postMessage({ ok: true, mode: 'vanilla', ...r } satisfies StructureReply, transfer)
      return
    }
    const result = meshStructure(structure, job.textures)
    const transfer: Transferable[] = []
    for (const g of result.groups) transfer.push(g.positions.buffer, g.uvs.buffer, g.colors.buffer, g.indices.buffer)
    reply.postMessage({ ok: true, mode: 'simple', ...result } satisfies StructureReply, transfer)
  }
  catch (e) {
    reply.postMessage({ ok: false, error: String((e as Error)?.message ?? e) } satisfies StructureReply)
  }
}
