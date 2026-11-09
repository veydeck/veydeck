import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import FilePropertiesDialog from '../FilePropertiesDialog.vue'
import zh from '@/locales/zh'

const api = vi.hoisted(() => ({ detail: vi.fn(), createStatistics: vi.fn(), statisticsDetail: vi.fn(), cancelStatistics: vi.fn() }))
vi.mock('@/api/modules/fs', () => ({ fsApi: { forNode: () => api } }))

/** 提供含零字节、无创建时间及完整 POSIX 权限的详情。 */
const detail = (fields: Record<string, unknown> = {}) => ({
  success: true,
  data: {
    name: 'empty.sh', path: '/logical/empty.sh', kind: 'file', revision: 'revision',
    sizeBytes: 0, allocatedBytes: 0, mode: 0o100640, uid: 1000, gid: 100,
    userName: 'alice', groupName: 'users', modifiedAt: '2026-11-09T08:00:00Z',
    accessedAt: '2026-11-09T08:00:00Z', management: { kind: 'custom' }, capabilities: {},
    ...fields,
  },
})
const wrappers: Array<ReturnType<typeof mount>> = []
/** 使用真实窗口级对话框，验证 Teleport、可见数据与焦点恢复。 */
function render() {
  const visible = ref(true)
  const close = vi.fn(() => { visible.value = false })
  const wrapper = mount(defineComponent({
    setup: () => () => h('div', { class: 'window-content' }, [
      h('button', { 'data-ui': 'file-grid' }, 'files'),
      visible.value ? h(FilePropertiesDialog, { nodeId: 'node-a', nodeName: 'NAS', path: '/logical/empty.sh', onClose: close }) : null,
    ]),
  }), { attachTo: document.body, global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] } })
  wrappers.push(wrapper)
  return { wrapper, close }
}

describe('文件属性对话框', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.detail.mockResolvedValue(detail())
    vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} })
  })
  afterEach(() => {
    for (const wrapper of wrappers.splice(0)) wrapper.unmount()
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('显示零字节、所有者与权限值，路径只提供复制入口', async () => {
    const { wrapper, close } = render()
    await flushPromises()
    const text = wrapper.get('[data-ui="file-properties"]').text()
    expect(text).toContain('0 B (0 字节)')
    expect(text).not.toContain('/logical/empty.sh')
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    await wrapper.get('[data-ui="file-properties-copy-path"]').trigger('click')
    expect(writeText).toHaveBeenCalledWith('/logical/empty.sh')
    expect(text).toContain('alice (1000)')
    expect(text).toContain('users (100)')
    expect(text).toContain('0640')
    expect(text).toContain('不支持')
    expect(wrapper.findAll('[data-slot="permissions"] input')).toHaveLength(0)
    expect(api.createStatistics).not.toHaveBeenCalled()
    await wrapper.get('[data-ui="file-properties-close"]').trigger('click')
    expect(close).toHaveBeenCalledOnce()
  })

  it('目录只在点击后统计，未知所有者降级为 UID/GID，权限保留八进制值', async () => {
    api.detail.mockResolvedValue(detail({ kind: 'directory', name: 'folder', userName: undefined, groupName: undefined, mode: 0o41770 }))
    const { wrapper } = render()
    await flushPromises()
    expect(wrapper.get('[data-ui="file-statistics-start"]').text()).toBe('计算大小')
    expect(wrapper.get('[data-slot="permissions"]').text()).toContain('1000')
    expect(wrapper.get('[data-slot="permissions"]').text()).toContain('1770')
    expect(api.createStatistics).not.toHaveBeenCalled()
    api.createStatistics.mockResolvedValue({ success: true, data: {
      id: 'scan', status: 'running', fileCount: 0, directoryCount: 0, symlinkCount: 0,
      logicalBytes: 0, allocatedBytes: 0, errors: [],
    } })
    api.cancelStatistics.mockResolvedValue({ success: true })
    await wrapper.get('[data-ui="file-statistics-start"]').trigger('click')
    await flushPromises()
    expect(api.createStatistics).toHaveBeenCalledWith({ path: '/logical/empty.sh', expectedRevision: 'revision' })
    expect(wrapper.get('[data-ui="file-statistics-cancel"]').exists()).toBe(true)
  })

  it('断链仍显示自身信息与目标，路径不替换成真实路径', async () => {
    api.detail.mockResolvedValue(detail({ kind: 'symlink', symlinkTarget: '../missing', symlinkError: 'FILE_NOT_FOUND' }))
    const { wrapper } = render()
    await flushPromises()
    expect(wrapper.get('[data-slot="link"]').text()).toContain('../missing')
    expect(wrapper.get('[data-slot="basic"]').text()).not.toContain('/logical/empty.sh')
    expect(wrapper.find('[data-slot="statistics"]').exists()).toBe(false)
    expect(wrapper.find('[data-slot="permissions"]').exists()).toBe(true)
  })

  it('详情错误不显示旧信息，保留刷新和关闭入口', async () => {
    api.detail.mockResolvedValue({ success: false, message: '文件已被删除' })
    const { wrapper } = render()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('文件已被删除')
    expect(wrapper.find('[data-slot="summary"]').exists()).toBe(false)
    api.detail.mockResolvedValue(detail())
    await wrapper.get('[data-ui="file-properties-refresh"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-slot="summary"]').exists()).toBe(true)
  })

  it('打开后聚焦关闭按钮，Escape 关闭后恢复宿主文件区域焦点', async () => {
    const { wrapper, close } = render()
    await flushPromises()
    expect(document.activeElement).toBe(wrapper.get('[data-ui="file-properties-close"]').element)
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await flushPromises()
    expect(close).toHaveBeenCalledOnce()
    expect(wrapper.find('[data-ui="file-properties"]').exists()).toBe(false)
    expect(document.activeElement).toBe(wrapper.get('[data-ui="file-grid"]').element)
  })

  it('复制成功显示按钮内勾选三秒，重复复制续时，失败时不显示成功', async () => {
    vi.useFakeTimers()
    const { wrapper } = render()
    await flushPromises()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const button = wrapper.get('[data-ui="file-properties-copy-path"]')
    await button.trigger('click')
    await flushPromises()
    expect(button.find('[data-slot="copy-success"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    await button.trigger('click')
    await flushPromises()
    await vi.advanceTimersByTimeAsync(2999)
    expect(button.find('[data-slot="copy-success"]').exists()).toBe(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(button.find('[data-slot="copy-success"]').exists()).toBe(false)
    writeText.mockRejectedValueOnce(new Error('permission denied'))
    await button.trigger('click')
    await flushPromises()
    expect(button.find('[data-slot="copy-success"]').exists()).toBe(false)
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
  })

  it('长链接目标通过组件库气泡展示完整原始路径', async () => {
    vi.useFakeTimers()
    const target = '../' + 'very-long-directory/'.repeat(20) + 'target.pcap'
    api.detail.mockResolvedValue(detail({ kind: 'symlink', symlinkTarget: target, symlinkTargetKind: 'file' }))
    const { wrapper } = render()
    await flushPromises()
    const trigger = wrapper.get('[data-ui="file-properties-link-target"]')
    expect(trigger.find('.target-path').text()).toBe(target)
    await trigger.trigger('mouseenter')
    await vi.advanceTimersByTimeAsync(250)
    await flushPromises()
    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(target)
    await trigger.trigger('mouseleave')
    await flushPromises()
    expect(document.querySelector('[role="tooltip"]')).toBeNull()
  })
})
