# 外のもの (サードパーティ)

看板の画像・動画の形式のために使っている部品です。どれも、その形式の看板が近くに来たときに初めて、別のファイル (`/_nuxt/` の js と wasm) として読み込みます。バージョンの正本は `package.json` (と `package-lock.json`) です。

| 名前 | ライセンス | 元 | 使い方 |
| --- | --- | --- | --- |
| @ffmpeg/core (1 スレッドの版) | GPL-2.0-or-later | https://github.com/ffmpegwasm/ffmpeg.wasm (FFmpeg https://ffmpeg.org/、x264、x265 などを含む) | ブラウザーが再生できない動画・音声を MP4 にする。`ffmpeg-core.js` と `ffmpeg-core.wasm` はそのまま別のファイルとして置き、`sources/ffmpeg-worker.ts` (自前の Worker) から呼ぶ。ソースは元のリポジトリの v0.12.10 のタグ |
| libheif-js | LGPL-3.0 | https://github.com/catdad-experiments/libheif-js | HEIC を WebCodecs で読めないとき。中の libheif 1.23 (LGPL-3.0, https://github.com/strukturag/libheif) と libde265 (LGPL-3.0, https://github.com/strukturag/libde265) を含む。`libheif-wasm/libheif.js` と `libheif.wasm` のソースには手を加えず、ほかのコードと別のファイルとして使う (置き換えられる)。wasm はそのままのバイト列を `/_nuxt/libheif.<hash>.wasm` に置く。js はビルドで ES モジュールに包んで縮めるだけ (処理は同じ。`/_nuxt/` の別の chunk になる)。wasm は `decoders/codecs.ts` が取ってきてコンパイルし、Emscripten の `instantiateWasm` で渡す。ライセンスの全文は npm のパッケージの `LICENSE` と `libheif-wasm/LICENSE` |
| jxl-oxide-wasm | MIT または Apache-2.0 | https://github.com/tirr-c/jxl-oxide | JPEG XL をブラウザーが読めないとき |
| fzstd | MIT | https://github.com/101arrowz/fzstd | TIFF の Zstandard |
| jpeg-js | BSD-3-Clause | https://github.com/eugeneware/jpeg-js | TIFF の中の JPEG |
| pdfjs-dist の OpenJPEG | Apache-2.0 (pdf.js)、BSD-2-Clause (OpenJPEG) | https://github.com/mozilla/pdf.js | JPEG 2000 (PDF の看板と同じもの。wasm と、wasm を使わない版 `openjpeg_nowasm_fallback.js`) |
| bcdec (書き直したもの) | MIT (Copyright (c) 2022 Sergii Kudlai) | https://github.com/iOrange/bcdec | `decoders/bcn.ts` の BC6H と BC7 (MarumaSign 本体の Bptc.java と同じ) |
