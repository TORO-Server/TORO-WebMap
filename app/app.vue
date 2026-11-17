<script setup lang="ts">
// map.torosaba.net の Dynmap の画面。3D 地図 (BlueMap) の画面は別のリポジトリ (TORO-3D-WebMap) の静的なサイトになった
import { defineAsyncComponent, type Component } from 'vue'

const View = defineAsyncComponent<Component>(() => import('~/components/DynmapView.vue'))

// ホーム画面に追加して開けるようにする (client/sw.ts)。手元の npm run dev では使わない
if (!import.meta.dev && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service Worker を登録できませんでした', e))
}
</script>

<template>
  <View />
</template>