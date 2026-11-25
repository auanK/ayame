<template>
  <div class="note-context-bar" data-testid="note-context-bar">
    <button
      v-if="vaultName || folderTrail.length > 0"
      type="button"
      class="note-breadcrumbs"
      data-testid="note-breadcrumbs"
      title="Reveal note in explorer"
      @click="emit('reveal-in-explorer')"
    >
      <span v-if="vaultName" class="note-crumb-seg">{{ vaultName }}</span>
      <span v-if="vaultName" class="note-crumb-sep" aria-hidden="true">›</span>
      <template v-for="(seg, idx) in folderTrail" :key="`${idx}-${seg}`">
        <span class="note-crumb-seg">{{ seg }}</span>
        <span class="note-crumb-sep" aria-hidden="true">›</span>
      </template>
      <span class="note-crumb-current">{{ noteStem }}</span>
    </button>
    <span v-else class="note-breadcrumbs note-breadcrumbs--static">
      <span class="note-crumb-current">{{ noteStem }}</span>
    </span>

    <div class="note-quick-tools">
      <button
        type="button"
        class="note-tool-btn"
        :class="{ 'note-tool-btn--active': propertiesVisible }"
        data-testid="note-properties-toggle"
        title="Cycle note properties view (Ctrl+;)"
        @click="emit('cycle-properties')"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M2.5 4h11M2.5 8h7.5M2.5 12h9" stroke-linecap="round" />
        </svg>
        <span>Properties</span>
        <span v-if="propertyCount > 0" class="note-tool-count">{{ propertyCount }}</span>
      </button>
      <button
        type="button"
        class="note-tool-btn note-tool-btn--icon"
        :class="{ 'note-tool-btn--active': !readableLineLength }"
        data-testid="note-width-toggle"
        :title="readableLineLength ? 'Switch to full width' : 'Switch to readable width'"
        aria-label="Toggle readable line length"
        @click="emit('toggle-width')"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M2.5 3.5v9M13.5 3.5v9M5.5 8h5M7 6.5 5.5 8 7 9.5M9 6.5 10.5 8 9 9.5" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <button
        v-if="vaultName"
        type="button"
        class="note-tool-btn note-tool-btn--icon"
        :class="{ 'note-tool-btn--bookmarked': bookmarked }"
        data-testid="note-bookmark-button"
        :aria-pressed="bookmarked ? 'true' : 'false'"
        :title="bookmarked ? 'Remove bookmark' : 'Bookmark note'"
        aria-label="Toggle bookmark"
        @click="emit('toggle-bookmark')"
      >
        <svg viewBox="0 0 16 16" width="12" height="12" :fill="bookmarked ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
          <path d="M8 2.1l1.8 3.6 4 .6-2.9 2.8.7 4L8 11.2 4.4 13.1l.7-4-2.9-2.8 4-.6L8 2.1Z" stroke-linejoin="round" />
        </svg>
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  vaultName: { type: String, default: '' },
  folderTrail: { type: Array, default: () => [] },
  noteStem: { type: String, default: '' },
  propertiesVisible: { type: Boolean, default: false },
  propertyCount: { type: Number, default: 0 },
  readableLineLength: { type: Boolean, default: true },
  bookmarked: { type: Boolean, default: false },
})

const emit = defineEmits(['reveal-in-explorer', 'cycle-properties', 'toggle-width', 'toggle-bookmark'])
</script>
