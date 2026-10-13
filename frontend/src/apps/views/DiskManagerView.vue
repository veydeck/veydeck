<script setup lang="ts">
/**
 * @file DiskManagerView.vue
 * @description 节点级可信 Linux 数据卷管理界面。
 */

import { computed, reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { CreateDiskOperationRequest, DiskPartition, DiskSummary } from '@/api/modules/disks'
import { useDiskManager } from '@/composables/useDiskManager'
import { useNodeStore } from '@/stores/node'
import { useToastStore } from '@/stores/toast'
import { useWindowManagerStore } from '@/stores/window-manager'
import { formatBytes } from '@/utils/units'
import {
  VeyActionMenu,
  VeyAlert,
  VeyButton,
  VeyDescriptions,
  VeyDialog,
  VeyDrawer,
  VeyEmpty,
  VeyFormItem,
  VeyInput,
  VeyLoading,
  VeyTable,
  VeyTag,
} from '@/components/ui'
import type { VeyTableColumn } from '@/components/ui/VeyTable.vue'

const props = defineProps<{
  isMaximized?: boolean
  windowId?: string
  payload?: Record<string, unknown>
}>()

const { t } = useI18n()
const nodeStore = useNodeStore()
const notifications = useToastStore()
const windowStore = useWindowManagerStore()
const targetNodeId =
  typeof props.payload?.nodeId === 'string' && props.payload.nodeId
    ? props.payload.nodeId
    : nodeStore.currentNodeId
const manager = useDiskManager(targetNodeId)

const detailOpen = ref(false)
const operationOpen = ref(false)
const formOpen = ref(false)
const eraseOpen = ref(false)
const formatOpen = ref(false)
const targetDisk = ref<DiskSummary | null>(null)
const targetPartition = ref<DiskPartition | null>(null)
type DiskFormKind =
  | 'createPartition'
  | 'adoptFilesystem'
  | 'adoptMounted'
  | 'mountVolume'
  | 'unmountVolume'
  | 'changeMountLocation'
  | 'removeManagedVolume'
const formKind = ref<DiskFormKind>('createPartition')
const form = reactive({ mountName: '', confirmationText: '' })

const inventory = computed(() => manager.inventory.value)
const disks = computed(() => inventory.value?.disks ?? [])
const busy = computed(() => manager.submitting.value || manager.activeOperation.value)
const nodeName = computed(() => inventory.value?.node.nodeName || targetNodeId)

watch(
  busy,
  (value) => {
    if (!props.windowId) return
    windowStore.updateWindowRuntimeState(props.windowId, {
      busy: value,
      allowsNodeSwitch: false,
      blockLevel: value ? 'busy' : 'open',
      blockReason: value ? t('app.diskManager.guardBusy') : t('app.diskManager.guardOpen'),
    })
  },
  { immediate: true },
)
watch(
  () => manager.operation.value,
  (value) => {
    if (value) operationOpen.value = true
  },
)

const columns = computed<VeyTableColumn[]>(() => [
  {
    prop: 'deviceName',
    label: t('app.diskManager.columns.device'),
    minWidth: 130,
    slot: 'device',
    align: 'center',
  },
  {
    prop: 'sizeBytes',
    label: t('app.diskManager.columns.capacity'),
    width: 120,
    slot: 'size',
    align: 'center',
  },
  {
    prop: 'mediaType',
    label: t('app.diskManager.columns.media'),
    width: 100,
    slot: 'media',
    align: 'center',
  },
  {
    prop: 'topologyStatus',
    label: t('app.diskManager.columns.topology'),
    width: 120,
    slot: 'topology',
    align: 'center',
  },
  {
    prop: 'ownership',
    label: t('app.diskManager.columns.ownership'),
    width: 115,
    slot: 'ownership',
    align: 'center',
  },
  {
    prop: 'protectionReasons',
    label: t('app.diskManager.columns.protection'),
    minWidth: 180,
    slot: 'protection',
  },
  {
    label: t('app.diskManager.columns.actions'),
    width: 150,
    align: 'center',
    fixed: 'right',
    slot: 'actions',
  },
])
const partitionColumns = computed<VeyTableColumn[]>(() => [
  {
    prop: 'deviceName',
    label: t('app.diskManager.detail.partition'),
    minWidth: 120,
    slot: 'device',
    align: 'center',
  },
  {
    prop: 'filesystem',
    label: t('app.diskManager.detail.filesystem'),
    width: 130,
    slot: 'filesystem',
    align: 'center',
  },
  {
    prop: 'sizeBytes',
    label: t('app.diskManager.columns.capacity'),
    width: 110,
    slot: 'size',
    align: 'center',
  },
  {
    prop: 'mounts',
    label: t('app.diskManager.detail.mount'),
    minWidth: 160,
    slot: 'mounts',
    align: 'center',
  },
  {
    prop: 'ownership',
    label: t('app.diskManager.columns.ownership'),
    width: 110,
    slot: 'ownership',
    align: 'center',
  },
  { label: t('app.diskManager.columns.actions'), width: 120, align: 'center', slot: 'actions' },
])

const tagType = (value: string): 'success' | 'warning' | 'danger' | 'info' | 'default' => {
  if (['ready', 'managed', 'succeeded', 'mounted'].includes(value)) return 'success'
  if (['partial', 'external', 'canceled', 'unmounted'].includes(value)) return 'warning'
  if (['unavailable', 'failed', 'system'].includes(value)) return 'danger'
  if (['queued', 'validating', 'preparing', 'applying', 'verifying', 'canceling'].includes(value))
    return 'info'
  return 'default'
}
const label = (scope: string, value: string) => t(`app.diskManager.${scope}.${value}`)
const protectionText = (reasons: string[]) =>
  reasons.length
    ? reasons.map((reason) => label('protection', reason)).join('、')
    : t('app.diskManager.protection.none')

const diskActions = (disk: DiskSummary) => {
  const actions: Array<{ label: string; className?: string; handler: () => void }> = [
    { label: t('app.diskManager.actions.detail'), handler: () => void openDetail(disk) },
  ]
  if (disk.capabilities.canCreatePartition) {
    actions.push({
      label: t('app.diskManager.actions.createPartition'),
      handler: () => openForm('createPartition', disk),
    })
  }
  if (disk.capabilities.canEraseAndCreatePartition) {
    actions.push({
      label: t('app.diskManager.actions.erase'),
      className: 'is-danger',
      handler: () => openErase(disk),
    })
  }
  return actions
}

/** 根据服务端能力生成分区操作，避免前端自行推断可执行动作。 */
const partitionActions = (partition: DiskPartition) => {
  const actions: Array<{ label: string; className?: string; handler: () => void }> = []
  if (partition.capabilities.canFormat) {
    actions.push({
      label: t('app.diskManager.actions.formatPartition'),
      className: 'app-btn-delete',
      handler: () => openFormat(partition),
    })
  }
  if (partition.capabilities.canAdoptFilesystem) {
    actions.push({
      label: t('app.diskManager.actions.adoptFilesystem'),
      handler: () => openPartitionForm('adoptFilesystem', partition),
    })
  }
  if (partition.capabilities.canAdoptMounted) {
    actions.push({
      label: t('app.diskManager.actions.adoptMounted'),
      handler: () => openPartitionForm('adoptMounted', partition),
    })
  }
  if (partition.capabilities.canMount) {
    actions.push({
      label: t('app.diskManager.actions.mountVolume'),
      handler: () => openPartitionForm('mountVolume', partition),
    })
  }
  if (partition.capabilities.canUnmount) {
    actions.push({
      label: t('app.diskManager.actions.unmountVolume'),
      className: 'app-btn-delete',
      handler: () => openPartitionForm('unmountVolume', partition),
    })
  }
  if (partition.capabilities.canChangeMountLocation) {
    actions.push({
      label: t('app.diskManager.actions.changeMountLocation'),
      handler: () => openPartitionForm('changeMountLocation', partition),
    })
  }
  if (partition.capabilities.canRemoveManagedVolume) {
    actions.push({
      label: t('app.diskManager.actions.removeManagedVolume'),
      className: 'app-btn-delete',
      handler: () => openPartitionForm('removeManagedVolume', partition),
    })
  }
  return actions
}

function openPartitionForm(
  kind:
    | 'adoptFilesystem'
    | 'adoptMounted'
    | 'mountVolume'
    | 'unmountVolume'
    | 'changeMountLocation'
    | 'removeManagedVolume',
  partition: DiskPartition,
) {
  const disk = manager.detail.value
  if (disk) openForm(kind, disk, partition)
}

async function openDetail(disk: DiskSummary) {
  detailOpen.value = true
  await manager.loadDetail(disk.diskId)
}
function openForm(kind: DiskFormKind, disk: DiskSummary, partition: DiskPartition | null = null) {
  formKind.value = kind
  targetDisk.value = disk
  targetPartition.value = partition
  form.mountName = partition?.managedVolume?.mountName ?? ''
  formOpen.value = true
}
function openErase(disk: DiskSummary) {
  targetDisk.value = disk
  form.mountName = ''
  form.confirmationText = ''
  eraseOpen.value = true
}
function openFormat(partition: DiskPartition) {
  const disk = manager.detail.value
  if (!disk) return
  targetDisk.value = disk
  targetPartition.value = partition
  form.confirmationText = ''
  formatOpen.value = true
}

async function submitForm() {
  const disk = targetDisk.value
  if (!disk) return
  let request: CreateDiskOperationRequest
  if (formKind.value === 'createPartition') {
    request = {
      kind: 'createPartition',
      diskId: disk.diskId,
      expectedFingerprint: disk.fingerprint,
    }
  } else if (formKind.value === 'adoptFilesystem' && targetPartition.value) {
    request = {
      kind: 'adoptFilesystem',
      diskId: disk.diskId,
      partitionId: targetPartition.value.partitionId,
      expectedFingerprint: disk.fingerprint,
    }
  } else if (formKind.value === 'adoptMounted' && targetPartition.value) {
    request = {
      kind: 'adoptMounted',
      diskId: disk.diskId,
      partitionId: targetPartition.value.partitionId,
      expectedFingerprint: disk.fingerprint,
    }
  } else if (formKind.value === 'mountVolume' && targetPartition.value?.managedVolume) {
    request = {
      kind: 'mountVolume',
      volumeId: targetPartition.value.managedVolume.volumeId,
      mountName: form.mountName,
    }
  } else if (formKind.value === 'unmountVolume' && targetPartition.value?.managedVolume) {
    request = { kind: 'unmountVolume', volumeId: targetPartition.value.managedVolume.volumeId }
  } else if (formKind.value === 'changeMountLocation' && targetPartition.value?.managedVolume) {
    request = {
      kind: 'changeMountLocation',
      volumeId: targetPartition.value.managedVolume.volumeId,
      mountName: form.mountName,
    }
  } else if (formKind.value === 'removeManagedVolume' && targetPartition.value?.managedVolume) {
    request = {
      kind: 'removeManagedVolume',
      volumeId: targetPartition.value.managedVolume.volumeId,
    }
  } else return
  try {
    const value = await manager.submit(request)
    if (value) {
      formOpen.value = false
      notifications.success(t('app.diskManager.messages.operationSubmitted'))
    }
  } catch (error) {
    notifications.error(
      error instanceof Error ? error.message : t('app.diskManager.messages.operationFailed'),
    )
  }
}

async function submitErase() {
  const disk = targetDisk.value
  if (!disk) return
  try {
    const value = await manager.submit({
      kind: 'eraseAndCreatePartition',
      diskId: disk.diskId,
      expectedFingerprint: disk.fingerprint,
      confirmationText: form.confirmationText,
    })
    if (value) {
      eraseOpen.value = false
      notifications.success(t('app.diskManager.messages.operationSubmitted'))
    }
  } catch (error) {
    notifications.error(
      error instanceof Error ? error.message : t('app.diskManager.messages.operationFailed'),
    )
  }
}

async function submitFormat() {
  const disk = targetDisk.value
  const partition = targetPartition.value
  if (!disk || !partition) return
  try {
    const value = await manager.submit({
      kind: 'formatPartition',
      diskId: disk.diskId,
      partitionId: partition.partitionId,
      expectedFingerprint: disk.fingerprint,
      confirmationText: form.confirmationText,
    })
    if (value) {
      formatOpen.value = false
      notifications.success(t('app.diskManager.messages.operationSubmitted'))
    }
  } catch (error) {
    notifications.error(
      error instanceof Error ? error.message : t('app.diskManager.messages.operationFailed'),
    )
  }
}

const detailItems = computed(() => {
  const disk = manager.detail.value
  if (!disk) return []
  return [
    { label: t('app.diskManager.detail.device'), value: `/dev/${disk.deviceName}` },
    { label: t('app.diskManager.detail.capacity'), value: formatBytes(disk.sizeBytes) },
    ...(disk.model ? [{ label: t('app.diskManager.detail.model'), value: disk.model }] : []),
    ...(disk.serial ? [{ label: t('app.diskManager.detail.serial'), value: disk.serial }] : []),
    ...(disk.transport
      ? [{ label: t('app.diskManager.detail.transport'), value: disk.transport }]
      : []),
    {
      label: t('app.diskManager.detail.identity'),
      value: label('identity', disk.identityConfidence),
    },
    { label: t('app.diskManager.detail.fingerprint'), value: disk.fingerprint },
  ]
})
const operationProgress = computed(() => {
  const value = manager.operation.value
  if (!value?.totalSteps) return 0
  return Math.round((value.completedSteps / value.totalSteps) * 100)
})
const formNeedsMountName = computed(() =>
  ['mountVolume', 'changeMountLocation'].includes(formKind.value),
)
const formIsDangerous = computed(() =>
  ['unmountVolume', 'removeManagedVolume'].includes(formKind.value),
)
const formSubmitDisabled = computed(() => {
  if (!formNeedsMountName.value) return false
  if (!form.mountName) return true
  return (
    formKind.value === 'changeMountLocation' &&
    form.mountName.toLowerCase() === targetPartition.value?.managedVolume?.mountName?.toLowerCase()
  )
})
</script>

<template>
  <div class="disk-manager" data-page="disk-manager">
    <div class="toolbar" data-ui="toolbar">
      <div class="toolbar-actions">
        <VeyButton v-if="manager.operation.value" @click="operationOpen = true">
          {{ t('app.diskManager.actions.operation') }}
        </VeyButton>
        <VeyButton :loading="manager.inventoryState.value.refreshing" @click="manager.refresh">
          {{ t('common.refresh') }}
        </VeyButton>
      </div>
    </div>

    <VeyAlert
      v-if="manager.inventoryState.value.warning"
      data-ui="alert"
      type="warning"
      :title="t('app.diskManager.messages.refreshFailed')"
      :description="manager.inventoryState.value.warning"
      show-icon
    />
    <VeyAlert
      v-if="inventory && inventory.status !== 'ready'"
      data-ui="alert"
      :type="inventory.status === 'partial' ? 'warning' : 'error'"
      :title="label('inventoryStatus', inventory.status)"
      :description="t('app.diskManager.messages.failClosed')"
      show-icon
    />
    <VeyAlert
      v-for="warning in inventory?.warnings ?? []"
      :key="warning"
      data-ui="alert"
      type="warning"
      :title="label('warnings', warning)"
      show-icon
    />

    <div class="table-shell" data-ui="table" data-slot="content">
      <VeyTable v-if="disks.length" :data="disks" :columns="columns" row-key="diskId" border>
        <template #device="{ row }: { row: DiskSummary }">
          <strong>/dev/{{ row.deviceName }}</strong>
        </template>
        <template #size="{ row }: { row: DiskSummary }">{{ formatBytes(row.sizeBytes) }}</template>
        <template #media="{ row }: { row: DiskSummary }">{{
          row.mediaType ? label('media', row.mediaType) : ''
        }}</template>
        <template #topology="{ row }: { row: DiskSummary }">
          <VeyTag :type="tagType(row.topologyStatus)">{{
            label('topology', row.topologyStatus)
          }}</VeyTag>
        </template>
        <template #ownership="{ row }: { row: DiskSummary }">
          <VeyTag :type="tagType(row.ownership)">{{ label('ownership', row.ownership) }}</VeyTag>
        </template>
        <template #protection="{ row }: { row: DiskSummary }">
          <span :class="{ muted: row.protectionReasons.length === 0 }">{{
            protectionText(row.protectionReasons)
          }}</span>
        </template>
        <template #actions="{ row }: { row: DiskSummary }">
          <VeyActionMenu
            :actions="diskActions(row)"
            :label="t('app.diskManager.columns.actions')"
          />
        </template>
      </VeyTable>
      <VeyEmpty
        v-else-if="!manager.inventoryState.value.initialLoading"
        :description="manager.inventoryState.value.error || t('app.diskManager.messages.empty')"
      />
      <VeyLoading :loading="manager.inventoryState.value.initialLoading" cover />
    </div>

    <VeyDrawer
      v-model="detailOpen"
      data-ui="detail"
      :title="t('app.diskManager.detail.title')"
      width="900px"
    >
      <div class="detail-content" data-slot="detail">
        <VeyAlert
          v-if="manager.detailState.value.error"
          type="error"
          :title="manager.detailState.value.error"
          show-icon
        />
        <template v-if="manager.detail.value">
          <VeyDescriptions :items="detailItems" :column="2" border />
          <VeyAlert
            v-if="manager.detail.value.references.length"
            type="warning"
            :title="t('app.diskManager.detail.references')"
            :description="manager.detail.value.references.map((item) => item.summary).join('、')"
            show-icon
          />
          <div class="partition-table-shell" data-ui="table" data-slot="content">
            <VeyTable
              :data="manager.detail.value.partitions"
              :columns="partitionColumns"
              row-key="partitionId"
              border
            >
              <template #device="{ row }: { row: DiskPartition }">
                /dev/{{ row.deviceName }}
              </template>
              <template #filesystem="{ row }: { row: DiskPartition }">{{
                row.filesystem.filesystemType || ''
              }}</template>
              <template #size="{ row }: { row: DiskPartition }">{{
                formatBytes(row.sizeBytes)
              }}</template>
              <template #mounts="{ row }: { row: DiskPartition }">{{
                row.mounts.join('、')
              }}</template>
              <template #ownership="{ row }: { row: DiskPartition }">
                <VeyTag :type="tagType(row.ownership)">{{
                  label('ownership', row.ownership)
                }}</VeyTag>
              </template>
              <template #actions="{ row }: { row: DiskPartition }">
                <div class="partition-actions" data-ui="volume-actions">
                  <VeyActionMenu
                    v-if="partitionActions(row).length"
                    :actions="partitionActions(row)"
                    :label="t('app.diskManager.columns.actions')"
                  />
                  <span v-else class="muted">{{ t('app.diskManager.actions.unavailable') }}</span>
                </div>
              </template>
              <template #empty
                ><VeyEmpty :description="t('app.diskManager.detail.noPartitions')"
              /></template>
            </VeyTable>
          </div>
        </template>
        <VeyLoading :loading="manager.detailState.value.initialLoading" cover />
      </div>
    </VeyDrawer>

    <VeyDialog
      :visible="formOpen"
      data-ui="form"
      :title="t(`app.diskManager.form.${formKind}Title`)"
      width="520px"
      @close="formOpen = false"
    >
      <div class="dialog-content" data-slot="content">
        <VeyAlert
          :type="formIsDangerous ? 'warning' : 'info'"
          :title="t(`app.diskManager.form.${formKind}Notice`)"
          show-icon
        />
        <VeyFormItem
          v-if="formNeedsMountName"
          :label="t('app.diskManager.form.mountName')"
          for="disk-mount-name"
          required
        >
          <VeyInput
            id="disk-mount-name"
            v-model="form.mountName"
            name="diskMountName"
            :maxlength="48"
            placeholder="data"
          />
          <span class="field-hint">/mnt/{{ form.mountName || 'data' }}</span>
        </VeyFormItem>
      </div>
      <template #footer>
        <VeyButton @click="formOpen = false">{{ t('common.cancel') }}</VeyButton>
        <VeyButton
          :type="formIsDangerous ? 'danger' : 'primary'"
          :disabled="formSubmitDisabled"
          :loading="manager.submitting.value"
          @click="submitForm"
        >
          {{ t('common.confirm') }}
        </VeyButton>
      </template>
    </VeyDialog>

    <VeyDialog
      :visible="eraseOpen"
      data-ui="form"
      :title="t('app.diskManager.form.eraseTitle')"
      width="560px"
      @close="eraseOpen = false"
    >
      <div class="dialog-content" data-slot="content">
        <VeyAlert type="error" :title="t('app.diskManager.form.eraseNotice')" show-icon />
        <VeyDescriptions
          v-if="targetDisk"
          :items="[
            { label: t('app.diskManager.targetNode'), value: nodeName },
            { label: t('app.diskManager.detail.device'), value: `/dev/${targetDisk.deviceName}` },
            {
              label: t('app.diskManager.detail.capacity'),
              value: formatBytes(targetDisk.sizeBytes),
            },
          ]"
          :column="1"
          border
        />
        <VeyFormItem
          :label="t('app.diskManager.form.confirmation')"
          for="disk-erase-confirmation"
          required
        >
          <VeyInput
            id="disk-erase-confirmation"
            v-model="form.confirmationText"
            name="diskEraseConfirmation"
            :placeholder="targetDisk?.eraseConfirmationText || ''"
            autocomplete="off"
          />
          <span class="confirmation-text">{{ targetDisk?.eraseConfirmationText }}</span>
        </VeyFormItem>
      </div>
      <template #footer>
        <VeyButton @click="eraseOpen = false">{{ t('common.cancel') }}</VeyButton>
        <VeyButton
          type="danger"
          :disabled="form.confirmationText !== targetDisk?.eraseConfirmationText"
          :loading="manager.submitting.value"
          @click="submitErase"
        >
          {{ t('app.diskManager.actions.erase') }}
        </VeyButton>
      </template>
    </VeyDialog>

    <VeyDialog
      :visible="formatOpen"
      data-ui="format-form"
      :title="t('app.diskManager.form.formatPartitionTitle')"
      width="560px"
      @close="formatOpen = false"
    >
      <div class="dialog-content" data-slot="content">
        <VeyAlert type="error" :title="t('app.diskManager.form.formatPartitionNotice')" show-icon />
        <VeyDescriptions
          v-if="targetDisk && targetPartition"
          :items="[
            { label: t('app.diskManager.targetNode'), value: nodeName },
            {
              label: t('app.diskManager.detail.partition'),
              value: `/dev/${targetPartition.deviceName}`,
            },
            {
              label: t('app.diskManager.detail.capacity'),
              value: formatBytes(targetPartition.sizeBytes),
            },
          ]"
          :column="1"
          border
        />
        <VeyFormItem
          :label="t('app.diskManager.form.confirmation')"
          for="disk-format-confirmation"
          required
        >
          <VeyInput
            id="disk-format-confirmation"
            v-model="form.confirmationText"
            name="diskFormatConfirmation"
            :placeholder="targetPartition?.formatConfirmationText || ''"
            autocomplete="off"
          />
          <span class="confirmation-text">{{ targetPartition?.formatConfirmationText }}</span>
        </VeyFormItem>
      </div>
      <template #footer>
        <VeyButton @click="formatOpen = false">{{ t('common.cancel') }}</VeyButton>
        <VeyButton
          type="danger"
          :disabled="form.confirmationText !== targetPartition?.formatConfirmationText"
          :loading="manager.submitting.value"
          @click="submitFormat"
        >
          {{ t('app.diskManager.actions.formatPartition') }}
        </VeyButton>
      </template>
    </VeyDialog>

    <VeyDrawer
      v-model="operationOpen"
      data-ui="operation"
      :title="t('app.diskManager.operation.title')"
      width="600px"
    >
      <div v-if="manager.operation.value" class="operation-content" data-slot="content">
        <VeyTag :type="tagType(manager.operation.value.status)">
          {{ label('operationStatus', manager.operation.value.status) }}
        </VeyTag>
        <VeyDescriptions
          :items="[
            {
              label: t('app.diskManager.operation.kind'),
              value: label('operationKind', manager.operation.value.kind),
            },
            { label: t('app.diskManager.operation.progress'), value: `${operationProgress}%` },
            ...(manager.operation.value.target.deviceName
              ? [
                  {
                    label: t('app.diskManager.detail.device'),
                    value: `/dev/${manager.operation.value.target.deviceName}`,
                  },
                ]
              : []),
            ...(manager.operation.value.target.mountPath
              ? [
                  {
                    label: t('app.diskManager.detail.mount'),
                    value: manager.operation.value.target.mountPath,
                  },
                ]
              : []),
          ]"
          :column="1"
          border
        />
        <VeyAlert
          v-if="manager.operation.value.errorSummary"
          type="error"
          :title="
            manager.operation.value.errorCode || t('app.diskManager.messages.operationFailed')
          "
          :description="manager.operation.value.errorSummary"
          show-icon
        />
        <VeyAlert
          v-if="manager.operation.value.warningSummary || manager.operationState.value.warning"
          type="warning"
          :title="manager.operation.value.warningSummary || manager.operationState.value.warning"
          show-icon
        />
        <VeyButton
          v-if="manager.operation.value.capabilities.canCancel"
          type="danger"
          :loading="manager.cancelling.value"
          @click="manager.cancel"
        >
          {{ t('app.diskManager.actions.cancel') }}
        </VeyButton>
      </div>
      <VeyEmpty v-else :description="t('app.diskManager.operation.empty')" />
    </VeyDrawer>
  </div>
