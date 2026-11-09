/** 属性查看的详情请求与临时统计；所有异步结果都受窗口生命周期隔离。 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { fsApi } from '@/api/modules/fs'
import type { FileStatistics, FsEntryDetail } from '@/api/interface/fs'
import type { ApiResponse } from '@/api/interface'

/** 为固定节点及逻辑路径管理属性查询，不依赖全局节点或任务中心。 */
export function useFileProperties(nodeId: string, path: string) {
  const client = fsApi.forNode(nodeId)
  const { t } = useI18n()
  const detail = ref<FsEntryDetail>()
  const statistics = ref<FileStatistics>()
  const loading = ref(false)
  const starting = ref(false)
  const error = ref('')
  const statisticsError = ref('')
  const connectionError = ref(false)
  const trackingStopped = ref(false)
  let generation = 0
  let disposed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let controller: AbortController | undefined
  let delay = 1000

  /** 返回本地化业务错误，统计容量与过期错误提供可操作的明确提示。 */
  function message(result: ApiResponse<unknown>): string {
    if (result.errorCode === 'FILE_STATISTICS_EXPIRED') return t('fileProperties.expired')
    if (result.code === 429) return t('fileProperties.busy')
    return result.message || t('fileProperties.loadFailed')
  }

  /** 终态才停止轮询，取消提交被接受时仍跟踪到扫描器确认。 */
  function running(value?: FileStatistics): boolean {
    return value?.status === 'running' || value?.status === 'cancelling'
  }

  /** 释放定时器与查询请求；调用方负责取消已创建的服务端统计。 */
  function clearRequests() {
    clearTimeout(timer)
    timer = undefined
    controller?.abort()
    controller = undefined
  }

  /** 退出后尽力取消，网络不可用时由 Agent 的查询租约回收兜底。 */
  async function release(id?: string) {
    if (!id) return
    try { await client.cancelStatistics(id) } catch { /* Agent 空闲回收兜底。 */ }
  }

  /** 每次仅安排一个下一轮查询，避免慢请求与轮询间隔造成并发。 */
  function schedule(token: number) {
    if (disposed || token !== generation || !running(statistics.value)) return
    timer = setTimeout(() => { void poll(token) }, delay)
  }

  /** 网络失败保留累计数据，退避到最多十五秒，不误报终态。 */
  async function poll(token: number) {
    const id = statistics.value?.id
    if (!id || disposed || token !== generation) return
    const request = new AbortController()
    controller = request
    try {
      const result = await client.statisticsDetail(id, { signal: request.signal })
      if (disposed || token !== generation) return
      if (!result.success || !result.data) {
        if (result.code && [400, 401, 403, 404, 410].includes(result.code)) {
          statisticsError.value = message(result)
          trackingStopped.value = true
          return
        }
        throw new Error(message(result))
      }
      if (statistics.value?.status === 'cancelling' && result.data.status === 'running')
        result.data.status = 'cancelling'
      statistics.value = result.data
      connectionError.value = false
      delay = 1000
    } catch {
      if (disposed || token !== generation) return
      connectionError.value = true
      delay = Math.min(delay * 2, 15000)
    }
    schedule(token)
  }

  /** 刷新前丢弃旧详情并取消旧统计，目录大小不会冒充实时一致性快照。 */
  async function load() {
    const token = ++generation
    const previous = running(statistics.value) ? statistics.value?.id : undefined
    clearRequests()
    detail.value = undefined
    statistics.value = undefined
    error.value = ''
    statisticsError.value = ''
    connectionError.value = false
    trackingStopped.value = false
    starting.value = false
    loading.value = true
    await release(previous)
    if (disposed || token !== generation) return
    const request = new AbortController()
    controller = request
    try {
      const result = await client.detail(path, { signal: request.signal })
      if (disposed || token !== generation) return
      if (!result.success || !result.data) throw new Error(message(result))
      detail.value = result.data
    } catch (failure) {
      if (!disposed && token === generation)
        error.value = failure instanceof Error ? failure.message : t('fileProperties.loadFailed')
    } finally {
      if (!disposed && token === generation) loading.value = false
    }
  }

  /** 创建请求不被直接中断，关闭期间收到标识后立即取消，避免遗留无主扫描。 */
  async function calculate() {
    if (!detail.value || starting.value || (running(statistics.value) && !trackingStopped.value)) return
    const token = generation
    const revision = detail.value.revision
    if (!revision) return
    const previous = trackingStopped.value && running(statistics.value) ? statistics.value?.id : undefined
    starting.value = true
    statisticsError.value = ''
    connectionError.value = false
    trackingStopped.value = false
    try {
      if (previous) await release(previous)
      if (disposed || token !== generation) return
      const result = await client.createStatistics({ path, expectedRevision: revision })
      if (disposed || token !== generation) {
        if (result.data) void release(result.data.id)
        return
      }
      if (!result.success || !result.data) throw new Error(message(result))
      statistics.value = result.data
      delay = 1000
      schedule(token)
    } catch (failure) {
      if (!disposed && token === generation)
        statisticsError.value = failure instanceof Error ? failure.message : t('fileProperties.loadFailed')
    } finally {
      if (!disposed && token === generation) starting.value = false
    }
  }

  /** 显示取消中并等待真实终态；请求失败后继续查询并允许再次取消。 */
  async function cancel() {
    const current = statistics.value
    if (!current || current.status !== 'running') return
    const token = generation
    current.status = 'cancelling'
    try {
      const result = await client.cancelStatistics(current.id)
      if (disposed || token !== generation) return
      if (!result.success || !result.data) throw new Error(message(result))
      // 取消响应可能晚于终态轮询返回，不能将已结束状态倒退为取消中。
      if (running(statistics.value)) statistics.value = result.data
    } catch {
      if (!disposed && token === generation && running(statistics.value)) {
        if (statistics.value?.status === 'cancelling') statistics.value.status = 'running'
        statisticsError.value = t('fileProperties.cancelFailed')
      }
    }
  }

  onMounted(() => { void load() })
  onBeforeUnmount(() => {
    disposed = true
    generation++
    clearRequests()
    if (running(statistics.value)) void release(statistics.value?.id)
  })
  return { detail, statistics, loading, starting, error, statisticsError, connectionError, trackingStopped, load, calculate, cancel }
}
