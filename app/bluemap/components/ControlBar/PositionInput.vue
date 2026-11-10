<template>
  <div class="position-input">
    <NumberInput label="x" :value="controls.position.x" v-on:input="controls.position.x = parseFloat($event.target.value);" />
    <NumberInput label="y" :value="controls.position.y" v-on:input="controls.position.y = parseFloat($event.target.value);" v-if="appState.controls.state === 'free'" />
    <NumberInput label="z" :value="controls.position.z" v-on:input="controls.position.z = parseFloat($event.target.value);" />
  </div>
</template>

<script lang="ts">
  import NumberInput from "./NumberInput.vue";
  import {defineComponent, reactive} from "vue";
  import type {BlueMapApp} from "../../js/BlueMapApp";
  import type {ControlsManager} from "../../js/controls/ControlsManager";

  export default defineComponent({
    name: "PositionInput",
    components: {
      NumberInput
    },
    data(): { controls: ControlsManager["data"], appState: BlueMapApp["appState"] } {
      return {
        controls: this.$bluemap.mapViewer.controlsManager.data,
        appState: this.$bluemap.appState
      }
    }
  })
</script>

<style lang="scss">
  .position-input {
    display: flex;
    user-select: none;

    > * {
      width: 100%;

      &:not(:first-child) {
        border-left: solid 1px var(--theme-bg-light);
      }
    }
  }
</style>