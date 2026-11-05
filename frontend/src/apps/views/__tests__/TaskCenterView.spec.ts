import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, flushPromises } from '@vue/test-utils'
import { createI18n } from 'vue-i18n'
import { nextTick } from 'vue'
import TaskCenterView from '../TaskCenterView.vue'
import { useTaskCenterStore, type CenterTask } from '@/stores/task-center'
import zh from '@/locales/zh'

vi.mock('@/stores/node', () => ({
  useNodeStore: () => ({ nodes: [{ id: 'a', name: 'Node A', status: 'online' }] }),
}))

/** 构造不同状态的展示摘要，避免真实执行服务影响焦点与键盘验证。 */
function task(id: string, kind: CenterTask['kind'], status: string): CenterTask {
  return {
    id,
    category: 'files',
    kind,
    status,
    nodeId: 'a',
    name: 'very-long-file-name.txt',
    path: '/target/directory',
    progress: 50,
    totalBytes: 100,
    transferredBytes: 50,
    totalFiles: 2,
    completedFiles: 1,
    failedFiles: 0,
    failures: [],
    createdAt: '2026-11-04T01:00:00Z',
    execution: kind === 'upload' ? 'browser' : 'server',
    affectedDirectories: [],
  }
}

describe('task center view', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('用表格统一展示文件任务，切换标签和卸载视图不影响任务', async () => {
    const center = useTaskCenterStore()
    center.tasks.push(
      task('upload', 'upload', 'uploading'),
      task('download', 'download', 'streaming'),
      task('copy', 'copy', 'running'),
      task('move', 'move', 'succeeded'),
      task('remove', 'remove', 'failed'),
    )
    const wrapper = mount(TaskCenterView, {
      attachTo: document.body,
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    await flushPromises()
    expect(document.querySelectorAll('[data-ui="task-center-row"]')).toHaveLength(5)
    const progress = document.querySelector('progress')
    const progressLine = progress?.closest('.task-progress-line')
    expect(progressLine?.textContent).toContain('50%')
    expect(progressLine?.textContent).not.toContain('已完成')
    expect(progress?.getAttribute('aria-label')).toContain('任务进度')
    const tabs = [...document.querySelectorAll<HTMLButtonElement>('[role="tab"]')]
    expect(tabs[0]?.textContent).toContain('文件任务 (3)')
    expect(tabs[1]?.textContent).toContain('其他任务')
    tabs[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    await nextTick()
    expect(center.selectedTab).toBe('other')
    expect(document.body.textContent).toContain('暂无其他任务')
    expect(document.querySelector('[aria-modal="true"]')).toBeNull()
    expect(document.body.style.overflow).not.toBe('hidden')
    expect(center.tasks).toHaveLength(5)
    wrapper.unmount()
  })

  it('显示真实阶段、异常和失败详情；取消中禁用且下载没有取消操作', async () => {
    const center = useTaskCenterStore()
    const cancelling = task('cancelling', 'copy', 'cancelling')
    Object.assign(cancelling, {
      stage: 'rollingBack',
      connectionError: 'offline',
      progress: undefined,
      failures: [{ path: '/source/file', message: 'conflict' }],
    })
    center.tasks.push(cancelling, task('download', 'download', 'completed'))
    const wrapper = mount(TaskCenterView, {
      attachTo: document.body,
      global: { plugins: [createI18n({ legacy: false, locale: 'zh', messages: { zh } })] },
    })
    await flushPromises()
    const row = document.querySelector('[data-task-id="cancelling"]')!.closest('tr')!
    expect(row.textContent).toContain('回滚中')
    expect(row.textContent).toContain('连接异常')
    const menu = row.querySelector<HTMLButtonElement>('[data-ui="task-center-menu"]')!
    menu.click()
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click()
    await flushPromises()
    expect(document.querySelector('[data-ui="task-center-details"]')?.textContent).toContain(
      '/source/file: conflict',
    )
    expect(row.querySelector('progress')?.hasAttribute('value')).toBe(false)
    expect(row.querySelector<HTMLButtonElement>('[data-ui="task-center-cancel"]')?.disabled).toBe(
      true,
    )
    const download = document.querySelector('[data-task-id="download"]')!.closest('tr')!
    expect(download.textContent).toContain('传输完成')
    expect(download.querySelector('[data-ui="task-center-cancel"]')).toBeNull()
    wrapper.unmount()
  })
})
