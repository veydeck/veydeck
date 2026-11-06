<script setup lang="ts">
/**
 * @file MonitorCurrentValues.vue
 * @description 当前标签页的实时资源数值与内存构成条。
 */
import { computed } from 'vue'
import { VeyTooltip } from '@/components/ui'
import { useI18n } from 'vue-i18n'
import { useThemeStore, buildChartTheme } from '@/stores/theme'
import type { SystemMonitoringCurrent } from '@/api/generated'
import { formatBytes, formatScaledThroughput, resolveThroughputUnit } from '@/utils/units'

type MetricKeys<T> = T extends unknown ? keyof T : never
type MetricKey = MetricKeys<SystemMonitoringCurrent['metrics']>
type ValueFormat = 'load' | 'percent' | 'bytes' | 'rate'
const props = defineProps<{
  memoryType?: 'physical' | 'swap'
  group: SystemMonitoringCurrent['group']
  snapshot: SystemMonitoringCurrent | null
  loading: boolean
  error: string
  stale: boolean
}>()
const { t } = useI18n()
const themeStore = useThemeStore()
const chartTheme = computed(() => buildChartTheme(themeStore.currentTheme))

/** 当前分组应展示的字段顺序与数值格式。 */
const fields = computed<Array<[MetricKey, ValueFormat]>>(() => {
  switch (props.group) {
    case 'load':
      return [
        ['loadAverage1m', 'load'],
        ['loadAverage5m', 'load'],
        ['loadAverage15m', 'load'],
      ]
    case 'cpu':
      return [
        ['cpuPercent', 'percent'],
        ['userPercent', 'percent'],
        ['systemPercent', 'percent'],
        ['ioWaitPercent', 'percent'],
      ]
    case 'memory':
      return [
        ['usagePercent', 'percent'],
        ['totalBytes', 'bytes'],
        ['usedBytes', 'bytes'],
        ...(props.memoryType === 'swap'
          ? []
          : [['availableBytes', 'bytes'] as [MetricKey, ValueFormat]]),
      ]
    case 'diskIo':
      return [
        ['diskReadBytesPerSecond', 'rate'],
        ['diskWriteBytesPerSecond', 'rate'],
      ]
    case 'network':
      return [
        ['networkReceiveBytesPerSecond', 'rate'],
        ['networkTransmitBytesPerSecond', 'rate'],
      ]
  }
  return []
})
/** 主读数与辅助读数按资源语义分组。 */
const primaryFields = computed(() =>
  props.group === 'cpu' ? fields.value.slice(0, 1) : fields.value,
)
const secondaryFields = computed(() => (props.group === 'cpu' ? fields.value.slice(1) : []))

/** 内存摘要保持中性色，其他资源读数与对应历史曲线同色。 */
const metricStyle = (key: MetricKey) => {
  const colors: Partial<Record<MetricKey, string>> = {
    loadAverage1m: chartTheme.value.primary,
    loadAverage5m: chartTheme.value.success,
    loadAverage15m: chartTheme.value.warning,
    cpuPercent: chartTheme.value.primary,
    diskReadBytesPerSecond: chartTheme.value.primary,
    diskWriteBytesPerSecond: chartTheme.value.success,
    networkReceiveBytesPerSecond: chartTheme.value.primary,
    networkTransmitBytesPerSecond: chartTheme.value.warning,
  }
  return {
    '--metric-accent': colors[key] ?? 'var(--vdl-border-default)',
    '--metric-value-color': colors[key]
      ? `color-mix(in srgb, ${colors[key]} 55%, var(--vdl-text-primary))`
      : 'var(--vdl-text-primary)',
  }
}

const metrics = computed<Partial<Record<MetricKey, number | null>>>(() => {
  if (props.snapshot?.group !== props.group) return {}
  if (props.snapshot.group === 'memory' && props.memoryType === 'swap') {
    const memory = props.snapshot.metrics
    return {
      totalBytes: memory.swapTotalBytes,
      usedBytes: memory.swapUsedBytes,
      usagePercent: memory.swapPercent,
      freeBytes: memory.swapFreeBytes,
    }
  }
  return props.snapshot.metrics
})

