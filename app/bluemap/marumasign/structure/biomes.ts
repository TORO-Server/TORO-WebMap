// バイオームごとの草・葉・水の色 (MarumaSign 本体の BiomeColors と同じ。Minecraft の Biome と GrassColor / FoliageColor の計算)。
// 構造物のファイルにバイオームが書かれていればそのバイオーム、なければ平原 (本体と同じ。看板のある場所のバイオームは使わない)
// 色は 0xRRGGBB。ここは Node の試験でも使う
import type { GameAssets, Sprite } from './assets.ts'

export const DEFAULT_BIOME = 'minecraft:plains'
export const DEFAULT_WATER = 0x3F76E4

export interface BiomeColorSet {
  grass: number
  foliage: number
  dryFoliage: number
  water: number
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v))
}

export class BiomeColors {
  private readonly assets: GameAssets
  private readonly grassMap: Sprite
  private readonly foliageMap: Sprite
  private readonly dryFoliageMap: Sprite
  private readonly cache = new Map<string, BiomeColorSet>()

  constructor(assets: GameAssets) {
    this.assets = assets
    this.grassMap = assets.sprite('minecraft:colormap/grass')
    this.foliageMap = assets.sprite('minecraft:colormap/foliage')
    this.dryFoliageMap = assets.sprite('minecraft:colormap/dry_foliage')
  }

  private static lookup(map: Sprite, temperature: number, downfall: number, fallback: number): number {
    if (map.missing || map.width !== 256 || map.height !== 256) return fallback
    downfall *= temperature
    const x = Math.trunc((1 - temperature) * 255), y = Math.trunc((1 - downfall) * 255)
    const index = y << 8 | x
    if (index < 0 || index >= 65536) return fallback
    const p = map.frames[0]!
    return p[index * 4]! << 16 | p[index * 4 + 1]! << 8 | p[index * 4 + 2]!
  }

  /** 温度と雨の量から草の色 (GrassColor.get) */
  grassAt(temperature: number, downfall: number): number {
    return BiomeColors.lookup(this.grassMap, clamp01(temperature), clamp01(downfall), 0xFF00FF)
  }

  colors(biome: string | null): BiomeColorSet {
    const key = biome ?? DEFAULT_BIOME
    let c = this.cache.get(key)
    if (!c) {
      const loaded = this.load(key)
      if (!loaded) {
        // 知らないバイオームは覚えない (名前は構造物のファイルの中身で決まる)
        if (key !== DEFAULT_BIOME) return this.colors(DEFAULT_BIOME)
        c = { grass: 0x91BD59, foliage: 0x77AB2F, dryFoliage: 0x8D6B4B, water: DEFAULT_WATER }
      }
      else c = loaded
      this.cache.set(key, c)
    }
    return c
  }

  private load(biome: string): BiomeColorSet | null {
    const b = Object.prototype.hasOwnProperty.call(this.assets.bundle.biomes, biome) ? this.assets.bundle.biomes[biome] : undefined
    if (!b) return null
    const t = clamp01(b[0]), d = clamp01(b[1])
    let grass = b[2] ?? BiomeColors.lookup(this.grassMap, t, d, 0xFF00FF)
    if (b[6] === 'dark_forest') grass = ((grass & 0xFEFEFE) + 0x28340A) >> 1
    // 沼の草の色は場所ごとの雑音で 2 色に分かれる。多い方の色にする
    else if (b[6] === 'swamp') grass = 0x6A7039
    const foliage = b[3] ?? BiomeColors.lookup(this.foliageMap, t, d, 0x48B518)
    const dryFoliage = b[4] ?? BiomeColors.lookup(this.dryFoliageMap, t, d, 0x8D6B4B)
    const water = b[5] ?? DEFAULT_WATER
    return { grass, foliage, dryFoliage, water }
  }
}
