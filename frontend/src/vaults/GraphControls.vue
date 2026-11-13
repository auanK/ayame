<script setup>
import { reactive, computed } from 'vue'
import { createDefaultGraphFilters } from './graphSelection.js'
import {
  GRAPH_DISPLAY_LIMITS,
  GRAPH_FORCE_LIMITS,
  createDefaultGraphSettings,
  addColorGroup,
  updateColorGroup,
  removeColorGroup,
  moveColorGroup,
} from './graphSettings.js'

const props = defineProps({
  filters: {
    type: Object,
    required: true,
  },
  queryError: {
    type: String,
    default: '',
  },
  groups: {
    type: Array,
    default: () => [],
  },
  groupErrors: {
    type: Object,
    default: () => ({}),
  },
  display: {
    type: Object,
    default: () => createDefaultGraphSettings().global.display,
  },
  forces: {
    type: Object,
    default: () => createDefaultGraphSettings().global.forces,
  },
})

const emit = defineEmits([
  'update:filters',
  'update:groups',
  'update:display',
  'update:forces',
  'restore-defaults',
  'reset-groups',
])

const openSections = reactive({
  filters: true,
  groups: false,
  display: false,
  forces: false,
})

const toggleSection = (key) => {
  openSections[key] = !openSections[key]
}

const DISPLAY_SLIDERS = [
  {
    key: 'textFadeThreshold',
    label: 'Text fade threshold',
    testid: 'graph-display-text-fade',
    ...GRAPH_DISPLAY_LIMITS.textFadeThreshold,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'nodeSize',
    label: 'Node size',
    testid: 'graph-display-node-size',
    ...GRAPH_DISPLAY_LIMITS.nodeSize,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'linkThickness',
    label: 'Link thickness',
    testid: 'graph-display-link-thickness',
    ...GRAPH_DISPLAY_LIMITS.linkThickness,
    format: (v) => v.toFixed(2),
  },
]

const FORCE_SLIDERS = [
  {
    key: 'centerForce',
    label: 'Center force',
    testid: 'graph-force-center',
    ...GRAPH_FORCE_LIMITS.centerForce,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'repelForce',
    label: 'Repel force',
    testid: 'graph-force-repel',
    ...GRAPH_FORCE_LIMITS.repelForce,
    format: (v) => String(Math.round(v)),
  },
  {
    key: 'linkForce',
    label: 'Link force',
    testid: 'graph-force-link',
    ...GRAPH_FORCE_LIMITS.linkForce,
    format: (v) => v.toFixed(2),
  },
  {
    key: 'linkDistance',
    label: 'Link distance',
    testid: 'graph-force-distance',
    ...GRAPH_FORCE_LIMITS.linkDistance,
    format: (v) => String(Math.round(v)),
  },
]

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

const updateDisplay = (patch) => {
  emit('update:display', {
    ...createDefaultGraphSettings().global.display,
    ...props.display,
    ...patch,
  })
}

const updateForces = (patch) => {
  emit('update:forces', {
    ...createDefaultGraphSettings().global.forces,
    ...props.forces,
    ...patch,
  })
}

const handleRangeInput = (kind, key, event) => {
  const numeric = Number(event?.target?.value)
  if (!Number.isFinite(numeric)) return
  if (kind === 'display') updateDisplay({ [key]: numeric })
  else updateForces({ [key]: numeric })
}

const formatSliderValue = (source, slider) => {
  const raw = source?.[slider.key]
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : slider.default
  return slider.format(value)
}

const sliderNumericValue = (source, slider) => {
  const raw = source?.[slider.key]
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : slider.default
}

const handleAddGroup = () => {
  emit('update:groups', addColorGroup({ groups: props.groups }).groups)
}

const handleUpdateGroup = (groupId, patch) => {
  emit('update:groups', updateColorGroup({ groups: props.groups }, groupId, patch).groups)
}

const handleRemoveGroup = (groupId) => {
  emit('update:groups', removeColorGroup({ groups: props.groups }, groupId).groups)
}

const handleMoveGroup = (groupId, delta) => {
  emit('update:groups', moveColorGroup({ groups: props.groups }, groupId, delta).groups)
}
</script>