/** 格式化真实零值与缺失值，容量和吞吐量使用项目统一单位。 */
const formatValue = (key: MetricKey, format: ValueFormat) => {
  const value = metrics.value[key]
  if (value === null || value === undefined || !Number.isFinite(value)) return '—'
  switch (format) {
    case 'load':
      return value.toFixed(2).replace(/\.?0+$/, '')
    case 'percent':
      return `${value.toFixed(1)}%`
    case 'bytes':
      return formatBytes(value)
    case 'rate': {
      const scale = resolveThroughputUnit([value])
      return `${formatScaledThroughput(value, scale.base)} ${scale.unit}`
    }
  }
}
/** 构成项由服务端使用同次采样计算，保留与可用估计不同的口径。 */
const memorySegments = computed(() => {
  const snapshot = props.snapshot
  if (props.group !== 'memory' || snapshot?.group !== 'memory') return []
  const memory = snapshot.metrics
  const total = props.memoryType === 'swap' ? memory.swapTotalBytes : memory.totalBytes
  if (total == null || total <= 0) return []
  const segments =
    props.memoryType === 'swap'
      ? [
          {
            key: 'usedBytes' as const,
            bytes: memory.swapUsedBytes,
            color: chartTheme.value.primary,
          },
          {
            key: 'freeBytes' as const,
            bytes: memory.swapFreeBytes,
            color: 'var(--vdl-border-strong)',
          },
        ]
      : [
          {
            key: 'otherUsedBytes' as const,
            bytes: memory.otherUsedBytes,
            color: chartTheme.value.primary,
          },
          { key: 'buffersBytes' as const, bytes: memory.buffersBytes, color: 'var(--vdl-info)' },
          {
            key: 'cachedBytes' as const,
            bytes: memory.cachedBytes,
            color: chartTheme.value.warning,
          },
          { key: 'freeBytes' as const, bytes: memory.freeBytes, color: 'var(--vdl-border-strong)' },
        ]
  if (segments.some((segment) => segment.bytes == null)) return []
  return segments.map((segment) => ({
    ...segment,
    bytes: segment.bytes!,
    percent: (segment.bytes! / total) * 100,
  }))
})
const compositionDescription = computed(
  () =>
    `${t('app.systemMonitor.current.compositionTitle')}: ${memorySegments.value.map((segment) => `${t(`app.systemMonitor.current.metrics.${segment.key}`)} ${formatBytes(segment.bytes)}`).join(', ')}`,
)
const notice = computed(() => {
  const warnings = [props.error, props.stale ? t('app.systemMonitor.current.stale') : ''].filter(
    Boolean,
  )
  if (warnings.length) return warnings.join(' · ')
  if (props.loading) return t('app.systemMonitor.current.loading')
  if (props.snapshot?.status === 'unavailable') return t('app.systemMonitor.current.unavailable')
  return ''
})
</script>

<template>
  <div
    class="current-values"
    data-ui="current-values"
    role="region"
    :data-group="group"
    :data-memory-type="group === 'memory' ? (memoryType ?? 'physical') : undefined"
    :aria-label="t('app.systemMonitor.current.title')"
    :aria-busy="loading"
  >
    <div v-if="notice" class="current-heading">
      <span
        class="current-notice"
        :class="{ 'is-warning': error || stale }"
        data-ui="current-notice"
        role="status"
        >{{ notice }}</span
      >
    </div>
    <div v-if="memorySegments.length" class="memory-composition" data-ui="memory-composition">
      <div
        class="memory-track"
        role="img"
        :aria-label="compositionDescription"
        data-ui="memory-usage"
      >
        <VeyTooltip
          v-for="segment in memorySegments"
          :key="segment.key"
          class="memory-segment"
          data-ui="memory-segment"
          :data-segment="segment.key"
          :style="{ width: `${segment.percent}%`, background: segment.color }"
          :text="`${t(`app.systemMonitor.current.metrics.${segment.key}`)} ${formatBytes(segment.bytes)} (${segment.percent.toFixed(1)}%)`"
          ><span class="memory-segment-fill" aria-hidden="true"
        /></VeyTooltip>
      </div>
      <div class="memory-legend" data-ui="memory-legend">
        <VeyTooltip
          v-for="segment in memorySegments"
          :key="segment.key"
          class="memory-legend-item"
          :text="`${t(`app.systemMonitor.current.metrics.${segment.key}`)} ${formatBytes(segment.bytes)} (${segment.percent.toFixed(1)}%)`"
        >
          <span class="legend-dot" :style="{ background: segment.color }" aria-hidden="true" />
          {{ t(`app.systemMonitor.current.metrics.${segment.key}`) }}
        </VeyTooltip>
      </div>
    </div>
    <div class="readout-row" :class="{ 'is-cpu': group === 'cpu' }" data-ui="resource-readouts">
      <dl class="metric-grid" :style="{ '--metric-columns': primaryFields.length }">
        <div
          v-for="[key, format] in primaryFields"
          :key="key"
          class="metric"
          :style="metricStyle(key)"
          data-ui="current-metric"
          :data-metric="key"
        >
          <dt>
            <VeyTooltip
              v-if="key === 'usedBytes' && memoryType !== 'swap'"
              :text="t('app.systemMonitor.current.usedMemoryHint')"
            >
              {{ t(`app.systemMonitor.current.metrics.${key}`) }}
            </VeyTooltip>
            <template v-else>{{ t(`app.systemMonitor.current.metrics.${key}`) }}</template>
          </dt>
          <dd>{{ formatValue(key, format) }}</dd>
        </div>
      </dl>
      <dl v-if="group === 'cpu'" class="cpu-breakdown" data-ui="cpu-breakdown">
        <div
          v-for="[key, format] in secondaryFields"
          :key="key"
          class="detail"
          data-ui="current-metric"
          :data-metric="key"
        >
          <dt>{{ t(`app.systemMonitor.current.metrics.${key}`) }}</dt>
          <dd>{{ formatValue(key, format) }}</dd>
        </div>
      </dl>
    </div>
  </div>
