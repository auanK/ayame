<template>
  <BaseModal
    :title="title"
    :title-id="titleId"
    :subtitle="subtitle"
    :backdrop-class="backdropClass"
    :close-disabled="disabled"
    @close="emit('cancel')"
  >
    <p class="vaults-muted">{{ message }}</p>
    <template #footer>
      <button
        type="button"
        class="btn btn-secondary"
        :data-testid="cancelTestId"
        :disabled="disabled"
        @click="emit('cancel')"
      >
        {{ cancelLabel }}
      </button>
      <button
        type="button"
        class="btn btn-primary"
        :data-testid="confirmTestId"
        :disabled="disabled"
        @click="emit('confirm')"
      >
        {{ confirmLabel }}
      </button>
    </template>
  </BaseModal>
</template>

<script setup>
import BaseModal from './BaseModal.vue'

defineProps({
  title: {
    type: String,
    required: true,
  },
  titleId: {
    type: String,
    default: 'confirm-modal-title',
  },
  subtitle: {
    type: String,
    default: '',
  },
  message: {
    type: String,
    required: true,
  },
  cancelLabel: {
    type: String,
    default: 'Cancel',
  },
  confirmLabel: {
    type: String,
    default: 'Confirm',
  },
  cancelTestId: {
    type: String,
    default: undefined,
  },
  confirmTestId: {
    type: String,
    default: undefined,
  },
  backdropClass: {
    type: String,
    default: '',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['cancel', 'confirm'])
</script>
