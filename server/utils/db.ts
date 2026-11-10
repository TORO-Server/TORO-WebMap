import mysql from 'mysql2/promise'
import type { Pool, RowDataPacket } from 'mysql2/promise'

const pools = new Map<string, Pool>()
// 接続を待つ数の上限 (いっぱいなら待たせずに失敗にする。toro-edge は古いものを返す)。toro-edge が同時に聞く数 (256 + 256) より多く
const QUEUE_LIMIT = 1024
// 1 つの問い合わせの時間 (toro-edge が返事を待つ長さと同じ)
const QUERY_TIMEOUT_MILLIS = 30_000

/** DB ごとの接続プール。TiDB は 1 台なので、地図の配信には 16 本あれば足りる */
function pool(database: string): Pool {
  let p = pools.get(database)
  if (!p) {
    const { db } = useRuntimeConfig()
    p = mysql.createPool({
      host: db.host,
      port: Number(db.port),
      user: db.user,
      password: db.password,
      database,
      connectionLimit: 16,
      queueLimit: QUEUE_LIMIT,
      enableKeepAlive: true,
    })
    pools.set(database, p)
  }
  return p
}

/** 1 行だけ読む。無ければ undefined */
export async function queryOne<T extends RowDataPacket>(database: string, sql: string, params: unknown[]): Promise<T | undefined> {
  const rows = await queryAll<T>(database, sql, params)
  return rows[0]
}

export async function queryAll<T extends RowDataPacket>(database: string, sql: string, params: unknown[]): Promise<T[]> {
  const [rows] = await pool(database).query<T[]>({ sql, values: params, timeout: QUERY_TIMEOUT_MILLIS })
  return rows
}
