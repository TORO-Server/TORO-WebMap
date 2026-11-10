import type { RowDataPacket } from 'mysql2/promise'

interface ContentRow extends RowDataPacket { Content: string | Buffer }

/** Dynmap の JsonFileClientUpdateComponent が DB (StandaloneFiles) に書き出したファイル */
export async function dynmapStandaloneFile(name: string): Promise<string | undefined> {
  const { dynmap } = useRuntimeConfig()
  const row = await queryOne<ContentRow>(dynmap.database,
    `SELECT Content FROM ${dynmap.prefix}StandaloneFiles WHERE FileName = ? AND ServerID = 0`, [name])
  return row ? row.Content.toString() : undefined
}
