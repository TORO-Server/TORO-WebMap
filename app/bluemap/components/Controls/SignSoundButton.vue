<template>
  <div v-if="sound.available" id="sign-sound-button">
    <SvgButton :active="sound.on" :title="sound.on ? '看板の音を消す' : '看板の音を出す'" @action="toggle">
      <svg viewBox="0 0 30 30">
        <path d="M5,11.5h4.5L16,6v18l-6.5-5.5H5z" />
        <template v-if="sound.on">
          <path d="M19.2,10.8c2.3,2.3,2.3,6.1,0,8.4l-1.4-1.4c1.5-1.5,1.5-4.1,0-5.6z" />
          <path d="M22.4,7.6c4.1,4.1,4.1,10.7,0,14.8l-1.4-1.4c3.3-3.3,3.3-8.7,0-12z" />
        </template>
        <path v-else d="M18.6,11.6l1.4-1.4l2.9,2.9l2.9-2.9l1.4,1.4L24.3,14.5l2.9,2.9l-1.4,1.4l-2.9-2.9l-2.9,2.9l-1.4-1.4l2.9-2.9z" />
      </svg>
    </SvgButton>
  </div>
</template>

<script lang="ts">
// MarumaSign の看板 (動画・音声・ライブ配信) の音を出すボタン。音の出る看板が近くにあるときだけ出る
// ブラウザーの決まりで、ページを開いただけでは音を出せないので、最初は消してある
import {defineComponent} from "vue";
import SvgButton from "../ControlBar/SvgButton.vue";
import {signSound, toggleSignSound} from "../../marumasign/state";

export default defineComponent({
  name: "SignSoundButton",
  components: {
    SvgButton
  },
  data() {
    return {
      sound: signSound
    }
  },
  methods: {
    toggle(): void {
      toggleSignSound();
    }
  }
})
</script>

<style lang="scss">
  #sign-sound-button {
    position: fixed;
    bottom: 0;
    left: 0;

    filter: drop-shadow(1px 1px 3px rgba(0, 0, 0, 0.53));
    width: 2em;

    margin: 0.5em;
  }
</style>
