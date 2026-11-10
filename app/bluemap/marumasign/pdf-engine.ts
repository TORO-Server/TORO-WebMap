// PDF を読んでページを画像にする部分 (pdf.js)。PDF の看板が来たときに初めて読み込む
// pdf.js の Worker、文字の対応表 (cmaps)、標準のフォント、wasm は、ビルドに入れて同じサイト (/_nuxt/) から返す
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import openjpegFallbackUrl from 'pdfjs-dist/wasm/openjpeg_nowasm_fallback.js?url'

GlobalWorkerOptions.workerSrc = workerUrl

// ビルドではそれぞれ別のファイルになり、ここには URL だけが入る (読むのは必要になったものだけ)。小さなものも data: の URL にしない (CSP の connect-src が data: を許さない)
const CMAPS = import.meta.glob('../../../node_modules/pdfjs-dist/cmaps/*.bcmap', { query: '?url&no-inline', import: 'default', eager: true, exhaustive: true }) as Record<string, string>
const FONTS = import.meta.glob('../../../node_modules/pdfjs-dist/standard_fonts/*.{pfb,ttf}', { query: '?url&no-inline', import: 'default', eager: true, exhaustive: true }) as Record<string, string>
// JPEG 2000 と JBIG2 の画像を読むもの (quickjs は PDF の中のスクリプト用、qcms は useWorkerFetch のときだけ使うので入れない)
const WASM = import.meta.glob('../../../node_modules/pdfjs-dist/wasm/{openjpeg,jbig2}.wasm', { query: '?url&no-inline', import: 'default', eager: true, exhaustive: true }) as Record<string, string>

function byName(table: Record<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [path, url] of Object.entries(table)) m.set(path.substring(path.lastIndexOf('/') + 1), url)
  return m
}

const tables: Record<string, Map<string, string>> = {
  cMapUrl: byName(CMAPS),
  standardFontDataUrl: byName(FONTS),
  wasmUrl: byName(WASM),
}

/**
 * pdf.js が文字の対応表などを読むときに使う (pdf.js の BinaryDataFactory と同じ形)。
 * 決まった名前のものだけを、ビルドに入れたファイルから読む
 */
class BuiltInDataFactory {
  async fetch({ kind, filename }: { kind: string, filename: string }): Promise<Uint8Array> {
    const url = tables[kind]?.get(filename)
    if (!url) throw new Error('unknown pdf.js data: ' + kind + ' ' + filename)
    const res = await fetch(url, { credentials: 'same-origin' })
    if (!res.ok) throw new Error('HTTP ' + res.status)
    return new Uint8Array(await res.arrayBuffer())
  }
}

/**
 * pdf.js は wasm を読めないブラウザー (relaxed SIMD のない Safari など) で、OpenJPEG の wasm を使わない版を
 * `${wasmUrl}openjpeg_nowasm_fallback.js` として Worker から import する。wasm そのものは BuiltInDataFactory で渡すので、
 * wasmUrl はこの import のためだけに使う。ビルドしたファイルの名前には hash が付くので、そのファイルの URL の後ろに
 * 「?/」を付けたものにする (後ろに付く名前は検索の文字列になり、同じファイルが返る。pdf.js は最後が / であることを求める)。
 * JBIG2 の wasm を使わない版は入れていない (JBIG2 の wasm は relaxed SIMD を使わない)
 */
const WASM_FALLBACK_URL = openjpegFallbackUrl + '?/'

/** 開いた PDF と、それを閉じるもの */
export interface OpenedPdf {
  doc: PDFDocumentProxy
  destroy(): Promise<void>
}

/** PDF を開く (中身はもう読んで、大きさを確かめたもの) */
export async function openPdf(data: Uint8Array): Promise<OpenedPdf> {
  const task = getDocument({
    data,
    BinaryDataFactory: BuiltInDataFactory,
    useWorkerFetch: false,
    wasmUrl: WASM_FALLBACK_URL,
    enableXfa: false,
    stopAtErrors: false,
    // 大きすぎる画像は描かない (ピクセル数)
    maxImageSize: 4096 * 4096,
    isEvalSupported: false,
  } as Parameters<typeof getDocument>[0])
  return { doc: await task.promise, destroy: () => task.destroy() }
}

/**
 * ページを、長い辺が size ピクセルの canvas に描く (白い紙の上に。MarumaSign 本体の PdfFile.render と同じ)
 * @param index 0 から始まるページ番号
 */
export async function renderPage(doc: PDFDocumentProxy, index: number, size: number): Promise<HTMLCanvasElement> {
  const page = await doc.getPage(index + 1)
  try {
    const base = page.getViewport({ scale: 1 })
    const longest = Math.max(base.width, base.height)
    const scale = longest > 0 ? size / longest : 1
    const viewport = page.getViewport({ scale })
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(viewport.width))
    canvas.height = Math.max(1, Math.round(viewport.height))
    await page.render({ canvas, viewport, background: 'rgb(255,255,255)' }).promise
    return canvas
  }
  finally {
    page.cleanup()
  }
}
