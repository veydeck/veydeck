<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { VeyButton, VeyEmpty, VeyTabs, VeyTag } from '@/components/ui'
import AppContextMenu from '@/components/AppContextMenu.vue'
import VeyTable, { type VeyTableColumn } from '@/components/ui/VeyTable.vue'
import VeyIcon from '@/components/icons/VeyIcon.vue'
import { useTaskCenterStore, isTaskActive, type CenterTask } from '@/stores/task-center'
import { useNodeStore } from '@/stores/node'
import { formatBytes } from '@/utils/units'
import { formatDateTime } from '@/utils/time'

/** 任务中心应用：窗口只消费全局任务状态，关闭或最小化不会影响执行。 */
const center = useTaskCenterStore()
const nodes = useNodeStore()
const { t } = useI18n()
const detailsId = ref<string>()
const tabs = computed(() =>
  (['files', 'other'] as const).map((name) => {
    const count = center.tasks.filter((task) => task.category === name && isTaskActive(task)).length
    return { name, label: t(`taskCenter.${name}`) + (count ? ` (${count})` : '') }
  }),
)
const shown = computed(() =>
  center.sortedTasks.filter((task) => task.category === center.selectedTab),
)
const details = computed(() => shown.value.find((task) => task.id === detailsId.value))
const hasFinished = computed(() => shown.value.some((task) => !isTaskActive(task)))
const columns = computed<VeyTableColumn[]>(() => [
  { label: t('taskCenter.columns.name'), slot: 'name', minWidth: 140, headerAlign: 'left' },
  { label: t('taskCenter.columns.progress'), slot: 'progress', width: 180, headerAlign: 'left' },
  { label: t('taskCenter.columns.status'), slot: 'status', width: 140, headerAlign: 'left' },
  { label: t('taskCenter.columns.actions'), slot: 'actions', width: 100, align: 'right' },
])
/** 本地节点使用统一名称，外部节点按当前目录解析。 */
function nodeLabel(nodeId: string) {
  return nodeId === 'local'
    ? t('desktop.header.localNode')
    : nodes.nodes.find((node) => node.id === nodeId)?.name || nodeId
}
/** 状态文字和颜色共同表达执行结果。 */
function statusType(task: CenterTask) {
  if (task.status === 'failed' || task.status === 'expired') return 'danger'
  if (task.status === 'partial' || task.status === 'cancelling' || task.connectionError)
    return 'warning'
  if (!isTaskActive(task)) return task.status === 'cancelled' ? 'default' : 'success'
  return 'primary'
}
/** 下载只承诺服务端传输完成。 */
function statusText(task: CenterTask) {
  return task.kind === 'download' && task.status === 'completed'
    ? t('taskCenter.transferCompleted')
    : t(`taskCenter.status.${task.status}`)
}
/** 清理提交阶段不再提供取消入口。 */
function canCancel(task: CenterTask) {
  return (
    isTaskActive(task) &&
    task.kind !== 'download' &&
    !['cleaningUp', 'completed'].includes(task.stage || '')
  )
}
/** 详情和终态清理集中到行菜单，避免常驻多组按钮。 */
function actions(task: CenterTask) {
  return [
    {
      label: t('taskCenter.details'),
      icon: 'info',
      handler: () => {
        detailsId.value = task.id
      },
    },
    ...(!isTaskActive(task)
      ? [{ label: t('taskCenter.remove'), icon: 'trash', handler: () => center.remove(task.id) }]
      : []),
  ]
}
/** 行菜单使用轻量浮层，支持键盘导航和关闭后的焦点恢复。 */
const menu = ref<{ task: CenterTask; x: number; y: number; trigger: HTMLElement }>()
const menuElement = ref<HTMLElement>()
async function openMenu(task: CenterTask, event: MouseEvent) {
  const trigger = event.currentTarget as HTMLElement
  const bounds = trigger.getBoundingClientRect()
  menu.value = {
    task,
    trigger,
    x: Math.max(8, Math.min(bounds.right - 160, window.innerWidth - 168)),
    y: Math.max(8, Math.min(bounds.bottom + 4, window.innerHeight - 100)),
  }
  await nextTick()
  menuElement.value?.querySelector<HTMLButtonElement>('button')?.focus()
}
/** 关闭菜单并恢复触发按钮焦点。 */
function closeMenu() {
  const trigger = menu.value?.trigger
  menu.value = undefined
  if (trigger?.isConnected) trigger.focus()
}
/** 执行当前行操作并关闭菜单。 */
function runMenuAction(action: { handler: () => void }) {
  action.handler()
  closeMenu()
}
/** 菜单键盘操作保持在当前菜单内。 */
function handleMenuKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    event.stopPropagation()
    closeMenu()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(menuElement.value?.querySelectorAll<HTMLButtonElement>('button') || [])
  const index = buttons.findIndex((button) => button === document.activeElement)
  const next =
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[next]?.focus()
}
onMounted(() => window.addEventListener('resize', closeMenu))
onUnmounted(() => window.removeEventListener('resize', closeMenu))

