import { defineComponent } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useNodeStore } from '@/stores/node'
import { useSystemMonitor } from '@/composables/useSystemMonitor'
import { systemMonitoringApi } from '@/api/modules/systemMonitoring'
import type { SystemMonitoringSeriesPage } from '@/api/generated'

vi.mock('@/api/modules/systemMonitoring', () => ({ systemMonitoringApi: { fetchSeries: vi.fn() } }))
const api = vi.mocked(systemMonitoringApi)
type Group = SystemMonitoringSeriesPage['group']

/** 构造具有真实分组结构的趋势响应。 */
const series = (group: Group = 'load', range = '24h'): SystemMonitoringSeriesPage => {
  const base = {
    range,
    from: '2026-07-14T00:00:00Z',
    to: '2026-07-15T00:00:00Z',
    resolutionSeconds: 300,
    seriesStatus: 'complete' as const,
    collectionState: 'running' as const,
    expectedPointCount: 288,
    actualPointCount: 1,
    coveragePercent: 100,
    pageInfo: { limit: 500, hasMore: false, nextCursor: null },
  }
  const point = { sampledAt: base.from, coveragePercent: 100 }
  switch (group) {
    case 'load':
      return {
        ...base,
        group,
        points: [{ ...point, metrics: { loadAverage1m: 1, loadAverage5m: 2, loadAverage15m: 3 } }],
      }
    case 'cpu':
      return { ...base, group, points: [{ ...point, metrics: { cpuPercent: 42 } }] }
    case 'memory':
      return {
        ...base,
        group,
        points: [{ ...point, metrics: { memoryPercent: 50, swapPercent: null } }],
      }
    case 'diskIo':
      return {
        ...base,
        group,
        points: [
          { ...point, metrics: { diskReadBytesPerSecond: 0, diskWriteBytesPerSecond: null } },
        ],
      }
    case 'network':
      return {
        ...base,
        group,
        points: [
          {
            ...point,
            metrics: { networkReceiveBytesPerSecond: null, networkTransmitBytesPerSecond: null },
          },
        ],
      }
  }
}
const response = (data: SystemMonitoringSeriesPage) => ({
  success: true,
  code: 200,
  message: '',
  data,
})
/** 手动控制响应顺序。 */
const deferred = () => {
  let resolve!: (value: ReturnType<typeof response>) => void
  const promise = new Promise<ReturnType<typeof response>>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const Harness = defineComponent({ setup: useSystemMonitor, template: '<div />' })
const wrappers: ReturnType<typeof mountHarness>['wrapper'][] = []
/** 挂载独立窗口及节点状态。 */
function mountHarness() {
  const pinia = createPinia()
  const i18n = createI18n({
    legacy: false,
    locale: 'zh',
    messages: { zh: { app: { systemMonitor: { fetchFailed: '加载失败' } } } },
  })
  const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] } })
  wrappers.push(wrapper)
  return { wrapper, nodeStore: useNodeStore(pinia) }
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  localStorage.clear()
  api.fetchSeries.mockImplementation(async (_node, range, group) => response(series(group, range)))
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
})

