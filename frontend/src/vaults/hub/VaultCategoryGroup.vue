<template>
  <section
    class="vault-category-section"
    :class="{ 'vault-category-section--drop': isDropTarget }"
    data-testid="category-drop-zone"
    :data-category-key="group.key"
    @dragover.prevent="emit('drag-over', group.key)"
    @dragleave="emit('drag-leave', group.key, $event)"
    @drop.prevent="emit('drop-category', group.key, $event)"
  >
    <header class="vault-category-header">
      <h3>{{ group.label }}</h3>
      <span class="vault-category-count">{{ group.items.length }}</span>
    </header>

    <p v-if="group.items.length === 0" class="vault-category-empty-drop">
      Drop vault cards here
    </p>
    <ul v-else class="vault-grid" :aria-label="`Vaults in ${group.label}`">
      <VaultCard
        v-for="vault in group.items"
        :key="vault.id || vault.directory"
        :vault="vault"
        :compact="false"
        :dragging="draggingDirectory === vault.directory"
        :drop-target="dragOverDirectory === vault.directory && draggingDirectory !== vault.directory"
        :needs-refresh="needsRefresh"
        :operation="operation"
        :selected-tag="selectedTag"
        :cover-url="coverUrlFor(vault)"
        :banner-style="bannerStyleFor(vault)"
        :formatted-time="formatRelativeTime(vault.lastModifiedAt)"
        @open="emit('open', $event)"
        @open-card="emit('open-card', $event)"
        @edit="emit('edit', $event)"
        @reset="emit('reset', $event)"
        @trash="emit('trash', $event)"
        @toggle-pin="emit('toggle-pin', $event)"
        @upload-cover="emit('upload-cover', $event)"
        @toggle-tag="emit('toggle-tag', $event)"
        @drag-start="(v, e) => emit('card-drag-start', v, e)"
        @drag-over="(v, e) => emit('card-drag-over', v, e)"
        @drag-leave="(v, e) => emit('card-drag-leave', v, e)"
        @drop-card="(v, e) => emit('card-drop', v, e)"
        @drag-end="emit('card-drag-end')"
      />
    </ul>
  </section>
</template>

<script setup>
import VaultCard from './VaultCard.vue'

defineProps({
  group: { type: Object, required: true },
  isDropTarget: { type: Boolean, default: false },
  draggingDirectory: { type: String, default: null },
  dragOverDirectory: { type: String, default: null },
  needsRefresh: { type: Boolean, default: false },
  operation: { type: String, default: '' },
  selectedTag: { type: String, default: '' },
  coverUrlFor: { type: Function, required: true },
  bannerStyleFor: { type: Function, required: true },
  formatRelativeTime: { type: Function, required: true },
})

const emit = defineEmits([
  'drag-over',
  'drag-leave',
  'drop-category',
  'open',
  'open-card',
  'edit',
  'reset',
  'trash',
  'toggle-pin',
  'upload-cover',
  'toggle-tag',
  'card-drag-start',
  'card-drag-over',
  'card-drag-leave',
  'card-drop',
  'card-drag-end',
])
</script>
