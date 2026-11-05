import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import { mount } from '@vue/test-utils'
import DesktopHeader from './DesktopHeader.vue'
import { useTaskCenterStore } from '@/stores/task-center'
import zh from '@/locales/zh'

const mocks = vi.hoisted(() => ({
  error: vi.fn(),
  post: vi.fn(),
  openWindow: vi.fn(),
  checkBeforeCloseAll: vi.fn(() => ({ blockers: [] })),
}))
vi.mock('vue-router', () => ({ useRouter: () => ({}) }))
vi.mock('@/router', () => ({ resetAuthState: vi.fn() }))
vi.mock('@/api', () => ({ default: { post: mocks.post } }))
vi.mock('@/stores/window-manager', () => ({
  useWindowManagerStore: () => ({
    openWindows: [],
    openWindow: mocks.openWindow,
    availableApps: {},
    appCatalogOrder: [],
    checkBeforeCloseAll: mocks.checkBeforeCloseAll,
  }),
}))
vi.mock('@/stores/node', () => ({
  useNodeStore: () => ({
    nodes: [],
    currentNodeId: 'local',
    startAutoRefresh: vi.fn(),
    stopAutoRefresh: vi.fn(),
  }),
}))
vi.mock('@/stores/notification-center', () => ({
  useNotificationCenterStore: () => ({
    unreadCount: 0,
    startPolling: vi.fn(),
    stopPolling: vi.fn(),
  }),
}))
vi.mock('@/stores/toast', () => ({ useToastStore: () => ({ error: mocks.error }) }))
vi.mock('@/stores/confirmation-modal', () => ({
  useConfirmationModalStore: () => ({ showConfirmation: vi.fn() }),
}))

/** 全局上传守卫不能依赖文件管理窗口是否存在。 */
describe('desktop task center entry', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    setActivePinia(createPinia())
  })
  it('任务按钮紧邻通知，显示进行中数量；全局上传阻止无提示离开和退出', async () => {
    const center = useTaskCenterStore()
    const wrapper = mount(DesktopHeader, {
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    center.tasks.push({
      id: 'queued',
      category: 'files',
      kind: 'upload',
      execution: 'browser',
      nodeId: 'local',
      name: 'file',
      path: '/target',
      status: 'queued',
      totalBytes: 0,
      transferredBytes: 0,
      totalFiles: 1,
      completedFiles: 0,
      failedFiles: 0,
      failures: [],
      createdAt: new Date().toISOString(),
      affectedDirectories: [],
    })
    await wrapper.vm.$nextTick()
    expect(wrapper.get('[data-slot="task-count"]').text()).toBe('1')
    const buttons = wrapper.findAll('.header-operate button')
    expect(buttons[0]?.attributes('data-ui')).toBe('desktop-task-center-button')
    expect(buttons[1]?.attributes('data-ui')).toBe('desktop-notification-button')
    await buttons[0]!.trigger('click')
    expect(mocks.openWindow).toHaveBeenCalledWith('task-center')
    const leave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(leave)
    expect(leave.defaultPrevented).toBe(true)
    await wrapper.get('[data-ui="desktop-logout-button"]').trigger('click')
    expect(mocks.error).toHaveBeenCalledWith(expect.stringContaining('仍有上传'))
    expect(mocks.post).not.toHaveBeenCalled()
    center.tasks[0]!.status = 'completed'
    const safeLeave = new Event('beforeunload', { cancelable: true })
    window.dispatchEvent(safeLeave)
    expect(safeLeave.defaultPrevented).toBe(false)
    wrapper.unmount()
  })
})
