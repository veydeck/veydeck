import { mount, flushPromises } from '@vue/test-utils'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SystemMonitorView from '../SystemMonitorView.vue'
import { systemMonitoringApi } from '@/api/modules/systemMonitoring'
import type { SystemMonitoringSeriesPage } from '@/api/generated'
import zh from '@/locales/zh'
import { VeySelect, VeyTabs } from '@/components/ui'

vi.mock('@/api/modules/systemMonitoring', () => ({
  systemMonitoringApi: { fetchSeries: vi.fn(), fetchCurrent: vi.fn() },
}))
vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => ({ updateWindowRuntimeState: vi.fn() }),
}))
vi.mock('../MonitorChartPanel.vue', () => ({
  default: {
    props: ['title', 'options'],
    template: '<div data-ui="chart-panel">{{ title }}</div>',
  },
}))
const api = vi.mocked(systemMonitoringApi)
const wrappers: ReturnType<typeof mount>[] = []

/** 构造含缺失值的分组历史数据，验证提示不依赖完整性。 */
const data = (overrides: Partial<SystemMonitoringSeriesPage> = {}): SystemMonitoringSeriesPage =>
  ({
    range: '24h',
    from: '2026-11-05T00:00:00Z',
    to: '2026-11-06T00:00:00Z',
    resolutionSeconds: 300,
    seriesStatus: 'partial',
    collectionState: 'running',
    coveragePercent: 50,
    expectedPointCount: 288,
    actualPointCount: 1,
    group: 'load',
    points: [
      {
        sampledAt: '2026-11-06T00:00:00Z',
        coveragePercent: 50,
        metrics: { loadAverage1m: 1, loadAverage5m: null, loadAverage15m: 2 },
      },
    ],
    pageInfo: { limit: 500, hasMore: false, nextCursor: null },
    ...overrides,
  }) as SystemMonitoringSeriesPage
