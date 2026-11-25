<template>
  <div class="editor-bottom-hud">
    <button
      v-if="backlinkCount > 0"
      type="button"
      class="editor-hud-pill editor-hud-pill--interactive"
      data-testid="note-backlinks-hud"
      @click="emit('open-backlinks')"
    >
      {{ backlinkCount }} {{ backlinkCount === 1 ? 'backlink' : 'backlinks' }}
    </button>
    <div class="editor-word-count" data-testid="markdown-word-count">
      {{ words }} {{ words === 1 ? 'word' : 'words' }} · {{ readingMinutes }} min read
    </div>
  </div>
</template>

<script setup>
defineProps({
  backlinkCount: { type: Number, default: 0 },
  words: { type: Number, default: 0 },
  readingMinutes: { type: Number, default: 1 },
})

const emit = defineEmits(['open-backlinks'])
</script>
