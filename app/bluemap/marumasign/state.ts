// 看板の音のボタン (components/SignSoundButton.vue) と、動画の看板の描き方 (renderers/media.ts) が分け合う状態
// ボタンは画面の部品なので最初から読み込む。ここは小さく保つ (動画の部分は看板が近くに来たときに読み込む)
import { reactive } from 'vue'

export const signSound = reactive({
  /** 音の出る看板 (動画・音声・ライブ配信) が近くにあるか。あるときだけボタンを出す */
  available: false,
  /** 音を出しているか。ブラウザーの決まりで、最初は消してある (押してから出せる) */
  on: false,
})

let handler: ((on: boolean) => void) | null = null

/** ボタンが押されたときの動き (renderers/media.ts が入れる) */
export function setSoundHandler(h: (on: boolean) => void): void {
  handler = h
}

/** ボタンが押された (押した操作の中で呼ぶ。ブラウザーはこの中でだけ音を出し始めることを許す) */
export function toggleSignSound(): void {
  if (handler) handler(!signSound.on)
}
