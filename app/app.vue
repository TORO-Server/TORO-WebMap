<script setup lang="ts">
// 3d-map.torosaba.net は BlueMap の画面 (app/bluemap/)、それ以外 (map.torosaba.net) は Dynmap の画面。
// 開いたほうのコードだけを読み込む (手元では ?app=bluemap で BlueMap の画面になる)
import { defineAsyncComponent, type Component } from 'vue'

const bluemap = window.location.hostname.startsWith('3d-map.') || new URLSearchParams(window.location.search).get('app') === 'bluemap'
const View = defineAsyncComponent<Component>(bluemap
  ? () => import('~/bluemap/BlueMapView.vue')
  : () => import('~/components/DynmapView.vue'))

// ホーム画面に追加して開けるようにする (client/sw.ts)。手元の npm run dev では使わない
if (!import.meta.dev && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(e => console.warn('Service Worker を登録できませんでした', e))
}
</script>

<template>
  <View />
</template>
