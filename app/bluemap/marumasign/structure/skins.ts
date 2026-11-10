// プレイヤーの頭のスキン (MarumaSign 本体の PlayerSkins)。ブロックエンティティに書かれたプロフィールの textures から、
// Mojang のスキンのサーバー (https://textures.minecraft.net/texture/...) の画像だけを読む。
// 名前や UUID しか書かれていないものは、このサーバー (/mcassets/skin) に textures の URL を聞く (サーバーが Mojang に問い合わせる)。
// 分からなければゲームの既定のスキン (Steve。本体と同じ)
// ここは Node の試験でも使う
import { type GameAssets, PENDING, type Sprite } from './assets.ts'
import { type Compound, compound, ints, list, str, type Tag } from './nbt.ts'

/** 1 つの構造物で読むスキンの数の上限 (本体と同じ。サーバーに聞くものも数える) */
export const MAX_SKIN_LOOKUPS = 16
const STEVE = 'minecraft:entity/player/wide/steve'
const NAME = /^[A-Za-z0-9_]{1,16}$/

/** textures の値 (base64 の JSON) から、スキンの URL (textures.minecraft.net の https) を取り出す。なければ空 */
export function skinUrl(textures: string): string {
  if (!textures || textures.length > 16384) return ''
  try {
    const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(textures.replace(/\s+/g, '')), c => c.charCodeAt(0)))) as Record<string, unknown>
    const t = json && typeof json === 'object' ? json.textures as Record<string, unknown> : null
    const skin = t && typeof t === 'object' ? t.SKIN as Record<string, unknown> : null
    const url = skin && typeof skin.url === 'string' ? skin.url : ''
    return checkSkinUrl(url)
  }
  catch {
    return ''
  }
}

/** Mojang のスキンのサーバーの、テクスチャの hash だけの URL なら https にしたもの (ほかは空) */
export function checkSkinUrl(url: string): string {
  const m = /^https?:\/\/textures\.minecraft\.net\/texture\/([0-9a-f]{1,128})$/.exec(url)
  return m ? 'https://textures.minecraft.net/texture/' + m[1] : ''
}

/** UUID (int 4 つか、区切りありなしの文字列) を 32 桁の小文字に。なければ空 */
function uuidOf(v: Tag | undefined): string {
  if (typeof v === 'string') {
    const s = v.trim().toLowerCase().replace(/-/g, '')
    return /^[0-9a-f]{32}$/.test(s) ? s : ''
  }
  const parts = ints(v)
  if (!parts || parts.length !== 4) return ''
  return parts.map(p => (p >>> 0).toString(16).padStart(8, '0')).join('')
}

/** プロフィールから分かること: スキンの URL、なければサーバーに聞くときの問い合わせ (name=... か uuid=...) */
export interface ProfileSkin {
  url: string
  query: string
}

/** ブロックエンティティ (やアイテムの profile) の、スキンの URL か問い合わせ */
export function profileSkinInfo(entity: Compound): ProfileSkin {
  let value: Tag | undefined = entity.has('profile') ? entity.get('profile') : entity.get('SkullOwner')
  if (value === undefined && entity.get('Owner') instanceof Map) value = entity.get('Owner')
  let textures = '', id = '', name = ''
  if (typeof value === 'string') name = value
  else if (value instanceof Map) {
    name = str(value.get('name'), str(value.get('Name')))
    id = uuidOf(value.has('id') ? value.get('id') : value.get('Id'))
    // 1.20.5 から: properties: [{name: "textures", value: "..."}]
    for (const item of list(value.get('properties'))) {
      const p = compound(item)
      if (str(p.get('name')) === 'textures') textures = str(p.get('value'))
    }
    // それより前: Properties: {textures: [{Value: "..."}]}
    for (const item of list(compound(value.get('Properties')).get('textures'))) {
      const t = str(compound(item).get('Value'))
      if (t) textures = t
    }
  }
  const url = skinUrl(textures)
  if (url) return { url, query: '' }
  // 本体と同じく、UUID があればそれ、なければ名前で聞く
  if (id) return { url: '', query: 'uuid=' + id }
  if (NAME.test(name)) return { url: '', query: 'name=' + name }
  return { url: '', query: '' }
}

/** ブロックエンティティ (やアイテムの profile) の、書かれたスキンの URL。なければ空 */
export function profileSkin(entity: Compound): string {
  return profileSkinInfo(entity).url
}

export class PlayerSkins {
  private readonly assets: GameAssets
  private readonly used = new Set<string>()

  constructor(assets: GameAssets) {
    this.assets = assets
  }

  private budget(key: string): boolean {
    if (this.used.has(key)) return true
    if (this.used.size >= MAX_SKIN_LOOKUPS) return false
    this.used.add(key)
    return true
  }

  skin(entity: Compound): Sprite {
    const info = profileSkinInfo(entity)
    let url = info.url
    if (!url && info.query) {
      if (!this.budget(info.query)) return this.assets.sprite(STEVE)
      const r = this.assets.profileLookup(info.query)
      if (r === undefined) return PENDING // まだ聞いていない (仮のもの。次の回で描き直す)
      url = r?.url ? checkSkinUrl(r.url) : ''
    }
    if (!url || !this.budget(url)) return this.assets.sprite(STEVE)
    const s = this.assets.skin(url)
    if (s === undefined) return PENDING
    return s ?? this.assets.sprite(STEVE)
  }
}
