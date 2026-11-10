import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { brotliCompress, constants, gzip } from 'node:zlib'
import { buildMcAssets, resolveClientJar, sha1, UNIFONT_SHA1, UNIFONT_SIZE, type McAssets } from './mcassets-build.ts'

// 構造物の看板のための Minecraft のリソースのまとめ (/mcassets/)。作り方は mcassets-build.ts
// 起動したとき (server/plugins/mcassets.ts) に作り始め、メモリに持つ (1 秒ほど。持つのは 20 MB ほど)。
// jar かリソースパックが変わったら (10 分ごとに確かめる) 作り直す。前のものも少しのあいだ返す (読み込み中のブラウザーのため)
// NUXT_MCASSETS_JAR がフォルダ (BlueMap の main/bluemap) なら、その中の minecraft-client-<版>.jar のうち最も新しい版を使う (新しい jar が増えたら作り直す)

export interface ServedAssets extends Omit<McAssets, 'bundle'> {
  /** まとめの中身のうち、index.json に書くもの (中身の JSON は json に入っているので、読んだ形は持たない) */
  meta: { format: number, version: string, unifont: boolean, textures: number }
  jsonGzip: Buffer
  jsonBrotli: Buffer
}

const CHECK_MILLIS = 10 * 60_000
const builds = new Map<string, ServedAssets>()
let current: ServedAssets | null = null
let building: Promise<ServedAssets | null> | null = null
let lastError = ''
let lastCheck = 0
let lastStamp = ''

function config(): { jar: string, packs: string, cache: string, unifont: string } {
  return useRuntimeConfig().mcassets
}

/** 使う jar (フォルダなら最も新しい版のもの)。見つからなければ null */
async function clientJar(): Promise<string | null> {
  const { jar } = config()
  if (!jar) return null
  try {
    return await resolveClientJar(jar)
  }
  catch {
    return null
  }
}

/** 使う jar とリソースパックの場所・大きさ・時刻 (変わったかを見る) */
async function stamp(): Promise<string> {
  const { packs } = config()
  const parts: string[] = []
  for (const p of [await clientJar() ?? '', packs]) {
    if (!p) continue
    try {
      const s = await stat(p)
      parts.push(p + ':' + s.size + ':' + s.mtimeMs)
    }
    catch {
      parts.push(p + ':missing')
    }
  }
  return parts.join('|')
}

/** Unifont の zip。ファイルを指定されていればそれ、なければ Mojang の配布元 (hash で確かめる) から 1 度だけ読んで、キャッシュのフォルダに置く */
async function unifontZip(): Promise<Buffer | null> {
  const { unifont, cache } = config()
  if (unifont === 'off') return null
  const verify = (b: Buffer): boolean => b.length === UNIFONT_SIZE && sha1(b) === UNIFONT_SHA1
  if (unifont && unifont !== 'download') {
    try {
      const b = await readFile(unifont)
      return verify(b) ? b : null
    }
    catch {
      return null
    }
  }
  const file = join(cache, 'unifont-' + UNIFONT_SHA1 + '.zip')
  try {
    const b = await readFile(file)
    if (verify(b)) return b
  }
  catch { /* まだない */ }
  try {
    const res = await fetch(`https://resources.download.minecraft.net/${UNIFONT_SHA1.slice(0, 2)}/${UNIFONT_SHA1}`, {
      redirect: 'error', signal: AbortSignal.timeout(30_000),
    })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    const b = Buffer.from(await res.arrayBuffer())
    if (!verify(b)) throw new Error('checksum mismatch')
    try {
      await mkdir(cache, { recursive: true })
      await writeFile(file + '.tmp', b)
      await rename(file + '.tmp', file)
    }
    catch (e) {
      console.warn('mcassets: cannot cache unifont', String(e))
    }
    return b
  }
  catch (e) {
    console.warn('mcassets: cannot download unifont (text outside the bitmap fonts will not be drawn)', String(e))
    return null
  }
}

async function build(): Promise<ServedAssets | null> {
  const { packs } = config()
  if (!config().jar) {
    lastError = 'NUXT_MCASSETS_JAR is not set'
    return null
  }
  const jar = await clientJar()
  if (!jar) {
    lastError = 'no minecraft-client-*.jar at NUXT_MCASSETS_JAR'
    return current
  }
  try {
    const s = await stamp()
    const a = await buildMcAssets({ jar, packs: packs || undefined, unifontZip: await unifontZip() })
    const { bundle, ...rest } = a
    const served: ServedAssets = {
      ...rest,
      meta: { format: bundle.format, version: bundle.version, unifont: bundle.unifont, textures: Object.keys(bundle.textures).length },
      // 圧縮は zlib のスレッドで行う (brotli の最高の圧縮は数秒かかるので、ほかの返事を止めない)
      jsonGzip: await promisify(gzip)(a.json, { level: 9 }),
      jsonBrotli: await promisify(brotliCompress)(a.json, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
    }
    builds.set(a.hash, served)
    // 前のものは 1 つだけ残す
    for (const h of Array.from(builds.keys())) if (builds.size > 2 && h !== a.hash) builds.delete(h)
    current = served
    lastStamp = s
    lastError = ''
    console.info(`mcassets: ${served.meta.version} ${a.hash} (${served.meta.textures} textures, ${a.millis} ms)`)
    return served
  }
  catch (e) {
    lastError = String((e as Error)?.message ?? e)
    console.warn('mcassets: cannot build', lastError)
    return current
  }
}

/** いまのまとめ (作っている途中なら待つ)。作れなければ null */
export async function mcAssets(): Promise<ServedAssets | null> {
  const now = Date.now()
  if (current && !building && now - lastCheck > CHECK_MILLIS) {
    lastCheck = now
    if (await stamp() !== lastStamp) building = build().finally(() => (building = null))
  }
  if (!current && !building) {
    lastCheck = now
    building = build().finally(() => (building = null))
  }
  if (!current && building) await building
  return current
}

export function mcAssetsByHash(hash: string): ServedAssets | undefined {
  return builds.get(hash)
}

export function mcAssetsError(): string {
  return lastError
}
