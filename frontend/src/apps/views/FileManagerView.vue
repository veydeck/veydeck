<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { VeyButton, VeyInput, VeyEmpty } from '@/components/ui'
import VeyIcon from '@/components/icons/VeyIcon.vue'
import AppContextMenu from '@/components/AppContextMenu.vue'
import ApplicationDialog from '@/components/layout/ApplicationDialog.vue'
import ApplicationConfirmationDialog from '@/components/layout/ApplicationConfirmationDialog.vue'
import FileBrowserContent from '@/components/files/FileBrowserContent.vue'
import { useFileDirectory } from '@/composables/useFileDirectory'
import { useFileOperations } from '@/composables/useFileOperations'
import { useApplicationConfirmation } from '@/composables/useApplicationConfirmation'
import { useFileBrowserStore, type FileBrowserPreferences } from '@/stores/file-browser'
import { useTaskCenterStore } from '@/stores/task-center'
import { useWindowManagerStore } from '@/stores/window-manager'
import { useNodeStore } from '@/stores/node'
import { useToastStore } from '@/stores/toast'
import { fsApi } from '@/api/modules/fs'
import { localizeErrorSummary } from '@/api/error'
import type { FsEntry } from '@/api/interface/fs'
import { fileParent, fileTarget, validateFileAction } from '@/services/file-browser'
import { captureDroppedFiles } from '@/services/file-drop'
import { fileIconUrl } from '@/services/file-icons'

/** 文件管理窗口只持有浏览状态，后台文件任务由桌面会话统一管理。 */
const props = defineProps<{
  windowId?: string
  payload?: Record<string, unknown>
  isMaximized?: boolean
}>()
const { t } = useI18n(),
  browser = useFileBrowserStore(),
  center = useTaskCenterStore(),
  windows = useWindowManagerStore(),
  nodes = useNodeStore(),
  toast = useToastStore()
const nodeId = ref(
  typeof props.payload?.nodeId === 'string' ? props.payload.nodeId : nodes.currentNodeId || 'local',
)
const selected = ref(new Set<string>()),
  interacting = ref(false),
  submitting = ref(false)
const root = ref<HTMLElement>(),
  content = ref<InstanceType<typeof FileBrowserContent>>()
const directory = useFileDirectory(nodeId, interacting, () => {
  selected.value = new Set()
  content.value?.resetScroll()
})
const {
  path,
  home,
  entries,
  total,
  loading,
  error,
  canCreate,
  loadedAt,
  hasMore,
  historyIndex,
  history,
} = directory
const operations = useFileOperations(nodeId)
const { confirmationState, showConfirmation, handleConfirmationResponse } =
  useApplicationConfirmation()
const chosen = computed(() => entries.value.filter((entry) => selected.value.has(entry.path)))
const canCopy = computed(
  () => chosen.value.length > 0 && chosen.value.every((entry) => entry.capabilities.canCopy),
)
const canCut = computed(
  () => canCopy.value && chosen.value.every((entry) => entry.capabilities.canRemove),
)
const address = ref(''),
  editingAddress = ref(false),
  addressElement = ref<HTMLElement>()
const crumbs = computed(() => [
  { name: '/', path: '/' },
  ...path.value
    .split('/')
    .filter(Boolean)
    .map((name, index, array) => ({ name, path: '/' + array.slice(0, index + 1).join('/') })),
])
const active = computed(() => {
  if (!props.windowId) return true
  const window = windows.openWindows?.find((w) => w.id === props.windowId)
  return !!window && !window.isMinimized && window.zIndex === windows.maxZIndex
})
const dialog = ref<{ type: 'file' | 'dir' | 'rename'; entry?: FsEntry }>(),
  inputName = ref('')
const menu = ref<{
    x: number
    y: number
    entry?: FsEntry
    kind?: 'create' | 'upload' | 'view'
    trigger: HTMLElement | null
  }>(),
  menuElement = ref<HTMLElement>()
const dropPath = ref<string>(),
  dropDescription = ref('')
const fileInput = ref<HTMLInputElement>(),
  folderInput = ref<HTMLInputElement>()
let unsubscribe: (() => void) | undefined,
  disposed = false
