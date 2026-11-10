// 3D モデル (glTF 2.0 の .glb と .gltf) を読む (3D モデルの看板が来たときに初めて読み込む)
// MarumaSign 本体と同じ決まり:
//  - ファイルは外部ファイルを含めて 64 MB まで、三角形は 15 万枚まで
//  - .gltf が別のファイル (.bin や画像) を参照していれば、看板の URL からの相対の位置で読み、1 つの .glb にまとめてから読む
//    (外部のファイルも看板の URL と同じ決まりで確かめる: https、怪しいホストなし、CORS・Cookie なし・Referer なし・転送を追わない)
//  - Draco、meshopt (EXT と KHR)、KHR_mesh_quantization、EXT_mesh_gpu_instancing、KTX2 (KHR_texture_basisu)、WebP、AVIF、
//    DDS (MSFT_texture_dds、BC1 - BC7)、KHR_texture_transform、KHR_materials_* (unlit・emissive_strength・clearcoat・sheen・
//    specular・ior・transmission・volume・iridescence・anisotropy・dispersion・diffuse_transmission・pbrSpecularGlossiness)、
//    KHR_lights_punctual、EXT_lights_image_based、KHR_animation_pointer、KHR_node_visibility。
//    KHR_materials_variants は既定の材質を使い、KHR_xmp_json_ld は読み飛ばす (どちらも MarumaSign 本体と同じ)
// three.js の GLTFLoader が読み、足りない拡張は下と model-ext.ts のプラグインで足す。陰影は model-shading.ts (本体と同じ式)。
// テクスチャは blob: の URL を fetch で読まない (本番の CSP の connect-src が blob: を許さない) ように、img 要素か、バイト列のまま読む
import {
  type AnimationClip, Box3, ClampToEdgeWrapping, DoubleSide, type Group, LinearFilter, LinearMipmapLinearFilter, LinearMipmapNearestFilter,
  LoadingManager, type Material, type Mesh, MeshStandardMaterial, MirroredRepeatWrapping, NearestFilter,
  NearestMipmapLinearFilter, NearestMipmapNearestFilter, type Object3D, RepeatWrapping, SRGBColorSpace, TextureLoader,
  type MagnificationTextureFilter, type MinificationTextureFilter, type Texture, type Wrapping, type InstancedMesh, type SkinnedMesh,
} from 'three'
import { GLTFLoader, type GLTF, type GLTFLoaderPlugin, type GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
// Draco の展開のプログラムは glTF 用の小さいもの (DRACO_GLTF_CONFIG。ビルドに入れて同じサイトから返す)。
// DRACOLoader が既定で指す大きいもの (draco_decoder.js など) は、nuxt.config.ts の drop-draco-defaults でビルドに入れない
import { DRACOLoader, DRACO_GLTF_CONFIG } from 'three/addons/loaders/DRACOLoader.js'
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js'
import { safeUrl } from './core'
import { concat, open, readHead, readLimited, readRest, sniffAsync, WrongKindError } from './fetch'
import { getKtx2Loader, withTimeout } from './ktx2'
import { ddsTexture } from './model-dds'
import {
  animationPointerPlugin, diffuseTransmissionPlugin, gltfExtras, iblPlugin, lightsPlugin, nodeExtrasPlugin, specularGlossinessExtra,
  type ModelExtras,
} from './model-ext'
import { materialTextures, prepareMaterial } from './model-shading'

/** 3D モデルのファイルの大きさの上限 (外部ファイルを含む。MarumaSign 本体と同じ) */
export const MAX_MODEL_BYTES = 64 * 1024 * 1024
/** 三角形の数の上限 (MarumaSign 本体と同じ) */
export const MAX_TRIANGLES = 150000
// 外部ファイルの数の上限
const MAX_RESOURCES = 64

export interface LoadedModel {
  scene: Group
  clips: AnimationClip[]
  /** モデルを囲む直方体 (動かす前の形) [minX, minY, minZ, maxX, maxY, maxZ] */
  box: number[]
  triangles: number
  /** three.js の材質にない拡張の値 (光源、環境光、アニメーションの書き換え先など) */
  extras: ModelExtras
  /** DDS を CPU で展開したテクスチャの数 */
  cpuTextures: number
}

// ---------------------------------------------------------------- .gltf と外部ファイルを 1 つの .glb にまとめる

interface GltfJson {
  buffers?: { uri?: string, byteLength: number, extensions?: Record<string, unknown> }[]
  bufferViews?: { buffer: number, byteOffset?: number, byteLength: number, extensions?: Record<string, unknown> }[]
  images?: { uri?: string, bufferView?: number, mimeType?: string }[]
  [key: string]: unknown
}

/** data: の URL (base64 か、%エンコード) をバイト列にする (fetch は CSP で使えないので自前で) */
function decodeDataUri(uri: string): { bytes: Uint8Array, mime: string } {
  const comma = uri.indexOf(',')
  if (comma < 0) throw new Error('bad data uri')
  const meta = uri.substring(5, comma)
  const body = uri.substring(comma + 1)
  if (/;base64$/i.test(meta)) {
    const bin = atob(body)
    const bytes = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
    return { bytes, mime: meta.replace(/;base64$/i, '') }
  }
  return { bytes: new TextEncoder().encode(decodeURIComponent(body)), mime: meta }
}

function imageMime(b: Uint8Array): string {
  if (b[0] === 0x89 && b[1] === 0x50) return 'image/png'
  if (b[0] === 0xFF && b[1] === 0xD8) return 'image/jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57) return 'image/webp'
  if (b[0] === 0xAB && b[1] === 0x4B) return 'image/ktx2'
  if (b[0] === 0x44 && b[1] === 0x44 && b[2] === 0x53) return 'image/vnd-ms.dds'
  return 'image/avif'
}

/** GLB を JSON と BIN に分ける */
function splitGlb(glb: Uint8Array): { json: GltfJson, bin: Uint8Array | null } {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength)
  if (dv.getUint32(0, true) !== 0x46546C67 || dv.getUint32(4, true) !== 2) throw new Error('unsupported glb')
  let p = 12
  let json: GltfJson = null
  let bin: Uint8Array | null = null
  while (p + 8 <= glb.length) {
    const len = dv.getUint32(p, true), type = dv.getUint32(p + 4, true)
    const chunk = glb.subarray(p + 8, p + 8 + len)
    if (type === 0x4E4F534A) json = JSON.parse(new TextDecoder().decode(chunk)) as GltfJson
    else if (type === 0x004E4942 && !bin) bin = chunk
    p += 8 + len
  }
  if (!json) throw new Error('glb has no json')
  return { json, bin }
}

