<template>
  <aside
    class="workspace-right-panel"
    :class="{ 'workspace-right-panel--collapsed': !contextOpen }"
    :style="{ width: `${contextWidth}px` }"
    data-testid="workspace-right-panel"
  >
    <nav
      ref="tabsRef"
      class="right-panel-tabs"
      role="tablist"
      aria-label="Contextual panel views"
      @keydown="handleTabsKeydown"
    >
      <button
        v-for="tab in tabs"
        :key="tab.id"
        type="button"
        class="right-panel-tab"
        :class="{ 'right-panel-tab--active': activeTab === tab.id }"
        role="tab"
        :aria-selected="activeTab === tab.id ? 'true' : 'false'"
        :data-testid="tab.testid"
        :data-panel-tab="tab.id"
        @click="emit('update:activeTab', tab.id)"
      >
        {{ tab.label }}
      </button>
    </nav>

    <div class="right-panel-body">
      <!-- Backlinks Tab -->
      <div v-if="activeTab === 'backlinks'" data-testid="backlinks-panel">
        <h4 class="panel-section-title">Linked mentions ({{ backlinks.linked.length }})</h4>
        <p v-if="backlinks.linked.length === 0" class="panel-empty">No linked mentions yet.</p>
        <button
          v-for="(item, idx) in backlinks.linked"
          :key="`bl-${idx}-${item.sourcePath}`"
          type="button"
          class="panel-list-item"
          data-testid="backlink-item"
          :data-source-path="item.sourcePath"
          @click="emit('open-note', item.sourcePath)"
        >
          <strong class="panel-item-title">{{ item.sourceName }}</strong>
          <span class="panel-item-snippet">{{ item.snippet || item.raw }}</span>
        </button>

        <h4 class="panel-section-title">Unlinked mentions ({{ backlinks.unlinkedMentions.length }})</h4>
        <p v-if="backlinks.unlinkedMentions.length === 0" class="panel-empty">No unlinked mentions.</p>
        <button
          v-for="(item, idx) in backlinks.unlinkedMentions"
          :key="`ul-${idx}-${item.sourcePath}`"
          type="button"
          class="panel-list-item"
          data-testid="unlinked-mention-item"
          :data-source-path="item.sourcePath"
          @click="emit('open-note', item.sourcePath)"
        >
          <strong class="panel-item-title">{{ item.sourceName }}</strong>
          <span class="panel-item-snippet">{{ item.snippet }}</span>
        </button>
      </div>

      <!-- Outgoing Links Tab -->
      <div v-else-if="activeTab === 'outgoing'" data-testid="outgoing-links-panel">
        <h4 class="panel-section-title">Resolved links ({{ outgoingLinks.resolved.length }})</h4>
        <p v-if="outgoingLinks.resolved.length === 0" class="panel-empty">No outgoing resolved links.</p>
        <button
          v-for="(item, idx) in outgoingLinks.resolved"
          :key="`out-res-${idx}-${item.targetPath}`"
          type="button"
          class="panel-list-item"
          data-testid="outgoing-resolved-item"
          :data-target-path="item.targetPath"
          @click="emit('open-note', item.targetPath, item.anchor)"
        >
          <strong class="panel-item-title">{{ item.targetPath }}</strong>
          <span class="panel-item-snippet">{{ item.raw }}</span>
        </button>

        <h4 class="panel-section-title">Pending / Unresolved ({{ outgoingLinks.unresolved.length }})</h4>
        <p v-if="outgoingLinks.unresolved.length === 0" class="panel-empty">No pending links.</p>
        <button
          v-for="(item, idx) in outgoingLinks.unresolved"
          :key="`out-unres-${idx}-${item.raw}`"
          type="button"
          class="panel-list-item panel-list-item--pending"
          data-testid="outgoing-unresolved-item"
          :data-raw-target="item.rawTarget"
          @click="emit('create-missing-link', item.raw, item.kind)"
        >
          <strong class="panel-item-title">{{ item.rawTarget }} (create)</strong>
          <span class="panel-item-snippet">{{ item.raw }}</span>
        </button>
      </div>

      <!-- Outline Tab -->
      <div v-else-if="activeTab === 'outline'" data-testid="outline-panel">
        <h4 class="panel-section-title">Document Outline</h4>
        <p v-if="outline.length === 0" class="panel-empty">No headings in this note.</p>
        <button
          v-for="(heading, idx) in outline"
          :key="`h-${idx}-${heading.line}`"
          type="button"
          class="panel-list-item"
          data-testid="outline-heading-item"
          :style="{ paddingLeft: `${(heading.level - 1) * 10 + 8}px` }"
          @click="emit('select-anchor', heading.text)"
        >
          <span class="panel-item-title">H{{ heading.level }} · {{ heading.text }}</span>
        </button>
      </div>

      <!-- Tags Tab -->
      <div v-else-if="activeTab === 'tags'" data-testid="tags-panel">
        <h4 class="panel-section-title">Vault Tags</h4>
        <div class="panel-tags-cloud">
          <button
            v-for="tagEntry in allTags"
            :key="tagEntry.tag"
            type="button"
            class="tag-cloud-chip"
            :class="{ 'tag-cloud-chip--active': activeTagFilter.toLowerCase() === tagEntry.tag.toLowerCase() }"
            data-testid="vault-tag-item"
            :data-tag-name="tagEntry.tag"
            @click="emit('update:activeTagFilter', tagEntry.tag)"
          >
            #{{ tagEntry.tag }} ({{ tagEntry.count }})
          </button>
        </div>
        <div v-if="activeTagFilter" class="tag-filter-results">
          <div class="tag-filter-header">
            <strong>Notes with #{{ activeTagFilter }}</strong>
            <button type="button" class="btn-secondary btn-compact" @click="emit('update:activeTagFilter', '')">
              Clear
            </button>
          </div>
          <button
            v-for="note in filteredTagNotes"
            :key="note.path"
            type="button"
            class="panel-list-item"
            data-testid="tag-result-item"
            :data-note-path="note.path"
            @click="emit('open-note', note.path)"
          >
            <strong class="panel-item-title">{{ note.title }}</strong>
            <span class="panel-item-snippet">{{ note.path }}</span>
          </button>
        </div>
      </div>

      <!-- Search Tab -->
      <div v-else-if="activeTab === 'search'" data-testid="search-panel">
        <input
          :value="searchQuery"
          type="search"
          class="explorer-create-input"
          data-testid="vault-search-input"
          placeholder="Search notes, #tags, aliases…"
          @input="emit('update:searchQuery', $event.target.value)"
        />
        <div class="vault-search-results" data-testid="vault-search-results">
          <button
            v-for="res in searchResults"
            :key="res.path"
            type="button"
            class="panel-list-item"
            data-testid="search-result-item"
            :data-note-path="res.path"
            @click="emit('open-note', res.path)"
          >
            <strong class="panel-item-title">{{ res.name }}</strong>
            <span class="panel-item-snippet">{{ res.snippet || res.path }}</span>
          </button>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { nextTick, ref } from 'vue'

