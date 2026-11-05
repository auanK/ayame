<template>
  <div class="vault-tag-editor">
    <span
      v-for="tag in modelValue"
      :key="tag"
      class="vault-tag-chip vault-tag-chip--editable"
    >
      #{{ tag }}
      <button
        type="button"
        class="vault-tag-remove"
        aria-label="Remove tag"
        :disabled="disabled"
        @click="removeTag(tag)"
      >
        ×
      </button>
    </span>
    <input
      :id="inputId"
      v-model="draftInput"
      type="text"
      class="vault-tag-inline-input"
      :placeholder="placeholder"
      :disabled="disabled"
      @keydown.enter.prevent="commitDraft"
      @keydown.,.prevent="commitDraft"
    />
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  modelValue: {
    type: Array,
    default: () => [],
  },
  inputId: {
    type: String,
    default: undefined,
  },
  placeholder: {
    type: String,
    default: 'Add tag and press Enter',
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['update:modelValue'])

const draftInput = ref('')

const commitDraft = () => {
  const cleaned = String(draftInput.value || '').trim().replace(/^#+/, '').replace(/,+$/, '').trim()
  draftInput.value = ''
  if (!cleaned) return
  if (props.modelValue.some((t) => t.toLowerCase() === cleaned.toLowerCase())) return
  emit('update:modelValue', [...props.modelValue, cleaned])
}

const removeTag = (tagToRemove) => {
  emit(
    'update:modelValue',
    props.modelValue.filter((t) => t !== tagToRemove)
  )
}

const flushPending = () => {
  if (draftInput.value.trim()) {
    commitDraft()
  }
}

const resetInput = () => {
  draftInput.value = ''
}

defineExpose({ flushPending, resetInput })
</script>
