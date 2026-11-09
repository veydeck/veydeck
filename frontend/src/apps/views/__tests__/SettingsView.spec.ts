import { createPinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, onMounted } from 'vue'
import { flushPromises, shallowMount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import SettingsView from '../SettingsView.vue'
import AboutSettings from '../settings/AboutSettings.vue'
import zh from '@/locales/zh'

const api = vi.hoisted(() => ({
  fetchAbout: vi.fn(),
  fetchInterfaces: vi.fn(),
  fetchNetwork: vi.fn(),
  fetchSecurity: vi.fn(),
  listReleases: vi.fn(),
  checkSuiteCompatibility: vi.fn(),
  createPlan: vi.fn(),
  startPlan: vi.fn(),
  deleteRelease: vi.fn(),
}))

const confirmation = vi.hoisted(() => ({ showConfirmation: vi.fn() }))

const windowManager = vi.hoisted(() => ({
  updateWindowRuntimeState: vi.fn(),
  openWindowWithPayload: vi.fn(),
}))

vi.mock('@/api/modules/system', () => ({
  systemApi: {
    forNode: () => ({ fetchAbout: api.fetchAbout }),
  },
}))

vi.mock('@/api/modules/veydeck', () => ({
  veydeckApi: {
    fetchInterfaces: api.fetchInterfaces,
    fetchNetwork: api.fetchNetwork,
    updateNetwork: vi.fn(),
  },
}))

vi.mock('@/api/modules/security', () => ({
  securityApi: {
    fetchSettings: api.fetchSecurity,
    updateSettings: vi.fn(),
    updateUsername: vi.fn(),
    updatePassword: vi.fn(),
  },
}))

vi.mock('@/api/modules/upgrades', () => ({
  upgradesApi: {
    listReleases: api.listReleases,
    uploadRelease: vi.fn(),
    createPlan: api.createPlan,
    startPlan: api.startPlan,
    detail: vi.fn(),
    deleteRelease: api.deleteRelease,
    checkSuiteCompatibility: api.checkSuiteCompatibility,
  },
}))

vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => windowManager,
}))

vi.mock('@/stores/confirmation-modal', () => ({
  useConfirmationModalStore: () => confirmation,
}))

const MenuStub = defineComponent({
  name: 'VeyMenu',
  props: {
    modelValue: { type: String, required: true },
    items: { type: Array, required: true },
  },
  emits: ['update:modelValue'],
  template: `
    <div>
      <button
        v-for="item in items.flatMap((group) => group.children)"
        :key="item.key"
        :data-menu-key="item.key"
        @click="$emit('update:modelValue', item.key)"
      >
        {{ item.label }}
      </button>
    </div>
  `,
})

const CardStub = defineComponent({
  name: 'VeyCard',
  template: '<div><slot name="header" /><slot /></div>',
})

const success = <T>(data: T) => ({ success: true, code: 200, message: '', data })

const ButtonStub = defineComponent({
  props: { disabled: Boolean, loading: Boolean },
  emits: ['click'],
  template: `<button :disabled="disabled || loading" @click="$emit('click')"><slot /></button>`,
})

/** 构造完整版本信息，确保条目布局不丢失原表格字段。 */
const release = (version = '1.0.0') => ({
  releaseId: `release-${version}`,
  version,
  channel: 'prerelease',
  checksumStatus: 'verified',
  signatureStatus: 'verified',
  publishedAt: '2026-11-09T07:00:00Z',
  upgradeEligible: true,
})

const mountSettings = async (sectionStubs: Record<string, unknown> = {}) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: { template: '<div />' } },
      { path: '/upgrade-progress', component: { template: '<div />' } },
    ],
  })
  await router.push('/')
  await router.isReady()

  return shallowMount(SettingsView, {
    props: { windowId: 'settings-test' },
    global: {
      plugins: [
        createPinia(),
        router,
        createI18n({ legacy: false, locale: 'zh', messages: { zh } }),
      ],
      stubs: {
        KeepAlive: false,
        VeyCard: CardStub,
        VeyMenu: MenuStub,
        VeyButton: ButtonStub,
        VeyTag: { template: '<span><slot /></span>' },
        VeyAlert: { props: ['title'], template: '<div>{{ title }}</div>' },
        SystemMonitoringSettings: true,
        ...sectionStubs,
      },
    },
  })
}

