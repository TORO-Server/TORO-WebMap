<script setup lang="ts">
// 右のサイドバー (web/js/map.js と sidebarutils.js の作るものと同じ形)。地図の一覧とプレイヤーの一覧
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { DynmapViewer } from '~/lib/viewer'
import type { MapConfig, WorldConfig } from '~/lib/types'

const props = defineProps<{ viewer: DynmapViewer }>()
const state = props.viewer.state
const config = computed(() => state.config!)

const pinned = ref(state.sidebarMode !== 'false')
const sidebar = ref<HTMLElement>()
const sections = ref<HTMLElement[]>([])

interface Entry { world: WorldConfig, maps: MapConfig[] }

// 地図は append_to_world で別のワールドの下に並べられる
const entries = computed<Entry[]>(() => {
  const list = new Map<string, Entry>()
  for (const w of config.value.worlds) list.set(w.name, { world: w, maps: [] })
  for (const w of config.value.worlds) {
    for (const m of w.maps) {
      const target = (m.append_to_world && list.get(m.append_to_world)) || list.get(w.name)!
      target.maps.push(m)
    }
  }
  return [...list.values()].filter(e => e.maps.length > 0)
})

// 地図の種類の絵 (images/block_<world>_<map>.png)
function mapIcon(world: string, m: MapConfig): string {
  if (m.icon) return m.icon
  let w = 'world'
  let name = ['surface', 'flat', 'biome', 'cave'].includes(m.name) ? m.name : 'flat'
  if (world.endsWith('_nether') || world === 'DIM-1') {
    w = 'nether'
    name = m.name === 'nether' ? 'surface' : 'flat'
  }
  else if (world.endsWith('the_end') || world === 'DIM1') {
    w = 'the_end'
    name = m.name === 'the_end' ? 'surface' : 'flat'
  }
  return `images/block_${w}_${name}.png`
}

function worldOf(m: MapConfig): string {
  return config.value.worlds.find(w => w.maps.includes(m))!.name
}

// 押しているあいだ、1 秒に 100px ずつ動かす (Dynmap は 3 秒で 300px)
let scrolling = 0
function scroll(el: HTMLElement | null | undefined, dir: number): void {
  stopScroll()
  if (!el) return
  let last = performance.now()
  const step = (now: number): void => {
    el.scrollTop += dir * (now - last) / 10
    last = now
    scrolling = requestAnimationFrame(step)
  }
  scrolling = requestAnimationFrame(step)
}
function stopScroll(): void {
  cancelAnimationFrame(scrolling)
}

// 縦に入りきらないとき、長い一覧ほど縮めて上下の送りボタンを出す (map.js の updateSidebarHeight と同じ)
function updateHeight(): void {
  const bar = sidebar.value
  if (!bar) return
  const minContent = 24
  let minSections = 0
  let total = 0
  let totalWithButtons = 0
  let resizeable = 0
  const fixed = new Set<number>()
  const parts = sections.value.map((section) => {
    const legend = section.querySelector<HTMLElement>('legend')!
    const content = section.querySelector<HTMLElement>('.content')!
    const up = section.querySelector<HTMLElement>('.scrollup')!
    const down = section.querySelector<HTMLElement>('.scrolldown')!
    return { section, legend, content, up, down }
  })
  const outer = (el: HTMLElement): number => {
    const s = getComputedStyle(el)
    return el.offsetHeight + Number.parseFloat(s.marginTop) + Number.parseFloat(s.marginBottom)
  }
  parts.forEach((p, i) => {
    p.content.style.height = 'auto'
    const legend = outer(p.legend)
    const content = p.content.scrollHeight
    const up = outer(p.up)
    const down = outer(p.down)
    const padding = outer(p.section) - p.section.clientHeight
    const h = legend + content + padding
    total += h
    minSections += legend + padding
    totalWithButtons += h
    if (content < up + down + minContent) {
      fixed.add(i)
      minSections += content
    }
    else {
      resizeable += content
      totalWithButtons += up + down
      minSections += up + down + minContent
    }
  })
  const height = bar.clientHeight
  if (total > height && height > minSections) {
    const missing = totalWithButtons - height
    parts.forEach((p, i) => {
      const show = !fixed.has(i)
      p.up.style.display = show ? '' : 'none'
      p.down.style.display = show ? '' : 'none'
      if (show) {
        const h = p.content.scrollHeight
        p.content.style.height = `${h - missing * (h / resizeable)}px`
      }
    })
  }
  else {
    for (const p of parts) {
      p.up.style.display = 'none'
      p.down.style.display = 'none'
      p.content.style.height = 'auto'
    }
  }
  bar.style.overflowY = height < minSections ? 'scroll' : ''
  bar.style.overflowX = height < minSections ? 'hidden' : ''
}

