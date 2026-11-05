import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { useTaskCenterStore } from '@/stores/task-center'
import type { FileOperationTask } from '@/api/interface/fs'

const mocks = vi.hoisted(() => ({
  forNode: vi.fn(),
  nodes: [
    { id: 'a', name: 'A', status: 'online' },
    { id: 'b', name: 'B', status: 'online' },
  ],
  info: vi.fn(),
}))
vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => ({ openWindow: vi.fn() }),
}))
vi.mock('@/api/modules/fs', () => ({ fsApi: { forNode: mocks.forNode } }))
vi.mock('@/stores/node', () => ({ useNodeStore: () => ({ nodes: mocks.nodes }) }))
vi.mock('@/stores/toast', () => ({ useToastStore: () => ({ info: mocks.info, error: vi.fn() }) }))

const ok = <T>(data: T) => ({ success: true, data, message: '' })
/** 创建可被测试控制的异步请求。 */
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const operation = (
  taskId: string,
  status: FileOperationTask['status'] = 'running',
): FileOperationTask => ({
  taskId,
  nodeId: 'a',
  operation: 'copy',
  status,
  stage: 'copying',
  progressPercent: 42,
  totalItemCount: 2,
  completedItemCount: 0,
  failedItemCount: 0,
  totalBytes: 100,
  processedBytes: 42,
  items: [{ path: '/source/file', targetPath: '/dest/file', status: 'running' }],
  createdAt: new Date().toISOString(),
})
const selection = (name: string) => ({
  kind: 'files' as const,
  displayName: name,
  files: [{ file: new File(['abc'], name), relativePath: name }],
})

