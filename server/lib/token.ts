import { createHash, timingSafeEqual } from 'node:crypto'

/**
 * 合言葉を比べる。どちらも SHA-256 にしてから比べるので、長さが違っても (マルチバイトの文字でも) 例外にならず、時間で中身が漏れない。
 * 決めた合言葉が空なら、どんな値でも通さない
 */
export function tokenMatches(given: string | null | undefined, expected: string | null | undefined): boolean {
  if (!expected) return false
  const a = createHash('sha256').update(given ?? '').digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}
