// three.js の GLTFLoader に足す拡張 (MarumaSign 本体の GltfLoader.java が読むもののうち、three.js にないもの):
//  - KHR_lights_punctual: three.js の光源にはしない (地図のほかの看板まで照らしてしまう)。位置と向きだけのノードにして、
//    光はそのモデルの材質の中で計算する (model-shading.ts。MarumaSign 本体の GltfLight と同じ式)
//  - EXT_lights_image_based: 球面調和関数の環境光と、映り込む景色 (キューブマップ)
//  - KHR_materials_diffuse_transmission: 裏からの光 (model-shading.ts で計算する)
//  - KHR_animation_pointer: 材質・光源・カメラ・ノードの値のアニメーション
//  - KHR_node_visibility: ノードを隠す (アニメーションも)
// 値を書き換える先は看板ごとに写した材質なので、ここでは「どこを書き換えるか」(PointerSpec) だけを決め、
// 看板に置くときに model-shading.ts が書き換え先 (名前を付けたノードの v) を作る
import {
  BooleanKeyframeTrack, CubeTexture, InterpolateDiscrete, InterpolateLinear, type KeyframeTrack, NumberKeyframeTrack, Object3D,
  PMREMGenerator, Quaternion, SRGBColorSpace, type Texture, VectorKeyframeTrack, type AnimationClip, type BufferAttribute,
  type InterleavedBufferAttribute,
} from 'three'
import type { GLTF, GLTFLoaderPlugin, GLTFParser } from 'three/addons/loaders/GLTFLoader.js'
import { getRenderer } from './renderer-ref'

export const LIGHT_DIRECTIONAL = 0
export const LIGHT_POINT = 1
export const LIGHT_SPOT = 2

/** KHR_lights_punctual の光源 1 つ (MarumaSign 本体の GltfModel.Light と同じ既定値) */
export interface ModelLight {
  type: number
  color: [number, number, number]
  intensity: number
  /** 0 は無限 */
  range: number
  innerConeAngle: number
  outerConeAngle: number
}

/** EXT_lights_image_based */
export interface ModelIbl {
  /** 9 個の RGB (27 個)。なければ空と地面の明るさ */
  sh: Float32Array | null
  intensity: number
  /** 環境の向き (x, y, z, w) */
  rotation: [number, number, number, number]
  /** 映り込む景色 (PMREM)。なければ空と地面のグラデーション */
  env: Texture | null
}

/** 材質ごとの、three.js の材質にない値 (glTF の材質の番号ごと) */
export interface MaterialExtra {
  diffuseTransmission?: { factor: number, color: [number, number, number], map: Texture | null, colorMap: Texture | null }
  specularGlossiness?: { f0: [number, number, number], glossiness: number, map: Texture | null }
}

/** KHR_animation_pointer の 1 つの書き換え先 */
export interface PointerSpec {
  /** 書き換えるノードの名前 (トラックは <名前>.v) */
  proxy: string
  kind: 'material' | 'light' | 'camera'
  index: number
  /** 番号のあとの JSON Pointer (例: pbrMetallicRoughness/baseColorFactor) */
  path: string
  size: number
}

export interface ModelExtras {
  lights: ModelLight[]
  ibl: ModelIbl | null
  materials: Map<number, MaterialExtra>
  pointers: PointerSpec[]
  /** 片付けるもの (材質に付けないテクスチャ) */
  textures: Set<Texture>
}

const extrasByParser = new WeakMap<GLTFParser, ModelExtras>()

export function extrasOf(parser: GLTFParser): ModelExtras {
  let e = extrasByParser.get(parser)
  if (!e) {
    e = { lights: [], ibl: null, materials: new Map(), pointers: [], textures: new Set() }
    extrasByParser.set(parser, e)
  }
  return e
}

export function gltfExtras(gltf: GLTF): ModelExtras {
  return extrasOf(gltf.parser)
}

type Json = Record<string, unknown>
const obj = (v: unknown): Json => (v && typeof v === 'object' && !Array.isArray(v) ? v as Json : {})
const num = (v: unknown, def: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : def)
const nums = (v: unknown, n: number, def: number[]): number[] =>
  Array.isArray(v) && v.length >= n && v.slice(0, n).every(x => typeof x === 'number' && Number.isFinite(x)) ? v.slice(0, n) as number[] : def

