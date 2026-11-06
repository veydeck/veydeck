<script setup lang="ts">
/**
 * @file TerminalSessionPane.vue
 * @description 单个标签的宿主机 PTY 会话，独立管理连接、转录与尺寸。
 */

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import type { TerminalServerMessage } from '@/api/generated'
import { useTerminalSession, type TerminalSessionState } from '@/composables/useTerminalSession'
import { useThemeStore, buildTerminalTheme } from '@/stores/theme'
import { VeyAlert, VeyButton, VeyLoading } from '@/components/ui'
import '@xterm/xterm/css/xterm.css'

const props = defineProps<{
  active: boolean
  payload?: Record<string, unknown>
}>()

const { t } = useI18n()
const themeStore = useThemeStore()
const terminalHost = ref<HTMLDivElement | null>(null)

const targetNodeId =
  typeof props.payload?.nodeId === 'string' && props.payload.nodeId ? props.payload.nodeId : 'local'
const targetNodeName =
  typeof props.payload?.nodeName === 'string' && props.payload.nodeName
    ? props.payload.nodeName
    : targetNodeId

let disposed = false
let xterm: Terminal | null = null
let fitAddon: FitAddon | null = null
let resizeObserver: ResizeObserver | null = null
let resizeFrame: number | null = null

/** 控制事件只更新页面状态，不写入终端转录。 */
const handleControl = (message: TerminalServerMessage) => {
  if (message.kind === 'started') {
    if (props.active) xterm?.focus()
  }
}

const terminalSession = useTerminalSession(targetNodeId, {
  onOutput(bytes) {
    xterm?.write(bytes)
  },
  onControl: handleControl,
})

const {
  access,
  accessState,
  sessionState,
  sessionError,
  exitResult,
  idleWarningSeconds,
  canConnect,
  checkAccess,
  connect,
  writeInput,
  resize,
} = terminalSession

const activeStates: TerminalSessionState[] = [
  'connecting',
  'starting',
  'active',
  'idleWarning',
  'closing',
]
const hasActiveSession = computed(() => activeStates.includes(sessionState.value))

const visibleStatus = computed(() => {
  if (accessState.value === 'checking') return 'checking'
  if (accessState.value === 'failed') return 'accessFailed'
  if (accessState.value === 'unavailable') return 'unavailable'
  return sessionState.value
})

const statusLabel = computed(() => t(`app.terminal.status.${visibleStatus.value}`))
const statusType = computed<'default' | 'info' | 'success' | 'warning' | 'danger'>(() => {
  if (['active'].includes(visibleStatus.value)) return 'success'
  if (['connecting', 'starting', 'checking', 'closing'].includes(visibleStatus.value)) return 'info'
  if (['idleWarning', 'unavailable'].includes(visibleStatus.value)) return 'warning'
  if (['failed', 'accessFailed'].includes(visibleStatus.value)) return 'danger'
  return 'default'
})

const sessionErrorText = computed(() =>
  sessionError.value ? t(`app.terminal.errors.${sessionError.value.code}`) : '',
)
const sessionResultText = computed(() => {
  if (!exitResult.value) return ''
  return exitResult.value.exitCode === null
    ? t('app.terminal.sessionEnded')
    : t('app.terminal.sessionEndedWithCode', { code: exitResult.value.exitCode })
})
const inactiveStatusText = computed(
  () => sessionErrorText.value || sessionResultText.value || statusLabel.value,
)
const terminalBackground = computed(
  () => buildTerminalTheme(themeStore.currentTheme)?.background || 'var(--vdl-bg-canvas)',
)
const unavailableText = computed(() => {
  const code = access.value?.unavailableReason
  return code ? t(`app.terminal.errors.${code}`) : t('app.terminal.accessUnavailable')
})

/** 解析 VDL 等宽字体 Token 后交给 Canvas 渲染器。 */
const resolveMonospaceFont = () => {
  const token = getComputedStyle(document.documentElement)
    .getPropertyValue('--vdl-font-mono')
    .trim()
  return token || 'monospace'
}

/** 合并窗口尺寸变化，并忽略隐藏或零尺寸状态。 */
const scheduleFit = () => {
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = null
    const host = terminalHost.value
    if (!host || host.clientWidth === 0 || host.clientHeight === 0 || !fitAddon) return
    try {
      fitAddon.fit()
    } catch {
      // 窗口布局切换期间由下一次 ResizeObserver 回调重新计算。
    }
  })
}

/** 清空旧会话并以当前可见网格创建全新 PTY。 */
const startConnection = async () => {
  if (disposed || !canConnect.value) return
  xterm?.reset()
  xterm?.clear()
  await nextTick()
  if (disposed) return
  const host = terminalHost.value
  if (host && host.clientWidth > 0 && host.clientHeight > 0) fitAddon?.fit()
  connect(xterm?.cols || 80, xterm?.rows || 24)
}

watch(
  () => themeStore.currentTheme,
  (theme) => {
    if (xterm) xterm.options.theme = buildTerminalTheme(theme)
  },
)

/** 访问检查成功后首次连接；重试检查也使用相同入口。 */
const checkAndConnect = async () => {
  await checkAccess()
  if (!disposed) await startConnection()
}

/** 切回标签时恢复网格与键盘焦点，后台标签保留会话。 */
watch(() => props.active, async (active) => {
  if (!active) return
  await nextTick()
  if (disposed) return
  scheduleFit()
  xterm?.focus()
})

