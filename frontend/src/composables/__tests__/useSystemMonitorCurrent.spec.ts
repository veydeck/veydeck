import { defineComponent, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { useSystemMonitorCurrent } from '@/composables/useSystemMonitorCurrent'
import { useNodeStore } from '@/stores/node'
import { systemMonitoringApi } from '@/api/modules/systemMonitoring'
import type { SystemMonitoringCurrent } from '@/api/generated'

vi.mock('@/api/modules/systemMonitoring', () => ({
  systemMonitoringApi: { fetchCurrent: vi.fn() },
}))
const api = vi.mocked(systemMonitoringApi)
type Group = SystemMonitoringCurrent['group']

/** 按分组构造同次实时采样。 */
const snapshot = (group: Group = 'load'): SystemMonitoringCurrent => {
  const base = { sampledAt: new Date().toISOString(), sampleAgeMs: 0, status: 'fresh' as const }
  switch (group) {
    case 'load':
      return {
        ...base,
        group,
        metrics: { loadAverage1m: 0, loadAverage5m: 1, loadAverage15m: null },
      }
    case 'cpu':
      return {
        ...base,
        group,
        metrics: { cpuPercent: 40, userPercent: 20, systemPercent: 15, ioWaitPercent: 5 },
      }
    case 'memory':
      return {
        ...base,
        group,
        metrics: {
          totalBytes: 1024,
          usedBytes: 512,
          usagePercent: 50,
          buffersBytes: 0,
          cachedBytes: null,
          availableBytes: 512,
          freeBytes: null,
          otherUsedBytes: null,
        },
      }
    case 'diskIo':
      return {
        ...base,
        group,
        metrics: { diskReadBytesPerSecond: 0, diskWriteBytesPerSecond: null },
      }
    case 'network':
      return {
        ...base,
        group,
        metrics: { networkReceiveBytesPerSecond: 1024, networkTransmitBytesPerSecond: 0 },
      }
  }
}
const response = (data: SystemMonitoringCurrent) => ({
  success: true,
  code: 200,
  message: '',
  data,
})
/** 控制网络响应的提交时机。 */
const deferred = () => {
  let resolve!: (value: ReturnType<typeof response>) => void
  const promise = new Promise<ReturnType<typeof response>>((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const Harness = defineComponent({
  setup() {
    const group = ref<Group>('load')
    return { group, ...useSystemMonitorCurrent(group) }
  },
  template: '<div />',
})
const wrappers: ReturnType<typeof mount>[] = []
/** 每个窗口使用独立节点和实时缓存。 */
const mountHarness = () => {
  const pinia = createPinia()
  const wrapper = mount(Harness, {
    global: {
      plugins: [
        pinia,
        createI18n({
          legacy: false,
          locale: 'zh',
          messages: { zh: { app: { systemMonitor: { current: { fetchFailed: '请求失败' } } } } },
        }),
      ],
    },
  })
  wrappers.push(wrapper)
  return { wrapper, nodeStore: useNodeStore(pinia) }
}
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  localStorage.clear()
  api.fetchCurrent.mockImplementation(async (_node, group) => response(snapshot(group)))
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
})

describe('useSystemMonitorCurrent', () => {
  it('首次仅请求当前组，五秒后轮询，不重叠慢请求', async () => {
    const pending = deferred()
    api.fetchCurrent.mockImplementationOnce(() => pending.promise)
    const { wrapper } = mountHarness()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(api.fetchCurrent).toHaveBeenCalledExactlyOnceWith('local', 'load')
    expect(wrapper.vm.loading).toBe(true)
    pending.resolve(response(snapshot()))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(4_999)
    expect(api.fetchCurrent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(api.fetchCurrent).toHaveBeenCalledTimes(2)
  })

  it('只轮询活动组，五秒内切回直接复用缓存', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    wrapper.vm.group = 'cpu'
    await flushPromises()
    wrapper.vm.group = 'load'
    await flushPromises()
    expect(api.fetchCurrent).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.current?.group).toBe('load')
    await vi.advanceTimersByTimeAsync(5_000)
    expect(api.fetchCurrent).toHaveBeenLastCalledWith('local', 'load')
    expect(api.fetchCurrent).toHaveBeenCalledTimes(3)
  })

  it('新组无需等待旧组响应，旧响应只更新自己的缓存', async () => {
    const old = deferred()
    api.fetchCurrent.mockImplementationOnce(() => old.promise)
    const { wrapper } = mountHarness()
    wrapper.vm.group = 'cpu'
    await flushPromises()
    expect(wrapper.vm.current?.group).toBe('cpu')
    old.resolve(response(snapshot()))
    await flushPromises()
    expect(wrapper.vm.current?.group).toBe('cpu')
    wrapper.vm.group = 'load'
    await flushPromises()
    expect(api.fetchCurrent).toHaveBeenCalledTimes(2)
  })

  it('同键请求共享正在执行的 Promise', async () => {
    const pending = deferred()
    api.fetchCurrent.mockImplementationOnce(() => pending.promise)
    const { wrapper } = mountHarness()
    const first = wrapper.vm.refreshCurrent()
    const second = wrapper.vm.refreshCurrent()
    expect(first).toBe(second)
    pending.resolve(response(snapshot()))
    await first
    expect(api.fetchCurrent).toHaveBeenCalledTimes(1)
  })

  it('切换节点清空缓存，并拒绝原节点的旧响应', async () => {
    const old = deferred()
    api.fetchCurrent.mockImplementationOnce(() => old.promise)
    const { wrapper, nodeStore } = mountHarness()
    nodeStore.currentNodeId = 'node-2'
    await flushPromises()
    expect(api.fetchCurrent).toHaveBeenLastCalledWith('node-2', 'load')
    nodeStore.currentNodeId = 'local'
    await flushPromises()
    old.resolve(response({ ...snapshot(), status: 'unavailable' }))
    await flushPromises()
    expect(api.fetchCurrent).toHaveBeenCalledTimes(3)
    expect(wrapper.vm.current?.status).toBe('fresh')
  })

  it('请求失败保留旧值，并在旧采样超过十秒时标记过期', async () => {
    const { wrapper } = mountHarness()
    await flushPromises()
    api.fetchCurrent.mockRejectedValue(new Error('网络失败'))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(wrapper.vm.error).toBe('网络失败')
    expect(wrapper.vm.current?.group).toBe('load')
    expect(wrapper.vm.stale).toBe(false)
    await vi.advanceTimersByTimeAsync(5_001)
    expect(wrapper.vm.stale).toBe(true)
  })

  it.each([-3_600_000, 3_600_000])('Agent 时钟偏差 %i 毫秒时按样本年龄计时', async (offset) => {
    api.fetchCurrent.mockResolvedValueOnce(
      response({
        ...snapshot(),
        sampledAt: new Date(Date.now() + offset).toISOString(),
        sampleAgeMs: 2500,
      }),
    )
    const { wrapper } = mountHarness()
    await flushPromises()
    expect(wrapper.vm.stale).toBe(false)
    // 下一轮请求挂起时，仍按已收到的年龄继续计时，不能延长样本有效期。
    const pending = deferred()
    api.fetchCurrent.mockImplementationOnce(() => pending.promise)
    await vi.advanceTimersByTimeAsync(7500)
    expect(wrapper.vm.stale).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    expect(wrapper.vm.stale).toBe(true)
    pending.resolve(response(snapshot()))
    await flushPromises()
    expect(wrapper.vm.stale).toBe(false)
  })

  it.each([-86_400_000, 86_400_000])(
    '浏览器校时 %i 毫秒不改变缓存寿命或样本年龄',
    async (offset) => {
      const { wrapper } = mountHarness()
      await flushPromises()
      const initial = Date.now()
      vi.setSystemTime(initial + offset)
      expect(wrapper.vm.stale).toBe(false)
      wrapper.vm.group = 'cpu'
      await flushPromises()
      wrapper.vm.group = 'load'
      await flushPromises()
      expect(api.fetchCurrent).toHaveBeenCalledTimes(2)
      expect(wrapper.vm.stale).toBe(false)
      api.fetchCurrent.mockRejectedValue(new Error('网络失败'))
      await vi.advanceTimersByTimeAsync(10_001)
      expect(wrapper.vm.stale).toBe(true)
      expect(wrapper.vm.error).toBe('网络失败')
    },
  )

  it('尚无样本时没有年龄，不安排虚假的过期提示', async () => {
    api.fetchCurrent.mockResolvedValue(
      response({
        ...snapshot(),
        sampledAt: null,
        sampleAgeMs: null,
        status: 'unavailable',
      }),
    )
    const { wrapper } = mountHarness()
    await flushPromises()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(wrapper.vm.stale).toBe(false)
    expect(wrapper.vm.current?.status).toBe('unavailable')
  })

  it('服务端明确过期时立即标记，首次失败没有伪造数据', async () => {
    api.fetchCurrent.mockRejectedValueOnce(new Error('首次失败'))
    const { wrapper } = mountHarness()
    await flushPromises()
    expect(wrapper.vm.current).toBeNull()
    expect(wrapper.vm.error).toBe('首次失败')
    api.fetchCurrent.mockResolvedValueOnce(response({ ...snapshot(), status: 'stale' }))
    await vi.advanceTimersByTimeAsync(5_000)
    expect(wrapper.vm.stale).toBe(true)
    expect(wrapper.vm.error).toBe('')
  })

  it('卸载后忽略响应并清理轮询', async () => {
    const pending = deferred()
    api.fetchCurrent.mockImplementationOnce(() => pending.promise)
    const { wrapper } = mountHarness()
    wrapper.unmount()
    pending.resolve(response(snapshot()))
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(api.fetchCurrent).toHaveBeenCalledTimes(1)
  })
})
