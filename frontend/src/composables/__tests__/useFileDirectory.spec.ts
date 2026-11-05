import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { useFileDirectory } from '../useFileDirectory'
const api = vi.hoisted(() => ({ list: vi.fn(), detail: vi.fn() }))
vi.mock('@/api/modules/fs', () => ({
  fsApi: { forNode: () => ({ listEntries: api.list, detail: api.detail }) },
}))
vi.mock('@/stores/file-browser', () => ({
  useFileBrowserStore: () => ({
    preferences: { sortBy: 'name', sortOrder: 'ascending', showHidden: false },
  }),
}))
/** 提供可复用快照响应，目录条目用于验证旧响应不会回流。 */
const page = (path: string, total = 1) => ({
  success: true,
  data: {
    snapshotId: 'snapshot-' + path,
    path,
    entries: [{ path: path + '/file', name: 'file' }],
    total,
    loadedAt: 'now',
  },
})
const wrappers: Array<ReturnType<typeof mount>> = []
/** 在组件作用域创建目录模型以验证卸载与监听释放。 */
function setup() {
  let model!: ReturnType<typeof useFileDirectory>
  const interacting = ref(false)
  const replace = vi.fn()
  const wrapper = mount(
    defineComponent({
      setup() {
        model = useFileDirectory(ref('a'), interacting, replace)
        return () => h('div')
      },
    }),
  )
  wrappers.push(wrapper)
  return { model, interacting, replace }
}
describe('file directory snapshots', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.detail.mockResolvedValue({
      success: true,
      data: { capabilities: { canCreateChild: true } },
    })
  })
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
  })
  it('快速导航取消旧请求，较晚返回的旧响应不能覆盖新路径', async () => {
    let resolve!: (value: unknown) => void
    api.list
      .mockImplementationOnce(() => new Promise((r) => (resolve = r)))
      .mockResolvedValue(page('/second'))
    const { model } = setup()
    const first = model.load('/first')
    const signal = api.list.mock.calls[0]![1].signal as AbortSignal
    await model.load('/second')
    resolve(page('/first'))
    await first
    expect(signal.aborted).toBe(true)
    expect(model.path.value).toBe('/second')
    expect(model.entries.value[0]!.path).toBe('/second/file')
  })
  it('过期快照不会拼接到新列表，框选结束后才重载并清理选择', async () => {
    api.list
      .mockResolvedValueOnce(page('/source', 10))
      .mockResolvedValueOnce({ success: false, errorCode: 'FILE_LIST_SNAPSHOT_EXPIRED' })
      .mockResolvedValue(page('/source', 10))
    const { model, interacting, replace } = setup()
    await model.load('/source')
    interacting.value = true
    await model.more()
    expect(api.list).toHaveBeenCalledTimes(2)
    interacting.value = false
    await flushPromises()
    expect(api.list.mock.calls[2]![0]).toMatchObject({ page: 1, snapshotId: undefined })
    expect(model.entries.value).toHaveLength(1)
    expect(replace).toHaveBeenCalledTimes(2)
  })
  it('导航失败保留旧内容，重试失败目标而不是拼接其它快照', async () => {
    api.list
      .mockResolvedValueOnce(page('/source', 10))
      .mockResolvedValueOnce({ success: false, message: 'offline' })
      .mockResolvedValue(page('/target'))
    const { model } = setup()
    await model.load('/source')
    await model.load('/target')
    expect(model.path.value).toBe('/source')
    expect(model.entries.value).toHaveLength(1)
    await model.retry()
    expect(api.list.mock.calls.at(-1)![0]).toMatchObject({
      path: '/target',
      page: 1,
      snapshotId: undefined,
    })
    expect(model.path.value).toBe('/target')
  })
})
