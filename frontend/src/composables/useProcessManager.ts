import { computed, onScopeDispose, reactive, ref, watch } from 'vue'
import type {
  NetworkConnectionListPage,
  ProcessForceKillConfirmation,
  ProcessListPage,
  ProcessSignalResult,
} from '@/api/generated'
import {
  processApi,
  type NetworkConnectionListParams,
  type ProcessListParams,
} from '@/api/modules/process'

export type ProcessManagerActiveView = 'process' | 'network'
export type ProcessLoadPhase =
  | 'idle'
  | 'initialLoading'
  | 'ready'
  | 'refreshing'
  | 'stale'
  | 'initialError'

const PROCESS_POLL_INTERVAL_MS = 3000
const NETWORK_POLL_INTERVAL_MS = 5000

const createIdempotencyKey = () => {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `00000000-0000-4000-8000-${Date.now().toString(16).padStart(12, '0').slice(-12)}`
}

/**
 * 为进程管理窗口维护固定节点、独立加载状态和非重叠 HTTP 轮询。
 */
export const useProcessManager = (nodeId: string) => {
  const scopedApi = processApi.forNode(nodeId)
  const activeView = ref<ProcessManagerActiveView>('process')
  const processPage = ref<ProcessListPage | null>(null)
  const networkPage = ref<NetworkConnectionListPage | null>(null)
  const processLoadingMore = ref(false)
  const processLoadMoreError = ref<string | null>(null)
  const processGeneration = ref(0)
  const processBusy = ref(false)
  let loadedProcessPages = 0
  const processHasMore = ref(false)
  const processPhase = ref<ProcessLoadPhase>('idle')
  const networkPhase = ref<ProcessLoadPhase>('idle')
  const processError = ref<string | null>(null)
  const networkError = ref<string | null>(null)
  const pendingProcessIds = ref<Set<string>>(new Set())

  const processQuery = reactive<ProcessListParams>({
    page: 1,
    pageSize: 100,
    sortBy: 'pid',
    sortOrder: 'asc',
  })
  const networkQuery = reactive<NetworkConnectionListParams>({
    page: 1,
    pageSize: 100,
    sortBy: 'protocol',
    sortOrder: 'asc',
  })

  let processRequestSequence = 0
  let networkRequestSequence = 0
  let processQueryRevision = 0
  let networkQueryRevision = 0
  let processInFlight = false
  let networkInFlight = false
  let processRequestPending = false
  let networkRequestPending = false
  let pollTimer: ReturnType<typeof setTimeout> | null = null
  let disposed = false

  const clearPoll = () => {
    if (pollTimer !== null) clearTimeout(pollTimer)
    pollTimer = null
  }

  const schedulePoll = (view: ProcessManagerActiveView) => {
    if (disposed || activeView.value !== view) return
    clearPoll()
    const delay = view === 'process' ? PROCESS_POLL_INTERVAL_MS : NETWORK_POLL_INTERVAL_MS
    pollTimer = setTimeout(() => {
      if (view === 'process') void loadProcesses(true)
      else void loadNetworkConnections(true)
    }, delay)
  }

  /** 串行加载或整体刷新已展开的进程范围，过期查询不能提交结果。 */
  const loadProcesses = async (
    background = false,
    append = false,
  ): Promise<boolean | undefined> => {
    if (disposed) return undefined
    if (processInFlight) {
      if (!append) processRequestPending = true
      return undefined
    }
    if (append && (!processHasMore.value || activeView.value !== 'process')) return undefined
    if (activeView.value === 'process') clearPoll()
    processInFlight = true
    processBusy.value = true
    processLoadingMore.value = append
    const sequence = ++processRequestSequence
    const revision = processQueryRevision
    const params = { ...processQuery }
    const isCurrent = () =>
      !disposed && sequence === processRequestSequence && revision === processQueryRevision
    if (!processPage.value) processPhase.value = 'initialLoading'
    else if (!background && !append && processPhase.value !== 'stale') {
      processPhase.value = 'refreshing'
    }
    try {
      const firstPage = append ? loadedProcessPages + 1 : 1
      const lastPage = append ? firstPage : Math.max(1, loadedProcessPages)
      const entries = append ? [...(processPage.value?.entries ?? [])] : []
      let snapshotId = append ? processPage.value?.snapshotId : undefined
      let result: ProcessListPage | undefined
      let fetchedPage = firstPage
      let hasMore = false
      for (let page = firstPage; page <= lastPage; page += 1) {
        const response = await scopedApi.listProcesses({ ...params, page, snapshotId })
        if (!isCurrent()) return undefined
        if (!response.success || !response.data) {
          if (append && response.errorCode === 'PROCESS_SNAPSHOT_EXPIRED') {
            processRequestPending = true
          }
          throw new Error(response.message)
        }
        result = response.data
        if (snapshotId && result.snapshotId !== snapshotId) {
          throw new Error('Process snapshot changed during pagination')
        }
        snapshotId = result.snapshotId
        entries.push(...result.entries)
        fetchedPage = page
        hasMore = result.entries.length > 0 && entries.length < result.total
        if (!hasMore) break
      }
      if (!result) return undefined
      processPage.value = { ...result, entries }
      loadedProcessPages = fetchedPage
      processHasMore.value = hasMore
      processLoadMoreError.value = null
      processError.value = null
      processPhase.value = 'ready'
      return true
    } catch (error) {
      if (!isCurrent()) return undefined
      const message = error instanceof Error ? error.message : String(error)
      if (append) {
        processLoadMoreError.value = message
      } else {
        processError.value = message
        processPhase.value = processPage.value ? 'stale' : 'initialError'
      }
      return false
    } finally {
      processInFlight = false
      processBusy.value = false
      processLoadingMore.value = false
      if (processRequestPending) {
        processRequestPending = false
        queueMicrotask(() => void loadProcesses(false))
      } else {
        schedulePoll('process')
      }
    }
  }

  /** 触底加载下一页；重复触发不会创建并发请求。 */
  const loadMoreProcesses = () => loadProcesses(false, true)

  const loadNetworkConnections = async (background = false): Promise<boolean | undefined> => {
    if (networkInFlight) {
      networkRequestPending = true
      return undefined
    }
    if (activeView.value === 'network') clearPoll()
    networkInFlight = true
    const sequence = ++networkRequestSequence
    const revision = networkQueryRevision
    const requestNodeId = nodeId
    const params = { ...networkQuery }
    if (!networkPage.value) networkPhase.value = 'initialLoading'
    else if (!background && networkPhase.value !== 'stale') networkPhase.value = 'refreshing'
    try {
      const response = await scopedApi.listNetworkConnections(params)
      if (
        disposed ||
        requestNodeId !== nodeId ||
        sequence !== networkRequestSequence ||
        revision !== networkQueryRevision
      ) {
        return undefined
      }
      if (!response.success || !response.data) throw new Error(response.message)
      networkPage.value = response.data
      networkError.value = null
      networkPhase.value = 'ready'
      return true
    } catch (error) {
      if (
        disposed ||
        requestNodeId !== nodeId ||
        sequence !== networkRequestSequence ||
        revision !== networkQueryRevision
      ) {
        return undefined
      }
      networkError.value = error instanceof Error ? error.message : String(error)
      networkPhase.value = networkPage.value ? 'stale' : 'initialError'
      return false
    } finally {
      networkInFlight = false
      if (networkRequestPending) {
        networkRequestPending = false
        queueMicrotask(() => void loadNetworkConnections(false))
      } else {
        schedulePoll('network')
      }
    }
  }

  const setActiveView = (view: ProcessManagerActiveView) => {
    if (activeView.value === view) return
    activeView.value = view
    clearPoll()
    if (view === 'process') void loadProcesses(false)
    else void loadNetworkConnections(false)
  }

  const refresh = () => {
    if (activeView.value === 'process') return loadProcesses(false)
    return loadNetworkConnections(false)
  }

  const withPendingProcess = async <T>(processId: string, operation: () => Promise<T>) => {
    if (pendingProcessIds.value.has(processId)) return undefined
    pendingProcessIds.value = new Set(pendingProcessIds.value).add(processId)
    try {
      return await operation()
    } finally {
      const next = new Set(pendingProcessIds.value)
      next.delete(processId)
      pendingProcessIds.value = next
    }
  }

  const terminate = (processId: string) =>
    withPendingProcess<ProcessSignalResult>(processId, async () => {
      const response = await scopedApi.terminate(processId, {
        idempotencyKey: createIdempotencyKey(),
      })
      if (!response.success || !response.data) throw new Error(response.message)
      void loadProcesses(true)
      return response.data
    })

  const createForceKillConfirmation = async (
    processId: string,
  ): Promise<ProcessForceKillConfirmation> => {
    const response = await scopedApi.createForceKillConfirmation(processId)
    if (!response.success || !response.data) throw new Error(response.message)
    return response.data
  }

  const forceKill = (processId: string, confirmationToken: string) =>
    withPendingProcess<ProcessSignalResult>(processId, async () => {
      const response = await scopedApi.forceKill(processId, {
        idempotencyKey: createIdempotencyKey(),
        confirmationToken,
      })
      if (!response.success || !response.data) throw new Error(response.message)
      void loadProcesses(true)
      return response.data
    })

  watch(
    () => ({ ...processQuery }),
    () => {
      processQueryRevision += 1
      processGeneration.value += 1
      loadedProcessPages = 0
      processHasMore.value = false
      processPage.value = null
      processLoadMoreError.value = null
      processError.value = null
      if (activeView.value === 'process') void loadProcesses(false)
    },
  )
  watch(
    () => ({ ...networkQuery }),
    () => {
      networkQueryRevision += 1
      if (activeView.value === 'network') void loadNetworkConnections(false)
    },
  )

  onScopeDispose(() => {
    disposed = true
    processRequestSequence += 1
    networkRequestSequence += 1
    clearPoll()
  })

  void loadProcesses(false)

  return {
    activeView,
    createForceKillConfirmation,
    forceKill,
    networkError,
    networkOwnerCoveragePercent: computed(() => {
      const coverage = networkPage.value?.coverage.ownerCoveragePercent ?? 100
      return coverage < 100 ? Math.floor(coverage * 10) / 10 : 100
    }),
    networkOwnerPartial: computed(() => {
      const coverage = networkPage.value?.coverage.ownerCoveragePercent
      return coverage !== undefined && coverage < 100
    }),
    networkPage,
    networkPartial: computed(() => networkPage.value?.coverage.status === 'partial'),
    networkPhase,
    networkQuery,
    pendingProcessIds,
    loadMoreProcesses,
    processBusy,
    processGeneration,
    processHasMore,
    processLoadingMore,
    processLoadMoreError,
    processError,
    processPage,
    processPartial: computed(() => processPage.value?.coverage.status === 'partial'),
    processPhase,
    processQuery,
    refresh,
    setActiveView,
    terminate,
  }
}