</template>

<style scoped>
.disk-manager {
  height: 100%;
  min-height: 0;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
  padding: var(--vdl-space-3);
  overflow: hidden;
  background: var(--vdl-bg-canvas);
}
.toolbar,
.toolbar-actions {
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
}
.toolbar {
  justify-content: flex-end;
  flex-wrap: wrap;
}
.field-hint,
.muted {
  color: var(--vdl-text-secondary);
}
.table-shell,
.detail-content,
.operation-content {
  position: relative;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
}
.table-shell {
  flex: 1;
  overflow: auto;
}
.detail-content {
  height: 100%;
  min-height: 0;
}
.partition-table-shell {
  flex: 1 1 0;
  width: 100%;
  min-height: 0;
  overflow: hidden;
}
.partition-actions {
  display: flex;
  justify-content: center;
  align-items: center;
}
.dialog-content {
  display: flex;
  flex-direction: column;
  gap: var(--vdl-space-3);
}
.confirmation-text {
  display: block;
  margin-top: var(--vdl-space-2);
  padding: var(--vdl-space-2);
  overflow-wrap: anywhere;
  font-family: var(--vdl-font-mono);
  color: var(--vdl-text-primary);
  background: var(--vdl-bg-sunken);
  border: 1px solid var(--vdl-border-default);
  border-radius: var(--vdl-radius-sm);
}
@media (max-width: 720px) {
  .disk-manager {
    padding: var(--vdl-space-2);
  }
}
</style>
