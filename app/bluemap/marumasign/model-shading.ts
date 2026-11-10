// 3D モデルの陰影を、MarumaSign 本体 (core/gltf/GltfLight.java) と同じ式で描く。
// 本体はモデルに固定の照明 (上からの空の明るさ、斜め上からの太陽、空と地面の映り込み) と、決まった向き (正面の少し上) から
// 見たときの陰影を、読み込みのときに頂点の色やテクスチャに焼き込む。ここでは同じ式を three.js の材質のシェーダーの中で
// 画素ごとに計算する (本体の焼き込みと同じく、見る向きが変わっても陰影は変わらない)。
//  - three.js の光源 (と、前に使っていた半球光・平行光・部屋の景色) は使わない
//  - モデルの中の光源 (KHR_lights_punctual) も、本体と同じ式で、そのモデルの材質の中だけで計算する。
//    光はほかの看板や地図を照らさず、深度バッファーと対数深度は BlueMap の描画のものをそのまま使う (描く回数も増えない)
//  - EXT_lights_image_based の球面調和関数は環境光に (本体と同じ)、キューブマップは映り込む景色に使う
//  - KHR_materials_diffuse_transmission、透過 (半透明として)、厚み (色)、クリアコート、シーン、イリデッセンス、異方性も本体の式
// 看板に置くたびに材質を写し (同じモデルの看板でも、光源とアニメーションの値は看板ごと)、シェーダーの値をその看板のものにする
import {
  type Camera, Color, Matrix3, Matrix4, type Material, type Mesh, MeshBasicMaterial, MeshPhysicalMaterial, MeshStandardMaterial,
  Object3D, type OrthographicCamera, type PerspectiveCamera, type Texture, Vector2, Vector3, Vector4, type WebGLProgramParametersWithUniforms,
} from 'three'
import {
  iblInverseRotation, materialPointerSize, TEXTURE_SLOTS, type MaterialExtra, type ModelExtras, type PointerSpec,
} from './model-ext'

/** 1 つのモデルで計算する光源の数の上限 */
export const MAX_MODEL_LIGHTS = 16

// ---------------------------------------------------------------- シェーダー

const VERTEX_PARS = /* glsl */`
uniform mat4 msWorldToModel;
varying vec3 vMsPos;
#ifdef MS_UV
  varying vec2 vMsUv0;
  varying vec2 vMsUv1;
  #ifndef USE_UV1
    attribute vec2 uv1;
  #endif
#endif
`

const VERTEX_MAIN = /* glsl */`
{
  vec4 msP = vec4( transformed, 1.0 );
  #ifdef USE_BATCHING
    msP = batchingMatrix * msP;
  #endif
  #ifdef USE_INSTANCING
    msP = instanceMatrix * msP;
  #endif
  vMsPos = ( msWorldToModel * ( modelMatrix * msP ) ).xyz;
  #ifdef MS_UV
    vMsUv0 = uv;
    vMsUv1 = uv1;
  #endif
}
`

