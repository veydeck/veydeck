<script setup lang="ts">
/**
 * @file TerminalView.vue
 * @description 终端会话标签工作区，汇总各标签的窗口运行状态。
 */
import { computed, nextTick, ref, shallowReactive, watch } from 'vue'
import type { ComponentPublicInstance } from 'vue'
import { useI18n } from 'vue-i18n'
import { useWindowManagerStore } from '@/stores/window-manager'
import { VeyButton, VeyTooltip } from '@/components/ui'
import TerminalSessionPane from './TerminalSessionPane.vue'

const props = defineProps<{
  windowId?: string
  payload?: Record<string, unknown>
}>()

const { t } = useI18n()
const windowStore = useWindowManagerStore()
const nodeId = typeof props.payload?.nodeId === 'string' && props.payload.nodeId ? props.payload.nodeId : 'local'
const nodeName = typeof props.payload?.nodeName === 'string' && props.payload.nodeName ? props.payload.nodeName : nodeId
const tabs = ref([{ id: 1, number: 1, nodeId, nodeName }])
const activeId = ref(1)
let nextId = 2
const panes = shallowReactive<Record<number, InstanceType<typeof TerminalSessionPane>>>({})
const hasActiveSession = computed(() => tabs.value.some((tab) => panes[tab.id]?.hasActiveSession))

/** 登记标签实例，以汇总标签状态。 */
const registerPane = (id: number, instance: Element | ComponentPublicInstance | null) => {
  if (instance) panes[id] = instance as InstanceType<typeof TerminalSessionPane>
  else delete panes[id]
}

/** 新建当前节点的独立会话，并复用最小可用显示序号。 */
const addSession = () => {
  const id = nextId++
  let number = 1
  while (tabs.value.some((tab) => tab.number === number)) number += 1
  tabs.value.push({ id, number, nodeId, nodeName })
  activeId.value = id
}

/** 关闭标签并释放会话；最后一个标签关闭后等待用户新建。 */
const closeSession = (id: number) => {
  const index = tabs.value.findIndex((tab) => tab.id === id)
  if (index < 0) return
  tabs.value.splice(index, 1)
  if (tabs.value.length > 0 && activeId.value === id) activeId.value = tabs.value[Math.min(index, tabs.value.length - 1)]!.id
}

/** 提供标签栏的方向键、Home 与 End 导航。 */
const navigateTabs = async (event: KeyboardEvent, id: number) => {
  const index = tabs.value.findIndex((tab) => tab.id === id)
  let nextIndex: number
  if (event.key === 'ArrowRight') nextIndex = (index + 1) % tabs.value.length
  else if (event.key === 'ArrowLeft') nextIndex = (index + tabs.value.length - 1) % tabs.value.length
  else if (event.key === 'Home') nextIndex = 0
  else if (event.key === 'End') nextIndex = tabs.value.length - 1
  else return
  event.preventDefault()
  activeId.value = tabs.value[nextIndex]!.id
  const tablist = (event.currentTarget as HTMLElement).closest('[role="tablist"]')
  await nextTick()
  tablist?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')?.focus()
}

watch(hasActiveSession, (active) => {
  if (!props.windowId) return
  windowStore.updateWindowRuntimeState(props.windowId, {
    activeSession: active,
    allowsNodeSwitch: false,
    blockLevel: active ? 'active' : 'open',
    blockReason: active ? t('app.terminal.guardActive') : t('app.terminal.guardOpen'),
    blockReasonKey: active ? 'app.terminal.guardActive' : 'app.terminal.guardOpen',
  })
}, { immediate: true })
</script>