/** 上传下载的活动阶段才显示当前采样速度。 */
function speedText(task: CenterTask) {
  if (
    !isTaskActive(task) ||
    task.connectionError ||
    !['uploading', 'streaming', 'receiving'].includes(task.status)
  )
    return ''
  return task.bytesPerSecond === undefined
    ? t('taskCenter.calculatingSpeed')
    : `${formatBytes(task.bytesPerSecond)}/s`
}
</script>

<template>
  <div class="task-center-view" data-page="task-center" data-veydeck-app="task-center">
    <div class="task-tabs" data-slot="header">
      <VeyTabs v-model="center.selectedTab" :tabs="tabs" data-ui="task-center-tabs" />
    </div>
    <div class="task-toolbar" data-slot="toolbar">
      <VeyButton
        size="small"
        type="secondary"
        :disabled="!hasFinished"
        data-ui="task-center-clear"
        @click="center.clearFinished(center.selectedTab)"
        >{{ t('taskCenter.clear') }}</VeyButton
      >
      <span class="history-hint">{{ t('taskCenter.sessionHistory') }}</span>
    </div>
    <div
      class="task-table-region"
      data-slot="task-list"
      role="tabpanel"
      :aria-label="t(`taskCenter.${center.selectedTab}`)"
    >
      <VeyTable :data="shown" :columns="columns" row-key="id" data-ui="task-center-table">
        <template #name="{ row }">
          <div
            class="task-name-cell"
            data-ui="task-center-row"
            :data-task-id="row.id"
            :data-node-id="row.nodeId"
            :data-status="row.status"
          >
            <VeyIcon
              :name="
                row.kind === 'upload'
                  ? 'upload'
                  : row.kind === 'download'
                    ? 'download'
                    : row.kind === 'remove'
                      ? 'trash'
                      : row.kind === 'copy'
                        ? 'copy'
                        : 'folder'
              "
              :size="18"
            />
            <div class="task-name-content">
              <div class="task-title" :title="row.name">{{ row.name }}</div>
              <div class="task-secondary" :title="`${nodeLabel(row.nodeId)} · ${row.path}`">
                {{ t(`taskCenter.kind.${row.kind}`) }} · {{ nodeLabel(row.nodeId) }} ·
                {{ row.path }}
              </div>
            </div>
          </div>
        </template>
        <template #progress="{ row }">
          <div class="task-progress-cell">
            <div class="task-progress-line">
              <progress
                v-if="isTaskActive(row) || row.progress !== undefined"
                :value="row.progress"
                max="100"
                :aria-label="t('taskCenter.progress', { name: row.name })"
              />
              <span v-if="row.progress !== undefined" class="task-progress-percent"
                >{{ row.progress }}%</span
              >
              <span v-else class="task-secondary">{{
                row.stage ? t(`taskCenter.stage.${row.stage}`) : statusText(row)
              }}</span>
            </div>
            <div class="task-secondary task-byte-count">
              {{ formatBytes(row.transferredBytes) }} / {{ formatBytes(row.totalBytes) }}
            </div>
          </div>
        </template>
        <template #status="{ row }">
          <div class="task-status-cell">
            <VeyTag :type="statusType(row)" size="small" effect="plain">{{
              statusText(row)
            }}</VeyTag>
            <span v-if="speedText(row)" class="task-secondary" data-slot="transfer-speed">{{
              speedText(row)
            }}</span>
            <span v-if="row.connectionError" class="task-warning">{{
              t('taskCenter.connectionError')
            }}</span>
            <span
              v-else-if="row.error || row.actionError"
              class="task-error task-error-summary"
              :title="row.error || row.actionError"
              >{{ row.error || row.actionError }}</span
            >
          </div>
        </template>
        <template #actions="{ row }">
          <div class="task-actions">
            <VeyButton
              v-if="canCancel(row)"
              size="small"
              type="secondary"
              :disabled="row.status === 'cancelling'"
              :aria-label="t('taskCenter.cancel')"
              class="task-icon-button"
              data-ui="task-center-cancel"
              @click="center.cancel(row.id)"
              ><VeyIcon name="x" :size="14"
            /></VeyButton>
            <VeyButton
              size="small"
              type="secondary"
              :aria-label="t('taskCenter.columns.actions')"
              aria-haspopup="menu"
              :aria-expanded="menu?.task.id === row.id"
              class="task-icon-button"
              data-ui="task-center-menu"
              @click="openMenu(row, $event)"
              ><VeyIcon name="more-horizontal" :size="16"
            /></VeyButton>
          </div>
        </template>
        <template #empty
          ><VeyEmpty
            :description="
              t(center.selectedTab === 'files' ? 'taskCenter.emptyFiles' : 'taskCenter.emptyOther')
            "
        /></template>
      </VeyTable>
    </div>
    <AppContextMenu :visible="!!menu" :x="menu?.x || 0" :y="menu?.y || 0" @close="closeMenu">
      <div ref="menuElement" role="menu" data-ui="task-center-actions" @keydown="handleMenuKeydown">
        <button
          v-for="action in menu ? actions(menu.task) : []"
          :key="action.label"
          type="button"
          role="menuitem"
          class="context-menu-btn"
          @click="runMenuAction(action)"
        >
          {{ action.label }}
        </button>
      </div>
    </AppContextMenu>
    <div v-if="details" class="task-details" data-ui="task-center-details">
      <div class="task-details-heading">
        <strong>{{ details.name }}</strong
        ><VeyButton
          size="small"
          type="secondary"
          :aria-label="t('common.close')"
          @click="detailsId = undefined"
          ><VeyIcon name="x" :size="14"
        /></VeyButton>
      </div>
      <span>{{ nodeLabel(details.nodeId) }} · {{ details.path }}</span>
      <span>{{
        t('taskCenter.fileCounts', {
          completed: details.completedFiles,
          failed: details.failedFiles,
          total: details.totalFiles,
        })
      }}</span>
      <span v-if="details.currentFile">{{ details.currentFile }}</span>
      <span v-if="details.stage">{{ t(`taskCenter.stage.${details.stage}`) }}</span>
      <span>{{ t('taskCenter.createdAt') }}: {{ formatDateTime(details.createdAt) }}</span>
      <span v-if="details.finishedAt"
        >{{ t('taskCenter.finishedAt') }}: {{ formatDateTime(details.finishedAt) }}</span
      >
      <span>{{ t('taskCenter.taskId') }}: {{ details.serverId || details.id }}</span>
      <span v-if="details.connectionError" class="task-warning">{{ details.connectionError }}</span>
      <span v-if="details.cleanupWarning" class="task-warning">{{ details.cleanupWarning }}</span>
      <span v-if="details.error || details.actionError" class="task-error">{{
        details.error || details.actionError
      }}</span>
      <span v-for="(failure, index) in details.failures" :key="index" class="task-error"
        >{{ failure.path }}: {{ failure.message }}</span
      >
    </div>
  </div>
