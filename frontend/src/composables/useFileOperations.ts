/**
 * @file useFileOperations.ts
 * @description 封装固定节点的同步文件请求与后台任务提交。
 */
import { computed, type Ref } from 'vue'
import { fsApi } from '@/api/modules/fs'
import type { FileOperation, FileOperationItemRequest } from '@/api/interface/fs'
import { useToastStore } from '@/stores/toast'
import { useI18n } from 'vue-i18n'
import { useTaskCenterStore } from '@/stores/task-center'
import type { FileUploadSelection } from '@/services/file-upload'

/** 在窗口内提交文件操作，执行与跟踪交给任务中心。 */
export function useFileOperations(nodeId: Readonly<Ref<string>>) {
  const toastStore = useToastStore()
  const { t } = useI18n()
  const center = useTaskCenterStore()
  const fsClient = computed(() => fsApi.forNode(nodeId.value))

  /** 创建文件属于短请求，保留原有同步反馈。 */
  const createFile = async (path: string, content = '') => {
    const generation = center.captureSession()
    const res = await fsClient.value.createFile({ path, content })
    if (!center.isCurrentSession(generation)) return false
    if (!res.success) toastStore.error(res.message || t('app.fileManager.writeFailed'))
    return res.success
  }
  /** 创建目录属于短请求，保留原有同步反馈。 */
  const mkdir = async (path: string, recursive = false) => {
    const generation = center.captureSession()
    const res = await fsClient.value.mkdir({ path, recursive })
    if (!center.isCurrentSession(generation)) return false
    if (!res.success) toastStore.error(res.message || t('app.fileManager.mkdirFailed'))
    return res.success
  }
  /** 创建服务端文件任务后立即返回，不占用应用窗口。 */
  const runPathTask = async (
    operation: FileOperation,
    items: FileOperationItemRequest[],
    recursive = false,
    targetDirectory?: string,
  ) => {
    const generation = center.captureSession()
    const fixedNodeId = nodeId.value
    const res = await fsApi.forNode(fixedNodeId).createTask({
      operation,
      items,
      targetDirectory,
      recursive,
      overwrite: false,
      idempotencyKey: crypto.randomUUID(),
    })
    if (!center.isCurrentSession(generation)) return false
    if (!res.success || !res.data) {
      toastStore.error(res.message || t('app.fileManager.fetchError'))
      return false
    }
    center.registerOperation(fixedNodeId, res.data, targetDirectory)
    return true
  }
  /** 删除确认和权限校验由调用方负责。 */
  const removePath = (path: string, recursive = false, expectedRevision?: string) =>
    runPathTask('remove', [{ path, expectedRevision }], recursive)
  /** 重命名沿用服务端 move 任务与 revision 校验。 */
  const renamePath = (from: string, to: string, expectedRevision?: string) =>
    runPathTask('move', [{ path: from, targetPath: to, expectedRevision }], true)
  /** 提交单项复制任务。 */
  const copyPath = (from: string, to: string, expectedRevision?: string) =>
    runPathTask('copy', [{ path: from, targetPath: to, expectedRevision }], true)
  /** 启动浏览器原生下载，后续仅跟踪服务端传输。 */
  const downloadFile = async (path: string, fileName?: string, expectedRevision?: string) => {
    const generation = center.captureSession()
    const fixedNodeId = nodeId.value
    const client = fsApi.forNode(fixedNodeId)
    const res = await client.createTransfer({
      direction: 'download',
      path,
      expectedRevision,
      overwrite: false,
    })
    if (!center.isCurrentSession(generation)) return false
    if (!res.success || !res.data) {
      toastStore.error(res.message || t('app.fileManager.downloadFailed'))
      return false
    }
    const link = document.createElement('a')
    link.href = client.downloadUrl(res.data.transferId)
    link.download = fileName || path.split('/').pop() || 'download'
    document.body.appendChild(link)
    link.click()
    link.remove()
    center.registerDownload(fixedNodeId, res.data)
    return true
  }
  /** 捕获提交时的节点和目录，将上传加入桌面队列。 */
  const startUpload = (directory: string, selection: FileUploadSelection) =>
    center.submitUpload(nodeId.value, directory, selection)

  return {
    createFile,
    mkdir,
    removePath,
    renamePath,
    copyPath,
    runPathTask,
    downloadFile,
    startUpload,
  }
}
