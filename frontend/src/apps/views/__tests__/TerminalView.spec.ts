import { createI18n } from 'vue-i18n'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import TerminalView from '../TerminalView.vue'
import zh from '@/locales/zh'
import { terminalApi } from '@/api/modules/terminal'

const xtermSpies = vi.hoisted(() => ({
  write: vi.fn(),
  focus: vi.fn(),
  clear: vi.fn(),
  reset: vi.fn(),
}))

vi.mock('@/api/modules/terminal', () => ({
  terminalApi: {
    fetchAccess: vi.fn(),
    getWebSocketUrl: vi.fn(() => 'ws://localhost/terminal'),
  },
}))

vi.mock('@/stores/theme', () => ({
  useThemeStore: () => ({ currentTheme: 'light' }),
  buildTerminalTheme: () => ({}),
}))

const updateWindowRuntimeState = vi.fn()
vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => ({ updateWindowRuntimeState }),
}))

vi.mock('@xterm/xterm', () => ({
  Terminal: class {
    cols = 80
    rows = 24
    options: Record<string, unknown> = {}
    textarea = document.createElement('textarea')
    loadAddon() {}
    open() {}
    onData() {}
    onResize() {}
    write = xtermSpies.write
    focus = xtermSpies.focus
    clear = xtermSpies.clear
    reset = xtermSpies.reset
    dispose() {}
  },
}))

vi.mock('@xterm/addon-fit', () => ({
  FitAddon: class {
    fit() {}
  },
}))

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}

class FakeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSED = 3
  static instances: FakeWebSocket[] = []

  readyState = FakeWebSocket.CONNECTING
  binaryType = ''
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null

  constructor() {
    FakeWebSocket.instances.push(this)
  }

  send() {}

  open() {
    this.readyState = FakeWebSocket.OPEN
    this.onopen?.()
  }

  message(data: string | ArrayBuffer) {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  close() {
    this.readyState = FakeWebSocket.CLOSED
  }
}

const api = vi.mocked(terminalApi)