const FRAGMENT_PARS = /* glsl */`
uniform mat3 msNormalToModel;
uniform mat3 msIblRotation;
uniform float msIblIntensity;
varying vec3 vMsPos;
#ifdef MS_UV
  varying vec2 vMsUv0;
  varying vec2 vMsUv1;
#endif
#if MS_LIGHTS > 0
  uniform vec3 msLightPos[ MS_LIGHTS ];
  uniform vec3 msLightDir[ MS_LIGHTS ];
  uniform vec3 msLightColor[ MS_LIGHTS ];
  uniform vec4 msLightParam[ MS_LIGHTS ];
  uniform vec2 msLightCone[ MS_LIGHTS ];
#endif
#ifdef MS_SH
  uniform vec3 msSh[ 9 ];
#endif
#ifdef MS_TRANSMISSION
  uniform float msTransmission;
  uniform float msThickness;
  uniform float msAttenuationDistance;
  uniform vec3 msAttenuationColor;
#endif
#ifdef MS_DT
  uniform float msDiffuseTransmission;
  uniform vec3 msDiffuseTransmissionColor;
#endif
#ifdef MS_SPECGLOSS
  uniform vec3 msF0;
  uniform float msGlossiness;
#endif
#define MS_MAP( map, transform, coord ) texture2D( map, ( transform * vec3( coord, 1.0 ) ).xy )
#ifdef MS_TRANSMISSION_MAP
  uniform sampler2D msTransmissionMap;
  uniform mat3 msTransmissionMapTransform;
#endif
#ifdef MS_THICKNESS_MAP
  uniform sampler2D msThicknessMap;
  uniform mat3 msThicknessMapTransform;
#endif
#ifdef MS_DT_MAP
  uniform sampler2D msDiffuseTransmissionMap;
  uniform mat3 msDiffuseTransmissionMapTransform;
#endif
#ifdef MS_DT_COLOR_MAP
  uniform sampler2D msDiffuseTransmissionColorMap;
  uniform mat3 msDiffuseTransmissionColorMapTransform;
#endif
#ifdef MS_SPECGLOSS_MAP
  uniform sampler2D msSpecularGlossinessMap;
  uniform mat3 msSpecularGlossinessMapTransform;
#endif

// MarumaSign 本体 (GltfLight.java) の照明
#define MS_SKY 0.39
#define MS_GROUND 0.21
#define MS_SUN 0.68
#define MS_SUN_GLARE 2.4
#define MS_MIRROR_SKY 1.0
#define MS_MIRROR_GROUND 0.16
const vec3 MS_SUN_DIR = vec3( 0.088, 0.894, 0.440 );
const vec3 MS_VIEW = vec3( 0.0, 0.196, 0.981 );

struct MsSurface {
  vec3 base;
  float metallic;
  float roughness;
  vec3 n;
  float occ;
  vec3 df0;
  float clearcoat;
  float ccRough;
  vec3 ccN;
  vec3 sheen;
  float sheenRough;
  float irid;
  float iridIor;
  float iridThick;
  float aniso;
  vec3 t;
  vec3 b;
  vec3 dt;
  vec3 pos;
};

vec3 msToModel( vec3 viewDir ) {
  return normalize( msNormalToModel * normalize( ( vec4( viewDir, 0.0 ) * viewMatrix ).xyz ) );
}

float msPow5( float x ) {
  float x2 = x * x;
  return x2 * x2 * x;
}

float msGgx( float nh, float nl, float nv, float r ) {
  float a = r * r;
  float a2 = a * a;
  float d = nh * nh * ( a2 - 1.0 ) + 1.0;
  float dist = a2 / ( 3.14159265 * d * d );
  float k = a / 2.0;
  float vis = 1.0 / ( 4.0 * ( nl * ( 1.0 - k ) + k ) * ( nv * ( 1.0 - k ) + k ) );
  return min( 4.0, dist * vis );
}

float msAnisoGgx( MsSurface s, vec3 h, float nl, float nv, float r ) {
  float at = max( 0.001, r * r * ( 1.0 + s.aniso ) );
  float ab = max( 0.001, r * r * ( 1.0 - s.aniso ) );
  float th = dot( s.t, h );
  float bh = dot( s.b, h );
  float nh = dot( s.n, h );
  float d1 = ( th * th ) / ( at * at ) + ( bh * bh ) / ( ab * ab ) + nh * nh;
  float dist = 1.0 / ( 3.14159265 * at * ab * d1 * d1 );
  float k = ( at + ab ) * 0.25;
  float vis = 1.0 / ( 4.0 * ( nl * ( 1.0 - k ) + k ) * ( nv * ( 1.0 - k ) + k ) );
  return min( 4.0, dist * vis );
}

float msSkyGround( float ny ) {
  return MS_GROUND + ( MS_SKY - MS_GROUND ) * ( 0.5 + 0.5 * ny );
}

#ifdef MS_SH
vec3 msEvalSh( vec3 n ) {
  // Ramamoorthi & Hanrahan (2001)
  const float c1 = 0.429043, c2 = 0.511664, c3 = 0.743125, c4 = 0.886227, c5 = 0.247708;
  vec3 v = c1 * msSh[ 8 ] * ( n.x * n.x - n.y * n.y ) + c3 * msSh[ 6 ] * ( n.z * n.z ) + c4 * msSh[ 0 ] - c5 * msSh[ 6 ]
    + 2.0 * c1 * ( msSh[ 4 ] * n.x * n.y + msSh[ 7 ] * n.x * n.z + msSh[ 5 ] * n.y * n.z )
    + 2.0 * c2 * ( msSh[ 3 ] * n.x + msSh[ 1 ] * n.y + msSh[ 2 ] * n.z );
  return max( vec3( 0.0 ), v * 0.318309886 );
}
#endif

vec3 msAmbient( vec3 n, float occ ) {
  #if defined( MS_SH )
    return msEvalSh( msIblRotation * n ) * msIblIntensity * occ;
  #elif defined( MS_ENV )
    return textureCubeUV( envMap, msIblRotation * n, 1.0 ).rgb * msIblIntensity * occ;
  #else
    return vec3( msSkyGround( n.y ) * occ );
  #endif
}

// 景色の映り込み (EXT_lights_image_based のキューブマップがあれば、それを映す)
vec3 msMirror( vec3 n, float nv, float rough, float occ ) {
  #ifdef MS_ENV
    vec3 r = 2.0 * nv * n - MS_VIEW;
    return textureCubeUV( envMap, msIblRotation * r, rough ).rgb * msIblIntensity * occ;
  #else
    float reflY = 2.0 * nv * n.y - MS_VIEW.y;
    float h = clamp( 0.5 + 0.5 * reflY, 0.0, 1.0 );
    h = h * h * ( 3.0 - 2.0 * h );
    float sharp = MS_MIRROR_GROUND + ( MS_MIRROR_SKY - MS_MIRROR_GROUND ) * h;
    float blurred = msSkyGround( n.y ) * 1.6;
    return vec3( ( sharp + ( blurred - sharp ) * rough ) * occ );
  #endif
}

vec3 msShade( MsSurface s ) {
  float metallic = clamp( s.metallic, 0.0, 1.0 );
  float rough = clamp( s.roughness, 0.04, 1.0 );
  vec3 n = s.n;
  float nv = dot( n, MS_VIEW );
  float facing = abs( nv );
  float nl = max( 0.0, dot( n, MS_SUN_DIR ) );
  vec3 ambient = msAmbient( n, s.occ );
  vec3 diffuse = ( ambient + MS_SUN * nl ) * ( 1.0 - metallic );
  // 拡散透過 (裏からの太陽)
  diffuse += max( 0.0, - dot( n, MS_SUN_DIR ) ) * MS_SUN * s.dt;
  vec3 f0 = s.df0 + ( s.base - s.df0 ) * metallic;
  // 薄膜干渉
  if ( s.irid > 0.0 ) {
    float eta = max( 1.0, s.iridIor );
    float sinT2 = max( 0.0, 1.0 - facing * facing ) / ( eta * eta );
    float cosT = sqrt( max( 0.0, 1.0 - sinT2 ) );
    float opd = 2.0 * eta * s.iridThick * cosT;
    vec3 ir = 0.5 + 0.5 * cos( 6.2831853 * opd / vec3( 650.0, 530.0, 440.0 ) );
    f0 += ( ir - f0 ) * s.irid;
  }
  // 太陽のハイライト
  vec3 spec = vec3( 0.0 );
  if ( nl > 0.0 && nv > 0.0 ) {
    vec3 h = normalize( MS_SUN_DIR + MS_VIEW );
    float nh = max( 0.0, dot( n, h ) );
    float vh = max( 0.0, dot( MS_VIEW, h ) );
    float g = ( abs( s.aniso ) > 0.01 && dot( s.t, s.t ) > 0.0 ) ? msAnisoGgx( s, h, nl, nv, rough ) : msGgx( nh, nl, nv, rough );
    g *= nl * MS_SUN_GLARE;
    spec = g * ( f0 + ( 1.0 - f0 ) * msPow5( 1.0 - vh ) );
  }
  // モデルの中の光源 (KHR_lights_punctual)
  #if MS_LIGHTS > 0
  for ( int i = 0; i < MS_LIGHTS; i ++ ) {
    vec4 prm = msLightParam[ i ];
    vec3 l;
    float att = 1.0;
    if ( prm.x < 0.5 ) {
      l = - msLightDir[ i ];
    } else {
      l = msLightPos[ i ] - s.pos;
      float dist = length( l );
      if ( dist > 1e-4 ) l /= dist;
      float dEff = max( dist, 0.08 );
      att = 1.0 / ( dEff * dEff );
      if ( prm.z > 0.0 ) {
        float f = dist / prm.z;
        att *= max( 0.0, 1.0 - f * f * f * f );
      }
      if ( prm.x > 1.5 ) {
        float spotCos = - dot( l, msLightDir[ i ] );
        float cone = clamp( ( spotCos - msLightCone[ i ].y ) / max( 1e-4, msLightCone[ i ].x - msLightCone[ i ].y ), 0.0, 1.0 );
        att *= cone * cone;
      }
    }
    if ( att <= 0.0 ) continue;
    // 明るすぎないよう、緩やかに飽和させる
    float e = prm.y * att * 0.04;
    vec3 lc = msLightColor[ i ] * ( e / ( 1.0 + e * 0.25 ) );
    float nli = max( 0.0, dot( n, l ) );
    diffuse += lc * nli * ( 1.0 - metallic );
    diffuse += lc * max( 0.0, - dot( n, l ) ) * s.dt;
    if ( nli > 0.0 && nv > 0.0 ) {
      vec3 h = l + MS_VIEW;
      float hl = length( h );
      if ( hl > 0.0 ) {
        h /= hl;
        float nh = max( 0.0, dot( n, h ) );
        float vh = max( 0.0, dot( MS_VIEW, h ) );
        spec += lc * ( msGgx( nh, nli, nv, rough ) * nli * 2.4 ) * ( f0 + ( 1.0 - f0 ) * msPow5( 1.0 - vh ) );
      }
    }
  }
  #endif
  vec3 mirror = msMirror( n, nv, rough, s.occ );
  float grazing = msPow5( 1.0 - facing ) * ( 1.0 - rough );
  // シーン (微細な繊維による散乱)
  if ( s.sheen.r > 0.0 || s.sheen.g > 0.0 || s.sheen.b > 0.0 ) {
    float sr = clamp( s.sheenRough, 0.04, 1.0 );
    float gs = pow( max( 0.0, 1.0 - facing ), sr * 3.5 + 0.5 );
    float sl = ( ambient.r + ambient.g + ambient.b ) * 0.3333 + MS_SUN * nl;
    diffuse += s.sheen * sl * gs;
  }
  vec3 outC = s.base * diffuse + spec + mirror * ( f0 + ( 1.0 - f0 ) * grazing );
  // クリアコート
  if ( s.clearcoat > 0.0 ) {
    vec3 cn = s.ccN;
    float ccR = clamp( s.ccRough, 0.04, 1.0 );
    float ccNv = dot( cn, MS_VIEW );
    float ccFacing = abs( ccNv );
    float ccNl = max( 0.0, dot( cn, MS_SUN_DIR ) );
    float ccGlare = 0.0;
    float ccFr = 0.0;
    if ( ccNl > 0.0 && ccNv > 0.0 ) {
      vec3 h = normalize( MS_SUN_DIR + MS_VIEW );
      ccGlare = msGgx( max( 0.0, dot( cn, h ) ), ccNl, ccNv, ccR ) * ccNl * MS_SUN_GLARE;
      ccFr = msPow5( 1.0 - max( 0.0, dot( MS_VIEW, h ) ) );
    }
    vec3 ccMirror = msMirror( cn, ccNv, ccR, s.occ );
    float ccGrazing = msPow5( 1.0 - ccFacing ) * ( 1.0 - ccR );
    float ccSpec = ccGlare * ( 0.04 + 0.96 * ccFr ) * s.clearcoat;
    float ccEnv = ( 0.04 + 0.96 * ccGrazing ) * s.clearcoat;
    outC = outC * ( 1.0 - ccEnv ) + ccSpec + ccMirror * ccEnv;
  }
  return outC;
}
`

