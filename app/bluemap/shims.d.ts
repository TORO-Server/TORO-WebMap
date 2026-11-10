// 型の無いパッケージ
declare module 'hocon-parser' {
  /** HOCON の文字列を読み、オブジェクトにする */
  export default function parseHocon(text: string): any
}
