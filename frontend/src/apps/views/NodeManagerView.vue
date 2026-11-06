<!-- 节点管理视图：卡片摘要、独立详情及节点生命周期操作。 -->
<script setup lang="ts">
import { computed, onMounted, onUnmounted, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { upgradesApi, type UpgradeReleaseRecord } from '@/api/modules/upgrades'
import { DEFAULT_AGENT_PORT } from '@/utils/constants'
import {
  nodesApi,
  type NodeCheckResponse,
  type NodeDetailResponse,
  type NodePrecheckResponse,
} from '@/api/modules/nodes'
import { useNodeStore, type NodeStatus, type NodeSummary } from '@/stores/node'
import { useWindowManagerStore } from '@/stores/window-manager'
import NodeContextMenu from './node-manager/NodeContextMenu.vue'
import {
  VeyButton,
  VeyCard,
  VeyTag,
  VeyInput,
  VeySelect,
  VeyAlert,
  VeyFormItem,
  VeyDescriptions,
  VeyCheckbox,
  VeyLoading,
} from '@/components/ui'
import { useToastStore } from '@/stores/toast'
import { formatDateTime } from '@/utils/time'
import ApplicationDialog from '@/components/layout/ApplicationDialog.vue'
import ApplicationConfirmationDialog from '@/components/layout/ApplicationConfirmationDialog.vue'
import { useApplicationConfirmation } from '@/composables/useApplicationConfirmation'
import NodeProvisionWorkspace, {
  type NodeProvisionPhase,
} from './node-manager/NodeProvisionWorkspace.vue'

const props = defineProps<{
  isMaximized?: boolean
  windowId?: string
  payload?: Record<string, unknown>
}>()

const router = useRouter()
const { t } = useI18n()
const nodeStore = useNodeStore()
const windowStore = useWindowManagerStore()
const toastStore = useToastStore()
const { confirmationState, showConfirmation, handleConfirmationResponse } =
  useApplicationConfirmation()

const nodes = computed(() => nodeStore.nodes)
const currentNodeId = computed(() => nodeStore.currentNodeId)
const activeView = ref<'list' | NodeProvisionPhase>('list')
const isEditActive = ref(false)
const editTarget = ref<NodeSummary | null>(null)
const precheckSubmitting = ref(false)
const editSubmitting = ref(false)
const editDetailLoading = ref(false)
const editError = ref('')
const isCheckDrawerVisible = ref(false)
const checkDetail = ref<NodeCheckResponse | null>(null)
const checkDetailTarget = ref<NodeSummary | null>(null)
const nodeDetailLoading = ref(false)
const selectedNodeDetail = ref<NodeDetailResponse | null>(null)
const precheckResult = ref<NodePrecheckResponse | null>(null)
const pendingDeployPayload = ref<Record<string, unknown> | null>(null)
const deployLogs = ref<string[]>([])
const deployError = ref('')
const deployTarget = ref<NodeSummary | null>(null)
const deployProgressPercent = ref(0)
const deployLaunching = ref(false)
const deployRunning = ref(false)
const deployFinished = ref(false)
let deployPollInterval: number | null = null
let deployOperationId: string | null = null
const hasDeploySession = computed(
  () => deployLaunching.value || deployRunning.value || deployFinished.value,
)

const buildNodeSwitchBlockMessage = () => {
  const guard = windowStore.checkBeforeNodeSwitch()
  if (guard.allowed) return ''
  const details = guard.blockers
    .slice(0, 5)
    .map((item) => `${item.title}: ${item.reason}`)
    .join('；')
  const restCount = Math.max(0, guard.blockers.length - 5)
  const restText = restCount > 0 ? t('app.nodes.switchBlockedRest', { count: restCount }) : ''
  return t('app.nodes.switchBlocked', { details, rest: restText })
}

const switchCurrentNode = async (nodeId: string) => {
  if (nodeId === nodeStore.currentNodeId) return
  const guardMessage = buildNodeSwitchBlockMessage()
  if (guardMessage) {
    toastStore.error(guardMessage)
    return
  }
  const result = nodeStore.requestSwitchCurrentNode(nodeId)
  if (!result.switched) {
    toastStore.error(result.reason || t('app.nodes.switchFailed'))
    return
  }
  const targetNode = nodeStore.nodes.find((node) => node.id === nodeId)
  toastStore.success(t('app.nodes.switchSuccess', { name: targetNode?.name || nodeId }))
}
const createFormDefaults = () => ({
  name: '',
  groupId: 'default',
  groupCustom: '',
  description: '',
  addr: '',
  port: '22',
  user: 'root',
  authMode: 'key',
  pwd: '',
  privateKey: '~/.ssh/id_ed25519',
  privateKeyPassphrase: '',
  tags: '',
  installDir: '/opt',
  servicePort: String(DEFAULT_AGENT_PORT),
  veydeckUrl: '',
})
const createForm = reactive(createFormDefaults())
const editForm = reactive({
  name: '',
  groupId: 'default',
  groupCustom: '',
  tags: '',
  description: '',
  addr: '',
  port: '',
  user: 'root',
  authMode: 'key',
  pwd: '',
  privateKey: '~/.ssh/id_ed25519',
  privateKeyPassphrase: '',
  servicePort: '',
  veydeckUrl: '',
})
let originalFormJson = ''
const checkingIds = ref<Set<string>>(new Set())
const deletingIds = ref<Set<string>>(new Set())
const refreshInterval = ref(5000)
const refreshOptions = computed(() => [
  { value: 0, label: t('app.nodes.refresh.off') },
  { value: 5000, label: t('app.nodes.refresh.seconds', { value: 5 }) },
  { value: 10000, label: t('app.nodes.refresh.seconds', { value: 10 }) },
  { value: 30000, label: t('app.nodes.refresh.seconds', { value: 30 }) },
])
const nodeDisplayName = (node: NodeSummary) => {
  if (node.id === 'local') return t('app.nodes.local')
  return node.name
}

const statusLabel = (status: NodeStatus) => {
  switch (status) {
    case 'draft':
      return t('app.nodes.status.draft')
    case 'deploying':
      return t('app.nodes.status.deploying')
    case 'deploy_failed':
      return t('app.nodes.status.deployFailed')
    case 'awaiting_registration':
      return t('app.nodes.status.awaitingRegistration')
    case 'online':
      return t('app.nodes.status.online')
    case 'degraded':
      return t('app.nodes.status.degraded')
    case 'offline':
      return t('app.nodes.status.offline')
    case 'conflict':
      return t('app.nodes.status.conflict')
    case 'retired':
      return t('app.nodes.status.retired')
    default:
      return t('app.nodes.status.unknown')
  }
}

const statusTagType = (status: NodeStatus): 'success' | 'danger' | 'warning' | 'info' => {
  if (status === 'deploying' || status === 'awaiting_registration') return 'warning'
  if (status === 'online') return 'success'
  if (status === 'degraded') return 'warning'
  if (status === 'offline') return 'danger'
  return 'info'
}

const formatBytes = (bytes?: number) => {
  if (bytes === undefined || !Number.isFinite(bytes)) return '--'
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB']
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1)
  const value = bytes / Math.pow(1024, index)
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[index]}`
}

const formatPercent = (value?: number) => {
  if (value === undefined || !Number.isFinite(value)) return '--'
  return `${value.toFixed(1)}%`
}

const resourceLabel = (node: NodeSummary) => {
  if (!['online', 'degraded'].includes(node.status)) return '--'
  const resource = node.metadata?.resource as Record<string, unknown> | undefined
  if (!resource) return 'CPU -- · MEM --'
  const cpu = resource.cpuPercent as number | undefined
  const memUsed = resource.memoryUsedBytes as number | undefined
  const memTotal = resource.memoryTotalBytes as number | undefined
  return `CPU ${formatPercent(cpu)} · MEM ${formatBytes(memUsed)}/${formatBytes(memTotal)}`
}

const checkDetailItems = computed(() => {
  if (!checkDetail.value) return []
  return [
    { key: 'ssh', label: t('app.nodes.check.checks.ssh'), item: checkDetail.value.ssh },
    { key: 'service', label: t('app.nodes.check.checks.service'), item: checkDetail.value.service },
    { key: 'api', label: t('app.nodes.check.checks.api'), item: checkDetail.value.api },
  ]
})

const checkItemDetail = (item: NodeCheckResponse['ssh']) => {
  const base = item.message || ''
  if (item.code === 'service_missing') {
    const hint = t('app.nodes.check.messages.serviceMissingHint')
    return base ? `${base} · ${hint}` : hint
  }
  return base
}

const checkItemTagType = (status: string) => {
  if (status === 'passed') return 'success'
  if (status === 'warning') return 'warning'
  if (status === 'skipped') return 'info'
  return 'danger'
}

const checkItemStatusText = (status: string) => t(`app.nodes.precheck.status.${status}Short`)

const checkStatusLabel = computed(() => {
  const status = (checkDetail.value?.status ?? '').toLowerCase()
  if (status === 'online') return t('app.nodes.check.statusOnline')
  if (status === 'offline') return t('app.nodes.check.statusOffline')
  return t('app.nodes.check.statusUnknown')
})

/** 详情概览只显示有实际意义的版本、分组与最近在线时间。 */
const detailVersion = computed(() => {
  const resource = detailNode.value?.metadata?.resource as Record<string, unknown> | undefined
  const version = selectedNodeDetail.value?.node.metadata?.resource?.version ?? resource?.version
  return typeof version === 'string' && version ? version : t('app.nodes.status.unknown')
})
const detailGroup = computed(() => {
  const group = selectedNodeDetail.value?.node.groupName || detailNode.value?.groupId
  return group && group !== 'default' ? group : ''
})
const detailLastSeen = computed(() => {
  if (!detailNode.value || detailNode.value.status === 'online') return ''
  const lastSeen = selectedNodeDetail.value?.node.lastSeenAt || detailNode.value.lastSeenAt
  return lastSeen ? formatDateTime(lastSeen) : ''
})
const deploymentFailed = computed(() => Boolean(
  selectedNodeDetail.value?.provisioning?.lastDeployResultStatus === 'failed'
  || selectedNodeDetail.value?.provisioning?.lastDeployErrorSummary
  || detailNode.value?.status === 'deploy_failed',
))

/** 将服务端枚举映射为面向用户的文案，未知状态不着色。 */
const detailValueLabel = (kind: 'runtime' | 'method', value?: string) => {
  const values = kind === 'runtime'
    ? ['active', 'expired', 'closed', 'revoked', 'superseded']
    : ['ssh_push', 'ssh_upgrade', 'ssh_repair', 'inventory_create', 'inventory_update']
  return value && values.includes(value)
    ? t(`app.nodes.detail.${kind}.${value}`)
    : t('app.nodes.status.unknown')
}

/** 部署信息使用单列键值展示，不重复输出内部部署任务状态。 */
const nodeDeployDetailItems = computed(() => {
  const provisioning = selectedNodeDetail.value?.provisioning
  if (!provisioning) return []
  const address = provisioning.sshAddr
  const sshTarget = address
    ? `${address.includes(':') && !address.startsWith('[') ? `[${address}]` : address}:${provisioning.sshPort ?? 22}`
    : t('app.nodes.status.unknown')
  return [
    { label: t('app.nodes.detail.deployMethod'), value: detailValueLabel('method', provisioning.deployMethod) },
    { label: t('app.nodes.detail.sshTarget'), value: sshTarget },
    { label: t('app.nodes.detail.installDir'), value: provisioning.installDir || t('app.nodes.status.unknown') },
    { label: t('app.nodes.detail.deployAt'), value: formatDateTime(provisioning.lastDeployAt) },
  ]
})

/** 内部生命周期及完整会话信息仅放在可展开的连接诊断中。 */
const nodeDiagnosticItems = computed(() => {
  const node = selectedNodeDetail.value?.node
  const session = selectedNodeDetail.value?.session
  const items = [
    { label: t('app.nodes.detail.lifecycleStatus'), value: statusLabel((node?.lifecycleStatus || detailNode.value?.lifecycleStatus) as NodeStatus) },
    { label: t('app.nodes.detail.runtimeStatus'), value: detailValueLabel('runtime', node?.runtimeStatus) },
    { label: t('app.nodes.detail.healthStatus'), value: statusLabel(node?.healthStatus as NodeStatus) },
  ]
  if (session) items.push(
    { label: t('app.nodes.detail.sessionId'), value: session.sessionId },
    { label: t('app.nodes.detail.registeredAt'), value: formatDateTime(session.registeredAt) },
    { label: t('app.nodes.detail.lastHeartbeatAt'), value: formatDateTime(session.lastHeartbeatAt) },
    { label: t('app.nodes.detail.leaseExpiresAt'), value: formatDateTime(session.leaseExpiresAt) },
  )
  return items
})

/** 批量升级选中的节点 ID 列表 */
const selectedNodeIds = ref<string[]>([])
const selectionMode = ref(false)

/** 退出批量选择时清理勾选。 */
const exitSelection = () => {
  selectionMode.value = false
  selectedNodeIds.value = []
}

/** 是否展示精细化升级引导 */
const showUpgradeGuide = ref(!!props.payload?.highlightUpgrade)

watch(
  () => props.payload,
  (newPayload) => {
    if (newPayload?.highlightUpgrade) {
      showUpgradeGuide.value = true
    }
  },
  { deep: true },
)

/** 判断节点是否允许独立升级（排除 local 节点，且必须在线） */
const isNodeUpgradable = (node: NodeSummary) => {
  return node.id !== 'local' && node.status === 'online'
}

/** 是否全部在线可升级节点均已选中 */
const isAllSelected = computed(() => {
  const upgradableNodes = nodes.value.filter(isNodeUpgradable)
  if (upgradableNodes.length === 0) return false
  return upgradableNodes.every((n) => selectedNodeIds.value.includes(n.id))
})

/** 全选/全取消 */
const handleSelectAll = (val: boolean) => {
  if (val) {
    const upgradableNodes = nodes.value.filter(isNodeUpgradable)
    selectedNodeIds.value = upgradableNodes.map((n) => n.id)
  } else {
    selectedNodeIds.value = []
  }
}

/** 单选/取消单选 */
const handleSelectChange = (nodeId: string, val: boolean) => {
  if (val) {
    if (!nodes.value.some((node) => node.id === nodeId && isNodeUpgradable(node))) return
    if (!selectedNodeIds.value.includes(nodeId)) {
      selectedNodeIds.value.push(nodeId)
    }
  } else {
    selectedNodeIds.value = selectedNodeIds.value.filter((id) => id !== nodeId)
  }
}

const closeCheckDrawer = () => {
  isCheckDrawerVisible.value = false
}

const detailNodeId = ref<string | null>(null)
const detailNode = computed(() => nodes.value.find((node) => node.id === detailNodeId.value))
const selectedNodeName = computed(() => detailNode.value ? nodeDisplayName(detailNode.value) : '')
const detailError = ref(false)
let detailRequest = 0
let loadingDetailId: string | null = null

/** 关闭详情时使在途请求失效，避免旧响应覆盖后续选择。 */
const closeNodeDetail = () => {
  detailRequest += 1
  loadingDetailId = null
  detailNodeId.value = null
  selectedNodeDetail.value = null
  nodeDetailLoading.value = false
  detailError.value = false
}

/** 仅为当前打开的外部节点请求详情。 */
const loadSelectedNodeDetail = async (silent = false) => {
  const nodeId = detailNodeId.value
  if (!nodeId || nodeId === 'local' || loadingDetailId === nodeId) return
  const request = ++detailRequest
  loadingDetailId = nodeId
  if (!silent) nodeDetailLoading.value = true
  try {
    const res = await nodesApi.detail(nodeId)
    if (request !== detailRequest || detailNodeId.value !== nodeId) return
    selectedNodeDetail.value = res.success && res.data ? res.data : null
    detailError.value = !selectedNodeDetail.value
  } catch {
    if (request === detailRequest) detailError.value = true
  } finally {
    if (request === detailRequest) {
      loadingDetailId = null
      nodeDetailLoading.value = false
    }
  }
}

/** 普通模式查看详情，选择模式仅切换升级勾选。 */
const activateCard = (node: NodeSummary) => {
  menu.value = null
  if (selectionMode.value) {
    if (isNodeUpgradable(node)) handleSelectChange(node.id, !selectedNodeIds.value.includes(node.id))
    return
  }
  closeNodeDetail()
  detailNodeId.value = node.id
  void loadSelectedNodeDetail()
}

const menu = ref<{ nodeId: string; x: number; y: number } | null>(null)
const menuNode = computed(() => nodes.value.find((node) => node.id === menu.value?.nodeId))
const menuActions = computed(() => {
  const node = menuNode.value
  if (!node) return []
  return [{
    label: node.id === currentNodeId.value ? t('app.nodes.current') : t('app.nodes.switchToNode'),
    disabled: node.id === currentNodeId.value || node.status !== 'online',
    handler: () => switchCurrentNode(node.id),
  }, ...(node.id === 'local' ? [] : getNodeActions(node))]
})

/** 右键与键盘菜单入口共享目标，不触发卡片查看或勾选。 */
const openNodeMenu = (event: MouseEvent | KeyboardEvent, node: NodeSummary) => {
  event.preventDefault()
  event.stopPropagation()
  const card = event.currentTarget as HTMLElement
  card.focus()
  const rect = card.getBoundingClientRect()
  menu.value = { nodeId: node.id, x: 'clientX' in event ? event.clientX : rect.left + 16,
    y: 'clientY' in event ? event.clientY : rect.top + 32 }
}

/** 使用键盘查看卡片或打开其上下文菜单。 */
const handleCardKeydown = (event: KeyboardEvent, node: NodeSummary) => {
  if (event.target !== event.currentTarget) return
  if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openNodeMenu(event, node)
  else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    activateCard(node)
  }
}

const fetchNodes = async () => {
  try {
    await nodeStore.refreshNodes()
    await loadSelectedNodeDetail()
  } catch {
    return
  }
}

const isChecking = (id?: string) => {
  if (!id) return false
  return checkingIds.value.has(id)
}

const setChecking = (id: string, active: boolean) => {
  const next = new Set(checkingIds.value)
  if (active) {
    next.add(id)
  } else {
    next.delete(id)
  }
  checkingIds.value = next
}

const isDeleting = (id?: string) => {
  if (!id) return false
  return deletingIds.value.has(id)
}

const setDeleting = (id: string, active: boolean) => {
  const next = new Set(deletingIds.value)
  if (active) {
    next.add(id)
  } else {
    next.delete(id)
  }
  deletingIds.value = next
}

const checkNode = async (node: NodeSummary) => {
  if (!node.id || node.id === 'local') return
  if (isChecking(node.id)) return
  setChecking(node.id, true)
  try {
    const res = await nodesApi.check(node.id)
    if (!res.success) {
      toastStore.error(res.message || t('app.nodes.check.failed'))
      return
    }
    const payload = res.data as NodeCheckResponse | undefined
    if (!payload) {
      toastStore.error(t('app.nodes.check.failed'))
      return
    }
    checkDetail.value = payload
    checkDetailTarget.value = node
    isCheckDrawerVisible.value = true
    await fetchNodes()
  } catch {
    toastStore.error(t('app.nodes.check.failed'))
  } finally {
    setChecking(node.id, false)
  }
}

const startCreate = () => {
  if (hasDeploySession.value) return
  Object.assign(createForm, createFormDefaults())
  activeView.value = 'create'
  isEditActive.value = false
  editTarget.value = null
  precheckResult.value = null
  pendingDeployPayload.value = null
  deployError.value = ''
}

const cancelCreate = () => {
  activeView.value = 'list'
  Object.assign(createForm, createFormDefaults())
  precheckResult.value = null
  pendingDeployPayload.value = null
  deployError.value = ''
}

const returnToCreate = () => {
  precheckResult.value = null
  pendingDeployPayload.value = null
  activeView.value = 'create'
}

const validateCreateForm = () => {
  if (createForm.addr.trim() === '') {
    toastStore.error(t('app.nodes.create.addrRequired'))
    return false
  }
  if (createForm.user.trim() === '') {
    toastStore.error(t('app.nodes.create.userRequired'))
    return false
  }
  if (createForm.authMode === 'password' && createForm.pwd.trim() === '') {
    toastStore.error(t('app.nodes.create.passwordRequired'))
    return false
  }
  if (createForm.authMode === 'key' && createForm.privateKey.trim() === '') {
    toastStore.error(t('app.nodes.create.privateKeyRequired'))
    return false
  }
  if (createForm.veydeckUrl.trim() !== '') {
    try {
      const url = new URL(createForm.veydeckUrl.trim())
      if (url.protocol !== 'https:') {
        toastStore.error(t('app.nodes.create.veydeckUrlHttpsRequired'))
        return false
      }
      if (url.pathname !== '/' || url.search !== '' || url.hash !== '') {
        toastStore.error(t('app.nodes.create.veydeckUrlBaseRequired'))
        return false
      }
    } catch {
      toastStore.error(t('app.nodes.create.veydeckUrlInvalid'))
      return false
    }
  }
  return true
}

const submitCreate = async () => {
  if (precheckSubmitting.value) return
  precheckSubmitting.value = true
  precheckResult.value = null
  deployError.value = ''
  if (!validateCreateForm()) {
    precheckSubmitting.value = false
    return
  }
  const groupId = createForm.groupId === 'custom' ? createForm.groupCustom : createForm.groupId
  const payload = {
    name: createForm.name || undefined,
    groupId: groupId || undefined,
    description: createForm.description || undefined,
    addr: createForm.addr || undefined,
    port: createForm.port || undefined,
    user: createForm.user || undefined,
    authMode: createForm.authMode || undefined,
    pwd: createForm.pwd || undefined,
    privateKey: createForm.privateKey || undefined,
    privateKeyPassphrase: createForm.privateKeyPassphrase || undefined,
    tags: createForm.tags
      ? createForm.tags
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean)
      : undefined,
    installDir: createForm.installDir || undefined,
    servicePort: createForm.servicePort || undefined,
    veydeckUrl: createForm.veydeckUrl.trim() || undefined,
  }
  const precheckPayload = {
    name: createForm.name || undefined,
    addr: createForm.addr || undefined,
    port: createForm.port || undefined,
    user: createForm.user || undefined,
    authMode: createForm.authMode || undefined,
    pwd: createForm.authMode === 'password' ? createForm.pwd || undefined : undefined,
    privateKey: createForm.authMode === 'key' ? createForm.privateKey || undefined : undefined,
    privateKeyPassphrase:
      createForm.authMode === 'key' ? createForm.privateKeyPassphrase || undefined : undefined,
    servicePort: createForm.servicePort || undefined,
    installDir: createForm.installDir || undefined,
    veydeckUrl: createForm.veydeckUrl.trim() || undefined,
  }
  try {
    const res = await nodesApi.precheck(precheckPayload)
    if (!res.success || !res.data) {
      const message = res.message || t('app.nodes.precheck.failed')
      toastStore.error(message)
      precheckSubmitting.value = false
      return
    }
    precheckResult.value = res.data
    pendingDeployPayload.value = res.data.passed ? payload : null
    activeView.value = 'precheck'
    deployLogs.value = []
    deployError.value = ''
    deployTarget.value = {
      id: 'pending',
      name: createForm.name || createForm.addr || '-',
      groupId: undefined,
      address: createForm.addr || '-',
      status: 'unknown',
      tags: [],
    }
    if (!res.data.passed) {
      precheckSubmitting.value = false
      return
    }
  } catch {
    toastStore.error(t('app.nodes.precheck.failed'))
    precheckSubmitting.value = false
    return
  }
  precheckSubmitting.value = false
}

const parseAddress = (address: string) => {
  const trimmed = address.trim()
  const match = trimmed.match(/^(.*):(\d+)$/)
  if (match) {
    return { addr: match[1] ?? '', port: match[2] ?? '' }
  }
  return { addr: trimmed, port: '' }
}

const startEdit = async (node: NodeSummary) => {
  if (!node.id || node.id === 'local') return
  activeView.value = 'list'
  isEditActive.value = true
  editTarget.value = node
  editError.value = ''
  const parsed = parseAddress(node.address)

  // 默认初始占位
  editForm.name = node.name
  if (node.groupId === 'default') {
    editForm.groupId = 'default'
    editForm.groupCustom = ''
  } else {
    editForm.groupId = 'custom'
    editForm.groupCustom = node.groupId || ''
  }
  editForm.tags = node.tags ? node.tags.join(', ') : ''
  editForm.description = node.description || ''
  editForm.addr = parsed.addr
  editForm.port = parsed.port || '22'
  editForm.user = 'root'
  editForm.authMode = 'key'
  editForm.pwd = ''
  editForm.privateKey = ''
  editForm.privateKeyPassphrase = ''
  editForm.servicePort = node.servicePort ?? ''
  editForm.veydeckUrl = ''

  editDetailLoading.value = true
  try {
    await Promise.all([
      (async () => {
        try {
          const res = await nodesApi.detail(node.id)
          if (editTarget.value?.id === node.id && res.success && res.data) {
            const prov = res.data.provisioning
            if (prov) {
              editForm.addr = prov.sshAddr || parsed.addr
              editForm.port = prov.sshPort ? String(prov.sshPort) : parsed.port || '22'
              editForm.user = prov.sshUser || 'root'
              editForm.authMode = prov.sshAuthMode || 'password'
              editForm.servicePort = prov.expectedListenPort
                ? String(prov.expectedListenPort)
                : (node.servicePort ?? '')
              if (prov.sshAuthMode === 'key') {
                editForm.privateKey = '~/.ssh/id_ed25519'
              }
            }
          }
        } catch (err) {
          console.error('Failed to load node detail for editing:', err)
        }
      })(),
      (async () => {
        try {
          const res = await nodesApi.about(node.id)
          if (editTarget.value?.id === node.id && res.success && res.data) {
            editForm.veydeckUrl = res.data.veydeckUrl || ''
          }
        } catch (err) {
          console.error('Failed to load remote node veydeckUrl:', err)
        }
      })(),
    ])
  } finally {
    editDetailLoading.value = false
    if (editTarget.value?.id === node.id) {
      // 在所有异步详情数据填充后，保存表单初始状态快照
      originalFormJson = JSON.stringify(editForm)
    }
  }
}

const cancelEdit = () => {
  editTarget.value = null
  editError.value = ''
  isEditActive.value = false
}

const submitEdit = async () => {
  if (!editTarget.value?.id || editTarget.value.id === 'local') return

  // 检查表单是否有改动。如果没有改动，直接关闭弹窗返回，不发送请求
  if (JSON.stringify(editForm) === originalFormJson) {
    cancelEdit()
    return
  }

  const originalForm = JSON.parse(originalFormJson)
  const isVeydeckUrlChanged = editForm.veydeckUrl !== originalForm.veydeckUrl

  editSubmitting.value = true
  editError.value = ''
  const payload = {
    name: editForm.name || undefined,
    groupId: editForm.groupId === 'custom' ? editForm.groupCustom || 'default' : 'default',
    tags: editForm.tags
      ? editForm.tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean)
      : [],
    description: editForm.description || '',
    addr: editForm.addr || undefined,
    port: editForm.port || undefined,
    user: editForm.user || undefined,
    authMode: editForm.authMode || undefined,
    pwd: editForm.authMode === 'password' ? editForm.pwd || undefined : undefined,
    privateKey: editForm.authMode === 'key' ? editForm.privateKey || undefined : undefined,
    privateKeyPassphrase:
      editForm.authMode === 'key' ? editForm.privateKeyPassphrase || undefined : undefined,
    servicePort: editForm.servicePort || undefined,
    veydeckUrl: isVeydeckUrlChanged ? editForm.veydeckUrl || undefined : undefined,
  }
  try {
    const res = await nodesApi.update(editTarget.value.id, payload)
    if (!res.success) {
      const msg = res.message || t('app.nodes.edit.failed')
      toastStore.error(msg)
      editError.value = msg
      editSubmitting.value = false
      return
    }
  } catch {
    const msg = t('app.nodes.edit.failed')
    toastStore.error(msg)
    editError.value = msg
    editSubmitting.value = false
    return
  }
  editSubmitting.value = false
  cancelEdit()
  await fetchNodes()
}

const handleDeleteAction = async (node: NodeSummary) => {
  if (!node.id || node.id === 'local') return
  const useSimpleMessage = node.status === 'retired' || node.status === 'draft'
  const message = useSimpleMessage
    ? t('app.nodes.delete.confirmMessageSimple', { name: node.name })
    : t('app.nodes.delete.confirmMessage', { name: node.name })
  const confirmed = await showConfirmation(
    message,
    t('app.nodes.delete.confirmTitle'),
    t('app.nodes.delete.confirmAction'),
    t('confirmation.cancel'),
    'danger',
  )
  if (!confirmed) return
  if (isDeleting(node.id)) return
  setDeleting(node.id, true)
  try {
    const res = await nodesApi.remove(node.id)
    if (!res.success) {
      toastStore.error(res.message || t('app.nodes.delete.failed'))
      return
    }
    toastStore.success(t('app.nodes.delete.success'))
    await fetchNodes()
  } catch {
    toastStore.error(t('app.nodes.delete.failed'))
  } finally {
    setDeleting(node.id, false)
  }
}

/**
 * 根据节点的当前生命周期状态，动态计算其可用的操作菜单项。
 *
 * @param node 节点摘要信息
 * @returns 过滤并设置状态后的操作项数组
 */
const getNodeActions = (node: NodeSummary) => {
  const actions = []
  const status = node.status

  // 1. 检测 (Check) - 当节点非草稿、非部署中、且非退役时可用
  const canCheck = !['draft', 'deploying', 'retired'].includes(status)
  if (canCheck) {
    actions.push({
      label: isChecking(node.id) ? t('app.nodes.check.submitting') : t('app.nodes.check.action'),
      handler: () => checkNode(node),
      disabled: isChecking(node.id) || status === 'deploying',
    })
  }

  // 2. 编辑 (Edit) - 非部署中、且非退役状态下可用（已退役节点无法编辑，只能删除重新录入）
  const canEdit = !['deploying', 'retired'].includes(status)
  if (canEdit) {
    actions.push({
      label: t('app.nodes.actions.edit'),
      handler: () => startEdit(node),
    })
  }
  // 3. 修复/部署 (Repair) - 在非退役、非部署中状态下可用
  const canRepair = !['retired', 'deploying'].includes(status)
  if (canRepair) {
    actions.push({
      label: t('app.nodes.actions.repair'),
      handler: () => executeNodeAction(node, 'repair'),
    })
  }

  // 4. 退役 (Retire) - 在非草稿、非部署中、且非退役的状态下可用
  const canRetire = !['draft', 'deploying', 'retired'].includes(status)
  if (canRetire) {
    actions.push({
      label: t('app.nodes.actions.retire'),
      handler: () => executeNodeAction(node, 'retire'),
      class: 'btn-stop',
    })
  }

  // 5. 卸载 (Uninstall) - 在非草稿、非部署中、且非退役的状态下可用
  const canUninstall = !['draft', 'deploying', 'retired'].includes(status)
  if (canUninstall) {
    actions.push({
      label: t('app.nodes.actions.uninstall'),
      handler: () => executeNodeAction(node, 'uninstall'),
      class: 'btn-delete',
    })
  }

  // 6. 删除 (Delete) 只用于清理主控侧记录。在线类节点必须先卸载或退役，
  // 避免远端 agent 继续运行并重新注册，形成孤儿节点或会话冲突。
  const canDelete = [
    'draft',
    'deploy_failed',
    'offline',
    'unknown',
    'conflict',
    'retired',
  ].includes(status)
  if (canDelete) {
    actions.push({
      label: isDeleting(node.id) ? t('app.nodes.delete.submitting') : t('app.nodes.actions.delete'),
      handler: () => handleDeleteAction(node),
      disabled: isDeleting(node.id),
      class: 'btn-delete',
    })
  }

  return actions
}

const startPollingProgress = (nodeId: string) => {
  stopPollingProgress()
  deployPollInterval = window.setInterval(async () => {
    try {
      const res = await nodesApi.getDeployProgress(nodeId)
      if (res.success && res.data) {
        deployLogs.value = res.data.logs ?? []
        deployProgressPercent.value = res.data.progressPercent ?? 0
        if (res.data.isFinished) {
          stopPollingProgress()
          deployRunning.value = false
          deployFinished.value = true
          if (deployOperationId) {
            windowStore.finishGlobalOperation(deployOperationId)
            deployOperationId = null
          }
          if (res.data.error) {
            deployError.value = res.data.error
          } else {
            toastStore.success(
              t('app.nodes.deploy.success', { name: deployTarget.value?.name || '' }),
            )
          }
          void fetchNodes()
        }
      }
    } catch {
      // Ignore poll failures
    }
  }, 1500)
}

const stopPollingProgress = () => {
  if (deployPollInterval) {
    clearInterval(deployPollInterval)
    deployPollInterval = null
  }
}

const startDeploy = async (payload: Record<string, unknown>) => {
  deployLaunching.value = true
  deployRunning.value = false
  deployFinished.value = false
  deployError.value = ''
  deployLogs.value = []
  deployProgressPercent.value = 0
  activeView.value = 'deploy'
  deployTarget.value = {
    id: 'pending',
    name: createForm.name || createForm.addr || '-',
    groupId: undefined,
    address: createForm.addr || '-',
    status: 'unknown',
    tags: [],
  }
  try {
    const res = await nodesApi.deployCreate(payload)
    if (!res.success || !res.data?.node?.nodeId) {
      deployError.value = res.message || t('app.nodes.deploy.failed')
      deployLogs.value = [deployError.value]
      deployFinished.value = true
      return false
    }
    const nodeId = res.data.node.nodeId
    deployLogs.value = res.data.logs ?? []
    deployOperationId = `node-deploy:${nodeId}`
    windowStore.registerGlobalOperation({
      operationId: deployOperationId,
      sourceAppId: 'node-manager',
      title: deployTarget.value?.name
        ? t('app.nodes.deploy.operationTitle', { name: deployTarget.value.name })
        : t('app.nodes.deploy.drawerTitle'),
      cancellable: false,
      reason: t('app.nodes.deploy.operationBusy'),
    })
    deployRunning.value = true
    startPollingProgress(nodeId)
    return true
  } catch {
    deployError.value = t('app.nodes.deploy.failed')
    deployLogs.value = [deployError.value]
    deployFinished.value = true
    return false
  } finally {
    deployLaunching.value = false
  }
}

const showDeployProgress = () => {
  if (deployRunning.value || deployFinished.value) activeView.value = 'deploy'
}

const backgroundDeploy = () => {
  if (deployRunning.value && !deployLaunching.value) activeView.value = 'list'
}

const finishDeploy = () => {
  if (!deployFinished.value) return
  activeView.value = 'list'
  stopPollingProgress()
  deployLogs.value = []
  deployError.value = ''
  deployProgressPercent.value = 0
  deployTarget.value = null
  deployFinished.value = false
  pendingDeployPayload.value = null
  precheckResult.value = null
  Object.assign(createForm, createFormDefaults())
  void fetchNodes()
}

const handleProvisionBack = () => {
  if (activeView.value === 'deploy') {
    if (deployFinished.value) finishDeploy()
    else backgroundDeploy()
    return
  }
  cancelCreate()
}

const confirmDeploy = async () => {
  if (!pendingDeployPayload.value || !precheckResult.value?.passed) return
  isEditActive.value = false
  await startDeploy(pendingDeployPayload.value)
}

const executeNodeAction = async (node: NodeSummary, action: 'repair' | 'retire' | 'uninstall') => {
  const actionLabel = t(`app.nodes.actions.${action}`)
  const isUninstallingCurrentNode = action === 'uninstall' && currentNodeId.value === node.id
  if (isUninstallingCurrentNode) {
    const guardMessage = buildNodeSwitchBlockMessage()
    if (guardMessage) {
      toastStore.error(guardMessage)
      return
    }
  }
  const confirmMessage = isUninstallingCurrentNode
    ? t('app.nodes.actions.confirmCurrentUninstallMessage', { name: node.name })
    : t('app.nodes.actions.confirmMessage', { action: actionLabel, name: node.name })
  const confirmed = await showConfirmation(
    confirmMessage,
    t('app.nodes.actions.confirmTitle'),
    actionLabel,
    t('confirmation.cancel'),
    action === 'repair' ? 'primary' : 'danger',
  )
  if (!confirmed) return

  try {
    let res
    if (action === 'repair') {
      res = await nodesApi.repair(node.id)
    } else if (action === 'retire') {
      res = await nodesApi.retire(node.id)
    } else {
      res = await nodesApi.uninstall(node.id)
    }
    if (!res.success) {
      toastStore.error(res.message || t('app.nodes.actions.failed', { action: actionLabel }))
      return
    }
    if (isUninstallingCurrentNode) {
      const switchResult = nodeStore.requestSwitchCurrentNode('local')
      if (switchResult.switched) {
        toastStore.success(t('app.nodes.actions.currentUninstallSuccess'))
      } else {
        toastStore.error(switchResult.reason || t('app.nodes.switchFailed'))
      }
    } else {
      toastStore.success(t('app.nodes.actions.success', { action: actionLabel }))
    }
    await fetchNodes()
  } catch {
    toastStore.error(t('app.nodes.actions.failed', { action: actionLabel }))
  }
}

watch(
  refreshInterval,
  (value) => {
    nodeStore.startAutoRefresh(value)
  },
  { immediate: true },
)

watch(activeView, () => {
  menu.value = null
  closeNodeDetail()
  exitSelection()
})

watch(() => nodeStore.nodes, () => {
  selectedNodeIds.value = selectedNodeIds.value.filter((id) => nodes.value.some((node) => node.id === id && isNodeUpgradable(node)))
  if (menu.value && !menuNode.value) menu.value = null
  if (detailNodeId.value && !detailNode.value) closeNodeDetail()
  else void loadSelectedNodeDetail(true)
}, { deep: true })

onUnmounted(() => {
  nodeStore.startAutoRefresh(10000)
  stopPollingProgress()
  closeNodeDetail()
})

const isUpgradeDialogOpen = ref(false)
const upgradeSubmitting = ref(false)
const releases = ref<UpgradeReleaseRecord[]>([])
const upgradeForm = reactive({
  targetVersion: '',
  overwriteSameVersion: false,
})

const releaseOptions = computed(() =>
  releases.value.map((r) => ({
    value: r.version,
    label: `${r.version} (${r.channel})`,
  })),
)

const getNodeNameById = (id: string) => {
  const node = nodes.value.find((n) => n.id === id)
  return node ? nodeDisplayName(node) : id
}

const openUpgradeDialog = async () => {
  if (selectedNodeIds.value.length === 0) return
  upgradeForm.targetVersion = ''
  upgradeForm.overwriteSameVersion = false
  isUpgradeDialogOpen.value = true
  try {
    const res = await upgradesApi.listReleases()
    if (res.success && res.data) {
      releases.value = res.data.filter((r) => r.upgradeEligible)
    }
  } catch (err) {
    console.error('Failed to load releases', err)
    toastStore.error(t('app.nodes.upgradeDialog.noReleases'))
  }
}

const submitUpgradePlan = async () => {
  if (!upgradeForm.targetVersion || selectedNodeIds.value.length === 0) return
  upgradeSubmitting.value = true
  try {
    const payload = {
      targetVersion: upgradeForm.targetVersion,
      nodeIds: selectedNodeIds.value,
      overwriteSameVersion: upgradeForm.overwriteSameVersion,
    }
    const createResponse = await upgradesApi.createPlan(payload)
    if (!createResponse.success || !createResponse.data) {
      toastStore.error(createResponse.message || t('app.nodes.upgradeDialog.createPlanFailed'))
      return
    }
    const startResponse = await upgradesApi.startPlan(createResponse.data.plan.planId)
    if (!startResponse.success || !startResponse.data) {
      toastStore.error(startResponse.message || t('app.nodes.upgradeDialog.startPlanFailed'))
      return
    }

    exitSelection()
    isUpgradeDialogOpen.value = false

    // 缓存升级状态并跳转
    window.sessionStorage.setItem('veydeck.activeUpgradePlanId', startResponse.data.plan.planId)
    window.sessionStorage.setItem(
      'veydeck.activeUpgradePlanDetail',
      JSON.stringify(startResponse.data),
    )

    toastStore.success(t('app.nodes.upgradeDialog.startPlanSuccess') || '升级任务已成功启动')
    router.push({ path: '/upgrade-progress', query: { planId: startResponse.data.plan.planId } })
  } catch (err) {
    console.error('Failed to submit upgrade plan', err)
    toastStore.error(t('app.nodes.upgradeDialog.startPlanFailed'))
  } finally {
    upgradeSubmitting.value = false
  }
}

const nodeManagerBusy = computed(
  () =>
    precheckSubmitting.value ||
    deployLaunching.value ||
    deployRunning.value ||
    editSubmitting.value ||
    upgradeSubmitting.value,
)

watch(
  nodeManagerBusy,
  (busy) => {
    if (!props.windowId) return
    windowStore.updateWindowRuntimeState(props.windowId, {
      busy,
      allowsNodeSwitch: !busy,
      blockLevel: busy ? 'busy' : 'open',
      blockReason: busy ? t('app.nodes.guardBusy') : t('app.nodes.guardOpen'),
    })
  },
  { immediate: true },
)

onMounted(() => {
  fetchNodes()
})
</script>

<template>
  <div class="node-manager" data-page="node-manager" data-veydeck-app="nodes">
    <!-- 升级引导 Alert 提示条 -->
    <VeyAlert
      v-if="showUpgradeGuide && activeView === 'list'"
      :title="t('app.nodes.upgradeGuideTitle')"
      type="info"
      closeable
      style="margin-bottom: 12px"
      @close="showUpgradeGuide = false"
    >
      {{ t('app.nodes.upgradeGuideDesc') }}
    </VeyAlert>

    <VeyCard v-if="activeView === 'list'" shadow="never" class="toolbar-card">
      <div class="toolbar" data-ui="toolbar">
        <div class="toolbar-left">
          <VeyButton
            type="primary"
            :disabled="hasDeploySession"
            data-ui="node-create"
            @click="startCreate"
          >
            {{ t('app.nodes.create.action') }}
          </VeyButton>
          <VeyButton
            v-if="hasDeploySession"
            type="secondary"
            data-ui="node-deploy-resume"
            @click="showDeployProgress"
          >
            {{
              deployFinished ? t('app.nodes.deploy.viewResult') : t('app.nodes.deploy.viewProgress')
            }}
          </VeyButton>
          <VeyButton v-if="!selectionMode" type="secondary" :class="{ 'upgrade-btn-highlight': showUpgradeGuide }" data-ui="node-select-mode" @click="selectionMode = true">
            {{ t('app.nodes.batchUpgrade') }}
          </VeyButton>
          <template v-else>
            <VeyCheckbox :model-value="isAllSelected" :disabled="nodes.filter(isNodeUpgradable).length === 0" data-ui="node-select-all" @change="handleSelectAll">{{ t('app.nodes.selectAll') }}</VeyCheckbox>
            <VeyButton type="primary" :disabled="selectedNodeIds.length === 0" data-ui="node-upgrade-selected" @click="openUpgradeDialog">
              {{ t('app.nodes.upgradeSelected') }} ({{ selectedNodeIds.length }})
            </VeyButton>
            <VeyButton type="secondary" data-ui="node-exit-selection" @click="exitSelection">{{ t('app.nodes.exitSelection') }}</VeyButton>
          </template>
        </div>

        <div class="toolbar-right">
          <VeySelect v-model="refreshInterval" class="refresh-select" style="width: 150px" :options="refreshOptions" />

          <VeyButton @click="fetchNodes">{{ t('app.nodes.refresh.manual') }}</VeyButton>
        </div>
      </div>
    </VeyCard>

    <ApplicationDialog
      :visible="detailNodeId !== null"
      :title="`${t('app.nodes.detail.title')} · ${selectedNodeName}`"
      width="640px"
      data-ui="node-detail-dialog"
      @close="closeNodeDetail"
    >
      <div :key="detailNodeId || 'closed'" class="detail-body node-detail" data-slot="detail">
        <div v-if="detailNode" class="node-overview" data-ui="node-detail-overview">
          <div class="node-overview-line">
            <VeyTag :type="statusTagType(detailNode.status)">{{ statusLabel(detailNode.status) }}</VeyTag>
            <span class="node-overview-address">{{ detailNode.address || '--' }}</span>
            <span>{{ t('app.nodes.detail.agentVersion') }} {{ detailVersion }}</span>
          </div>
          <div v-if="detailNode.status === 'online' || detailNode.status === 'degraded'" class="node-overview-resource">
            {{ resourceLabel(detailNode) }}
          </div>
          <div v-if="detailLastSeen">{{ t('app.nodes.detail.lastSeenAt') }}: {{ detailLastSeen }}</div>
          <div v-if="detailGroup || detailNode.tags.length" class="node-overview-line">
            <span v-if="detailGroup">{{ t('app.nodes.detail.group') }}: {{ detailGroup }}</span>
            <VeyTag v-for="tag in detailNode.tags" :key="tag">{{ tag }}</VeyTag>
          </div>
          <p v-if="detailNode.description">{{ detailNode.description }}</p>
        </div>
        <VeyAlert v-if="detailError" type="error" :title="t('app.nodes.detailLoadFailed')" />
        <VeyButton v-if="detailError" type="secondary" @click="loadSelectedNodeDetail()">{{ t('common.retry') }}</VeyButton>
        <VeyAlert
          v-if="selectedNodeDetail?.node?.lifecycleStatus === 'conflict'"
          :title="t('app.nodes.detail.conflict')"
          type="error"
          show-icon
        />
        <details
          v-if="selectedNodeDetail?.provisioning"
          :open="deploymentFailed"
          class="node-detail-section"
          data-ui="node-deployment-details"
        >
          <summary>{{ t('app.nodes.detail.deployment') }}</summary>
          <div class="node-detail-section-body">
            <VeyAlert
              v-if="deploymentFailed"
              type="error"
              :title="selectedNodeDetail.provisioning.lastDeployErrorSummary || t('app.nodes.status.deployFailed')"
              show-icon
              data-ui="node-deployment-error"
            />
            <VeyDescriptions :items="nodeDeployDetailItems" :column="1" :glass="false" />
          </div>
        </details>
        <details v-if="selectedNodeDetail" class="node-detail-section" data-ui="node-connection-diagnostics">
          <summary>{{ t('app.nodes.detail.diagnostics') }}</summary>
          <div class="node-detail-section-body">
            <VeyDescriptions :items="nodeDiagnosticItems" :column="1" :glass="false" />
          </div>
        </details>
        <VeyLoading :loading="nodeDetailLoading" cover />
      </div>
    </ApplicationDialog>

    <ApplicationDialog
      :visible="isEditActive"
      :title="t('app.nodes.form.editNode')"
      width="720px"
      :close-on-click-overlay="false"
      :close-disabled="editSubmitting"
      initial-focus-selector="[data-ui='node-edit-name'] input"
      data-ui="node-edit-dialog"
      @close="cancelEdit"
    >
      <form class="node-edit-form" style="position: relative" @submit.prevent>
        <!-- 基础配置 -->
        <div class="form-section">
          <div class="form-section-title">{{ t('app.nodes.sections.basic') }}</div>
          <div class="form-grid-2col">
            <VeyFormItem :label="t('app.nodes.create.name')">
              <VeyInput v-model="editForm.name" data-ui="node-edit-name" />
            </VeyFormItem>
            <VeyFormItem :label="t('app.nodes.create.addr')">
              <VeyInput v-model="editForm.addr" />
            </VeyFormItem>
            <VeyFormItem :label="t('app.nodes.create.port')">
              <VeyInput v-model="editForm.port" />
            </VeyFormItem>
            <VeyFormItem :label="t('app.nodes.create.user')">
              <VeyInput v-model="editForm.user" autocomplete="username" />
            </VeyFormItem>
          </div>
        </div>

        <!-- 认证配置 -->
        <div class="form-section">
          <div class="form-section-title">{{ t('app.nodes.sections.auth') }}</div>
          <div class="form-grid-2col">
            <VeyFormItem :label="t('app.nodes.create.authMode')">
              <VeySelect
                v-model="editForm.authMode"
                :options="[
                  { label: t('app.nodes.create.authPassword'), value: 'password' },
                  { label: t('app.nodes.create.authKey'), value: 'key' },
                ]"
              />
            </VeyFormItem>
            <VeyFormItem
              v-if="editForm.authMode === 'password'"
              :label="t('app.nodes.create.password')"
            >
              <input type="text" autocomplete="username" style="display: none" />
              <VeyInput
                v-model="editForm.pwd"
                type="password"
                showPassword
                autocomplete="new-password"
              />
            </VeyFormItem>
            <VeyFormItem v-else :label="t('app.nodes.create.privateKeyPassphrase')">
              <input type="text" autocomplete="username" style="display: none" />
              <VeyInput
                v-model="editForm.privateKeyPassphrase"
                type="password"
                showPassword
                autocomplete="new-password"
              />
            </VeyFormItem>

            <template v-if="editForm.authMode === 'key'">
              <div class="grid-col-2">
                <VeyFormItem :label="t('app.nodes.create.privateKey')">
                  <VeyInput
                    v-model="editForm.privateKey"
                    :placeholder="t('app.nodes.create.privateKeyPlaceholder')"
                  />
                </VeyFormItem>
              </div>
            </template>
          </div>
        </div>

        <!-- 分组与描述 -->
        <div class="form-section">
          <div class="form-section-title">{{ t('app.nodes.sections.group') }}</div>
          <div class="form-grid-2col">
            <VeyFormItem :label="t('app.nodes.create.groupId')">
              <VeySelect
                v-model="editForm.groupId"
                :options="[
                  { label: t('app.nodes.create.groupDefault'), value: 'default' },
                  { label: t('app.nodes.create.groupCustom'), value: 'custom' },
                ]"
              />
            </VeyFormItem>
            <VeyFormItem
              v-if="editForm.groupId === 'custom'"
              :label="t('app.nodes.create.groupCustomInput')"
            >
              <VeyInput v-model="editForm.groupCustom" />
            </VeyFormItem>
            <VeyFormItem :label="t('app.nodes.create.tags')">
              <VeyInput v-model="editForm.tags" />
            </VeyFormItem>
            <VeyFormItem :label="t('app.nodes.create.description')" class="grid-col-2">
              <VeyInput v-model="editForm.description" />
            </VeyFormItem>
          </div>
        </div>

        <!-- 部署配置 -->
        <div class="form-section">
          <div class="form-section-title">{{ t('app.nodes.sections.install') }}</div>
          <div class="form-grid-2col">
            <VeyFormItem :label="t('app.nodes.create.servicePort')">
              <VeyInput v-model="editForm.servicePort" />
            </VeyFormItem>
            <VeyFormItem :label="t('app.nodes.create.veydeckUrl')">
              <VeyInput
                v-model="editForm.veydeckUrl"
                :placeholder="t('app.nodes.create.veydeckUrlPlaceholder')"
              />
            </VeyFormItem>
          </div>
        </div>

        <VeyAlert v-if="editError" :title="editError" type="error" show-icon />
        <VeyLoading :loading="editDetailLoading" cover />
      </form>

      <template #footer>
        <VeyButton :disabled="editSubmitting" @click="cancelEdit">
          {{ t('app.nodes.edit.cancel') }}
        </VeyButton>
        <VeyButton
          type="primary"
          :loading="editSubmitting"
          :disabled="editDetailLoading"
          @click="submitEdit"
        >
          {{ t('app.nodes.edit.submit') }}
        </VeyButton>
      </template>
    </ApplicationDialog>

    <div v-if="activeView === 'list'" class="node-grid-scroll" data-ui="node-grid">
      <div class="node-grid">
        <VeyCard v-for="node in nodes" :key="node.id" shadow="never" :glass="false"
          :content-style="{ background: 'transparent' }"
          :style="{ backgroundColor: node.id === currentNodeId ? 'color-mix(in srgb, var(--vdl-primary) 5%, var(--vdl-bg-panel))' : 'var(--vdl-bg-panel)' }"
          class="node-card" :class="{ 'is-current': node.id === currentNodeId, 'is-selected': selectedNodeIds.includes(node.id) }"
          role="button" tabindex="0" :aria-label="`${nodeDisplayName(node)} · ${statusLabel(node.status)}${node.id === currentNodeId ? ` · ${t('app.nodes.current')}` : ''}`"
          :aria-pressed="selectionMode ? selectedNodeIds.includes(node.id) : undefined"
          :aria-disabled="selectionMode && !isNodeUpgradable(node) ? true : undefined"
          data-ui="node-card" :data-node-id="node.id" :data-current="node.id === currentNodeId"
          @click="activateCard(node)" @keydown="handleCardKeydown($event, node)" @contextmenu="openNodeMenu($event, node)">
          <div class="node-card-heading">
            <div v-if="selectionMode" @click.stop @keydown.stop>
              <VeyCheckbox :model-value="selectedNodeIds.includes(node.id)" :disabled="!isNodeUpgradable(node)" :aria-label="nodeDisplayName(node)" @change="(value) => handleSelectChange(node.id, value)" />
            </div>
            <strong class="node-card-name">{{ nodeDisplayName(node) }}</strong>
            <VeyTag v-if="node.id === currentNodeId" type="primary" data-ui="node-current">{{ t('app.nodes.current') }}</VeyTag>
          </div>
          <div class="node-card-address">{{ node.address || '--' }}</div>
          <VeyTag :type="statusTagType(node.status)">{{ statusLabel(node.status) }}</VeyTag>
          <div v-if="node.status === 'online' || node.status === 'degraded'" class="resource-text">{{ resourceLabel(node) }}</div>
          <div v-else class="resource-text">{{ t('app.nodes.detail.lastSeenAt') }}: {{ formatDateTime(node.lastSeenAt) }}</div>
        </VeyCard>
      </div>
      <div v-if="nodes.length === 0" class="empty-state">{{ t('app.nodes.messages.empty') }}</div>
    </div>
    <NodeContextMenu v-if="menu && menuNode" :key="menu.nodeId" :x="menu.x" :y="menu.y" :label="nodeDisplayName(menuNode)" :actions="menuActions" @close="menu = null" />

    <ApplicationDialog
      :visible="isCheckDrawerVisible"
      :title="t('app.nodes.check.drawerTitle')"
      width="680px"
      data-ui="node-check-dialog"
      @close="closeCheckDrawer"
    >
      <VeyDescriptions
        :items="[
          { label: t('app.nodes.check.target'), slot: 'target' },
          { label: t('app.nodes.check.statusLabel'), slot: 'status' },
        ]"
        border
        class="drawer-meta"
      >
        <template #target>
          {{ checkDetailTarget?.name ?? '-' }}
        </template>
        <template #status>
          <VeyTag :type="checkDetail?.status?.toLowerCase() === 'online' ? 'success' : 'danger'">
            {{ checkStatusLabel }}
          </VeyTag>
        </template>
      </VeyDescriptions>

      <div class="drawer-list">
        <VeyCard
          v-for="detail in checkDetailItems"
          :key="detail.key"
          shadow="never"
          class="drawer-list-item"
        >
          <template #header>
            <div class="drawer-list-header">
              <span>{{ detail.label }}</span>
              <VeyTag :type="checkItemTagType(detail.item.status)">
                {{ checkItemStatusText(detail.item.status) }}
              </VeyTag>
            </div>
          </template>
          <div class="check-item-detail">{{ checkItemDetail(detail.item) || '-' }}</div>
        </VeyCard>
      </div>

      <template #footer>
        <VeyButton type="primary" @click="closeCheckDrawer">{{
          t('app.nodes.check.close')
        }}</VeyButton>
      </template>
    </ApplicationDialog>

    <NodeProvisionWorkspace
      v-if="activeView !== 'list'"
      :phase="activeView"
      :form="createForm"
      :precheck-result="precheckResult"
      :precheck-submitting="precheckSubmitting"
      :deploy-launching="deployLaunching"
      :deploy-running="deployRunning"
      :deploy-finished="deployFinished"
      :deploy-target-name="deployTarget?.name || ''"
      :deploy-progress-percent="deployProgressPercent"
      :deploy-logs="deployLogs"
      :deploy-error="deployError"
      @back="handleProvisionBack"
      @precheck="submitCreate"
      @edit="returnToCreate"
      @deploy="confirmDeploy"
      @background="backgroundDeploy"
    />

    <!-- 弹窗：精细化升级配置 -->
    <ApplicationDialog
      :visible="isUpgradeDialogOpen"
      :title="t('app.nodes.upgradeDialog.title')"
      width="600px"
      :close-disabled="upgradeSubmitting"
      return-focus-selector="[data-ui='node-upgrade-selected']"
      data-ui="node-upgrade-dialog"
      @close="isUpgradeDialogOpen = false"
    >
      <div class="dialog-detail-content flex-column gap-layout">
        <VeyAlert
          :title="t('app.nodes.upgradeDialog.selectedCount', { count: selectedNodeIds.length })"
          type="info"
          show-icon
        />

        <div
          style="
            max-height: 100px;
            overflow-y: auto;
            display: flex;
            flex-wrap: wrap;
            gap: 6px;
            padding: 4px;
            border: 1px dashed var(--vdl-border-default);
            border-radius: 4px;
          "
        >
          <VeyTag v-for="id in selectedNodeIds" :key="id" type="default">
            {{ getNodeNameById(id) }}
          </VeyTag>
        </div>

        <div class="form-group" style="margin-top: 10px">
          <label style="display: block; margin-bottom: 6px; font-weight: 600">
            {{ t('app.nodes.upgradeDialog.targetVersion') }}
          </label>
          <VeySelect
            v-model="upgradeForm.targetVersion"
            :options="releaseOptions"
            :placeholder="t('app.nodes.upgradeDialog.versionPlaceholder')"
            style="width: 100%"
          />
        </div>

        <div class="form-group" style="margin-top: 10px">
          <VeyCheckbox v-model="upgradeForm.overwriteSameVersion">
            {{ t('app.nodes.upgradeDialog.overwriteSameVersion') }}
          </VeyCheckbox>
          <div class="form-hint">
            {{ t('app.nodes.upgradeDialog.overwriteSameVersionTip') }}
          </div>
        </div>
      </div>

      <template #footer>
        <VeyButton :disabled="upgradeSubmitting" @click="isUpgradeDialogOpen = false">
          {{ t('app.nodes.upgradeDialog.cancel') }}
        </VeyButton>
        <VeyButton
          type="primary"
          :loading="upgradeSubmitting"
          :disabled="!upgradeForm.targetVersion || selectedNodeIds.length === 0"
          @click="submitUpgradePlan"
        >
          {{ t('app.nodes.upgradeDialog.submit') }}
        </VeyButton>
      </template>
    </ApplicationDialog>

    <ApplicationConfirmationDialog
      :visible="confirmationState.visible"
      :title="confirmationState.title"
      :message="confirmationState.message"
      :confirm-text="confirmationState.confirmText"
      :cancel-text="confirmationState.cancelText"
      :type="confirmationState.type"
      dialog-ui="node-confirmation-dialog"
      @confirm="handleConfirmationResponse(true)"
      @cancel="handleConfirmationResponse(false)"
    />
  </div>
</template>

<style scoped>
/* 确保表格最后一列操作栏下拉菜单能够正常弹出越界显示 */
.node-manager {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  gap: var(--vdl-space-3);
  padding: var(--vdl-space-3);
  background: var(--vdl-bg-canvas);
  box-sizing: border-box;
}

.toolbar-card {
  flex-shrink: 0;
  position: relative;
  z-index: 10;
}

.toolbar {
  display: flex;
  justify-content: space-between;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vdl-space-3);
}

.toolbar-right {
  flex: 0 0 auto;
  max-width: 100%;
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  min-width: 0;
  align-items: center;
  gap: var(--vdl-space-2);
}

.refresh-select { width: 150px; }
.node-grid-scroll { flex: 1; min-height: 0; overflow: auto; }
.node-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 260px), 1fr)); gap: var(--vdl-space-3); align-items: start; }
.node-card { min-width: 0; cursor: pointer; border: 1px solid var(--vdl-border-default); border-radius: var(--vdl-radius-md); background: var(--vdl-bg-panel); }
.node-card.is-current { border-color: var(--vdl-border-brand); background: color-mix(in srgb, var(--vdl-primary) 5%, var(--vdl-bg-panel)); }
.node-card.is-selected { outline: 2px dashed var(--vdl-border-brand); outline-offset: -4px; }
.node-card:focus-visible { outline: 2px solid var(--vdl-primary); outline-offset: -2px; }
.node-card-heading { display: flex; align-items: center; gap: var(--vdl-space-2); min-width: 0; margin-bottom: var(--vdl-space-2); }
.node-card-name { min-width: 0; flex: 1; overflow-wrap: anywhere; }
.node-card-address { font-family: var(--vdl-font-mono); font-size: var(--vdl-font-body-sm); overflow-wrap: anywhere; margin-bottom: var(--vdl-space-2); }
.node-card .resource-text { margin-top: var(--vdl-space-3); overflow-wrap: anywhere; }
.node-detail {
  container-type: inline-size;
}

.node-overview {
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
  padding-bottom: var(--vdl-space-4);
  overflow-wrap: anywhere;
}

.node-overview-line {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--vdl-space-2);
}

.node-overview-address {
  font-family: var(--vdl-font-mono);
}

.node-overview-resource {
  color: var(--vdl-text-secondary);
  font-size: var(--vdl-font-body-sm);
}

.node-overview p {
  margin: 0;
}

.node-detail-section {
  border-top: 1px solid var(--vdl-border-subtle);
}

.node-detail-section summary {
  padding: var(--vdl-space-3) 0;
  cursor: pointer;
  font-weight: 500;
}

.node-detail-section summary:focus-visible {
  outline: 2px solid var(--vdl-border-brand);
  outline-offset: -2px;
}

.node-detail-section-body {
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
  padding-bottom: var(--vdl-space-3);
}

.node-detail :deep(.vl-descriptions-content) {
  overflow-wrap: anywhere;
  word-break: normal;
  white-space: normal;
}

@container (max-width: 480px) {
  .node-detail-section-body :deep(.vl-descriptions-item) {
    flex-direction: column;
  }

  .node-detail-section-body :deep(.vl-descriptions-label) {
    width: auto;
    padding: var(--vdl-space-2) 0 var(--vdl-space-1);
    background: transparent;
  }

  .node-detail-section-body :deep(.vl-descriptions-content) {
    padding: 0 0 var(--vdl-space-2);
  }
}

.resource-text {
  color: var(--vdl-text-muted);
  font-size: var(--vdl-font-caption);
}

.tag-list {
  display: flex;
  flex-wrap: wrap;
  gap: var(--vdl-space-1);
}

.form-hint {
  margin-top: var(--vdl-space-1);
  font-size: var(--vdl-font-caption);
  color: var(--vdl-text-muted);
}

.detail-body {
  position: relative;
  min-height: 100px;
}

.drawer-meta {
  margin-bottom: var(--vdl-space-3);
}

.drawer-list {
  display: grid;
  gap: var(--vdl-space-2);
}

.drawer-list-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--vdl-space-2);
}

.check-item-detail {
  font-size: var(--vdl-font-body-sm);
  line-height: 1.5;
}

.empty-state {
  padding: var(--vdl-space-8);
  text-align: center;
  color: var(--vdl-text-muted);
}

.form-section {
  background-color: var(--vdl-bg-card);
  border: 1px solid var(--vdl-border-default);
  border-radius: var(--vdl-radius-md);
  padding: var(--vdl-space-4);
}

.form-section-title {
  font-size: var(--vdl-font-body);
  font-weight: 700;
  color: var(--vdl-text-primary);
  margin-bottom: var(--vdl-space-3);
  padding-left: var(--vdl-space-2);
  border-left: 3px solid var(--vdl-primary);
  line-height: 1.2;
}

.form-grid-2col {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: var(--vdl-space-3) var(--vdl-space-4);
}

.grid-col-2 {
  grid-column: span 2;
}

.toolbar-left {
  display: flex;
  flex-direction: row;
  flex-wrap: wrap;
  min-width: 0;
  gap: var(--vdl-space-3);
  align-items: center;
}

@keyframes pulse-border {
  0% {
    box-shadow: 0 0 0 0 color-mix(in srgb, var(--vdl-primary) 70%, transparent);
  }
  70% {
    box-shadow: 0 0 0 6px transparent;
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
  }
}

.upgrade-btn-highlight {
  animation: pulse-border 1.5s infinite;
  border: 1px solid var(--vdl-primary);
}
</style>