// 頂点の色は、陰影を付けた後の色 (画面の色) に掛ける (MarumaSign 本体と同じ)。透明度だけは先に掛ける
const COLOR_FRAGMENT = /* glsl */`
#if defined( USE_COLOR_ALPHA )
  diffuseColor.a *= vColor.a;
#endif
`

const SHADE_FRAGMENT = /* glsl */`
{
  vec3 msBase = diffuseColor.rgb;
  MsSurface s;
  s.metallic = metalnessFactor;
  s.roughness = roughnessFactor;
  s.df0 = material.specularColor;
  #ifdef MS_SPECGLOSS
    vec4 msSg = vec4( 1.0 );
    #ifdef MS_SPECGLOSS_MAP
      msSg = MS_MAP( msSpecularGlossinessMap, msSpecularGlossinessMapTransform, MS_SPECGLOSS_MAP );
    #endif
    s.df0 = min( msF0 * msSg.rgb, vec3( 1.0 ) );
    s.metallic = 0.0;
    s.roughness = 1.0 - msGlossiness * msSg.a;
  #endif
  #ifdef MS_TRANSMISSION
    // 透過は屈折を描かず、半透明にする (完全に透過する材質でも半分は残す)。厚みのある材質は、その色を付ける
    float msTr = msTransmission;
    #ifdef MS_TRANSMISSION_MAP
      msTr *= MS_MAP( msTransmissionMap, msTransmissionMapTransform, MS_TRANSMISSION_MAP ).r;
    #endif
    msTr = clamp( msTr, 0.0, 1.0 );
    diffuseColor.a *= 1.0 - msTr * 0.5;
    if ( msTransmission > 0.0 && msAttenuationDistance > 0.0 ) {
      float msTh = msThickness;
      #ifdef MS_THICKNESS_MAP
        msTh *= MS_MAP( msThicknessMap, msThicknessMapTransform, MS_THICKNESS_MAP ).g;
      #endif
      float msDepth = msTh > 0.0 ? min( 1.0, msTh / msAttenuationDistance ) : 1.0;
      msBase *= pow( clamp( msAttenuationColor, vec3( 1e-4 ), vec3( 1.0 ) ), vec3( msDepth ) );
    }
  #endif
  s.base = msBase;
  s.occ = 1.0;
  #ifdef USE_AOMAP
    s.occ = ( texture2D( aoMap, vAoMapUv ).r - 1.0 ) * aoMapIntensity + 1.0;
  #endif
  s.n = msToModel( normal );
  s.pos = vMsPos;
  s.clearcoat = 0.0;
  s.ccRough = 0.0;
  s.ccN = s.n;
  #ifdef USE_CLEARCOAT
    s.clearcoat = material.clearcoat;
    s.ccRough = clearcoatRoughness;
    #ifdef USE_CLEARCOAT_ROUGHNESSMAP
      s.ccRough *= texture2D( clearcoatRoughnessMap, vClearcoatRoughnessMapUv ).y;
    #endif
    s.ccN = msToModel( clearcoatNormal );
  #endif
  s.sheen = vec3( 0.0 );
  s.sheenRough = 0.0;
  #ifdef USE_SHEEN
    s.sheen = material.sheenColor;
    s.sheenRough = material.sheenRoughness;
  #endif
  s.irid = 0.0;
  s.iridIor = 1.3;
  s.iridThick = 100.0;
  #ifdef USE_IRIDESCENCE
    s.irid = material.iridescence;
    s.iridIor = material.iridescenceIOR;
    s.iridThick = material.iridescenceThickness;
  #endif
  s.aniso = 0.0;
  s.t = vec3( 0.0 );
  s.b = vec3( 0.0 );
  #ifdef USE_ANISOTROPY
    s.aniso = material.anisotropy;
    s.t = msToModel( material.anisotropyT );
    s.b = msToModel( material.anisotropyB );
  #endif
  s.dt = vec3( 0.0 );
  #ifdef MS_DT
    s.dt = msDiffuseTransmissionColor * msDiffuseTransmission;
    #ifdef MS_DT_MAP
      s.dt *= MS_MAP( msDiffuseTransmissionMap, msDiffuseTransmissionMapTransform, MS_DT_MAP ).a;
    #endif
    #ifdef MS_DT_COLOR_MAP
      s.dt *= MS_MAP( msDiffuseTransmissionColorMap, msDiffuseTransmissionColorMapTransform, MS_DT_COLOR_MAP ).rgb;
    #endif
  #endif
  // 発光は陰影に足してから画面の色にする (本体の焼き込みと同じ)。画面の色は 2.2 乗の逆
  vec3 msDisplay = pow( clamp( msShade( s ) + totalEmissiveRadiance, 0.0, 1.0 ), vec3( 1.0 / 2.2 ) );
  #if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
    msDisplay *= vColor.rgb;
  #endif
  // three.js は最後に sRGB にするので、その逆にしておく
  outgoingLight = sRGBTransferEOTF( vec4( msDisplay, 1.0 ) ).rgb;
}
`

