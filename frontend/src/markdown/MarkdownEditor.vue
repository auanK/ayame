<template>
  <textarea
    class="markdown-editor-input"
    data-testid="markdown-editor"
    aria-label="Markdown source"
    spellcheck="false"
    :value="modelValue"
    :disabled="disabled"
    @input="$emit('update:modelValue', $event.target.value)"
  ></textarea>
</template>

<script setup>
defineProps({
  modelValue: { type: String, required: true },
  disabled: { type: Boolean, default: false },
})

defineEmits(['update:modelValue'])
</script>

<style scoped>
.markdown-editor-input {
  display: block;
  width: 100%;
  min-height: 55vh;
  box-sizing: border-box;
  resize: vertical;
  padding: 1rem;
  border: 1px solid rgba(212, 203, 228, 0.2);
  border-radius: 6px;
  background: #0b0c10;
  color: rgba(255, 255, 255, 0.9);
  font: 0.92rem/1.6 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  tab-size: 2;
}

.markdown-editor-input:focus {
  outline: 2px solid var(--ayame-primary, #a99aca);
  outline-offset: 2px;
}
</style>
