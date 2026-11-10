<script setup lang="ts">
// map.torosaba.net の地図の画面。Dynmap の web/index.html の代わり
// 地図のデータは up/... と tiles/... (toro-webmap が TiDB から返す)、見た目は Dynmap の css/ と images/ をそのまま使う
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { computed, markRaw, onMounted, ref } from 'vue'
import { DynmapViewer } from '~/lib/viewer'
import type { ComponentConfig } from '~/lib/types'

// lang と title は、返す HTML に入るよう nuxt.config.ts の app.head に書いている
useHead({
  meta: [
    { name: 'keywords', content: 'TORO Server, Minecraft, マインクラフト, 地図, Dynmap' },
    { name: 'apple-mobile-web-app-capable', content: 'yes' },
    { name: 'mobile-web-app-capable', content: 'yes' },
    { name: 'apple-mobile-web-app-title', content: 'TORO 地図' },
    // ホーム画面から開いたとき、iPhone の上の帯に地図とボタンが潜らないよう、透けない黒にする
    { name: 'apple-mobile-web-app-status-bar-style', content: 'black' },
    { name: 'msapplication-TileColor', content: '#000000' },
    { name: 'msapplication-config', content: 'images/icons/browserconfig.xml' },
    { name: 'theme-color', content: '#000000' },
  ],
  link: [
    // ホーム画面のアイコンとアプリの情報 (public/pwa/。Dynmap の images/icons/site.webmanifest は名前もなく、インストールできない)
    { rel: 'apple-touch-icon', sizes: '180x180', href: '/pwa/map-apple-180.png' },
    { rel: 'manifest', href: '/pwa/map.webmanifest' },
    { rel: 'icon', type: 'image/png', sizes: '32x32', href: 'images/icons/favicon-32x32.png' },
    { rel: 'icon', type: 'image/png', sizes: '16x16', href: 'images/icons/favicon-16x16.png' },
    { rel: 'mask-icon', href: 'images/icons/safari-pinned-tab.svg', color: '#000000' },
    { rel: 'shortcut icon', href: 'images/icons/favicon.ico' },
    // Leaflet の CSS より後に読み、Dynmap の見た目にする
    { rel: 'stylesheet', href: 'css/standalone.css' },
    { rel: 'stylesheet', href: 'css/dynmap_style.css' },
  ],
})

const viewer = markRaw(new DynmapViewer())
if (import.meta.dev) (window as unknown as { viewer: DynmapViewer }).viewer = viewer
const state = viewer.state
const mapEl = ref<HTMLElement>()
const error = ref<string | null>(null)

const component = (type: string): ComponentConfig | undefined => state.config?.components.find(c => c.type === type)
const clock = computed(() => component('timeofdayclock'))
const chatbox = computed(() => component('chatbox'))
const compassClass = computed(() => {
  const map = viewer.currentMap.value
  return ['compass', L.Browser.mobile ? 'mobilecompass' : '', map ? `compass_${map.compassview} compass_${map.name}` : '']
})

onMounted(async () => {
  try {
    await viewer.start(mapEl.value!)
  }
  catch (e) {
    error.value = (e as Error).message
  }
})
</script>

<template>
  <div id="mcmap" class="dynmap">
    <div ref="mapEl" class="map" />
    <DynmapSidebar v-if="state.ready && !state.nopanel" :viewer="viewer" />
    <div v-if="state.ready && !state.nogui && !state.nocompass" :class="compassClass" />
    <div v-show="state.alert || error" class="alertbox">{{ error || state.alert }}</div>
    <DynmapChatbox v-if="state.ready && !state.nogui && !state.hidechat && chatbox" :viewer="viewer" :visiblelines="Number(chatbox.visiblelines) || undefined" />
    <DynmapClock v-if="state.ready && !state.nogui && clock" :viewer="viewer" :digital="clock.showdigitalclock === true" :weather="clock.showweather === true" />
  </div>
</template>