<template>
  <div class="terminal-workspace" data-page="terminal" data-ui="terminal-workspace">
    <div v-if="tabs.length > 0" class="terminal-tabbar" data-ui="terminal-tabbar" data-slot="tabbar">
      <div class="terminal-tabs" role="tablist" :aria-label="t('app.terminal.sessionTabs')">
        <div v-for="tab in tabs" :key="tab.id" class="terminal-tab" :class="{ 'is-active': tab.id === activeId }" data-ui="terminal-tab">
          <button
            class="terminal-tab-select"
            role="tab"
            :id="`terminal-tab-${windowId || 'standalone'}-${tab.id}`"
            :aria-controls="`terminal-panel-${windowId || 'standalone'}-${tab.id}`"
            :aria-selected="tab.id === activeId"
            :tabindex="tab.id === activeId ? 0 : -1"
            :title="panes[tab.id]?.statusLabel"
            @click="activeId = tab.id"
            @keydown="navigateTabs($event, tab.id)"
          >
            <span class="terminal-status-dot" :data-status="panes[tab.id]?.statusType" aria-hidden="true"></span>
            <span class="terminal-tab-name">{{ tab.nodeName }} · {{ tab.number }}</span>
            <span class="sr-only" data-ui="terminal-status">{{ panes[tab.id]?.statusLabel }}</span>
          </button>
          <button class="terminal-tab-close" :aria-label="t('app.terminal.closeSession', { name: tab.nodeName })" data-ui="terminal-close-tab" @click="closeSession(tab.id)">×</button>
        </div>
      </div>
      <VeyTooltip :text="t('app.terminal.newSession')" position="bottom">
        <button class="terminal-tab-add" :aria-label="t('app.terminal.newSession')" data-ui="terminal-add-tab" @click="addSession">+</button>
      </VeyTooltip>
    </div>
    <div v-if="tabs.length === 0" class="terminal-empty" data-ui="terminal-empty">
      <VeyButton type="secondary" @click="addSession">{{ t('app.terminal.newSession') }}</VeyButton>
    </div>
    <TerminalSessionPane
      v-for="tab in tabs"
      v-show="tab.id === activeId"
      :key="tab.id"
      :ref="(instance) => registerPane(tab.id, instance)"
      :id="`terminal-panel-${windowId || 'standalone'}-${tab.id}`"
      role="tabpanel"
      :aria-labelledby="`terminal-tab-${windowId || 'standalone'}-${tab.id}`"
      :active="tab.id === activeId"
      :payload="{ nodeId: tab.nodeId, nodeName: tab.nodeName }"
    />
  </div>
</template>

<style scoped>
.terminal-workspace {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--vdl-bg-canvas);
}
.terminal-empty { flex: 1; display: flex; align-items: center; justify-content: center; }
.terminal-tabbar {
  display: flex;
  align-items: stretch;
  min-height: 36px;
  flex-shrink: 0;
  border-bottom: 1px solid var(--vdl-border-subtle);
  background: var(--vdl-bg-muted);
}
.terminal-tabs {
  display: flex;
  min-width: 0;
  overflow-x: auto;
}
.terminal-tab {
  display: flex;
  flex-shrink: 0;
  align-items: center;
  border-right: 1px solid var(--vdl-border-subtle);
  border-bottom: 2px solid transparent;
}
.terminal-tab.is-active {
  background: var(--vdl-bg-canvas);
  border-bottom-color: var(--vdl-border-brand);
}
.terminal-tab-select,
.terminal-tab-close,
.terminal-tab-add {
  border: 0;
  background: transparent;
  color: var(--vdl-text-secondary);
  cursor: pointer;
}
.terminal-tab-select {
  display: flex;
  align-items: center;
  gap: var(--vdl-space-2);
  padding: var(--vdl-space-2) var(--vdl-space-3);
  font: inherit;
  font-size: var(--vdl-font-body-sm);
}
.is-active .terminal-tab-select { color: var(--vdl-text-primary); }
.terminal-tab-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.terminal-tab-close,
.terminal-tab-add { padding: 0 var(--vdl-space-2); font-size: 18px; }
.terminal-tab-add { height: 100%; min-height: 36px; flex-shrink: 0; }
.terminal-tab-close:hover,
.terminal-tab-add:hover { background: var(--vdl-bg-surface); color: var(--vdl-text-primary); }
.terminal-tab-select:focus-visible,
.terminal-tab-close:focus-visible,
.terminal-tab-add:focus-visible { outline: 2px solid var(--vdl-border-brand); outline-offset: -2px; }
.terminal-status-dot { width: 6px; height: 6px; flex-shrink: 0; border-radius: 50%; background: var(--vdl-text-secondary); }
.terminal-status-dot[data-status='success'] { background: var(--vdl-success); }
.terminal-status-dot[data-status='info'] { background: var(--vdl-info); }
.terminal-status-dot[data-status='warning'] { background: var(--vdl-warning); }
.terminal-status-dot[data-status='danger'] { background: var(--vdl-danger); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; }
</style>