describe('SettingsView', () => {
  beforeEach(() => {
    confirmation.showConfirmation.mockResolvedValue(true)
    api.fetchAbout.mockResolvedValue(success(null))
    api.fetchInterfaces.mockResolvedValue(success([]))
    api.fetchNetwork.mockResolvedValue(
      success({ host: '::', port: 8443, publicHost: 'veydeck.example.test' }),
    )
    api.fetchSecurity.mockResolvedValue(
      success({ safeEntry: '', safeEntryEnabled: false, passwordComplexity: false }),
    )
    api.listReleases.mockResolvedValue(success([]))
    api.checkSuiteCompatibility.mockResolvedValue(
      success({
        releaseVersion: '1.0.0',
        supportedSuiteContractVersions: [1],
        compatible: true,
        summary: { total: 0, compatible: 0, incompatible: 0 },
        instances: [],
      }),
    )
  })

  it('初次打开由分区组件自行加载数据', async () => {
    const wrapper = await mountSettings()
    await flushPromises()

    expect(wrapper.attributes('data-page')).toBe('settings')
    expect(api.fetchAbout).not.toHaveBeenCalled()
    expect(api.fetchInterfaces).not.toHaveBeenCalled()
    expect(api.fetchNetwork).not.toHaveBeenCalled()
    expect(api.fetchSecurity).not.toHaveBeenCalled()
    expect(api.listReleases).not.toHaveBeenCalled()
  })

  it('关于分区挂载后加载当前节点信息', async () => {
    shallowMount(AboutSettings, {
      global: {
        plugins: [createPinia(), createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
      },
    })
    await flushPromises()

    expect(api.fetchAbout).toHaveBeenCalledTimes(1)
  })

  it('切换菜单时渲染对应分区组件', async () => {
    const wrapper = await mountSettings()
    await flushPromises()

    await wrapper.get('[data-menu-key="network"]').trigger('click')
    await flushPromises()
    expect(wrapper.findComponent({ name: 'NetworkSettings' }).exists()).toBe(true)
  })

  it('网络设置未保存时不阻止关闭设置窗口', async () => {
    const NetworkStub = defineComponent({
      name: 'NetworkSettings',
      emits: ['busyChange', 'dirtyChange'],
      setup(_, { emit }) {
        onMounted(() => {
          emit('busyChange', false)
          emit('dirtyChange', true)
        })
      },
      template: '<div data-page="settings-network-stub" />',
    })
    const wrapper = await mountSettings({ NetworkSettings: NetworkStub })

    await wrapper.get('[data-menu-key="network"]').trigger('click')
    await flushPromises()

    expect(windowManager.updateWindowRuntimeState).toHaveBeenLastCalledWith(
      'settings-test',
      expect.objectContaining({ busy: false, dirty: false, blockLevel: 'open' }),
    )
  })

  it('快速切换模块后已停用分区的加载状态仍会正常收敛', async () => {
    let resolveAbout!: () => void
    const aboutFinished = new Promise<void>((resolve) => {
      resolveAbout = resolve
    })
    const aboutMounted = vi.fn()
    const AsyncAboutStub = defineComponent({
      name: 'AboutSettings',
      emits: ['busyChange'],
      setup(_, { emit }) {
        onMounted(async () => {
          aboutMounted()
          emit('busyChange', true)
          await aboutFinished
          emit('busyChange', false)
        })
      },
      template: '<div data-page="settings-about-stub" />',
    })
    const NetworkStub = defineComponent({
      name: 'NetworkSettings',
      emits: ['busyChange', 'dirtyChange'],
      setup(_, { emit }) {
        onMounted(() => {
          emit('busyChange', false)
          emit('dirtyChange', false)
        })
      },
      template: '<div data-page="settings-network-stub" />',
    })
    const wrapper = await mountSettings({
      AboutSettings: AsyncAboutStub,
      NetworkSettings: NetworkStub,
    })
    await flushPromises()
    expect(windowManager.updateWindowRuntimeState).toHaveBeenLastCalledWith(
      'settings-test',
      expect.objectContaining({ busy: true }),
    )

    await wrapper.get('[data-menu-key="network"]').trigger('click')
    resolveAbout()
    await flushPromises()
    expect(windowManager.updateWindowRuntimeState).toHaveBeenLastCalledWith(
      'settings-test',
      expect.objectContaining({ busy: false }),
    )

    await wrapper.get('[data-menu-key="about"]').trigger('click')
    await flushPromises()
    expect(aboutMounted).toHaveBeenCalledTimes(1)
  })

  it('没有运行中升级计划时不创建后台轮询', async () => {
    const setIntervalSpy = vi.spyOn(window, 'setInterval')
    const wrapper = await mountSettings()

    await wrapper.get('[data-menu-key="upgrade"]').trigger('click')
    await flushPromises()

    expect(api.listReleases).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).not.toHaveBeenCalled()
  })
  it('纵向版本条目保留全部信息与直接可用的操作', async () => {
    api.listReleases.mockResolvedValue(success([release()]))
    const wrapper = await mountSettings()
    await wrapper.get('[data-menu-key="upgrade"]').trigger('click')
    await flushPromises()
    const item = wrapper.get('[data-ui="upgrade-release-item"]')
    expect(item.text()).toContain('1.0.0')
    expect(item.text()).toContain('预发布')
    expect(item.text()).toContain('校验')
    expect(item.text()).toContain('签名')
    expect(item.text()).toContain('已通过')
    expect(item.text()).toContain('2026-11-09')
    expect(item.get('[data-ui="upgrade-release-start"]').text()).toBe('立即升级')
    expect(item.get('[data-ui="suite-compatibility-check"]').text()).toBe('检测套件')
    expect(item.get('[data-ui="upgrade-release-delete"]').text()).toBe('删除')
    wrapper.unmount()
  })

  it('套件检测结果展示在对应版本条目内', async () => {
    api.listReleases.mockResolvedValue(success([release('1.0.0'), release('0.9.0')]))
    const wrapper = await mountSettings()
    await wrapper.get('[data-menu-key="upgrade"]').trigger('click')
    await flushPromises()
    await wrapper
      .get('[data-version="1.0.0"] [data-ui="suite-compatibility-check"]')
      .trigger('click')
    await flushPromises()
    expect(api.checkSuiteCompatibility).toHaveBeenCalledWith('1.0.0')
    expect(
      wrapper.get('[data-version="1.0.0"]').find('[data-ui="suite-compatibility-report"]').exists(),
    ).toBe(true)
    expect(
      wrapper.get('[data-version="0.9.0"]').find('[data-ui="suite-compatibility-report"]').exists(),
    ).toBe(false)
    wrapper.unmount()
  })

  it('完整显示选择的长文件名', async () => {
    const wrapper = await mountSettings()
    await wrapper.get('[data-menu-key="upgrade"]').trigger('click')
    await flushPromises()
    const filename =
      'veydeck-0.1.0-alpha.3-linux-aarch64-custom-build-with-long-release-name.tar.gz'
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['package'], filename)] })
    await input.trigger('change')
    expect(wrapper.get('[data-ui="upgrade-file-name"]').text()).toBe(filename)
    expect(wrapper.get('[data-ui="upgrade-upload-submit"]').attributes('disabled')).toBeUndefined()
    wrapper.unmount()
  })

  it('执行详情归组主控组件并保留完整错误与计划编号', async () => {
    api.listReleases.mockResolvedValue(success([release()]))
    const detail = {
      plan: {
        planId: 'plan-with-long-identifier-0123456789abcdef',
        targetVersion: '1.0.0',
        status: 'failed',
      },
      targets: [
        {
          targetId: 'controller',
          targetType: 'controller',
          status: 'succeeded',
          currentVersion: '0.9.0',
          targetVersion: '1.0.0',
        },
        {
          targetId: 'local-agent',
          targetType: 'agent',
          nodeId: 'local',
          status: 'failed',
          currentVersion: '0.9.0',
          targetVersion: '1.0.0',
          errorDetail: '本地 Agent 重启超时，错误详情应完整显示',
        },
        {
          targetId: 'node-agent',
          targetType: 'agent',
          nodeId: 'node-1',
          status: 'pending',
          currentVersion: '0.9.0',
          targetVersion: '1.0.0',
        },
      ],
      events: [],
      nodeNames: { 'node-1': '测试节点' },
    }
    api.createPlan.mockResolvedValue(success(detail))
    api.startPlan.mockResolvedValue(success(detail))
    const wrapper = await mountSettings()
    await wrapper.get('[data-menu-key="upgrade"]').trigger('click')
    await flushPromises()
    await wrapper.get('[data-ui="upgrade-release-start"]').trigger('click')
    await flushPromises()
    expect(api.createPlan).toHaveBeenCalledWith({
      component: 'cluster',
      targetVersion: '1.0.0',
      includeOffline: true,
    })
    const host = wrapper.get('[data-host-id="local"]')
    expect(host.findAll('[data-ui="settings-upgrade-component"]')).toHaveLength(2)
    expect(host.text()).toContain('主控服务')
    expect(host.text()).toContain('本地节点 Agent')
    expect(host.get('[data-ui="settings-upgrade-error"]').text()).toBe(
      detail.targets[1]!.errorDetail,
    )
    expect(wrapper.text()).toContain(detail.plan.planId)
    expect(wrapper.get('[data-host-id="node-1"]').text()).toContain('测试节点')
    wrapper.unmount()
  })
})
