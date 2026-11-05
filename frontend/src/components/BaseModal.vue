<template>
  <div
    class="ayame-modal-backdrop"
    :class="backdropClass"
    :data-testid="testId"
    role="dialog"
    aria-modal="true"
    :aria-labelledby="titleId"
    :aria-label="!titleId ? ariaLabel : undefined"
    @click.self="handleBackdropClick"
  >
    <div
      class="ayame-modal-card"
      :class="[
        wide ? 'ayame-modal-card--wide' : '',
        cardClass,
      ]"
    >
      <header v-if="title || $slots.header" class="ayame-modal-header">
        <slot name="header">
          <div class="ayame-modal-heading">
            <h3 :id="titleId">{{ title }}</h3>
            <p v-if="subtitle" class="ayame-modal-subtitle" :class="subtitleClass">{{ subtitle }}</p>
          </div>
        </slot>
        <button
          v-if="closable"
          type="button"
          class="ayame-modal-close"
          :data-testid="closeTestId"
          :aria-label="closeAriaLabel"
          :disabled="closeDisabled"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="ayame-modal-body" :class="bodyClass">
        <slot />
      </div>

      <footer v-if="$slots.footer" class="ayame-modal-footer">
        <slot name="footer" />
      </footer>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted } from 'vue'

const props = defineProps({
  title: {
    type: String,
    default: '',
  },
  titleId: {
    type: String,
    default: undefined,
  },
  ariaLabel: {
    type: String,
    default: undefined,
  },
  subtitle: {
    type: String,
    default: '',
  },
  subtitleClass: {
    type: String,
    default: '',
  },
  wide: {
    type: Boolean,
    default: false,
  },
  closable: {
    type: Boolean,
    default: true,
  },
  closeDisabled: {
    type: Boolean,
    default: false,
  },
  closeAriaLabel: {
    type: String,
    default: 'Close',
  },
  closeTestId: {
    type: String,
    default: undefined,
  },
  testId: {
    type: String,
    default: undefined,
  },
  backdropClass: {
    type: [String, Array, Object],
    default: '',
  },
  cardClass: {
    type: [String, Array, Object],
    default: '',
  },
  bodyClass: {
    type: [String, Array, Object],
    default: '',
  },
  closeOnEsc: {
    type: Boolean,
    default: true,
  },
})

const emit = defineEmits(['close'])

const handleBackdropClick = () => {
  if (!props.closeDisabled) {
    emit('close')
  }
}

const handleKeydown = (event) => {
  if (props.closeOnEsc && !props.closeDisabled && event.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  if (props.closeOnEsc) {
    window.addEventListener('keydown', handleKeydown)
  }
})

onUnmounted(() => {
  if (props.closeOnEsc) {
    window.removeEventListener('keydown', handleKeydown)
  }
})
</script>