interface ParserInternals {
  json: Json
  createUniqueName(name: string): string
  getDependency(type: string, index: number): Promise<unknown>
  assignTexture(params: Record<string, unknown>, name: string, def: unknown, colorSpace?: string): Promise<Texture | null>
  loadImageSource(source: number, loader: unknown): Promise<Texture>
  textureLoader: unknown
  loadAnimation(index: number): Promise<AnimationClip>
  _createAnimationTracks(node: Object3D, input: BufferAttribute, output: BufferAttribute, sampler: Json, target: Json): KeyframeTrack[]
  _getArrayFromAccessor(accessor: BufferAttribute | InterleavedBufferAttribute): ArrayLike<number>
  _createCubicSplineTrackInterpolant(track: KeyframeTrack): void
}

const internals = (parser: GLTFParser): ParserInternals => parser as unknown as ParserInternals

// ---------------------------------------------------------------- KHR_lights_punctual

export function lightsPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const p = internals(parser)
  const ext = extrasOf(parser)
  const defs = (obj(obj(p.json.extensions).KHR_lights_punctual).lights ?? []) as unknown[]
  ext.lights = (Array.isArray(defs) ? defs : []).map((d): ModelLight => {
    const j = obj(d)
    const spot = obj(j.spot)
    return {
      type: j.type === 'point' ? LIGHT_POINT : j.type === 'spot' ? LIGHT_SPOT : LIGHT_DIRECTIONAL,
      color: nums(j.color, 3, [1, 1, 1]) as [number, number, number],
      intensity: num(j.intensity, 1),
      range: num(j.range, 0),
      innerConeAngle: num(spot.innerConeAngle, 0),
      outerConeAngle: num(spot.outerConeAngle, Math.PI / 4),
    }
  })
  return {
    name: 'KHR_lights_punctual',
    createNodeAttachment(nodeIndex: number): Promise<Object3D> | null {
      const nodes = (p.json.nodes ?? []) as unknown[]
      const index = obj(obj(obj(nodes[nodeIndex]).extensions).KHR_lights_punctual).light
      if (typeof index !== 'number' || !ext.lights[index]) return null
      const o = new Object3D()
      o.name = p.createUniqueName('light_' + index)
      o.userData.msLight = index
      return Promise.resolve(o)
    },
  } as GLTFLoaderPlugin
}

// ---------------------------------------------------------------- EXT_lights_image_based

/** 映り込む景色の一辺 (大きいキューブマップは縮める) */
const ENV_FACE = 256

export function iblPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const p = internals(parser)
  const ext = extrasOf(parser)
  return {
    name: 'EXT_lights_image_based',
    async beforeRoot(): Promise<void> {
      const lights = obj(obj(p.json.extensions).EXT_lights_image_based).lights
      if (!Array.isArray(lights) || lights.length === 0) return
      // 既定の場面が使う光 (なければ最初のもの。MarumaSign 本体は最初のもの)
      const scenes = (p.json.scenes ?? []) as unknown[]
      const scene = obj(scenes[num(p.json.scene, 0)])
      const index = num(obj(obj(scene.extensions).EXT_lights_image_based).light, 0)
      const def = obj(lights[index] ?? lights[0])
      // 決まりの名前は irradianceCoefficients (MarumaSign 本体は sphericalHarmonics を読む)
      const coeffs = Array.isArray(def.irradianceCoefficients) ? def.irradianceCoefficients : def.sphericalHarmonics
      let sh: Float32Array | null = null
      if (Array.isArray(coeffs) && coeffs.length === 9) {
        sh = new Float32Array(27)
        coeffs.forEach((c, i) => {
          const v = nums(c, 3, [0, 0, 0])
          sh![i * 3] = v[0]!
          sh![i * 3 + 1] = v[1]!
          sh![i * 3 + 2] = v[2]!
        })
      }
      const ibl: ModelIbl = {
        sh,
        intensity: Math.max(0, num(def.intensity, 1)),
        rotation: nums(def.rotation, 4, [0, 0, 0, 1]) as [number, number, number, number],
        env: null,
      }
      const faces = Array.isArray(def.specularImages) ? def.specularImages[0] : null
      if (Array.isArray(faces) && faces.length === 6 && faces.every(f => typeof f === 'number')) {
        try {
          ibl.env = await loadEnvironment(p, faces as number[])
          if (ibl.env) ext.textures.add(ibl.env)
        }
        catch (e) {
          console.info('MarumaSign: EXT_lights_image_based specular images', String(e))
        }
      }
      if (ibl.sh || ibl.env) ext.ibl = ibl
    },
  } as GLTFLoaderPlugin
}

