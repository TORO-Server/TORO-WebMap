// BlueMap の WebGL の描画 (圧縮されたテクスチャを使えるかを調べるため、後から読み込む部分にも渡す)
import type { WebGLRenderer } from 'three'

let current: WebGLRenderer | null = null

export function setRenderer(renderer: WebGLRenderer): void {
  current = renderer
}

export function getRenderer(): WebGLRenderer | null {
  return current
}

/** three.js の圧縮されたテクスチャの形式を、この GPU で描けるか (DDS) */
export function compressedFormatSupported(format: number): boolean {
  const gl = current
  if (!gl) return false
  const ext = (name: string): boolean => gl.extensions.has(name)
  // RGB_S3TC_DXT1 = 33776 ... RGBA_S3TC_DXT5 = 33779, RGB_ETC1 = 36196, BPTC = 36492 - 36495
  if (format >= 33776 && format <= 33779) return ext('WEBGL_compressed_texture_s3tc')
  if (format === 36196) return ext('WEBGL_compressed_texture_etc1') || ext('WEBGL_compressed_texture_etc')
  if (format >= 36492 && format <= 36495) return ext('EXT_texture_compression_bptc')
  return false
}
