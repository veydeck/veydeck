import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { useFileProperties } from '../useFileProperties'
import zh from '@/locales/zh'

const api = vi.hoisted(() => ({
  detail: vi.fn(),
  createStatistics: vi.fn(),
  statisticsDetail: vi.fn(),
  cancelStatistics: vi.fn(),
  forNode: vi.fn(),
}))
vi.mock('@/api/modules/fs', () => ({ fsApi: { forNode: api.forNode } }))

/** 构造最小但真实的统计响应，按需覆盖生命周期或累计值。 */
const scan = (fields: Record<string, unknown> = {}) => ({
  success: true,
  data: { id: 'scan', path: '/logical', status: 'running', logicalBytes: 16, ...fields },
})
const wrappers: Array<ReturnType<typeof mount>> = []
/** 在组件作用域测试请求取消、定时器与卸载释放。 */
function setup() {
  let model!: ReturnType<typeof useFileProperties>
  const wrapper = mount(
    defineComponent({
      setup() {
        model = useFileProperties('fixed-node', '/logical')
        return () => h('div')
      },
    }),
    { global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] } },
  )
  wrappers.push(wrapper)
  return { wrapper, model }
}

describe('文件属性查询生命周期', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    api.forNode.mockReturnValue(api)
    api.detail.mockResolvedValue({
      success: true,
      data: { path: '/logical', revision: 'revision' },
    })
    api.createStatistics.mockResolvedValue(scan())
    api.statisticsDetail.mockResolvedValue(scan())
    api.cancelStatistics.mockResolvedValue(scan({ status: 'cancelling' }))
  })
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    vi.useRealTimers()
  })

  it('绑定固定节点与路径，只在点击后统计，关闭后取消并停止轮询', async () => {
    const { model, wrapper } = setup()
    await flushPromises()
    expect(api.forNode).toHaveBeenCalledWith('fixed-node')
    expect(api.detail.mock.calls[0]![0]).toBe('/logical')
    expect(api.createStatistics).not.toHaveBeenCalled()
    await model.calculate()
    expect(api.createStatistics).toHaveBeenCalledWith({
      path: '/logical',
      expectedRevision: 'revision',
    })
    wrapper.unmount()
    expect(api.cancelStatistics).toHaveBeenCalledWith('scan')
    await vi.advanceTimersByTimeAsync(10000)
    expect(api.statisticsDetail).not.toHaveBeenCalled()
  })

  it('关闭期间创建响应迟到时仍取消服务端统计，不回写组件状态', async () => {
    let resolve!: (value: unknown) => void
    api.createStatistics.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const { model, wrapper } = setup()
    await flushPromises()
    const pending = model.calculate()
    wrapper.unmount()
    resolve(scan())
    await pending
    expect(api.cancelStatistics).toHaveBeenCalledWith('scan')
    expect(model.statistics.value).toBeUndefined()
  })

  it('刷新取消旧请求，较晚返回的旧详情不能覆盖最新详情', async () => {
    let resolve!: (value: unknown) => void
    api.detail.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const { model } = setup()
    await flushPromises()
    const signal = api.detail.mock.calls[0]![1].signal as AbortSignal
    await model.load()
    resolve({ success: true, data: { path: '/wrong', revision: 'old' } })
    await flushPromises()
    expect(signal.aborted).toBe(true)
    expect(model.detail.value?.path).toBe('/logical')
  })

  it('慢查询不并发，断网保留累计结果并退避，恢复后继续跟踪', async () => {
    const { model } = setup()
    await flushPromises()
    await model.calculate()
    let reject!: (reason: Error) => void
    api.statisticsDetail.mockImplementationOnce(
      () =>
        new Promise((_resolve, r) => {
          reject = r
        }),
    )
    await vi.advanceTimersByTimeAsync(1000)
    await vi.advanceTimersByTimeAsync(20000)
    expect(api.statisticsDetail).toHaveBeenCalledTimes(1)
    reject(new Error('offline'))
    await flushPromises()
    expect(model.connectionError.value).toBe(true)
    expect(model.statistics.value?.logicalBytes).toBe(16)
    await vi.advanceTimersByTimeAsync(1999)
    expect(api.statisticsDetail).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(model.connectionError.value).toBe(false)
    expect(api.statisticsDetail).toHaveBeenCalledTimes(2)
  })

  it('取消提交不代表终态，晚到取消响应不能覆盖已确认终态', async () => {
    const { model } = setup()
    await flushPromises()
    await model.calculate()
    let resolve!: (value: unknown) => void
    api.cancelStatistics.mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r
        }),
    )
    const pending = model.cancel()
    expect(model.statistics.value?.status).toBe('cancelling')
    api.statisticsDetail.mockResolvedValue(scan({ status: 'succeeded' }))
    await vi.advanceTimersByTimeAsync(1000)
    resolve(scan({ status: 'cancelling' }))
    await pending
    expect(model.statistics.value?.status).toBe('succeeded')
  })

  it.each(['success', 'failure'])(
    '旧统计取消的迟到 %s 响应不影响重新计算后的新会话',
    async (outcome) => {
      const { model } = setup()
      await flushPromises()
      await model.calculate()
      let resolve!: (value: unknown) => void
      let reject!: (failure: Error) => void
      api.cancelStatistics.mockImplementationOnce(
        () =>
          new Promise((done, fail) => {
            resolve = done
            reject = fail
          }),
      )
      const cancellingOld = model.cancel()
      api.statisticsDetail.mockResolvedValueOnce(scan({ status: 'succeeded' }))
      await vi.advanceTimersByTimeAsync(1000)
      expect(model.statistics.value?.status).toBe('succeeded')
      api.createStatistics.mockResolvedValueOnce(scan({ id: 'scan-new', logicalBytes: 77 }))
      await model.calculate()
      if (outcome === 'failure') {
        api.cancelStatistics.mockResolvedValueOnce(
          scan({ id: 'scan-new', status: 'cancelling', logicalBytes: 77 }),
        )
        await model.cancel()
        reject(new Error('old cancellation failed'))
      } else {
        resolve(scan({ status: 'cancelling' }))
      }
      await cancellingOld
      expect(model.statistics.value).toMatchObject({
        id: 'scan-new',
        logicalBytes: 77,
        status: outcome === 'failure' ? 'cancelling' : 'running',
      })
      expect(model.statisticsError.value).toBe('')
      api.statisticsDetail.mockResolvedValueOnce(
        scan({ id: 'scan-new', status: 'succeeded', logicalBytes: 99 }),
      )
      await vi.advanceTimersByTimeAsync(1000)
      expect(api.statisticsDetail).toHaveBeenLastCalledWith('scan-new', expect.anything())
      expect(model.statistics.value).toMatchObject({
        id: 'scan-new',
        status: 'succeeded',
        logicalBytes: 99,
      })
    },
  )

  it('过期统计保留结果并停止查询，允许显式重新计算', async () => {
    const { model } = setup()
    await flushPromises()
    await model.calculate()
    api.statisticsDetail.mockResolvedValue({
      success: false,
      code: 410,
      errorCode: 'FILE_STATISTICS_EXPIRED',
    })
    await vi.advanceTimersByTimeAsync(1000)
    expect(model.trackingStopped.value).toBe(true)
    expect(model.statistics.value?.logicalBytes).toBe(16)
    expect(model.statisticsError.value).toContain('过期')
    await vi.advanceTimersByTimeAsync(5000)
    expect(api.statisticsDetail).toHaveBeenCalledTimes(1)
    await model.calculate()
    expect(api.createStatistics).toHaveBeenCalledTimes(2)
  })

  it('已确认终态后晚到的取消失败不再提示继续跟踪', async () => {
    const { model } = setup()
    await flushPromises()
    await model.calculate()
    let reject!: (failure: Error) => void
    api.cancelStatistics.mockImplementationOnce(
      () =>
        new Promise((_resolve, r) => {
          reject = r
        }),
    )
    const pending = model.cancel()
    api.statisticsDetail.mockResolvedValue(scan({ status: 'succeeded' }))
    await vi.advanceTimersByTimeAsync(1000)
    reject(new Error('cancel response lost'))
    await pending
    expect(model.statistics.value?.status).toBe('succeeded')
    expect(model.statisticsError.value).toBe('')
  })

  it('刷新先请求取消旧统计，然后清空旧累计结果；详情失败不保留旧信息', async () => {
    const { model } = setup()
    await flushPromises()
    await model.calculate()
    api.detail.mockResolvedValue({ success: false, message: 'file no longer exists' })
    await model.load()
    expect(api.cancelStatistics).toHaveBeenCalledWith('scan')
    expect(model.statistics.value).toBeUndefined()
    expect(model.detail.value).toBeUndefined()
    expect(model.error.value).toContain('no longer exists')
  })
})
