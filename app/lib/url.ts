// URL の ?worldname=...&mapname=...&x=...&zoom=... (Dynmap の「リンク」と同じ形)

/** マーカーのリンクとして開いてよいか (http(s) と、同じサイトの相対パスだけ。javascript: などは開かない) */
export function isOpenableLink(link: string, base: string): boolean {
  try {
    const protocol = new URL(link, base).protocol
    return protocol === 'https:' || protocol === 'http:'
  }
  catch {
    return false
  }
}

/** 基点 (末尾の / なし) とパスをつなぐ。パスの先頭の / は取り除く (api.ts の apiUrl と tileUrl が使う) */
export function joinBase(base: string, path: string): string {
  return `${base}/${path.replace(/^\/+/, '')}`
}

export function param(name: string): string {
  return new URLSearchParams(window.location.search).get(name) ?? ''
}

export function intParam(name: string): number | null {
  const v = param(name)
  if (v === '') return null
  const n = Number.parseInt(v, 10)
  return Number.isNaN(n) ? null : n
}

export function boolParam(name: string): boolean | null {
  const v = param(name)
  return v === 'true' ? true : v === 'false' ? false : null
}
