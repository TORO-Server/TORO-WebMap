import createDOMPurify from 'dompurify'
import type { Config, WindowLike } from 'dompurify'

// マーカーの説明などに入る HTML から、スクリプトになるものを取り除く
// マーカーは文字の色や枠のために style を使う (MarumaSign のリンク切れの一覧など) ので、style の属性は残す
const CONFIG: Config = {
  USE_PROFILES: { html: true },
  // 地図の上にログイン画面などを偽装させないよう、入力の部品も入れない
  FORBID_TAGS: ['style', 'form', 'input', 'button', 'select', 'textarea'],
}

type Sanitizer = (html: string | null | undefined) => string

/** テストでは jsdom の window を渡す */
export function createSanitizer(win: WindowLike): Sanitizer {
  const purify = createDOMPurify(win)
  return (html) => {
    // 取り除けないブラウザでは、そのまま通さずに何も出さない
    if (!html || !purify.isSupported) return ''
    return purify.sanitize(html, CONFIG)
  }
}

let browser: Sanitizer | undefined

export function sanitizeHtml(html: string | null | undefined): string {
  browser ??= createSanitizer(window)
  return browser(html)
}
