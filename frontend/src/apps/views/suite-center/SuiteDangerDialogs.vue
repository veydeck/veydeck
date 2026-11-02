<script setup lang="ts">
import ApplicationDialog from '@/components/layout/ApplicationDialog.vue'
import { ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type {
  SuiteCatalogItem,
  SuiteInstanceSummary,
  SuitePackageOccupant,
} from '@/api/interface/suites'
import { VeyButton, VeyCheckbox } from '@/components/ui'

const props = defineProps<{
  deleteTarget: SuiteCatalogItem | null
  packageVersion?: string
  occupants: SuitePackageOccupant[]
  uninstallSuite: SuiteCatalogItem | null
  uninstallInstance?: SuiteInstanceSummary
  busy: boolean
}>()

defineEmits<{
  closeDelete: []
  confirmDelete: []
  closeUninstall: []
  confirmUninstall: [removeData: boolean]
}>()

const { t } = useI18n()
const removeData = ref(false)

watch(
  () => props.uninstallSuite,
  () => {
    removeData.value = false
  },
)
</script>

<template>
  <ApplicationDialog
    :style="{ background: 'var(--vdl-bg-panel)', color: 'var(--vdl-text-primary)' }"
    :visible="!!deleteTarget"
    :title="t('app.suiteCenter.deleteTitle')"
    width="30rem"
    :close-on-click-overlay="!busy"
    @close="$emit('closeDelete')"
  >
    <div class="danger-dialog" data-ui="suite-delete-confirmation">
      {{
        t(
          packageVersion ? 'app.suiteCenter.deleteVersionConfirm' : 'app.suiteCenter.deleteConfirm',
          { name: deleteTarget?.name, version: packageVersion },
        )
      }}
      <div v-if="occupants.length" role="alert" data-ui="suite-delete-occupants">
        <p>{{ t('app.suiteCenter.packageInUse') }}</p>
        <div v-for="item in occupants" :key="`${item.instanceId}:${item.taskId}`">
          {{ item.nodeId }} · {{ item.version }} · {{ item.instanceId }}
          <span v-if="item.taskId"> · {{ item.taskId }}</span>
        </div>
      </div>
    </div>
    <template #footer>
      <VeyButton type="secondary" :disabled="busy" @click="$emit('closeDelete')">
        {{ t('common.cancel') }}
      </VeyButton>
      <VeyButton type="danger" :loading="busy" @click="$emit('confirmDelete')">
        {{ t('common.delete') }}
      </VeyButton>
    </template>
  </ApplicationDialog>

  <ApplicationDialog
    :style="{ background: 'var(--vdl-bg-panel)', color: 'var(--vdl-text-primary)' }"
    :visible="!!uninstallSuite && !!uninstallInstance"
    :title="t('app.suiteCenter.uninstallTitle')"
    width="32rem"
    :close-on-click-overlay="!busy"
    @close="$emit('closeUninstall')"
  >
    <div class="danger-dialog" data-ui="suite-uninstall-confirmation">
      <p>{{ t('app.suiteCenter.uninstallConfirm', { name: uninstallSuite?.name }) }}</p>
      <VeyCheckbox v-model="removeData" :disabled="busy">
        {{ t('app.suiteCenter.removeData') }}
      </VeyCheckbox>
      <div v-if="removeData" class="danger-dialog__warning" role="alert">
        <strong>{{ t('app.suiteCenter.removeDataSecondWarningTitle') }}</strong>
        <span>{{ t('app.suiteCenter.removeDataWarning') }}</span>
      </div>
    </div>
    <template #footer>
      <VeyButton type="secondary" :disabled="busy" @click="$emit('closeUninstall')">
        {{ t('common.cancel') }}
      </VeyButton>
      <VeyButton
        type="danger"
        :loading="busy"
        data-ui="suite-confirm-uninstall"
        @click="$emit('confirmUninstall', removeData)"
      >
        {{
          removeData
            ? t('app.suiteCenter.uninstallAndRemoveData')
            : t('app.suiteCenter.actions.uninstall')
        }}
      </VeyButton>
    </template>
  </ApplicationDialog>
</template>

<style scoped>
.danger-dialog {
  display: grid;
  gap: var(--vdl-space-4);
  color: var(--vdl-text-secondary);
  font: var(--vdl-font-body);
}

.danger-dialog p {
  margin: 0;
}

.danger-dialog__warning {
  display: grid;
  gap: var(--vdl-space-2);
  padding: var(--vdl-space-3);
  border: 1px solid var(--vdl-danger);
  border-radius: var(--vdl-radius-md);
  color: var(--vdl-danger);
  background: var(--vdl-danger-soft);
}
</style>