</template>

<style scoped>
.task-center-view {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--vdl-bg-panel);
  color: var(--vdl-text-primary);
}
.task-tabs {
  flex-shrink: 0;
  padding: var(--vdl-space-2) var(--vdl-space-4) 0;
}
.task-toolbar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: var(--vdl-space-3);
  padding: var(--vdl-space-3) var(--vdl-space-4);
}
.history-hint {
  margin-left: auto;
  font-size: var(--vdl-font-caption);
  color: var(--vdl-text-muted);
}
.task-table-region :deep(.vl-table) {
  table-layout: fixed;
  min-width: 560px;
}
.task-table-region {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0 var(--vdl-space-4) var(--vdl-space-4);
}
.task-name-cell,
.task-actions {
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
}
.task-name-cell > svg {
  flex-shrink: 0;
  color: var(--vdl-text-secondary);
}
.task-name-content {
  min-width: 0;
  flex: 1;
}
.task-title,
.task-secondary,
.task-error-summary {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.task-title {
  color: var(--vdl-text-primary);
  font-size: var(--vdl-font-body-sm);
}
.task-secondary {
  color: var(--vdl-text-muted);
  font-size: var(--vdl-font-caption);
  line-height: 1.6;
}
.task-progress-cell {
  display: grid;
  gap: var(--vdl-space-1);
  padding-right: var(--vdl-space-4);
}
.task-progress-line {
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
  min-width: 0;
}
.task-progress-percent {
  flex-shrink: 0;
  min-width: 3.2em;
  text-align: right;
  color: var(--vdl-text-muted);
  font-size: var(--vdl-font-caption);
  font-variant-numeric: tabular-nums;
  line-height: 1;
}
.task-icon-button.task-icon-button {
  width: 26px;
  height: 26px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  line-height: 1;
}
.task-icon-button :deep(.vl-icon) {
  display: flex;
  align-items: center;
  justify-content: center;
  vertical-align: initial;
}
.task-progress-cell progress {
  flex: 1;
  min-width: 0;
  width: 100%;
  height: 5px;
  appearance: none;
  border: 0;
  border-radius: var(--vdl-radius-pill);
  overflow: hidden;
  accent-color: var(--vdl-primary);
}
.task-progress-cell progress::-webkit-progress-bar {
  background: var(--vdl-border-subtle);
  border-radius: inherit;
}
.task-progress-cell progress::-webkit-progress-value {
  background: var(--vdl-primary);
  border-radius: inherit;
}
.task-progress-cell progress::-moz-progress-bar {
  background: var(--vdl-primary);
  border-radius: inherit;
}
.task-progress-cell progress:indeterminate {
  appearance: auto;
}
.task-status-cell {
  display: grid;
  justify-items: start;
  gap: var(--vdl-space-1);
}
.task-actions {
  justify-content: flex-end;
}
.task-details {
  flex-shrink: 0;
  max-height: 40%;
  overflow: auto;
  display: grid;
  gap: var(--vdl-space-2);
  padding: var(--vdl-space-3) var(--vdl-space-4);
  border-top: 1px solid var(--vdl-border-subtle);
  font-size: var(--vdl-font-caption);
  overflow-wrap: anywhere;
}
.task-details-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--vdl-space-3);
}
.task-details-heading strong {
  min-width: 0;
}
.task-warning {
  color: var(--vdl-warning);
  font-size: var(--vdl-font-caption);
}
.task-error {
  color: var(--vdl-danger);
  font-size: var(--vdl-font-caption);
}
@media (max-width: 700px) {
  .history-hint {
    display: none;
  }
}
</style>