const UNLIT_FRAGMENT = /* glsl */`
#if defined( USE_COLOR ) || defined( USE_COLOR_ALPHA )
  outgoingLight = sRGBTransferEOTF( vec4( sRGBTransferOETF( vec4( outgoingLight, 1.0 ) ).rgb * vColor.rgb, 1.0 ) ).rgb;
#endif
`

function inject(source: string, anchor: string, code: string, before: boolean): string {
  if (!source.includes(anchor)) throw new Error('shader anchor not found: ' + anchor)
  return source.replace(anchor, before ? code + '\n' + anchor : anchor + '\n' + code)
}

// ---------------------------------------------------------------- 読み込みのときの材質の準備

/** 材質の、three.js の材質にない値 (読み込みのときに決める) */
interface MaterialShading {
  lit: boolean
  transmission: number
  transmissionMap: Texture | null
  thickness: number
  thicknessMap: Texture | null
  attenuationColor: Color
  attenuationDistance: number
  extra: MaterialExtra | null
}

const shadingOf = new WeakMap<Material, MaterialShading>()

/**
 * 読み込んだモデルの材質を、この描き方に合わせて直す (読み込みのときに 1 度)。
 * @param index glTF の材質の番号 (KHR_animation_pointer の書き換え先を探すのに使う)
 */
