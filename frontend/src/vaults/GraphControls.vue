<script setup>
import { ref, computed } from 'vue'
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
  panelId: {
    type: String,
    default: 'graph-settings-panel',
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

const CONTROL_TABS = [
  { id: 'filters', label: 'Filters', testid: 'graph-section-filters' },
  { id: 'groups', label: 'Groups', testid: 'graph-section-groups' },
  { id: 'display', label: 'Display', testid: 'graph-section-display' },
  { id: 'forces', label: 'Forces', testid: 'graph-section-forces' },
]

const activeTab = ref('filters')
const tabButtonRefs = []

const setTabRef = (idx) => (el) => {
  tabButtonRefs[idx] = el
}

const handleTabKeydown = (idx, event) => {
  let nextIdx = null
  if (event.key === 'ArrowRight') nextIdx = (idx + 1) % CONTROL_TABS.length
  else if (event.key === 'ArrowLeft') nextIdx = (idx - 1 + CONTROL_TABS.length) % CONTROL_TABS.length
  else if (event.key === 'Home') nextIdx = 0
  else if (event.key === 'End') nextIdx = CONTROL_TABS.length - 1
  if (nextIdx === null) return
  event.preventDefault()
  activeTab.value = CONTROL_TABS[nextIdx].id
  tabButtonRefs[nextIdx]?.focus?.()
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
    :id="panelId"
    class="graph-filters-panel"
    data-testid="graph-filters-panel"
    role="region"
    aria-label="Graph settings"
  >
    <div class="graph-tabs-bar" role="tablist" aria-label="Graph settings categories">
      <button
        v-for="(tab, idx) in CONTROL_TABS"
        :id="`${panelId}-tab-${tab.id}`"
        :key="tab.id"
        :ref="setTabRef(idx)"
        type="button"
        role="tab"
        class="graph-tab-btn"
        :class="{ 'graph-tab-btn--active': activeTab === tab.id }"
        :data-testid="tab.testid"
        :aria-controls="`${panelId}-pane-${tab.id}`"
        :aria-selected="activeTab === tab.id ? 'true' : 'false'"
        @click="activeTab = tab.id"
        @keydown="handleTabKeydown(idx, $event)"
      >
        <span class="graph-tab-label">{{ tab.label }}</span>
        <span v-if="tab.id === 'groups' && groups.length > 0" class="graph-tab-count">
          ({{ groups.length }})
        </span>
      </button>
    </div>

    <div class="graph-tab-body">
      <!-- Filters Tab -->
      <section
        v-show="activeTab === 'filters'"
        :id="`${panelId}-pane-filters`"
        class="graph-tab-pane"
        data-testid="graph-tab-pane-filters"
        role="tabpanel"
        :aria-labelledby="`${panelId}-tab-filters`"
        :hidden="activeTab !== 'filters'"
        :inert="activeTab !== 'filters' || undefined"
      >
        <div class="graph-pane-header">
          <span class="graph-pane-title">Filters</span>
          <button
            v-if="hasActiveFilters"
            type="button"
            class="graph-inline-link"
            data-testid="graph-filters-reset"
            @click="resetFilters"
          >
            Reset filters
          </button>
        </div>

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
                title="Clear search filter"
                @click="updateFilter({ searchQuery: '' })"
              >
                ×
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
      </section>

      <!-- Groups Tab -->
      <section
        v-show="activeTab === 'groups'"
        :id="`${panelId}-pane-groups`"
        class="graph-tab-pane"
        data-testid="graph-tab-pane-groups"
        role="tabpanel"
        :aria-labelledby="`${panelId}-tab-groups`"
        :hidden="activeTab !== 'groups'"
        :inert="activeTab !== 'groups' || undefined"
      >
        <div class="graph-pane-header">
          <span class="graph-pane-title">Color groups</span>
          <button
            v-if="groups.length > 0"
            type="button"
            class="graph-inline-link"
            data-testid="graph-groups-reset"
            @click="emit('reset-groups')"
          >
            Clear groups
          </button>
        </div>

        <p v-if="groups.length === 0" class="graph-empty-hint">
          No color rules yet. Add a group by text, path:, file:, or tag:.
        </p>

        <div v-else class="graph-groups-list">
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
                  title="Move up"
                  @click="handleMoveGroup(group.id, -1)"
                >
                  ↑
                </button>
                <button
                  type="button"
                  class="graph-group-btn"
                  :data-testid="`graph-group-down-${group.id}`"
                  :disabled="idx === groups.length - 1"
                  aria-label="Move group down"
                  title="Move down"
                  @click="handleMoveGroup(group.id, 1)"
                >
                  ↓
                </button>
                <button
                  type="button"
                  class="graph-group-btn graph-group-btn--remove"
                  :data-testid="`graph-group-remove-${group.id}`"
                  aria-label="Remove group"
                  title="Remove group"
                  @click="handleRemoveGroup(group.id)"
                >
                  ×
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
            class="graph-inline-link graph-inline-link--accent"
            data-testid="graph-group-add"
            @click="handleAddGroup"
          >
            + New group
          </button>
        </div>
      </section>

      <!-- Display Tab -->
      <section
        v-show="activeTab === 'display'"
        :id="`${panelId}-pane-display`"
        class="graph-tab-pane"
        data-testid="graph-tab-pane-display"
        role="tabpanel"
        :aria-labelledby="`${panelId}-tab-display`"
        :hidden="activeTab !== 'display'"
        :inert="activeTab !== 'display' || undefined"
      >
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
      </section>

      <!-- Forces Tab -->
      <section
        v-show="activeTab === 'forces'"
        :id="`${panelId}-pane-forces`"
        class="graph-tab-pane"
        data-testid="graph-tab-pane-forces"
        role="tabpanel"
        :aria-labelledby="`${panelId}-tab-forces`"
        :hidden="activeTab !== 'forces'"
        :inert="activeTab !== 'forces' || undefined"
      >
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
      </section>
    </div>

    <div class="graph-panel-footer">
      <button
        type="button"
        class="graph-inline-link graph-restore-link"
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
  width: 100%;
  max-width: min(308px, 100%);
  max-height: min(62vh, 390px);
  background: var(--ayame-surface);
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-sm, 4px);
  box-shadow: 0 10px 26px var(--ayame-shadow);
  font-size: 0.76rem;
  color: var(--ayame-text);
  overflow: hidden;
  min-width: 0;
}