function isMeshoptFallback(b: { extensions?: Record<string, unknown> }): boolean {
  const e = b.extensions ?? {}
  return !!((e.EXT_meshopt_compression as { fallback?: boolean } | undefined)?.fallback || (e.KHR_meshopt_compression as { fallback?: boolean } | undefined)?.fallback)
}

function align4(n: number): number {
  return (n + 3) & ~3
}

/**
 * 外部ファイルを読み、1 つの .glb にまとめる (外部ファイルがなければ、そのまま)。
 * @param base 看板の URL (相対の位置の基準)
 * @param used 看板のファイルの大きさ (上限に数える)
 */
async function packGltf(json: GltfJson, bin: Uint8Array | null, base: string, used: number, original: Uint8Array | null, sign: string): Promise<ArrayBuffer> {
  const external = (json.buffers ?? []).some(b => b.uri !== undefined)
    || (json.images ?? []).some(i => i.uri !== undefined)
  if (!external && original) return original.buffer.slice(original.byteOffset, original.byteOffset + original.byteLength) as ArrayBuffer
  let total = used
  let count = 0
  const fetchResource = async (uri: string): Promise<{ bytes: Uint8Array, mime: string }> => {
    if (uri.startsWith('data:')) return decodeDataUri(uri)
    if (++count > MAX_RESOURCES) throw new Error('too many resources')
    let url: string
    try {
      url = new URL(uri, base).href
    }
    catch {
      throw new Error('bad resource uri')
    }
    if (!safeUrl(url, true)) throw new Error('blocked resource uri')
    // CORS のない .bin などは、サーバーが .gltf を読んで確かめてから中継する
    const o = await open(url, 'default', undefined, { parents: [sign] })
    try {
      const chunks = await readLimited(o, MAX_MODEL_BYTES - total)
      const bytes = concat(chunks)
      total += bytes.length
      return { bytes, mime: o.type }
    }
    finally {
      o.done()
    }
  }
  // バッファをつなげて 1 つにする。meshopt の展開先 (fallback、中身のないバッファ) はそのまま別のバッファに残す
  const parts: Uint8Array[] = []
  let offset = 0
  const buffers: { byteLength: number, extensions?: Record<string, unknown> }[] = [{ byteLength: 0 }]
  const remap: { buffer: number, offset: number }[] = []
  for (const [i, b] of (json.buffers ?? []).entries()) {
    let bytes: Uint8Array
    if (b.uri === undefined && !(i === 0 && bin)) {
      if (!isMeshoptFallback(b)) throw new Error('missing buffer')
      remap[i] = { buffer: buffers.length, offset: 0 }
      buffers.push({ byteLength: b.byteLength, extensions: b.extensions })
      continue
    }
    bytes = b.uri === undefined ? bin! : (await fetchResource(b.uri)).bytes
    if (bytes.length < b.byteLength) throw new Error('buffer too short')
    remap[i] = { buffer: 0, offset }
    parts.push(bytes.subarray(0, b.byteLength))
    const end = offset + b.byteLength
    offset = align4(end)
    if (offset > end) parts.push(new Uint8Array(offset - end))
  }
  const move = (target: { buffer: number, byteOffset?: number }): void => {
    const r = remap[target.buffer]
    if (!r) throw new Error('bad buffer index')
    target.byteOffset = (target.byteOffset ?? 0) + r.offset
    target.buffer = r.buffer
  }
  for (const v of json.bufferViews ?? []) {
    move(v)
    // meshopt で圧縮されたものは、圧縮された中身の場所も付け替える
    for (const name of ['EXT_meshopt_compression', 'KHR_meshopt_compression']) {
      const m = v.extensions?.[name] as { buffer: number, byteOffset?: number } | undefined
      if (m) move(m)
    }
  }  // 画像も同じバッファに入れる
  json.bufferViews = json.bufferViews ?? []
  for (const image of json.images ?? []) {
    if (image.uri === undefined) continue
    const r = await fetchResource(image.uri)
    const view = { buffer: 0, byteOffset: offset, byteLength: r.bytes.length }
    parts.push(r.bytes)
    offset = align4(offset + r.bytes.length)
    parts.push(new Uint8Array(offset - (view.byteOffset + r.bytes.length)))
    json.bufferViews.push(view)
    image.bufferView = json.bufferViews.length - 1
    image.mimeType = r.mime.startsWith('image/') && r.mime !== 'image/' ? r.mime : imageMime(r.bytes)
    delete image.uri
  }
  buffers[0]!.byteLength = offset
  json.buffers = offset > 0 || buffers.length > 1 ? buffers : []
  const binChunk = concat(parts)
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json))
  const jsonLength = align4(jsonBytes.length)
  const length = 12 + 8 + jsonLength + (binChunk.length ? 8 + binChunk.length : 0)
  const out = new Uint8Array(length)
  const dv = new DataView(out.buffer)
  dv.setUint32(0, 0x46546C67, true)
  dv.setUint32(4, 2, true)
  dv.setUint32(8, length, true)
  dv.setUint32(12, jsonLength, true)
  dv.setUint32(16, 0x4E4F534A, true)
  out.set(jsonBytes, 20)
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLength)
  if (binChunk.length) {
    dv.setUint32(20 + jsonLength, binChunk.length, true)
    dv.setUint32(24 + jsonLength, 0x004E4942, true)
    out.set(binChunk, 28 + jsonLength)
  }
  return out.buffer
}

