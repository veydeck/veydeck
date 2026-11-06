/**
 * @file useSystemMonitor.ts
 * @description 系统监控分组缓存、请求隔离与活动标签页轮询。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SystemMonitoringSeriesPage } from '@/api/generated'
import { systemMonitoringApi, type SystemMonitoringRange } from '@/api/modules/systemMonitoring'
import { useNodeStore } from '@/stores/node'
import { resolveThroughputUnit } from '@/utils/units'

const SERIES_REFRESH_MS = 60_000
/** 系统监控历史接口支持的指标分组。 */
export type SystemMonitoringGroup = SystemMonitoringSeriesPage['group']
type MetricKeys<T> = T extends unknown ? keyof T : never
type MetricKey = MetricKeys<SystemMonitoringSeriesPage['points'][number]['metrics']>

/** 单个节点、时间范围和指标分组的缓存及请求状态。 */
interface CacheEntry {
  data: SystemMonitoringSeriesPage | null
  loading: boolean
  refreshing: boolean
  error: string
  warning: string
  loadedAt: number | null
}

/** 将服务端 UTC 时间按当前 locale 展示。 */
export const formatMonitoringTime = (value: string | null) =>
  value ? new Date(value).toLocaleString() : ''

/** 管理当前窗口的分组趋势；仅轮询当前选择，同键请求共享 Promise。 */
export function useSystemMonitor() {
  const { t } = useI18n()
  const nodeStore = useNodeStore()
  const activeGroup = ref<SystemMonitoringGroup>('load')
  const memoryType = ref<'physical' | 'swap'>('physical')
  const timeRange = ref<SystemMonitoringRange>('24h')
  const cache = reactive(new Map<string, CacheEntry>())
  const requests = new Map<string, Promise<void>>()
  const currentNodeId = computed(() => nodeStore.currentNodeId || 'local')
  const currentKey = computed(() =>
    JSON.stringify([currentNodeId.value, timeRange.value, activeGroup.value]),
  )
  let mounted = false
  let generation = 0
  let timer: number | null = null

  /** 为当前选择取得独立状态，避免跨节点、范围或分组展示旧数据。 */
  const entry = computed(() => {
    const key = currentKey.value
    if (!cache.has(key)) {
      cache.set(key, {
        data: null,
        loading: false,
        refreshing: false,
        error: '',
        warning: '',
        loadedAt: null,
      })
    }
    return cache.get(key)!
  })
  const series = computed(() => entry.value.data)
  const seriesState = computed(() => entry.value)

  /** 停止活动选择的下一次自动刷新。 */
  const clearTimer = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }

  /** 获取当前分组；旧选择可更新自己的缓存，失效生命周期不得提交响应。 */
  const refreshSeries = (): Promise<void> => {
    if (!mounted) return Promise.resolve()
    const key = currentKey.value
    const existing = requests.get(key)
    if (existing) return existing
    clearTimer()
    const target = entry.value
    const nodeId = currentNodeId.value
    const range = timeRange.value
    const group = activeGroup.value
    const epoch = generation
    target.loading = !target.data
    target.refreshing = !!target.data
    target.error = ''
    target.warning = ''
    const request = (async () => {
      try {
        const response = await systemMonitoringApi.fetchSeries(nodeId, range, group)
        if (!mounted || epoch !== generation) return
        if (!response.success || !response.data)
          throw new Error(response.message || t('app.systemMonitor.fetchFailed'))
        if (response.data.group !== group || response.data.range !== range)
          throw new Error(t('app.systemMonitor.fetchFailed'))
        target.data = response.data
        target.loadedAt = Date.now()
      } catch (error) {
        if (!mounted || epoch !== generation) return
        const message =
          error instanceof Error && error.message
            ? error.message
            : t('app.systemMonitor.fetchFailed')
        target.error = target.data ? '' : message
        target.warning = target.data ? message : ''
      } finally {
        if (mounted && epoch === generation) {
          target.loading = false
          target.refreshing = false
          requests.delete(key)
          if (currentKey.value === key) schedule(SERIES_REFRESH_MS)
        }
      }
    })()
    requests.set(key, request)
    return request
  }

  /** 为当前选择安排唯一的轮询定时器。 */
  const schedule = (delay: number) => {
    clearTimer()
    if (mounted) timer = window.setTimeout(() => void refreshSeries(), delay)
  }

  /** 有效缓存直接展示；过期或首次访问立即请求。 */
  const activate = () => {
    clearTimer()
    if (!mounted) return
    if (requests.has(currentKey.value)) return
    const loadedAt = entry.value.loadedAt
    const remaining = loadedAt === null ? 0 : SERIES_REFRESH_MS - (Date.now() - loadedAt)
    if (remaining > 0) schedule(remaining)
    else void refreshSeries()
  }

  watch(
    [currentNodeId, timeRange, activeGroup],
    ([nodeId], [previousNodeId]) => {
      if (nodeId !== previousNodeId) {
        memoryType.value = 'physical'
        generation += 1
        cache.clear()
        requests.clear()
      }
      activate()
    },
    { flush: 'sync' },
  )
  onMounted(() => {
    mounted = true
    activate()
  })
  onUnmounted(() => {
    mounted = false
    generation += 1
    clearTimer()
    requests.clear()
    cache.clear()
  })

  const points = computed(() => series.value?.points ?? [])
  const hasSeriesData = computed(() => {
    const data = series.value
    if (data?.group === 'memory')
      return data.points.some(
        ({ metrics }) =>
          (memoryType.value === 'swap' ? metrics.swapPercent : metrics.memoryPercent) !== null,
      )
    return points.value.some((point) =>
      Object.values(point.metrics).some((value) => value !== null),
    )
  })
  const labels = computed(() => points.value.map((point) => formatMonitoringTime(point.sampledAt)))
  /** 将严格分组响应适配为现有图表数组，未选分组不生成伪造数值。 */
  const metric = (key: MetricKey) =>
    computed(() =>
      points.value.map((point) => {
        const metrics: Partial<Record<MetricKey, number | null>> = point.metrics
        return metrics[key] ?? null
      }),
    )
  const load1 = metric('loadAverage1m')
  const load5 = metric('loadAverage5m')
  const load15 = metric('loadAverage15m')
  const cpu = metric('cpuPercent')
  const physicalMemory = metric('memoryPercent')
  const swapMemory = metric('swapPercent')
  const memory = computed(() =>
    memoryType.value === 'swap' ? swapMemory.value : physicalMemory.value,
  )
  const diskRead = metric('diskReadBytesPerSecond')
  const diskWrite = metric('diskWriteBytesPerSecond')
  const netRx = metric('networkReceiveBytesPerSecond')
  const netTx = metric('networkTransmitBytesPerSecond')
  const numericValues = (values: Array<number | null>) =>
    values.filter((value): value is number => value !== null)
  const diskScale = computed(() =>
    resolveThroughputUnit(numericValues([...diskRead.value, ...diskWrite.value])),
  )
  const netScale = computed(() =>
    resolveThroughputUnit(numericValues([...netRx.value, ...netTx.value])),
  )
  const busy = computed(() => entry.value.loading || entry.value.refreshing)

  return {
    activeGroup,
    memoryType,
    series,
    seriesState,
    timeRange,
    points,
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
    refreshSeries,
  }
}