const props = defineProps({
  contextOpen: { type: Boolean, default: false },
  contextWidth: { type: Number, default: 280 },
  tabs: { type: Array, required: true },
  activeTab: { type: String, required: true },
  backlinks: { type: Object, required: true },
  outgoingLinks: { type: Object, required: true },
  outline: { type: Array, default: () => [] },
  allTags: { type: Array, default: () => [] },
  activeTagFilter: { type: String, default: '' },
  filteredTagNotes: { type: Array, default: () => [] },
  searchQuery: { type: String, default: '' },
  searchResults: { type: Array, default: () => [] },
})

const emit = defineEmits([
  'update:activeTab',
  'update:activeTagFilter',
  'update:searchQuery',
  'open-note',
  'create-missing-link',
  'select-anchor',
])

const tabsRef = ref(null)

const handleTabsKeydown = (event) => {
  const navEl = tabsRef.value
  if (!navEl) return
  const count = props.tabs.length
  const currentIdx = props.tabs.findIndex((t) => t.id === props.activeTab)
  if (currentIdx < 0) return

  let nextIdx = -1
  if (event.key === 'ArrowRight') {
    nextIdx = (currentIdx + 1) % count
  } else if (event.key === 'ArrowLeft') {
    nextIdx = (currentIdx - 1 + count) % count
  } else if (event.key === 'Home') {
    nextIdx = 0
  } else if (event.key === 'End') {
    nextIdx = count - 1
  } else {
    return
  }

  event.preventDefault()
  const nextTabId = props.tabs[nextIdx].id
  emit('update:activeTab', nextTabId)
  nextTick(() => {
    const btn = tabsRef.value?.querySelector(`[data-panel-tab="${nextTabId}"]`)
    btn?.focus?.()
  })
}

const ensureTabVisible = (tabId) => {
  const navEl = tabsRef.value
  if (!navEl || !tabId) return
  const tabEl = navEl.querySelector(`[data-panel-tab="${tabId}"]`)
  if (!tabEl) return

  const navRect = navEl.getBoundingClientRect?.()
  const tabRect = tabEl.getBoundingClientRect?.()
  const hasMeasurements = Boolean(navRect && tabRect && navRect.width > 0 && tabRect.width > 0)
  if (hasMeasurements && tabRect.left >= navRect.left && tabRect.right <= navRect.right) {
    return
  }

  if (typeof tabEl.scrollIntoView === 'function') {
    tabEl.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  }
}

defineExpose({ ensureTabVisible })
</script>
