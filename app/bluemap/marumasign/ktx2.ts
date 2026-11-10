// KTX2 (Basis Universal) のテクスチャを読むもの。画像の看板と 3D モデルのテクスチャで 1 つを分け合う
// basis の変換のプログラム (js と wasm) も、ビルドに入れて同じサイト (/_nuxt/) から返す
import { LoadingManager } from 'three'
import type { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js'
import { getRenderer } from './renderer-ref'

let loader: Promise<KTX2Loader> | null = null

/**
 * three.js の Zstandard の展開 (zstddec) は、中の wasm を data: の URL にして fetch で読む。
 * 本番の CSP の connect-src は data: を許さないので、その形の URL だけはここで中身を返す
 * (wasm のバイト列をそのまま渡すのと同じで、読める範囲は広がらない)
 */
let fetchPatched = false
export function allowInlineWasmFetch(): void {
  if (fetchPatched) return
  fetchPatched = true
  const PREFIX = 'data:application/wasm;base64,'
  const original = globalThis.fetch.bind(globalThis)
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    if (typeof input === 'string' && input.startsWith(PREFIX)) {
      const bin = atob(input.substring(PREFIX.length))
      const bytes = new Uint8Array(bin.length)
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
      return Promise.resolve(new Response(bytes, { headers: { 'Content-Type': 'application/wasm' } }))
    }
    return original(input, init)
  }) as typeof fetch
}

/** 時間までに終わらなければ失敗にする (KTX2Loader は失敗しても呼び返さないことがあるので、読み込み中のまま残らないように) */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then((v) => {
      clearTimeout(timer)
      resolve(v)
    }, (e: unknown) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

export function getKtx2Loader(): Promise<KTX2Loader> {
  if (loader) return loader
  allowInlineWasmFetch()
  loader = (async () => {
    const [{ KTX2Loader }, js, wasm] = await Promise.all([
      import('three/addons/loaders/KTX2Loader.js'),
      import('three/examples/jsm/libs/basis/basis_transcoder.js?url'),
      import('three/examples/jsm/libs/basis/basis_transcoder.wasm?url'),
    ])
    const manager = new LoadingManager()
    manager.setURLModifier((url) => {
      if (url.endsWith('basis_transcoder.js')) return js.default
      if (url.endsWith('basis_transcoder.wasm')) return wasm.default
      return url
    })
    const l = new KTX2Loader(manager)
    l.setTranscoderPath('marumasign-basis/')
    l.setWorkerLimit(1)
    const gl = getRenderer()
    if (gl) l.detectSupport(gl)
    return l
  })()
  loader.catch(() => {
    loader = null
  })
  return loader
}
