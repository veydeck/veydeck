import { defineComponent, nextTick } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NetworkConnectionListPage, ProcessListPage } from '@/api/generated'
import { useProcessManager } from '@/composables/useProcessManager'

const api = vi.hoisted(() => ({
  forNode: vi.fn(),
  listProcesses: vi.fn(),
  listNetworkConnections: vi.fn(),
  terminate: vi.fn(),
  createForceKillConfirmation: vi.fn(),
  forceKill: vi.fn(),
}))

vi.mock('@/api/modules/process', () => ({ processApi: { forNode: api.forNode } }))

const response = <T>(data: T) => ({ success: true, code: 200, message: '', data })

const processPage = (name: string): ProcessListPage => ({
  snapshotId: 'snapshot-initial',
  entries: [
    {
      processId: 'a'.repeat(64),
      pid: 42,
      name,
      parentPid: 1,
      threadCount: 1,
      userName: 'root',
      state: 'running',
      management: { kind: 'custom' },
      capabilities: { canTerminate: true, canForceKill: true },
    },
  ],
  page: 1,
  pageSize: 100,
  availableTotal: 1,
  total: 1,
  counts: { running: 1 },
  sampledAt: '2026-07-16T00:00:00.000Z',
  coverage: {
    status: 'complete',
    scannedCount: 1,
    succeededCount: 1,
    failedCount: 0,
    warnings: [],
  },
})