// ---------------------------------------------------------------- GLTFLoader と、足りない拡張のプラグイン

const WEBGL_FILTERS: Record<number, MagnificationTextureFilter | MinificationTextureFilter> = {
  9728: NearestFilter, 9729: LinearFilter, 9984: NearestMipmapNearestFilter, 9985: LinearMipmapNearestFilter,
  9986: NearestMipmapLinearFilter, 9987: LinearMipmapLinearFilter,
}
const WEBGL_WRAPPINGS: Record<number, Wrapping> = { 33071: ClampToEdgeWrapping, 33648: MirroredRepeatWrapping, 10497: RepeatWrapping }

interface TextureDef {
  sampler?: number
  name?: string
  extensions?: Record<string, { source?: number }>
}

/**
 * 画像をバイト列のまま読むテクスチャの拡張 (KHR_texture_basisu と MSFT_texture_dds)。
 * GLTFLoader のものは blob: の URL を fetch で読むので、本番の CSP では読めない
 */
function byteTexturePlugin(name: string, decode: (bytes: ArrayBuffer) => Promise<Texture>): (parser: GLTFParser) => GLTFLoaderPlugin {
  return (parser: GLTFParser) => ({
    name,
    loadTexture(textureIndex: number): Promise<Texture> | null {
      const json = parser.json as { textures: TextureDef[], images: { bufferView?: number }[], samplers?: { magFilter?: number, minFilter?: number, wrapS?: number, wrapT?: number }[] }
      const def = json.textures[textureIndex]
      const ext = def?.extensions?.[name]
      if (!ext || ext.source === undefined) return null
      const image = json.images[ext.source]
      if (!image || image.bufferView === undefined) return Promise.reject(new Error('texture without bufferView'))
      return (parser.getDependency('bufferView', image.bufferView) as Promise<ArrayBuffer>).then(async (bytes) => {
        const tex = await decode(bytes.slice(0))
        tex.flipY = false
        if (def.name) tex.name = def.name
        const sampler = (json.samplers ?? [])[def.sampler ?? -1] ?? {}
        tex.magFilter = (WEBGL_FILTERS[sampler.magFilter ?? 0] as MagnificationTextureFilter) ?? LinearFilter
        tex.minFilter = (WEBGL_FILTERS[sampler.minFilter ?? 0] as MinificationTextureFilter) ?? LinearMipmapLinearFilter
        tex.wrapS = WEBGL_WRAPPINGS[sampler.wrapS ?? 0] ?? RepeatWrapping
        tex.wrapT = WEBGL_WRAPPINGS[sampler.wrapT ?? 0] ?? RepeatWrapping
        // ミップマップを作れないテクスチャ (CPU で展開した BC6H) は、ミップマップを使わない
        if (tex.userData.noMipmaps && tex.minFilter !== NearestFilter && tex.minFilter !== LinearFilter) {
          tex.minFilter = tex.minFilter === NearestMipmapNearestFilter || tex.minFilter === NearestMipmapLinearFilter ? NearestFilter : LinearFilter
        }
        parser.associations.set(tex, { textures: textureIndex })
        return tex
      })
    },
  })
}