</template>

<style scoped>
.current-values {
  flex-shrink: 0;
  min-width: 0;
  container-type: inline-size;
  padding: var(--vdl-space-3) 0 var(--vdl-space-1);
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
}
.current-heading {
  font-size: var(--vdl-font-caption);
  color: var(--vdl-text-muted);
}
.current-notice.is-warning {
  color: var(--vdl-warning);
}
.readout-row {
  min-width: 0;
}
.metric-grid {
  display: grid;
  grid-template-columns: repeat(var(--metric-columns), minmax(0, 1fr));
  gap: var(--vdl-space-4) var(--vdl-space-6);
  margin: 0;
}
.metric {
  min-width: 0;
  border-inline-start: 3px solid var(--metric-accent);
  padding-inline-start: var(--vdl-space-3);
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-1);
}
.metric dt {
  font-size: var(--vdl-font-body-sm);
  line-height: var(--vdl-space-4);
  color: var(--vdl-text-secondary);
}
.metric dd {
  margin: 0;
  font-size: var(--vdl-font-title-lg);
  line-height: 28px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  color: var(--metric-value-color);
  white-space: nowrap;
}
.is-cpu {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vdl-space-6);
}
.is-cpu .metric-grid {
  flex: 0 0 128px;
}
.cpu-breakdown {
  width: 144px;
  margin: 0;
  display: grid;
  gap: var(--vdl-space-1);
}
.detail {
  display: flex;
  align-items: baseline;
  gap: var(--vdl-space-2);
  min-width: 0;
}
.detail dt {
  color: var(--vdl-text-muted);
  font-size: var(--vdl-font-caption);
}
.detail dd {
  margin: 0;
  font-size: var(--vdl-font-caption);
  font-variant-numeric: tabular-nums;
  color: var(--vdl-text-primary);
  white-space: nowrap;
}
.cpu-breakdown .detail {
  justify-content: space-between;
  line-height: var(--vdl-space-4);
}
.memory-track {
  display: flex;
  height: var(--vdl-space-2);
  border-radius: var(--vdl-radius-pill);
  background: var(--vdl-bg-hover);
  overflow: hidden;
}
.memory-composition {
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-2);
}
.memory-segment-fill {
  display: block;
  width: 100%;
  height: 100%;
}
.memory-segment {
  flex-shrink: 0;
  height: 100%;
}
.memory-legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vdl-space-1) var(--vdl-space-4);
}
.memory-legend-item {
  display: inline-flex;
  align-items: center;
  gap: var(--vdl-space-1);
  font-size: var(--vdl-font-caption);
  line-height: var(--vdl-space-4);
  color: var(--vdl-text-secondary);
}
.legend-dot {
  width: 6px;
  height: 6px;
  flex-shrink: 0;
  border-radius: var(--vdl-radius-pill);
}
@container (max-width: 800px) {
  [data-group='memory'] .metric-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}
@container (max-width: 560px) {
  .metric-grid {
    column-gap: var(--vdl-space-3);
  }
  .metric {
    padding-inline-start: var(--vdl-space-2);
  }
  .metric dd {
    font-size: var(--vdl-font-title);
  }
}
</style>
