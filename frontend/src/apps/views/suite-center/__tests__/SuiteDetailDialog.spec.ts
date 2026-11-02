import { defineComponent } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { describe, expect, it } from 'vitest'
import { VeySelect } from '@/components/ui'
import type { SuiteCatalogItem, SuiteInstanceSummary } from '@/api/interface/suites'
import zh from '@/locales/zh'
import SuiteDetailDialog from '../SuiteDetailDialog.vue'

/** 用直接插槽容器隔离浮层实现，只验证套件版本选择的领域行为。 */
const Dialog = defineComponent({
  props: ['visible', 'title'],
  template: '<div v-if="visible"><slot /><slot name="footer" /></div>',
})

/** 构造中心库保存两个版本的同一套件。 */
function suite(): SuiteCatalogItem {
  return {
    suiteId: 'example',
    version: '2.0.0',
    name: '新版名称',
    summary: '',
    icon: 'package',
    status: 'available',
    checksum: 'v2',
    createdAt: '',
    updatedAt: '',
    instanceCount: 1,
    versions: ['2.0.0', '1.0.0'].map((version) => ({
      packageId: `package-${version}`,
      version,
      name: `套件 ${version}`,
      summary: '',
      icon: 'package',
      checksum: version,
      createdAt: '',
      instanceCount: version === '1.0.0' ? 1 : 0,
    })),
  }
}

/** 挂载详情，并使用真实选择组件验证提交参数。 */
function mountDetail(instance?: SuiteInstanceSummary) {
  return mount(SuiteDetailDialog, {
    props: {
      suite: suite(),
      instance,
      nodeName: '本地节点',
      busy: false,
      nodeUnavailable: false,
      statusLabel: '可用',
      statusType: 'default',
    },
    global: {
      plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
      stubs: { ApplicationDialog: Dialog, AppIcon: true },
    },
  })
}

describe('SuiteDetailDialog', () => {
  it('详情挂载在所属应用内容区，背景使用不透明主题表面', async () => {
    const host = document.createElement('div')
    host.className = 'window-content'
    const other = document.createElement('div')
    other.className = 'window-content'
    document.body.append(host, other)
    const wrapper = mount(SuiteDetailDialog, {
      attachTo: host,
      props: {
        suite: suite(),
        nodeName: '本地节点',
        busy: false,
        nodeUnavailable: false,
        statusLabel: '可用',
        statusType: 'default',
      },
      global: {
        plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })],
        stubs: { AppIcon: true },
      },
    })
    await flushPromises()
    const dialog = host.querySelector<HTMLElement>('[data-ui="suite-detail-dialog"]')
    expect(dialog).not.toBeNull()
    expect(dialog?.style.background).toBe('var(--vdl-bg-panel)')
    expect(other.querySelector('[data-ui="application-dialog-overlay"]')).toBeNull()
    expect(
      document.body.querySelector(':scope > [data-ui="application-dialog-overlay"]'),
    ).toBeNull()
    wrapper.unmount()
    host.remove()
    other.remove()
  })

  it('不默认选择版本，明确选择旧版后提交该包身份', async () => {
    const wrapper = mountDetail()
    const button = wrapper.get('[data-ui="suite-install-action"]')
    expect(button.attributes('disabled')).toBeDefined()
    wrapper.getComponent(VeySelect).vm.$emit('update:modelValue', 'package-1.0.0')
    await wrapper.vm.$nextTick()
    await button.trigger('click')
    expect(wrapper.emitted('install')).toEqual([['package-1.0.0', false]])
    wrapper.unmount()
  })

  it('目标节点切换或所选包消失时清空版本选择', async () => {
    const wrapper = mountDetail()
    wrapper.getComponent(VeySelect).vm.$emit('update:modelValue', 'package-1.0.0')
    await wrapper.setProps({ nodeName: '节点 A' })
    expect(wrapper.getComponent(VeySelect).props('modelValue')).toBeNull()
    wrapper.getComponent(VeySelect).vm.$emit('update:modelValue', 'package-1.0.0')
    const next = suite()
    next.versions = next.versions.filter((item) => item.version !== '1.0.0')
    await wrapper.setProps({ suite: next })
    expect(wrapper.getComponent(VeySelect).props('modelValue')).toBeNull()
    wrapper.unmount()
  })

  it('已有实例使用绑定版本的展示信息并保持独立卸载目标', async () => {
    const instance: SuiteInstanceSummary = {
      packageId: 'package-1.0.0',
      instanceId: 'instance-local',
      suiteId: 'example',
      version: '1.0.0',
      nodeId: 'local',
      composeProjectName: 'example',
      status: 'installed',
      createdAt: '',
      updatedAt: '',
    }
    const wrapper = mountDetail(instance)
    expect(wrapper.text()).toContain('套件 1.0.0')
    expect(wrapper.find('[data-ui="suite-install-action"]').exists()).toBe(false)
    await wrapper.get('[data-ui="suite-uninstall-action"]').trigger('click')
    expect(wrapper.emitted('uninstall')).toHaveLength(1)
    const versions = wrapper.findAll('[data-ui="suite-delete-version"]')
    await versions[0]!.trigger('click')
    expect(wrapper.emitted('delete')).toEqual([['package-2.0.0']])
    wrapper.unmount()
  })
})
