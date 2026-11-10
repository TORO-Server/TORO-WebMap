// 構造物の看板を描くための Minecraft のリソースのまとめ (3d-map.torosaba.net の /mcassets/)。
// サーバーにある Minecraft のクライアントの jar (BlueMap が使っているもの。読むだけでマウントする) から、
// ブロックの blockstates と models、アイテムの定義、テクスチャ (と .mcmeta のアニメーション)、バイオームの色、絵画の大きさ、
// 防具の層、フォントを集めて、ブラウザーが 1 度だけ読めばよい形 (JSON 1 つとテクスチャを並べたもの 1 つ) にする。
// Mojang のファイルは git にも Docker のイメージにも入れない (起動したあとに、マウントした jar から作る)。
// ここは Nuxt の自動 import を使わない (tools/ や tests/ から node で直接使う)
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { ZipFile } from './zip.ts'

/** まとめの形の版 (変えたら上げる。URL の hash に入る) */
export const MCASSETS_FORMAT = 1

export interface McBundle {
  format: number
  /** jar の中の version.json の名前 (分からなければ空) */
  version: string
  blockstates: Record<string, unknown>
  models: Record<string, unknown>
  /** assets/<ns>/items/<name>.json の model */
  items: Record<string, unknown>
  equipment: Record<string, unknown>
  /** [温度, 雨の量, 草, 葉, 枯れ葉, 水, 草の色の変え方]。色が書かれていなければ null */
  biomes: Record<string, [number, number, number | null, number | null, number | null, number | null, string]>
  /** [幅, 高さ, テクスチャ] */
  paintings: Record<string, [number, number, string]>
  /** font/include/default.json の bitmap のもの */
  fonts: unknown[]
  /** テクスチャの名前 (minecraft:block/stone) → [textures.bin の位置, 長さ, .mcmeta の animation (なければ 0)] */
  textures: Record<string, [number, number, unknown]>
  /** Unifont (jar にない文字) のページがあるか */
  unifont: boolean
}

export interface McAssets {
  hash: string
  bundle: McBundle
  json: Buffer
  textures: Buffer
  /** Unifont のページ (codepoint >> 8) → "XXXX:hex\n" の並び */
  unifont: Map<number, string>
  /** 作るのにかかった時間 (ミリ秒) */
  millis: number
}

// テクスチャのうち、まとめに入れるフォルダ (gui や particle などは使わない)
const TEXTURE_FOLDERS = ['block/', 'item/', 'entity/', 'painting/', 'colormap/', 'font/']
// 1 枚のテクスチャの大きさの上限 (リソースパックの巨大な画像を配らない)
const MAX_TEXTURE_BYTES = 4 * 1024 * 1024
const MAX_TOTAL_TEXTURE_BYTES = 192 * 1024 * 1024
const MAX_JSON_BYTES = 4 * 1024 * 1024

/** 読む元 (jar、リソースパックの zip、フォルダ) */
interface Source {
  name: string
  list(): string[]
  read(path: string): Promise<Buffer | null>
  close(): Promise<void>
}

async function zipSource(path: string): Promise<Source> {
  const zip = await ZipFile.open(path)
  return {
    name: path,
    list: () => Array.from(zip.entries.keys()),
    read: p => zip.get(p),
    close: () => zip.close(),
  }
}

async function dirSource(path: string): Promise<Source> {
  const files: string[] = []
  const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
    if (depth > 16 || files.length > 200000) return
    for (const d of await readdir(dir, { withFileTypes: true })) {
      if (d.name.startsWith('.')) continue
      if (d.isDirectory()) await walk(join(dir, d.name), rel + d.name + '/', depth + 1)
      else if (d.isFile()) files.push(rel + d.name)
    }
  }
  await walk(path, '', 0)
  return {
    name: path,
    list: () => files,
    read: async (p) => {
      if (p.includes('..')) return null
      try {
        const full = join(path, p)
        if ((await stat(full)).size > MAX_TEXTURE_BYTES) return null
        return await readFile(full)
      }
      catch {
        return null
      }
    },
    close: async () => {},
  }
}

/** BlueMap の packs フォルダのリソースパック (zip とフォルダ。名前の順に読み、後のものが前のものを上書きする) */
async function packSources(dir: string): Promise<Source[]> {
  const out: Source[] = []
  let names: string[]
  try {
    names = (await readdir(dir)).filter(n => !n.startsWith('.')).sort()
  }
  catch {
    return out
  }
  for (const n of names) {
    const full = join(dir, n)
    try {
      const s = await stat(full)
      if (s.isDirectory()) out.push(await dirSource(full))
      else if (/\.(zip|jar)$/i.test(n)) out.push(await zipSource(full))
    }
    catch (e) {
      console.warn('mcassets: cannot read resource pack', full, String(e))
    }
  }
  return out
}