let openSequence = 0
const uploadActions = computed(() => [
  {
    label: t('app.fileManager.uploadFile'),
    icon: 'file',
    handler: () => fileInput.value?.click(),
  },
  {
    label: t('app.fileManager.uploadFolder'),
    icon: 'folder',
    handler: () => folderInput.value?.click(),
  },
])
const createActions = computed(() => [
  { label: t('app.fileManager.newDir'), icon: 'folder', handler: () => openDialog('dir') },
  { label: t('app.fileManager.newFile'), icon: 'file', handler: () => openDialog('file') },
])
const sortOptions = computed(() => [
  { label: t('app.fileManager.name'), value: 'name' as const },
  { label: t('app.fileManager.size'), value: 'sizeBytes' as const },
  { label: t('app.fileManager.lastModified'), value: 'modifiedAt' as const },
])
const sizeOptions = computed(() =>
  ([32, 48, 64] as const).map((value) => ({ label: t(`fileBrowser.size${value}`), value })),
)
/** 短请求只锁定当前窗口；关闭窗口不会留下异步 UI 回调。 */
async function execute(action: () => Promise<unknown>) {
  if (submitting.value) return
  submitting.value = true
  try {
    return await action()
  } catch (reason) {
    if (!disposed)
      toast.error(reason instanceof Error ? reason.message : t('fileBrowser.operationFailed'))
  } finally {
    if (!disposed) submitting.value = false
  }
}
/** 目录导航成功后由独立模型提交历史与选择变化。 */
function navigate(target: string) {
  openSequence += 1
  closeMenu(false)
  editingAddress.value = false
  void directory.load(target)
}
/** 新窗口固定当前节点，唯一实例不会覆盖其它窗口的目录。 */
function newWindow(target = path.value) {
  windows.openWindowWithPayload(
    'file-manager',
    { nodeId: nodeId.value, path: target },
    { instanceId: `file-manager-${crypto.randomUUID()}` },
  )
}
/** 按最终目标分流链接，但目录导航和编辑器始终保留用户的逻辑路径。 */
function openEntry(entry: FsEntry) {
  if (!entry.capabilities.canOpen || (entry.kind === 'symlink' && submitting.value)) return
  const generation = ++openSequence,
    requestedNode = nodeId.value,
    fromPath = path.value
  if (entry.kind === 'directory') {
    navigate(entry.path)
    return
  }
  if (entry.kind !== 'symlink') {
    windows.openWindowWithPayload('file-editor', { nodeId: requestedNode, path: entry.path })
    return
  }
  const current = () =>
    !disposed &&
    openSequence === generation &&
    nodeId.value === requestedNode &&
    path.value === fromPath
  return execute(async () => {
    const client = fsApi.forNode(requestedNode)
    const result = await client.detail(entry.path)
    if (!current()) return
    if (!result.success || !result.data)
      throw new Error(result.message || t('fileBrowser.operationFailed'))
    const detail = result.data
    if (detail.symlinkError) throw new Error(localizeErrorSummary(detail.symlinkError))
    // 链接可能在点击后被替换，按最新详情判断，不复用列表快照中的类型。
    const targetKind = detail.kind === 'symlink' ? detail.symlinkTargetKind : detail.kind
    const capabilities = detail.symlinkTargetCapabilities || detail.capabilities
    if (targetKind === 'directory') {
      if (!capabilities.canOpen) throw new Error(t('api.errors.FILE_PERMISSION_DENIED'))
      navigate(entry.path)
      return
    }
    if (targetKind !== 'file') throw new Error(t('api.errors.FILE_TYPE_UNSUPPORTED'))
    if (!capabilities.canOpen || !capabilities.canRead)
      throw new Error(t('api.errors.FILE_PERMISSION_DENIED'))
    // 先验证文本目标可读，失效、权限或二进制错误不会留下空白编辑器窗口。
    const document = await client.readFile(entry.path)
    if (!current()) return
    if (!document.success || !document.data)
      throw new Error(document.message || t('fileBrowser.operationFailed'))
    windows.openWindowWithPayload('file-editor', { nodeId: requestedNode, path: entry.path })
  })
}
/** 开启窗口级参数输入，禁止使用全局重复 id 寻找输入框。 */
function openDialog(type: 'file' | 'dir' | 'rename', entry?: FsEntry) {
  closeMenu(false)
  inputName.value = entry?.name || ''
  dialog.value = { type, entry }
}
/** 创建与重命名统一保留权限、版本和后台任务语义。 */
async function confirmDialog() {
  const value = dialog.value,
    name = inputName.value.trim()
  if (!value || !name || name === '.' || name === '..' || name.includes('/') || name.includes('\0'))
    return
  await execute(async () => {
    let ok = false
    if (value.type === 'rename' && value.entry)
      ok = await operations.renamePath(
        value.entry.path,
        fileTarget(fileParent(value.entry.path), name),
        value.entry.revision,
      )
    else if (canCreate.value)
      ok =
        value.type === 'dir'
          ? await operations.mkdir(fileTarget(path.value, name))
          : await operations.createFile(fileTarget(path.value, name))
    if (ok && !disposed) {
      dialog.value = undefined
      if (value.type !== 'rename') void directory.refresh()
    }
  })
}
/** 删除始终确认不可恢复，执行时使用选择快照中的 revision。 */
async function removeSelection() {
  const snapshot = [...chosen.value]
  if (!snapshot.length || submitting.value) return
  if (snapshot.length > 500) return toast.error(t('fileBrowser.tooMany'))
  if (snapshot.some((entry) => !entry.capabilities.canRemove))
    return toast.error(t('fileBrowser.permissionDenied'))
  const accepted = await showConfirmation(
    t('fileBrowser.deleteWarning', { count: snapshot.length }),
    t('app.fileManager.deleteTitle'),
    t('app.fileManager.confirmDelete'),
    t('app.fileManager.cancel'),
    'danger',
  )
  if (!accepted || disposed) return
  await execute(() =>
    operations.runPathTask(
      'remove',
      snapshot.map((entry) => ({ path: entry.path, expectedRevision: entry.revision })),
      true,
    ),
  )
}
/** 内部剪贴板不读取系统剪贴板，文本复制保留浏览器行为。 */
function copy(mode: 'copy' | 'move') {
  try {
    browser.capture(mode, { nodeId: nodeId.value, entries: chosen.value })
  } catch (reason) {
    toast.error((reason as Error).message)
  }
}
/** 粘贴固定当前节点和目录，执行与终态清理由全局 Store 接管。 */
function paste() {
  if (!canCreate.value || !browser.clipboard) return
  void execute(() => browser.paste(nodeId.value, path.value))
}
/** 文件名排序和方向状态在窗口之间保持同步。 */
function sort(field: 'name' | 'sizeBytes' | 'modifiedAt') {
  if (browser.preferences.sortBy === field)
    browser.preferences.sortOrder =
      browser.preferences.sortOrder === 'ascending' ? 'descending' : 'ascending'
  else browser.preferences.sortBy = field
}
/** 对输入区域、窗口对话框与其它活动应用让出快捷键。 */
function keydown(event: KeyboardEvent) {
  if (
    !active.value ||
    event.defaultPrevented ||
    dialog.value ||
    confirmationState.value.visible ||
    menu.value
  )
    return
  const target = event.target instanceof Element ? event.target : null
  const host = root.value?.closest('[data-ui="application-window"]')
  if (target && target !== document.body && host && !host.contains(target)) return
  if (
    target?.closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="combobox"],[role="dialog"]',
    )
  )
    return
  const modifier = event.ctrlKey || event.metaKey,
    key = event.key.toLowerCase()
  if (event.altKey) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      void directory.travel(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      void directory.travel(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      navigate(fileParent(path.value))
    }
    return
  }
  if (modifier && ['c', 'x'].includes(key) && chosen.value.length) {
    event.preventDefault()
    copy(key === 'c' ? 'copy' : 'move')
  } else if (modifier && key === 'v' && browser.clipboard) {
    event.preventDefault()
    paste()
  } else if (modifier && key === 'a') {
    event.preventDefault()
    selected.value = new Set(entries.value.map((entry) => entry.path))
    content.value?.focus()
  } else if (modifier && key === 'n') {
    event.preventDefault()
    newWindow()
  } else if (modifier && key === 'l') {
    event.preventDefault()
    void editAddress()
  } else if (
    event.key === 'F2' &&
    chosen.value.length === 1 &&
    chosen.value[0]!.capabilities.canRename
  ) {
    event.preventDefault()
    openDialog('rename', chosen.value[0])
  } else if (event.key === 'Delete' && chosen.value.length) {
    event.preventDefault()
    void removeSelection()
  } else if (event.key === 'Escape') {
    selected.value = new Set()
    browser.clearCut()
  } else if (event.key === 'F5' || (modifier && key === 'r')) {
    event.preventDefault()
    void directory.refresh()
  }
}
/** 地址栏在面包屑和文本输入之间切换。 */
async function editAddress() {
  address.value = path.value
  editingAddress.value = true
  await nextTick()
  const input = addressElement.value?.querySelector('input')
  input?.focus()
  input?.select()
}
/** 离开地址栏后恢复目录导航展示，不提交尚未确认的输入。 */
function addressBlur(event: FocusEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null))
    editingAddress.value = false
}
/** 退出地址编辑后将焦点恢复到地址栏。 */
async function cancelAddress() {
  editingAddress.value = false
  await nextTick()
  root.value?.querySelector<HTMLElement>('[data-ui="file-address"]')?.focus()
}
/** 所有显示偏好通过同一菜单更新，选择后恢复触发按钮焦点。 */
function setPreference<K extends keyof FileBrowserPreferences>(
  key: K,
  value: FileBrowserPreferences[K],
) {
  browser.preferences[key] = value
  closeMenu()
}
/** 打开菜单后将焦点移入，菜单操作使用当前选择。 */
async function context(entry: FsEntry | undefined, event: MouseEvent) {
  event.preventDefault()
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 210),
    y: Math.max(8, Math.min(event.clientY, window.innerHeight - 350)),
    entry,
    trigger: document.activeElement as HTMLElement,
  }
  await nextTick()
  menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}
