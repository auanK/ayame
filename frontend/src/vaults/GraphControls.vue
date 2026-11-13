<script setup>
import { computed } from 'vue'
import { createDefaultGraphFilters } from './graphSelection.js'

const props = defineProps({
  filters: {
    type: Object,
    required: true,
  },
  queryError: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['update:filters'])

const hasActiveFilters = computed(
  () =>
    Boolean(props.filters?.searchQuery?.trim()) ||
    Boolean(props.filters?.showTags) ||
    props.filters?.existingFilesOnly === false ||
    props.filters?.showOrphans === false
)

const updateFilter = (patch) => {
  emit('update:filters', {
    ...createDefaultGraphFilters(),
    ...props.filters,
    ...patch,
  })
}

const resetFilters = () => {
  emit('update:filters', createDefaultGraphFilters())
}
</script>

<template>
  <div
    class="graph-filters-panel"
    data-testid="graph-filters-panel"
    role="region"
    aria-label="Graph filters"
  >
    <div class="graph-filter-field">
      <label class="graph-filter-label">
        <span>Search files</span>
        <div class="graph-filter-search-row">
          <input
            type="search"
            class="graph-filter-input"
            data-testid="graph-filter-search"
            placeholder="text, file:, path:, tag:"
            :value="filters.searchQuery || ''"
            @input="updateFilter({ searchQuery: $event.target.value })"
          />
          <button
            v-if="filters.searchQuery"
            type="button"
            class="graph-filter-clear"
            data-testid="graph-filter-search-clear"
            aria-label="Clear search filter"
            @click="updateFilter({ searchQuery: '' })"
          >
            Clear
          </button>
        </div>
      </label>
      <p
        v-if="queryError"
        class="graph-filter-error"
        data-testid="graph-filter-search-error"
        role="status"
      >
        {{ queryError }}
      </p>
    </div>

    <div class="graph-filter-toggles">
      <label class="graph-filter-toggle">
        <input
          type="checkbox"
          data-testid="graph-filter-tags"
          :checked="Boolean(filters.showTags)"
          @change="updateFilter({ showTags: $event.target.checked })"
        />
        <span>Tags</span>
      </label>

      <label class="graph-filter-toggle">
        <input
          type="checkbox"
          data-testid="graph-filter-existing-only"
          :checked="filters.existingFilesOnly !== false"
          @change="updateFilter({ existingFilesOnly: $event.target.checked })"
        />
        <span>Existing files only</span>
      </label>

      <label class="graph-filter-toggle">
        <input
          type="checkbox"
          data-testid="graph-filter-orphans"
          :checked="filters.showOrphans !== false"
          @change="updateFilter({ showOrphans: $event.target.checked })"
        />
        <span>Orphans</span>
      </label>
    </div>

    <div v-if="hasActiveFilters" class="graph-filter-actions">
      <button
        type="button"
        class="btn-secondary btn-compact"
        data-testid="graph-filters-reset"
        @click="resetFilters"
      >
        Reset filters
      </button>
    </div>
  </div>
</template>

<style scoped>
.graph-filters-panel {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.5rem 0.6rem;
  background: var(--ayame-surface, #1b1c25);
  border-bottom: 1px solid var(--ayame-border, #34323f);
  font-size: 0.76rem;
  color: var(--ayame-text, #eeeaf3);
  max-height: 220px;
  overflow-y: auto;
  flex-shrink: 0;
}

.graph-filter-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.graph-filter-label {
  font-size: 0.72rem;
  color: var(--ayame-text-muted, #aaa6b8);
}

.graph-filter-search-row {
  display: flex;
  gap: 0.3rem;
  min-width: 0;
}

.graph-filter-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.25rem 0.45rem;
  background: var(--ayame-background, #111218);
  color: var(--ayame-text, #eeeaf3);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  font-size: 0.76rem;
}

.graph-filter-input:focus-visible {
  outline: none;
  border-color: var(--ayame-primary, #a99aca);
}

.graph-filter-clear {
  background: transparent;
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.7rem;
  padding: 0.15rem 0.4rem;
  cursor: pointer;
  flex-shrink: 0;
}

.graph-filter-clear:hover {
  color: var(--ayame-text, #eeeaf3);
  background: var(--ayame-hover, #242530);
}

.graph-filter-error {
  margin: 0;
  color: var(--ayame-danger, #e58b95);
  font-size: 0.71rem;
  line-height: 1.3;
}

.graph-filter-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.75rem;
}

.graph-filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
  user-select: none;
}

.graph-filter-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
