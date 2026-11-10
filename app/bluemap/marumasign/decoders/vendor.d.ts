// 型のない読み込みのもの (decoders/ から必要なときだけ読み込む)

// jpeg-js の展開だけ (BSD-3-Clause)。TIFF の中の JPEG に使う
declare module 'jpeg-js/lib/decoder.js' {
  const decode: (data: Uint8Array, options: object) => { width: number, height: number, data: Uint8Array }
  export default decode
}

// libheif-js (LGPL-3.0)。Emscripten の factory (使う形は codecs.ts の Libheif)
declare module 'libheif-js/libheif-wasm/libheif.js' {
  const factory: (options: object) => unknown
  export default factory
}
