/** 固定节点的上传执行器，生命周期由任务中心持有。 */
import { computed, reactive } from 'vue'
import { fsApi } from '@/api/modules/fs'
import { useToastStore } from '@/stores/toast'

const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
const TERMINAL_TRANSFER_STATUSES = new Set(['completed', 'failed', 'cancelled', 'expired'])

/** 上传批次生命周期状态。 */
export type FileUploadTaskStatus =
  | 'queued'
  | 'preparing'
  | 'uploading'
  | 'cancelling'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'

/** 浏览器文件与已验证的相对路径。 */
export interface FileUploadSource {
  file: File
  relativePath: string
}

/** 一次文件或目录选择形成的上传批次。 */
export interface FileUploadSelection {
  kind: 'files' | 'folder'
  displayName: string
  files: FileUploadSource[]
}

/** 单项上传失败摘要。 */
export interface FileUploadFailure {
  path: string
  message: string
}

/** 上传执行器输出的实时进度事实。 */
export interface FileUploadTaskState {
  kind: FileUploadSelection['kind']
  displayName: string
  targetDirectory: string
  status: FileUploadTaskStatus
  totalFiles: number
  completedFiles: number
  failedFiles: number
  totalBytes: number
  transferredBytes: number
  progressPercent: number
  currentFile: string
  failures: FileUploadFailure[]
  errorSummary: string
  connectionError?: string
}

const ACTIVE_UPLOAD_STATUSES = new Set<FileUploadTaskStatus>([
  'queued',
  'preparing',
  'uploading',
  'cancelling',
])

const wait = (delayMs: number) => new Promise((resolve) => window.setTimeout(resolve, delayMs))

/** 拼接服务器绝对路径，避免重复分隔符。 */
const joinAbsolutePath = (directory: string, relativePath: string) => {
  const root = directory === '/' ? '' : directory.replace(/\/+$/, '')
  return `${root}/${relativePath}`.replace(/\/{2,}/g, '/')
}

/** 校验浏览器提供的相对路径，禁止目录逃逸和平台分隔符混用。 */
const normalizeRelativePath = (path: string) => {
  if (!path || path.includes('\\') || path.includes('\0') || path.startsWith('/')) {
    throw new Error('invalid upload relative path')
  }
  const segments = path.split('/')
  if (segments.some((segment) => !segment || segment === '.' || segment === '..')) {
    throw new Error('invalid upload relative path')
  }
  return segments.join('/')
}

