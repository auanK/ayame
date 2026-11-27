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

    <p v-if="displayItems.length === 0" class="vault-category-empty-drop">
      Drop vault cards here
    </p>
    <ul v-else class="vault-grid" :aria-label="`Vaults in ${group.label}`">
      <template v-for="entry in displayItems" :key="entry.key">
        <li
          v-if="entry.type === 'placeholder'"
          class="vault-placeholder"
          data-testid="vault-placeholder"
          :style="{ height: `${pointerDrag.height}px` }"
          aria-hidden="true"
        />
        <VaultCard
          v-else
          :vault="entry.vault"
          :compact="false"
          :dragging="draggingDirectory === entry.vault.directory"
          :pointer-dragging="pointerDrag?.directory === entry.vault.directory"
          :pointer-drag-style="draggedCardStyle?.(entry.vault.directory)"
          :drop-target="dragOverDirectory === entry.vault.directory && draggingDirectory !== entry.vault.directory"
          :needs-refresh="needsRefresh"
          :operation="operation"
          :selected-tag="selectedTag"
          :cover-url="coverUrlFor(entry.vault)"
          :banner-style="bannerStyleFor(entry.vault)"
          :formatted-time="formatRelativeTime(entry.vault.lastModifiedAt)"
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
      </template>
    </ul>
  </section>
</template>

<script setup>
import { computed } from 'vue'
import VaultCard from './VaultCard.vue'

const props = defineProps({
  group: { type: Object, required: true },
  isDropTarget: { type: Boolean, default: false },
  draggingDirectory: { type: String, default: null },
  dragOverDirectory: { type: String, default: null },
  pointerDrag: { type: Object, default: null },
  pointerDragTarget: { type: Object, default: null },
  draggedCardStyle: { type: Function, default: null },
  needsRefresh: { type: Boolean, default: false },
  operation: { type: String, default: '' },
  selectedTag: { type: String, default: '' },
  coverUrlFor: { type: Function, required: true },
  bannerStyleFor: { type: Function, required: true },
  formatRelativeTime: { type: Function, required: true },
})

const displayItems = computed(() => {
  const drag = props.pointerDrag
  if (!drag) {
    return props.group.items.map((vault) => ({
      type: 'vault',
      key: vault.id || vault.directory,
      vault,
    }))
  }

  let draggedVault = null
  const list = []
  for (const vault of props.group.items) {
    if (vault.directory === drag.directory) {
      draggedVault = vault
    } else {
      list.push({ type: 'vault', key: vault.id || vault.directory, vault })
    }
  }

  if (props.pointerDragTarget?.category === props.group.key) {
    const insertAt = Math.max(0, Math.min(list.length, props.pointerDragTarget.index))
    list.splice(insertAt, 0, { type: 'placeholder', key: '__vault_placeholder__' })
  }

  // Keep dragged card mounted in its source group (positioned fixed out-of-flow)
  if (draggedVault) {
    list.push({
      type: 'vault',
      key: draggedVault.id || draggedVault.directory,
      vault: draggedVault,
    })
  }

  return list
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
