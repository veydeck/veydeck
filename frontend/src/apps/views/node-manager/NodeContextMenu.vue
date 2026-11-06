<script setup lang="ts">
/** 节点卡片菜单：处理视口避让、键盘导航和关闭。 */
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { VeyGlassSurface } from '@/components/ui'

const props = defineProps<{
  x: number
  y: number
  label: string
  actions: Array<{ label: string; disabled?: boolean; class?: string; handler: () => unknown }>
}>()
const emit = defineEmits<{ close: [] }>()
const menu = ref<HTMLElement | null>(null)
const left = ref(props.x)
const top = ref(props.y)
const trigger = document.activeElement as HTMLElement | null

/** 测量菜单后将其限制在可见视口内。 */
const position = async () => {
  await nextTick()
  if (!menu.value) return
  const rect = menu.value.getBoundingClientRect()
  left.value = Math.max(8, Math.min(props.x, window.innerWidth - rect.width - 8))
  top.value = Math.max(8, Math.min(props.y, window.innerHeight - rect.height - 8))
}

/** 菜单外点击、滚动和窗口变化时关闭。 */
const outside = (event: Event) => {
  if (!menu.value?.contains(event.target as Node)) emit('close')
}
const close = () => emit('close')

/** 使用方向键选择操作，Escape 关闭后恢复卡片焦点。 */
const navigate = (event: KeyboardEvent) => {
  if (event.key === 'Escape' || event.key === 'Tab') {
    event.preventDefault()
    emit('close')
    trigger?.focus()
    return
  }
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  event.preventDefault()
  const buttons = Array.from(menu.value?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  if (buttons.length === 0) return
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const index = event.key === 'Home'
    ? 0
    : event.key === 'End'
      ? buttons.length - 1
      : (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length
  buttons[index]?.focus()
}

/** 点击操作前关闭菜单，后续焦点交由操作打开的对话框管理。 */
const run = (action: typeof props.actions[number]) => {
  if (action.disabled) return
  emit('close')
  trigger?.focus()
  action.handler()
}

watch(() => [props.x, props.y, props.actions], position)
onMounted(async () => {
  document.addEventListener('mousedown', outside)
  document.addEventListener('scroll', outside, true)
  window.addEventListener('resize', close)
  await position()
  const target = menu.value?.querySelector<HTMLButtonElement>('button:not(:disabled)') ?? menu.value
  target?.focus()
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', outside)
  document.removeEventListener('scroll', outside, true)
  window.removeEventListener('resize', close)
})
</script>

<template>
  <Teleport to="body">
    <div
      ref="menu"
      class="node-context-menu"
      :style="{ left: `${left}px`, top: `${top}px` }"
      role="menu"
      tabindex="-1"
      :aria-label="label"
      data-ui="node-context-menu"
      @keydown="navigate"
      @contextmenu.prevent
    >
      <VeyGlassSurface class="node-menu-surface">
        <button
          v-for="(action, index) in actions"
          :key="index"
          role="menuitem"
          :disabled="action.disabled"
          :class="action.class"
          @click="run(action)"
        >
          {{ action.label }}
        </button>
      </VeyGlassSurface>
    </div>
  </Teleport>
</template>

<style scoped>
.node-context-menu {
  position: fixed;
  z-index: 21020;
  width: max-content;
  min-width: min(180px, calc(100vw - 16px));
  max-width: calc(100vw - 16px);
}

.node-menu-surface {
  display: flex;
  flex-direction: column;
  padding: var(--vdl-space-1);
  border-radius: var(--vdl-radius-md);
  box-shadow: var(--vdl-shadow-window);
  max-height: calc(100vh - 16px);
  overflow-y: auto;
}

button {
  border: 0;
  background: transparent;
  color: var(--vdl-text-primary);
  text-align: left;
  padding: var(--vdl-space-2) var(--vdl-space-3);
  font: inherit;
  font-size: var(--vdl-font-body-sm);
  border-radius: var(--vdl-radius-sm);
  cursor: pointer;
}

button:hover:not(:disabled),
button:focus-visible {
  background: var(--vdl-bg-muted);
  outline: 2px solid var(--vdl-border-brand);
  outline-offset: -2px;
}

button:disabled {
  color: var(--vdl-text-muted);
  cursor: default;
}

.btn-delete,
.btn-stop {
  color: var(--vdl-danger);
}
</style>
