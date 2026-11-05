<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import { useI18n } from 'vue-i18n'
import type { ProcessSummary } from '@/api/modules/process'
import type { VeyTableColumn } from '@/components/ui/VeyTable.vue'
import { VeyButton } from '@/components/ui'

/** 进程专用虚拟表格，固定行高并在接近已加载范围底部时请求更多数据。 */
const props = defineProps<{
  data: ProcessSummary[]
  columns: VeyTableColumn[]
  generation: number
  hasMore: boolean
  busy: boolean
  loadingMore: boolean
  loadMoreError: string | null
  label: string
}>()
const emit = defineEmits<{ loadMore: [] }>()
const { t } = useI18n()
const ROW_HEIGHT = 44
const HEADER_HEIGHT = 44
const OVERSCAN = 6
const viewport = ref<HTMLDivElement>()
const scrollTop = ref(0)
const viewportHeight = ref(0)
let resizeObserver: ResizeObserver | undefined
const start = computed(() =>
  Math.min(
    Math.max(0, props.data.length - 1),
    Math.max(0, Math.floor((scrollTop.value - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN),
  ),
)
const end = computed(() =>
  Math.min(
    props.data.length,
    start.value + Math.ceil(viewportHeight.value / ROW_HEIGHT) + OVERSCAN * 2,
  ),
)
const visibleRows = computed(() => props.data.slice(start.value, end.value))
const minimumWidth = computed(() =>
  props.columns.reduce(
    (width, column) => width + Number(column.width ?? column.minWidth ?? 100),
    0,
  ),
)

/** 列宽与表头、数据行共用，确保虚拟行切换时不会改变列布局。 */
const columnStyle = (column: VeyTableColumn): CSSProperties => ({
  width: typeof column.width === 'number' ? `${column.width}px` : column.width,
  textAlign: column.align ?? 'left',
})

/** 只在可见且没有请求或错误时自动续载；错误由显式重试恢复。 */
const checkLoadMore = () => {
  if (
    viewportHeight.value > 0 &&
    props.data.length > 0 &&
    props.hasMore &&
    !props.busy &&
    !props.loadMoreError &&
    scrollTop.value + viewportHeight.value >= HEADER_HEIGHT + props.data.length * ROW_HEIGHT - 220
  ) {
    emit('loadMore')
  }
}

/** 同步实际滚动位置并检查加载阈值，也支持键盘与横向滚动。 */
const onScroll = () => {
  scrollTop.value = viewport.value?.scrollTop ?? 0
  checkLoadMore()
}

/** 窗口缩放后重新计算可视行数；隐藏标签不主动加载。 */
const measure = () => {
  viewportHeight.value = viewport.value?.clientHeight ?? 0
  onScroll()
}

watch(
  () => props.generation,
  () => {
    if (viewport.value) viewport.value.scrollTop = 0
    scrollTop.value = 0
  },
  { flush: 'post' },
)
watch(
  () => [props.data.length, props.busy, props.hasMore],
  async () => {
    await nextTick()
    onScroll()
  },
  { flush: 'post' },
)
onMounted(() => {
  resizeObserver = new ResizeObserver(measure)
  if (viewport.value) resizeObserver.observe(viewport.value)
  measure()
})
onBeforeUnmount(() => resizeObserver?.disconnect())
</script>

<template>
  <div
    ref="viewport"
    class="process-viewport"
    data-slot="process-scroll"
    tabindex="0"
    role="region"
    :aria-label="label"
    :aria-busy="busy"
    @scroll.passive="onScroll"
  >
    <table :style="{ minWidth: `${minimumWidth}px` }" :aria-rowcount="data.length + 1">
      <colgroup>
        <col v-for="(column, index) in columns" :key="index" :style="columnStyle(column)" />
      </colgroup>
      <thead>
        <tr :style="{ height: `${HEADER_HEIGHT}px` }" aria-rowindex="1">
          <th
            v-for="(column, index) in columns"
            :key="index"
            scope="col"
            :class="{ 'fixed-right': column.fixed === 'right' }"
            :style="{ textAlign: column.headerAlign ?? column.align ?? 'center' }"
          >
            <slot v-if="column.headerSlot" :name="column.headerSlot" :column="column" />
            <template v-else>{{ column.label }}</template>
          </th>
        </tr>
      </thead>
      <tbody>
        <tr v-if="start > 0" aria-hidden="true">
          <td
            :colspan="columns.length"
            class="spacer"
            :style="{ height: `${start * ROW_HEIGHT}px` }"
          />
        </tr>
        <tr
          v-for="(row, index) in visibleRows"
          :key="row.processId"
          data-slot="process-row"
          :data-process-id="row.processId"
          :aria-rowindex="start + index + 2"
          :style="{ height: `${ROW_HEIGHT}px` }"
        >
          <td
            v-for="(column, columnIndex) in columns"
            :key="columnIndex"
            :class="{ 'fixed-right': column.fixed === 'right' }"
            :style="{ textAlign: column.align ?? 'left' }"
          >
            <div
              class="cell"
              :title="
                column.prop && !column.slot
                  ? String(row[column.prop as keyof ProcessSummary] ?? '')
                  : undefined
              "
              :style="{ height: `${ROW_HEIGHT - 1}px`, lineHeight: `${ROW_HEIGHT - 1}px` }"
            >
              <slot
                v-if="column.slot"
                :name="column.slot"
                :row="row"
                :column="column"
                :index="start + index"
              />
              <template v-else>{{
                column.prop ? row[column.prop as keyof ProcessSummary] : ''
              }}</template>
            </div>
          </td>
        </tr>
        <tr v-if="end < data.length" aria-hidden="true">
          <td
            :colspan="columns.length"
            class="spacer"
            :style="{ height: `${(data.length - end) * ROW_HEIGHT}px` }"
          />
        </tr>
        <tr v-if="!data.length">
          <td :colspan="columns.length"><slot name="empty" /></td>
        </tr>
      </tbody>
    </table>
    <div
      v-if="hasMore || loadMoreError"
      class="load-status"
      data-slot="process-load-more"
      aria-live="polite"
    >
      <template v-if="loadingMore">{{ t('fileBrowser.loading') }}</template>
      <template v-else-if="loadMoreError">
        <span role="alert">{{ loadMoreError }}</span>
        <VeyButton size="small" :disabled="busy" @click="emit('loadMore')">{{
          t('common.retry')
        }}</VeyButton>
      </template>
      <VeyButton v-else size="small" :disabled="busy" @click="emit('loadMore')">{{
        t('fileBrowser.loadMore')
      }}</VeyButton>
    </div>
  </div>
</template>

<style scoped>
.process-viewport {
  height: 100%;
  min-height: 0;
  overflow: auto;
  overflow-anchor: none;
  border: 1px solid var(--vdl-border-default);
  border-radius: var(--vdl-radius-md);
}

table {
  width: 100%;
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
  font-size: var(--vdl-font-body-sm);
  color: var(--vdl-text-primary);
}

th,
td {
  padding: 0;
  box-sizing: border-box;
  border-right: 1px solid var(--vdl-border-default);
  border-bottom: 1px solid var(--vdl-border-default);
  background: var(--vdl-bg-base);
}

th {
  position: sticky;
  top: 0;
  z-index: 2;
  padding: 0 var(--vdl-space-3);
  background: var(--vdl-bg-muted);
  white-space: nowrap;
}

.cell {
  padding: 0 var(--vdl-space-3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

td.fixed-right {
  position: sticky;
  right: 0;
  z-index: 1;
}

th.fixed-right {
  right: 0;
  z-index: 3;
}

.spacer {
  border: 0;
}

.load-status {
  position: sticky;
  left: 0;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: var(--vdl-space-2);
  padding: var(--vdl-space-2);
  color: var(--vdl-text-secondary);
  font-size: var(--vdl-font-body-sm);
}
</style>
