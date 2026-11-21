<template>
  <BaseModal
    title="Command palette"
    subtitle="Search commands or notes"
    aria-label="Command palette"
    test-id="command-palette-modal"
    :close-on-esc="false"
    @close="emit('close')"
  >
    <input
      ref="inputRef"
      :value="query"
      type="text"
      class="explorer-create-input"
      data-testid="command-palette-input"
      placeholder="Type a command or note name…"
      autofocus
      @input="emit('update:query', $event.target.value)"
      @keydown="emit('keydown', $event)"
    />
    <div class="trash-list">
      <button
        v-for="(cmd, idx) in items"
        :key="cmd.id"
        type="button"
        class="panel-list-item"
        :class="{ 'panel-list-item--active': idx === activeIndex }"
        @click="emit('run', cmd)"
      >
        <span class="panel-item-title">{{ cmd.label }}</span>
      </button>
    </div>
  </BaseModal>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import BaseModal from '../../components/BaseModal.vue'

defineProps({
  query: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
})

const emit = defineEmits(['close', 'update:query', 'keydown', 'run'])

const inputRef = ref(null)

const focusInput = () => {
  inputRef.value?.focus?.()
}

onMounted(() => {
  focusInput()
})

defineExpose({ focusInput })
</script>
