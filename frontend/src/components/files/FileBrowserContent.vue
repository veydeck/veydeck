<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import type { FsEntry } from '@/api/interface/fs'
import FileEntryIcon from './FileEntryIcon.vue'
import { formatBytes } from '@/utils/units'
import { formatDateTime } from '@/utils/time'
import { selectFileRange } from '@/services/file-browser'
import { useI18n } from 'vue-i18n'

/** 固定几何的虚拟图标／详细信息内容区，两种视图使用同一选择模型。 */
const props = defineProps<{
  entries: FsEntry[]
  selected: Set<string>
  view: 'icons' | 'details'
  iconSize: number
  hasMore: boolean
  loading: boolean
  location: string
  cutPaths: Set<string>
  nodeId: string
  dropPath?: string
}>()
const emit = defineEmits<{
  select: [paths: Set<string>]
  open: [entry: FsEntry]
  more: []
  context: [entry: FsEntry | undefined, event: MouseEvent]
  dragstart: [entry: FsEntry, event: DragEvent]
  dragend: []
  dragover: [entry: FsEntry | undefined, event: DragEvent]
  drop: [entry: FsEntry | undefined, event: DragEvent]
  interaction: [active: boolean]
  sort: [field: 'name' | 'sizeBytes' | 'modifiedAt']
}>()
const { t } = useI18n()
const viewport = ref<HTMLElement>()
const width = ref(800),
  height = ref(400),
  scroll = ref(0)
const focused = ref<string>(),
  anchor = ref<string>()
const uid = useId()
let resize: ResizeObserver | undefined
const columns = computed(() =>
  props.view === 'details' ? 1 : Math.max(1, Math.floor(width.value / (props.iconSize + 72))),
)
const rowHeight = computed(() => (props.view === 'details' ? 36 : props.iconSize + 64))
const rows = computed(() => Math.ceil(props.entries.length / columns.value))
const start = computed(
  () => Math.max(0, Math.floor(scroll.value / rowHeight.value) - 3) * columns.value,
)
const end = computed(() =>
  Math.min(
    props.entries.length,
    (Math.ceil((scroll.value + height.value) / rowHeight.value) + 3) * columns.value,
  ),
)
const visible = computed(() =>
  props.entries
    .slice(start.value, end.value)
    .map((entry, offset) => ({ entry, index: start.value + offset })),
)
const focusId = computed(() => {
  const index = props.entries.findIndex((entry) => entry.path === focused.value)
  return index >= 0 && index >= start.value && index < end.value ? `${uid}-${index}` : undefined
})
/** 滚动到列表底部之前请求下一批，单次请求由父级去重。 */
function onScroll() {
  if (!viewport.value) return
  scroll.value = viewport.value.scrollTop
  if (
    props.hasMore &&
    !props.loading &&
    scroll.value + height.value >= rows.value * rowHeight.value - rowHeight.value * 3
  )
    emit('more')
}
/** 选择条目并将键盘焦点留在当前虚拟网格。 */
function choose(entry: FsEntry, event: Pick<MouseEvent, 'ctrlKey' | 'metaKey' | 'shiftKey'>) {
  emit(
    'select',
    selectFileRange(
      props.entries,
      props.selected,
      entry.path,
      anchor.value,
      event.ctrlKey || event.metaKey,
      event.shiftKey,
    ),
  )
  if (!event.shiftKey || !anchor.value) anchor.value = entry.path
  focused.value = entry.path
  viewport.value?.focus({ preventScroll: true })
}
/** 右键已选择项不破坏多选；空白区提供目录操作。 */
function context(entry: FsEntry | undefined, event: MouseEvent) {
  if (entry && !props.selected.has(entry.path))
    choose(entry, { ctrlKey: false, metaKey: false, shiftKey: false })
  emit('context', entry, event)
}
/** 从有序模型计算方向键目标，不依赖当前是否存在对应 DOM。 */
function keyboard(event: KeyboardEvent) {
  if (event.altKey) return
  if (
    !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Enter'].includes(event.key)
  )
    return
  event.preventDefault()
  const current = props.entries.findIndex((entry) => entry.path === focused.value)
  if (event.key === 'Enter') {
    if (current >= 0) emit('open', props.entries[current]!)
    return
  }
  const offset =
    event.key === 'ArrowUp'
      ? -columns.value
      : event.key === 'ArrowDown'
        ? columns.value
        : event.key === 'ArrowLeft'
          ? -1
          : 1
  const index =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? props.entries.length - 1
        : current < 0
          ? 0
          : Math.max(0, Math.min(props.entries.length - 1, current + offset))
  const entry = props.entries[index]
  if (!entry) return
  if (event.ctrlKey || event.metaKey) focused.value = entry.path
  else choose(entry, { ...event, ctrlKey: false, metaKey: false, shiftKey: event.shiftKey })
  const top = Math.floor(index / columns.value) * rowHeight.value
  if (viewport.value) {
    if (top < viewport.value.scrollTop) viewport.value.scrollTop = top
    else if (top + rowHeight.value > viewport.value.scrollTop + height.value)
      viewport.value.scrollTop = top + rowHeight.value - height.value
    onScroll()
  }
}
/** 按虚拟几何进行框选，不逐项读取不可见 DOM。 */
const box = ref<{ x: number; y: number; endX: number; endY: number }>()
let boxStart:
  | {
      clientX: number
      clientY: number
      scroll: number
      selected: Set<string>
      add: boolean
      pointer: number
    }
  | undefined