async function loadEnvironment(p: ParserInternals, faces: number[]): Promise<Texture | null> {
  const renderer = getRenderer()
  if (!renderer) return null
  const textures = await Promise.all(faces.map(i => p.loadImageSource(i, p.textureLoader)))
  try {
    // 一辺を ENV_FACE までに縮める (PMREM の大きさはキューブマップの一辺で決まる)
    const images = textures.map((t) => {
      const img = t.image as HTMLImageElement | ImageBitmap
      const size = Math.min(ENV_FACE, Math.max(1, img.width))
      const canvas = document.createElement('canvas')
      canvas.width = size
      canvas.height = size
      canvas.getContext('2d')!.drawImage(img, 0, 0, size, size)
      return canvas
    })
    const cube = new CubeTexture(images)
    cube.colorSpace = SRGBColorSpace
    cube.needsUpdate = true
    const pmrem = new PMREMGenerator(renderer)
    const env = pmrem.fromCubemap(cube).texture
    pmrem.dispose()
    cube.dispose()
    return env
  }
  finally {
    for (const t of textures) t.dispose()
  }
}

// ---------------------------------------------------------------- KHR_materials_diffuse_transmission と、KHR_materials_pbrSpecularGlossiness の残り

export function diffuseTransmissionPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const NAME = 'KHR_materials_diffuse_transmission'
  const p = internals(parser)
  const ext = extrasOf(parser)
  return {
    name: NAME,
    async extendMaterialParams(materialIndex: number): Promise<void> {
      const def = obj(obj(obj(((p.json.materials ?? []) as unknown[])[materialIndex]).extensions)[NAME])
      if (Object.keys(def).length === 0) return
      const tmp: Record<string, unknown> = {}
      const pending: Promise<unknown>[] = []
      if (def.diffuseTransmissionTexture) pending.push(p.assignTexture(tmp, 'map', def.diffuseTransmissionTexture))
      if (def.diffuseTransmissionColorTexture) pending.push(p.assignTexture(tmp, 'colorMap', def.diffuseTransmissionColorTexture, SRGBColorSpace))
      await Promise.all(pending)
      const extra = ext.materials.get(materialIndex) ?? {}
      extra.diffuseTransmission = {
        factor: num(def.diffuseTransmissionFactor, 0),
        color: nums(def.diffuseTransmissionColorFactor, 3, [1, 1, 1]) as [number, number, number],
        map: (tmp.map as Texture) ?? null,
        colorMap: (tmp.colorMap as Texture) ?? null,
      }
      for (const t of [extra.diffuseTransmission.map, extra.diffuseTransmission.colorMap]) if (t) ext.textures.add(t)
      ext.materials.set(materialIndex, extra)
    },
  } as GLTFLoaderPlugin
}

/** KHR_materials_pbrSpecularGlossiness の反射の色と、つやのテクスチャ (MarumaSign 本体と同じく F0 = specularFactor) */
export async function specularGlossinessExtra(parser: GLTFParser, materialIndex: number, def: Json): Promise<void> {
  const p = internals(parser)
  const ext = extrasOf(parser)
  const tmp: Record<string, unknown> = {}
  if (def.specularGlossinessTexture) await p.assignTexture(tmp, 'map', def.specularGlossinessTexture, SRGBColorSpace)
  const extra = ext.materials.get(materialIndex) ?? {}
  extra.specularGlossiness = {
    f0: nums(def.specularFactor, 3, [1, 1, 1]) as [number, number, number],
    glossiness: num(def.glossinessFactor, 1),
    map: (tmp.map as Texture) ?? null,
  }
  if (extra.specularGlossiness.map) ext.textures.add(extra.specularGlossiness.map)
  ext.materials.set(materialIndex, extra)
}

