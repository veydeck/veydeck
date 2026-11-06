import { createI18n } from 'vue-i18n'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import NodeManagerView from '../NodeManagerView.vue'
import zh from '@/locales/zh'
import en from '@/locales/en'
import { nodesApi } from '@/api/modules/nodes'
import { VeyCheckbox } from '@/components/ui'
import { useNodeStore } from '@/stores/node'
import { upgradesApi } from '@/api/modules/upgrades'

const nodeStore = vi.hoisted(() => ({
  nodes: [
    {
      id: 'local',
      name: '本地节点',
      address: '127.0.0.1',
      status: 'online',
      tags: ['local'],
    },
  ] as Array<Record<string, unknown>>,
  currentNodeId: 'local',
  refreshNodes: vi.fn().mockResolvedValue(undefined),
  startAutoRefresh: vi.fn(),
  requestSwitchCurrentNode: vi.fn((_id: string) => ({ switched: true, reason: '' })),
}))
const windowManager = vi.hoisted(() => ({
  checkBeforeNodeSwitch: vi.fn(() => ({ allowed: true, blockers: [] })),
  registerGlobalOperation: vi.fn(),
  finishGlobalOperation: vi.fn(),
  updateWindowRuntimeState: vi.fn(),
}))
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))

vi.mock('@/stores/node', async () => {
  const { reactive } = await import('vue')
  const store = reactive(nodeStore)
  return { useNodeStore: () => store }
})
vi.mock('@/stores/window-manager', () => ({ useWindowManagerStore: () => windowManager }))
vi.mock('@/stores/toast', () => ({ useToastStore: () => toast }))
vi.mock('vue-router', () => ({ useRouter: () => ({ push: vi.fn() }) }))
vi.mock('@/api/modules/upgrades', () => ({
  upgradesApi: {
    listReleases: vi.fn(),
    createPlan: vi.fn(),
    startPlan: vi.fn(),
  },
}))
vi.mock('@/api/modules/nodes', () => ({
  nodesApi: {
    list: vi.fn(),
    detail: vi.fn(),
    about: vi.fn(),
    precheck: vi.fn(),
    deployCreate: vi.fn(),
    getDeployProgress: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    check: vi.fn(),
    repair: vi.fn(),
    retire: vi.fn(),
    uninstall: vi.fn(),
  },
}))

const response = <T>(data: T) => ({ success: true, code: 200, message: '', data })

const precheckResult = (passed: boolean) => {
  const detail = {
    status: passed ? 'passed' : 'failed',
    code: '',
    message: passed ? '正常' : '失败',
  }
  return {
    passed,
    agentStatus: { blocking: !passed, message: passed ? '正常' : '冲突' },
    versionCompatibility: { status: 'passed', message: '正常', requiredAction: '' },
    ssh: detail,
    os: detail,
    permission: detail,
    service: detail,
    systemd: detail,
    directory: detail,
    docker: detail,
    port: detail,
    callback: detail,
  }
}

const mountView = () => {
  const windowElement = document.createElement('section')
  windowElement.className = 'application-window'
  windowElement.innerHTML = `
    <header class="window-header">节点管理</header>
    <main class="window-content"></main>
  `
  document.body.append(windowElement)
  return mount(NodeManagerView, {
    attachTo: windowElement.querySelector<HTMLElement>('.window-content')!,
    props: { windowId: 'node-window' },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })],
    },
  })
}

async function openCreateAndSetAddress(wrapper: ReturnType<typeof mountView>) {
  await wrapper.get('[data-ui="node-create"]').trigger('click')
  const address = wrapper.get('[data-ui="node-create-address"] input')
  await address.setValue('192.0.2.10')
  return address
}