describe('TerminalView', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', ResizeObserverStub)
    vi.stubGlobal('WebSocket', FakeWebSocket)
    FakeWebSocket.instances = []
    xtermSpies.write.mockClear()
    xtermSpies.focus.mockClear()
    xtermSpies.clear.mockClear()
    xtermSpies.reset.mockClear()
    api.fetchAccess.mockResolvedValue({
      success: true,
      code: 200,
      message: '',
      data: {
        ownership: 'system',
        nodeId: 'node-a',
        nodeName: '节点 A',
        availability: 'available',
        shell: 'bash',
        idleTimeoutSeconds: 1_800,
        capabilities: { canStartSession: true },
        unavailableReason: null,
      },
    })
  })

  it('只使用窗口 payload 中固定的目标节点并提供稳定标记', async () => {
    const wrapper = mount(TerminalView, {
      props: {
        windowId: 'terminal-1',
        payload: { nodeId: 'node-a', nodeName: '节点 A' },
      },
      global: {
        plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
      },
    })
    await flushPromises()

    expect(api.fetchAccess).toHaveBeenCalledWith('node-a')
    expect(wrapper.get('[data-page="terminal"]').exists()).toBe(true)
    expect(wrapper.get('[data-ui="terminal-tabbar"]').text()).toContain('节点 A')
    expect(wrapper.get('[data-ui="terminal-canvas"]').attributes('aria-label')).toContain('节点 A')
    expect(updateWindowRuntimeState).toHaveBeenCalledWith(
      'terminal-1',
      expect.objectContaining({ allowsNodeSwitch: false }),
    )
    wrapper.unmount()
  })

  it('打开自动连接、控制事件不写入转录，退出后只显示一次退出结果并可在当前标签重连', async () => {
    const wrapper = mount(TerminalView, {
      props: { payload: { nodeId: 'node-a', nodeName: '节点 A' } },
      global: {
        plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
      },
    })
    await flushPromises()
    expect(wrapper.find('[data-ui="terminal-confirm-dialog"]').exists()).toBe(false)
    expect(FakeWebSocket.instances).toHaveLength(1)

    const socket = FakeWebSocket.instances[0]!
    socket.open()
    socket.message(
      JSON.stringify({
        kind: 'started',
        payload: {
          sessionId: 'session-1',
          shell: 'bash',
          startedAt: '2026-07-16T00:00:00Z',
          idleTimeoutSeconds: 1_800,
        },
      }),
    )
    expect(xtermSpies.write).not.toHaveBeenCalled()

    socket.message(new TextEncoder().encode('root@localhost:~# ').buffer)
    await flushPromises()
    socket.message(
      JSON.stringify({
        kind: 'exited',
        payload: {
          sessionId: 'session-1',
          exitCode: 0,
          reason: 'processExited',
          endedAt: '2026-07-16T00:00:01Z',
        },
      }),
    )
    await flushPromises()

    expect(xtermSpies.write).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-ui="terminal-inactive"]').text()).toContain('退出码：0')
    expect(FakeWebSocket.instances).toHaveLength(1)

    expect(wrapper.get('[data-ui="terminal-inactive"] p').text()).toBe('终端会话已结束，退出码：0')
    expect(wrapper.find('[data-ui="terminal-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="terminal-clear"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="terminal-connect"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="terminal-disconnect"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="terminal-cancel"]').exists()).toBe(false)
    expect(wrapper.text().match(/终端会话已结束，退出码：0/g)).toHaveLength(1)
    xtermSpies.clear.mockClear()
    xtermSpies.reset.mockClear()
    await wrapper.get('[data-ui="terminal-reconnect"]').trigger('click')
    await flushPromises()
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(1)
    expect(wrapper.find('[data-ui="terminal-inactive"]').exists()).toBe(false)
    expect(xtermSpies.reset).toHaveBeenCalledTimes(1)
    expect(xtermSpies.clear).toHaveBeenCalledTimes(1)
    wrapper.unmount()
  })
  it('新标签独立连接，切换不重建，关闭只释放对应会话', async () => {
    const wrapper = mount(TerminalView, {
      props: { windowId: 'terminal-tabs', payload: { nodeId: 'node-a', nodeName: '节点 A' } },
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    await flushPromises()
    const first = FakeWebSocket.instances[0]!
    await wrapper.get('[data-ui="terminal-add-tab"]').trigger('click')
    await flushPromises()
    const second = FakeWebSocket.instances[1]!
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(wrapper.findAll('[role="tab"]')).toHaveLength(2)
    await wrapper.findAll('[role="tab"]')[0]!.trigger('click')
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(second.readyState).toBe(FakeWebSocket.CONNECTING)
    await wrapper.findAll('[data-ui="terminal-close-tab"]')[0]!.trigger('click')
    expect(first.readyState).toBe(FakeWebSocket.CLOSED)
    expect(second.readyState).toBe(FakeWebSocket.CONNECTING)
    expect(wrapper.get('[role="tab"]').attributes('aria-selected')).toBe('true')
    expect(updateWindowRuntimeState).toHaveBeenLastCalledWith('terminal-tabs', expect.objectContaining({ activeSession: true }))
    await wrapper.get('[data-ui="terminal-close-tab"]').trigger('click')
    expect(second.readyState).toBe(FakeWebSocket.CLOSED)
    expect(FakeWebSocket.instances).toHaveLength(2)
    expect(wrapper.get('[data-ui="terminal-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-ui="terminal-tabbar"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="terminal-add-tab"]').exists()).toBe(false)
    expect(updateWindowRuntimeState).toHaveBeenLastCalledWith('terminal-tabs', expect.objectContaining({ activeSession: false }))
    wrapper.unmount()
  })

  it('所有终端显示序号，新建标签复用已关闭的序号', async () => {
    const wrapper = mount(TerminalView, {
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    await flushPromises()
    const labels = () => wrapper.findAll('.terminal-tab-name').map((tab) => tab.text())
    expect(labels()).toEqual(['local · 1'])
    expect(wrapper.get('[data-ui="terminal-add-tab"]').attributes('title')).toBeUndefined()
    expect(wrapper.findComponent({ name: 'VeyTooltip' }).props('text')).toBe('新建终端')
    await wrapper.get('[data-ui="terminal-add-tab"]').trigger('click')
    await wrapper.get('[data-ui="terminal-add-tab"]').trigger('click')
    await flushPromises()
    expect(labels()).toEqual(['local · 1', 'local · 2', 'local · 3'])
    const third = FakeWebSocket.instances[2]!
    await wrapper.findAll('[data-ui="terminal-close-tab"]')[1]!.trigger('click')
    await wrapper.get('[data-ui="terminal-add-tab"]').trigger('click')
    await flushPromises()
    expect(labels()).toEqual(['local · 1', 'local · 3', 'local · 2'])
    expect(third.readyState).toBe(FakeWebSocket.CONNECTING)
    while (wrapper.find('[data-ui="terminal-close-tab"]').exists()) {
      await wrapper.get('[data-ui="terminal-close-tab"]').trigger('click')
    }
    await wrapper.get('[data-ui="terminal-empty"] button').trigger('click')
    await flushPromises()
    expect(labels()).toEqual(['local · 1'])
    expect(wrapper.find('[data-ui="terminal-add-tab"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('检查失败时不连接，重试成功后连接', async () => {
    api.fetchAccess.mockRejectedValueOnce(new Error('offline'))
    const wrapper = mount(TerminalView, {
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    await flushPromises()
    expect(FakeWebSocket.instances).toHaveLength(0)
    await wrapper.get('[data-ui="terminal-access-failed"] button').trigger('click')
    await flushPromises()
    expect(FakeWebSocket.instances).toHaveLength(1)
    wrapper.unmount()
  })

  it('访问检查期间关闭窗口，不再创建连接', async () => {
    let resolveAccess!: (value: Awaited<ReturnType<typeof terminalApi.fetchAccess>>) => void
    const response = await api.fetchAccess('local')
    api.fetchAccess.mockImplementationOnce(() => new Promise((resolve) => { resolveAccess = resolve }))
    const wrapper = mount(TerminalView, {
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    wrapper.unmount()
    resolveAccess(response)
    await flushPromises()
    expect(FakeWebSocket.instances).toHaveLength(0)
  })

})