/** assets/<ns>/<folder>/<rest><ext> を、名前 (ns:rest) にする */
function idOf(path: string, folder: string, ext: string): string | null {
  const m = /^assets\/([a-z0-9_.-]+)\/(.+)$/.exec(path)
  if (!m || !m[2]!.startsWith(folder) || !m[2]!.endsWith(ext)) return null
  const rest = m[2]!.substring(folder.length, m[2]!.length - ext.length)
  if (!rest || !/^[a-z0-9_./-]+$/.test(rest) || rest.includes('..')) return null
  return m[1] + ':' + rest
}

function parseJson(b: Buffer | null): unknown {
  if (!b || b.length > MAX_JSON_BYTES) return undefined
  try {
    // UTF-8 の BOM を除く
    return JSON.parse(b.toString('utf8').replace(/^﻿/, ''))
  }
  catch {
    return undefined
  }
}

function colorValue(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.round(v) & 0xFFFFFF
  if (typeof v === 'string') {
    const n = Number.parseInt(v.replace(/^#/, ''), 16)
    return Number.isFinite(n) ? n & 0xFFFFFF : null
  }
  return null
}

export interface BuildOptions {
  jar: string
  /** BlueMap の packs フォルダ (なければ空) */
  packs?: string
  /** Unifont の zip の中身 (なければ Unifont なし) */
  unifontZip?: Buffer | null
}

/** jar (とリソースパック) からまとめを作る */
export async function buildMcAssets(options: BuildOptions): Promise<McAssets> {
  const started = Date.now()
  const jar = await zipSource(options.jar)
  const packs = options.packs ? await packSources(options.packs) : []
  const sources = [jar, ...packs]
  try {
    // 同じ場所のファイルは、後の元 (リソースパック) のものを使う
    const owner = new Map<string, Source>()
    for (const s of sources) for (const p of s.list()) if (p.startsWith('assets/') || (s === jar && p.startsWith('data/'))) owner.set(p, s)
    const read = (p: string): Promise<Buffer | null> => owner.get(p)?.read(p) ?? Promise.resolve(null)
    const paths = Array.from(owner.keys()).sort()

    const bundle: McBundle = {
      format: MCASSETS_FORMAT, version: '', blockstates: {}, models: {}, items: {}, equipment: {}, biomes: {}, paintings: {}, fonts: [], textures: {}, unifont: false,
    }
    const versionJson = parseJson(await jar.read('version.json')) as { name?: unknown } | undefined
    if (versionJson && typeof versionJson.name === 'string') bundle.version = versionJson.name.slice(0, 40)

    const chunks: Buffer[] = []
    let offset = 0
    const mcmeta = new Map<string, unknown>()
    for (const p of paths) {
      if (!p.endsWith('.png.mcmeta')) continue
      const json = parseJson(await read(p)) as { animation?: unknown } | undefined
      if (json && typeof json.animation === 'object' && json.animation) mcmeta.set(p.slice(0, -'.mcmeta'.length), json.animation)
    }
    for (const p of paths) {
      let id: string | null
      if ((id = idOf(p, 'blockstates/', '.json'))) {
        const j = parseJson(await read(p))
        if (j && typeof j === 'object') bundle.blockstates[id] = j
      }
      else if ((id = idOf(p, 'models/', '.json'))) {
        const j = parseJson(await read(p))
        if (j && typeof j === 'object') bundle.models[id] = j
      }
      else if ((id = idOf(p, 'items/', '.json'))) {
        const j = parseJson(await read(p)) as { model?: unknown } | undefined
        if (j && typeof j.model === 'object' && j.model) bundle.items[id] = j.model
      }
      else if ((id = idOf(p, 'equipment/', '.json'))) {
        const j = parseJson(await read(p))
        if (j && typeof j === 'object') bundle.equipment[id] = j
      }
      else if ((id = idOf(p, 'textures/', '.png'))) {
        const rest = id.substring(id.indexOf(':') + 1)
        if (!TEXTURE_FOLDERS.some(f => rest.startsWith(f))) continue
        const b = await read(p)
        // PNG だけ (先頭の印で確かめる)
        if (!b || b.length > MAX_TEXTURE_BYTES || b.readUInt32BE(0) !== 0x89504E47) continue
        if (offset + b.length > MAX_TOTAL_TEXTURE_BYTES) continue
        bundle.textures[id] = [offset, b.length, mcmeta.get(p) ?? 0]
        chunks.push(b)
        offset += b.length
      }
      else if (p.startsWith('data/minecraft/worldgen/biome/') && p.endsWith('.json')) {
        const j = parseJson(await read(p)) as Record<string, unknown> | undefined
        if (!j) continue
        const effects = (j.effects && typeof j.effects === 'object' ? j.effects : {}) as Record<string, unknown>
        const num = (v: unknown, d: number): number => typeof v === 'number' && Number.isFinite(v) ? v : d
        bundle.biomes['minecraft:' + p.substring('data/minecraft/worldgen/biome/'.length, p.length - 5)] = [
          num(j.temperature, 0.8), num(j.downfall, 0.4), colorValue(effects.grass_color), colorValue(effects.foliage_color),
          colorValue(effects.dry_foliage_color), colorValue(effects.water_color),
          typeof effects.grass_color_modifier === 'string' ? effects.grass_color_modifier : 'none',
        ]
      }
      else if (p.startsWith('data/minecraft/painting_variant/') && p.endsWith('.json')) {
        const j = parseJson(await read(p)) as Record<string, unknown> | undefined
        if (!j) continue
        bundle.paintings[p.substring('data/minecraft/painting_variant/'.length, p.length - 5)] = [
          typeof j.width === 'number' ? j.width : 1, typeof j.height === 'number' ? j.height : 1, typeof j.asset_id === 'string' ? j.asset_id : '',
        ]
      }
    }
    const fonts = parseJson(await read('assets/minecraft/font/include/default.json')) as { providers?: unknown[] } | undefined
    if (fonts && Array.isArray(fonts.providers)) {
      bundle.fonts = fonts.providers.filter(p => p && typeof p === 'object' && (p as { type?: unknown }).type === 'bitmap')
    }
    const unifont = options.unifontZip ? await readUnifont(options.unifontZip) : new Map<number, string>()
    bundle.unifont = unifont.size > 0
    const json = Buffer.from(JSON.stringify(bundle))
    const textures = Buffer.concat(chunks)
    const h = createHash('sha256').update(String(MCASSETS_FORMAT)).update(json).update(textures)
    for (const [page, text] of unifont) h.update(String(page)).update(text)
    return { hash: h.digest('hex').slice(0, 20), bundle, json, textures, unifont, millis: Date.now() - started }
  }
  finally {
    for (const s of sources) await s.close()
  }
}

/**
 * Unifont の zip (minecraft/font/unifont.zip。jar にはなく、ランチャーが別に配る) の .hex を、256 文字ごとのページにする。
 * MarumaSign 本体の SignTexts と同じく、zip の中の .hex を順に読み、後のものが前のものを上書きする
 */
async function readUnifont(zipBytes: Buffer): Promise<Map<number, string>> {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(join(tmpdir(), 'unifont-'))
  const file = join(dir, 'unifont.zip')
  const glyphs = new Map<number, string>()
  try {
    await writeFile(file, zipBytes)
    const zip = await ZipFile.open(file)
    try {
      for (const name of zip.entries.keys()) {
        if (!name.endsWith('.hex')) continue
        const text = (await zip.get(name))!.toString('latin1')
        for (const line of text.split('\n')) {
          const colon = line.indexOf(':')
          if (colon <= 0) continue
          const cp = Number.parseInt(line.substring(0, colon), 16)
          const hex = line.substring(colon + 1).trim()
          if (!Number.isFinite(cp) || cp < 0 || cp > 0x10FFFF || !/^[0-9A-Fa-f]{32,256}$/.test(hex)) continue
          glyphs.set(cp, hex)
        }
      }
    }
    finally {
      await zip.close()
    }
  }
  finally {
    await rm(dir, { recursive: true, force: true })
  }
  const pages = new Map<number, string[]>()
  for (const [cp, hex] of glyphs) {
    let l = pages.get(cp >> 8)
    if (!l) pages.set(cp >> 8, l = [])
    l.push(cp.toString(16).toUpperCase().padStart(4, '0') + ':' + hex)
  }
  const out = new Map<number, string>()
  for (const [page, lines] of pages) out.set(page, lines.join('\n') + '\n')
  return out
}

/** 版の名前 (26.3、26.10、26.3.1 など) を、数の部分ごとに比べる */
export function compareVersions(a: string, b: string): number {
  const na = a.match(/\d+/g)?.map(Number) ?? [], nb = b.match(/\d+/g)?.map(Number) ?? []
  for (let i = 0; i < Math.max(na.length, nb.length); i++) {
    const d = (na[i] ?? -1) - (nb[i] ?? -1)
    if (d) return d
  }
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * client の jar の場所。ファイルならそれ、フォルダなら、その中の minecraft-client-<版>.jar のうち版が最も新しいもの
 * (BlueMap がダウンロードする名前。Minecraft を更新しても設定を変えなくてよい)。見つからなければ null
 */
export async function resolveClientJar(path: string): Promise<string | null> {
  const s = await stat(path)
  if (!s.isDirectory()) return path
  let best: { file: string, version: string } | null = null
  for (const name of await readdir(path)) {
    const m = /^minecraft-client-(.+)\.jar$/.exec(name)
    if (!m) continue
    try {
      if (!(await stat(join(path, name))).isFile()) continue
    }
    catch {
      continue
    }
    if (!best || compareVersions(m[1]!, best.version) > 0) best = { file: join(path, name), version: m[1]! }
  }
  return best ? best.file : null
}

/** Unifont (26.3 のアセットの一覧のもの。MarumaSign 本体の SignTexts と同じ) */
export const UNIFONT_SHA1 = 'ccd5ac4767ce0a9c71d1dd62f2dc25449789b5dd'
export const UNIFONT_SIZE = 1559654

export function sha1(b: Buffer): string {
  return createHash('sha1').update(b).digest('hex')
}