<template>
  <div
    class="graph-filters-panel"
    data-testid="graph-filters-panel"
    role="region"
    aria-label="Graph settings"
  >
    <!-- Filters Section -->
    <section class="graph-control-section">
      <button
        type="button"
        class="graph-section-header"
        data-testid="graph-section-filters"
        :aria-expanded="openSections.filters ? 'true' : 'false'"
        @click="toggleSection('filters')"
      >
        <span>Filters</span>
        <span class="graph-section-indicator" aria-hidden="true">{{ openSections.filters ? '-' : '+' }}</span>
      </button>

      <div v-if="openSections.filters" class="graph-section-body">
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
    </section>

    <!-- Groups Section -->
    <section class="graph-control-section">
      <button
        type="button"
        class="graph-section-header"
        data-testid="graph-section-groups"
        :aria-expanded="openSections.groups ? 'true' : 'false'"
        @click="toggleSection('groups')"
      >
        <span>Groups{{ groups.length > 0 ? ` (${groups.length})` : '' }}</span>
        <span class="graph-section-indicator" aria-hidden="true">{{ openSections.groups ? '-' : '+' }}</span>
      </button>

      <div v-if="openSections.groups" class="graph-section-body">
        <div v-if="groups.length > 0" class="graph-groups-list">
          <div
            v-for="(group, idx) in groups"
            :key="group.id"
            class="graph-group-item"
            :data-testid="`graph-group-row-${group.id}`"
          >
            <div class="graph-group-row">
              <input
                type="color"
                class="graph-group-color"
                :data-testid="`graph-group-color-${group.id}`"
                :aria-label="`Color for group ${idx + 1}`"
                :value="group.color"
                @input="handleUpdateGroup(group.id, { color: $event.target.value })"
              />
              <input
                type="search"
                class="graph-filter-input graph-group-query"
                :data-testid="`graph-group-query-${group.id}`"
                :aria-label="`Query for group ${idx + 1}`"
                placeholder="text, file:, path:, tag:"
                :value="group.query"
                @input="handleUpdateGroup(group.id, { query: $event.target.value })"
              />
              <div class="graph-group-actions">
                <button
                  type="button"
                  class="graph-group-btn"
                  :data-testid="`graph-group-up-${group.id}`"
                  :disabled="idx === 0"
                  aria-label="Move group up"
                  @click="handleMoveGroup(group.id, -1)"
                >
                  Up
                </button>
                <button
                  type="button"
                  class="graph-group-btn"
                  :data-testid="`graph-group-down-${group.id}`"
                  :disabled="idx === groups.length - 1"
                  aria-label="Move group down"
                  @click="handleMoveGroup(group.id, 1)"
                >
                  Down
                </button>
                <button
                  type="button"
                  class="graph-group-btn graph-group-btn--remove"
                  :data-testid="`graph-group-remove-${group.id}`"
                  aria-label="Remove group"
                  @click="handleRemoveGroup(group.id)"
                >
                  Remove
                </button>
              </div>
            </div>
            <p
              v-if="groupErrors[group.id]"
              class="graph-filter-error"
              :data-testid="`graph-group-error-${group.id}`"
              role="status"
            >
              {{ groupErrors[group.id] }}
            </p>
          </div>
        </div>

        <div class="graph-group-footer">
          <button
            type="button"
            class="btn-secondary btn-compact"
            data-testid="graph-group-add"
            @click="handleAddGroup"
          >
            New group
          </button>
          <button
            v-if="groups.length > 0"
            type="button"
            class="graph-filter-clear"
            data-testid="graph-groups-reset"
            @click="emit('reset-groups')"
          >
            Reset groups
          </button>
        </div>
      </div>
    </section>

    <!-- Display Section -->
    <section class="graph-control-section">
      <button
        type="button"
        class="graph-section-header"
        data-testid="graph-section-display"
        :aria-expanded="openSections.display ? 'true' : 'false'"
        @click="toggleSection('display')"
      >
        <span>Display</span>
        <span class="graph-section-indicator" aria-hidden="true">{{ openSections.display ? '-' : '+' }}</span>
      </button>

      <div v-if="openSections.display" class="graph-section-body">
        <label class="graph-filter-toggle">
          <input
            type="checkbox"
            data-testid="graph-display-arrows"
            :checked="Boolean(display.arrows)"
            @change="updateDisplay({ arrows: $event.target.checked })"
          />
          <span>Arrows</span>
        </label>

        <label
          v-for="slider in DISPLAY_SLIDERS"
          :key="slider.key"
          class="graph-slider-field"
        >
          <div class="graph-slider-header">
            <span>{{ slider.label }}</span>
            <span class="graph-slider-value">{{ formatSliderValue(display, slider) }}</span>
          </div>
          <input
            type="range"
            class="graph-range-slider"
            :data-testid="slider.testid"
            :aria-label="slider.label"
            :min="slider.min"
            :max="slider.max"
            :step="slider.step"
            :value="sliderNumericValue(display, slider)"
            @input="handleRangeInput('display', slider.key, $event)"
          />
        </label>
      </div>
    </section>

    <!-- Forces Section -->
    <section class="graph-control-section">
      <button
        type="button"
        class="graph-section-header"
        data-testid="graph-section-forces"
        :aria-expanded="openSections.forces ? 'true' : 'false'"
        @click="toggleSection('forces')"
      >
        <span>Forces</span>
        <span class="graph-section-indicator" aria-hidden="true">{{ openSections.forces ? '-' : '+' }}</span>
      </button>

      <div v-if="openSections.forces" class="graph-section-body">
        <label
          v-for="slider in FORCE_SLIDERS"
          :key="slider.key"
          class="graph-slider-field"
        >
          <div class="graph-slider-header">
            <span>{{ slider.label }}</span>
            <span class="graph-slider-value">{{ formatSliderValue(forces, slider) }}</span>
          </div>
          <input
            type="range"
            class="graph-range-slider"
            :data-testid="slider.testid"
            :aria-label="slider.label"
            :min="slider.min"
            :max="slider.max"
            :step="slider.step"
            :value="sliderNumericValue(forces, slider)"
            @input="handleRangeInput('forces', slider.key, $event)"
          />
        </label>
      </div>
    </section>

    <div class="graph-panel-footer">
      <button
        type="button"
        class="btn-secondary btn-compact"
        data-testid="graph-restore-defaults"
        @click="emit('restore-defaults')"
      >
        Restore default settings
      </button>
    </div>
  </div>
