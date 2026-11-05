import { defineComponent, nextTick } from 'vue'
import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { mount, flushPromises } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useNodeStore } from '@/stores/node'
import { useWindowManagerStore } from '@/stores/window-manager'
import zh from '@/locales/zh'
import en from '@/locales/en'

const fetchAppsMock = vi.hoisted(() => vi.fn())

vi.mock('@/api/modules/apps', () => ({
  appsApi: {
    fetchApps: fetchAppsMock,
  },
}))

vi.mock('@/api/modules/desktop', () => ({
  desktopApi: {
    fetchDesktopApps: vi.fn().mockResolvedValue({ success: false, data: null }),
    saveDesktopApps: vi.fn().mockResolvedValue({ success: true, data: null }),
  },
}))

const Harness = defineComponent({
  setup() {
    return { windowStore: useWindowManagerStore() }
  },
  template: '<div />',
})

beforeEach(() => {
  localStorage.clear()
  fetchAppsMock.mockReset()
  fetchAppsMock.mockResolvedValue({ success: false, data: null })
})

describe('终端窗口节点绑定', () => {
  it('固定节点 payload，标题只显示可国际化的应用名', async () => {
    const pinia = createPinia()
    const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })
    const wrapper = mount(Harness, {
      global: {
        plugins: [pinia, i18n],
      },
    })
    const nodeStore = useNodeStore(pinia)
    nodeStore.setNodes([
      { id: 'node-a', name: '节点 A', address: '', status: 'online', tags: [] },
      { id: 'node-b', name: '节点 B', address: '', status: 'online', tags: [] },
    ])
    nodeStore.setCurrentNode('node-a')

    wrapper.vm.windowStore.openWindow('terminal')
    const terminalWindow = wrapper.vm.windowStore.openWindows[0]
    expect(terminalWindow?.payload).toEqual({ nodeId: 'node-a', nodeName: '节点 A' })
    expect(terminalWindow?.title).toBe('终端')
    expect(wrapper.vm.windowStore.checkBeforeNodeSwitch().allowed).toBe(false)

    nodeStore.setCurrentNode('node-b')
    expect(terminalWindow?.payload).toEqual({ nodeId: 'node-a', nodeName: '节点 A' })

    i18n.global.locale.value = 'en'
    await nextTick()
    expect(terminalWindow?.title).toBe('Terminal')
    wrapper.unmount()
  })
})

describe('套件窗口节点切换守卫', () => {
  it('固化代理 Web 套件的节点上下文，并在窗口关闭前阻止切换', async () => {
    fetchAppsMock.mockResolvedValue({
      success: true,
      data: [
        {
          appId: 'suite-a-dashboard',
          i18nTitleKey: '',
          title: '节点 A 套件',
          icon: 'package',
          defaultWidth: 960,
          defaultHeight: 640,
          minWidth: 640,
          minHeight: 420,
          hidden: false,
          sortOrder: 100,
          sourceType: 'suite',
          suiteInstanceId: 'suite-instance-a',
          nodeId: 'node-a',
          appEntryId: 'dashboard',
          entryType: 'proxied_web',
          entryTarget: '/api/v1/suites/proxy/suite-instance-a/dashboard/',
        },
      ],
    })

    const pinia = createPinia()
    const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })
    const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] } })
    const nodeStore = useNodeStore(pinia)
    nodeStore.setNodes([
      { id: 'node-a', name: '节点 A', address: '', status: 'online', tags: [] },
      { id: 'node-b', name: '节点 B', address: '', status: 'online', tags: [] },
    ])
    nodeStore.setCurrentNode('node-a')
    await wrapper.vm.windowStore.loadAppCatalog()

    wrapper.vm.windowStore.openWindow('suite-a-dashboard')
    const suiteWindow = wrapper.vm.windowStore.openWindows[0]
    expect(suiteWindow?.appId).toBe('suite-web-app')
    expect(suiteWindow?.title).toBe('节点 A 套件')
    expect(suiteWindow?.nodeContext).toEqual({
      nodeId: 'node-a',
      nodeScope: 'current-node',
      nodeSwitchPolicy: 'block-while-open',
    })

    let guard = wrapper.vm.windowStore.checkBeforeNodeSwitch()
    expect(guard.allowed).toBe(false)
    expect(guard.blockers).toMatchObject([
      {
        windowId: 'suite-a-dashboard',
        title: '节点 A 套件',
        level: 'open',
      },
    ])

    wrapper.vm.windowStore.minimizeWindow('suite-a-dashboard')
    expect(wrapper.vm.windowStore.checkBeforeNodeSwitch().allowed).toBe(false)

    wrapper.vm.windowStore.closeWindow('suite-a-dashboard')
    guard = wrapper.vm.windowStore.checkBeforeNodeSwitch()
    expect(guard).toEqual({ allowed: true, blockers: [] })
    wrapper.unmount()
  })

  it('保持套件中心和显式节点应用可切换，并继续阻止 Compose 套件窗口', async () => {
    fetchAppsMock.mockResolvedValue({
      success: true,
      data: [
        {
          appId: 'suite-a-compose',
          i18nTitleKey: '',
          title: '节点 A Compose',
          icon: 'package',
          defaultWidth: 960,
          defaultHeight: 640,
          minWidth: 640,
          minHeight: 420,
          hidden: false,
          sortOrder: 100,
          sourceType: 'suite',
          suiteInstanceId: 'suite-instance-a',
          nodeId: 'node-a',
          appEntryId: 'compose',
          entryType: 'compose_detail',
          entryTarget: 'suite-project-a',
        },
      ],
    })

    const pinia = createPinia()
    const i18n = createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })
    const wrapper = mount(Harness, { global: { plugins: [pinia, i18n] } })
    const nodeStore = useNodeStore(pinia)
    nodeStore.setNodes([
      { id: 'node-a', name: '节点 A', address: '', status: 'online', tags: [] },
      { id: 'node-b', name: '节点 B', address: '', status: 'online', tags: [] },
    ])
    nodeStore.setCurrentNode('node-a')
    await wrapper.vm.windowStore.loadAppCatalog()

    wrapper.vm.windowStore.openWindow('suite-center')
    wrapper.vm.windowStore.openWindow('runtime-log')
    expect(wrapper.vm.windowStore.checkBeforeNodeSwitch().allowed).toBe(true)

    wrapper.vm.windowStore.openWindow('suite-a-compose')
    const dockerWindow = wrapper.vm.windowStore.openWindows.find(
      (item) => item.appId === 'docker-manager',
    )
    expect(dockerWindow?.payload).toEqual({
      composeProject: 'suite-project-a',
      nodeId: 'node-a',
    })
    expect(wrapper.vm.windowStore.checkBeforeNodeSwitch().allowed).toBe(false)
    wrapper.unmount()
  })
})

