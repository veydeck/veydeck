import { defineComponent } from 'vue'
import { createI18n, useI18n } from 'vue-i18n'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createFileUploadRunner } from '@/services/file-upload'
import zh from '@/locales/zh'

const client = vi.hoisted(() => ({
  mkdir: vi.fn(),
  activeTransfers: vi.fn(),
  createTransfer: vi.fn(),
  uploadChunk: vi.fn(),
  completeTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  transferDetail: vi.fn(),
}))

vi.mock('@/api/modules/fs', () => ({
  fsApi: { forNode: vi.fn(() => client) },
}))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ error: vi.fn(), success: vi.fn() }),
}))

const response = <T>(data: T) => ({ success: true, code: 200, message: '', data })
const transfer = (transferId: string, path: string, sizeBytes: number, transferredBytes = 0) => ({
  transferId,
  nodeId: 'node-a',
  direction: 'upload' as const,
  status: transferredBytes === sizeBytes ? ('ready' as const) : ('created' as const),
  path,
  sizeBytes,
  transferredBytes,
  createdAt: '2026-08-24T00:00:00Z',
  updatedAt: '2026-08-24T00:00:00Z',
  expiresAt: '2026-08-25T00:00:00Z',
})

const Harness = defineComponent({
  setup: () => createFileUploadRunner('node-a', useI18n().t),
  template: '<div />',
})
const mountHarness = () =>
  mount(Harness, {
    global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
  })

