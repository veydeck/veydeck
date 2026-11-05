/** 每个文件窗口独立的目录快照、请求取消和导航历史。 */
import { computed, onBeforeUnmount, ref, watch, type Ref } from 'vue'
import type { FsEntry } from '@/api/interface/fs'
import { fsApi } from '@/api/modules/fs'
import { useFileBrowserStore } from '@/stores/file-browser'
import { normalizeFilePath, fileDirectoryCapabilities } from '@/services/file-browser'
import i18n from '@/i18n'
import { useToastStore } from '@/stores/toast'

/** 将连续分页绑定到固定快照，旧响应不能覆盖新导航。 */
export function useFileDirectory(
  node: Readonly<Ref<string>>,
  interacting: Ref<boolean>,
  onReplace: () => void,
) {
  const browser = useFileBrowserStore()
  const path = ref('/'),
    home = ref('/'),
    entries = ref<FsEntry[]>([]),
    total = ref(0)
  const loading = ref(false),
    error = ref(''),
    canCreate = ref(false),
    loadedAt = ref('')
  const history = ref<string[]>([]),
    historyIndex = ref(-1)
  const stale = ref(false)
  const hasMore = computed(() => !stale.value && entries.value.length < total.value)
  let lastAttempt: { destination: string; append: boolean; historyTarget?: number } | undefined
  let snapshotId: string | undefined,
    page = 0,
    sequence = 0,
    disposed = false
  let controller: AbortController | undefined,
    deferredRefresh = false
  /** 执行新导航或当前快照的下一页；失败保留原有内容。 */
  async function load(destination: string, append = false, historyTarget?: number) {
    if (disposed || (append && (loading.value || !hasMore.value))) return false
    let normalized: string
    try {
      normalized = normalizeFilePath(destination)
    } catch {
      error.value = i18n.global.t('fileBrowser.invalidPath')
      return false
    }
    lastAttempt = { destination: normalized, append, historyTarget }
    if (!append) {
      stale.value = true
      controller?.abort()
      sequence++
    }
    const request = sequence,
      nodeId = node.value,
      nextPage = append ? page + 1 : 1
    controller = new AbortController()
    const currentController = controller
    loading.value = true
    error.value = ''
    try {
      const result = await fsApi.forNode(nodeId).listEntries(
        {
          path: normalized,
          page: nextPage,
          pageSize: 200,
          sortBy: browser.preferences.sortBy,
          sortOrder: browser.preferences.sortOrder,
          showHidden: browser.preferences.showHidden,
          snapshotId: append ? snapshotId : undefined,
        },
        { signal: currentController.signal },
      )
      if (disposed || request !== sequence || nodeId !== node.value) return false
      if (!result.success || !result.data) {
        if (append && result.errorCode === 'FILE_LIST_SNAPSHOT_EXPIRED') {
          deferredRefresh = true
          useToastStore().info(i18n.global.t('fileBrowser.snapshotExpired'))
          error.value = i18n.global.t('fileBrowser.snapshotExpired')
          return false
        }
        throw new Error(result.message || i18n.global.t('fileBrowser.loadFailed'))
      }
      const data = result.data
      if (append && data.snapshotId !== snapshotId)
        throw new Error(i18n.global.t('fileBrowser.snapshotExpired'))
      if (!append) {
        entries.value = data.entries
        path.value = normalized
        onReplace()
        if (historyTarget !== undefined) historyIndex.value = historyTarget
        else if (history.value[historyIndex.value] !== normalized) {
          history.value = history.value.slice(0, historyIndex.value + 1)
          history.value.push(normalized)
          historyIndex.value = history.value.length - 1
        }
        canCreate.value = false
        void fsApi
          .forNode(nodeId)
          .detail(normalized)
          .then((result) => {
            if (!disposed && request === sequence && node.value === nodeId)
              canCreate.value =
                !!result.data && fileDirectoryCapabilities(result.data).canCreateChild
          })
          .catch(() => {})
      } else {
        const seen = new Set(entries.value.map((entry) => entry.path))
        entries.value = [...entries.value, ...data.entries.filter((entry) => !seen.has(entry.path))]
      }
      stale.value = false
      snapshotId = data.snapshotId
      page = nextPage
      total.value = data.total
      loadedAt.value = data.loadedAt
      return true
    } catch (reason) {
      if (!disposed && request === sequence && !currentController.signal.aborted)
        error.value =
          reason instanceof Error ? reason.message : i18n.global.t('fileBrowser.loadFailed')
      return false
    } finally {
      if (request === sequence && !disposed) {
        loading.value = false
        if (deferredRefresh && !interacting.value) {
          deferredRefresh = false
          void load(path.value)
        }
      }
    }
  }
  /** 外部变更在拖拽或框选期间延迟重载。 */
  function refresh() {
    if (interacting.value) {
      deferredRefresh = true
      return Promise.resolve(false)
    }
    return load(path.value)
  }
  /** 返回导航历史中的前后目录，失败时不移动历史指针。 */
  function travel(offset: number) {
    const index = historyIndex.value + offset
    const destination = history.value[index]
    if (destination) return load(destination, false, index)
  }
  /** 初始化或切换固定节点时取消旧请求。 */
  async function initialize(initialPath?: string) {
    const generation = ++sequence
    controller?.abort()
    history.value = []
    historyIndex.value = -1
    entries.value = []
    total.value = 0
    canCreate.value = false
    const nodeId = node.value
    try {
      const result = await fsApi.forNode(nodeId).home()
      if (disposed || generation !== sequence) return
      home.value = result.data?.path || '/'
      await load(initialPath || home.value)
    } catch (reason) {
      if (!disposed && generation === sequence)
        error.value =
          reason instanceof Error ? reason.message : i18n.global.t('fileBrowser.loadFailed')
    }
  }
  watch(interacting, (value) => {
    if (!value && deferredRefresh && !loading.value) {
      deferredRefresh = false
      void refresh()
    }
  })
  watch(
    () => [
      browser.preferences.sortBy,
      browser.preferences.sortOrder,
      browser.preferences.showHidden,
    ],
    () => {
      void refresh()
    },
  )
  onBeforeUnmount(() => {
    disposed = true
    sequence++
    controller?.abort()
  })
  return {
    path,
    home,
    entries,
    total,
    loading,
    error,
    canCreate,
    loadedAt,
    hasMore,
    history,
    historyIndex,
    load,
    refresh,
    travel,
    initialize,
    retry: () =>
      lastAttempt
        ? load(lastAttempt.destination, lastAttempt.append, lastAttempt.historyTarget)
        : refresh(),
    more: () => load(path.value, true),
  }
}