/** 创建独立上传执行器；同节点调度由任务中心负责。 */
export function createFileUploadRunner(nodeId: string, t: (key: string) => string) {
  const toastStore = useToastStore()
  const uploadTask = reactive<FileUploadTaskState>({
    kind: 'files',
    displayName: '',
    targetDirectory: '',
    status: 'completed',
    totalFiles: 0,
    completedFiles: 0,
    failedFiles: 0,
    totalBytes: 0,
    transferredBytes: 0,
    progressPercent: 0,
    currentFile: '',
    failures: [],
    errorSummary: '',
  })
  const uploadActive = computed(() => ACTIVE_UPLOAD_STATUSES.has(uploadTask.status))
  let disposed = false
  let uploadCancelRequested = false
  let uploadAbortController: AbortController | null = null
  let currentTransferId = ''
  let currentTransferClient: ReturnType<(typeof fsApi)['forNode']> | null = null
  let currentCancelPromise: Promise<void> | null = null
  let completedDuringCleanup = false

  /** 计算并写入上传任务的整体进度。 */
  const updateUploadProgress = (
    settledWorkBytes: number,
    currentWorkBytes: number,
    actualTransferredBytes: number,
  ) => {
    uploadTask.transferredBytes = Math.min(uploadTask.totalBytes, actualTransferredBytes)
    if (uploadTask.totalBytes > 0) {
      uploadTask.progressPercent = Math.min(
        100,
        Math.round(((settledWorkBytes + currentWorkBytes) / uploadTask.totalBytes) * 100),
      )
      return
    }
    const processedFiles = uploadTask.completedFiles + uploadTask.failedFiles
    uploadTask.progressPercent = uploadTask.totalFiles
      ? Math.round((processedFiles / uploadTask.totalFiles) * 100)
      : 0
  }

  /** 取消当前服务端传输；并发调用复用同一请求。 */
  const cancelCurrentTransfer = async () => {
    if (!currentTransferId || !currentTransferClient) return
    if (currentCancelPromise) return currentCancelPromise
    const transferId = currentTransferId
    const client = currentTransferClient
    currentCancelPromise = client
      .cancelTransfer(transferId)
      .then(async (response) => {
        let result = response.data
        if (!response.success || !result || !TERMINAL_TRANSFER_STATUSES.has(result.status)) {
          const detail = await client.transferDetail(transferId)
          if (
            !detail.success ||
            !detail.data ||
            !TERMINAL_TRANSFER_STATUSES.has(detail.data.status)
          ) {
            throw new Error(response.message || t('taskCenter.connectionError'))
          }
          result = detail.data
        }
        completedDuringCleanup = result.status === 'completed'
      })
      .finally(() => {
        currentCancelPromise = null
      })
    return currentCancelPromise
  }

  /** 取消失败时保留运行状态，网络恢复后继续确认清理结果。 */
  const confirmCancellation = async () => {
    let delay = 1000
    while (currentTransferId && !disposed) {
      try {
        await cancelCurrentTransfer()
        currentTransferId = ''
        uploadTask.connectionError = undefined
      } catch (error) {
        uploadTask.connectionError = error instanceof Error ? error.message : String(error)
        await wait(delay)
        delay = Math.min(15000, delay * 2)
      }
    }
  }

  let committing = false

  /** 上传一个文件并报告本文件的实际传输字节。 */
  const uploadOneFile = async (
    client: ReturnType<(typeof fsApi)['forNode']>,
    targetPath: string,
    file: File,
    onProgress: (uploadedBytes: number) => void,
  ) => {
    completedDuringCleanup = false
    const active = await client.activeTransfers()
    if (!active.success) {
      throw new Error(active.message || t('app.fileManager.uploadFailed'))
    }
    const resumable = active.data?.find(
      (transfer) =>
        transfer.direction === 'upload' &&
        transfer.path === targetPath &&
        transfer.sizeBytes === file.size &&
        !TERMINAL_TRANSFER_STATUSES.has(transfer.status),
    )
    const created = resumable
      ? { success: true, data: resumable, message: '' }
      : await client.createTransfer({
          direction: 'upload',
          path: targetPath,
          sizeBytes: file.size,
          overwrite: false,
        })
    if (!created.success || !created.data) {
      throw new Error(created.message || t('app.fileManager.uploadFailed'))
    }

    currentTransferId = created.data.transferId
    currentTransferClient = client
    let uploadedBytes = created.data.transferredBytes
    onProgress(uploadedBytes)
    if (uploadCancelRequested) {
      await confirmCancellation()
      return { completed: false, uploadedBytes }
    }

    try {
      for (let start = uploadedBytes; start < file.size; start += UPLOAD_CHUNK_BYTES) {
        if (uploadCancelRequested) break
        const endExclusive = Math.min(start + UPLOAD_CHUNK_BYTES, file.size)
        const chunk = await file.slice(start, endExclusive).arrayBuffer()
        if (uploadCancelRequested) break
        const controller = new AbortController()
        uploadAbortController = controller
        const uploaded = await client.uploadChunk(
          currentTransferId,
          chunk,
          start,
          endExclusive - 1,
          file.size,
          {
            signal: controller.signal,
            onProgress: (loadedBytes) => {
              uploadedBytes = Math.max(uploadedBytes, Math.min(endExclusive, start + loadedBytes))
              onProgress(uploadedBytes)
            },
          },
        )
        uploadAbortController = null
        if (!uploaded.success || !uploaded.data) {
          throw new Error(uploaded.message || t('app.fileManager.uploadFailed'))
        }
        uploadedBytes = uploaded.data.transferredBytes
        onProgress(uploadedBytes)
      }
      if (uploadCancelRequested) {
        await confirmCancellation()
        return { completed: false, uploadedBytes }
      }
      if (disposed) return { completed: false, uploadedBytes }
      committing = true
      const completed = await client.completeTransfer(currentTransferId)
      committing = false
      if (!completed.success || completed.data?.status !== 'completed') {
        throw new Error(completed.message || t('app.fileManager.uploadFailed'))
      }
      currentTransferId = ''
      onProgress(file.size)
      return { completed: true, uploadedBytes: file.size }
    } catch (error) {
      committing = false
      uploadAbortController = null
      await confirmCancellation()
      if (completedDuringCleanup) {
        onProgress(file.size)
        return { completed: true, uploadedBytes: file.size }
      }
      if (uploadCancelRequested) return { completed: false, uploadedBytes }
      throw error
    }
  }

  /** 执行固定节点上的一个上传批次。 */
  const startUpload = async (targetDirectory: string, selection: FileUploadSelection) => {
    if (disposed || uploadActive.value || selection.files.length === 0) return false
    let files: FileUploadSource[]
    try {
      files = selection.files.map((source) => ({
        file: source.file,
        relativePath: normalizeRelativePath(source.relativePath),
      }))
    } catch {
      toastStore.error(t('app.fileManager.uploadInvalidPath'))
      return false
    }

    Object.assign(uploadTask, {
      kind: selection.kind,
      displayName: selection.displayName,
      targetDirectory,
      status: 'preparing' as FileUploadTaskStatus,
      totalFiles: files.length,
      completedFiles: 0,
      failedFiles: 0,
      totalBytes: files.reduce((total, source) => total + source.file.size, 0),
      transferredBytes: 0,
      progressPercent: 0,
      currentFile: '',
      failures: [],
      errorSummary: '',
    })
    uploadCancelRequested = false
    const client = fsApi.forNode(nodeId)
    currentTransferClient = client
    let settledWorkBytes = 0
    let actualTransferredBytes = 0

    try {
      if (selection.kind === 'folder') {
        const directories = new Set<string>()
        files.forEach(({ relativePath }) => {
          const segments = relativePath.split('/')
          segments.pop()
          for (let end = 1; end <= segments.length; end += 1) {
            directories.add(segments.slice(0, end).join('/'))
          }
        })
        for (const directory of [...directories].sort(
          (left, right) => left.split('/').length - right.split('/').length,
        )) {
          if (uploadCancelRequested) break
          uploadTask.currentFile = directory
          const created = await client.mkdir({
            path: joinAbsolutePath(targetDirectory, directory),
            recursive: false,
          })
          if (!created.success) {
            throw new Error(created.message || t('app.fileManager.uploadDirectoryFailed'))
          }
        }
      }

      for (const source of files) {
        if (uploadCancelRequested) break
        uploadTask.status = 'uploading'
        uploadTask.currentFile = source.relativePath
        let currentUploadedBytes = 0
        try {
          const result = await uploadOneFile(
            client,
            joinAbsolutePath(targetDirectory, source.relativePath),
            source.file,
            (uploadedBytes) => {
              currentUploadedBytes = Math.max(currentUploadedBytes, uploadedBytes)
              updateUploadProgress(
                settledWorkBytes,
                currentUploadedBytes,
                actualTransferredBytes + currentUploadedBytes,
              )
            },
          )
          if (!result.completed) break
          uploadTask.completedFiles += 1
          actualTransferredBytes += source.file.size
        } catch (error) {
          const message = error instanceof Error ? error.message : t('app.fileManager.uploadFailed')
          uploadTask.failedFiles += 1
          actualTransferredBytes += currentUploadedBytes
          uploadTask.failures.push({ path: source.relativePath, message })
        }
        settledWorkBytes += source.file.size
        updateUploadProgress(settledWorkBytes, 0, actualTransferredBytes)
      }

      if (uploadCancelRequested && uploadTask.completedFiles < uploadTask.totalFiles) {
        uploadTask.status = 'cancelled'
      } else if (uploadTask.failedFiles === 0) {
        uploadTask.status = 'completed'
        uploadTask.progressPercent = 100
      } else if (uploadTask.completedFiles > 0) {
        uploadTask.status = 'partial'
        uploadTask.progressPercent = 100
      } else {
        uploadTask.status = 'failed'
        uploadTask.progressPercent = 100
      }
    } catch (error) {
      uploadTask.errorSummary =
        error instanceof Error ? error.message : t('app.fileManager.uploadFailed')
      uploadTask.status = uploadCancelRequested ? 'cancelled' : 'failed'
    } finally {
      uploadAbortController = null
      currentTransferId = ''
      currentTransferClient = null
      currentCancelPromise = null
      uploadTask.currentFile = ''
    }
    return uploadTask.completedFiles > 0
  }

  /** 请求取消上传，当前分块中止后由服务端清理暂存文件。 */
  const cancelUpload = async () => {
    if (!uploadActive.value || uploadTask.status === 'cancelling') return
    uploadCancelRequested = true
    uploadTask.status = 'cancelling'
    uploadAbortController?.abort()
    if (!committing) await confirmCancellation()
  }

  /** 会话销毁时停止浏览器工作，不再向失效会话提交请求。 */
  const dispose = () => {
    disposed = true
    uploadCancelRequested = true
    uploadAbortController?.abort()
  }
  return { uploadTask, uploadActive, startUpload, cancelUpload, dispose }
}
