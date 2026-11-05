import { beforeEach, describe, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { FileOperationTask, FsEntry } from '@/api/interface/fs'
import { useFileBrowserStore, normalizeFilePreferences } from '../file-browser'
const api = vi.hoisted(() => ({
  detail: vi.fn(),
  createTask: vi.fn(),
  register: vi.fn(),
  upload: vi.fn(),
  listener: undefined as ((...args: unknown[]) => void) | undefined,
}))
vi.mock('@/api/modules/fs', () => ({
  fsApi: { forNode: () => ({ detail: api.detail, createTask: api.createTask }) },
}))
vi.mock('../task-center', () => ({
  useTaskCenterStore: () => ({
    registerOperation: api.register,
    submitUpload: api.upload,
    subscribeOperation: (listener: (...args: unknown[]) => void) => {
      api.listener = listener
      return vi.fn()
    },
  }),
}))
/** 文件操作使用真实版本及最终执行端提供的能力摘要。 */
const entry = (name: string) =>
  ({
    name,
    path: '/source/' + name,
    kind: 'file',
    revision: 'revision-' + name,
    management: { kind: 'custom' },
    capabilities: { canCopy: true, canRemove: true },
  }) as FsEntry
/** 返回可控的服务端文件任务。 */
function task(status = 'running'): FileOperationTask {
  return {
    taskId: 'move-task',
    status,
    items: [
      { path: '/source/a', status: 'succeeded' },
      { path: '/source/b', status: 'failed' },
    ],
  } as FileOperationTask
}
describe('file browser clipboard', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.detail.mockResolvedValue({
      success: true,
      data: { capabilities: { canCreateChild: true } },
    })
    api.createTask.mockResolvedValue({ success: true, data: task() })
  })
  it('剪切请求创建期间与运行期间都拒绝重复粘贴，部分失败保留失败项', async () => {
    const store = useFileBrowserStore()
    store.start()
    store.capture('move', { nodeId: 'a', entries: [entry('a'), entry('b')] })
    const pending = store.paste('a', '/target')
    await expect(store.paste('a', '/target')).rejects.toThrow()
    await pending
    expect(api.createTask.mock.calls[0]![0].items[0]).toEqual({
      path: '/source/a',
      expectedRevision: 'revision-a',
      targetPath: '/target/a',
    })
    await expect(store.paste('a', '/target')).rejects.toThrow()
    api.listener?.({
      serverId: 'move-task',
      operationItems: task().items,
    })
    expect(store.clipboard?.entries.map((entry) => entry.name)).toEqual(['b'])
    expect(store.pendingTask).toBeUndefined()
  })
  it('复制可重复粘贴，跨节点拒绝且不发出请求，登出清理引用', async () => {
    const store = useFileBrowserStore()
    store.capture('copy', { nodeId: 'a', entries: [entry('a')] })
    await expect(store.paste('b', '/target')).rejects.toThrow()
    expect(api.createTask).not.toHaveBeenCalled()
    await store.paste('a', '/target')
    await store.paste('a', '/target')
    expect(api.createTask).toHaveBeenCalledTimes(2)
    expect(store.clipboard).toBeDefined()
    store.reset()
    expect(store.clipboard).toBeUndefined()
  })
  it('创建失败解除剪切锁，规范化无效显示偏好', async () => {
    const store = useFileBrowserStore()
    store.capture('move', { nodeId: 'a', entries: [entry('a')] })
    api.createTask.mockResolvedValue({ success: false, message: 'conflict' })
    await expect(store.paste('a', '/target')).rejects.toThrow('conflict')
    expect(store.pendingTask).toBeUndefined()
    expect(store.clipboard).toBeDefined()
    expect(normalizeFilePreferences({ iconSize: 999 as 48 })).toEqual({
      view: 'icons',
      iconSize: 48,
      sortBy: 'name',
      sortOrder: 'ascending',
      showHidden: false,
    })
  })
  it('登出时尚未完成的文件夹遍历不能将上传加入下一次会话', async () => {
    const store = useFileBrowserStore()
    let resolve!: (value: unknown) => void
    const read = vi.fn(
      () =>
        new Promise((resolveRead) => {
          resolve = resolveRead
        }),
    )
    const pending = store.uploadDrop('a', '/target', read as never)
    await Promise.resolve()
    store.reset()
    resolve({
      files: [{ file: new File(['a'], 'a'), relativePath: 'a' }],
      kind: 'files',
      displayName: 'a',
    })
    await pending
    expect(api.upload).not.toHaveBeenCalled()
  })
  it('链接目录使用目标的创建能力，但提交路径仍保留链接地址', async () => {
    api.detail.mockResolvedValue({
      success: true,
      data: {
        kind: 'symlink',
        capabilities: { canCreateChild: false },
        symlinkTargetCapabilities: { canCreateChild: true },
      },
    })
    const store = useFileBrowserStore()
    store.capture('copy', { nodeId: 'a', entries: [entry('a')] })
    await store.paste('a', '/alias')
    expect(api.createTask.mock.calls[0]![0].items[0].targetPath).toBe('/alias/a')
    const selection = {
      kind: 'files' as const,
      displayName: 'a',
      files: [{ file: new File(['a'], 'a'), relativePath: 'a' }],
    }
    await store.uploadDrop('a', '/alias', async () => selection)
    expect(api.upload).toHaveBeenCalledWith('a', '/alias', selection)
  })
})
