<template>
  <div class="vault-color-swatches">
    <button
      type="button"
      class="vault-color-swatch vault-color-swatch--none"
      :class="{ 'vault-color-swatch--active': !modelValue }"
      aria-label="No accent color"
      title="No accent color"
      @click="emit('update:modelValue', '')"
    >
      ∅
    </button>
    <button
      v-for="color in swatches"
      :key="color"
      type="button"
      class="vault-color-swatch"
      :class="{ 'vault-color-swatch--active': modelValue === color }"
      :style="{ backgroundColor: color }"
      :aria-label="`Select accent ${color}`"
      @click="emit('update:modelValue', modelValue === color ? '' : color)"
    />
  </div>
</template>

<script setup>
defineProps({
  modelValue: {
    type: String,
    default: '',
  },
  swatches: {
    type: Array,
    default: () => [
      '#a99aca',
      '#d4a5b8',
      '#8ccff0',
      '#8fc7a8',
      '#e6c387',
      '#9da8c4',
    ],
  },
})

const emit = defineEmits(['update:modelValue'])
</script>
