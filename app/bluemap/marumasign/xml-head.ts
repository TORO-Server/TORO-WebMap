/*
 * XML や HTML の先頭の前置き (空白、<?xml ...>、コメント、DOCTYPE) を飛ばす。ブラウザーとサーバーの両方で使う。何も import しない。
 * 外から来た本文に使うので、正規表現で書かない (コメントが続くものは、後戻りの数がコメントの数の指数で増える)。前から 1 度だけ読む
 */

const SPACE = /\s*/y

function skipSpace(text: string, at: number): number {
  SPACE.lastIndex = at
  SPACE.test(text)
  return SPACE.lastIndex
}

/** text の at の位置に word があるか (大文字小文字を区別しない。word は小文字) */
function wordAt(text: string, at: number, word: string): boolean {
  return text.slice(at, at + word.length).toLowerCase() === word
}

export interface XmlHeadOptions {
  /** 先頭の <?xml ...> も飛ばす */
  decl?: boolean
  /** <!DOCTYPE ...> も飛ばす */
  doctype?: boolean
}

/** 前置きの次の位置 (最初の要素の「<」があるはずのところ)。閉じていない前置きがあれば -1 */
export function skipXmlHead(text: string, options: XmlHeadOptions = {}): number {
  let at = skipSpace(text, 0)
  if (options.decl && wordAt(text, at, '<?xml')) {
    const end = text.indexOf('>', at)
    if (end < 0) return -1
    at = skipSpace(text, end + 1)
  }
  for (;;) {
    let end: number
    if (text.startsWith('<!--', at)) {
      end = text.indexOf('-->', at + 4)
      if (end < 0) return -1
      end += 2
    }
    else if (options.doctype && wordAt(text, at, '<!doctype')) {
      end = text.indexOf('>', at)
      if (end < 0) return -1
    }
    else {
      return at
    }
    at = skipSpace(text, end + 1)
  }
}

/** 前置きのあとが、re (y を付けた正規表現) で始まるか */
export function startsAfterXmlHead(text: string, re: RegExp, options: XmlHeadOptions = {}): boolean {
  const at = skipXmlHead(text, options)
  if (at < 0) return false
  re.lastIndex = at
  return re.test(text)
}
