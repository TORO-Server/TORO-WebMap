// JSON の値を取り出す小さな関数 (MarumaSign 本体の Json と同じ。形が違えば既定の値)
// ここは何も import しない

export type JsonObject = Record<string, unknown>

export function obj(v: unknown): JsonObject {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as JsonObject : {}
}

export function field(o: JsonObject, key: string): unknown {
  // 自分のものだけ (__proto__ などを引かない)
  return Object.prototype.hasOwnProperty.call(o, key) ? o[key] : undefined
}

export function child(o: JsonObject, key: string): JsonObject {
  return obj(field(o, key))
}

export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

export function list(o: JsonObject, key: string): unknown[] {
  return arr(field(o, key))
}

export function str(o: JsonObject, key: string, def: string): string
export function str(o: JsonObject, key: string, def: null): string | null
export function str(o: JsonObject, key: string, def: string | null): string | null {
  const v = field(o, key)
  return typeof v === 'string' ? v : def
}

export function num(o: JsonObject, key: string, def: number): number {
  const v = field(o, key)
  return typeof v === 'number' && Number.isFinite(v) ? v : def
}

export function int(o: JsonObject, key: string, def: number): number {
  const v = field(o, key)
  return typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : def
}

export function bool(o: JsonObject, key: string, def: boolean): boolean {
  const v = field(o, key)
  return typeof v === 'boolean' ? v : def
}

/** 数の配列。配列でなければ def */
export function numbers(v: unknown, def: number[]): number[] {
  if (!Array.isArray(v)) return def
  return v.map(x => typeof x === 'number' && Number.isFinite(x) ? x : 0)
}

export function numbersOf(o: JsonObject, key: string, def: number[]): number[] {
  return numbers(field(o, key), def)
}
