// BlueMap の画面で全体から使うものの型
import type { BlueMapApp } from './js/BlueMapApp'

declare global {
  interface Window {
    /** BlueMap の画面の本体。BlueMap の外のスクリプト (Wiki の背景の撮影など) もこれを使う */
    bluemap: BlueMapApp
    /** BlueMap のクラス (js/BlueMap.ts)。外のスクリプトが使う */
    BlueMap: typeof import('./js/BlueMap')
  }

  interface String {
    /** 大文字と小文字を区別せずに含むか (BlueMap の main.js が足していたもの) */
    includesCI(val: string): boolean
  }
}

declare module 'vue' {
  interface ComponentCustomProperties {
    $bluemap: BlueMapApp
  }
}

export {}