// ---------------------------------------------------------------- KHR_node_visibility と、カメラの番号

export function nodeExtrasPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const p = internals(parser)
  return {
    name: 'KHR_node_visibility',
    async afterRoot(): Promise<void> {
      const nodes = (p.json.nodes ?? []) as unknown[]
      await Promise.all(nodes.map(async (n, i) => {
        const def = obj(n)
        const hidden = obj(obj(def.extensions).KHR_node_visibility).visible === false
        if (!hidden && typeof def.camera !== 'number') return
        const node = await p.getDependency('node', i) as Object3D
        if (!node) return
        if (hidden) node.visible = false
        if (typeof def.camera === 'number') {
          const camera = (node as { isCamera?: boolean }).isCamera ? node : node.children.find(c => (c as { isCamera?: boolean }).isCamera)
          if (camera) camera.userData.msCamera = def.camera
        }
      }))
    },
  } as GLTFLoaderPlugin
}

// ---------------------------------------------------------------- KHR_animation_pointer

/** 材質の値の大きさ (MarumaSign 本体が書き換えるものと、glTF の Object Model の残り) */
export const MATERIAL_POINTER_SIZES: Record<string, number> = {
  'pbrMetallicRoughness/baseColorFactor': 4,
  'pbrMetallicRoughness/metallicFactor': 1,
  'pbrMetallicRoughness/roughnessFactor': 1,
  'alphaCutoff': 1,
  'emissiveFactor': 3,
  'normalTexture/scale': 1,
  'occlusionTexture/strength': 1,
  'extensions/KHR_materials_emissive_strength/emissiveStrength': 1,
  'extensions/KHR_materials_ior/ior': 1,
  'extensions/KHR_materials_transmission/transmissionFactor': 1,
  'extensions/KHR_materials_volume/thicknessFactor': 1,
  'extensions/KHR_materials_volume/attenuationDistance': 1,
  'extensions/KHR_materials_volume/attenuationColor': 3,
  'extensions/KHR_materials_clearcoat/clearcoatFactor': 1,
  'extensions/KHR_materials_clearcoat/clearcoatRoughnessFactor': 1,
  'extensions/KHR_materials_clearcoat/clearcoatNormalTexture/scale': 1,
  'extensions/KHR_materials_sheen/sheenColorFactor': 3,
  'extensions/KHR_materials_sheen/sheenRoughnessFactor': 1,
  'extensions/KHR_materials_specular/specularFactor': 1,
  'extensions/KHR_materials_specular/specularColorFactor': 3,
  'extensions/KHR_materials_iridescence/iridescenceFactor': 1,
  'extensions/KHR_materials_iridescence/iridescenceIor': 1,
  'extensions/KHR_materials_iridescence/iridescenceThicknessMinimum': 1,
  'extensions/KHR_materials_iridescence/iridescenceThicknessMaximum': 1,
  'extensions/KHR_materials_anisotropy/anisotropyStrength': 1,
  'extensions/KHR_materials_anisotropy/anisotropyRotation': 1,
  'extensions/KHR_materials_dispersion/dispersion': 1,
  'extensions/KHR_materials_diffuse_transmission/diffuseTransmissionFactor': 1,
  'extensions/KHR_materials_diffuse_transmission/diffuseTransmissionColorFactor': 3,
}