let lastPointer: PointerEvent | undefined
let animation = 0
/** 背景按下启动独立框选，条目按下保留原生文件拖拽。 */
function pointerDown(event: PointerEvent) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('[data-ui="file-entry"],button'))
    return
  const rect = viewport.value!.getBoundingClientRect()
  boxStart = {
    clientX: event.clientX,
    clientY: event.clientY,
    scroll: scroll.value,
    selected: new Set(props.selected),
    add: event.ctrlKey || event.metaKey,
    pointer: event.pointerId,
  }
  box.value = {
    x: event.clientX - rect.left,
    y: event.clientY - rect.top + scroll.value,
    endX: event.clientX - rect.left,
    endY: event.clientY - rect.top + scroll.value,
  }
  viewport.value?.setPointerCapture?.(event.pointerId)
  viewport.value?.focus({ preventScroll: true })
  emit('interaction', true)
}
/** 框选期间持续处理边缘滚动，结束后不保留动画循环。 */
function updateBox() {
  animation = 0
  if (!boxStart || !box.value || !lastPointer || !viewport.value) return
  const rect = viewport.value.getBoundingClientRect()
  const edge =
    lastPointer.clientY < rect.top + 24 ? -12 : lastPointer.clientY > rect.bottom - 24 ? 12 : 0
  if (edge) {
    viewport.value.scrollTop += edge
    onScroll()
  }
  box.value.endX = Math.max(0, Math.min(width.value, lastPointer.clientX - rect.left))
  box.value.endY = Math.max(0, lastPointer.clientY - rect.top + scroll.value)
  const left = Math.min(box.value.x, box.value.endX),
    right = Math.max(box.value.x, box.value.endX)
  const top = Math.min(box.value.y, box.value.endY),
    bottom = Math.max(box.value.y, box.value.endY)
  const cell = width.value / columns.value
  const selected = new Set(boxStart.add ? boxStart.selected : [])
  if (
    Math.abs(lastPointer.clientX - boxStart.clientX) +
      Math.abs(lastPointer.clientY - boxStart.clientY) >
    4
  ) {
    const first = Math.max(0, Math.floor(top / rowHeight.value) * columns.value)
    const last = Math.min(
      props.entries.length,
      (Math.floor(bottom / rowHeight.value) + 1) * columns.value,
    )
    for (let index = first; index < last; index++)
      if (
        (index % columns.value) * cell + (props.view === 'icons' ? 4 : 0) < right &&
        ((index % columns.value) + 1) * cell - (props.view === 'icons' ? 4 : 8) > left &&
        Math.floor(index / columns.value) * rowHeight.value + (props.view === 'icons' ? 4 : 0) <
          bottom &&
        (Math.floor(index / columns.value) + 1) * rowHeight.value -
          (props.view === 'icons' ? 4 : 0) >
          top
      )
        selected.add(props.entries[index]!.path)
  }
  emit('select', selected)
  if (edge) animation = requestAnimationFrame(updateBox)
}
/** 合并指针更新，避免每个移动事件都计算框选。 */
function pointerMove(event: PointerEvent) {
  if (!boxStart) return
  lastPointer = event
  if (!animation) animation = requestAnimationFrame(updateBox)
}
/** 结束框选并允许父级执行延期的目录刷新。 */
function pointerUp(event?: PointerEvent) {
  if (!boxStart) return
  if (event) {
    lastPointer = event
    updateBox()
  }
  if (viewport.value?.hasPointerCapture?.(boxStart.pointer))
    viewport.value.releasePointerCapture(boxStart.pointer)
  boxStart = undefined
  box.value = undefined
  lastPointer = undefined
  cancelAnimationFrame(animation)
  animation = 0
  emit('interaction', false)
}
/** 将视图重排后的虚拟窗口与滚动边界同步。 */
function resetScroll() {
  if (viewport.value) viewport.value.scrollTop = 0
  scroll.value = 0
  focused.value = undefined
  anchor.value = undefined
}
watch(() => props.location, resetScroll)
watch([columns, rowHeight], () => {
  if (focused.value) {
    const index = props.entries.findIndex((e) => e.path === focused.value)
    if (index >= 0 && viewport.value)
      viewport.value.scrollTop = Math.floor(index / columns.value) * rowHeight.value
  }
  nextTick(onScroll)
})
watch(
  () => props.entries.length,
  () => nextTick(onScroll),
)
onMounted(() => {
  resize = new ResizeObserver((records) => {
    const rect = records[0]?.contentRect
    if (rect) {
      width.value = rect.width
      height.value = rect.height
      onScroll()
    }
  })
  if (viewport.value) resize.observe(viewport.value)
})
onBeforeUnmount(() => {
  pointerUp()
  resize?.disconnect()
  cancelAnimationFrame(animation)
})
defineExpose({ keyboard, resetScroll, focus: () => viewport.value?.focus() })
</script>

