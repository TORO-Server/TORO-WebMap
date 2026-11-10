<script setup lang="ts">
// 3d-map.torosaba.net の画面。BlueMap の webapp の main.js と index.html の代わり
// 地図のデータ (maps/...) は toro-webmap が TiDB から返し、settings.json と lang/ と assets/ は BlueMap の web のファイルを toro-edge が返す
import { getCurrentInstance, nextTick, onMounted, ref } from 'vue'
import { useHead } from '@unhead/vue'
import App from './App.vue'
import * as BlueMap from './js/BlueMap'
import { BlueMapApp } from './js/BlueMapApp'
import { i18nModule, loadLanguageSettings } from './i18n'
import favicon from './assets/favicon.png'

useHead({
  meta: [
    { name: 'keywords', content: 'TORO Server, Minecraft, マインクラフト, 地図, 3D, BlueMap' },
    { name: 'theme-color', content: '#006EDE' },
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'TORO 3D 地図' },
  ],
  link: [
    { rel: 'icon', href: favicon },
    // ホーム画面のアイコンとアプリの情報 (public/pwa/。BlueMap の manifest は BlueMap の名前とアイコンだった)
    { rel: 'manifest', href: '/pwa/3d-map.webmanifest' },
    { rel: 'apple-touch-icon', sizes: '180x180', href: '/pwa/3d-map-apple-180.png' },
  ],
})

// BlueMap の main.js が足していたもの (画面の部品が使う)
String.prototype.includesCI = function (this: string, val: string): boolean {
  return this.toLowerCase().includes(val.toLowerCase())
}

const container = ref<HTMLElement>()
const ready = ref(false)
const failed = ref(false)
const vueApp = getCurrentInstance()!.appContext.app

onMounted(async () => {
  try {
    const bluemap = new BlueMapApp(container.value!)
    window.bluemap = bluemap
    window.BlueMap = BlueMap
    vueApp.config.globalProperties.$bluemap = bluemap
    vueApp.use(i18nModule)
    await loadLanguageSettings()
    // 画面の部品を出してから地図を読む (BlueMap の main.js と同じ順)
    ready.value = true
    await nextTick()
    await bluemap.load()
    // MarumaSign の看板 (画像・動画・PDF など)。前は MarumaSign Companion が js/marumasign3d.js を入れていた。
    // 手元で前のスクリプトと見比べるとき (npm run dev で ?marumasign=legacy) は、前のスクリプトだけを動かす
    if (!(import.meta.env.DEV && /[?&]marumasign=legacy\b/.test(window.location.search))) {
      import('./marumasign/overlay')
        .then(m => m.startMarumaSign(bluemap))
        .catch(e => console.warn('MarumaSign の看板を表示できませんでした', e))
    }
  }
  catch (e) {
    console.error('Failed to load BlueMap webapp!', e)
    failed.value = true
  }
})
</script>

<template>
  <div v-if="failed" id="bm-app-err">
    <div>
      <!-- BlueMap の web のファイル (toro-edge が返す)。ビルドに含めない -->
      <img :src="'/assets/logo.png'" alt="bluemap logo">
      <div class="bm-app-err-main">Failed to load BlueMap webapp!</div>
      <div class="bm-app-err-hint">Make sure you have <a href="https://get.webgl.org/webgl2/">WebGL2</a> enabled on your browser.</div>
    </div>
  </div>
  <template v-else>
    <div id="map-container" ref="container" />
    <App v-if="ready" />
  </template>
</template>
