<script setup lang="ts">
/** 套件详情：节点实例操作与中心不可变版本库。 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  SuiteCatalogItem,
  SuiteInstallTaskResponse,
  SuiteInstanceSummary,
} from '@/api/interface/suites'
import { VeyButton, VeyCheckbox, VeyDescriptions, VeySelect, VeyTag } from '@/components/ui'
import ApplicationDialog from '@/components/layout/ApplicationDialog.vue'
import AppIcon from '@/components/icons/AppIcon.vue'
import SuiteInstallProgress from './SuiteInstallProgress.vue'

const props = defineProps<{
  suite: SuiteCatalogItem | null
  instance?: SuiteInstanceSummary
  task?: SuiteInstallTaskResponse
  statusLabel: string
  statusType: 'primary' | 'success' | 'warning' | 'danger' | 'info' | 'default'
  nodeName: string
  busy: boolean
  nodeUnavailable: boolean
  pollingError?: string
}>()
const emit = defineEmits<{
  close: []
  install: [packageId: string, adoptRetainedData: boolean]
  enable: []
  disable: []
  uninstall: []
  delete: [packageId?: string]
  cancel: [taskId: string]
  retry: [taskId: string]
}>()
const { t } = useI18n()
const packageId = ref<string | number | null>(null)
const adoptRetainedData = ref(false)
watch(
  () => [props.suite?.suiteId, props.nodeName],
  () => {
    packageId.value = null
    adoptRetainedData.value = false
  },
)
watch(
  () => props.suite?.versions,
  (versions) => {
    if (!versions?.some((item) => item.packageId === packageId.value)) packageId.value = null
  },
)
const installedPackage = computed(() =>
  props.suite?.versions.find((item) => item.packageId === props.instance?.packageId),
)
const selectedPackage = computed(() =>
  props.suite?.versions.find((item) => item.packageId === packageId.value),
)
const displayPackage = computed(() => installedPackage.value ?? props.suite)
const options = computed(
  () => props.suite?.versions.map((item) => ({ value: item.packageId, label: item.version })) ?? [],
)
const canInstall = computed(() => !props.instance && !props.task)
const canEnable = computed(
  () =>
    !!props.instance &&
    ['installed', 'disabled', 'error'].includes(props.instance.status) &&
    !props.task,
)
const descriptions = computed(() => [
  { label: t('app.suiteCenter.fields.node'), value: props.nodeName },
  {
    label: t('app.suiteCenter.fields.installedVersion'),
    value: props.instance?.version ?? t('app.suiteCenter.notInstalled'),
  },
  ...(props.instance
    ? [
        { label: t('app.suiteCenter.fields.instanceId'), value: props.instance.instanceId },
        {
          label: t('app.suiteCenter.fields.projectName'),
          value: props.instance.composeProjectName,
        },
      ]
    : []),
])

/** 只有用户明确选择仍存在的版本包后才允许提交安装。 */
function install() {
  if (selectedPackage.value && canInstall.value && !props.busy && !props.nodeUnavailable) {
    emit('install', selectedPackage.value.packageId, adoptRetainedData.value)
  }
}
</script>