/** 验证全局队列、会话边界与服务端事实恢复。 */
describe('task center', () => {
  let center: ReturnType<typeof useTaskCenterStore>
  let client: ReturnType<typeof createClient>
  function createClient() {
    return {
      activeTasks: vi.fn().mockResolvedValue(ok([])),
      activeTransfers: vi.fn().mockResolvedValue(ok([])),
      taskDetail: vi.fn(),
      transferDetail: vi.fn(),
      cancelTask: vi.fn(),
      mkdir: vi.fn().mockResolvedValue(ok({})),
      createTransfer: vi
        .fn()
        .mockImplementation(({ path, sizeBytes }) =>
          Promise.resolve(
            ok({ transferId: path, transferredBytes: 0, sizeBytes, status: 'created' }),
          ),
        ),
      uploadChunk: vi.fn().mockResolvedValue(ok({ transferredBytes: 3 })),
      completeTransfer: vi.fn().mockResolvedValue(ok({ status: 'completed' })),
      cancelTransfer: vi.fn().mockResolvedValue(ok({ status: 'cancelled' })),
    }
  }
  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    setActivePinia(createPinia())
    client = createClient()
    mocks.forNode.mockReturnValue(client)
    center = useTaskCenterStore()
  })
  afterEach(() => {
    center.reset()
    vi.useRealTimers()
  })

  it('同节点 FIFO、跨节点并行，窗口展示不影响上传', async () => {
    const blocked = deferred<ReturnType<typeof ok<{ transferredBytes: number }>>>()
    client.uploadChunk.mockReturnValue(blocked.promise)
    center.submitUpload('a', '/one', selection('first'))
    center.submitUpload('a', '/two', selection('second'))
    center.submitUpload('b', '/three', selection('third'))
    center.open('files')
    await flushPromises()
    expect(client.createTransfer.mock.calls.map(([request]) => request.path)).toEqual([
      '/one/first',
      '/three/third',
    ])
    expect(center.activeCount).toBe(3)
    expect(center.tasks[1]?.status).toBe('queued')
    expect(center.hasBrowserUploads).toBe(true)
    blocked.resolve(ok({ transferredBytes: 3 }))
    await flushPromises()
    expect(client.createTransfer.mock.calls.map(([request]) => request.path)).toContain(
      '/two/second',
    )
    expect(center.tasks.every((task) => task.status === 'completed')).toBe(true)
    expect(center.hasBrowserUploads).toBe(false)
    expect(center.tasks.every((task) => task.category === 'files')).toBe(true)
  })

  it('提交窗口的作用域销毁后仍持续更新上传结果', async () => {
    const commit = deferred<ReturnType<typeof ok<{ status: string }>>>()
    client.completeTransfer.mockReturnValue(commit.promise)
    const windowScope = effectScope()
    windowScope.run(() => center.submitUpload('a', '/target', selection('file')))
    await flushPromises()
    windowScope.stop()
    commit.resolve(ok({ status: 'completed' }))
    await flushPromises()
    expect(center.tasks[0]?.status).toBe('completed')
    expect(center.tasks[0]?.completedFiles).toBe(1)
    expect(center.hasBrowserUploads).toBe(false)
  })

  it('排队取消释放批次、不发起服务端传输；完成提交前不宣告成功', async () => {
    const commit = deferred<ReturnType<typeof ok<{ status: string }>>>()
    client.completeTransfer.mockReturnValue(commit.promise)
    center.submitUpload('a', '/one', selection('first'))
    center.submitUpload('a', '/two', selection('second'))
    await flushPromises()
    expect(center.tasks[0]?.progress).toBe(100)
    expect(center.tasks[0]?.status).toBe('uploading')
    await center.cancel(center.tasks[1]!.id)
    expect(center.tasks[1]?.status).toBe('cancelled')
    commit.resolve(ok({ status: 'completed' }))
    await flushPromises()
    expect(client.createTransfer).toHaveBeenCalledTimes(1)
  })

  it('服务端查询失败保留状态、串行退避并在恢复后发布目录事件', async () => {
    const listener = vi.fn()
    const unsubscribe = center.subscribe(listener)
    client.taskDetail
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(ok(operation('task', 'succeeded')))
    center.registerOperation('a', operation('task'))
    center.registerOperation('a', operation('task'))
    expect(center.tasks).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1000)
    expect(center.tasks[0]?.status).toBe('running')
    expect(center.tasks[0]?.connectionError).toBe('offline')
    await vi.advanceTimersByTimeAsync(1999)
    expect(client.taskDetail).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(center.tasks[0]?.status).toBe('succeeded')
    expect(center.tasks[0]?.connectionError).toBeUndefined()
    expect(listener).toHaveBeenCalledWith('a', ['/source', '/dest'])
    unsubscribe()
    center.registerOperation('a', operation('next', 'failed'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('单个任务请求尚未返回时不重叠轮询，reset 后丢弃迟到结果', async () => {
    const pending = deferred<ReturnType<typeof ok<FileOperationTask>>>()
    client.taskDetail.mockReturnValue(pending.promise)
    center.registerOperation('a', operation('task'))
    await vi.advanceTimersByTimeAsync(20000)
    expect(client.taskDetail).toHaveBeenCalledTimes(1)
    center.reset()
    pending.resolve(ok(operation('task', 'succeeded')))
    await flushPromises()
    expect(center.tasks).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('取消请求仅更新服务端返回状态，清理阶段不能被展示为取消完成', async () => {
    client.cancelTask.mockResolvedValue(
      ok({ ...operation('task'), status: 'cancelling', stage: 'rollingBack' }),
    )
    center.registerOperation('a', operation('task'))
    await center.cancel(center.tasks[0]!.id)
    expect(center.tasks[0]?.status).toBe('cancelling')
    await center.cancel(center.tasks[0]!.id)
    expect(client.cancelTask).toHaveBeenCalledTimes(1)
    expect(center.activeCount).toBe(1)
  })

  it('取消的迟到结果不能覆盖轮询已确认的终态', async () => {
    const request = deferred<ReturnType<typeof ok<FileOperationTask>>>()
    client.cancelTask.mockReturnValue(request.promise)
    client.taskDetail.mockResolvedValue(ok(operation('task', 'succeeded')))
    center.registerOperation('a', operation('task'))
    const cancelling = center.cancel(center.tasks[0]!.id)
    await vi.advanceTimersByTimeAsync(1000)
    expect(center.tasks[0]?.status).toBe('succeeded')
    request.resolve(ok({ ...operation('task'), status: 'cancelling' }))
    await cancelling
    expect(center.tasks[0]?.status).toBe('succeeded')
    expect(center.activeCount).toBe(0)
  })

  it('取消确认后忽略在途轮询的旧状态', async () => {
    const request = deferred<ReturnType<typeof ok<FileOperationTask>>>()
    client.taskDetail.mockReturnValue(request.promise)
    client.cancelTask.mockResolvedValue(ok(operation('task', 'cancelled')))
    center.registerOperation('a', operation('task'))
    await vi.advanceTimersByTimeAsync(1000)
    await center.cancel(center.tasks[0]!.id)
    request.resolve(ok(operation('task')))
    await flushPromises()
    expect(center.tasks[0]?.status).toBe('cancelled')
    expect(center.activeCount).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('活动发现只接入文件任务和下载，去重且不接管上传', async () => {
    client.activeTasks.mockResolvedValue(ok([operation('task')]))
    client.activeTransfers.mockResolvedValue(
      ok([
        {
          transferId: 'upload',
          direction: 'upload',
          status: 'receiving',
          path: '/file',
          sizeBytes: 100,
          transferredBytes: 10,
        },
        {
          transferId: 'download',
          direction: 'download',
          status: 'streaming',
          path: '/file',
          sizeBytes: 100,
          transferredBytes: 10,
        },
      ]),
    )
    center.start()
    await flushPromises()
    expect(center.tasks).toHaveLength(4)
    expect(center.tasks.some((task) => task.kind === 'upload')).toBe(false)
    center.start()
    expect(client.activeTasks).toHaveBeenCalledTimes(2)
  })

  it('最多保留 100 条终态，活动任务不可清除', () => {
    center.registerOperation('a', operation('active'))
    for (let i = 0; i < 105; i++) center.registerOperation('a', operation(String(i), 'succeeded'))
    expect(center.tasks).toHaveLength(101)
    center.remove('a:operation:active')
    expect(center.activeCount).toBe(1)
    center.clearFinished('files')
    expect(center.tasks).toHaveLength(1)
    expect(center.tasks[0]?.id).toBe('a:operation:active')
  })

  it('拒绝目录逃逸，不创建任务', () => {
    const invalid = selection('file')
    invalid.files[0]!.relativePath = '../file'
    expect(center.submitUpload('a', '/target', invalid)).toBe(false)
    expect(center.tasks).toHaveLength(0)
  })
  it('上传下载速度根据真实字节增量采样，结束后不保留旧速度', async () => {
    let time = 0
    vi.spyOn(performance, 'now').mockImplementation(() => time)
    client.transferDetail.mockImplementation(async (id: string) =>
      ok({
        transferId: id,
        status: 'streaming',
        sizeBytes: 10000,
        transferredBytes: time,
        path: '/download',
      }),
    )
    center.registerDownload('a', {
      transferId: 'download',
      nodeId: 'a',
      direction: 'download',
      status: 'streaming',
      path: '/download',
      sizeBytes: 10000,
      transferredBytes: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      expiresAt: new Date().toISOString(),
    })
    center.start()
    time = 1000
    await vi.advanceTimersByTimeAsync(1000)
    time = 2000
    await vi.advanceTimersByTimeAsync(1000)
    expect(center.tasks[0]?.bytesPerSecond).toBe(1000)
    center.tasks[0]!.status = 'completed'
    time = 3000
    await vi.advanceTimersByTimeAsync(1000)
    expect(center.tasks[0]?.bytesPerSecond).toBeUndefined()
  })
})