export function prepareMaterial(m: Material, index: number | undefined, extra: MaterialExtra | undefined): void {
  if (shadingOf.has(m)) return
  if (index !== undefined) m.userData.msMaterial = index
  const s: MaterialShading = {
    lit: m instanceof MeshStandardMaterial,
    transmission: 0,
    transmissionMap: null,
    thickness: 0,
    thicknessMap: null,
    attenuationColor: new Color(1, 1, 1),
    attenuationDistance: 0,
    extra: extra ?? null,
  }
  if (m instanceof MeshPhysicalMaterial && (m.transmission > 0 || m.transmissionMap)) {
    // 透過は屈折を計算せず、半透明として表示する (MarumaSign 本体と同じ)。three.js の透過の描画 (画面の写し) は使わない
    s.transmission = m.transmission
    s.transmissionMap = m.transmissionMap
    s.thickness = m.thickness
    s.thicknessMap = m.thicknessMap
    s.attenuationColor.copy(m.attenuationColor)
    s.attenuationDistance = Number.isFinite(m.attenuationDistance) ? m.attenuationDistance : 0
    m.transmission = 0
    m.transmissionMap = null
    m.thicknessMap = null
    m.transparent = true
    m.depthWrite = false
  }
  if (m instanceof MeshStandardMaterial) m.envMap = null
  shadingOf.set(m, s)
}

/** 片付けるテクスチャ (材質の持ち物でないもの) */
export function materialTextures(m: Material): Texture[] {
  const s = shadingOf.get(m)
  return s ? [s.transmissionMap, s.thicknessMap].filter((t): t is Texture => !!t) : []
}

// ---------------------------------------------------------------- 看板に置くとき

/** 看板 1 つ分の光源の値 (アニメーションで変わる) */
interface LightState {
  object: Object3D
  index: number
  type: number
  color: Color
  intensity: number
  range: number
  inner: number
  outer: number
}

type Uniform<T> = { value: T }

export interface InstanceBinding {
  /** KHR_animation_pointer の書き換え先などを片付ける */
  dispose(): void
  /** 計算している光源の数 (試験用) */
  readonly lights: number
}

/** 書き換え先 (PropertyBinding が v を読み書きする) */
function makeProxy(name: string, size: number, get: () => number[], set: (v: number[]) => void): Object3D {
  const o = new Object3D()
  o.name = name
  o.visible = false
  if (size === 1) {
    Object.defineProperty(o, 'v', { get: () => get()[0], set: (x: number) => set([x]), enumerable: false })
  }
  else {
    const value = {
      fromArray(array: ArrayLike<number>, offset = 0) {
        const v: number[] = []
        for (let i = 0; i < size; i++) v.push(array[offset + i]!)
        set(v)
        return value
      },
      toArray(array: number[] = [], offset = 0) {
        const v = get()
        for (let i = 0; i < size; i++) array[offset + i] = v[i] ?? 0
        return array
      },
    }
    Object.defineProperty(o, 'v', { value, enumerable: false })
  }
  return o
}

/**
 * 看板に置くモデル (cloneSkinned で写したもの) の材質を写し、陰影の計算と KHR_animation_pointer の書き換え先を用意する。
 * @param placement モデルの座標から、ワールドの座標への変換 (看板の置き方)
 */
export function bindInstance(instance: Object3D, extras: ModelExtras, placement: Matrix4): InstanceBinding {
  const worldToModel = placement.clone().invert()
  const normalToModel = new Matrix3().setFromMatrix4(placement).transpose()
  // 光源
  const lights: LightState[] = []
  instance.traverse((o) => {
    const index = o.userData.msLight
    const def = typeof index === 'number' ? extras.lights[index] : undefined
    if (!def || lights.length >= MAX_MODEL_LIGHTS) return
    lights.push({
      object: o, index, type: def.type, color: new Color(...def.color), intensity: def.intensity, range: def.range,
      inner: def.innerConeAngle, outer: def.outerConeAngle,
    })
  })
  const shared: Record<string, Uniform<unknown>> = {
    msWorldToModel: { value: worldToModel },
    msNormalToModel: { value: normalToModel },
    msIblRotation: { value: new Matrix3() },
    msIblIntensity: { value: 1 },
  }
  if (lights.length > 0) {
    shared.msLightPos = { value: lights.map(() => new Vector3()) }
    shared.msLightDir = { value: lights.map(() => new Vector3(0, 0, -1)) }
    shared.msLightColor = { value: lights.map(() => new Vector3()) }
    shared.msLightParam = { value: lights.map(() => new Vector4()) }
    shared.msLightCone = { value: lights.map(() => new Vector2()) }
  }
  const ibl = extras.ibl
  if (ibl) {
    ;(shared.msIblRotation!.value as Matrix3).setFromMatrix4(new Matrix4().makeRotationFromQuaternion(iblInverseRotation(ibl)))
    shared.msIblIntensity!.value = ibl.intensity
    if (ibl.sh) shared.msSh = { value: Array.from({ length: 9 }, (_, i) => new Vector3(ibl.sh![i * 3], ibl.sh![i * 3 + 1], ibl.sh![i * 3 + 2])) }
  }

  // 材質を写す (glTF の材質の番号ごとに、写したものの一覧)
  const clones = new Map<Material, Material>()
  const states = new Map<Material, Record<string, Uniform<unknown>>>()
  const byIndex = new Map<number, Material[]>()
  const ownTextures = new Set<Texture>()
  const cloneMaterial = (base: Material): Material => {
    let c = clones.get(base)
    if (c) return c
    c = base.clone()
    const shading = shadingOf.get(base)
    const uniforms = setupShading(c, shading, shared, lights.length, extras)
    states.set(c, uniforms)
    clones.set(base, c)
    const index = base.userData.msMaterial
    if (typeof index === 'number') {
      const list = byIndex.get(index) ?? []
      list.push(c)
      byIndex.set(index, list)
    }
    return c
  }
  const meshes: Mesh[] = []
  instance.traverse((o) => {
    const mesh = o as Mesh
    if (!mesh.isMesh || !mesh.material) return
    meshes.push(mesh)
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(cloneMaterial) : cloneMaterial(mesh.material)
  })

  // 光源の位置と向き (モデルの座標) を、描く前に求める
  if (lights.length > 0) {
    const pos = shared.msLightPos!.value as Vector3[], dir = shared.msLightDir!.value as Vector3[]
    const color = shared.msLightColor!.value as Vector3[], param = shared.msLightParam!.value as Vector4[], cone = shared.msLightCone!.value as Vector2[]
    const m = new Matrix4()
    let last = -1
    const update = (renderer: { info: { render: { frame: number } } }): void => {
      const frame = renderer.info.render.frame
      if (frame === last) return
      last = frame
      lights.forEach((l, i) => {
        m.multiplyMatrices(worldToModel, l.object.matrixWorld)
        pos[i]!.setFromMatrixPosition(m)
        const e = m.elements
        dir[i]!.set(-e[8]!, -e[9]!, -e[10]!).normalize()
        color[i]!.set(l.color.r, l.color.g, l.color.b)
        param[i]!.set(l.type, l.intensity, l.range, 0)
        cone[i]!.set(Math.cos(l.inner), Math.cos(l.outer))
      })
    }
    for (const mesh of meshes) mesh.onBeforeRender = update as unknown as Mesh['onBeforeRender']
  }

  // KHR_animation_pointer の書き換え先
  const proxies: Object3D[] = []
  const texClones = new Map<Texture, Texture>()
  for (const spec of extras.pointers) {
    const proxy = pointerProxy(spec, instance, byIndex, states, lights, texClones)
    instance.add(proxy)
    proxies.push(proxy)
  }
  for (const t of texClones.values()) ownTextures.add(t)

  return {
    lights: lights.length,
    dispose() {
      for (const p of proxies) p.removeFromParent()
      for (const c of clones.values()) c.dispose()
      for (const t of ownTextures) t.dispose()
      for (const mesh of meshes) mesh.onBeforeRender = Object3D.prototype.onBeforeRender
    },
  }
}