interface SpecGloss {
  diffuseFactor?: number[]
  diffuseTexture?: { index: number }
  glossinessFactor?: number
}

/**
 * KHR_materials_pbrSpecularGlossiness (three.js から外された拡張)。
 * MarumaSign 本体と同じく、金属らしさ 0、粗さ 1 - glossiness、正面の反射率 (F0) を specularFactor にする
 * (F0 と、つやのテクスチャは model-shading.ts が使う)
 */
function specGlossPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const NAME = 'KHR_materials_pbrSpecularGlossiness'
  const ext = (materialIndex: number): SpecGloss | undefined =>
    (parser.json as { materials?: { extensions?: Record<string, SpecGloss> }[] }).materials?.[materialIndex]?.extensions?.[NAME]
  return {
    name: NAME,
    getMaterialType(materialIndex: number) {
      return ext(materialIndex) ? MeshStandardMaterial : null
    },
    async extendMaterialParams(materialIndex: number, params: Record<string, unknown>) {
      const e = ext(materialIndex)
      if (!e) return
      const f = e.diffuseFactor ?? [1, 1, 1, 1]
      ;(params.color as { setRGB(r: number, g: number, b: number): void } | undefined)?.setRGB(f[0]!, f[1]!, f[2]!)
      params.opacity = f[3]
      params.metalness = 0
      params.roughness = Math.max(0.04, 1 - (e.glossinessFactor ?? 1))
      await Promise.all([
        e.diffuseTexture ? parser.assignTexture(params, 'map', e.diffuseTexture, SRGBColorSpace) : null,
        specularGlossinessExtra(parser, materialIndex, e as Record<string, unknown>),
      ])
    },
  } as GLTFLoaderPlugin
}