/** 挂载业务视图及真实标签页组件。 */
const mountView = () => {
  const wrapper = mount(SystemMonitorView, {
    global: {
      plugins: [createPinia(), createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
    },
  })
  wrappers.push(wrapper)
  return wrapper
}
const respond = (value: SystemMonitoringSeriesPage) =>
  api.fetchSeries.mockResolvedValue({ success: true, code: 200, message: '', data: value })
beforeEach(() => {
  vi.useFakeTimers()
  vi.resetAllMocks()
  respond(data())
  api.fetchCurrent.mockResolvedValue({
    success: true,
    code: 200,
    message: '',
    data: {
      group: 'load',
      sampledAt: null,
      sampleAgeMs: 0,
      status: 'unavailable',
      metrics: { loadAverage1m: null, loadAverage5m: null, loadAverage15m: null },
    },
  })
})
afterEach(() => {
  wrappers.splice(0).forEach((w) => w.unmount())
  vi.useRealTimers()
})

describe('SystemMonitorView', () => {
  it('不展示完整性告警和刷新按钮，时间筛选与 tabs 同属工具栏', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.find('[data-ui="partial-status"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('历史数据不完整')
    expect(wrapper.find('[data-slot="refresh"]').exists()).toBe(false)
    const toolbar = wrapper.get('[data-ui="toolbar"]')
    expect(toolbar.find('[data-ui="monitoring-tabs"]').exists()).toBe(true)
    expect(toolbar.find('[name="systemMonitoringRange"]').exists()).toBe(true)
    expect(wrapper.find('[data-ui="collection-notice"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-ui="chart-panel"]')).toHaveLength(1)
  })

  it('切换历史范围不刷新实时值，历史失败也不影响资源区', async () => {
    const wrapper = mountView()
    await flushPromises()
    expect(api.fetchCurrent).toHaveBeenCalledTimes(1)
    wrapper.findComponent(VeySelect).vm.$emit('update:modelValue', '1h')
    await flushPromises()
    expect(api.fetchSeries).toHaveBeenCalledTimes(2)
    expect(api.fetchCurrent).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-ui="current-values"]').exists()).toBe(true)
  })

  it('有 Swap 时切换曲线与读数，空 Swap 历史显示空态且可切回', async () => {
    api.fetchSeries.mockImplementation(async (_node, range, group) => ({
      success: true,
      code: 200,
      message: '',
      data:
        group === 'memory'
          ? data({
              group,
              range,
              points: [
                {
                  sampledAt: '2026-11-06T00:00:00Z',
                  coveragePercent: 100,
                  metrics: { memoryPercent: 50, swapPercent: null },
                },
              ],
            })
          : data({ range }),
    }))
    api.fetchCurrent.mockResolvedValue({
      success: true,
      code: 200,
      message: '',
      data: {
        group: 'memory',
        sampledAt: null,
        sampleAgeMs: 0,
        status: 'fresh',
        metrics: {
          totalBytes: 8192,
          usedBytes: 4096,
          usagePercent: 50,
          availableBytes: 4096,
          buffersBytes: 0,
          cachedBytes: 2048,
          freeBytes: 2048,
          otherUsedBytes: 4096,
          swapTotalBytes: 2048,
          swapUsedBytes: 512,
          swapFreeBytes: 1536,
          swapPercent: 25,
        },
      },
    })
    const wrapper = mountView()
    await flushPromises()
    wrapper.findComponent(VeyTabs).vm.$emit('update:modelValue', 'memory')
    await flushPromises()
    const selector = wrapper
      .findAllComponents(VeySelect)
      .find((component) => component.props('name') === 'systemMonitoringMemoryType')!
    expect(selector.exists()).toBe(true)
    expect(wrapper.get('[data-ui="chart-panel"]').text()).toContain('内存趋势')
    const historyCalls = api.fetchSeries.mock.calls.length
    const currentCalls = api.fetchCurrent.mock.calls.length
    selector.vm.$emit('update:modelValue', 'swap')
    await flushPromises()
    expect(wrapper.find('[data-ui="history-empty"]').exists()).toBe(true)
    expect(wrapper.get('[data-metric="usagePercent"] dd').text()).toBe('25.0%')
    expect(api.fetchSeries).toHaveBeenCalledTimes(historyCalls)
    expect(api.fetchCurrent).toHaveBeenCalledTimes(currentCalls)
    expect(wrapper.find('[data-ui="memory-type-select"]').exists()).toBe(true)
    selector.vm.$emit('update:modelValue', 'physical')
    await flushPromises()
    expect(wrapper.find('[data-ui="chart-panel"]').exists()).toBe(true)
    expect(wrapper.get('[data-metric="usagePercent"] dd').text()).toBe('50.0%')
    // Swap 被停用后自动回到物理内存，不留下无法切回的隐藏选择。
    selector.vm.$emit('update:modelValue', 'swap')
    const response = await api.fetchCurrent.mock.results.at(-1)!.value
    if (response.data?.group !== 'memory') throw new Error('invalid fixture')
    api.fetchCurrent.mockResolvedValue({
      ...response,
      data: {
        ...response.data,
        metrics: {
          ...response.data.metrics,
          swapTotalBytes: 0,
          swapUsedBytes: 0,
          swapFreeBytes: 0,
          swapPercent: null,
        },
      },
    })
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(wrapper.find('[data-ui="memory-type-select"]').exists()).toBe(false)
    expect(wrapper.get('[data-metric="usagePercent"] dd').text()).toBe('50.0%')
  })

  it('未配置 Swap 时不显示内存类型切换', async () => {
    api.fetchCurrent.mockResolvedValue({
      success: true,
      code: 200,
      message: '',
      data: {
        group: 'memory',
        sampledAt: null,
        sampleAgeMs: 0,
        status: 'fresh',
        metrics: {
          totalBytes: 8192,
          usedBytes: 4096,
          usagePercent: 50,
          availableBytes: 4096,
          buffersBytes: 0,
          cachedBytes: 2048,
          freeBytes: 2048,
          otherUsedBytes: 4096,
          swapTotalBytes: 0,
          swapUsedBytes: 0,
          swapFreeBytes: 0,
          swapPercent: null,
        },
      },
    })
    const wrapper = mountView()
    await flushPromises()
    wrapper.findComponent(VeyTabs).vm.$emit('update:modelValue', 'memory')
    await flushPromises()
    expect(wrapper.find('[data-ui="memory-type-select"]').exists()).toBe(false)
    expect(wrapper.get('[data-ui="current-values"]').attributes('data-memory-type')).toBe(
      'physical',
    )
  })

  it('保留历史曲线，同时明确提示采集已停止', async () => {
    respond(data({ collectionState: 'stopped', seriesStatus: 'stale' }))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-ui="collection-notice"]').text()).toContain('历史采集已停止')
    expect(wrapper.find('[data-ui="chart-panel"]').exists()).toBe(true)
  })

  it('长时间无新样本时显示明确提示', async () => {
    respond(data({ seriesStatus: 'stale' }))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-ui="collection-notice"]').text()).toContain('超过 2 分钟')
  })

  it('首次请求失败显示错误，轮询成功后自动恢复', async () => {
    api.fetchSeries.mockRejectedValueOnce(new Error('请求失败'))
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.get('[data-ui="load-error"]').text()).toContain('请求失败')
    await vi.advanceTimersByTimeAsync(60_000)
    expect(wrapper.find('[data-ui="load-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="chart-panel"]').exists()).toBe(true)
  })
})