/** 工具栏菜单使用明确的业务图标，并复用文件菜单的键盘与焦点处理。 */
async function toolbarMenu(kind: 'create' | 'upload' | 'view', event: MouseEvent) {
  const trigger = event.currentTarget as HTMLElement,
    rect = trigger.getBoundingClientRect()
  menu.value = { x: rect.left, y: rect.bottom + 4, kind, trigger }
  await nextTick()
  menuElement.value?.querySelector<HTMLButtonElement>('button:not(:disabled)')?.focus()
}
/** 菜单动作先固定，再关闭浮层，避免异步执行读取已关闭的菜单状态。 */
function toolbarAction(action: () => void) {
  closeMenu()
  action()
}
/** 关闭菜单并恢复网格焦点。 */
function closeMenu(restore = true) {
  const previous = menu.value?.trigger
  menu.value = undefined
  if (restore && previous?.isConnected) previous.focus()
}
/** 菜单键盘导航不传播为文件操作快捷键。 */
function menuKeys(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.preventDefault()
    closeMenu()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(
    menuElement.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') || [],
  )
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[
    event.key === 'Home'
      ? 0
      : event.key === 'End'
        ? buttons.length - 1
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  ]?.focus()
}
/** 文本路径复制与内部文件剪贴板保持独立。 */
async function copyPath() {
  const target = menu.value?.entry?.path || path.value
  closeMenu()
  try {
    await navigator.clipboard.writeText(target)
  } catch {
    toast.error(t('app.fileManager.copyPathUnsupported'))
  }
}
/** 上传入口选择结果立即交给任务中心，窗口不持有执行回调。 */
function uploadInput(event: Event, folder = false) {
  const input = event.target as HTMLInputElement,
    files = Array.from(input.files || [])
  input.value = ''
  if (!files.length) return
  operations.startUpload(path.value, {
    kind: folder ? 'folder' : 'files',
    displayName: folder ? files[0]!.webkitRelativePath.split('/')[0]! : files[0]!.name,
    files: files.map((file) => ({
      file,
      relativePath: folder ? file.webkitRelativePath : file.name,
    })),
  })
}
/** 内部拖拽仅传递会话内随机标识，外部网页不能伪造文件路径。 */
function dragStart(entry: FsEntry, event: DragEvent) {
  const source = selected.value.has(entry.path) ? chosen.value : [entry]
  selected.value = new Set(source.map((item) => item.path))
  if (source.length > 500) {
    toast.error(t('fileBrowser.tooMany'))
    event.preventDefault()
    interacting.value = false
    return
  }
  browser.drag = {
    nodeId: nodeId.value,
    entries: source.map((item) => ({ ...item })),
    token: crypto.randomUUID(),
  }
  event.dataTransfer?.setData('application/x-veydeck-files', browser.drag.token)
  if (event.dataTransfer) event.dataTransfer.effectAllowed = 'copyMove'
}
/** 预览落点时区分内部拖拽、本机上传与禁止目标。 */
function dragOver(event: DragEvent, entry?: FsEntry, targetDirectory?: string) {
  event.preventDefault()
  const target =
    targetDirectory || (entry?.kind === 'directory' ? entry.path : entry ? undefined : path.value)
  const internal = Array.from(event.dataTransfer?.types || []).includes(
    'application/x-veydeck-files',
  )
  const files = Array.from(event.dataTransfer?.types || []).includes('Files')
  const allowed =
    !!target &&
    (entry ? entry.capabilities.canCreateChild : targetDirectory ? true : canCreate.value) &&
    (internal
      ? !!browser.drag &&
        !validateFileAction(browser.drag.nodeId, nodeId.value, browser.drag.entries, target)
      : files)
  dropPath.value = allowed ? target : undefined
  dropDescription.value = allowed
    ? t(
        internal
          ? event.ctrlKey
            ? 'fileBrowser.dropCopy'
            : 'fileBrowser.dropMove'
          : 'fileBrowser.dropUpload',
      )
    : t('fileBrowser.invalidTarget')
  if (event.dataTransfer)
    event.dataTransfer.dropEffect = allowed
      ? internal && !event.ctrlKey
        ? 'move'
        : 'copy'
      : 'none'
}
/** 在同步事件阶段捕获文件引用和目标，遍历期间不读取当前目录。 */
function drop(event: DragEvent, entry?: FsEntry, targetDirectory?: string) {
  event.preventDefault()
  event.stopPropagation()
  dropPath.value = undefined
  dropDescription.value = ''
  const target =
      targetDirectory ||
      (entry?.kind === 'directory' ? entry.path : entry ? undefined : path.value),
    transfer = event.dataTransfer
  if (!target || !transfer) return
  const internal = transfer.types.includes('application/x-veydeck-files')
  const destinationNode = nodeId.value
  if (internal) {
    const source = browser.drag
    if (!source || transfer.getData('application/x-veydeck-files') !== source.token) return
    const fixed = { nodeId: source.nodeId, entries: [...source.entries] }
    void execute(() =>
      browser.submit(event.ctrlKey ? 'copy' : 'move', fixed, destinationNode, target),
    )
  } else if (transfer.types.includes('Files')) {
    const read = captureDroppedFiles(transfer)
    void execute(() => browser.uploadDrop(destinationNode, target, read))
  }
}
/** 只有真正离开内容区域时清理落点，避免子元素之间移动时闪烁。 */
function dragLeave(event: DragEvent) {
  if (!(event.currentTarget as HTMLElement).contains(event.relatedTarget as Node | null)) {
    dropPath.value = undefined
    dropDescription.value = ''
  }
}
/** 离开拖拽后清理视觉状态和会话引用。 */
function dragEnd() {
  browser.drag = undefined
  dropPath.value = undefined
  dropDescription.value = ''
  interacting.value = false
}
watch(
  () => props.payload,
  (payload) => {
    const nextNode = typeof payload?.nodeId === 'string' ? payload.nodeId : nodeId.value
    const target = typeof payload?.path === 'string' ? payload.path : undefined
    if (nextNode !== nodeId.value) {
      nodeId.value = nextNode
      void directory.initialize(target)
    } else if (target && target !== path.value) navigate(target)
  },
)
watch(
  submitting,
  (busy) => {
    if (props.windowId)
      windows.updateWindowRuntimeState(props.windowId, {
        busy,
        allowsNodeSwitch: false,
        blockLevel: busy ? 'busy' : 'open',
        blockReason: t(busy ? 'app.fileManager.guardBusy' : 'app.fileManager.guardOpen'),
      })
  },
  { immediate: true },
)
onMounted(() => {
  browser.start()
  void directory.initialize(
    typeof props.payload?.path === 'string' ? props.payload.path : undefined,
  )
  unsubscribe = center.subscribe((changedNode, paths) => {
    if (changedNode === nodeId.value && paths.includes(path.value)) void directory.refresh()
  })
  document.addEventListener('keydown', keydown)
})
onUnmounted(() => {
  disposed = true
  unsubscribe?.()
  document.removeEventListener('keydown', keydown)
  if (interacting.value) dragEnd()
})
</script>