/** 写した材質を、MarumaSign 本体の式で描くようにする */
function setupShading(m: Material, shading: MaterialShading | undefined, shared: Record<string, Uniform<unknown>>, lights: number, extras: ModelExtras): Record<string, Uniform<unknown>> {
  const uniforms: Record<string, Uniform<unknown>> = { ...shared }
  const defines: Record<string, string | number> = {}
  if (m instanceof MeshBasicMaterial) {
    // 光の当たらない材質 (KHR_materials_unlit) は、頂点の色の掛け方だけを本体に合わせる
    if (!m.vertexColors) return uniforms
    m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', COLOR_FRAGMENT)
      shader.fragmentShader = inject(shader.fragmentShader, '#include <opaque_fragment>', UNLIT_FRAGMENT, true)
    }
    m.customProgramCacheKey = () => 'marumasign-unlit-1'
    return uniforms
  }
  if (!(m instanceof MeshStandardMaterial) || !shading?.lit) return uniforms
  defines.MS_LIGHTS = lights
  const ibl = extras.ibl
  if (ibl?.sh) defines.MS_SH = ''
  if (ibl?.env) {
    defines.MS_ENV = ''
    m.envMap = ibl.env
    m.envMapIntensity = 1
  }
  let uv = false
  const map = (define: string, name: string, texture: Texture | null): void => {
    if (!texture) return
    if (texture.matrixAutoUpdate) texture.updateMatrix()
    uniforms[name] = { value: texture }
    uniforms[name + 'Transform'] = { value: texture.matrix }
    defines[define] = texture.channel === 1 ? 'vMsUv1' : 'vMsUv0'
    uv = true
  }
  if (shading.transmission > 0 || shading.transmissionMap) {
    defines.MS_TRANSMISSION = ''
    uniforms.msTransmission = { value: shading.transmission }
    uniforms.msThickness = { value: shading.thickness }
    uniforms.msAttenuationDistance = { value: shading.attenuationDistance }
    uniforms.msAttenuationColor = { value: shading.attenuationColor.clone() }
    map('MS_TRANSMISSION_MAP', 'msTransmissionMap', shading.transmissionMap)
    map('MS_THICKNESS_MAP', 'msThicknessMap', shading.thicknessMap)
  }
  const dt = shading.extra?.diffuseTransmission
  if (dt) {
    defines.MS_DT = ''
    uniforms.msDiffuseTransmission = { value: dt.factor }
    uniforms.msDiffuseTransmissionColor = { value: new Color(...dt.color) }
    map('MS_DT_MAP', 'msDiffuseTransmissionMap', dt.map)
    map('MS_DT_COLOR_MAP', 'msDiffuseTransmissionColorMap', dt.colorMap)
  }
  const sg = shading.extra?.specularGlossiness
  if (sg) {
    defines.MS_SPECGLOSS = ''
    uniforms.msF0 = { value: new Color(...sg.f0) }
    uniforms.msGlossiness = { value: sg.glossiness }
    map('MS_SPECGLOSS_MAP', 'msSpecularGlossinessMap', sg.map)
  }
  if (uv) defines.MS_UV = ''
  m.defines = { ...(m.defines ?? {}), ...defines }
  m.onBeforeCompile = (shader: WebGLProgramParametersWithUniforms) => {
    Object.assign(shader.uniforms, uniforms)
    shader.vertexShader = inject(shader.vertexShader, '#include <common>', VERTEX_PARS, false)
    shader.vertexShader = inject(shader.vertexShader, '#include <project_vertex>', VERTEX_MAIN, false)
    shader.fragmentShader = inject(shader.fragmentShader, 'void main() {', FRAGMENT_PARS, true)
    shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', COLOR_FRAGMENT)
    shader.fragmentShader = inject(shader.fragmentShader, '#include <opaque_fragment>', SHADE_FRAGMENT, true)
  }
  // シェーダーは defines で決まる (同じものは看板どうしで分け合う)
  m.customProgramCacheKey = () => 'marumasign-shade-1'
  return uniforms
}

// ---------------------------------------------------------------- KHR_animation_pointer の書き換え先

