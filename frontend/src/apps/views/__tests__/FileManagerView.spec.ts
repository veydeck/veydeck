import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { reactive } from 'vue'
import FileManagerView from '../FileManagerView.vue'
import FileBrowserContent from '@/components/files/FileBrowserContent.vue'
import zh from '@/locales/zh'
import { useToastStore } from '@/stores/toast'
import type { FsEntry } from '@/api/interface/fs'
const api = vi.hoisted(() => ({
  list: vi.fn(),
  home: vi.fn(),
  detail: vi.fn(),
  readFile: vi.fn(),
  open: vi.fn(),
  subscribe: vi.fn(() => vi.fn()),
  upload: vi.fn(),
  tasks: vi.fn(),
  windows: {
    openWindows: [{ id: 'file-window', zIndex: 2, isMinimized: false }],
    maxZIndex: 2,
  },
}))
vi.mock('@/api/modules/fs', () => ({
  fsApi: {
    forNode: () => ({
      listEntries: api.list,
      home: api.home,
      detail: api.detail,
      readFile: api.readFile,
    }),
  },
}))
vi.mock('@/stores/task-center', () => ({
  useTaskCenterStore: () => ({
    open: vi.fn(),
    subscribe: api.subscribe,
    subscribeOperation: api.subscribe,
    registerOperation: vi.fn(),
  }),
}))
vi.mock('@/stores/node', () => ({ useNodeStore: () => ({ currentNodeId: 'local' }) }))
vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => ({
    openWindowWithPayload: api.open,
    updateWindowRuntimeState: vi.fn(),
    get openWindows() {
      return api.windows.openWindows
    },
    get maxZIndex() {
      return api.windows.maxZIndex
    },
  }),
}))
vi.mock('@/composables/useFileOperations', () => ({
  useFileOperations: () => ({
    startUpload: api.upload,
    runPathTask: api.tasks,
    renamePath: vi.fn(),
    mkdir: vi.fn(),
    createFile: vi.fn(),
  }),
}))
/** 构造包含权限和版本的目录条目。 */
const entry = (index: number) =>
  ({
    name: `file-${index}.txt`,
    path: `/home/file-${index}.txt`,
    kind: 'file',
    revision: String(index),
    capabilities: { canOpen: true, canCopy: true, canRemove: true, canRename: true },
    management: { kind: 'custom' },
  }) as FsEntry