let gltfLoader: Promise<GLTFLoader> | null = null

async function getGltfLoader(): Promise<GLTFLoader> {
  if (gltfLoader) return gltfLoader
  gltfLoader = (async () => {
    const manager = new LoadingManager()
    const draco = new DRACOLoader(manager)
    draco.setDecoderPath(DRACO_GLTF_CONFIG as unknown as string)
    draco.setWorkerLimit(1)
    const loader = new GLTFLoader(manager)
    loader.setDRACOLoader(draco)
    loader.setMeshoptDecoder(MeshoptDecoder)
    const ktx2 = await getKtx2Loader()
    loader.setKTX2Loader(ktx2)
    // 画像は img 要素で読む (blob: の URL を fetch で読まない)
    loader.register((parser) => {
      ;(parser as unknown as { textureLoader: TextureLoader }).textureLoader = new TextureLoader(manager)
      return { name: 'marumasign_image_element' }
    })
    loader.register(byteTexturePlugin('KHR_texture_basisu', bytes =>
      withTimeout(new Promise<Texture>((resolve, reject) => ktx2.parse(bytes, resolve, reject)), 20000)))
    // DDS は GPU が描ける形式なら圧縮のまま、描けなければ CPU で展開する
    loader.register(byteTexturePlugin('MSFT_texture_dds', async (bytes) => {
      const { texture, cpu } = ddsTexture(bytes)
      if (cpu) texture.userData.msCpuDecoded = true
      return texture
    }))
    loader.register(specGlossPlugin)
    // three.js の光源の代わり (同じ名前の拡張は、あとに足したものが使われる)
    loader.register(lightsPlugin)
    loader.register(iblPlugin)
    loader.register(diffuseTransmissionPlugin)
    loader.register(animationPointerPlugin)
    loader.register(nodeExtrasPlugin)
    return loader
  })()
  gltfLoader.catch(() => {
    gltfLoader = null
  })
  return gltfLoader
}
function countTriangles(scene: Object3D): number {
  let total = 0
  scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh || !mesh.geometry) return
    const g = mesh.geometry
    const n = g.index ? g.index.count : (g.attributes.position?.count ?? 0)
    const instances = (o as InstancedMesh).isInstancedMesh ? (o as InstancedMesh).count : 1
    // 両面の材質は裏と表で 2 つに数える (MarumaSign 本体と同じ)
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    const sides = mats.some(m => m && m.side === DoubleSide) ? 2 : 1
    total += Math.floor(n / 3) * instances * sides
  })
  return total
}

// ---------------------------------------------------------------- 読み込み