const networkPage = (): NetworkConnectionListPage => ({
  entries: [],
  page: 1,
  pageSize: 100,
  availableTotal: 0,
  total: 0,
  byState: {},
  byProtocol: {},
  sampledAt: '2026-07-16T00:00:00.000Z',
  coverage: {
    status: 'complete',
    scannedCount: 0,
    succeededCount: 0,
    failedCount: 0,
    warnings: [],
  },
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((complete) => {
    resolve = complete
  })
  return { promise, resolve }
}

const Harness = defineComponent({
  setup() {
    return useProcessManager('node-a')
  },
  template: '<div />',
})

describe('useProcessManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.forNode.mockReturnValue({
      listProcesses: api.listProcesses,
      listNetworkConnections: api.listNetworkConnections,
      terminate: api.terminate,
      createForceKillConfirmation: api.createForceKillConfirmation,
      forceKill: api.forceKill,
    })
    api.listProcesses.mockResolvedValue(response(processPage('initial')))
    api.listNetworkConnections.mockResolvedValue(response(networkPage()))
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('固定节点且并发筛选变化只提交最新查询结果', async () => {
    const first = deferred<ReturnType<typeof response<ProcessListPage>>>()
    const latest = deferred<ReturnType<typeof response<ProcessListPage>>>()
    api.listProcesses.mockReset()
    api.listProcesses.mockReturnValueOnce(first.promise).mockReturnValueOnce(latest.promise)
    const wrapper = mount(Harness)

    wrapper.vm.processQuery.query = 'old'
    await nextTick()
    wrapper.vm.processQuery.query = 'latest'
    await nextTick()
    expect(api.forNode).toHaveBeenCalledWith('node-a')
    expect(api.listProcesses).toHaveBeenCalledTimes(1)

    first.resolve(response(processPage('old result')))
    await flushPromises()
    expect(api.listProcesses).toHaveBeenCalledTimes(2)
    expect(api.listProcesses.mock.calls[1]?.[0]).toMatchObject({ query: 'latest' })
    latest.resolve(response(processPage('latest result')))
    await flushPromises()

    expect(wrapper.vm.processPage?.entries[0]?.name).toBe('latest result')
    wrapper.unmount()
  })

  it('后台刷新失败时保留旧进程数据并进入 stale', async () => {
    const wrapper = mount(Harness)
    await flushPromises()
    api.listProcesses.mockResolvedValueOnce({
      success: false,
      code: 503,
      message: 'sampler unavailable',
      data: null,
    })

    await wrapper.vm.refresh()

    expect(wrapper.vm.processPage?.entries[0]?.name).toBe('initial')
    expect(wrapper.vm.processPhase).toBe('stale')
    expect(wrapper.vm.processError).toBe('sampler unavailable')
    wrapper.unmount()
  })

  it('仅轮询活动标签且轮询请求不重叠', async () => {
    vi.useFakeTimers()
    const wrapper = mount(Harness)
    await flushPromises()
    expect(api.listProcesses).toHaveBeenCalledTimes(1)

    wrapper.vm.setActiveView('network')
    await flushPromises()
    expect(api.listNetworkConnections).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(3000)
    expect(api.listProcesses).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(api.listNetworkConnections).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('触底串行追加同一快照，并在刷新时替换整个已加载范围', async () => {
    const first = { ...processPage('first'), total: 3, pageSize: 1 }
    const second = {
      ...first,
      page: 2,
      entries: [{ ...first.entries[0]!, processId: 'second', pid: 43, name: 'second' }],
    }
    api.listProcesses.mockResolvedValueOnce(response(first))
    const wrapper = mount(Harness)
    await flushPromises()
    const pending = deferred<ReturnType<typeof response<ProcessListPage>>>()
    api.listProcesses.mockReturnValueOnce(pending.promise)
    const loading = wrapper.vm.loadMoreProcesses()
    await wrapper.vm.loadMoreProcesses()
    expect(api.listProcesses).toHaveBeenCalledTimes(2)
    expect(api.listProcesses.mock.calls[1]?.[0]).toMatchObject({
      page: 2,
      snapshotId: 'snapshot-initial',
    })
    expect(wrapper.vm.processLoadingMore).toBe(true)
    pending.resolve(response(second))
    await loading
    expect(wrapper.vm.processPage?.entries.map((row) => row.name)).toEqual(['first', 'second'])

    api.listProcesses.mockResolvedValueOnce(
      response({
        ...second,
        page: 3,
        entries: [{ ...first.entries[0]!, processId: 'third', name: 'third' }],
      }),
    )
    await wrapper.vm.loadMoreProcesses()
    expect(wrapper.vm.processPage?.entries).toHaveLength(3)
    expect(wrapper.vm.processHasMore).toBe(false)

    api.listProcesses.mockResolvedValueOnce(response({ ...first, total: 1 }))
    await wrapper.vm.refresh()
    expect(wrapper.vm.processPage?.entries.map((row) => row.name)).toEqual(['first'])
    expect(wrapper.vm.processHasMore).toBe(false)
    wrapper.unmount()
  })

  it('刷新完整读取已展开页后原子提交，中途失败保留全部旧数据', async () => {
    const first = { ...processPage('first'), total: 200 }
    const second = { ...first, page: 2, entries: [{ ...first.entries[0]!, processId: 'second' }] }
    api.listProcesses.mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second))
    const wrapper = mount(Harness)
    await flushPromises()
    await wrapper.vm.loadMoreProcesses()
    api.listProcesses
      .mockResolvedValueOnce(
        response({ ...first, entries: [{ ...first.entries[0]!, name: 'updated' }] }),
      )
      .mockRejectedValueOnce(new Error('refresh failed'))
    await wrapper.vm.refresh()
    expect(wrapper.vm.processPage?.entries).toHaveLength(2)
    expect(wrapper.vm.processPage?.entries[0]?.name).toBe('first')
    expect(wrapper.vm.processPhase).toBe('stale')
    api.listProcesses
      .mockResolvedValueOnce(
        response({ ...first, entries: [{ ...first.entries[0]!, name: 'updated' }] }),
      )
      .mockResolvedValueOnce(response(second))
    await wrapper.vm.refresh()
    expect(wrapper.vm.processPage?.entries[0]?.name).toBe('updated')
    expect(wrapper.vm.processPage?.entries).toHaveLength(2)
    wrapper.unmount()
  })

  it('追加失败保留数据和页号，重试继续同一页，末页不再请求', async () => {
    const first = { ...processPage('first'), total: 200 }
    api.listProcesses.mockResolvedValueOnce(response(first))
    const wrapper = mount(Harness)
    await flushPromises()
    api.listProcesses.mockRejectedValueOnce(new Error('load more failed'))
    await wrapper.vm.loadMoreProcesses()
    expect(wrapper.vm.processLoadMoreError).toBe('load more failed')
    expect(wrapper.vm.processPage?.entries[0]?.name).toBe('first')
    expect(wrapper.vm.processHasMore).toBe(true)
    api.listProcesses.mockResolvedValueOnce(response({ ...first, entries: [], page: 2 }))
    await wrapper.vm.loadMoreProcesses()
    expect(api.listProcesses.mock.calls[2]?.[0]).toMatchObject({
      page: 2,
      snapshotId: 'snapshot-initial',
    })
    expect(wrapper.vm.processLoadMoreError).toBeNull()
    expect(wrapper.vm.processHasMore).toBe(false)
    await wrapper.vm.loadMoreProcesses()
    expect(api.listProcesses).toHaveBeenCalledTimes(3)
    wrapper.unmount()
  })

  it('追加期间筛选变化清空列表且丢弃过期响应，从第一页重新加载', async () => {
    api.listProcesses.mockResolvedValueOnce(response({ ...processPage('first'), total: 200 }))
    const wrapper = mount(Harness)
    await flushPromises()
    const pending = deferred<ReturnType<typeof response<ProcessListPage>>>()
    api.listProcesses.mockReturnValueOnce(pending.promise)
    const loading = wrapper.vm.loadMoreProcesses()
    wrapper.vm.processQuery.status = 'sleeping'
    await nextTick()
    expect(wrapper.vm.processPage).toBeNull()
    expect(wrapper.vm.processGeneration).toBe(1)
    api.listProcesses.mockResolvedValueOnce(response(processPage('filtered')))
    pending.resolve(response(processPage('obsolete')))
    await loading
    await flushPromises()
    expect(wrapper.vm.processPage?.entries[0]?.name).toBe('filtered')
    expect(api.listProcesses.mock.calls[2]?.[0]).toMatchObject({ page: 1, status: 'sleeping' })
    wrapper.unmount()
  })

  it('多页刷新从新快照开始，其余页固定沿用该快照', async () => {
    const first = { ...processPage('first'), total: 200 }
    const second = { ...first, page: 2, entries: [{ ...first.entries[0]!, processId: 'second' }] }
    api.listProcesses.mockResolvedValueOnce(response(first)).mockResolvedValueOnce(response(second))
    const wrapper = mount(Harness)
    await flushPromises()
    await wrapper.vm.loadMoreProcesses()
    api.listProcesses
      .mockResolvedValueOnce(response({ ...second, page: 1, snapshotId: 'snapshot-new' }))
      .mockResolvedValueOnce(response({ ...first, page: 2, snapshotId: 'snapshot-new' }))
    await wrapper.vm.refresh()
    expect(api.listProcesses.mock.calls[2]?.[0]).toMatchObject({ page: 1, snapshotId: undefined })
    expect(api.listProcesses.mock.calls[3]?.[0]).toMatchObject({
      page: 2,
      snapshotId: 'snapshot-new',
    })
    expect(wrapper.vm.processPage?.entries.map((row) => row.processId)).toEqual([
      'second',
      first.entries[0]!.processId,
    ])
    expect(wrapper.vm.processPage?.snapshotId).toBe('snapshot-new')
    wrapper.unmount()
  })

  it('过期快照追加失败后重新刷新，保留已展示范围直到新快照就绪', async () => {
    const first = { ...processPage('first'), total: 200 }
    api.listProcesses.mockResolvedValueOnce(response(first))
    const wrapper = mount(Harness)
    await flushPromises()
    const replacement = deferred<ReturnType<typeof response<ProcessListPage>>>()
    api.listProcesses
      .mockResolvedValueOnce({
        success: false,
        code: 410,
        errorCode: 'PROCESS_SNAPSHOT_EXPIRED',
        message: 'expired',
        data: null,
      })
      .mockReturnValueOnce(replacement.promise)
    await wrapper.vm.loadMoreProcesses()
    await flushPromises()
    expect(wrapper.vm.processPage?.snapshotId).toBe('snapshot-initial')
    expect(api.listProcesses.mock.calls[2]?.[0]).toMatchObject({ page: 1, snapshotId: undefined })
    replacement.resolve(response({ ...first, snapshotId: 'replacement' }))
    await flushPromises()
    expect(wrapper.vm.processPage?.snapshotId).toBe('replacement')
    expect(wrapper.vm.processLoadMoreError).toBeNull()
    wrapper.unmount()
  })

  it('后续分页快照标识改变时拒绝合并并保留原数据', async () => {
    const first = { ...processPage('first'), total: 200 }
    api.listProcesses.mockResolvedValueOnce(response(first))
    const wrapper = mount(Harness)
    await flushPromises()
    api.listProcesses.mockResolvedValueOnce(
      response({ ...first, snapshotId: 'unexpected', page: 2 }),
    )
    await wrapper.vm.loadMoreProcesses()
    expect(wrapper.vm.processPage?.snapshotId).toBe('snapshot-initial')
    expect(wrapper.vm.processPage?.entries).toHaveLength(1)
    expect(wrapper.vm.processLoadMoreError).toBeTruthy()
    wrapper.unmount()
  })

  it('区分连接来源不完整与进程归属不完整', async () => {
    const ownerPartialPage = networkPage()
    ownerPartialPage.coverage.ownerCoveragePercent = 62.4
    api.listNetworkConnections.mockResolvedValue(response(ownerPartialPage))
    const wrapper = mount(Harness)

    wrapper.vm.setActiveView('network')
    await flushPromises()

    expect(wrapper.vm.networkPartial).toBe(false)
    expect(wrapper.vm.networkOwnerPartial).toBe(true)
    expect(wrapper.vm.networkOwnerCoveragePercent).toBe(62.4)
    wrapper.unmount()
  })
})