.graph-tabs-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.15rem;
  padding: 0.3rem 0.35rem;
  background: var(--ayame-background);
  border-bottom: 1px solid var(--ayame-border);
  flex-shrink: 0;
}

.graph-tab-btn {
  flex: 1 1 56px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.18rem;
  min-width: 0;
  max-width: 100%;
  padding: 0.26rem 0.25rem;
  border: 1px solid transparent;
  border-radius: var(--radius-xs, 2px);
  background: transparent;
  color: var(--ayame-text-muted);
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.graph-tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.graph-tab-btn:hover {
  color: var(--ayame-text);
  background: color-mix(in srgb, var(--ayame-text) 4%, transparent);
}

.graph-tab-btn:focus-visible {
  outline: 2px solid var(--ayame-primary);
  outline-offset: -1px;
  color: var(--ayame-text);
}

.graph-tab-btn--active {
  color: var(--ayame-text);
  background: var(--ayame-hover);
  border-color: color-mix(in srgb, var(--ayame-primary) 32%, transparent);
  font-weight: 600;
}

.graph-tab-count {
  color: var(--ayame-primary);
  font-size: 0.68rem;
  flex-shrink: 0;
}

.graph-tab-body {
  flex: 1 1 auto;
  padding: 0.65rem 0.75rem 0.55rem;
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
}

.graph-tab-pane {
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  min-width: 0;
}

.graph-tab-pane[hidden] {
  display: none;
}

.graph-pane-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-height: 1.15rem;
}

.graph-pane-title {
  color: var(--ayame-text-muted);
  font-size: 0.68rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}