/**
 * 看板の URL から 3D モデルを読む。先に中身を見て、3D モデルでなければ WrongKindError (正しい描き方に任せる)。
 */
export async function loadModel(url: string, ext: string): Promise<LoadedModel> {
  const o = await open(url, 'default')
  // 相対の URI は転送された先から解決する
  const base = o.url || url
  let data: Uint8Array
  let format: string
  try {
    const h = await readHead(o, 64)
    const s = await sniffAsync(h.head, o.type, ext)
    if (!s || s.route !== 'model') {
      o.controller.abort()
      throw new WrongKindError(s ? s.route : 'image', s ? s.format : '')
    }
    format = s.format
    data = await readRest(o, h, MAX_MODEL_BYTES)
  }
  finally {
    o.done()
  }
  let glb: ArrayBuffer
  if (format === 'glb') {
    const { json, bin } = splitGlb(data)
    glb = await packGltf(json, bin, base, data.length, data, url)
  }
  else {
    let json: GltfJson
    try {
      json = JSON.parse(new TextDecoder().decode(data)) as GltfJson
    }
    catch {
      throw new Error('not a glTF')
    }
    if (!json || typeof json !== 'object' || !('asset' in json)) throw new Error('not a glTF')
    glb = await packGltf(json, null, base, data.length, null, url)
  }
  const loader = await getGltfLoader()
  const gltf: GLTF = await withTimeout(loader.parseAsync(glb, ''), 60000)
  const scene = gltf.scene
  const extras = gltfExtras(gltf)
  // モデルの中の光源は three.js の光源にせず (ほかの看板や地図まで照らしてしまう)、位置だけのノードにしてある (model-ext.ts)。
  // 光はそのモデルの材質の中だけで計算する (model-shading.ts)
  let cpuTextures = 0
  scene.traverse((o) => {
    // 名前のないノードは、アニメーションが uuid で指しているので、看板ごとに写しても見つかるように uuid を名前にする
    if (!o.name) o.name = o.uuid
    const mesh = o as Mesh
    if (mesh.isMesh) {
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      for (const m of mats) {
        const index = gltf.parser.associations.get(m)?.materials
        prepareMaterial(m, index, index === undefined ? undefined : extras.materials.get(index))
      }
      // スキニングのモデルは、動いても消えないように (動いた先は直方体の外になりうる)
      if ((o as SkinnedMesh).isSkinnedMesh) o.frustumCulled = false
    }
  })
  const model: LoadedModel = { scene, clips: gltf.animations, box: [], triangles: 0, extras, cpuTextures: 0 }
  for (const t of modelTextures(model)) if (t.userData.msCpuDecoded) cpuTextures++
  model.cpuTextures = cpuTextures
  const triangles = countTriangles(scene)
  model.triangles = triangles
  if (triangles > MAX_TRIANGLES) {
    disposeModel(model)
    throw new Error('Model exceeds safety limits (max ' + MAX_TRIANGLES + ' triangles)')
  }
  if (triangles === 0) {
    disposeModel(model)
    throw new Error('Model has no triangles')
  }
  scene.updateMatrixWorld(true)
  const b = new Box3().setFromObject(scene, true)
  if (b.isEmpty()) {
    disposeModel(model)
    throw new Error('Model is empty')
  }
  model.box = [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]
  return model
}

/** モデルが持つテクスチャ (材質のものと、拡張のもの) */
function modelTextures(model: LoadedModel): Set<Texture> {
  const textures = new Set<Texture>(model.extras.textures)
  model.scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    const mats: Material[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) {
      for (const v of Object.values(m)) if (v && (v as Texture).isTexture) textures.add(v as Texture)
      for (const t of materialTextures(m)) textures.add(t)
    }
  })
  return textures
}

export function disposeModel(model: LoadedModel): void {
  const textures = modelTextures(model)
  model.scene.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh) return
    mesh.geometry?.dispose()
    const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
    for (const m of mats) m.dispose()
  })
  for (const t of textures) t.dispose()
}