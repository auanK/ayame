<template>
  <div class="vaults-toolbar" data-testid="vaults-toolbar">
    <div class="vaults-toolbar-row">
      <input
        :value="searchQuery"
        type="search"
        class="form-input vaults-search-input"
        data-testid="vaults-search-input"
        placeholder="Search vaults by name, category, or #tag…"
        aria-label="Search vaults"
        @input="emit('update:searchQuery', $event.target.value)"
      />

      <div class="vaults-view-controls">
        <div class="vaults-segmented" role="group" aria-label="View mode">
          <button
            type="button"
            class="vaults-seg-btn"
            :class="{ 'vaults-seg-btn--active': viewMode === 'cards' }"
            data-testid="view-mode-cards"
            @click="emit('update:viewMode', 'cards')"
          >
            Cards
          </button>
          <button
            type="button"
            class="vaults-seg-btn"
            :class="{ 'vaults-seg-btn--active': viewMode === 'categories' }"
            data-testid="view-mode-categories"
            @click="emit('update:viewMode', 'categories')"
          >
            Categories
          </button>
          <button
            type="button"
            class="vaults-seg-btn"
            :class="{ 'vaults-seg-btn--active': viewMode === 'compact' }"
            data-testid="view-mode-compact"
            @click="emit('update:viewMode', 'compact')"
          >
            Compact
          </button>
        </div>

        <select
          :value="sortMode"
          class="form-input vaults-sort-select"
          data-testid="vaults-sort-select"
          aria-label="Sort vaults"
          @change="emit('update:sortMode', $event.target.value)"
        >
          <option value="manual">Manual (Drag)</option>
          <option value="name">Name (A-Z)</option>
          <option value="recent">Recently updated</option>
          <option value="notes">Most notes</option>
        </select>
      </div>
    </div>

    <div
      v-if="categoryCounts.length > 0 || pinnedCount > 0 || allVaultTags.length > 0"
      class="vaults-filters-row"
    >
      <div
        v-if="categoryCounts.length > 0 || pinnedCount > 0"
        class="vaults-filter-pills"
        role="group"
        aria-label="Filter by category"
      >
        <button
          type="button"
          class="vault-filter-pill"
          :class="{ 'vault-filter-pill--active': selectedCategory === 'all' }"
          data-testid="category-filter-all"
          @click="emit('update:selectedCategory', 'all')"
        >
          All ({{ totalCount }})
        </button>
        <button
          v-if="pinnedCount > 0"
          type="button"
          class="vault-filter-pill"
          :class="{ 'vault-filter-pill--active': selectedCategory === 'pinned' }"
          data-testid="category-filter-pinned"
          @click="emit('update:selectedCategory', 'pinned')"
        >
          Pinned ({{ pinnedCount }})
        </button>
        <button
          v-for="cat in categoryCounts"
          :key="cat.name"
          type="button"
          class="vault-filter-pill"
          :class="{ 'vault-filter-pill--active': selectedCategory === cat.name }"
          :data-testid="`category-filter-${cat.name}`"
          @click="emit('update:selectedCategory', cat.name)"
        >
          {{ cat.name }} ({{ cat.count }})
        </button>
        <button
          v-if="categoryCounts.length > 0 && uncategorizedCount > 0"
          type="button"
          class="vault-filter-pill"
          :class="{ 'vault-filter-pill--active': selectedCategory === '__uncategorized__' }"
          data-testid="category-filter-uncategorized"
          @click="emit('update:selectedCategory', '__uncategorized__')"
        >
          Uncategorized ({{ uncategorizedCount }})
        </button>
      </div>

      <div v-if="allVaultTags.length > 0" class="vaults-tag-pills" role="group" aria-label="Filter by tag">
        <button
          v-for="tagInfo in allVaultTags"
          :key="tagInfo.tag"
          type="button"
          class="vault-tag-chip"
          :class="{ 'vault-tag-chip--active': selectedTag.toLowerCase() === tagInfo.tag.toLowerCase() }"
          :data-testid="`tag-filter-${tagInfo.tag}`"
          @click="emit('toggle-tag', tagInfo.tag)"
        >
          #{{ tagInfo.tag }} ({{ tagInfo.count }})
        </button>
        <button
          v-if="selectedTag"
          type="button"
          class="vault-tag-clear-btn"
          data-testid="clear-tag-filter"
          @click="emit('clear-tag')"
        >
          Clear tag
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  searchQuery: { type: String, default: '' },
  viewMode: { type: String, default: 'cards' },
  sortMode: { type: String, default: 'manual' },
  selectedCategory: { type: String, default: 'all' },
  selectedTag: { type: String, default: '' },
  totalCount: { type: Number, default: 0 },
  pinnedCount: { type: Number, default: 0 },
  uncategorizedCount: { type: Number, default: 0 },
  categoryCounts: { type: Array, default: () => [] },
  allVaultTags: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'update:searchQuery',
  'update:viewMode',
  'update:sortMode',
  'update:selectedCategory',
  'toggle-tag',
  'clear-tag',
])
</script>
