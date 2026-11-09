import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import UpgradeProgressView from '../UpgradeProgressView.vue'
import type { UpgradePlanDetail, UpgradeTargetRecord } from '@/api/modules/upgrades'
import zh from '@/locales/zh'
import en from '@/locales/en'

const api = vi.hoisted(() => ({ detail: vi.fn(), latestPlan: vi.fn(), cancelPlan: vi.fn() }))
vi.mock('@/api/modules/upgrades', () => ({ upgradesApi: api }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ query: { planId: 'upgrade-plan' } }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('@/router', () => ({ resetAuthState: vi.fn() }))
vi.mock('@/api', () => ({ default: { post: vi.fn() } }))
vi.mock('@/stores/toast', () => ({
  useToastStore: () => ({ success: vi.fn(), error: vi.fn() }),
}))
vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => ({ openWindows: [], closeWindow: vi.fn() }),
}))

/** 构造保留各组件独立版本与状态的升级目标。 */
const target = (
  targetId: string,
  nodeId: string | undefined,
  status = 'pending',
): UpgradeTargetRecord => ({
  targetId,
  planId: 'upgrade-plan',
  targetType: nodeId ? 'agent' : 'controller',
  nodeId,
  status,
  currentVersion: nodeId === 'local' ? '0.1.0-alpha.2' : '0.1.0-alpha.3',
  targetVersion: '0.1.0-alpha.3',
  retryCount: 0,
  createdAt: '2026-11-09T07:00:00Z',
  updatedAt: '2026-11-09T07:00:00Z',
})

/** 刻意打乱组件顺序，验证展示按主机归组而非依赖返回顺序。 */
const plan = (): UpgradePlanDetail => ({
  plan: {
    planId: 'upgrade-plan',
    targetVersion: '0.1.0-alpha.3',
    component: 'cluster',
    scope: '{}',
    strategy: '{}',
    status: 'running',
    requestedBy: 'admin',
    createdAt: '2026-11-09T07:00:00Z',
    updatedAt: '2026-11-09T07:00:00Z',
  },
  targets: [
    target('remote-agent', 'node-1'),
    target('local-agent', 'local'),
    target('controller-service', undefined),
  ],
  events: [],
  nodeNames: { local: 'Local Node', 'node-1': '110.133' },
})

/** 挂载真实页面组件，使用接口快照驱动展示。 */
const mountView = async (detail: UpgradePlanDetail) => {
  api.detail.mockResolvedValue({ success: true, data: detail })
  const wrapper = mount(UpgradeProgressView, {
    global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh, en } })] },
  })
  await flushPromises()
  return wrapper
}

describe('UpgradeProgressView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sessionStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    sessionStorage.clear()
  })

  it('主控服务与本地 Agent 合并为置顶单元，并区分主机与组件数量', async () => {
    const wrapper = await mountView(plan())
    const hosts = wrapper.findAll('[data-ui="upgrade-target-card"]')
    expect(hosts).toHaveLength(2)
    expect(hosts[0]!.attributes('data-host-id')).toBe('controller')
    expect(
      hosts[0]!
        .findAll('[data-ui="upgrade-component-row"]')
        .map((row) => row.attributes('data-target-id')),
    ).toEqual(['controller-service', 'local-agent'])
    expect(hosts[0]!.text()).toContain('主控服务')
    expect(hosts[0]!.text()).toContain('本地节点 Agent')
    expect(hosts[0]!.get('[data-target-id="local-agent"]').text()).toContain('0.1.0-alpha.2')
    expect(hosts[1]!.text()).toContain('110.133')
    expect(wrapper.text()).toContain('2 台主机 · 3 个组件')
    expect(wrapper.find('[data-host-id="local"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('主控服务成功后仍等待本地 Agent，轮询确认全部组件成功才显示整组成功', async () => {
    vi.useFakeTimers()
    const detail = plan()
    detail.targets[2]!.status = 'succeeded'
    detail.targets[1]!.status = 'running'
    detail.targets[1]!.subStatus = 'restarting'
    const wrapper = await mountView(detail)
    const status = () =>
      wrapper.get('[data-host-id="controller"] [data-ui="upgrade-host-status"]').text()
    expect(status()).toBe('运行中')
    expect(wrapper.get('[data-target-id="local-agent"]').text()).toContain('重启中')
    const next = plan()
    next.targets[2]!.status = 'succeeded'
    next.targets[1]!.status = 'succeeded'
    api.detail.mockResolvedValue({ success: true, data: next })
    await vi.advanceTimersByTimeAsync(3000)
    await flushPromises()
    expect(status()).toBe('已成功')
    const local = wrapper.get('[data-target-id="local-agent"]')
    expect(local.text()).not.toContain('0.1.0-alpha.2')
    expect(local.text()).toContain('0.1.0-alpha.3')
    wrapper.unmount()
  })

  it('本地 Agent 失败时主控单元显示失败，错误保留在对应组件行', async () => {
    const detail = plan()
    detail.targets[2]!.status = 'succeeded'
    detail.targets[1]!.status = 'failed'
    detail.targets[1]!.errorDetail = 'agent restart failed'
    const wrapper = await mountView(detail)
    const host = wrapper.get('[data-host-id="controller"]')
    expect(host.get('[data-ui="upgrade-host-status"]').text()).toBe('失败')
    expect(
      host.get('[data-target-id="local-agent"] [data-ui="upgrade-component-error"]').text(),
    ).toBe('agent restart failed')
    expect(host.get('[data-target-id="controller-service"]').text()).not.toContain(
      'agent restart failed',
    )
    wrapper.unmount()
  })

  it('部分组件成功、其余取消时不会显示整组成功', async () => {
    const detail = plan()
    detail.targets[2]!.status = 'succeeded'
    detail.targets[1]!.status = 'canceled'
    const wrapper = await mountView(detail)
    expect(wrapper.get('[data-host-id="controller"] [data-ui="upgrade-host-status"]').text()).toBe(
      '已取消',
    )
    wrapper.unmount()
  })

  it('仅同步其他节点时不生成主控单元', async () => {
    const detail = plan()
    detail.plan.component = 'agent'
    detail.targets = [detail.targets[0]!]
    const wrapper = await mountView(detail)
    expect(wrapper.find('[data-host-id="controller"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-ui="upgrade-target-card"]')).toHaveLength(1)
    expect(wrapper.text()).toContain('1 台主机 · 1 个组件')
    wrapper.unmount()
  })
})