/** 返回稳定快照的目录页。 */
const page = (entries: FsEntry[], total = entries.length) => ({
  success: true,
  data: { path: '/home', entries, total, snapshotId: 'snapshot', loadedAt: 'now', counts: {} },
})
const mounted: Array<ReturnType<typeof mount>> = []
/** 安装真实偏好与剪贴板 Store，使用当前应用的组件和国际化。 */
function render() {
  const wrapper = mount(FileManagerView, {
    props: { windowId: 'file-window' },
    attachTo: document.body,
    global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
  })
  mounted.push(wrapper)
  return wrapper
}
describe('desktop file manager', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    api.windows = reactive({
      openWindows: [{ id: 'file-window', zIndex: 2, isMinimized: false }],
      maxZIndex: 2,
    })
    api.home.mockResolvedValue({ success: true, data: { path: '/home' } })
    api.detail.mockResolvedValue({
      success: true,
      data: { capabilities: { canCreateChild: true } },
    })
    api.list.mockResolvedValue(page(Array.from({ length: 10 }, (_, i) => entry(i))))
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    )
  })
  afterEach(() => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })
  it('统一单选、Ctrl 切换和 Shift 区间选择，切换视图保留选择', async () => {
    const wrapper = render()
    await flushPromises()
    const items = wrapper.findAll('[data-ui="file-entry"]')
    await items[1]!.trigger('click')
    await items[4]!.trigger('click', { shiftKey: true })
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(4)
    await items[2]!.trigger('click', { ctrlKey: true })
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(3)
    await wrapper.get('[data-ui="file-view-menu"]').trigger('click')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-ui="file-view-details"]')!.click()
    await flushPromises()
    expect(wrapper.findAll('[aria-selected="true"]')).toHaveLength(3)
  })
  it('只处理活动窗口快捷键，输入框内复制不写入文件剪贴板，新建窗口固定节点目录', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-ui="file-entry"]').trigger('click')
    const input = document.createElement('input')
    document.body.append(input)
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    expect(api.open).not.toHaveBeenCalled()
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'n', ctrlKey: true, bubbles: true, cancelable: true }),
    )
    expect(api.open).toHaveBeenCalledWith(
      'file-manager',
      { nodeId: 'local', path: '/home' },
      expect.objectContaining({ instanceId: expect.stringContaining('file-manager-') }),
    )
  })
  it('最顶层窗口最小化后让出快捷键，恢复后重新处理', async () => {
    const wrapper = render()
    await flushPromises()
    await wrapper.get('[data-ui="file-entry"]').trigger('click')
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'c',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    api.windows.openWindows[0]!.isMinimized = true
    const listCalls = api.list.mock.calls.length
    for (const init of [
      { key: 'n', ctrlKey: true },
      { key: 'v', ctrlKey: true },
      { key: 'F5' },
      { key: 'a', ctrlKey: true },
    ]) {
      const event = new KeyboardEvent('keydown', { ...init, bubbles: true, cancelable: true })
      document.body.dispatchEvent(event)
      expect(event.defaultPrevented).toBe(false)
    }
    await flushPromises()
    expect(api.open).not.toHaveBeenCalled()
    expect(api.list).toHaveBeenCalledTimes(listCalls)
    api.windows.openWindows[0]!.isMinimized = false
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'n',
        ctrlKey: true,
        bubbles: true,
        cancelable: true,
      }),
    )
    expect(api.open).toHaveBeenCalledTimes(1)
  })
  it('单击地址栏空白即可编辑，目录段仍可导航，精简工具栏只保留统一视图入口', async () => {
    const wrapper = render()
    await flushPromises()
    expect(wrapper.find('[data-ui="file-refresh"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="file-view-tasks"]').exists()).toBe(false)
    expect(wrapper.get('[data-ui="file-status"]').text()).not.toContain('Ctrl+A')
    const toolbar = wrapper.get('[data-ui="file-manager-toolbar"]')
    expect(toolbar.text()).not.toContain('新建窗口')
    expect(wrapper.find('[data-ui="file-view-details"]').exists()).toBe(false)
    await wrapper.get('[data-ui="file-address"]').trigger('click')
    await flushPromises()
    const input = wrapper.get('[data-ui="file-address"] input').element as HTMLInputElement
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('/home')
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(5)
    await wrapper.get('[data-ui="file-address"] input').trigger('keydown', { key: 'Escape' })
    await flushPromises()
    expect(wrapper.find('[data-ui="file-address"] input').exists()).toBe(false)
    const requestCount = api.list.mock.calls.length
    await wrapper.findAll('[data-ui="file-breadcrumb"]')[0]!.trigger('click')
    await flushPromises()
    expect(api.list.mock.calls.length).toBe(requestCount + 1)
    expect(wrapper.find('[data-ui="file-address"] input').exists()).toBe(false)
  })
  it('目录链接按目标类型打开，列表、地址栏和新窗口始终保留链接路径', async () => {
    const link = { ...entry(0), kind: 'symlink' as const, name: 'bin', path: '/home/bin' }
    api.list.mockResolvedValueOnce(page([link])).mockResolvedValue(page([]))
    const wrapper = render()
    await flushPromises()
    api.detail.mockResolvedValueOnce({
      success: true,
      data: {
        ...link,
        symlinkTargetKind: 'directory',
        symlinkTargetCapabilities: { canOpen: true, canCreateChild: true },
      },
    })
    await wrapper.get('[data-ui="file-entry"]').trigger('dblclick')
    await flushPromises()
    expect(api.list.mock.calls.at(-1)?.[0].path).toBe('/home/bin')
    expect(api.open).not.toHaveBeenCalled()
    await wrapper.get('[data-ui="file-address"]').trigger('click')
    await flushPromises()
    expect((wrapper.get('[data-ui="file-address"] input').element as HTMLInputElement).value).toBe(
      '/home/bin',
    )
  })
  it('文本链接在原路径打开编辑器，失效或不可读链接不创建编辑器窗口', async () => {
    const link = { ...entry(0), kind: 'symlink' as const, path: '/home/file-link' }
    api.list.mockResolvedValue(page([link]))
    const wrapper = render()
    await flushPromises()
    api.detail.mockResolvedValue({
      success: true,
      data: {
        ...link,
        symlinkTargetKind: 'file',
        symlinkTargetCapabilities: { canOpen: true, canRead: true },
      },
    })
    api.readFile.mockResolvedValue({ success: true, data: { path: link.path, content: 'text' } })
    await wrapper.get('[data-ui="file-entry"]').trigger('dblclick')
    await flushPromises()
    expect(api.open).toHaveBeenCalledWith('file-editor', {
      nodeId: 'local',
      path: '/home/file-link',
    })
    api.open.mockClear()
    const error = vi.spyOn(useToastStore(), 'error')
    api.detail.mockResolvedValue({
      success: true,
      data: { ...link, symlinkError: 'FILE_NOT_FOUND' },
    })
    await wrapper.get('[data-ui="file-entry"]').trigger('dblclick')
    await flushPromises()
    expect(api.open).not.toHaveBeenCalled()
    expect(error).toHaveBeenCalled()
    api.detail.mockResolvedValue({
      success: true,
      data: {
        ...link,
        symlinkTargetKind: 'file',
        symlinkTargetCapabilities: { canOpen: true, canRead: true },
      },
    })
    api.readFile.mockResolvedValue({ success: false, message: 'permission denied' })
    await wrapper.get('[data-ui="file-entry"]').trigger('dblclick')
    await flushPromises()
    expect(api.open).not.toHaveBeenCalled()
    expect(error).toHaveBeenLastCalledWith('permission denied')
  })
  it('一万条记录仅渲染可视条目，切换大图标仍保持 DOM 数量有界', async () => {
    const entries = Array.from({ length: 10000 }, (_, i) => entry(i))
    const wrapper = mount(FileBrowserContent, {
      props: {
        entries,
        selected: new Set(),
        view: 'icons',
        iconSize: 48,
        hasMore: false,
        loading: false,
        location: 'local:/home',
        cutPaths: new Set(),
        nodeId: 'local',
      },
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    mounted.push(wrapper)
    expect(wrapper.findAll('[data-ui="file-entry"]').length).toBeLessThan(100)
    await wrapper.setProps({ iconSize: 64, view: 'details' })
    expect(wrapper.findAll('[data-ui="file-entry"]').length).toBeLessThan(30)
  })
  it('连续加载携带快照，关闭窗口会取消请求和释放目录变更订阅', async () => {
    api.list
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 30 }, (_, i) => entry(i)),
          60,
        ),
      )
      .mockResolvedValue(
        page(
          Array.from({ length: 30 }, (_, i) => entry(i + 30)),
          60,
        ),
      )
    const wrapper = render()
    await flushPromises()
    await wrapper.get('button').trigger('click')
    wrapper.findComponent(FileBrowserContent).vm.$emit('more')
    await flushPromises()
    expect(api.list.mock.calls.at(-1)?.[0]).toMatchObject({ snapshotId: 'snapshot', page: 2 })
    const signal = api.list.mock.calls.at(-1)?.[1].signal as AbortSignal
    wrapper.unmount()
    mounted.splice(mounted.indexOf(wrapper), 1)
    expect(signal.aborted).toBe(true)
  })
})