</template>

<style scoped>
.graph-filters-panel {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  padding: 0.45rem 0.55rem;
  background: var(--ayame-surface, #1b1c25);
  border-bottom: 1px solid var(--ayame-border, #34323f);
  font-size: 0.76rem;
  color: var(--ayame-text, #eeeaf3);
  max-height: min(55vh, 360px);
  overflow-y: auto;
  overflow-x: hidden;
  flex-shrink: 0;
  min-width: 0;
}

.graph-control-section {
  display: flex;
  flex-direction: column;
  border-bottom: 1px solid var(--ayame-border, #2b2936);
  padding-bottom: 0.3rem;
  min-width: 0;
}

.graph-section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 0.2rem 0.1rem;
  background: transparent;
  border: none;
  color: var(--ayame-text, #eeeaf3);
  font-size: 0.74rem;
  font-weight: 600;
  cursor: pointer;
  text-align: left;
}

.graph-section-header:hover {
  color: var(--ayame-primary, #a99aca);
}

.graph-section-indicator {
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.8rem;
}

.graph-section-body {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.3rem 0.05rem 0.15rem;
  min-width: 0;
}

.graph-filter-field,
.graph-slider-field {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
  min-width: 0;
}

.graph-filter-label,
.graph-slider-header {
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
  font-size: 0.72rem;
  color: var(--ayame-text-muted, #aaa6b8);
}

.graph-slider-header {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.graph-slider-value {
  font-variant-numeric: tabular-nums;
  color: var(--ayame-text, #eeeaf3);
}

.graph-range-slider {
  width: 100%;
  min-width: 0;
  accent-color: var(--ayame-primary, #a99aca);
  cursor: pointer;
}

.graph-filter-search-row {
  display: flex;
  gap: 0.3rem;
  min-width: 0;
}

.graph-filter-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.24rem 0.4rem;
  background: var(--ayame-background, #111218);
  color: var(--ayame-text, #eeeaf3);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  font-size: 0.75rem;
}

.graph-filter-input:focus-visible {
  outline: none;
  border-color: var(--ayame-primary, #a99aca);
}

.graph-filter-clear,
.graph-group-btn {
  background: transparent;
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.68rem;
  padding: 0.14rem 0.35rem;
  cursor: pointer;
  flex-shrink: 0;
}

.graph-filter-clear:hover,
.graph-group-btn:hover:not(:disabled) {
  color: var(--ayame-text, #eeeaf3);
  background: var(--ayame-hover, #242530);
}

.graph-group-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.graph-filter-error {
  margin: 0;
  color: var(--ayame-danger, #e58b95);
  font-size: 0.7rem;
  line-height: 1.3;
  word-break: break-word;
}

.graph-filter-toggles {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.7rem;
}

.graph-filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
  user-select: none;
}

.graph-groups-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  min-width: 0;
}

.graph-group-item {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
}

.graph-group-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}

.graph-group-color {
  width: 24px;
  height: 24px;
  padding: 1px;
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.graph-group-query {
  min-width: 72px;
}

.graph-group-actions {
  display: flex;
  align-items: center;
  gap: 0.2rem;
  flex-shrink: 0;
}

.graph-group-footer,
.graph-filter-actions,
.graph-panel-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding-top: 0.15rem;
  flex-wrap: wrap;
}

.graph-panel-footer {
  justify-content: flex-end;
}
</style>
