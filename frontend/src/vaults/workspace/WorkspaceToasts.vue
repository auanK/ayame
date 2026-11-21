<template>
  <Teleport to="body" :disabled="isTestEnv">
    <aside class="workspace-toast-container" data-testid="workspace-toast-container">
      <div
        v-if="workspaceNotice"
        class="workspace-toast workspace-toast--info"
        data-testid="workspace-notice"
        role="status"
      >
        <span>{{ workspaceNotice }}</span>
        <button
          type="button"
          class="toast-close-btn"
          aria-label="Dismiss notice"
          @click="emit('dismiss-notice')"
        >
          ×
        </button>
      </div>
      <div
        v-for="t in toasts"
        :key="t.id"
        class="workspace-toast"
        :class="`workspace-toast--${t.type}`"
        data-testid="workspace-toast"
        role="status"
      >
        <span>{{ t.message }}</span>
        <button
          type="button"
          class="toast-close-btn"
          aria-label="Dismiss notification"
          @click="emit('dismiss-toast', t.id)"
        >
          ×
        </button>
      </div>
    </aside>
  </Teleport>
</template>

<script setup>
defineProps({
  workspaceNotice: { type: String, default: '' },
  toasts: { type: Array, default: () => [] },
  isTestEnv: { type: Boolean, default: false },
})

const emit = defineEmits(['dismiss-notice', 'dismiss-toast'])
</script>