.graph-inline-link {
  padding: 0;
  border: none;
  border-radius: 3px;
  background: transparent;
  color: var(--ayame-text-muted);
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  line-height: 1.2;
}

.graph-inline-link:hover {
  color: var(--ayame-lavender);
  text-decoration: underline;
  text-underline-offset: 2px;
}

.graph-inline-link:focus-visible {
  outline: 2px solid var(--ayame-primary);
  outline-offset: 2px;
  color: var(--ayame-lavender);
}

.graph-inline-link--accent {
  color: var(--ayame-primary);
}

.graph-restore-link {
  font-size: 0.7rem;
}

.graph-empty-hint {
  margin: 0;
  color: var(--ayame-text-muted);
  font-size: 0.72rem;
  line-height: 1.4;
}

.graph-filter-field,
.graph-slider-field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 0;
}

.graph-filter-label,
.graph-slider-header {
  display: flex;
  flex-direction: column;
  gap: 0.24rem;
  font-size: 0.72rem;
  color: var(--ayame-text-muted);
}

.graph-slider-header {
  flex-direction: row;
  justify-content: space-between;
  align-items: center;
}

.graph-slider-value {
  font-variant-numeric: tabular-nums;
  color: var(--ayame-text);
}

.graph-range-slider {
  width: 100%;
  min-width: 0;
  accent-color: var(--ayame-primary);
  cursor: pointer;
}

.graph-filter-search-row {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  min-width: 0;
}

.graph-filter-input {
  flex: 1 1 auto;
  min-width: 0;
  padding: 0.28rem 0.45rem;
  background: var(--ayame-background);
  color: var(--ayame-text);
  border: 1px solid var(--ayame-control-border);
  border-radius: var(--radius-xs, 2px);
  font-size: 0.74rem;
}

.graph-filter-input:focus-visible {
  border-color: var(--ayame-primary);
}

.graph-filter-clear,
.graph-group-btn {
  background: transparent;
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-xs, 2px);
  color: var(--ayame-text-muted);
  font-size: 0.72rem;
  line-height: 1;
  padding: 0.22rem 0.38rem;
  cursor: pointer;
  flex-shrink: 0;
}

.graph-filter-clear:hover,
.graph-group-btn:hover:not(:disabled) {
  color: var(--ayame-text);
  background: var(--ayame-hover);
}

.graph-filter-clear:focus-visible,
.graph-group-btn:focus-visible,
.graph-group-color:focus-visible,
.graph-range-slider:focus-visible,
.graph-filter-toggle input:focus-visible {
  outline: 2px solid var(--ayame-primary);
  outline-offset: 1px;
}

.graph-group-btn--remove:hover:not(:disabled) {
  color: var(--ayame-error);
  border-color: color-mix(in srgb, var(--ayame-error) 45%, transparent);
}

.graph-group-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.graph-filter-error {
  margin: 0;
  color: var(--ayame-error);
  font-size: 0.7rem;
  line-height: 1.3;
  word-break: break-word;
}

.graph-filter-toggles {
  display: flex;
  flex-direction: column;
  gap: 0.42rem;
  min-width: 0;
}

.graph-filter-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  cursor: pointer;
  user-select: none;
  font-size: 0.75rem;
}

.graph-filter-toggle span {
  min-width: 0;
  overflow-wrap: anywhere;
}

.graph-groups-list {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
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
  gap: 0.28rem;
  min-width: 0;
}

.graph-group-color {
  width: 24px;
  height: 24px;
  padding: 1px;
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-xs, 2px);
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
}

.graph-group-query {
  flex: 1 1 90px;
  min-width: 0;
}

.graph-group-actions {
  display: flex;
  align-items: center;
  gap: 0.16rem;
  flex-shrink: 0;
}

.graph-group-footer {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  padding-top: 0.1rem;
}

.graph-panel-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  padding: 0.4rem 0.75rem;
  border-top: 1px solid var(--ayame-border);
  background: color-mix(in srgb, var(--ayame-background) 45%, transparent);
  flex-shrink: 0;
}
</style>