/** テクスチャの貼り方 (KHR_texture_transform) を書き換えられるテクスチャ: glTF の場所 → three.js の材質の持ち物 */
export const TEXTURE_SLOTS: Record<string, string[]> = {
  'pbrMetallicRoughness/baseColorTexture': ['map'],
  'pbrMetallicRoughness/metallicRoughnessTexture': ['metalnessMap', 'roughnessMap'],
  'normalTexture': ['normalMap'],
  'occlusionTexture': ['aoMap'],
  'emissiveTexture': ['emissiveMap'],
  'extensions/KHR_materials_clearcoat/clearcoatTexture': ['clearcoatMap'],
  'extensions/KHR_materials_clearcoat/clearcoatRoughnessTexture': ['clearcoatRoughnessMap'],
  'extensions/KHR_materials_clearcoat/clearcoatNormalTexture': ['clearcoatNormalMap'],
  'extensions/KHR_materials_sheen/sheenColorTexture': ['sheenColorMap'],
  'extensions/KHR_materials_sheen/sheenRoughnessTexture': ['sheenRoughnessMap'],
  'extensions/KHR_materials_specular/specularTexture': ['specularIntensityMap'],
  'extensions/KHR_materials_specular/specularColorTexture': ['specularColorMap'],
  'extensions/KHR_materials_iridescence/iridescenceTexture': ['iridescenceMap'],
  'extensions/KHR_materials_iridescence/iridescenceThicknessTexture': ['iridescenceThicknessMap'],
  'extensions/KHR_materials_anisotropy/anisotropyTexture': ['anisotropyMap'],
  'extensions/KHR_materials_transmission/transmissionTexture': ['msTransmissionMap'],
  'extensions/KHR_materials_volume/thicknessTexture': ['msThicknessMap'],
  'extensions/KHR_materials_diffuse_transmission/diffuseTransmissionTexture': ['msDiffuseTransmissionMap'],
  'extensions/KHR_materials_diffuse_transmission/diffuseTransmissionColorTexture': ['msDiffuseTransmissionColorMap'],
  'extensions/KHR_materials_pbrSpecularGlossiness/diffuseTexture': ['map'],
  'extensions/KHR_materials_pbrSpecularGlossiness/specularGlossinessTexture': ['msSpecularGlossinessMap'],
}

export const TEXTURE_TRANSFORM_SIZES: Record<string, number> = { offset: 2, scale: 2, rotation: 1 }

export const LIGHT_POINTER_SIZES: Record<string, number> = {
  'color': 3, 'intensity': 1, 'range': 1, 'spot/innerConeAngle': 1, 'spot/outerConeAngle': 1,
}

export const CAMERA_POINTER_SIZES: Record<string, number> = {
  'perspective/yfov': 1, 'perspective/aspectRatio': 1, 'perspective/znear': 1, 'perspective/zfar': 1,
  'orthographic/xmag': 1, 'orthographic/ymag': 1, 'orthographic/znear': 1, 'orthographic/zfar': 1,
}

/** 材質のポインターの値の大きさ (書き換えられないものは 0) */
export function materialPointerSize(path: string): number {
  if (MATERIAL_POINTER_SIZES[path]) return MATERIAL_POINTER_SIZES[path]!
  const m = /^(.+Texture)\/extensions\/KHR_texture_transform\/(offset|scale|rotation)$/.exec(path)
  return m && TEXTURE_SLOTS[m[1]!] ? TEXTURE_TRANSFORM_SIZES[m[2]!]! : 0
}

/** JSON Pointer を区切る (~1 は /、~0 は ~) */
export function splitPointer(pointer: string): string[] | null {
  if (!pointer.startsWith('/')) return null
  return pointer.substring(1).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'))
}

const INDEX = /^(0|[1-9][0-9]{0,6})$/

/** ポインターを、書き換え先の種類・番号・場所にする (読まないものは null) */
export function parsePointer(pointer: string): { kind: 'node' | 'material' | 'light' | 'camera', index: number, path: string } | null {
  const parts = splitPointer(pointer)
  if (!parts) return null
  if ((parts[0] === 'nodes' || parts[0] === 'materials' || parts[0] === 'cameras') && parts.length >= 3 && INDEX.test(parts[1]!)) {
    const kind = parts[0] === 'nodes' ? 'node' : parts[0] === 'materials' ? 'material' : 'camera'
    return { kind, index: Number(parts[1]), path: parts.slice(2).join('/') }
  }
  if (parts[0] === 'extensions' && parts[1] === 'KHR_lights_punctual' && parts[2] === 'lights' && parts.length >= 5 && INDEX.test(parts[3]!)) {
    return { kind: 'light', index: Number(parts[3]), path: parts.slice(4).join('/') }
  }
  return null
}

