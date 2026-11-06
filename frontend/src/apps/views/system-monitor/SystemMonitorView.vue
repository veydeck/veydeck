<script setup lang="ts">
/**
 * @file SystemMonitorView.vue
 * @description 系统监控只读观测视图。
 */

import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { LineChart } from 'echarts/charts'
import {
  DataZoomComponent,
  GridComponent,
  LegendComponent,
  TooltipComponent,
} from 'echarts/components'
import { use } from 'echarts/core'
import { CanvasRenderer } from 'echarts/renderers'
import { useThemeStore, buildChartTheme } from '@/stores/theme'
import { useWindowManagerStore } from '@/stores/window-manager'
import { useSystemMonitor } from '@/composables/useSystemMonitor'
import {
  buildLoadChartOptions,
  buildCpuChartOptions,
  buildMemoryChartOptions,
  buildDiskIoChartOptions,
  buildNetworkChartOptions,
} from './chartOptions'
import MonitorChartPanel from './MonitorChartPanel.vue'
import MonitorCurrentValues from './MonitorCurrentValues.vue'
import { useSystemMonitorCurrent } from '@/composables/useSystemMonitorCurrent'
import { VeyAlert, VeyEmpty, VeyLoading, VeySelect, VeyTabs } from '@/components/ui'

use([
  LineChart,
  GridComponent,
  TooltipComponent,
  LegendComponent,
  DataZoomComponent,
  CanvasRenderer,
])

const LOADING_PLACEHOLDER_DELAY_MS = 200

const props = defineProps<{
  isMaximized?: boolean
  windowId?: string
  payload?: Record<string, unknown>
}>()

const { t } = useI18n()
const themeStore = useThemeStore()
const windowStore = useWindowManagerStore()
const {
  activeGroup,
  memoryType,
  series,
  seriesState,
  timeRange,
  hasSeriesData,
  labels,
  load1,
  load5,
  load15,
  cpu,
  memory,
  diskRead,
  diskWrite,
  netRx,
  netTx,
  diskScale,
  netScale,
  busy,
} = useSystemMonitor()
const {
  current,
  loading: currentLoading,
  error: currentError,
  stale: currentStale,
} = useSystemMonitorCurrent(activeGroup)

/** 只有当前节点已配置 Swap 时开放切换，未知采样不当作未配置。 */
const hasSwap = computed(
  () => current.value?.group === 'memory' && (current.value.metrics.swapTotalBytes ?? 0) > 0,
)
const memoryOptions = computed(() => [
  { value: 'physical', label: t('app.systemMonitor.memoryTypes.physical') },
  { value: 'swap', label: t('app.systemMonitor.memoryTypes.swap') },
])
watch(current, (snapshot) => {
  if (snapshot?.group === 'memory' && snapshot.metrics.swapTotalBytes === 0)
    memoryType.value = 'physical'
})
const rangeOptions = computed(() => [
  { value: '1h', label: t('app.systemMonitor.ranges.1h') },
  { value: '6h', label: t('app.systemMonitor.ranges.6h') },
  { value: '24h', label: t('app.systemMonitor.ranges.24h') },
  { value: '3d', label: t('app.systemMonitor.ranges.3d') },
  { value: '7d', label: t('app.systemMonitor.ranges.7d') },
])
const chartTheme = computed(() => buildChartTheme(themeStore.currentTheme))
const awaitingSeriesWithoutChart = computed(() => seriesState.value.loading)
const tabs = computed(() =>
  ['load', 'cpu', 'memory', 'diskIo', 'network'].map((name) => ({
    name,
    label: t(`app.systemMonitor.tabs.${name}`),
  })),
)
const showSeriesLoading = ref(false)
let seriesLoadingTimer: number | null = null
const collectionNotice = computed(() => {
  if (series.value?.collectionState === 'stopped')
    return t('app.systemMonitor.collectionStoppedNotice')
  if (series.value?.seriesStatus === 'stale') return t('app.systemMonitor.noRecentSamples')
  return ''
})
const emptyDescription = computed(() =>
  series.value?.collectionState === 'stopped'
    ? t('app.systemMonitor.collectionStopped')
    : t('app.systemMonitor.noHistory'),
)

watch(
  awaitingSeriesWithoutChart,
  (isAwaiting) => {
    if (seriesLoadingTimer !== null) {
      window.clearTimeout(seriesLoadingTimer)
      seriesLoadingTimer = null
    }
    showSeriesLoading.value = false
    if (!isAwaiting) return
    seriesLoadingTimer = window.setTimeout(() => {
      showSeriesLoading.value = true
      seriesLoadingTimer = null
    }, LOADING_PLACEHOLDER_DELAY_MS)
  },
  { immediate: true },
)

onBeforeUnmount(() => {
  if (seriesLoadingTimer !== null) window.clearTimeout(seriesLoadingTimer)
})

