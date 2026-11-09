<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import ApplicationDialog from '@/components/layout/ApplicationDialog.vue'
import FileEntryIcon from './FileEntryIcon.vue'
import { VeyButton, VeyDescriptions, VeyLoading, VeyTooltip } from '@/components/ui'
import VeyIcon from '@/components/icons/VeyIcon.vue'
import { useFileProperties } from '@/composables/useFileProperties'
import { formatBytes } from '@/utils/units'
import { formatDateTime } from '@/utils/time'
import { localizeErrorSummary } from '@/api/error'

/** 单个文件或目录的窗口级只读属性；实例卸载即释放查询与临时统计。 */
const props = defineProps<{ nodeId: string; nodeName: string; path: string }>()
const emit = defineEmits<{ close: [] }>()
const visible = ref(true)
const { t } = useI18n()
const {
  detail, statistics, loading, starting, error, statisticsError, connectionError, trackingStopped,
  load, calculate, cancel,
} = useFileProperties(props.nodeId, props.path)
const copied = ref(false)
const copying = ref(false)
const copyError = ref('')
let copyTimer: ReturnType<typeof setTimeout> | undefined
let disposed = false
const isDirectory = computed(() => detail.value?.kind === 'directory' ||
  (detail.value?.kind === 'symlink' && detail.value.symlinkTargetKind === 'directory' && !detail.value.symlinkError))
const running = computed(() => ['running', 'cancelling'].includes(statistics.value?.status || ''))
const typeLabel = computed(() => {
  const entry = detail.value
  if (!entry) return ''
  if (entry.kind !== 'file') return t(`app.fileManager.${entry.kind === 'directory' ? 'dir' : entry.kind}`)
  const extension = entry.name.includes('.') ? entry.name.split('.').pop() : undefined
  return extension ? t('fileProperties.fileType', { extension: extension.toUpperCase() }) : t('app.fileManager.file')
})

/** 同时提供可读单位与准确字节数，零字节不显示为空值。 */
function bytes(value: number): string {
  return `${formatBytes(value)} (${value.toLocaleString()} ${t('fileProperties.bytes')})`
}

/** 路径始终使用当前查看的逻辑路径，不替换为链接的真实目标。 */
const basicItems = computed(() => {
  const entry = detail.value
  if (!entry) return []
  const items = [
    { label: t('fileProperties.node'), value: props.nodeName },
    { label: t('fileProperties.path'), slot: 'path' },
    { label: t('fileProperties.type'), value: typeLabel.value },
  ]
  if (entry.kind === 'file') {
    items.push({ label: t('fileProperties.size'), value: bytes(entry.sizeBytes ?? 0) })
  }
  if (!isDirectory.value) {
    items.push({ label: t('fileProperties.allocated'), value: bytes(entry.allocatedBytes) })
  }
  items.push(
    { label: t('fileProperties.modified'), value: formatDateTime(entry.modifiedAt) },
    { label: t('fileProperties.created'), value: entry.createdAt ? formatDateTime(entry.createdAt) : t('fileProperties.unsupported') },
    { label: t('fileProperties.accessed'), value: formatDateTime(entry.accessedAt) },
  )
  return items
})
const ownerItems = computed(() => detail.value ? [
  { label: t('fileProperties.owner'), value: detail.value.userName ? `${detail.value.userName} (${detail.value.uid})` : String(detail.value.uid) },
  { label: t('fileProperties.group'), value: detail.value.groupName ? `${detail.value.groupName} (${detail.value.gid})` : String(detail.value.gid) },
  { label: t('fileProperties.mode'), value: (detail.value.mode & 0o7777).toString(8).padStart(4, '0') },
] : [])
const linkItems = computed(() => detail.value?.kind === 'symlink' ? [
  { label: t('fileProperties.target'), slot: 'target' },
  { label: t('fileProperties.targetType'), value: detail.value.symlinkTargetKind ? t(`app.fileManager.${detail.value.symlinkTargetKind === 'directory' ? 'dir' : detail.value.symlinkTargetKind}`) : t('fileProperties.unknown') },
  { label: t('fileProperties.linkStatus'), value: detail.value.symlinkError ? localizeErrorSummary(detail.value.symlinkError) : detail.value.symlinkTargetKind ? t('fileProperties.linkAvailable') : t('fileProperties.unknown') },
] : [])
const statisticsItems = computed(() => statistics.value ? [
  { label: t('fileProperties.size'), value: bytes(statistics.value.logicalBytes) },
  { label: t('fileProperties.allocated'), value: bytes(statistics.value.allocatedBytes) },
  { label: t('fileProperties.contents'), value: t('fileProperties.counts', { files: statistics.value.fileCount, directories: statistics.value.directoryCount, links: statistics.value.symlinkCount }) },
] : [])

/** 复制成功后在按钮内显示三秒勾选图标，重复复制重新计时；失败不误报成功。 */
async function copyPath() {
  if (copying.value) return
  copying.value = true
  copyError.value = ''
  try {
    await navigator.clipboard.writeText(props.path)
    if (disposed) return
    copied.value = true
    clearTimeout(copyTimer)
    copyTimer = setTimeout(() => { copied.value = false }, 3000)
  } catch {
    if (disposed) return
    clearTimeout(copyTimer)
    copied.value = false
    copyError.value = t('app.fileManager.copyPathUnsupported')
  } finally {
    if (!disposed) copying.value = false
  }
}

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(copyTimer)
})

/** 先走窗口对话框的关闭生命周期恢复焦点，再卸载实例并释放统计。 */
async function requestClose() {
  if (!visible.value) return
  visible.value = false
  await nextTick()
  emit('close')
}
</script>

