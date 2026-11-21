<template>
  <Teleport to="body" :disabled="isTestEnv">
    <div
      v-if="contextMenu"
      class="explorer-context-menu"
      data-testid="explorer-context-menu"
      role="menu"
      :style="{
        position: 'fixed',
        left: `${position.left}px`,
        top: `${position.top}px`,
        zIndex: 1200,
      }"
      @click.stop
    >
      <template v-if="contextMenu.type === 'empty'">
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-new-note"
          @click="emit('create', 'note', '')"
        >
          New note
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-new-folder"
          @click="emit('create', 'folder', '')"
        >
          New folder
        </button>
      </template>

      <template v-else-if="contextMenu.entry && contextMenu.entry.type === 'directory'">
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-new-note"
          @click="emit('create', 'note', contextMenu.entry.path)"
        >
          New note
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-new-folder"
          @click="emit('create', 'folder', contextMenu.entry.path)"
        >
          New subfolder
        </button>
        <div class="dropdown-divider" />
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-rename"
          @click="emit('relocate', contextMenu.entry, 'rename')"
        >
          Rename
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-move"
          @click="emit('relocate', contextMenu.entry, 'move')"
        >
          Move to…
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-copy-path"
          @click="emit('copy-path', contextMenu.entry)"
        >
          Copy relative path
        </button>
        <div class="dropdown-divider" />
        <button
          type="button"
          class="context-menu-item context-menu-item--danger"
          data-testid="ctx-delete"
          @click="emit('delete', contextMenu.entry)"
        >
          Delete folder
        </button>
      </template>

      <template v-else-if="contextMenu.entry">
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-open"
          @click="emit('open', contextMenu.entry.path)"
        >
          Open
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-open-new-tab"
          @click="emit('open-new-tab', contextMenu.entry.path)"
        >
          Open in new tab
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-bookmark"
          @click="emit('toggle-bookmark', contextMenu.entry.path)"
        >
          {{ isBookmarked ? 'Remove bookmark' : 'Bookmark note' }}
        </button>
        <div class="dropdown-divider" />
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-rename"
          @click="emit('relocate', contextMenu.entry, 'rename')"
        >
          Rename
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-move"
          @click="emit('relocate', contextMenu.entry, 'move')"
        >
          Move to…
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-copy-link"
          @click="emit('copy-link', contextMenu.entry)"
        >
          Copy internal link
        </button>
        <button
          type="button"
          class="context-menu-item"
          data-testid="ctx-copy-path"
          @click="emit('copy-path', contextMenu.entry)"
        >
          Copy relative path
        </button>
        <div class="dropdown-divider" />
        <button
          type="button"
          class="context-menu-item context-menu-item--danger"
          data-testid="ctx-delete"
          @click="emit('delete', contextMenu.entry)"
        >
          Delete note
        </button>
      </template>
    </div>
  </Teleport>
</template>

<script setup>
defineProps({
  contextMenu: { type: Object, default: null },
  position: { type: Object, default: () => ({ left: 0, top: 0 }) },
  isBookmarked: { type: Boolean, default: false },
  isTestEnv: { type: Boolean, default: false },
})

const emit = defineEmits([
  'create',
  'relocate',
  'copy-path',
  'copy-link',
  'delete',
  'open',
  'open-new-tab',
  'toggle-bookmark',
])
</script>