<template>
  <div
    ref="root"
    class="file-manager"
    data-page="file-manager"
    data-veydeck-app="file-manager"
    :data-node-id="nodeId"
    :data-loaded-at="loadedAt"
    @dragover.prevent
    @drop.prevent
  >
    <div class="navigation" data-ui="file-manager-navigation">
      <VeyButton
        type="secondary"
        :disabled="historyIndex <= 0"
        :aria-label="t('fileBrowser.back')"
        @click="directory.travel(-1)"
        ><VeyIcon name="arrow-left" :size="16"
      /></VeyButton>
      <VeyButton
        type="secondary"
        :disabled="historyIndex >= history.length - 1"
        :aria-label="t('fileBrowser.forward')"
        @click="directory.travel(1)"
        ><VeyIcon name="arrow-right" :size="16"
      /></VeyButton>
      <VeyButton
        type="secondary"
        :disabled="path === '/'"
        :aria-label="t('fileBrowser.up')"
        @click="navigate(fileParent(path))"
        ><VeyIcon name="chevron-up" :size="16"
      /></VeyButton>
      <div
        class="address"
        data-ui="file-address"
        tabindex="0"
        :aria-label="t('fileBrowser.editAddress')"
        @click="!editingAddress && editAddress()"
        @keydown.enter.self="editAddress"
        @keydown.space.self.prevent="editAddress"
        @focusout="addressBlur"
      >
        <div v-if="editingAddress" ref="addressElement" class="address-input">
          <VeyInput
            v-model="address"
            :glass="false"
            autocomplete="off"
            :aria-label="t('app.fileManager.path')"
            @keydown.enter.stop="navigate(address)"
            @keydown.esc.stop="cancelAddress"
          />
        </div>
        <div v-else class="breadcrumbs">
          <template v-for="(crumb, index) in crumbs" :key="crumb.path">
            <span v-if="index > 1" class="path-separator" aria-hidden="true">/</span>
            <button
              :class="{ 'is-drop-target': dropPath === crumb.path }"
              data-ui="file-breadcrumb"
              @click.stop="navigate(crumb.path)"
              @dragover.prevent.stop="dragOver($event, undefined, crumb.path)"
              @drop.prevent.stop="drop($event, undefined, crumb.path)"
            >
              {{ crumb.name }}
            </button>
          </template>
        </div>
      </div>
    </div>
    <div class="toolbar" data-ui="file-manager-toolbar">
      <VeyButton
        type="secondary"
        :disabled="!canCreate || submitting"
        data-ui="file-create-actions"
        aria-haspopup="menu"
        @click="toolbarMenu('create', $event)"
        ><span class="command-content"
          ><VeyIcon name="plus" :size="16" /><span>{{ t('common.new') }}</span></span
        ></VeyButton
      >
      <VeyButton
        type="secondary"
        :disabled="!canCreate || submitting"
        data-ui="file-upload-actions"
        aria-haspopup="menu"
        @click="toolbarMenu('upload', $event)"
        ><span class="command-content"
          ><VeyIcon name="upload" :size="16" /><span>{{ t('app.fileManager.upload') }}</span></span
        ></VeyButton
      >
      <VeyButton
        type="secondary"
        :disabled="!canCopy || !!browser.pendingTask"
        @click="copy('copy')"
        >{{ t('fileBrowser.copy') }}</VeyButton
      >
      <VeyButton
        type="secondary"
        :disabled="!canCut || !!browser.pendingTask"
        @click="copy('move')"
        >{{ t('fileBrowser.cut') }}</VeyButton
      >
      <VeyButton
        type="secondary"
        data-ui="file-paste"
        :disabled="
          !browser.clipboard ||
          !canCreate ||
          submitting ||
          !!browser.pendingTask ||
          browser.clipboard.nodeId !== nodeId
        "
        @click="paste"
        >{{ t('fileBrowser.paste') }}</VeyButton
      >
      <div class="toolbar-spacer" />
      <VeyButton
        type="secondary"
        data-ui="file-view-menu"
        aria-haspopup="menu"
        :aria-expanded="menu?.kind === 'view'"
        @click="toolbarMenu('view', $event)"
        ><span class="command-content"
          ><span>{{ t('fileBrowser.view') }}</span
          ><VeyIcon name="chevron-down" :size="14" /></span
      ></VeyButton>
    </div>
    <div class="workspace">
      <aside class="locations" data-ui="file-locations">
        <button
          :class="{ 'is-drop-target': dropPath === home }"
          @click="navigate(home)"
          @dragover.prevent.stop="dragOver($event, undefined, home)"
          @drop.prevent.stop="drop($event, undefined, home)"
        >
          <img
            :src="fileIconUrl('nav-home-v01')"
            class="location-icon"
            alt=""
            draggable="false"
            data-ui="file-location-home-icon"
          />{{ t('fileBrowser.home') }}</button
        ><button
          :class="{ 'is-drop-target': dropPath === '/' }"
          @click="navigate('/')"
          @dragover.prevent.stop="dragOver($event, undefined, '/')"
          @drop.prevent.stop="drop($event, undefined, '/')"
        >
          <img
            :src="fileIconUrl('nav-root-v01')"
            class="location-icon"
            alt=""
            draggable="false"
            data-ui="file-location-root-icon"
          />{{ t('fileBrowser.root') }}
        </button>
      </aside>
      <div
        class="files-pane"
        data-ui="file-browser-pane"
        :class="{ 'is-drop-target': dropPath === path }"
        @dragleave="dragLeave"
      >
        <div v-if="error" class="load-error" role="alert" data-ui="file-load-error">
          {{ error
          }}<VeyButton type="secondary" @click="directory.retry()">{{
            t('fileBrowser.retry')
          }}</VeyButton>
        </div>
        <FileBrowserContent
          ref="content"
          :entries="entries"
          :selected="selected"
          :view="browser.preferences.view"
          :icon-size="browser.preferences.iconSize"
          :location="`${nodeId}:${path}`"
          :node-id="nodeId"
          :cut-paths="browser.cutPaths"
          :has-more="hasMore"
          :loading="loading"
          :drop-path="dropPath"
          @select="selected = $event"
          @open="openEntry"
          @more="directory.more"
          @context="context"
          @sort="sort"
          @interaction="interacting = $event"
          @dragstart="dragStart"
          @dragend="dragEnd"
          @dragover="(entry, event) => dragOver(event, entry)"
          @drop="(entry, event) => drop(event, entry)"
        />
        <div v-if="!entries.length && !loading && !error" class="empty-state">
          <VeyEmpty :description="t('fileBrowser.empty')" />
        </div>
      </div>
    </div>
    <div class="status-bar" data-ui="file-status" role="status">
      <span v-if="dropDescription">{{ dropDescription }}</span
      ><span v-else>{{
        t('fileBrowser.status', { total, loaded: entries.length, selected: selected.size })
      }}</span>
    </div>
    <input
      ref="fileInput"
      type="file"
      multiple
      hidden
      data-ui="file-upload-files"
      @change="uploadInput($event)"
    /><input
      ref="folderInput"
      type="file"
      multiple
      webkitdirectory=""
      hidden
      data-ui="file-upload-folder"
      @change="uploadInput($event, true)"
    />
    <AppContextMenu :visible="!!menu" :x="menu?.x || 0" :y="menu?.y || 0" @close="closeMenu()"
      ><div
        ref="menuElement"
        role="menu"
        class="file-menu"
        :style="{ maxHeight: `calc(100vh - ${(menu?.y || 0) + 16}px)` }"
        data-ui="file-context-menu"
        @keydown.stop="menuKeys"
      >
        <template v-if="menu?.kind === 'view'">
          <div role="group" :aria-label="t('fileBrowser.view')">
            <button
              v-for="mode in ['icons', 'details'] as const"
              :key="mode"
              class="context-menu-btn view-setting"
              role="menuitemradio"
              :aria-checked="browser.preferences.view === mode"
              :data-ui="`file-view-${mode}`"
              @click="setPreference('view', mode)"
            >
              <span>{{ t(`fileBrowser.${mode}`) }}</span
              ><VeyIcon v-if="browser.preferences.view === mode" name="success" :size="14" />
            </button>
          </div>
          <div
            v-if="browser.preferences.view === 'icons'"
            role="group"
            :aria-label="t('fileBrowser.iconSize')"
            class="view-group"
          >
            <span class="view-group-label">{{ t('fileBrowser.iconSize') }}</span
            ><button
              v-for="option in sizeOptions"
              :key="option.value"
              class="context-menu-btn view-setting"
              role="menuitemradio"
              :aria-checked="browser.preferences.iconSize === option.value"
              @click="setPreference('iconSize', option.value)"
            >
              <span>{{ option.label }}</span
              ><VeyIcon
                v-if="browser.preferences.iconSize === option.value"
                name="success"
                :size="14"
              />
            </button>
          </div>
          <div role="group" :aria-label="t('fileBrowser.sort')" class="view-group">
            <span class="view-group-label">{{ t('fileBrowser.sort') }}</span
            ><button
              v-for="option in sortOptions"
              :key="option.value"
              class="context-menu-btn view-setting"
              role="menuitemradio"
              :aria-checked="browser.preferences.sortBy === option.value"
              @click="setPreference('sortBy', option.value)"
            >
              <span>{{ option.label }}</span
              ><VeyIcon
                v-if="browser.preferences.sortBy === option.value"
                name="success"
                :size="14"
              />
            </button>
          </div>
          <div role="group" :aria-label="t('fileBrowser.sortDirection')" class="view-group">
            <button
              v-for="order in ['ascending', 'descending'] as const"
              :key="order"
              class="context-menu-btn view-setting"
              role="menuitemradio"
              :aria-checked="browser.preferences.sortOrder === order"
              @click="setPreference('sortOrder', order)"
            >
              <span>{{ t(`fileBrowser.${order}`) }}</span
              ><VeyIcon v-if="browser.preferences.sortOrder === order" name="success" :size="14" />
            </button>
          </div>
          <div class="view-group">
            <button
              class="context-menu-btn view-setting"
              role="menuitemcheckbox"
              :aria-checked="browser.preferences.showHidden"
              @click="setPreference('showHidden', !browser.preferences.showHidden)"
            >
              <span>{{ t('app.fileManager.showHidden') }}</span
              ><VeyIcon v-if="browser.preferences.showHidden" name="success" :size="14" />
            </button>
          </div>
        </template>
        <template v-else-if="menu?.kind"
          ><button
            v-for="action in menu.kind === 'create' ? createActions : uploadActions"
            :key="action.label"
            class="context-menu-btn"
            role="menuitem"
            @click="toolbarAction(action.handler)"
          >
            {{ action.label }}
          </button></template
        >
        <template v-else-if="menu?.entry"
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!menu.entry.capabilities.canOpen"
            @click="
              ($event) => {
                openEntry(menu!.entry!)
                closeMenu(false)
              }
            "
          >
            {{ t('app.fileManager.open') }}</button
          ><button
            v-if="menu.entry.kind === 'directory'"
            class="context-menu-btn"
            role="menuitem"
            @click="
              ($event) => {
                newWindow(menu!.entry!.path)
                closeMenu(false)
              }
            "
          >
            {{ t('fileBrowser.openNewWindow') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!!browser.pendingTask"
            @click="
              ($event) => {
                copy('copy')
                closeMenu()
              }
            "
          >
            {{ t('fileBrowser.copy') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!!browser.pendingTask"
            @click="
              ($event) => {
                copy('move')
                closeMenu()
              }
            "
          >
            {{ t('fileBrowser.cut') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="chosen.length !== 1 || !menu.entry.capabilities.canRename"
            @click="openDialog('rename', menu!.entry)"
          >
            {{ t('app.fileManager.rename') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!menu.entry.capabilities.canDownload || chosen.length !== 1"
            @click="
              () => {
                execute(() =>
                  operations.downloadFile(
                    menu!.entry!.path,
                    menu!.entry!.name,
                    menu!.entry!.revision,
                  ),
                )
                closeMenu()
              }
            "
          >
            {{ t('fileBrowser.download') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            @click="
              ($event) => {
                closeMenu()
                removeSelection()
              }
            "
          >
            {{ t('fileBrowser.delete') }}
          </button></template
        >
        <template v-else
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!canCreate"
            @click="openDialog('dir')"
          >
            {{ t('app.fileManager.newDir') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!canCreate"
            @click="openDialog('file')"
          >
            {{ t('app.fileManager.newFile') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            :disabled="!canCreate || !browser.clipboard || !!browser.pendingTask"
            @click="
              ($event) => {
                paste()
                closeMenu()
              }
            "
          >
            {{ t('fileBrowser.paste') }}</button
          ><button
            class="context-menu-btn"
            role="menuitem"
            @click="
              ($event) => {
                directory.refresh()
                closeMenu()
              }
            "
          >
            {{ t('fileBrowser.refresh') }}
          </button></template
        ><button v-if="!menu?.kind" class="context-menu-btn" role="menuitem" @click="copyPath">
          {{ t('app.fileManager.copyPath') }}
        </button>
      </div></AppContextMenu
    >
    <ApplicationDialog
      :visible="!!dialog"
      :title="
        dialog?.type === 'rename'
          ? t('app.fileManager.rename')
          : dialog?.type === 'dir'
            ? t('app.fileManager.newDir')
            : t('app.fileManager.newFile')
      "
      :close-disabled="submitting"
      initial-focus-selector="input"
      return-focus-selector="[data-ui='file-grid']"
      @close="dialog = undefined"
      ><VeyInput
        v-model="inputName"
        :aria-label="t('app.fileManager.name')"
        @keydown.enter.stop="confirmDialog"
      /><template #footer
        ><VeyButton type="secondary" :disabled="submitting" @click="dialog = undefined">{{
          t('app.fileManager.cancel')
        }}</VeyButton
        ><VeyButton
          type="primary"
          :disabled="!inputName.trim() || submitting"
          @click="confirmDialog"
          >{{ t('fileBrowser.confirm') }}</VeyButton
        ></template
      ></ApplicationDialog
    >
    <ApplicationConfirmationDialog
      v-bind="confirmationState"
      @confirm="handleConfirmationResponse(true)"
      @cancel="handleConfirmationResponse(false)"
    />
  </div>
</template>

<style scoped>
.file-manager {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  color: var(--vdl-text-primary);
  background: var(--vdl-bg-panel);
  font-size: var(--vdl-font-body);
}
.navigation,
.toolbar {
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
  padding: var(--vdl-space-2) var(--vdl-space-3);
  border-bottom: 1px solid var(--vdl-border-subtle);
  flex-shrink: 0;
}
.navigation :deep(.vl-button),
.toolbar :deep(.vl-button) {
  min-height: 28px;
  height: 28px;
  white-space: nowrap;
}
.toolbar {
  flex-wrap: wrap;
}
.toolbar-spacer {
  flex: 1;
}
.address {
  flex: 1;
  min-width: 0;
  border: 1px solid var(--vdl-border-default);
  border-radius: var(--vdl-radius-md);
  height: 32px;
  background: var(--vdl-bg-base);
}
.address-input {
  display: flex;
  height: 100%;
}
.address-input :deep(.vl-input-wrapper) {
  flex: 1;
  min-width: 0;
  height: 100%;
}
.address-input :deep(.vl-input-inner-wrapper) {
  height: 100%;
  border: 0;
  border-radius: inherit;
  background: transparent;
  box-shadow: none;
}
.breadcrumbs {
  display: flex;
  align-items: center;
  height: 100%;
  overflow: auto;
  white-space: nowrap;
}
.breadcrumbs button {
  border: 0;
  background: none;
  color: var(--vdl-text-secondary);
  cursor: pointer;
  padding: 0 var(--vdl-space-1);
  height: 100%;
  font-size: var(--vdl-font-caption);
}
.breadcrumbs button:hover {
  background: var(--vdl-bg-hover);
  color: var(--vdl-primary);
}
.path-separator {
  color: var(--vdl-text-secondary);
  padding: 0;
}
.address:focus-visible,
.address:focus-within {
  outline: none;
  box-shadow: var(--vdl-focus-ring);
}
.address {
  cursor: text;
}
.address-input :deep(.vl-input) {
  height: 100%;
  min-height: 0;
  padding: 0 var(--vdl-space-1);
  background: transparent;
  font-size: var(--vdl-font-caption);
}
.command-content {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--vdl-space-1);
  line-height: 1;
}
.command-content :deep(.vl-icon) {
  display: inline-flex;
  flex-shrink: 0;
}
.file-menu {
  overflow-y: auto;
  min-width: 180px;
}
.view-setting {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--vdl-space-4);
}
.view-group {
  border-top: 1px solid var(--vdl-border-subtle);
  margin-top: var(--vdl-space-1);
  padding-top: var(--vdl-space-1);
}
.view-group-label {
  display: block;
  padding: var(--vdl-space-1) var(--vdl-space-2);
  font-size: var(--vdl-font-caption);
  color: var(--vdl-text-secondary);
}
.workspace {
  flex: 1;
  display: flex;
  min-height: 0;
}
.locations {
  width: 144px;
  flex-shrink: 0;
  border-right: 1px solid var(--vdl-border-subtle);
  padding: var(--vdl-space-3) var(--vdl-space-2);
  background: var(--vdl-bg-muted);
}
.locations button {
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
  width: 100%;
  border: 0;
  background: none;
  color: var(--vdl-text-primary);
  padding: var(--vdl-space-2);
  border-radius: var(--vdl-radius-md);
  cursor: pointer;
  font-size: var(--vdl-font-caption);
}
.locations button:hover {
  background: var(--vdl-bg-hover);
}
.location-icon {
  width: 20px;
  height: 20px;
  object-fit: contain;
  flex-shrink: 0;
}
.files-pane {
  display: flex;
  flex: 1;
  min-width: 0;
  min-height: 0;
  flex-direction: column;
  position: relative;
}
.status-bar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--vdl-space-2);
  padding: var(--vdl-space-2) var(--vdl-space-3);
  border-top: 1px solid var(--vdl-border-subtle);
  font-size: var(--vdl-font-caption);
  color: var(--vdl-text-secondary);
  flex-shrink: 0;
}
.is-drop-target {
  outline: 2px solid var(--vdl-primary);
  outline-offset: -2px;
  background: var(--vdl-bg-active);
}
.load-error {
  padding: var(--vdl-space-2);
  color: var(--vdl-danger);
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
}
.empty-state {
  position: absolute;
  inset: 80px 0 0;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}
@media (max-width: 900px) {
  .locations {
    width: 112px;
  }
  .toolbar {
    gap: var(--vdl-space-1);
  }
  .toolbar :deep(.vl-button) {
    font-size: var(--vdl-font-caption);
    padding: 0 var(--vdl-space-2);
  }
}
</style>
