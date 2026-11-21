<template>
  <div class="workspace-empty-state" data-testid="workspace-empty-state">
    <div class="workspace-empty-card">
      <AyameMark :size="26" />
      <h3>No note open</h3>
      <p class="workspace-empty-subtitle">
        {{ vaultName }} · {{ knownMarkdownFiles.length }} {{ knownMarkdownFiles.length === 1 ? 'note' : 'notes' }} · {{ tagsCount }} {{ tagsCount === 1 ? 'tag' : 'tags' }}
      </p>
      <div class="workspace-empty-actions">
        <button
          type="button"
          class="btn btn-primary btn-compact"
          @click="emit('create-note')"
        >
          Create new note
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-compact"
          data-testid="welcome-daily-note-button"
          @click="emit('daily-note')"
        >
          Daily note
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-compact"
          data-testid="welcome-quick-switcher-button"
          @click="emit('quick-switcher')"
        >
          Quick switcher
        </button>
        <button
          type="button"
          class="btn btn-secondary btn-compact"
          data-testid="welcome-graph-button"
          @click="emit('open-graph')"
        >
          Open graph
        </button>
      </div>
      <div v-if="knownMarkdownFiles.length > 0" class="workspace-empty-recent">
        <p class="workspace-empty-section-label">Notes in this vault</p>
        <button
          v-for="notePath in knownMarkdownFiles.slice(0, 4)"
          :key="`welcome-${notePath}`"
          type="button"
          class="workspace-empty-note-item"
          data-testid="welcome-recent-note"
          @click="emit('select-note', notePath)"
        >
          <span class="workspace-empty-note-name">{{ stripMarkdownExtension(notePath.split('/').pop()) }}</span>
          <span v-if="notePath.includes('/')" class="workspace-empty-note-dir">{{ notePath.slice(0, notePath.lastIndexOf('/')) }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import AyameMark from '../../auth/AyameMark.vue'

defineProps({
  vaultName: { type: String, required: true },
  knownMarkdownFiles: { type: Array, default: () => [] },
  tagsCount: { type: Number, default: 0 },
})

const emit = defineEmits(['create-note', 'daily-note', 'quick-switcher', 'open-graph', 'select-note'])

const stripMarkdownExtension = (name) => String(name || '').replace(/\.md$/i, '')
</script>