function pointerProxy(
  spec: PointerSpec, instance: Object3D, byIndex: Map<number, Material[]>, states: Map<Material, Record<string, Uniform<unknown>>>,
  lights: LightState[], texClones: Map<Texture, Texture>,
): Object3D {
  const none = (): Object3D => makeProxy(spec.proxy, spec.size, () => new Array<number>(spec.size).fill(0), () => {})
  if (spec.kind === 'light') {
    const targets = lights.filter(l => l.index === spec.index)
    if (targets.length === 0) return none()
    const first = targets[0]!
    const get: Record<string, () => number[]> = {
      'color': () => [first.color.r, first.color.g, first.color.b],
      'intensity': () => [first.intensity],
      'range': () => [first.range],
      'spot/innerConeAngle': () => [first.inner],
      'spot/outerConeAngle': () => [first.outer],
    }
    const set: Record<string, (l: LightState, v: number[]) => void> = {
      'color': (l, v) => l.color.setRGB(v[0]!, v[1]!, v[2]!),
      'intensity': (l, v) => { l.intensity = v[0]! },
      'range': (l, v) => { l.range = v[0]! },
      'spot/innerConeAngle': (l, v) => { l.inner = v[0]! },
      'spot/outerConeAngle': (l, v) => { l.outer = v[0]! },
    }
    if (!get[spec.path]) return none()
    return makeProxy(spec.proxy, spec.size, get[spec.path]!, v => targets.forEach(l => set[spec.path]!(l, v)))
  }
  if (spec.kind === 'camera') {
    const cameras: Camera[] = []
    instance.traverse(o => o.userData.msCamera === spec.index && (o as Camera).isCamera && cameras.push(o as Camera))
    if (cameras.length === 0) return none()
    const persp = cameras[0] as PerspectiveCamera, ortho = cameras[0] as OrthographicCamera
    const rw: Record<string, [() => number, (c: PerspectiveCamera & OrthographicCamera, x: number) => void]> = {
      'perspective/yfov': [() => persp.fov * Math.PI / 180, (c, x) => { c.fov = x * 180 / Math.PI }],
      'perspective/aspectRatio': [() => persp.aspect, (c, x) => { c.aspect = x }],
      'perspective/znear': [() => persp.near, (c, x) => { c.near = x }],
      'perspective/zfar': [() => persp.far, (c, x) => { c.far = x }],
      'orthographic/xmag': [() => ortho.right, (c, x) => { c.left = -x; c.right = x }],
      'orthographic/ymag': [() => ortho.top, (c, x) => { c.bottom = -x; c.top = x }],
      'orthographic/znear': [() => ortho.near, (c, x) => { c.near = x }],
      'orthographic/zfar': [() => ortho.far, (c, x) => { c.far = x }],
    }
    const f = rw[spec.path]
    if (!f) return none()
    return makeProxy(spec.proxy, 1, () => [f[0]()], v => cameras.forEach((c) => {
      f[1](c as PerspectiveCamera & OrthographicCamera, v[0]!)
      ;(c as PerspectiveCamera).updateProjectionMatrix()
    }))
  }
  // 材質
  const mats = byIndex.get(spec.index) ?? []
  if (mats.length === 0 || materialPointerSize(spec.path) !== spec.size) return none()
  const tt = /^(.+Texture)\/extensions\/KHR_texture_transform\/(offset|scale|rotation)$/.exec(spec.path)
  if (tt) return textureTransformProxy(spec, mats, states, TEXTURE_SLOTS[tt[1]!] ?? [], tt[2]!, texClones)
  const prop = MATERIAL_PROPS[spec.path]
  if (!prop) return none()
  const first = mats[0]! as unknown as Record<string, unknown>
  const u0 = states.get(mats[0]!) ?? {}
  return makeProxy(spec.proxy, spec.size, () => prop.get(first, u0), v => mats.forEach(m => prop.set(m as unknown as Record<string, unknown>, states.get(m) ?? {}, v)))
}

type Props = Record<string, unknown>
type UniformSet = Record<string, Uniform<unknown>>
interface PropAccess {
  get(m: Props, u: UniformSet): number[]
  set(m: Props, u: UniformSet, v: number[]): void
}

const color = (name: string): PropAccess => ({
  get: m => (m[name] instanceof Color ? (m[name] as Color).toArray() : [0, 0, 0]),
  set: (m, _u, v) => { if (m[name] instanceof Color) (m[name] as Color).setRGB(v[0]!, v[1]!, v[2]!) },
})
const scalar = (name: string): PropAccess => ({
  get: m => [typeof m[name] === 'number' ? m[name] as number : 0],
  set: (m, _u, v) => { if (typeof m[name] === 'number') m[name] = v[0]! },
})
const uniformScalar = (name: string, map?: (x: number) => number): PropAccess => ({
  get: (_m, u) => [typeof u[name]?.value === 'number' ? u[name]!.value as number : 0],
  set: (_m, u, v) => { if (u[name]) u[name]!.value = map ? map(v[0]!) : v[0]! },
})
const uniformColor = (name: string): PropAccess => ({
  get: (_m, u) => (u[name]?.value instanceof Color ? (u[name]!.value as Color).toArray() : [0, 0, 0]),
  set: (_m, u, v) => { if (u[name]?.value instanceof Color) (u[name]!.value as Color).setRGB(v[0]!, v[1]!, v[2]!) },
})
const scale2 = (name: string): PropAccess => ({
  get: m => [(m[name] as Vector2 | undefined)?.x ?? 1],
  set: (m, _u, v) => {
    const s = m[name] as Vector2 | undefined
    if (!s) return
    // 接線のないモデルでは y の向きが逆 (GLTFLoader)
    const flip = s.y * s.x < 0 ? -1 : 1
    s.set(v[0]!, v[0]! * flip)
  },
})
const range = (index: number): PropAccess => ({
  get: m => [(m.iridescenceThicknessRange as number[] | undefined)?.[index] ?? 0],
  set: (m, _u, v) => { const r = m.iridescenceThicknessRange as number[] | undefined; if (r) r[index] = v[0]! },
})

