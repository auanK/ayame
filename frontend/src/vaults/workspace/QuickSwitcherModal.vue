<template>
  <BaseModal
    title="Open note"
    subtitle="Type to navigate quickly"
    aria-label="Quick switcher"
    test-id="quick-switcher-modal"
    :close-on-esc="false"
    @close="emit('close')"
  >
    <input
      ref="inputRef"
      :value="query"
      type="text"
      class="explorer-create-input"
      data-testid="quick-switcher-input"
      placeholder="Note name…"
      @input="emit('update:query', $event.target.value)"
      @keydown="emit('keydown', $event)"
    />
    <div class="trash-list">
      <button
        v-for="(filePath, idx) in results"
        :key="filePath"
        type="button"
        class="panel-list-item"
        :class="{ 'panel-list-item--active': idx === activeIndex }"
        data-testid="quick-switcher-item"
        :data-file-path="filePath"
        @click="emit('select', filePath)"
      >
        {{ filePath }}
      </button>
      <button
        v-if="canCreate"
        type="button"
        class="panel-list-item panel-list-item--pending"
        :class="{ 'panel-list-item--active': activeIndex === results.length }"
        data-testid="quick-switcher-create"
        @click="emit('create', query.trim())"
      >
        Create "{{ query.trim() }}"
      </button>
    </div>
  </BaseModal>
</template>

<script setup>
import { onMounted, ref } from 'vue'
import BaseModal from '../../components/BaseModal.vue'

defineProps({
  query: { type: String, default: '' },
  results: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
  canCreate: { type: Boolean, default: false },
})

const emit = defineEmits(['close', 'update:query', 'keydown', 'select', 'create'])

const inputRef = ref(null)

const focusInput = () => {
  inputRef.value?.focus?.()
}

onMounted(() => {
  focusInput()
})

defineExpose({ focusInput })
</script>
