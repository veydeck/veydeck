import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { reactive } from 'vue'
import FileManagerView from '../FileManagerView.vue'
import FileBrowserContent from '@/components/files/FileBrowserContent.vue'
import FilePropertiesDialog from '@/components/files/FilePropertiesDialog.vue'
import zh from '@/locales/zh'
import { useToastStore } from '@/stores/toast'
import type { FsEntry } from '@/api/interface/fs'
const api = vi.hoisted(() => ({
  list: vi.fn(),
  suites: vi.fn(),
  sendCapture: vi.fn(),
  submitCapture: vi.fn(),
  centerTasks: [] as Array<{ kind: string; nodeId: string; finishedAt?: string }>,
  scope: vi.fn(),
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
    forNode: (nodeId: string) => {
      api.scope(nodeId)
      return {
        sendToTrafficAnalysis: api.sendCapture,
        listEntries: api.list,
        home: api.home,
        detail: api.detail,
        readFile: api.readFile,
      }
    },
  },
}))
vi.mock('@/api/modules/suites', () => ({ suitesApi: { fetchSuites: api.suites } }))
vi.mock('@/stores/task-center', () => ({
  useTaskCenterStore: () => ({
    open: vi.fn(),
    sendToTrafficAnalysis: api.submitCapture,
    get tasks() {
      return api.centerTasks
    },
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
function render(payload?: Record<string, unknown>) {
  const wrapper = mount(FileManagerView, {
    props: { windowId: 'file-window', payload },
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
    api.centerTasks = reactive([])
    api.windows = reactive({
      openWindows: [{ id: 'file-window', zIndex: 2, isMinimized: false }],
      maxZIndex: 2,
    })
    api.suites.mockResolvedValue({ success: true, data: { catalog: [], instances: [] } })
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
  /** 提供同节点安装状态与实际套件图标。 */
  function installedCapture(status = 'enabled', nodeId = 'file-node') {
    api.suites.mockResolvedValue({
      success: true,
      data: {
        instances: [
          {
            suiteId: 'veydeck.packet',
            nodeId,
            instanceId: 'packet-instance',
            packageId: 'package',
            status,
          },
        ],
        catalog: [
          {
            suiteId: 'veydeck.packet',
            icon: '/suite-icon.png',
            versions: [{ packageId: 'package', icon: '/installed-icon.png' }],
          },
        ],
      },
    })
  }
  /** 打开抓包文件菜单，读取传送到桌面的真实菜单元素。 */
  async function captureMenu(name = 'capture.PCAPNG', kind = 'file', canRead = true) {
    api.list.mockResolvedValue(
      page([
        {
          ...entry(0),
          name,
          path: `/home/${name}`,
          kind,
          capabilities: { ...entry(0).capabilities, canRead },
        } as FsEntry,
      ]),
    )
    const wrapper = render({ nodeId: 'file-node' })
    await flushPromises()
    await wrapper
      .get('[data-ui="file-entry"]')
      .trigger('contextmenu', { clientX: 100, clientY: 100 })
    await flushPromises()
    return {
      wrapper,
      action: document.querySelector<HTMLButtonElement>(
        '[data-ui="file-send-to-traffic-analysis"]',
      ),
    }
  }
  it('菜单使用实际套件图标，发送交给任务中心且文件窗口不显示进度', async () => {
    installedCapture()
    const { wrapper, action } = await captureMenu()
    expect(api.suites).toHaveBeenCalledWith('file-node')
    expect(action?.disabled).toBe(false)
    expect(action?.querySelector('img')?.getAttribute('src')).toBe('/installed-icon.png')
    action!.click()
    await flushPromises()
    expect(api.submitCapture).toHaveBeenCalledWith(
      'file-node',
      expect.objectContaining({ path: '/home/capture.PCAPNG' }),
    )
    expect(wrapper.find('[data-ui="file-traffic-sending"]').exists()).toBe(false)
    api.centerTasks.push({ kind: 'trafficAnalysis', nodeId: 'file-node' })
    await wrapper
      .get('[data-ui="file-entry"]')
      .trigger('contextmenu', { clientX: 100, clientY: 100 })
    await flushPromises()
    expect(
      document.querySelector<HTMLButtonElement>('[data-ui="file-send-to-traffic-analysis"]')
        ?.disabled,
    ).toBe(true)
    expect(api.open).not.toHaveBeenCalled()
  })
  it('已安装但未启用时菜单禁用并提示先启用，不可读文件也禁用', async () => {
    installedCapture('disabled')
    const first = await captureMenu('capture.pcap')
    expect(first.action?.disabled).toBe(true)
    expect(first.action?.title).toBe('请先启用流量解析')
    first.wrapper.unmount()
    document.body.innerHTML = ''
    installedCapture()
    const second = await captureMenu('capture.pcap', 'file', false)
    expect(second.action?.disabled).toBe(true)
  })
  it.each([
    ['capture.txt', 'file'],
    ['capture.pcap', 'symlink'],
    ['capture.pcapng', 'directory'],
  ])('不为 %s 类型 %s 提供发送入口', async (name, kind) => {
    installedCapture()
    expect((await captureMenu(name, kind)).action).toBeNull()
  })
  it('多选时不提供批量发送入口', async () => {
    installedCapture()
    api.list.mockResolvedValue(
      page(
        [0, 1].map((index) => ({
          ...entry(index),
          name: `capture-${index}.pcap`,
          capabilities: { ...entry(index).capabilities, canRead: true },
        })),
      ),
    )
    const wrapper = render({ nodeId: 'file-node' })
    await flushPromises()
    const entries = wrapper.findAll('[data-ui="file-entry"]')
    await entries[0]!.trigger('click')
    await entries[1]!.trigger('click', { ctrlKey: true })
    await entries[0]!.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await flushPromises()
    expect(document.querySelector('[data-ui="file-send-to-traffic-analysis"]')).toBeNull()
  })
  it('未安装或只有其他节点安装时隐藏入口', async () => {
    expect((await captureMenu()).action).toBeNull()
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    installedCapture('enabled', 'other-node')
    expect((await captureMenu()).action).toBeNull()
  })
  it('右键与 Alt+Enter 查看单项属性，多选禁用，空白菜单查看当前目录', async () => {
    const wrapper = render()
    await flushPromises()
    api.detail.mockResolvedValue({
      success: true,
      data: {
        ...entry(0),
        mode: 0o100644,
        uid: 0,
        gid: 0,
        allocatedBytes: 0,
      },
    })
    const items = wrapper.findAll('[data-ui="file-entry"]')
    await items[0]!.trigger('click')
    document.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }),
    )
    await flushPromises()
    expect(wrapper.getComponent(FilePropertiesDialog).props('path')).toBe('/home/file-0.txt')
    wrapper.getComponent(FilePropertiesDialog).vm.$emit('close')
    await flushPromises()
    await items[1]!.trigger('click', { ctrlKey: true })
    await items[0]!.trigger('contextmenu', { clientX: 100, clientY: 100 })
    await flushPromises()
    const disabled = document.querySelector<HTMLButtonElement>(
      '[data-ui="file-properties-action"]',
    )!
    expect(disabled.disabled).toBe(true)
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    await wrapper
      .get('[data-ui="file-grid"]')
      .trigger('contextmenu', { clientX: 100, clientY: 100 })
    await flushPromises()
    const current = document.querySelector<HTMLButtonElement>('[data-ui="file-properties-action"]')!
    expect(current.disabled).toBe(false)
    current.click()
    await flushPromises()
    expect(wrapper.getComponent(FilePropertiesDialog).props('path')).toBe('/home')
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