describe('useSystemMonitor', () => {
  it('首次只请求负载，5 秒无轮询，60 秒只刷新活动分组', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledExactlyOnceWith('local', '24h', 'load')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
    wrapper.vm.activeGroup = 'cpu'
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(3)
    expect(api.fetchSeries).toHaveBeenLastCalledWith('local', '24h', 'cpu')
  })

  it('物理内存与 Swap 独立判断空态，切换复用同组数据且节点切换复位', async () => {
    const { wrapper, nodeStore } = mountHarness()
    await flushPromises()
    wrapper.vm.activeGroup = 'memory'
    await flushPromises()
    expect(wrapper.vm.memory).toEqual([50])
    expect(wrapper.vm.hasSeriesData).toBe(true)
    wrapper.vm.memoryType = 'swap'
    await flushPromises()
    expect(wrapper.vm.memory).toEqual([null])
    expect(wrapper.vm.hasSeriesData).toBe(false)
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
    const swap = series('memory')
    if (swap.group !== 'memory') throw new Error('invalid fixture')
    swap.points[0]!.metrics.swapPercent = 0
    api.fetchSeries.mockResolvedValueOnce(response(swap))
    await wrapper.vm.refreshSeries()
    expect(wrapper.vm.memory).toEqual([0])
    expect(wrapper.vm.hasSeriesData).toBe(true)
    nodeStore.currentNodeId = 'other-node'
    await flushPromises()
    expect(wrapper.vm.memoryType).toBe('physical')
  })

  it('切回有效缓存不请求，过期缓存保留并后台刷新', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    wrapper.vm.activeGroup = 'cpu'
    await flushPromises()
    wrapper.vm.activeGroup = 'load'
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
    wrapper.vm.activeGroup = 'cpu'
    await flushPromises()
    await vi.advanceTimersByTimeAsync(61_000)
    const pending = deferred()
    api.fetchSeries.mockImplementationOnce(() => pending.promise)
    wrapper.vm.activeGroup = 'load'
    await flushPromises()
    expect(wrapper.vm.series?.group).toBe('load')
    expect(wrapper.vm.seriesState.refreshing).toBe(true)
    pending.resolve(response(series()))
    await flushPromises()
  })

  it('新分组不等待旧请求，乱序响应只进入所属缓存', async () => {
    const old = deferred()
    api.fetchSeries.mockImplementationOnce(() => old.promise)
    const { wrapper } = mountHarness()
    wrapper.vm.activeGroup = 'cpu'
    await flushPromises()
    expect(wrapper.vm.series?.group).toBe('cpu')
    old.resolve(response(series()))
    await flushPromises()
    expect(wrapper.vm.series?.group).toBe('cpu')
    wrapper.vm.activeGroup = 'load'
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
  })

  it('切换范围不冒用旧范围数据', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    const next = deferred()
    api.fetchSeries.mockImplementationOnce(() => next.promise)
    wrapper.vm.timeRange = '7d'
    await flushPromises()
    expect(wrapper.vm.series).toBeNull()
    expect(wrapper.vm.seriesState.loading).toBe(true)
    next.resolve(response(series('load', '7d')))
    await flushPromises()
    expect(wrapper.vm.series?.range).toBe('7d')
  })

  it('节点切换清空缓存，旧生命周期响应不能污染相同节点的新请求', async () => {
    const old = deferred()
    api.fetchSeries.mockImplementationOnce(() => old.promise)
    const { wrapper, nodeStore } = mountHarness()
    nodeStore.currentNodeId = 'node-2'
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenLastCalledWith('node-2', '24h', 'load')
    nodeStore.currentNodeId = 'local'
    await flushPromises()
    old.resolve(response({ ...series(), coveragePercent: 1 }))
    await flushPromises()
    expect(wrapper.vm.series?.coveragePercent).toBe(100)
    expect(api.fetchSeries).toHaveBeenCalledTimes(3)
  })

  it('同一轮事件内切换节点并切回也会重新请求，保持后续轮询', async () => {
    const { wrapper, nodeStore } = mountHarness()
    await flushPromises()
    nodeStore.currentNodeId = 'node-2'
    nodeStore.currentNodeId = 'local'
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledTimes(3)
    expect(wrapper.vm.series?.group).toBe('load')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchSeries).toHaveBeenCalledTimes(4)
  })

  it('同键查询合并并等待已有请求完成', async () => {
    const pending = deferred()
    api.fetchSeries.mockImplementationOnce(() => pending.promise)
    const { wrapper } = mountHarness()
    const first = wrapper.vm.refreshSeries()
    const second = wrapper.vm.refreshSeries()
    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
    pending.resolve(response(series()))
    await Promise.all([first, second])
  })

  it('失败保留缓存并提示警告，无缓存显示错误，可手动重试', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    api.fetchSeries.mockRejectedValueOnce(new Error('temporary failure'))
    await wrapper.vm.refreshSeries()
    expect(wrapper.vm.seriesState.warning).toBe('temporary failure')
    expect(wrapper.vm.hasSeriesData).toBe(true)
    api.fetchSeries.mockRejectedValueOnce(new Error('first failure'))
    wrapper.vm.activeGroup = 'cpu'
    await flushPromises()
    expect(wrapper.vm.seriesState.error).toBe('first failure')
    await wrapper.vm.refreshSeries()
    expect(wrapper.vm.seriesState.error).toBe('')
  })

  it('零值是有效数据，全 null 是空态', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    wrapper.vm.activeGroup = 'diskIo'
    await flushPromises()
    expect(wrapper.vm.hasSeriesData).toBe(true)
    wrapper.vm.activeGroup = 'network'
    await flushPromises()
    expect(wrapper.vm.hasSeriesData).toBe(false)
  })

  it('卸载后忽略响应且不再轮询', async () => {
    const pending = deferred()
    api.fetchSeries.mockImplementationOnce(() => pending.promise)
    const { wrapper } = mountHarness()
    const state = wrapper.vm.seriesState
    wrapper.unmount()
    pending.resolve(response(series()))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(state.data).toBeNull()
    expect(api.fetchSeries).toHaveBeenCalledTimes(1)
  })
})
