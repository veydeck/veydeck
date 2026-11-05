/** 文件管理的浏览偏好、会话剪贴板与内部拖拽状态。 */
import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { FileUploadSelection } from '@/services/file-upload'
import type { FsEntry, FileOperationTask } from '@/api/interface/fs'
import { fsApi } from '@/api/modules/fs'
import { useTaskCenterStore } from './task-center'
import {
  fileTarget,
  normalizeFilePath,
  validateFileAction,
  fileDirectoryCapabilities,
} from '@/services/file-browser'
import i18n from '@/i18n'

/** 持久化的显示偏好，不包含文件路径或剪贴板内容。 */
export interface FileBrowserPreferences {
  view: 'icons' | 'details'
  iconSize: 32 | 48 | 64
  sortBy: 'name' | 'modifiedAt' | 'sizeBytes'
  sortOrder: 'ascending' | 'descending'
  showHidden: boolean
}
const preferenceKey = 'veydeck_file_browser_preferences'
/** 归一化存储数据，避免无效值影响布局或服务端查询。 */
export function normalizeFilePreferences(
  value: Partial<FileBrowserPreferences> = {},
): FileBrowserPreferences {
  return {
    view: value.view === 'details' ? 'details' : 'icons',
    iconSize: [32, 48, 64].includes(value.iconSize || 0) ? value.iconSize! : 48,
    sortBy: ['name', 'modifiedAt', 'sizeBytes'].includes(value.sortBy || '')
      ? value.sortBy!
      : 'name',
    sortOrder: value.sortOrder === 'descending' ? 'descending' : 'ascending',
    showHidden: value.showHidden === true,
  }
}
/** 容忍浏览器禁止本地存储。 */
function loadPreferences(): FileBrowserPreferences {
  try {
    return normalizeFilePreferences(JSON.parse(localStorage.getItem(preferenceKey) || '{}') || {})
  } catch {
    return normalizeFilePreferences()
  }
}
/** 复制和拖拽均固定来源节点及选中文件事实。 */
export interface FileSelectionPayload {
  nodeId: string
  entries: FsEntry[]
}
/** 会话剪贴板的操作身份。 */
interface FileClipboard extends FileSelectionPayload {
  mode: 'copy' | 'move'
  generation: string
}
/** 全窗口共享的文件浏览状态，执行不依赖某个文件窗口。 */
export const useFileBrowserStore = defineStore('file-browser', () => {
  const preferences = ref(loadPreferences())
  const clipboard = ref<FileClipboard>()
  const pendingTask = ref<string>()
  const drag = ref<FileSelectionPayload & { token: string }>()
  const center = useTaskCenterStore()
  let stop: (() => void) | undefined
  let session = 0
  const cutPaths = computed(
    () =>
      new Set(
        clipboard.value?.mode === 'move'
          ? clipboard.value.entries.map((entry) => `${clipboard.value!.nodeId}:${entry.path}`)
          : [],
      ),
  )
  watch(
    preferences,
    (value) => {
      try {
        localStorage.setItem(preferenceKey, JSON.stringify(value))
      } catch {
        /* 偏好存储不可用不阻止文件操作。 */
      }
    },
    { deep: true },
  )
  /** 返回本地化的操作错误。 */
  function fail(key: string): never {
    throw new Error(i18n.global.t(`fileBrowser.${key}`))
  }
  /** 创建请求前校验目标、条目能力和单次数量。 */
  async function submit(
    mode: 'copy' | 'move',
    source: FileSelectionPayload,
    targetNode: string,
    directory: string,
    clipboardGeneration?: string,
  ) {
    const generation = session
    const reason = validateFileAction(source.nodeId, targetNode, source.entries, directory)
    if (reason) fail(reason)
    if (
      source.entries.some(
        (entry) =>
          !entry.capabilities.canCopy || (mode === 'move' && !entry.capabilities.canRemove),
      )
    )
      fail('permissionDenied')
    const client = fsApi.forNode(targetNode)
    const target = await client.detail(directory)
    if (generation !== session) throw new DOMException('Session ended', 'AbortError')
    if (!target.success || !target.data || !fileDirectoryCapabilities(target.data).canCreateChild)
      fail('permissionDenied')
    const res = await client.createTask({
      operation: mode,
      items: source.entries.map((entry) => ({
        path: entry.path,
        expectedRevision: entry.revision,
        targetPath: fileTarget(normalizeFilePath(directory), entry.name),
      })),
      recursive: true,
      overwrite: false,
      idempotencyKey: crypto.randomUUID(),
    })
    if (generation !== session) throw new DOMException('Session ended', 'AbortError')
    if (!res.success || !res.data)
      throw new Error(res.message || i18n.global.t('fileBrowser.operationFailed'))
    if (clipboardGeneration) pendingTask.value = res.data.taskId
    center.registerOperation(targetNode, res.data, directory)
    if (clipboardGeneration && ['succeeded', 'failed', 'cancelled'].includes(res.data.status))
      settle(res.data.taskId, res.data.items)
    return res.data
  }
  /** 仅根据服务端逐项终态清理剪切成功项。 */
  function settle(taskId: string, items: FileOperationTask['items']) {
    if (pendingTask.value !== taskId) return
    pendingTask.value = undefined
    if (clipboard.value?.mode !== 'move') return
    const succeeded = new Set(
      items.filter((item) => item.status === 'succeeded').map((item) => item.path),
    )
    clipboard.value.entries = clipboard.value.entries.filter((entry) => !succeeded.has(entry.path))
    if (!clipboard.value.entries.length) clipboard.value = undefined
  }
  /** 挂载到桌面会话，剪切完成回调不会持有窗口组件。 */
  function start() {
    if (!stop)
      stop = center.subscribeOperation((task) => {
        if (task?.serverId && task.operationItems) settle(task.serverId, task.operationItems)
      })
  }
  /** 登录会话结束后移除订阅与文件引用。 */
  function reset() {
    session += 1
    stop?.()
    stop = undefined
    clipboard.value = undefined
    pendingTask.value = undefined
    drag.value = undefined
  }
  /** 覆盖剪贴板时保留完整版本与能力信息。 */
  function capture(mode: 'copy' | 'move', source: FileSelectionPayload) {
    if (pendingTask.value) fail('movePending')
    if (!source.entries.length) return
    if (source.entries.length > 500) fail('tooMany')
    if (
      source.entries.some(
        (entry) =>
          !entry.capabilities.canCopy || (mode === 'move' && !entry.capabilities.canRemove),
      )
    )
      fail('permissionDenied')
    clipboard.value = {
      ...source,
      entries: source.entries.map((entry) => ({
        ...entry,
        capabilities: { ...entry.capabilities },
      })),
      mode,
      generation: crypto.randomUUID(),
    }
  }
  /** 剪切在请求创建和后台执行期间都禁止再次粘贴。 */
  async function paste(nodeId: string, directory: string) {
    const value = clipboard.value
    if (!value) return
    if (pendingTask.value) fail('movePending')
    if (value.mode === 'move') pendingTask.value = 'submitting'
    try {
      return await submit(
        value.mode,
        value,
        nodeId,
        directory,
        value.mode === 'move' ? value.generation : undefined,
      )
    } catch (error) {
      if (clipboard.value?.generation === value.generation && pendingTask.value === 'submitting')
        pendingTask.value = undefined
      throw error
    }
  }
  /** 目录遍历和上传提交属于桌面会话，窗口关闭可继续，登出后停止提交。 */
  async function uploadDrop(
    nodeId: string,
    directory: string,
    read: () => Promise<FileUploadSelection>,
  ) {
    const generation = session
    const target = await fsApi.forNode(nodeId).detail(directory)
    if (generation !== session) return
    if (!target.success || !target.data || !fileDirectoryCapabilities(target.data).canCreateChild)
      fail('permissionDenied')
    const selection = await read()
    if (generation !== session) return
    if (!selection.files.length) fail('emptyDrop')
    center.submitUpload(nodeId, directory, selection)
  }
  /** 未提交的剪切可以取消，已提交的任务交由任务中心控制。 */
  function clearCut() {
    if (!pendingTask.value && clipboard.value?.mode === 'move') clipboard.value = undefined
  }
  return {
    preferences,
    clipboard,
    pendingTask,
    drag,
    cutPaths,
    submit,
    uploadDrop,
    capture,
    paste,
    clearCut,
    start,
    reset,
  }
})