<template>
  <div class="file-content" data-ui="file-content" :class="view">
    <div
      v-if="view === 'details'"
      class="details-header"
      :style="{ width: Math.max(488, width - 8) + 'px' }"
      data-ui="file-details-header"
    >
      <button @click="emit('sort', 'name')">{{ t('app.fileManager.name') }}</button>
      <span>{{ t('app.fileManager.type') }}</span>
      <button @click="emit('sort', 'sizeBytes')">{{ t('app.fileManager.size') }}</button>
      <button @click="emit('sort', 'modifiedAt')">{{ t('app.fileManager.lastModified') }}</button>
    </div>
    <div
      ref="viewport"
      class="file-viewport"
      data-ui="file-grid"
      tabindex="0"
      role="listbox"
      :aria-label="t('fileBrowser.files')"
      aria-multiselectable="true"
      :aria-activedescendant="focusId"
      :aria-busy="loading"
      @scroll="onScroll"
      @keydown="keyboard"
      @pointerdown="pointerDown"
      @pointermove="pointerMove"
      @pointerup="pointerUp"
      @pointercancel="pointerUp()"
      @contextmenu.prevent="context(undefined, $event)"
      @dragover.prevent="emit('dragover', undefined, $event)"
      @drop.prevent.stop="emit('drop', undefined, $event)"
    >
      <div
        class="virtual-space"
        :style="{ height: Math.max(height, rows * rowHeight + (hasMore ? 40 : 0)) + 'px' }"
      >
        <div
          v-for="{ entry, index } in visible"
          :id="`${uid}-${index}`"
          :key="entry.path"
          class="file-entry"
          :class="{
            'is-selected': selected.has(entry.path),
            'is-focused': focused === entry.path,
            'is-cut': cutPaths.has(`${nodeId}:${entry.path}`),
            'is-drop-target': dropPath === entry.path,
          }"
          :style="{
            top: Math.floor(index / columns) * rowHeight + (view === 'icons' ? 4 : 0) + 'px',
            left: `calc(${((index % columns) * 100) / columns}% + ${view === 'icons' ? 4 : 0}px)`,
            width: `calc(${100 / columns}% - 8px)`,
            height: rowHeight - (view === 'icons' ? 8 : 0) + 'px',
          }"
          data-ui="file-entry"
          :data-path="entry.path"
          role="option"
          :aria-selected="selected.has(entry.path)"
          :draggable="!box"
          @click.stop="choose(entry, $event)"
          @dblclick.stop="emit('open', entry)"
          @contextmenu.prevent.stop="context(entry, $event)"
          @dragstart.stop="
            ($event) => {
              emit('interaction', true)
              emit('dragstart', entry, $event)
            }
          "
          @dragend.stop="
            () => {
              emit('interaction', false)
              emit('dragend')
            }
          "
          @dragover.prevent.stop="emit('dragover', entry, $event)"
          @drop.prevent.stop="emit('drop', entry, $event)"
        >
          <div class="entry-name" :title="entry.name">
            <FileEntryIcon :entry="entry" :size="view === 'icons' ? iconSize : 20" />
            <span class="entry-label" data-slot="file-name">{{ entry.name }}</span>
          </div>
          <template v-if="view === 'details'"
            ><span class="entry-type">{{
              t(
                `app.fileManager.${entry.kind === 'directory' ? 'dir' : entry.kind === 'symlink' ? 'symlink' : entry.kind === 'other' ? 'other' : 'file'}`,
              )
            }}</span
            ><span>{{ entry.kind === 'directory' ? '—' : formatBytes(entry.sizeBytes || 0) }}</span
            ><span>{{ entry.modifiedAt ? formatDateTime(entry.modifiedAt) : '—' }}</span></template
          >
        </div>
        <div v-if="loading || hasMore" class="load-more" :style="{ top: rows * rowHeight + 'px' }">
          <button v-if="hasMore && !loading" @click="emit('more')">
            {{ t('fileBrowser.loadMore') }}</button
          ><span v-else>{{ t('fileBrowser.loading') }}</span>
        </div>
        <div
          v-if="box"
          class="selection-box"
          :style="{
            left: Math.min(box.x, box.endX) + 'px',
            top: Math.min(box.y, box.endY) + 'px',
            width: Math.abs(box.endX - box.x) + 'px',
            height: Math.abs(box.endY - box.y) + 'px',
          }"
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.file-content {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  min-width: 0;
}
.file-viewport {
  overflow: auto;
  position: relative;
  flex: 1;
  min-height: 0;
  outline: none;
  user-select: none;
  touch-action: none;
}
.file-viewport:focus-visible {
  box-shadow: inset 0 0 0 2px var(--vdl-border-brand);
}
.virtual-space {
  position: relative;
}
.file-entry {
  position: absolute;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  padding: var(--vdl-space-2);
  border: 1px solid transparent;
  border-radius: var(--vdl-radius-md);
  cursor: default;
  overflow: hidden;
}
.file-entry:hover {
  background: var(--vdl-bg-hover);
}
.file-entry.is-selected {
  background: var(--vdl-bg-active);
  border-color: var(--vdl-border-brand);
}
.file-entry.is-focused {
  outline: 1px dotted var(--vdl-primary);
  outline-offset: -3px;
}
.file-entry.is-cut .entry-name {
  opacity: 0.45;
}
.file-entry.is-drop-target {
  background: var(--vdl-bg-active);
  border: 2px solid var(--vdl-primary);
}
.entry-name {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--vdl-space-2);
  min-width: 0;
  width: 100%;
}
.entry-label {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  overflow-wrap: anywhere;
  text-align: center;
  font-size: var(--vdl-font-caption);
  line-height: 18px;
  max-height: 36px;
  width: 100%;
}
.details-header,
.details .file-entry {
  display: grid;
  grid-template-columns: minmax(140px, 1fr) 64px 80px 140px;
  gap: var(--vdl-space-2);
  align-items: center;
}
.details-header {
  flex-shrink: 0;
  min-width: 488px;
  padding: var(--vdl-space-2);
  border-bottom: 1px solid var(--vdl-border-subtle);
  background: var(--vdl-bg-muted);
  font-size: var(--vdl-font-caption);
}
.details-header button {
  border: 0;
  padding: 0;
  font: inherit;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}
.details .file-entry {
  min-width: 488px;
  padding: 0 var(--vdl-space-2);
  border-radius: 0;
  border-bottom-color: var(--vdl-border-subtle);
  font-size: var(--vdl-font-caption);
}
.details .entry-name {
  flex-direction: row;
}
.details .entry-label {
  flex: 1;
  min-width: 0;
  width: auto;
  display: block;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
}
.details .file-entry > span {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.selection-box {
  position: absolute;
  pointer-events: none;
  background: color-mix(in srgb, var(--vdl-primary) 14%, transparent);
  border: 1px solid var(--vdl-primary);
  z-index: 2;
}
.load-more {
  position: absolute;
  height: 40px;
  left: 0;
  right: 0;
  text-align: center;
  padding: var(--vdl-space-2);
  font-size: var(--vdl-font-caption);
  color: var(--vdl-text-secondary);
}
.load-more button {
  border: 0;
  background: none;
  color: var(--vdl-primary);
  cursor: pointer;
}
</style>
