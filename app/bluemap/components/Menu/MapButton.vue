<template>
  <div class="map-button" :class="{selected: map.id === selectedMapId}" @click="switchMap(map.id)" :title="map.id">
    <span class="sky" :style="{color: 'rgb(' + map.skyColor.r * 255 + ',' + map.skyColor.g * 255 + ',' + map.skyColor.b * 255 + ')'}">&bull;</span>
    <span class="name">{{map.name}}</span>
  </div>
</template>

<script lang="ts">
import {defineComponent, type PropType} from "vue";
import type {BlueMapApp} from "../../js/BlueMapApp";
import type {MapViewer} from "../../js/MapViewer";
import type {Map as BlueMapMap} from "../../js/map/Map";

export default defineComponent({
  name: "MapButton",
  props: {
    map: Object as PropType<BlueMapMap["data"]>,
  },
  data(): { mapViewer: MapViewer["data"], appState: BlueMapApp["appState"] } {
    return {
      mapViewer: this.$bluemap.mapViewer.data,
      appState: this.$bluemap.appState,
    }
  },
  computed: {
    selectedMapId(): string {
      return this.mapViewer.map ? this.mapViewer.map.id : null;
    }
  },
  methods: {
    switchMap(mapId: string): void {
      this.$bluemap.switchMap(mapId);
    }
  }
})
</script>

<style lang="scss">
.side-menu .map-button {
  position: relative;
  cursor: pointer;
  user-select: none;

  height: 2em;
  line-height: 2em;

  white-space: nowrap;
  overflow-x: hidden;
  text-overflow: ellipsis;

  &.selected {
    background-color: var(--theme-bg-light);
  }

  &:hover {
    background-color: var(--theme-bg-hover);
  }

  .sky {
    float: left;
    border-radius: 100%;

    width: 0.5em;
    height: 0.5em;

    margin: 0 0.25em 0 0.5em;
  }

  .id {
    font-style: italic;
    color: var(--theme-fg-light);

    margin: 0 0.5em;
  }
}
</style>