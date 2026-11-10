// 構造物を、Minecraft の jar のブロックのモデルとテクスチャで四角形にする (MarumaSign 本体の StructureLoader と同じ流れ)。
// 状態をそろえる (fixer.ts) → 四角形にする (structure-mesher.ts。多すぎれば粗くしてやり直す) → テクスチャをまとめる (atlas.ts)。
// テクスチャやスキンは、1 度作ってみて要るものが分かったら読み、作り直す (assets.ts)
// ここは Node の試験でも使う
import { Atlas, type AtlasPage, type AtlasPart } from './atlas.ts'
import type { GameAssets } from './assets.ts'
import { BiomeColors } from './biomes.ts'
import type { BlockData } from './block-data.ts'
import { BlockModels } from './block-models.ts'
import type { EntityModels } from './entity-models.ts'
import { fixStructure } from './fixer.ts'
import type { BlockTables, Structure } from './formats.ts'
import type { NestedPlacement } from './nested.ts'
import { SpecialModels, type SpecialCounts } from './special.ts'
import { MAX_QUADS, StructureMesher } from './structure-mesher.ts'

export interface VanillaContext {
  assets: GameAssets
  data: BlockData
  entityModels: EntityModels
  /** 統合版の植木鉢の中身を直すのに使う (なくてもよい) */
  tables: BlockTables | null
}

export interface VanillaResult {
  pages: AtlasPage[]
  parts: AtlasPart[]
  quads: number
  /** 描いたものを囲む直方体 (構造物の座標) */
  box: number[]
  /** まとめた結果の 1 ます目の大きさ (ブロック) */
  step: number
  nested: NestedPlacement[]
  counts: SpecialCounts
  /** モデルやテクスチャが見つからなかったもの (確かめる用) */
  missing: string[]
}

/** 要るものを読んで作り直す回数の上限 */
const MAX_PASSES = 5

export async function meshVanilla(input: Structure, ctx: VanillaContext): Promise<VanillaResult> {
  let structure = input
  fixStructure(structure, ctx.data, ctx.tables)
  for (;;) {
    let mesher: StructureMesher | null = null
    let special: SpecialModels | null = null
    let models: BlockModels | null = null
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      // テクスチャの透明度などは読み込んだあとで変わるので、モデルは回ごとに作り直す (JSON を読むだけなので軽い)
      models = new BlockModels(ctx.assets, ctx.data)
      const biomes = new BiomeColors(ctx.assets)
      special = new SpecialModels(models, ctx.entityModels, biomes)
      mesher = new StructureMesher(structure, ctx.data, models, biomes, special)
      mesher.build()
      const o = mesher.output
      // 多すぎれば、テクスチャを読む前に粗くする
      if (o.overflow || o.quadCount > MAX_QUADS) break
      if (!ctx.assets.hasNeeds && !o.pending) break
      if (!ctx.assets.hasNeeds) break
      await ctx.assets.fulfill()
    }
    const output = mesher!.output
    if ((output.quadCount > MAX_QUADS || output.overflow) && structure.sizeX * structure.sizeY * structure.sizeZ > 1) {
      structure = structure.halve()
      continue
    }
    if (output.quadCount === 0) throw new Error('Structure has no visible blocks')
    const box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]
    for (let layer = 0; layer < 3; layer++) {
      const p = output.positions[layer]!
      for (let i = 0; i < p.n; i += 3) {
        const x = p.a[i]!, y = p.a[i + 1]!, z = p.a[i + 2]!
        if (x < box[0]!) box[0] = x
        if (y < box[1]!) box[1] = y
        if (z < box[2]!) box[2] = z
        if (x > box[3]!) box[3] = x
        if (y > box[4]!) box[4] = y
        if (z > box[5]!) box[5] = z
      }
    }
    const atlas = new Atlas(output.sprites)
    const parts = atlas.build(output)
    const missing = [...models!.missing, ...ctx.assets.missingNames].slice(0, 64)
    return {
      pages: atlas.pages, parts, quads: output.quadCount, box, step: structure.step,
      nested: special!.nested.placements.slice(), counts: { ...special!.counts }, missing,
    }
  }
}