const loadChartOptions = computed(() =>
  buildLoadChartOptions(labels.value, load1.value, load5.value, load15.value, chartTheme.value, {
    load1: t('app.systemMonitor.charts.series.load1'),
    load5: t('app.systemMonitor.charts.series.load5'),
    load15: t('app.systemMonitor.charts.series.load15'),
  }),
)
const cpuChartOptions = computed(() =>
  buildCpuChartOptions(
    labels.value,
    cpu.value,
    chartTheme.value,
    t('app.systemMonitor.charts.series.cpu'),
  ),
)
const memoryChartOptions = computed(() =>
  buildMemoryChartOptions(
    labels.value,
    memory.value,
    chartTheme.value,
    t(
      memoryType.value === 'swap'
        ? 'app.systemMonitor.charts.series.swap'
        : 'app.systemMonitor.charts.series.memory',
    ),
  ),
)
const diskIoChartOptions = computed(() =>
  buildDiskIoChartOptions(
    labels.value,
    diskRead.value,
    diskWrite.value,
    diskScale.value,
    chartTheme.value,
    {
      read: t('app.systemMonitor.charts.series.read'),
      write: t('app.systemMonitor.charts.series.write'),
    },
  ),
)
const networkChartOptions = computed(() =>
  buildNetworkChartOptions(
    labels.value,
    netRx.value,
    netTx.value,
    netScale.value,
    chartTheme.value,
    {
      rx: t('app.systemMonitor.charts.series.rx'),
      tx: t('app.systemMonitor.charts.series.tx'),
    },
  ),
)

const activeChartOptions = computed(
  () =>
    ({
      load: loadChartOptions,
      cpu: cpuChartOptions,
      memory: memoryChartOptions,
      diskIo: diskIoChartOptions,
      network: networkChartOptions,
    })[activeGroup.value].value,
)

watch(
  busy,
  (isBusy) => {
    if (!props.windowId) return
    windowStore.updateWindowRuntimeState(props.windowId, {
      busy: isBusy,
      allowsNodeSwitch: true,
      blockLevel: 'open',
      blockReason: t('app.systemMonitor.guardOpen'),
    })
  },
  { immediate: true },
)
</script>

<template>
  <div class="system-monitor" data-page="system-monitoring" data-ui="monitoring-workspace">
    <div class="toolbar" data-ui="toolbar" data-slot="toolbar">
      <VeyTabs v-model="activeGroup" :tabs="tabs" class="monitor-tabs" data-ui="monitoring-tabs" />
      <VeySelect
        id="system-monitoring-range"
        v-model="timeRange"
        class="range-select"
        name="systemMonitoringRange"
        :aria-label="t('app.systemMonitor.timeRange')"
        :options="rangeOptions"
      />
    </div>

    <VeyAlert
      v-if="seriesState.warning"
      type="warning"
      :title="seriesState.warning"
      show-icon
      data-ui="refresh-warning"
    />
    <VeyAlert
      v-if="seriesState.error"
      type="error"
      :title="seriesState.error"
      show-icon
      data-ui="load-error"
    />
    <VeyAlert
      v-if="collectionNotice"
      type="warning"
      :title="collectionNotice"
      show-icon
      data-ui="collection-notice"
    />

    <div
      v-if="activeGroup === 'memory' && hasSwap"
      class="memory-controls"
      data-ui="memory-controls"
    >
      <VeySelect
        v-model="memoryType"
        class="memory-type-select"
        name="systemMonitoringMemoryType"
        :aria-label="t('app.systemMonitor.memoryType')"
        :options="memoryOptions"
        data-ui="memory-type-select"
      />
    </div>
    <div
      class="content"
      data-slot="content"
      data-ui="monitoring-panel"
      role="tabpanel"
      :aria-label="t(`app.systemMonitor.tabs.${activeGroup}`)"
      :data-group="activeGroup"
    >
      <div
        v-if="awaitingSeriesWithoutChart"
        class="series-loading-placeholder"
        aria-busy="true"
        data-ui="history-loading"
      >
        <VeyLoading
          v-if="showSeriesLoading"
          :loading="true"
          :text="t('app.systemMonitor.loading')"
        />
      </div>
      <VeyEmpty
        v-else-if="series && !hasSeriesData"
        class="history-empty"
        :description="emptyDescription"
        data-ui="history-empty"
      />
      <MonitorChartPanel
        v-else-if="hasSeriesData"
        :key="`${activeGroup}-${activeGroup === 'memory' ? memoryType : ''}`"
        :title="
          t(
            activeGroup === 'memory' && memoryType === 'swap'
              ? 'app.systemMonitor.charts.swap'
              : `app.systemMonitor.charts.${activeGroup}`,
          )
        "
        :options="activeChartOptions"
        :data-group="activeGroup"
        data-slot="active-chart"
      />
    </div>
    <MonitorCurrentValues
      :group="activeGroup"
      :snapshot="current"
      :memory-type="memoryType"
      :loading="currentLoading"
      :error="currentError"
      :stale="currentStale"
    />
  </div>
</template>

<style scoped>
.system-monitor {
  height: 100%;
  min-height: 0;
  padding: var(--vdl-space-3);
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
  overflow: hidden;
  background: var(--vdl-bg-canvas);
}

.toolbar {
  display: flex;
  align-items: center;
  flex-shrink: 0;
  gap: var(--vdl-space-3);
  min-width: 0;
}

.monitor-tabs {
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  scrollbar-width: thin;
}

.monitor-tabs :deep(.vl-tabs-nav) {
  width: max-content;
  min-width: 100%;
  gap: var(--vdl-space-2);
}

.monitor-tabs :deep(.vl-tabs-item) {
  flex-shrink: 0;
}

.range-select {
  width: 130px;
  flex: 0 0 130px;
}

.memory-controls {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}

.memory-type-select {
  width: 166px;
  flex: 0 0 166px;
}

.content {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}

.history-empty {
  flex: 1;
  min-width: 0;
}

.series-loading-placeholder {
  flex: 1;
  min-height: 0;
  display: flex;
}

.series-loading-placeholder > :deep(*) {
  width: 100%;
}

@media (max-width: 640px) {
  .toolbar {
    gap: var(--vdl-space-2);
  }

  .range-select {
    width: 120px;
    flex-basis: 120px;
  }
}
</style>