<template>
  <ApplicationDialog
    :visible="visible" :title="t('fileProperties.title')" width="620px"
    initial-focus-selector="[data-ui='file-properties-close']"
    return-focus-selector="[data-ui='file-grid']" @close="requestClose"
  >
    <div class="properties" data-ui="file-properties" :aria-busy="loading">
      <VeyLoading v-if="loading" :loading="true" :text="t('fileBrowser.loading')" />
      <div v-else-if="error" role="alert" data-slot="error">{{ error }}</div>
      <template v-else-if="detail">
        <div class="summary" data-slot="summary">
          <FileEntryIcon :entry="detail" :size="48" />
          <div class="name">{{ detail.name }}</div>
        </div>
        <VeyDescriptions :items="basicItems" :column="1" :glass="false" data-slot="basic">
          <template #path>
            <div class="copy-path">
              <VeyButton size="small" type="secondary" :disabled="copying" data-ui="file-properties-copy-path" @click="copyPath">
                <span class="copy-button-content">
                  <span v-if="copied" class="copy-check" aria-hidden="true"><VeyIcon name="success" :size="12" data-slot="copy-success" /></span>
                  {{ t('app.fileManager.copyPath') }}
                </span>
              </VeyButton>
              <span role="status" class="sr-only">{{ copied ? t('fileProperties.copied') : '' }}</span>
              <div v-if="copyError" role="alert">{{ copyError }}</div>
            </div>
          </template>
        </VeyDescriptions>
        <div v-if="isDirectory" class="section" data-slot="statistics" :aria-busy="starting || running">
          <div class="section-heading">
            <strong>{{ detail.kind === 'symlink' ? t('fileProperties.targetStatistics') : t('fileProperties.directoryStatistics') }}</strong>
            <VeyButton v-if="running && !trackingStopped" size="small" type="secondary" :disabled="statistics?.status === 'cancelling'" data-ui="file-statistics-cancel" @click="cancel">{{ t('fileProperties.cancel') }}</VeyButton>
            <VeyButton v-else size="small" type="secondary" :disabled="starting" data-ui="file-statistics-start" @click="calculate">{{ statistics ? t('fileProperties.recalculate') : t('fileProperties.calculate') }}</VeyButton>
          </div>
          <div v-if="connectionError" role="alert" class="muted">{{ t('fileProperties.connectionError') }}</div>
          <div v-if="statistics?.status === 'failed'" role="alert">{{ t('fileProperties.scanFailed') }}</div>
          <VeyDescriptions v-if="statistics" :items="statisticsItems" :column="1" :glass="false" />
          <div v-if="statistics?.partial" class="warning" data-slot="partial">
            {{ t('fileProperties.partial') }}
            {{ t('fileProperties.skipped', { mounts: statistics.skippedMountCount, unreadable: statistics.unreadableCount, vanished: statistics.vanishedCount, special: statistics.specialCount }) }}
            <details v-if="statistics.errors.length"><summary>{{ t('fileProperties.errorDetails') }}</summary><div v-for="(failure, index) in statistics.errors" :key="index">{{ failure.path }} · {{ localizeErrorSummary(failure.code) }}</div></details>
          </div>
          <div v-if="statisticsError" role="alert">{{ statisticsError }}</div>
        </div>
        <div v-if="linkItems.length" class="section" data-slot="link">
          <VeyDescriptions :items="linkItems" :column="1" :glass="false">
            <template #target>
              <VeyTooltip v-if="detail.symlinkTarget" :text="detail.symlinkTarget" position="top" class="target-tooltip" data-ui="file-properties-link-target">
                <span class="target-path">{{ detail.symlinkTarget }}</span>
              </VeyTooltip>
              <span v-else>{{ t('fileProperties.unknown') }}</span>
            </template>
          </VeyDescriptions>
        </div>
        <div class="section" data-slot="permissions">
          <VeyDescriptions :items="ownerItems" :column="1" :glass="false" />
        </div>
      </template>
    </div>
    <template #footer>
      <VeyButton type="secondary" :disabled="loading" data-ui="file-properties-refresh" @click="load">{{ t('fileBrowser.refresh') }}</VeyButton>
      <VeyButton type="primary" data-ui="file-properties-close" @click="requestClose">{{ t('fileProperties.close') }}</VeyButton>
    </template>
  </ApplicationDialog>
</template>

<style scoped>
.properties { min-width: 0; overflow-wrap: anywhere; color: var(--vdl-text-primary); font-size: var(--vdl-font-body-sm); }
.summary { display: flex; gap: var(--vdl-space-3); align-items: center; margin-bottom: var(--vdl-space-4); }
.summary > div { min-width: 0; }
.name { font-weight: 600; }
.muted { color: var(--vdl-text-secondary); }
.copy-path { min-width: 0; }
.copy-button-content { display: inline-flex; align-items: center; gap: var(--vdl-space-1); }
.copy-check { display: inline-flex; align-items: center; justify-content: center; width: 12px; height: 12px; flex-shrink: 0; color: var(--vdl-success); }
.target-tooltip { display: block; width: 100%; min-width: 0; }
.target-path { display: block; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
.section { margin-top: var(--vdl-space-4); padding-top: var(--vdl-space-3); border-top: 1px solid var(--vdl-border-subtle); }
.section-heading { display: flex; align-items: center; justify-content: space-between; gap: var(--vdl-space-2); margin-bottom: var(--vdl-space-2); }
.warning { color: var(--vdl-text-secondary); margin-top: var(--vdl-space-2); }
</style>
