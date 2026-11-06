/**
 * @file useSystemMonitorCurrent.ts
 * @description 当前标签页的实时资源缓存、生命周期隔离与五秒轮询。
 */
import { computed, onMounted, onUnmounted, reactive, ref, watch, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SystemMonitoringCurrent } from '@/api/generated'
import { systemMonitoringApi } from '@/api/modules/systemMonitoring'
import { useNodeStore } from '@/stores/node'

const REFRESH_MS = 5_000
const STALE_MS = 10_000

/** 节点和分组专属的实时请求状态。 */
interface CurrentEntry {
  data: SystemMonitoringCurrent | null
  loading: boolean
  error: string
  loadedAt: number | null
}

/** 实时轮询只依赖节点与分组，不受历史范围或图表交互影响。 */
export function useSystemMonitorCurrent(group: Ref<SystemMonitoringCurrent['group']>) {
  const { t } = useI18n()
  const nodeStore = useNodeStore()
  const nodeId = computed(() => nodeStore.currentNodeId || 'local')
  const key = computed(() => JSON.stringify([nodeId.value, group.value]))
  const cache = reactive(new Map<string, CurrentEntry>())
  const requests = new Map<string, Promise<void>>()
  const now = ref(performance.now())
  let mounted = false
  let generation = 0
  let timer: number | null = null
  let staleTimer: number | null = null

  /** 取得当前选择独立的缓存状态。 */
  const entry = computed(() => {
    if (!cache.has(key.value))
      cache.set(key.value, { data: null, loading: false, error: '', loadedAt: null })
    return cache.get(key.value)!
  })
  const current = computed(() => entry.value.data)
  const error = computed(() => entry.value.error)
  const loading = computed(() => entry.value.loading)
  const stale = computed(() => {
    const value = current.value
    return (
      !!value &&
      (value.status === 'stale' ||
        (value.sampleAgeMs !== null &&
          entry.value.loadedAt !== null &&
          value.sampleAgeMs + Math.max(0, now.value - entry.value.loadedAt) > STALE_MS))
    )
  })

  /** 清理网络轮询定时器。 */
  const clearTimer = () => {
    if (timer !== null) window.clearTimeout(timer)
    timer = null
  }
  /** 仅安排当前选择的下一次请求。 */
  const schedule = (delay: number) => {
    clearTimer()
    if (mounted) timer = window.setTimeout(() => void refreshCurrent(), delay)
  }

  /** 相同选择合并请求；失效节点或已卸载窗口不能提交结果。 */
  const refreshCurrent = (): Promise<void> => {
    if (!mounted) return Promise.resolve()
    const requestKey = key.value
    const existing = requests.get(requestKey)
    if (existing) return existing
    clearTimer()
    const target = entry.value
    const requestedNode = nodeId.value
    const requestedGroup = group.value
    const epoch = generation
    target.loading = !target.data
    target.error = ''
    const request = (async () => {
      try {
        const response = await systemMonitoringApi.fetchCurrent(requestedNode, requestedGroup)
        if (!mounted || generation !== epoch) return
        if (!response.success || !response.data || response.data.group !== requestedGroup)
          throw new Error(response.message || t('app.systemMonitor.current.fetchFailed'))
        target.loadedAt = performance.now()
        target.data = response.data
      } catch (cause) {
        if (!mounted || generation !== epoch) return
        target.error =
          cause instanceof Error && cause.message
            ? cause.message
            : t('app.systemMonitor.current.fetchFailed')
      } finally {
        if (mounted && generation === epoch) {
          target.loading = false
          requests.delete(requestKey)
          if (key.value === requestKey) schedule(REFRESH_MS)
        }
      }
    })()
    requests.set(requestKey, request)
    return request
  }

  /** 切换时复用五秒内缓存，其他情况立即读取当前分组。 */
  const activate = () => {
    clearTimer()
    if (!mounted || requests.has(key.value)) return
    const remaining =
      entry.value.loadedAt === null ? 0 : REFRESH_MS - (performance.now() - entry.value.loadedAt)
    if (remaining > 0) schedule(remaining)
    else void refreshCurrent()
  }
  watch(
    [nodeId, group],
    ([node], [previousNode]) => {
      if (node !== previousNode) {
        generation += 1
        cache.clear()
        requests.clear()
      }
      activate()
    },
    { flush: 'sync' },
  )

  /** 使用 Agent 样本年龄与本地单调时长判断过期，避免跨设备比较 UTC 时间。 */
  watch([current, () => entry.value.loadedAt], ([value, loadedAt]) => {
    now.value = performance.now()
    if (staleTimer !== null) window.clearTimeout(staleTimer)
    staleTimer = null
    if (!mounted || value?.sampleAgeMs == null || loadedAt === null) return
    const remaining = STALE_MS - value.sampleAgeMs - Math.max(0, now.value - loadedAt)
    if (remaining >= 0)
      staleTimer = window.setTimeout(() => {
        now.value = performance.now()
        staleTimer = null
      }, remaining + 1)
  })
  onMounted(() => {
    mounted = true
    activate()
  })
  onUnmounted(() => {
    mounted = false
    generation += 1
    clearTimer()
    if (staleTimer !== null) window.clearTimeout(staleTimer)
    requests.clear()
    cache.clear()
  })
  return { current, error, loading, stale, refreshCurrent }
}
