/** URL のパスをデコードする。壊れたエンコードなら null (500 にしない) */
export function decodePathParam(value: string): string | null {
  try {
    return decodeURIComponent(value)
  }
  catch {
    return null
  }
}
