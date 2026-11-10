<script setup lang="ts">
// 左下のチャット欄 (web/js/chatbox.js と同じ形)。入った・抜けた人とゲーム内のチャットを数秒だけ出す
import { nextTick, ref, watch } from 'vue'
import type { DynmapViewer } from '~/lib/viewer'

const props = defineProps<{ viewer: DynmapViewer, visiblelines?: number }>()
const state = props.viewer.state
const list = ref<HTMLElement>()

watch(() => state.chat.length, () => void nextTick(() => {
  if (list.value) list.value.scrollTop = list.value.scrollHeight
}))
</script>

<template>
  <div class="chat">
    <div ref="list" class="messagelist" :style="{ maxHeight: `${visiblelines || 6}em`, display: state.chat.length ? '' : 'none' }">
      <div v-for="row in state.chat" :key="row.id" class="messagerow">
        <template v-if="row.html !== undefined">
          <span v-html="row.html" />
        </template>
        <template v-else>
          <span class="messageicon"><img v-if="row.face" class="playerMessageIcon" :src="row.face"></span>
          <span v-if="row.channel" class="messagetext">[{{ row.channel }}] </span>
          <span v-if="row.name" class="messagetext">{{ ` ${row.name}: ` }}</span>
          <span class="messagetext">{{ row.text }}</span>
        </template>
      </div>
    </div>
  </div>
</template>