const playersLegend = computed(() => `${config.value['msg-players']} [${state.currentcount}/${config.value.maxcount}]`)

onMounted(() => {
  window.addEventListener('resize', updateHeight)
  void nextTick(updateHeight)
})
onBeforeUnmount(() => window.removeEventListener('resize', updateHeight))
watch(() => state.players.length, () => void nextTick(updateHeight))
</script>

<template>
  <div ref="sidebar" class="sidebar" :class="{ pinned }">
    <div class="panel">
      <div v-if="state.sidebarMode !== 'true'" class="pin" @click="pinned = !pinned" />
      <fieldset :ref="el => { if (el) sections[0] = el as HTMLElement }" class="section">
        <legend>{{ config['msg-maptypes'] }}</legend>
        <div class="scrollup" @mousedown="scroll(sections[0]?.querySelector('.content'), -1)" @touchstart="scroll(sections[0]?.querySelector('.content'), -1)" @mouseup="stopScroll" @touchend="stopScroll" />
        <ul class="list content worldlist">
          <li v-for="e in entries" :key="e.world.name" class="world subsection">
            {{ e.world.title }}
            <ul class="maplist sublist">
              <li
                v-for="m in e.maps" :key="m.name" class="map item"
                :class="{ selected: state.world === worldOf(m) && state.map === m.name }"
                @click.prevent="viewer.selectMap(worldOf(m), m.name)"
              >
                <a :title="m.title" href="#" class="maptype" :style="{ backgroundImage: `url(${mapIcon(e.world.name, m)})` }">{{ m.title }}</a>
              </li>
            </ul>
          </li>
        </ul>
        <div class="scrolldown" @mousedown="scroll(sections[0]?.querySelector('.content'), 1)" @touchstart="scroll(sections[0]?.querySelector('.content'), 1)" @mouseup="stopScroll" @touchend="stopScroll" />
      </fieldset>
      <fieldset :ref="el => { if (el) sections[1] = el as HTMLElement }" class="section">
        <legend>{{ playersLegend }}</legend>
        <div class="scrollup" @mousedown="scroll(sections[1]?.querySelector('.content'), -1)" @touchstart="scroll(sections[1]?.querySelector('.content'), -1)" @mouseup="stopScroll" @touchend="stopScroll" />
        <ul class="list content playerlist">
          <li
            v-for="p in state.players" :key="p.account" class="player"
            :class="{ otherworld: config.grayplayerswhenhidden && p.world !== state.world, following: state.following === p.account }"
            @click="viewer.centerOnPlayer(p.account)"
          >
            <span class="playerIcon" title="Follow player" @click.stop="viewer.followPlayer(state.following === p.account ? null : p.account)">
              <img :src="config.showplayerfacesinmenu ? viewer.faceUrl(p.account, 16) : 'images/player_face.png'" @error="($event.target as HTMLImageElement).src = 'images/player_face.png'">
            </span>
            <a href="#" title="Center on player" @click.prevent>{{ p.name }}</a>
          </li>
        </ul>
        <div class="scrolldown" @mousedown="scroll(sections[1]?.querySelector('.content'), 1)" @touchstart="scroll(sections[1]?.querySelector('.content'), 1)" @mouseup="stopScroll" @touchend="stopScroll" />
      </fieldset>
      <div v-if="state.sidebarMode !== 'true'" class="hitbar" @click="pinned = !pinned" />
    </div>
  </div>
</template>
