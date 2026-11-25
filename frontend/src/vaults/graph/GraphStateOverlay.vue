<template>
  <div
    v-if="status === 'loading'"
    class="graph-state"
    data-testid="graph-loading-state"
    role="status"
  >
    <p>Loading graph...</p>
  </div>

  <div
    v-else-if="status === 'error'"
    class="graph-state"
    data-testid="graph-error-state"
    role="alert"
  >
    <p>Unable to load graph data.</p>
    <button
      type="button"
      class="btn-secondary btn-compact"
      data-testid="graph-retry-button"
      :disabled="loading"
      @click="emit('retry')"
    >
      Try again
    </button>
  </div>

  <div
    v-else-if="status === 'filtered-empty'"
    class="graph-state"
    data-testid="graph-filtered-empty-state"
    role="status"
  >
    <p>No nodes match the current filters.</p>
    <button
      type="button"
      class="btn-secondary btn-compact"
      data-testid="graph-clear-filters-button"
      @click="emit('clear-filters')"
    >
      Clear filters
    </button>
  </div>

  <div
    v-else-if="status === 'incomplete-empty'"
    class="graph-state"
    data-testid="graph-incomplete-state"
    role="status"
  >
    <p>Graph data is incomplete.</p>
  </div>

  <div
    v-else-if="status === 'empty'"
    class="graph-state"
    data-testid="graph-empty-state"
  >
    <p>No notes in this vault.</p>
  </div>
</template>

<script setup>
defineProps({
  status: { type: String, required: true },
  loading: { type: Boolean, default: false },
})

const emit = defineEmits(['retry', 'clear-filters'])
</script>