const NODE_PATHS = new Set(['translation', 'rotation', 'scale', 'weights', 'extensions/KHR_node_visibility/visible'])

export function animationPointerPlugin(parser: GLTFParser): GLTFLoaderPlugin {
  const p = internals(parser)
  const ext = extrasOf(parser)
  let proxies = 0
  return {
    name: 'KHR_animation_pointer',
    loadAnimation(animationIndex: number): Promise<AnimationClip> {
      // ふつうのチャンネルは GLTFLoader に読ませ (target.node のないものは読み飛ばす)、ポインターのものを足す
      return p.loadAnimation(animationIndex).then(async (clip) => {
        const def = obj(((p.json.animations ?? []) as unknown[])[animationIndex])
        const channels = Array.isArray(def.channels) ? def.channels : []
        const samplers = Array.isArray(def.samplers) ? def.samplers : []
        for (const c of channels) {
          const channel = obj(c)
          const target = obj(channel.target)
          const pointer = obj(obj(target.extensions).KHR_animation_pointer).pointer
          if (target.node !== undefined || typeof pointer !== 'string') continue
          const sampler = obj(samplers[num(channel.sampler, -1)])
          if (typeof sampler.input !== 'number' || typeof sampler.output !== 'number') continue
          const ptr = parsePointer(pointer)
          if (!ptr) continue
          try {
            const [input, output] = await Promise.all([
              p.getDependency('accessor', sampler.input) as Promise<BufferAttribute>,
              p.getDependency('accessor', sampler.output) as Promise<BufferAttribute>,
            ])
            if (!input || !output) continue
            for (const t of await pointerTracks(ptr, input, output, sampler)) clip.tracks.push(t)
          }
          catch (e) {
            console.info('MarumaSign: KHR_animation_pointer', pointer, String(e))
          }
        }
        clip.resetDuration()
        return clip
      })
    },
  } as GLTFLoaderPlugin

  async function pointerTracks(ptr: NonNullable<ReturnType<typeof parsePointer>>, input: BufferAttribute, output: BufferAttribute, sampler: Json): Promise<KeyframeTrack[]> {
    const cubic = sampler.interpolation === 'CUBICSPLINE'
    const step = sampler.interpolation === 'STEP'
    const values = p._getArrayFromAccessor(output)
    if (ptr.kind === 'node') {
      if (!NODE_PATHS.has(ptr.path)) return []
      const node = await p.getDependency('node', ptr.index) as Object3D
      if (!node) return []
      // 名前のないノードは uuid で指す (GLTFLoader と同じ)
      if (ptr.path === 'extensions/KHR_node_visibility/visible') {
        const name = node.name || node.uuid
        const flags = Array.from({ length: input.count }, (_, i) => values[(cubic ? i * 3 + 1 : i)]! !== 0)
        return [new BooleanKeyframeTrack(name + '.visible', input.array as unknown as number[], flags)]
      }
      return p._createAnimationTracks(node, input, output, sampler, { node: ptr.index, path: ptr.path }) ?? []
    }
    const size = ptr.kind === 'material' ? materialPointerSize(ptr.path)
      : ptr.kind === 'light' ? LIGHT_POINTER_SIZES[ptr.path] ?? 0
        : CAMERA_POINTER_SIZES[ptr.path] ?? 0
    if (!size || output.itemSize !== size) return []
    const proxy = 'ms_pointer_' + (proxies++)
    ext.pointers.push({ proxy, kind: ptr.kind, index: ptr.index, path: ptr.path, size })
    const Track = size === 1 ? NumberKeyframeTrack : VectorKeyframeTrack
    const track = new Track(proxy + '.v', input.array as unknown as number[], values as unknown as number[], step ? InterpolateDiscrete : InterpolateLinear)
    if (cubic) p._createCubicSplineTrackInterpolant(track)
    return [track]
  }
}

/** EXT_lights_image_based の向き (環境の向きの逆。モデルの向きから環境の向きにする) */
export function iblInverseRotation(ibl: ModelIbl): Quaternion {
  return new Quaternion(...ibl.rotation).normalize().invert()
}