defineExpose({
  statusLabel,
  statusType,
  hasActiveSession,
})

onMounted(() => {
  if (!terminalHost.value) return
  xterm = new Terminal({
    cursorBlink: true,
    disableStdin: true,
    fontFamily: resolveMonospaceFont(),
    fontSize: 13,
    scrollback: 5_000,
    theme: buildTerminalTheme(themeStore.currentTheme),
  })
  fitAddon = new FitAddon()
  xterm.loadAddon(fitAddon)
  xterm.open(terminalHost.value)
  xterm.textarea?.setAttribute(
    'aria-label',
    t('app.terminal.terminalLabel', { node: targetNodeName }),
  )
  xterm.onData(writeInput)
  xterm.onResize(({ cols, rows }) => resize(cols, rows))
  resizeObserver = new ResizeObserver(scheduleFit)
  resizeObserver.observe(terminalHost.value)
  scheduleFit()
  void checkAndConnect()
})

watch(sessionState, (state) => {
  if (xterm) xterm.options.disableStdin = !['active', 'idleWarning'].includes(state)
})

onBeforeUnmount(() => {
  disposed = true
  resizeObserver?.disconnect()
  if (resizeFrame !== null) cancelAnimationFrame(resizeFrame)
  xterm?.dispose()
  xterm = null
  fitAddon = null
})
</script>

<template>
  <div
    class="terminal-app"
    data-ui="terminal-session"
    :style="{ '--terminal-background': terminalBackground }"
  >
    <div v-if="idleWarningSeconds !== null || (sessionError?.recoverable && sessionErrorText)" class="terminal-notice" data-ui="terminal-notice">
      <span v-if="idleWarningSeconds !== null" class="context-notice-warning" data-ui="terminal-idle-warning">
        {{ t('app.terminal.idleWarning', { seconds: idleWarningSeconds }) }}
      </span>
      <span v-else class="context-notice-error" data-ui="terminal-session-error">{{ sessionErrorText }}</span>
    </div>

    <div class="sr-only" role="status" aria-live="polite" data-slot="announcements">
      <span>{{ statusLabel }}</span>
      <span v-if="idleWarningSeconds !== null">
        {{ t('app.terminal.idleWarning', { seconds: idleWarningSeconds }) }}
      </span>
      <span v-if="sessionErrorText">{{ sessionErrorText }}</span>
    </div>

    <div class="terminal-stage" data-slot="canvas">
      <div
        ref="terminalHost"
        class="terminal-canvas"
        role="application"
        :aria-label="t('app.terminal.terminalLabel', { node: targetNodeName })"
        data-ui="terminal-canvas"
        data-native-context-menu
      ></div>

      <div
        v-if="accessState === 'checking'"
        class="terminal-overlay"
        aria-busy="true"
        data-ui="terminal-checking"
      >
        <VeyLoading
          class="terminal-checking-loading"
          :loading="true"
          :text="t('app.terminal.checkingAccess')"
        />
      </div>
      <div
        v-else-if="accessState === 'failed'"
        class="terminal-overlay"
        data-ui="terminal-access-failed"
      >
        <VeyAlert type="error" :title="t('app.terminal.accessFailed')" show-icon />
        <VeyButton type="secondary" @click="checkAndConnect">{{ t('common.retry') }}</VeyButton>
      </div>
      <div
        v-else-if="accessState === 'unavailable'"
        class="terminal-overlay"
        data-ui="terminal-unavailable"
      >
        <VeyAlert type="warning" :title="unavailableText" show-icon />
      </div>
      <div
        v-else-if="sessionState === 'ended' || sessionState === 'failed'"
        class="terminal-overlay terminal-inactive-overlay"
        data-ui="terminal-inactive"
        role="status"
      >
        <p>{{ inactiveStatusText }}</p>
        <VeyButton
          type="primary"
          :disabled="!canConnect"
          data-ui="terminal-reconnect"
          @click="startConnection"
        >
          {{ t('app.terminal.reconnect') }}
        </VeyButton>
      </div>
    </div>
  </div>
</template>

<style scoped>
.terminal-app {
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--vdl-bg-canvas);
  color: var(--vdl-text-primary);
}

.terminal-notice {
  padding: var(--vdl-space-1) var(--vdl-space-3);
  font-size: var(--vdl-font-body-sm);
  color: var(--vdl-text-secondary);
}

.context-notice-warning {
  color: var(--vdl-warning);
}

.context-notice-error {
  color: var(--vdl-danger);
}

.terminal-stage {
  position: relative;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: var(--vdl-space-3);
  background: var(--terminal-background);
}

.terminal-canvas {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background: var(--terminal-background);
}

.terminal-overlay {
  position: absolute;
  inset: var(--vdl-space-3);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--vdl-space-4);
  padding: var(--vdl-space-5);
  text-align: center;
  background: var(--vdl-bg-canvas);
}

.terminal-overlay > :deep(*) {
  max-width: 520px;
}

.terminal-overlay p {
  margin: 0;
  color: var(--vdl-text-secondary);
  line-height: 1.6;
}

.terminal-checking-loading {
  width: 240px;
  max-width: 100%;
}

.terminal-checking-loading :deep(.vl-loading-text) {
  white-space: nowrap;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

:deep(.xterm) {
  height: 100%;
  background: var(--terminal-background);
}

:deep(.xterm-viewport) {
  overflow-y: auto;
  background: var(--terminal-background) !important;
}

:deep(.xterm-screen) {
  background: var(--terminal-background);
}

</style>