describe('NodeManagerView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    windowManager.checkBeforeNodeSwitch.mockReturnValue({ allowed: true, blockers: [] })
    nodeStore.nodes = [
      {
        id: 'local',
        name: '本地节点',
        address: '127.0.0.1',
        status: 'online',
        tags: ['local'],
      },
    ]
    nodeStore.currentNodeId = 'local'
    vi.mocked(nodesApi.precheck).mockResolvedValue(response(precheckResult(true)) as never)
    vi.mocked(nodesApi.deployCreate).mockResolvedValue(
      response({
        logs: [],
        node: {
          nodeId: 'node-1',
          name: 'node-1',
          address: '192.0.2.10',
          status: 'deploying',
          tags: [],
        },
      }) as never,
    )
    vi.mocked(nodesApi.getDeployProgress).mockResolvedValue(
      response({ progressPercent: 25, logs: ['installing'], isFinished: false }) as never,
    )
    vi.mocked(nodesApi.detail).mockResolvedValue(response(undefined) as never)
    vi.mocked(nodesApi.about).mockResolvedValue(response(undefined) as never)
    vi.mocked(nodesApi.check).mockResolvedValue(
      response({
        status: 'online',
        ssh: { status: 'passed', message: 'SSH 正常' },
        service: { status: 'passed', message: '服务正常' },
        api: { status: 'passed', message: 'API 正常' },
      }) as never,
    )
    vi.mocked(upgradesApi.listReleases).mockResolvedValue(response([]) as never)
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('在内容区打开创建表单，返回后恢复列表并清理草稿', async () => {
    const wrapper = mountView()
    await flushPromises()
    const address = await openCreateAndSetAddress(wrapper)

    expect(wrapper.find('[data-ui="node-grid"]').exists()).toBe(false)
    expect(wrapper.find('[data-ui="node-create-view"]').exists()).toBe(true)
    expect(document.body.querySelector('.vl-dialog-overlay')).toBeNull()

    await wrapper.get('[data-ui="node-provision-back"]').trigger('click')
    expect(wrapper.find('[data-ui="node-grid"]').exists()).toBe(true)

    await wrapper.get('[data-ui="node-create"]').trigger('click')
    expect(
      (wrapper.get('[data-ui="node-create-address"] input').element as HTMLInputElement).value,
    ).toBe('')
    expect((address.element as HTMLInputElement).isConnected).toBe(false)
    wrapper.unmount()
  })

  it('检查失败时保留输入并允许返回修改', async () => {
    vi.mocked(nodesApi.precheck).mockResolvedValue(response(precheckResult(false)) as never)
    const wrapper = mountView()
    await flushPromises()
    await openCreateAndSetAddress(wrapper)
    await wrapper.get('[data-ui="node-run-precheck"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-ui="node-precheck-view"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('未通过')
    await wrapper.get('[data-ui="node-precheck-edit"]').trigger('click')
    expect(
      (wrapper.get('[data-ui="node-create-address"] input').element as HTMLInputElement).value,
    ).toBe('192.0.2.10')
    wrapper.unmount()
  })

  it('部署可转入后台、重新查看，并在终态后手动返回列表', async () => {
    vi.useFakeTimers()
    const wrapper = mountView()
    await flushPromises()
    await openCreateAndSetAddress(wrapper)
    await wrapper.get('[data-ui="node-run-precheck"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-ui="node-start-deploy"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-ui="node-deploy-view"]').exists()).toBe(true)
    expect(windowManager.registerGlobalOperation).toHaveBeenCalledOnce()
    expect(windowManager.updateWindowRuntimeState).toHaveBeenLastCalledWith(
      'node-window',
      expect.objectContaining({ busy: true }),
    )

    await wrapper.get('[data-ui="node-deploy-background"]').trigger('click')
    expect(wrapper.find('[data-ui="node-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-ui="node-deploy-resume"]').exists()).toBe(true)
    await wrapper.get('[data-ui="node-deploy-resume"]').trigger('click')

    vi.mocked(nodesApi.getDeployProgress).mockResolvedValue(
      response({ progressPercent: 100, logs: ['done'], isFinished: true }) as never,
    )
    await vi.advanceTimersByTimeAsync(1500)
    await flushPromises()
    expect(windowManager.finishGlobalOperation).toHaveBeenCalledWith('node-deploy:node-1')
    expect(wrapper.find('[data-ui="node-deploy-finish"]').exists()).toBe(true)
    expect(wrapper.find('[data-ui="node-deploy-view"]').exists()).toBe(true)

    await wrapper.get('[data-ui="node-deploy-finish"]').trigger('click')
    expect(wrapper.find('[data-ui="node-grid"]').exists()).toBe(true)
    expect(wrapper.find('[data-ui="node-deploy-resume"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('将编辑、升级、检测详情和操作确认限制在当前窗口内容区', async () => {
    nodeStore.nodes = [
      ...nodeStore.nodes,
      {
        id: 'node-2',
        name: '远程节点',
        address: '192.0.2.20:22',
        status: 'online',
        tags: [],
      },
    ]
    const wrapper = mountView()
    await flushPromises()
    const windowContent = document.querySelector('.window-content')!
    const windowHeader = document.querySelector('.window-header')!
    const invokeAction = async (label: string) => {
      await wrapper.get('[data-node-id="node-2"]').trigger('contextmenu', { clientX: 100, clientY: 100 })
      await flushPromises()
      const button = Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ui="node-context-menu"] button'))
        .find((item) => item.textContent === label)!
      button.click()
      await flushPromises()
    }
    await invokeAction('编辑')
    await flushPromises()
    const editDialog = document.querySelector('[data-ui="node-edit-dialog"]')!
    expect(windowContent.contains(editDialog)).toBe(true)
    expect(windowHeader.contains(editDialog)).toBe(false)
    const editCancel = Array.from(editDialog.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '取消',
    )
    editCancel?.click()
    await flushPromises()

    await invokeAction('检测')
    await flushPromises()
    const checkDialog = document.querySelector('[data-ui="node-check-dialog"]')!
    expect(windowContent.contains(checkDialog)).toBe(true)
    expect(document.body.querySelector(':scope > .application-dialog-overlay')).toBeNull()
    checkDialog.querySelector<HTMLButtonElement>('[aria-label]')?.click()
    await flushPromises()

    await wrapper.get('[data-ui="node-select-mode"]').trigger('click')
    const checkboxes = wrapper.findAllComponents(VeyCheckbox)
    checkboxes.at(-1)?.vm.$emit('change', true)
    await flushPromises()
    await wrapper.get('[data-ui="node-upgrade-selected"]').trigger('click')
    await flushPromises()
    expect(windowContent.querySelector('[data-ui="node-upgrade-dialog"]')).not.toBeNull()
    document.querySelector<HTMLElement>('[data-ui="node-upgrade-dialog"] [aria-label]')?.click()
    await flushPromises()

    await invokeAction('退役')
    await flushPromises()
    const confirmation = document.querySelector('[data-ui="node-confirmation-dialog"]')!
    expect(windowContent.contains(confirmation)).toBe(true)
    const cancel = Array.from(confirmation.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '取消',
    )
    cancel?.click()
    await flushPromises()
    wrapper.unmount()
  })
  /** 建立多个不同状态的节点用于卡片交互测试。 */
  const addNodes = () => {
    nodeStore.nodes.push(
      { id: 'node-a', name: '节点 A', address: '192.0.2.1', status: 'online', tags: ['production'] },
      { id: 'node-b', name: '节点 B', address: '192.0.2.2', status: 'offline', tags: [] },
    )
  }

  /** 从实际渲染的右键菜单执行操作。 */
  const menuAction = async (wrapper: ReturnType<typeof mountView>, id: string, label: string) => {
    await wrapper.get(`[data-node-id="${id}"]`).trigger('contextmenu', { clientX: 50, clientY: 50 })
    await flushPromises()
    return Array.from(document.querySelectorAll<HTMLButtonElement>('[data-ui="node-context-menu"] button'))
      .find((button) => button.textContent === label)!
  }

  it('点击查看独立详情，本地节点不请求远端信息且当前标记保持不变', async () => {
    addNodes()
    const wrapper = mountView()
    await flushPromises()
    expect(nodesApi.detail).not.toHaveBeenCalled()
    await wrapper.get('[data-node-id="node-a"]').trigger('click')
    await flushPromises()
    expect(nodesApi.detail).toHaveBeenCalledWith('node-a')
    expect(nodeStore.requestSwitchCurrentNode).not.toHaveBeenCalled()
    expect(wrapper.get('[data-node-id="local"]').attributes('data-current')).toBe('true')
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).toContain('节点 A')
    await wrapper.get('[data-node-id="local"]').trigger('click')
    await flushPromises()
    expect(nodesApi.detail).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).toContain('127.0.0.1')
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).not.toContain('SSH 目标')
    wrapper.unmount()
  })

  it('右键不会查看详情或勾选，本地节点菜单不开放维护操作', async () => {
    addNodes()
    const wrapper = mountView()
    await flushPromises()
    const current = await menuAction(wrapper, 'local', '当前节点')
    expect(current.disabled).toBe(true)
    expect(document.querySelectorAll('[data-ui="node-context-menu"] button')).toHaveLength(1)
    expect(nodesApi.detail).not.toHaveBeenCalled()
    expect(document.querySelector('[data-ui="node-detail-dialog"]')).toBeNull()
    const offline = await menuAction(wrapper, 'node-b', '切换到此节点')
    expect(offline.disabled).toBe(true)
    await wrapper.get('[data-ui="node-select-mode"]').trigger('click')
    await menuAction(wrapper, 'node-a', '切换到此节点')
    expect(wrapper.get('[data-ui="node-upgrade-selected"]').text()).toContain('(0)')
    wrapper.unmount()
  })

  it('节点切换保留全局保护，允许切换后标记跟随当前节点', async () => {
    addNodes()
    const wrapper = mountView()
    await flushPromises()
    windowManager.checkBeforeNodeSwitch.mockReturnValue({ allowed: false, blockers: [{ title: '终端', reason: '会话活动中' }] } as never)
    ;(await menuAction(wrapper, 'node-a', '切换到此节点')).click()
    await flushPromises()
    expect(nodeStore.requestSwitchCurrentNode).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalled()
    windowManager.checkBeforeNodeSwitch.mockReturnValue({ allowed: true, blockers: [] })
    nodeStore.requestSwitchCurrentNode.mockImplementationOnce((id) => {
      useNodeStore().currentNodeId = id
      return { switched: true, reason: '' }
    })
    ;(await menuAction(wrapper, 'node-a', '切换到此节点')).click()
    await flushPromises()
    expect(nodeStore.requestSwitchCurrentNode).toHaveBeenCalledWith('node-a')
    expect(wrapper.get('[data-node-id="node-a"]').attributes('data-current')).toBe('true')
    expect(wrapper.get('[data-node-id="local"]').attributes('data-current')).toBe('false')
    wrapper.unmount()
  })

  it('仅在选择模式勾选在线外部节点，状态变化和退出会清理选择', async () => {
    addNodes()
    const wrapper = mountView()
    await flushPromises()
    expect(wrapper.findAllComponents(VeyCheckbox)).toHaveLength(0)
    await wrapper.get('[data-ui="node-select-mode"]').trigger('click')
    await wrapper.get('[data-node-id="local"]').trigger('click')
    await wrapper.get('[data-node-id="node-b"]').trigger('click')
    expect(wrapper.get('[data-ui="node-upgrade-selected"]').text()).toContain('(0)')
    await wrapper.get('[data-node-id="node-a"]').trigger('click')
    expect(wrapper.get('[data-ui="node-upgrade-selected"]').text()).toContain('(1)')
    expect(nodesApi.detail).not.toHaveBeenCalled()
    useNodeStore().nodes = useNodeStore().nodes.map((node) => node.id === 'node-a' ? { ...node, status: 'offline' } : node)
    await flushPromises()
    expect(wrapper.get('[data-ui="node-upgrade-selected"]').text()).toContain('(0)')
    await wrapper.get('[data-ui="node-exit-selection"]').trigger('click')
    expect(wrapper.findAllComponents(VeyCheckbox)).toHaveLength(0)
    wrapper.unmount()
  })

  it('旧详情响应不会覆盖新选择，关闭期间返回的请求也不会重新显示', async () => {
    addNodes()
    let resolveFirst!: (value: never) => void
    vi.mocked(nodesApi.detail).mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve }))
    vi.mocked(nodesApi.detail).mockResolvedValueOnce(response({ node: { metadata: { resource: { version: 'B-current' } } }, provisioning: null, session: null }) as never)
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-node-id="node-a"]').trigger('click')
    await wrapper.get('[data-node-id="node-b"]').trigger('click')
    await flushPromises()
    resolveFirst(response({ node: { metadata: { resource: { version: 'A-stale' } } } }) as never)
    await flushPromises()
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).toContain('B-current')
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).not.toContain('A-stale')
    document.querySelector<HTMLButtonElement>('[data-ui="node-detail-dialog"] [aria-label]')?.click()
    await flushPromises()
    const calls = vi.mocked(nodesApi.detail).mock.calls.length
    useNodeStore().nodes = [...useNodeStore().nodes]
    await flushPromises()
    expect(nodesApi.detail).toHaveBeenCalledTimes(calls)
    expect(document.querySelector('[data-ui="node-detail-dialog"]')).toBeNull()
    wrapper.unmount()
  })

  it('键盘菜单支持 Escape 恢复焦点，点击外部及删除目标会关闭菜单', async () => {
    addNodes()
    const wrapper = mountView()
    await flushPromises()
    const card = wrapper.get('[data-node-id="node-a"]')
    await card.trigger('keydown', { key: 'F10', shiftKey: true })
    await flushPromises()
    const menu = document.querySelector<HTMLElement>('[data-ui="node-context-menu"]')!
    expect(menu.contains(document.activeElement)).toBe(true)
    document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-ui="node-context-menu"]')).toBeNull()
    expect(document.activeElement).toBe(card.element)
    await card.trigger('keydown', { key: 'ContextMenu' })
    await flushPromises()
    document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))
    await flushPromises()
    expect(document.querySelector('[data-ui="node-context-menu"]')).toBeNull()
    await menuAction(wrapper, 'node-a', '切换到此节点')
    useNodeStore().nodes = useNodeStore().nodes.filter((node) => node.id !== 'node-a')
    await flushPromises()
    expect(document.querySelector('[data-ui="node-context-menu"]')).toBeNull()
    wrapper.unmount()
  })

  it('详情关闭后使在途响应失效，同一节点重开不会显示上次请求内容', async () => {
    addNodes()
    let resolveOld!: (value: never) => void
    vi.mocked(nodesApi.detail).mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve }))
    vi.mocked(nodesApi.detail).mockResolvedValueOnce(response({ node: { metadata: { resource: { version: 'fresh' } } } }) as never)
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-node-id="node-a"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-ui="node-detail-dialog"] [aria-label]')?.click()
    await flushPromises()
    await wrapper.get('[data-node-id="node-a"]').trigger('keydown', { key: 'Enter' })
    await flushPromises()
    resolveOld(response({ node: { metadata: { resource: { version: 'stale' } } } }) as never)
    await flushPromises()
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).toContain('fresh')
    expect(document.querySelector('[data-ui="node-detail-dialog"]')?.textContent).not.toContain('stale')
    expect(nodeStore.requestSwitchCurrentNode).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('详情默认展示概览，部署及连接诊断收起，默认分组不占位置', async () => {
    addNodes()
    vi.mocked(nodesApi.detail).mockResolvedValue(response({
      node: { groupName: 'default', lifecycleStatus: 'online', runtimeStatus: 'active', metadata: { resource: { version: '0.1.2' } } },
      provisioning: { deployMethod: 'ssh_push', sshAddr: '2001:db8::1', sshPort: 22, installDir: '/opt/veydeck', lastDeployResultStatus: 'prepared' },
      session: { sessionId: 'full-session-identifier', registeredAt: '2026-11-06T00:00:00Z' },
    }) as never)
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-node-id="node-a"]').trigger('click')
    await flushPromises()
    const overview = document.querySelector('[data-ui="node-detail-overview"]')!
    expect(overview.textContent).toContain('192.0.2.1')
    expect(overview.textContent).toContain('0.1.2')
    expect(overview.textContent).not.toContain('default')
    expect(overview.textContent).not.toContain('最近可见')
    const deployment = document.querySelector<HTMLDetailsElement>('[data-ui="node-deployment-details"]')!
    const diagnostics = document.querySelector<HTMLDetailsElement>('[data-ui="node-connection-diagnostics"]')!
    expect(deployment.open).toBe(false)
    expect(diagnostics.open).toBe(false)
    expect(deployment.textContent).toContain('SSH 部署')
    expect(deployment.textContent).toContain('[2001:db8::1]:22')
    expect(deployment.textContent).not.toContain('prepared')
    expect(diagnostics.textContent).toContain('已连接')
    expect(diagnostics.textContent).toContain('未知')
    expect(diagnostics.textContent).toContain('full-session-identifier')
    expect(diagnostics.querySelector('.vl-tag')).toBeNull()
    deployment.open = true
    diagnostics.open = true
    await wrapper.get('[data-node-id="node-b"]').trigger('click')
    await flushPromises()
    expect(document.querySelector<HTMLDetailsElement>('[data-ui="node-connection-diagnostics"]')?.open).toBe(false)
    wrapper.unmount()
  })

  it('部署失败自动展开错误，离线节点只展示最近在线时间而不显示旧指标', async () => {
    addNodes()
    vi.mocked(nodesApi.detail).mockResolvedValue(response({
      node: { lifecycleStatus: 'offline', lastSeenAt: '2026-11-06T00:00:00Z', groupName: 'default' },
      provisioning: { deployMethod: 'ssh_push', lastDeployResultStatus: 'failed', lastDeployErrorSummary: 'SSH 认证失败', installDir: '/opt/veydeck' },
    }) as never)
    const wrapper = mountView()
    await flushPromises()
    await wrapper.get('[data-node-id="node-b"]').trigger('click')
    await flushPromises()
    expect(document.querySelector<HTMLDetailsElement>('[data-ui="node-deployment-details"]')?.open).toBe(true)
    expect(document.querySelector('[data-ui="node-deployment-error"]')?.textContent).toContain('SSH 认证失败')
    const overview = document.querySelector('[data-ui="node-detail-overview"]')!
    expect(overview.textContent).toContain('最近可见')
    expect(overview.textContent).not.toContain('CPU')
    wrapper.unmount()
  })

})
