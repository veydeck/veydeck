/** 桌面会话级任务中心；运行控制与文件引用只保存在内存中。 */
import { computed, effectScope, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { FileOperationTask, FileTransfer } from '@/api/interface/fs'
import { fsApi } from '@/api/modules/fs'
import {
  createFileUploadRunner,
  type FileUploadSelection,
  type FileUploadTaskState,
} from '@/services/file-upload'
import { useWindowManagerStore } from '@/stores/window-manager'
import { useNodeStore } from '@/stores/node'
import { useToastStore } from '@/stores/toast'
import i18n from '@/i18n'

/** 展示分类与具体任务操作分离，允许后续接入其它业务适配器。 */
export type TaskCategory = 'files' | 'other'
/** 任务中心统一摘要，服务端状态保留原有语义。 */
export interface CenterTask {
  id: string
  category: TaskCategory
  kind: 'upload' | 'download' | 'copy' | 'move' | 'remove'
  nodeId: string
  name: string
  path: string
  status: string
  stage?: string
  progress?: number
  totalBytes: number
  transferredBytes: number
  /** 最近采样得到的每秒传输字节，未得到有效采样时留空。 */
  bytesPerSecond?: number
  totalFiles: number
  completedFiles: number
  failedFiles: number
  currentFile?: string
  failures: Array<{ path: string; message: string }>
  error?: string
  connectionError?: string
  actionError?: string
  cleanupWarning?: string
  createdAt: string
  finishedAt?: string
  execution: 'browser' | 'server'
  serverId?: string
  affectedDirectories: string[]
}

const terminal = new Set(['completed', 'succeeded', 'partial', 'failed', 'cancelled', 'expired'])
/** 判断任务是否仍占用执行或等待队列。 */
export const isTaskActive = (task: CenterTask) => !terminal.has(task.status)
/** 获取绝对路径的父目录。 */
const parentPath = (path: string) => path.slice(0, path.lastIndexOf('/')) || '/'

/** 全局任务注册、上传队列和服务端进度跟踪。 */
export const useTaskCenterStore = defineStore('task-center', () => {
  const tasks = ref<CenterTask[]>([])
  const selectedTab = ref<TaskCategory>('files')
  const activeCount = computed(() => tasks.value.filter(isTaskActive).length)
  const hasBrowserUploads = computed(() =>
    tasks.value.some((task) => task.execution === 'browser' && isTaskActive(task)),
  )
  const sortedTasks = computed(() =>
    [...tasks.value].sort((a, b) => {
      if (isTaskActive(a) !== isTaskActive(b)) return isTaskActive(a) ? -1 : 1
      return isTaskActive(a)
        ? a.createdAt.localeCompare(b.createdAt)
        : (b.finishedAt || b.createdAt).localeCompare(a.finishedAt || a.createdAt)
    }),
  )
  const uploads = new Map<
    string,
    { run: () => Promise<void>; cancel: () => Promise<void>; dispose: () => void }
  >()
  const runningNodes = new Set<string>()
  const listeners = new Set<(nodeId: string, directories: string[]) => void>()
  const polls = new Map<
    string,
    { timer?: ReturnType<typeof setTimeout>; inFlight: boolean; delay: number }
  >()
  const speedSamples = new Map<string, { bytes: number; time: number }>()
  let speedTimer: ReturnType<typeof setInterval> | undefined
  let discoveryTimer: ReturnType<typeof setInterval> | undefined
  let stopNodeWatch: (() => void) | undefined
  let session = 0
  let discovering = false

  /** 打开指定分类，未指定时保持会话内选择。 */
  function open(tab?: TaskCategory) {
    if (tab) selectedTab.value = tab
    useWindowManagerStore().openWindow('task-center')
  }

  /** 按真实字节增量采样速度，重连、排队和终态不沿用旧速率。 */
  function sampleSpeeds() {
    const now = performance.now()
    for (const task of tasks.value) {
      if (
        !['upload', 'download'].includes(task.kind) ||
        !isTaskActive(task) ||
        !['uploading', 'streaming', 'receiving'].includes(task.status) ||
        task.connectionError
      ) {
        task.bytesPerSecond = undefined
        speedSamples.delete(task.id)
        continue
      }
      const previous = speedSamples.get(task.id)
      if (previous && now > previous.time) {
        task.bytesPerSecond =
          (Math.max(0, task.transferredBytes - previous.bytes) * 1000) / (now - previous.time)
      }
      speedSamples.set(task.id, { bytes: task.transferredBytes, time: now })
    }
    for (const id of speedSamples.keys())
      if (!tasks.value.some((task) => task.id === id)) speedSamples.delete(id)
  }

  /** 清理已结束记录；运行中的记录永不被移除。 */
  function remove(id: string) {
    tasks.value = tasks.value.filter((task) => task.id !== id || isTaskActive(task))
  }
  /** 清除指定分类的终态记录。 */
  function clearFinished(category: TaskCategory) {
    tasks.value = tasks.value.filter((task) => task.category !== category || isTaskActive(task))
  }
  /** 订阅目录变更；调用方卸载时释放订阅。 */
  function subscribe(listener: (nodeId: string, directories: string[]) => void) {
    listeners.add(listener)
    return () => {
      listeners.delete(listener)
    }
  }
  /** 发布终态变更并限制会话历史数量。 */
  function finish(task: CenterTask) {
    if (task.finishedAt) return
    task.finishedAt = new Date().toISOString()
    task.bytesPerSecond = undefined
    speedSamples.delete(task.id)
    for (const listener of listeners) listener(task.nodeId, task.affectedDirectories)
    const ended = tasks.value
      .filter((task) => !isTaskActive(task))
      .sort((a, b) => (b.finishedAt || b.createdAt).localeCompare(a.finishedAt || a.createdAt))
    const discard = new Set(ended.slice(100).map((task) => task.id))
    tasks.value = tasks.value.filter((task) => !discard.has(task.id))
  }

  /** 为摘要填入共同初始值。 */
  function baseTask(nodeId: string, kind: CenterTask['kind'], id: string): CenterTask {
    return {
      id,
      category: 'files',
      kind,
      nodeId,
      name: '',
      path: '',
      status: 'queued',
      progress: undefined,
      totalBytes: 0,
      transferredBytes: 0,
      totalFiles: 0,
      completedFiles: 0,
      failedFiles: 0,
      failures: [],
      createdAt: new Date().toISOString(),
      execution: 'server',
      affectedDirectories: [],
    }
  }

  /** 依次调度固定节点上的上传，其它节点可同时执行。 */
  function drain(nodeId: string) {
    if (runningNodes.has(nodeId)) return
    const task = tasks.value.find(
      (task) => task.nodeId === nodeId && task.kind === 'upload' && task.status === 'queued',
    )
    if (!task) return
    const job = uploads.get(task.id)
    if (!job) return
    runningNodes.add(nodeId)
    const generation = session
    void job.run().finally(() => {
      if (generation !== session) return
      uploads.delete(task.id)
      runningNodes.delete(nodeId)
      drain(nodeId)
    })
  }

  /** 校验并接收上传批次；文件引用由执行闭包持有直至结束。 */
  function submitUpload(nodeId: string, directory: string, selection: FileUploadSelection) {
    if (
      !selection.files.length ||
      selection.files.some(
        ({ relativePath }) =>
          !relativePath ||
          relativePath.includes('\\') ||
          relativePath.includes('\0') ||
          relativePath.split('/').some((part) => !part || part === '.' || part === '..'),
      )
    ) {
      useToastStore().error(i18n.global.t('app.fileManager.uploadInvalidPath'))
      return false
    }
    selection = { ...selection, files: selection.files.map((source) => ({ ...source })) }
    const runner = createFileUploadRunner(nodeId, i18n.global.t)
    const task = baseTask(nodeId, 'upload', crypto.randomUUID())
    task.execution = 'browser'
    task.name = selection.displayName
    task.path = directory
    task.affectedDirectories = [
      ...new Set([
        directory,
        ...selection.files.flatMap(({ relativePath }) => {
          const segments = relativePath.split('/').slice(0, -1)
          return segments.map(
            (_, index) =>
              `${directory.replace(/\/+$/, '')}/${segments.slice(0, index + 1).join('/')}`,
          )
        }),
      ]),
    ]
    task.totalFiles = selection.files.length
    task.totalBytes = selection.files.reduce((sum, source) => sum + source.file.size, 0)
    tasks.value.push(task)
    const record = tasks.value.find((item) => item.id === task.id)!
    const generation = session
    uploads.set(task.id, {
      cancel: runner.cancelUpload,
      dispose: runner.dispose,
      run: async () => {
        const scope = effectScope(true)
        scope.run(() =>
          watch(
            runner.uploadTask,
            (state: FileUploadTaskState) => {
              if (generation !== session) return
              Object.assign(record, {
                status: state.status,
                progress: state.status === 'preparing' ? undefined : state.progressPercent,
                totalBytes: state.totalBytes,
                transferredBytes: state.transferredBytes,
                totalFiles: state.totalFiles,
                completedFiles: state.completedFiles,
                failedFiles: state.failedFiles,
                currentFile: state.currentFile,
                failures: state.failures,
                error: state.errorSummary,
                connectionError: state.connectionError,
              })
            },
            { deep: true, flush: 'sync' },
          ),
        )
        try {
          await runner.startUpload(directory, selection)
        } finally {
          scope.stop()
          if (generation === session) finish(record)
        }
      },
    })
    drain(nodeId)
    return true
  }

  /** 将服务端任务事实映射为展示摘要。 */
  function applyOperation(task: CenterTask, source: FileOperationTask) {
    Object.assign(task, {
      status: source.status,
      stage: source.stage,
      progress: ['queued', 'validating', 'preparing', 'scanning'].includes(source.stage)
        ? undefined
        : source.progressPercent,
      totalBytes: source.totalBytes,
      transferredBytes: source.processedBytes,
      totalFiles: source.totalItemCount,
      completedFiles: source.completedItemCount,
      failedFiles: source.failedItemCount,
      error: source.errorSummary,
      cleanupWarning: source.cleanupWarning,
      failures: source.items
        .filter((item) => item.errorSummary)
        .map((item) => ({ path: item.path, message: item.errorSummary! })),
      connectionError: undefined,
    })
  }
  /** 映射下载传输；仅宣告服务端传输结果。 */
  function applyDownload(task: CenterTask, source: FileTransfer) {
    Object.assign(task, {
      status: source.status,
      totalBytes: source.sizeBytes,
      transferredBytes: source.transferredBytes,
      progress:
        source.status === 'completed'
          ? 100
          : source.sizeBytes
            ? Math.min(100, Math.round((source.transferredBytes / source.sizeBytes) * 100))
            : undefined,
      error: source.errorSummary,
      connectionError: undefined,
    })
  }

  /** 单个任务使用串行轮询；异常保留事实并指数退避。 */
  function track(task: CenterTask) {
    if (polls.has(task.id) || !isTaskActive(task)) return
    const state = {
      timer: undefined as ReturnType<typeof setTimeout> | undefined,
      inFlight: false,
      delay: 1000,
    }
    polls.set(task.id, state)
    const generation = session
    const tick = async () => {
      if (generation !== session || !polls.has(task.id)) return
      state.inFlight = true
      try {
        const client = fsApi.forNode(task.nodeId)
        if (task.kind === 'download') {
          const response = await client.transferDetail(task.serverId!)
          if (generation !== session || !isTaskActive(task)) return
          if (!response.success || !response.data) throw new Error(response.message)
          applyDownload(task, response.data)
        } else {
          const response = await client.taskDetail(task.serverId!)
          if (generation !== session || !isTaskActive(task)) return
          if (!response.success || !response.data) throw new Error(response.message)
          applyOperation(task, response.data)
        }
        state.delay = 1000
        if (!isTaskActive(task)) {
          polls.delete(task.id)
          finish(task)
          return
        }
      } catch (error) {
        if (generation !== session || !isTaskActive(task)) return
        task.connectionError = error instanceof Error ? error.message : String(error)
        state.delay = Math.min(15000, state.delay * 2)
      } finally {
        state.inFlight = false
      }
      if (generation === session && polls.has(task.id))
        state.timer = setTimeout(() => void tick(), state.delay)
    }
    state.timer = setTimeout(() => void tick(), 1000)
  }

  /** 登记服务端文件任务，相同节点与 ID 只保留一条记录。 */
  function registerOperation(nodeId: string, source: FileOperationTask, targetDirectory?: string) {
    const id = `${nodeId}:operation:${source.taskId}`
    const existing = tasks.value.find((task) => task.id === id)
    if (existing) return
    const task = baseTask(nodeId, source.operation, id)
    task.serverId = source.taskId
    task.name = source.items[0]?.path.split('/').pop() || source.taskId
    task.path = targetDirectory || source.items[0]?.targetPath || source.items[0]?.path || ''
    task.createdAt = source.createdAt
    task.affectedDirectories = [
      ...new Set(
        source.items
          .flatMap((item) => [
            parentPath(item.path),
            ...(item.targetPath ? [parentPath(item.targetPath)] : []),
          ])
          .concat(targetDirectory ? [targetDirectory] : []),
      ),
    ]
    applyOperation(task, source)
    tasks.value.push(task)
    const record = tasks.value.find((task) => task.id === id)!
    if (isTaskActive(record)) track(record)
    else finish(record)
  }

  /** 登记浏览器已启动的下载，不重新发起浏览器下载请求。 */
  function registerDownload(nodeId: string, source: FileTransfer) {
    const id = `${nodeId}:download:${source.transferId}`
    if (tasks.value.some((task) => task.id === id)) return
    const task = baseTask(nodeId, 'download', id)
    Object.assign(task, {
      serverId: source.transferId,
      name: source.path.split('/').pop() || source.path,
      path: source.path,
      createdAt: source.createdAt,
    })
    applyDownload(task, source)
    tasks.value.push(task)
    const record = tasks.value.find((task) => task.id === id)!
    if (isTaskActive(record)) track(record)
    else finish(record)
  }

  /** 取消操作必须由服务端确认；冲突时继续跟踪真实状态。 */
  async function cancel(id: string) {
    const task = tasks.value.find((task) => task.id === id)
    if (
      !task ||
      !isTaskActive(task) ||
      task.status === 'cancelling' ||
      task.kind === 'download' ||
      ['cleaningUp', 'completed'].includes(task.stage || '')
    )
      return
    if (task.execution === 'browser') {
      if (task.status === 'queued') {
        task.status = 'cancelled'
        uploads.delete(id)
        finish(task)
      } else await uploads.get(id)?.cancel()
      return
    }
    const generation = session
    const previousStatus = task.status
    task.status = 'cancelling'
    task.actionError = undefined
    try {
      const response = await fsApi.forNode(task.nodeId).cancelTask(task.serverId!)
      if (generation !== session || !isTaskActive(task)) return
      if (!response.success || !response.data) {
        task.status = previousStatus
        task.actionError = response.message || i18n.global.t('taskCenter.cancelFailed')
        return
      }
      applyOperation(task, response.data)
      if (!isTaskActive(task)) {
        const poll = polls.get(task.id)
        if (poll?.timer) clearTimeout(poll.timer)
        polls.delete(task.id)
        finish(task)
      }
    } catch (error) {
      if (generation !== session || !isTaskActive(task)) return
      task.status = previousStatus
      task.connectionError = error instanceof Error ? error.message : String(error)
    }
  }

  /** 在最多四个节点上并行发现活动任务，不恢复浏览器上传。 */
  async function discover() {
    if (discovering) return
    discovering = true
    const generation = session
    const nodes = useNodeStore()
      .nodes.filter((node) => node.status === 'online')
      .map((node) => node.id)
    const worker = async () => {
      while (nodes.length && generation === session) {
        const nodeId = nodes.shift()!
        const client = fsApi.forNode(nodeId)
        const results = await Promise.allSettled([client.activeTasks(), client.activeTransfers()])
        if (generation !== session) return
        const [operations, transfers] = results
        if (operations?.status === 'fulfilled' && operations.value.success)
          for (const task of operations.value.data || []) registerOperation(nodeId, task)
        if (transfers?.status === 'fulfilled' && transfers.value.success)
          for (const transfer of transfers.value.data || [])
            if (transfer.direction === 'download') registerDownload(nodeId, transfer)
      }
    }
    try {
      await Promise.all(Array.from({ length: Math.min(nodes.length, 4) }, worker))
    } finally {
      if (generation === session) discovering = false
    }
  }

  /** 桌面挂载时启动发现任务；节点上线立即触发一次补充发现。 */
  function start() {
    if (discoveryTimer) return
    void discover()
    discoveryTimer = setInterval(() => void discover(), 30000)
    speedTimer = setInterval(sampleSpeeds, 1000)
    stopNodeWatch = watch(
      () =>
        useNodeStore()
          .nodes.map((node) => `${node.id}:${node.status}`)
          .join(','),
      () => void discover(),
    )
  }
  /** 会话结束后停止所有跟踪并清空个人摘要，不取消服务端任务。 */
  function reset() {
    session += 1
    if (discoveryTimer) clearInterval(discoveryTimer)
    discoveryTimer = undefined
    if (speedTimer) clearInterval(speedTimer)
    speedTimer = undefined
    speedSamples.clear()
    stopNodeWatch?.()
    stopNodeWatch = undefined
    for (const state of polls.values()) if (state.timer) clearTimeout(state.timer)
    polls.clear()
    for (const job of uploads.values()) job.dispose()
    uploads.clear()
    runningNodes.clear()
    discovering = false
    tasks.value = []
    selectedTab.value = 'files'
    listeners.clear()
  }

  return {
    tasks,
    selectedTab,
    sortedTasks,
    activeCount,
    hasBrowserUploads,
    open,
    remove,
    clearFinished,
    subscribe,
    submitUpload,
    registerOperation,
    registerDownload,
    cancel,
    start,
    reset,
  }
})