describe('file upload runner', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    client.mkdir.mockResolvedValue(response({}))
    client.activeTransfers.mockResolvedValue(response([]))
    client.createTransfer.mockImplementation(
      ({ path, sizeBytes }: { path: string; sizeBytes: number }) =>
        Promise.resolve(
          response(
            transfer(`transfer-${client.createTransfer.mock.calls.length}`, path, sizeBytes),
          ),
        ),
    )
    client.uploadChunk.mockImplementation(
      (
        transferId: string,
        chunk: ArrayBuffer,
        _start: number,
        _end: number,
        total: number,
        options: { onProgress?: (loaded: number) => void },
      ) => {
        options.onProgress?.(chunk.byteLength)
        return Promise.resolve(response(transfer(transferId, '', total, total)))
      },
    )
    client.completeTransfer.mockImplementation((transferId: string) =>
      Promise.resolve(
        response({ ...transfer(transferId, '', 0, 0), status: 'completed' as const }),
      ),
    )
    client.cancelTransfer.mockImplementation((transferId: string) =>
      Promise.resolve(
        response({ ...transfer(transferId, '', 0, 0), status: 'cancelled' as const }),
      ),
    )
  })

  it('按层级创建目录并串行完成文件夹内文件', async () => {
    const wrapper = mountHarness()
    const first = new File(['abc'], 'first.txt')
    const empty = new File([], 'empty.txt')

    const changed = await wrapper.vm.startUpload('/home', {
      kind: 'folder',
      displayName: 'docs',
      files: [
        { file: first, relativePath: 'docs/first.txt' },
        { file: empty, relativePath: 'docs/nested/empty.txt' },
      ],
    })

    expect(changed).toBe(true)
    expect(client.mkdir.mock.calls.map(([payload]) => payload.path)).toEqual([
      '/home/docs',
      '/home/docs/nested',
    ])
    expect(client.createTransfer.mock.calls.map(([payload]) => payload.path)).toEqual([
      '/home/docs/first.txt',
      '/home/docs/nested/empty.txt',
    ])
    expect(wrapper.vm.uploadTask.status).toBe('completed')
    expect(wrapper.vm.uploadTask.completedFiles).toBe(2)
    expect(wrapper.vm.uploadTask.progressPercent).toBe(100)
    wrapper.unmount()
  })

  it('单项失败后继续队列并形成部分完成终态', async () => {
    client.createTransfer
      .mockResolvedValueOnce({ success: false, code: 409, message: 'already exists', data: null })
      .mockResolvedValueOnce(response(transfer('transfer-2', '/home/b.txt', 1)))
    const wrapper = mountHarness()

    await wrapper.vm.startUpload('/home', {
      kind: 'files',
      displayName: '2 files',
      files: [
        { file: new File(['a'], 'a.txt'), relativePath: 'a.txt' },
        { file: new File(['b'], 'b.txt'), relativePath: 'b.txt' },
      ],
    })

    expect(client.createTransfer).toHaveBeenCalledTimes(2)
    expect(wrapper.vm.uploadTask.status).toBe('partial')
    expect(wrapper.vm.uploadTask.completedFiles).toBe(1)
    expect(wrapper.vm.uploadTask.failedFiles).toBe(1)
    expect(wrapper.vm.uploadTask.failures[0]?.path).toBe('a.txt')
    wrapper.unmount()
  })

  it('取消时中止当前请求、只取消一次且不启动后续文件', async () => {
    client.uploadChunk.mockImplementation(
      (
        _transferId: string,
        _chunk: ArrayBuffer,
        _start: number,
        _end: number,
        _total: number,
        options: { signal: AbortSignal; onProgress?: (loaded: number) => void },
      ) =>
        new Promise((_resolve, reject) => {
          options.onProgress?.(1)
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const wrapper = mountHarness()
    const running = wrapper.vm.startUpload('/home', {
      kind: 'files',
      displayName: '2 files',
      files: [
        { file: new File(['first'], 'first.txt'), relativePath: 'first.txt' },
        { file: new File(['second'], 'second.txt'), relativePath: 'second.txt' },
      ],
    })
    await flushPromises()

    await wrapper.vm.cancelUpload()
    await running

    expect(client.cancelTransfer).toHaveBeenCalledTimes(1)
    expect(client.createTransfer).toHaveBeenCalledTimes(1)
    expect(wrapper.vm.uploadTask.status).toBe('cancelled')
    expect(wrapper.vm.uploadTask.completedFiles).toBe(0)
    wrapper.unmount()
  })
  it('大文件按 8 MiB 分块传输并保持连续范围', async () => {
    const wrapper = mountHarness()
    const file = new File([new Uint8Array(8 * 1024 * 1024 + 1)], 'large.bin')
    await wrapper.vm.startUpload('/home', {
      kind: 'files',
      displayName: file.name,
      files: [{ file, relativePath: file.name }],
    })
    expect(client.uploadChunk).toHaveBeenCalledTimes(2)
    expect(client.uploadChunk.mock.calls.map((call) => call.slice(2, 5))).toEqual([
      [0, 8 * 1024 * 1024 - 1, file.size],
      [8 * 1024 * 1024, file.size - 1, file.size],
    ])
    expect(wrapper.vm.uploadTask.status).toBe('completed')
    wrapper.unmount()
  })

  it('提交响应丢失时从服务端确认完成，不误报失败', async () => {
    client.completeTransfer.mockResolvedValueOnce({ success: false, message: 'connection lost' })
    client.cancelTransfer.mockResolvedValueOnce({ success: false, message: 'already completed' })
    client.transferDetail.mockResolvedValueOnce(
      response({ ...transfer('transfer-1', '/home/file', 3, 3), status: 'completed' }),
    )
    const wrapper = mountHarness()
    await wrapper.vm.startUpload('/home', {
      kind: 'files',
      displayName: 'file',
      files: [{ file: new File(['abc'], 'file'), relativePath: 'file' }],
    })
    expect(wrapper.vm.uploadTask.status).toBe('completed')
    expect(wrapper.vm.uploadTask.completedFiles).toBe(1)
    wrapper.unmount()
  })

  it('取消清理失败时保持取消中，恢复连接后才进入终态', async () => {
    vi.useFakeTimers()
    let rejectCancel!: (error: Error) => void
    client.cancelTransfer.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        rejectCancel = reject
      }),
    )
    client.uploadChunk.mockImplementation(
      (_id, _chunk, _start, _end, _total, options: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          )
        }),
    )
    const wrapper = mountHarness()
    try {
      const running = wrapper.vm.startUpload('/home', {
        kind: 'files',
        displayName: 'file',
        files: [{ file: new File(['abc'], 'file'), relativePath: 'file' }],
      })
      await flushPromises()
      const cancellation = wrapper.vm.cancelUpload()
      rejectCancel(new Error('offline'))
      await flushPromises()
      expect(wrapper.vm.uploadTask.status).toBe('cancelling')
      expect(wrapper.vm.uploadTask.connectionError).toBe('offline')
      await vi.advanceTimersByTimeAsync(1000)
      await cancellation
      await running
      expect(wrapper.vm.uploadTask.status).toBe('cancelled')
      expect(wrapper.vm.uploadTask.connectionError).toBeUndefined()
    } finally {
      wrapper.unmount()
      vi.useRealTimers()
    }
  })
})