/** 任务中心复用普通应用窗口，不占用全局节点或桌面交互。 */
describe('任务中心窗口', () => {
  it('允许共存、最小化和节点切换，重复打开聚焦同一窗口', async () => {
    fetchAppsMock.mockResolvedValue({
      success: true,
      data: [
        {
          appId: 'task-center',
          i18nTitleKey: 'taskCenter.title',
          icon: '/images/apps/task-center.png',
          defaultWidth: 1024,
          defaultHeight: 640,
          minWidth: 640,
          minHeight: 360,
          hidden: false,
          sortOrder: 151,
          sourceType: 'builtin',
        },
      ],
    })
    const pinia = createPinia()
    const wrapper = mount(Harness, {
      global: {
        plugins: [pinia, createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })],
      },
    })
    await flushPromises()
    const store = wrapper.vm.windowStore
    store.openWindow('task-center')
    const window = store.openWindows[0]!
    expect(window.title).toBe('任务中心')
    expect(window.width).toBe(1024)
    expect(window.nodeContext?.nodeScope).toBe('global')
    expect(store.checkBeforeNodeSwitch().allowed).toBe(true)
    expect(store.checkBeforeCloseWindow(window.id).allowed).toBe(true)
    store.minimizeWindow(window.id)
    expect(window.isMinimized).toBe(true)
    store.openWindow('task-center')
    expect(window.isMinimized).toBe(false)
    expect(store.openWindows).toHaveLength(1)
    store.openWindow('notification-center')
    expect(store.openWindows).toHaveLength(2)
    store.toggleMaximize(window.id)
    expect(window.isMaximized).toBe(true)
    store.closeWindow(window.id)
    expect(store.openWindows.some((item) => item.id === window.id)).toBe(false)
    wrapper.unmount()
  })
})

describe('文件管理桌面入口', () => {
  it('每次启动创建独立实例，已有窗口仍由任务栏恢复，不覆盖原目录', async () => {
    const pinia = createPinia()
    const wrapper = mount(Harness, {
      global: {
        plugins: [pinia, createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })],
      },
    })
    const nodes = useNodeStore(pinia)
    nodes.setNodes([{ id: 'node-a', name: '节点 A', address: '', status: 'online', tags: [] }])
    nodes.setCurrentNode('node-a')
    const store = wrapper.vm.windowStore
    store.openWindow('file-manager')
    const first = store.openWindows[0]!
    first.payload = { ...first.payload, path: '/source' }
    store.minimizeWindow(first.id)
    store.openWindow('file-manager')
    const second = store.openWindows[1]!
    expect(first.id).not.toBe(second.id)
    expect(first.isMinimized).toBe(true)
    expect(first.payload).toEqual({ nodeId: 'node-a', path: '/source' })
    expect(second.payload).toEqual({ nodeId: 'node-a' })
    expect(second.nodeContext?.nodeId).toBe('node-a')
    wrapper.unmount()
  })
})
