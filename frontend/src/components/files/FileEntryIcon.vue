<script setup lang="ts">
import { computed } from 'vue'
import type { FsEntryDetail } from '@/api/interface/fs'
import { fileIconUrl, resolveFileIcon } from '@/services/file-icons'

/** 两种文件视图共享的装饰图标，链接角标不替代文件类型。 */
const props = defineProps<{ entry: FsEntryDetail; size: number }>()
const appearance = computed(() => resolveFileIcon(props.entry))
</script>

<template>
  <span
    class="file-icon"
    data-ui="file-entry-icon"
    :data-icon="appearance.icon"
    :style="{ width: size + 'px', height: size + 'px' }"
    aria-hidden="true"
  >
    <img :src="fileIconUrl(appearance.icon)" alt="" draggable="false" />
    <img
      v-if="appearance.badge"
      class="link-badge"
      data-slot="file-link-badge"
      :src="fileIconUrl(appearance.badge)"
      alt=""
      draggable="false"
    />
  </span>
</template>

<style scoped>
.file-icon {
  position: relative;
  display: inline-flex;
  flex: none;
  pointer-events: none;
}
.file-icon img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.file-icon .link-badge {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 35%;
  height: 35%;
  min-width: 7px;
  min-height: 7px;
}
</style>
