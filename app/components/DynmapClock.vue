<script setup lang="ts">
// 上の時計 (web/js/timeofdayclock.js と同じ形)。太陽と月、時刻、天気
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { isServerDay, minecraftTime, sunAngle } from '~/lib/time'
import type { DynmapViewer } from '~/lib/viewer'

const props = defineProps<{ viewer: DynmapViewer, digital: boolean, weather: boolean }>()
const state = props.viewer.state

// サーバーの時刻は 2 秒ごとに届く。そのあいだは 0.7 秒ごとに 1000/60 ずつ進める
const shown = ref(state.servertime)
let timer: ReturnType<typeof setTimeout> | undefined
function tick(t: number): void {
  clearTimeout(timer)
  shown.value = t
  if (t >= 0) timer = setTimeout(() => tick(t + 1000 / 60), 700)
}
watch(() => state.updated, () => tick(state.servertime))
onBeforeUnmount(() => clearTimeout(timer))

const time = computed(() => shown.value >= 0 ? minecraftTime(shown.value) : null)
const text = computed(() => time.value ? `${String(time.value.hours).padStart(2, '0')}:${String(time.value.minutes).padStart(2, '0')}` : '')

function position(angle: number | null): string {
  return angle === null ? '-150px -150px' : `${-50 * Math.cos(angle)}px ${-50 * Math.sin(angle)}px`
}
const sun = computed(() => position(state.servertime >= 0 ? sunAngle(state.servertime) : null))
const moon = computed(() => position(state.servertime >= 0 ? sunAngle(state.servertime) + Math.PI : null))

const weatherClass = computed(() => {
  const daynight = isServerDay(state.servertime) ? '_day' : '_night'
  const kind = state.hasStorm ? (state.isThundering ? 'thunder' : 'stormy') : 'sunny'
  return kind + daynight
})
</script>

<template>
  <div class="largeclock timeofday">
    <div class="timeofday sun" :style="{ height: '60px', backgroundPosition: sun }">
      <div class="timeofday moon" :style="{ height: '60px', backgroundPosition: moon }" />
    </div>
    <div v-if="digital" class="timeofday digitalclock" :class="time ? (time.day ? 'day' : 'night') : ''">{{ text }}</div>
    <div v-if="weather" class="weather" :class="state.servertime >= 0 || state.updated ? weatherClass : ''" />
  </div>
</template>