const MATERIAL_PROPS: Record<string, PropAccess> = {
  'pbrMetallicRoughness/baseColorFactor': {
    get: m => [...(m.color as Color).toArray(), m.opacity as number],
    set: (m, _u, v) => {
      ;(m.color as Color).setRGB(v[0]!, v[1]!, v[2]!)
      m.opacity = v[3]!
    },
  },
  'pbrMetallicRoughness/metallicFactor': scalar('metalness'),
  'pbrMetallicRoughness/roughnessFactor': scalar('roughness'),
  'alphaCutoff': {
    get: m => [m.alphaTest as number],
    // MASK でない材質 (alphaTest が 0) は、切り抜く材質にしない
    set: (m, _u, v) => { if ((m.alphaTest as number) > 0) m.alphaTest = Math.max(1e-4, v[0]!) },
  },
  'emissiveFactor': color('emissive'),
  'normalTexture/scale': scale2('normalScale'),
  'occlusionTexture/strength': scalar('aoMapIntensity'),
  'extensions/KHR_materials_emissive_strength/emissiveStrength': scalar('emissiveIntensity'),
  'extensions/KHR_materials_ior/ior': scalar('ior'),
  'extensions/KHR_materials_transmission/transmissionFactor': uniformScalar('msTransmission'),
  'extensions/KHR_materials_volume/thicknessFactor': uniformScalar('msThickness'),
  'extensions/KHR_materials_volume/attenuationDistance': uniformScalar('msAttenuationDistance', x => (Number.isFinite(x) && x > 0 ? x : 0)),
  'extensions/KHR_materials_volume/attenuationColor': uniformColor('msAttenuationColor'),
  'extensions/KHR_materials_clearcoat/clearcoatFactor': scalar('clearcoat'),
  'extensions/KHR_materials_clearcoat/clearcoatRoughnessFactor': scalar('clearcoatRoughness'),
  'extensions/KHR_materials_clearcoat/clearcoatNormalTexture/scale': scale2('clearcoatNormalScale'),
  'extensions/KHR_materials_sheen/sheenColorFactor': color('sheenColor'),
  'extensions/KHR_materials_sheen/sheenRoughnessFactor': scalar('sheenRoughness'),
  'extensions/KHR_materials_specular/specularFactor': scalar('specularIntensity'),
  'extensions/KHR_materials_specular/specularColorFactor': color('specularColor'),
  'extensions/KHR_materials_iridescence/iridescenceFactor': scalar('iridescence'),
  'extensions/KHR_materials_iridescence/iridescenceIor': scalar('iridescenceIOR'),
  'extensions/KHR_materials_iridescence/iridescenceThicknessMinimum': range(0),
  'extensions/KHR_materials_iridescence/iridescenceThicknessMaximum': range(1),
  'extensions/KHR_materials_anisotropy/anisotropyStrength': scalar('anisotropy'),
  'extensions/KHR_materials_anisotropy/anisotropyRotation': scalar('anisotropyRotation'),
  'extensions/KHR_materials_dispersion/dispersion': scalar('dispersion'),
  'extensions/KHR_materials_diffuse_transmission/diffuseTransmissionFactor': uniformScalar('msDiffuseTransmission'),
  'extensions/KHR_materials_diffuse_transmission/diffuseTransmissionColorFactor': uniformColor('msDiffuseTransmissionColor'),
}

/** テクスチャの貼り方。看板ごとにテクスチャを写して (画像は分け合う)、glTF の順 (T * R * S) の行列にする */
function textureTransformProxy(
  spec: PointerSpec, mats: Material[], states: Map<Material, UniformSet>, slots: string[], what: string, texClones: Map<Texture, Texture>,
): Object3D {
  const textures: Texture[] = []
  for (const m of mats) {
    const props = m as unknown as Record<string, Texture | null>
    const u = states.get(m) ?? {}
    for (const slot of slots) {
      const custom = slot.startsWith('ms')
      const t = custom ? (u[slot]?.value as Texture | undefined) : props[slot]
      if (!t || !(t as Texture).isTexture) continue
      let c = texClones.get(t)
      if (!c) {
        c = t.clone()
        texClones.set(t, c)
        // 写す前の行列 (KHR_texture_transform の回転) も引き継ぐ
        c.matrix.copy(t.matrix)
        c.matrixAutoUpdate = false
      }
      if (custom) {
        u[slot]!.value = c
        if (u[slot + 'Transform']) u[slot + 'Transform']!.value = c.matrix
      }
      else {
        props[slot] = c
      }
      if (!textures.includes(c)) textures.push(c)
    }
  }
  if (textures.length === 0) return makeProxy(spec.proxy, spec.size, () => new Array<number>(spec.size).fill(0), () => {})
  const first = textures[0]!
  const apply = (t: Texture): void => {
    const c = Math.cos(t.rotation), s = Math.sin(t.rotation)
    t.matrix.set(t.repeat.x * c, t.repeat.y * s, t.offset.x, -t.repeat.x * s, t.repeat.y * c, t.offset.y, 0, 0, 1)
    t.matrixAutoUpdate = false
  }
  textures.forEach(apply)
  const get = (): number[] => what === 'offset' ? first.offset.toArray() : what === 'scale' ? first.repeat.toArray() : [first.rotation]
  const set = (v: number[]): void => {
    for (const t of textures) {
      if (what === 'offset') t.offset.set(v[0]!, v[1]!)
      else if (what === 'scale') t.repeat.set(v[0]!, v[1]!)
      else t.rotation = v[0]!
      apply(t)
    }
  }
  return makeProxy(spec.proxy, spec.size, get, set)
}