<template>
  <ApplicationDialog
    :visible="suite !== null"
    :title="displayPackage?.name || ''"
    width="min(48rem, 100vw)"
    data-ui="suite-detail-dialog"
    :style="{ background: 'var(--vdl-bg-panel)', color: 'var(--vdl-text-primary)' }"
    return-focus-selector=".suite-card__main"
    @close="$emit('close')"
  >
    <div v-if="suite" class="suite-detail" data-slot="suite-detail-content">
      <div class="suite-detail__head">
        <AppIcon
          :name="displayPackage?.icon || suite.icon"
          :size="44"
          :label="displayPackage?.name"
        />
        <div>
          <strong>{{ displayPackage?.name }}</strong>
          <div>{{ suite.suiteId }}</div>
        </div>
        <VeyTag :type="statusType" effect="plain">{{ statusLabel }}</VeyTag>
      </div>
      <p>{{ displayPackage?.summary }}</p>
      <VeyDescriptions :items="descriptions" :column="1" border />
      <div v-if="instance?.lastError" role="alert">{{ instance.lastError }}</div>
      <SuiteInstallProgress
        v-if="task"
        :task="task"
        :error="pollingError"
        @cancel="$emit('cancel', task.taskId)"
        @retry="$emit('retry', task.taskId)"
      />
      <div class="suite-detail__actions" data-ui="suite-instance-actions">
        <VeyButton v-if="canEnable" :disabled="busy || nodeUnavailable" @click="$emit('enable')">{{
          t('app.suiteCenter.actions.enable')
        }}</VeyButton>
        <VeyButton
          v-if="instance?.status === 'enabled'"
          :disabled="busy || !!task || nodeUnavailable"
          @click="$emit('disable')"
          >{{ t('app.suiteCenter.actions.disable') }}</VeyButton
        >
        <VeyButton
          v-if="instance"
          type="danger"
          :disabled="busy || !!task || nodeUnavailable"
          data-ui="suite-uninstall-action"
          @click="$emit('uninstall')"
          >{{ t('app.suiteCenter.actions.uninstall') }}</VeyButton
        >
      </div>
      <div class="suite-detail__library" data-slot="suite-version-library">
        <strong>{{ t('app.suiteCenter.versionLibrary') }}</strong>
        <div
          v-for="item in suite.versions"
          :key="item.packageId"
          class="suite-detail__version"
          :data-slot="item.packageId"
        >
          <span>{{ item.version }}</span>
          <span>{{ t('app.suiteCenter.versionInstances', { count: item.instanceCount }) }}</span>
          <VeyButton
            type="danger"
            :disabled="busy"
            data-ui="suite-delete-version"
            @click="$emit('delete', item.packageId)"
            >{{ t('app.suiteCenter.actions.deletePackage') }}</VeyButton
          >
        </div>
        <div v-if="canInstall" data-ui="suite-install-options" class="suite-detail__install">
          <VeySelect
            v-model="packageId"
            :options="options"
            :placeholder="t('app.suiteCenter.chooseVersion')"
            :aria-label="t('app.suiteCenter.chooseVersion')"
            :disabled="busy || nodeUnavailable"
            data-ui="suite-version-select"
          />
          <VeyCheckbox
            v-model="adoptRetainedData"
            :disabled="busy"
            data-ui="suite-adopt-retained-data"
            >{{ t('app.suiteCenter.adoptRetainedData') }}</VeyCheckbox
          >
          <VeyButton
            type="primary"
            :disabled="!selectedPackage || busy || nodeUnavailable"
            :loading="busy"
            data-ui="suite-install-action"
            @click="install"
            >{{ t('app.suiteCenter.actions.install') }}</VeyButton
          >
        </div>
      </div>
    </div>
    <template #footer>
      <VeyButton
        type="danger"
        :disabled="busy"
        data-ui="suite-delete-all"
        @click="$emit('delete')"
        >{{ t('app.suiteCenter.deleteAllVersions') }}</VeyButton
      >
      <VeyButton type="secondary" @click="$emit('close')">{{ t('common.close') }}</VeyButton>
    </template>
  </ApplicationDialog>
</template>

<style scoped>
.suite-detail {
  display: grid;
  gap: var(--vdl-space-4);
  min-width: 0;
  overflow-wrap: anywhere;
}
.suite-detail__head,
.suite-detail__actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--vdl-space-3);
}
.suite-detail__library {
  display: grid;
  gap: var(--vdl-space-3);
  border-top: 1px solid var(--vdl-border-default);
  padding-top: var(--vdl-space-4);
}
.suite-detail__version {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--vdl-space-3);
}
.suite-detail__install {
  display: grid;
  gap: var(--vdl-space-3);
}
</style>
