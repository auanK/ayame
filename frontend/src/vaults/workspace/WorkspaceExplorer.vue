<template>
  <aside
    class="workspace-explorer"
    :class="{ 'workspace-explorer--collapsed': !explorerOpen }"
    :style="{ width: `${explorerWidth}px` }"
    data-testid="vault-explorer"
    @contextmenu.prevent="emit('empty-contextmenu', $event)"
  >
    <div class="explorer-header">
      <span class="explorer-title">Files</span>
      <div class="explorer-header-actions">
        <button
          type="button"
          class="explorer-action-btn"
          data-testid="explorer-add-button"
          title="New item"
          aria-label="New item"
          @click.stop="emit('update:showAddMenu', !showAddMenu)"
        >
          +
        </button>
        <button
          v-if="selectedFile"
          type="button"
          class="explorer-action-btn"
          data-testid="reveal-active-file-button"
          title="Reveal active note in explorer"
          @click="emit('reveal-active-file')"
        >
          Reveal
        </button>

        <div
          v-show="showAddMenu"
          class="explorer-add-menu"
          role="menu"
          @click.stop
        >
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="new-note-button"
            @click="emit('update:showAddMenu', false); emit('start-create', 'note', selectedFolderPath)"
          >
            New note
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="new-folder-button"
            @click="emit('update:showAddMenu', false); emit('start-create', 'folder', selectedFolderPath)"
          >
            New folder
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="daily-note-button"
            @click="emit('update:showAddMenu', false); emit('open-daily-note')"
          >
            Today's daily note
          </button>
        </div>
      </div>
    </div>

    <!-- Relocate Confirmation / Form -->
    <div
      v-if="relocateState?.stage === 'confirm'"
      class="explorer-create-form"
      data-testid="relocate-confirmation"
      role="dialog"
      aria-label="Confirm moving a note with unsaved changes"
    >
      <p class="draft-warning">This note has unsaved changes. Moving it will discard those changes.</p>
      <p>Source: <code>{{ relocateState.sourcePath }}</code></p>
      <p>Destination: <code>{{ relocateState.targetPath }}</code></p>
      <p v-if="relocateState.error" class="relocate-error" data-testid="relocate-error">
        {{ relocateState.error }}
      </p>
      <div class="explorer-create-actions">
        <button
          type="button"
          class="btn-secondary btn-compact"
          data-testid="relocate-keep-editing"
          @click="emit('cancel-relocate')"
        >
          Keep editing
        </button>
        <button
          type="button"
          class="btn-primary btn-compact"
          data-testid="relocate-confirm"
          :disabled="relocateState.loading"
          @click="emit('confirm-relocate')"
        >
          {{ relocateState.mode === 'rename' ? 'Discard changes and rename' : 'Discard changes and move' }}
        </button>
      </div>
    </div>

    <div
      v-else-if="relocateState?.stage === 'uncertain'"
      class="explorer-create-form"
      data-testid="relocate-uncertain"
      role="alert"
    >
      <p class="relocate-error" data-testid="relocate-error">{{ relocateState.error }}</p>
      <button
        type="button"
        class="btn-secondary btn-compact"
        data-testid="relocate-refresh"
        :disabled="refreshing"
        @click="emit('refresh')"
      >
        {{ refreshing ? 'Refreshing…' : 'Refresh vault' }}
      </button>
    </div>

    <form
      v-else-if="relocateState?.origin === 'manual' && (relocateState.stage === 'edit' || relocateState.stage === 'executing')"
      class="explorer-create-form"
      data-testid="relocate-form"
      @submit.prevent="emit('submit-relocate')"
    >
      <label class="explorer-create-label">
        {{ relocateState.mode === 'move' ? 'Move entry to path:' : 'Rename entry:' }}
      </label>
      <input
        ref="relocateInputRef"
        v-model="relocateState.targetPath"
        type="text"
        class="explorer-create-input"
        data-testid="relocate-input"
        :disabled="relocateState.loading"
        @keydown.esc.prevent="emit('cancel-relocate')"
      />
      <p v-if="relocateState.error" class="relocate-error" data-testid="relocate-error">
        {{ relocateState.error }}
      </p>
      <p v-if="relocateState.loading" aria-live="polite">Moving entry…</p>
      <div class="explorer-create-actions">
        <button
          type="button"
          class="btn-primary btn-compact"
          data-testid="relocate-submit"
          :disabled="relocateState.loading"
          @click="emit('submit-relocate')"
        >
          Apply
        </button>
        <button
          type="button"
          class="btn-secondary btn-compact"
          data-testid="relocate-cancel"
          :disabled="relocateState.loading"
          @click="emit('cancel-relocate')"
        >
          Cancel
        </button>
      </div>
    </form>

    <!-- Delete Confirmation -->
    <div
      v-if="deleteConfirmState"
      class="explorer-create-form"
      data-testid="delete-confirm-dialog"
      role="dialog"
      aria-label="Confirm deletion"
    >
      <p class="explorer-create-label">
        Delete <code>{{ deleteConfirmState.entry.path }}</code>?
      </p>
      <p v-if="deleteConfirmState.error" class="relocate-error">{{ deleteConfirmState.error }}</p>
      <p
        v-if="deleteConfirmState.hasUnsavedDraft"
        class="draft-warning"
        data-testid="delete-draft-warning"
      >
        There are unsaved changes in the affected notes. Do you want to discard them and proceed?
      </p>
      <div class="explorer-create-actions">
        <button
          type="button"
          class="btn-primary btn-compact"
          data-testid="confirm-trash-button"
          :disabled="deleteConfirmState.loading"
          @click="emit('confirm-delete', 'trash')"
        >
          Move to trash
        </button>
        <button
          type="button"
          class="btn-secondary btn-compact"
          data-testid="confirm-permanent-delete-button"
          :disabled="deleteConfirmState.loading"
          @click="emit('confirm-delete', 'permanent')"
        >
          Delete permanently
        </button>
        <button
          type="button"
          class="btn-secondary btn-compact"
          @click="emit('cancel-delete')"
        >
          Cancel
        </button>
      </div>
    </div>

    <div
      v-if="createError"
      class="browser-alert browser-error explorer-alert"
      data-testid="explorer-create-error"
      role="alert"
    >
      {{ createError }}
    </div>

    <div
      v-if="stale"
      class="browser-alert browser-stale explorer-alert"
      data-testid="browser-stale-warning"
      role="status"
    >
      Could not refresh vault tree. Showing last loaded entries.
    </div>

    <!-- Bookmarked Notes -->
    <section
      v-if="bookmarkedPaths.length > 0"
      class="explorer-bookmarks"
      data-testid="explorer-bookmarks"
      aria-label="Bookmarked notes"
    >
      <button
        type="button"
        class="explorer-bookmarks-header"
        :aria-expanded="bookmarksExpanded ? 'true' : 'false'"
        @click="bookmarksExpanded = !bookmarksExpanded"
      >
        <span class="tree-chevron" aria-hidden="true">{{ bookmarksExpanded ? '▾' : '▸' }}</span>
        <span>Bookmarked</span>
        <span class="explorer-bookmarks-count">{{ bookmarkedPaths.length }}</span>
      </button>
      <div v-if="bookmarksExpanded" class="explorer-bookmarks-list">
        <div
          v-for="bmPath in bookmarkedPaths"
          :key="bmPath"
          class="tree-row-wrapper explorer-bookmark-row"
        >
          <button
            type="button"
            class="tree-row tree-file explorer-bookmark-btn"
            :class="{ 'tree-file--active': selectedFile === bmPath }"
            data-testid="bookmark-item"
            :data-bookmark-path="bmPath"
            :title="bmPath"
            @click="emit('select-note', bmPath)"
            @dblclick.prevent="emit('select-note', bmPath, { newTab: true, fromDoubleClick: true })"
            @click.middle.prevent="emit('select-note', bmPath, { newTab: true })"
          >
            <span class="tree-label">{{ stripMarkdownExtension(bmPath.split('/').pop()) }}</span>
          </button>
          <button
            type="button"
            class="tree-row-menu-btn"
            data-testid="remove-bookmark-button"
            :data-bookmark-path="bmPath"
            aria-label="Remove bookmark"
            title="Remove bookmark"
            @click.stop="emit('toggle-bookmark', bmPath)"
          >
            ×
          </button>
        </div>
      </div>
    </section>

    <!-- File Tree -->
    <div
      class="workspace-tree"
      :class="{
        'workspace-tree--drop-valid': dropTarget?.path === '' && dropTarget.valid,
        'workspace-tree--drop-invalid': dropTarget?.path === '' && dropTarget && !dropTarget.valid,
      }"
      role="tree"
      data-testid="workspace-tree"
      @dragover.self.prevent="emit('drag-over-folder', '', $event)"
      @dragleave.self="emit('drag-leave-target', '', $event)"
      @drop.self.prevent="emit('drop-on-folder', '')"
      @contextmenu.prevent="emit('empty-contextmenu', $event)"
    >
      <div
        v-if="loadingRoot"
        class="browser-loading"
        data-testid="browser-loading"
        role="status"
      >
        Loading notes…
      </div>

      <div
        v-else-if="rootError"
        class="browser-alert browser-error"
        data-testid="browser-error"
        role="alert"
      >
        <p>{{ rootError }}</p>
        <button
          type="button"
          class="btn-secondary btn-compact"
          data-testid="retry-browser-button"
          @click="emit('retry-root')"
        >
          Try again
        </button>
      </div>

      <template v-else>
        <!-- Inline Create at Root -->
        <form
          v-if="createMode && !selectedFolderPath"
          class="tree-row tree-row--create"
          :style="{ paddingLeft: '10px' }"
          data-testid="new-entry-form"
          @submit.prevent="emit('submit-create')"
        >
          <input
            ref="createInputRef"
            :value="newEntryName"
            type="text"
            class="tree-inline-input"
            data-testid="new-entry-input"
            :placeholder="createMode === 'folder' ? 'Folder name' : 'Note name'"
            :disabled="creating"
            @input="emit('update:newEntryName', $event.target.value)"
            @keydown.esc.prevent="emit('cancel-create')"
          />
          <div class="tree-create-actions">
            <button
              type="button"
              class="tree-btn-action"
              data-testid="new-entry-submit"
              :disabled="creating"
              title="Create"
              aria-label="Create"
              @click="emit('submit-create')"
            >
              Create
            </button>
            <button
              type="button"
              class="tree-btn-action"
              data-testid="new-entry-cancel"
              :disabled="creating"
              title="Cancel"
              aria-label="Cancel"
              @click="emit('cancel-create')"
            >
              Cancel
            </button>
          </div>
        </form>

        <div
          v-if="treeRows.length === 0 && !createMode"
          class="browser-empty"
          data-testid="browser-empty"
        >
          This vault is empty.
        </div>

        <template v-for="row in treeRows" :key="`${row.entry.type}:${row.entry.path}`">
          <template v-if="row.isDir">
            <div
              class="tree-row-wrapper"
              :class="{
                'tree-row-wrapper--dragging': draggedEntry?.path === row.entry.path,
                'tree-row-wrapper--drop-valid': dropTarget?.path === row.entry.path && dropTarget.valid,
                'tree-row-wrapper--drop-invalid': dropTarget?.path === row.entry.path && dropTarget && !dropTarget.valid,
              }"
              :data-entry-path="row.entry.path"
              draggable="true"
              @dragstart.stop="emit('drag-start', row.entry, $event)"
              @dragend="emit('drag-end')"
              @dragover.stop.prevent="emit('drag-over-folder', row.entry.path, $event)"
              @dragleave.stop="emit('drag-leave-target', row.entry.path, $event)"
              @drop.stop.prevent="emit('drop-on-folder', row.entry.path)"
              @contextmenu.prevent.stop="emit('open-contextmenu', $event, row.entry)"
            >
              <button
                type="button"
                class="tree-row tree-folder"
                :class="{ 'tree-folder--selected': selectedFolderPath === row.entry.path }"
                data-testid="open-directory-button"
                :data-folder-path="row.entry.path"
                :aria-expanded="row.isExpanded ? 'true' : 'false'"
                :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
                @click="emit('toggle-folder', row.entry.path)"
              >
                <span class="tree-chevron" aria-hidden="true">{{ row.isExpanded ? '▾' : '▸' }}</span>
                <span class="tree-label">{{ row.entry.name }}</span>
              </button>
              <button
                type="button"
                class="tree-row-menu-btn"
                data-testid="entry-context-button"
                :data-entry-path="row.entry.path"
                aria-label="Folder actions"
                title="Folder actions"
                @click.stop="emit('open-contextmenu', $event, row.entry)"
              >
                …
              </button>
            </div>

            <!-- Inline Create inside folder -->
            <form
              v-if="createMode && selectedFolderPath === row.entry.path"
              class="tree-row tree-row--create"
              :style="{ paddingLeft: `${(row.depth + 1) * 14 + 10}px` }"
              data-testid="new-entry-form"
              @submit.prevent="emit('submit-create')"
            >
              <input
                ref="createInputRef"
                :value="newEntryName"
                type="text"
                class="tree-inline-input"
                data-testid="new-entry-input"
                :placeholder="createMode === 'folder' ? 'Folder name' : 'Note name'"
                :disabled="creating"
                @input="emit('update:newEntryName', $event.target.value)"
                @keydown.esc.prevent="emit('cancel-create')"
              />
              <div class="tree-create-actions">
                <button
                  type="button"
                  class="tree-btn-action"
                  data-testid="new-entry-submit"
                  :disabled="creating"
                  title="Create"
                  aria-label="Create"
                  @click="emit('submit-create')"
                >
                  Create
                </button>
                <button
                  type="button"
                  class="tree-btn-action"
                  data-testid="new-entry-cancel"
                  :disabled="creating"
                  title="Cancel"
                  aria-label="Cancel"
                  @click="emit('cancel-create')"
                >
                  Cancel
                </button>
              </div>
            </form>
          </template>

          <div
            v-else-if="row.isMarkdown"
            class="tree-row-wrapper"
            :class="{
              'tree-row-wrapper--dragging': draggedEntry?.path === row.entry.path,
              'tree-row-wrapper--drop-invalid': dropTarget?.path === row.entry.path && dropTarget && !dropTarget.valid,
            }"
            :data-entry-path="row.entry.path"
            draggable="true"
            @dragstart.stop="emit('drag-start', row.entry, $event)"
            @dragend="emit('drag-end')"
            @dragover.stop.prevent="emit('drag-over-file', row.entry.path, $event)"
            @dragleave.stop="emit('drag-leave-target', row.entry.path, $event)"
            @drop.stop.prevent="emit('drag-end')"
            @contextmenu.prevent.stop="emit('open-contextmenu', $event, row.entry)"
          >
            <button
              type="button"
              class="tree-row tree-file"
              :class="{ 'tree-file--active': selectedFile === row.entry.path }"
              data-testid="open-file-button"
              :data-file-path="row.entry.path"
              :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
              @click="emit('open-file', row.entry)"
              @dblclick.prevent="emit('open-file', row.entry, { newTab: true, fromDoubleClick: true })"
              @click.middle.prevent="emit('open-file', row.entry, { newTab: true })"
            >
              <span class="tree-label">{{ stripMarkdownExtension(row.entry.name) }}</span>
            </button>
            <button
              type="button"
              class="tree-row-menu-btn"
              data-testid="entry-context-button"
              :data-entry-path="row.entry.path"
              aria-label="Note actions"
              title="Note actions"
              @click.stop="emit('open-contextmenu', $event, row.entry)"
            >
              …
            </button>
          </div>

          <div
            v-else-if="showUnsupportedFiles"
            class="tree-row tree-file tree-file--unsupported"
            :class="{ 'tree-file--drop-invalid': dropTarget?.path === row.entry.path && dropTarget && !dropTarget.valid }"
            :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
            @dragover.stop.prevent="emit('drag-over-file', row.entry.path, $event)"
            @dragleave.stop="emit('drag-leave-target', row.entry.path, $event)"
            @drop.stop.prevent="emit('drag-end')"
          >
            <span class="tree-label">{{ row.entry.name }}</span>
          </div>
        </template>
      </template>
    </div>
  </aside>
</template>

<script setup>
import { ref } from 'vue'

defineProps({
  explorerOpen: { type: Boolean, default: true },
  explorerWidth: { type: Number, default: 256 },
  showAddMenu: { type: Boolean, default: false },
  selectedFile: { type: String, default: null },
  selectedFolderPath: { type: String, default: '' },
  relocateState: { type: Object, default: null },
  deleteConfirmState: { type: Object, default: null },
  createError: { type: String, default: '' },
  stale: { type: Boolean, default: false },
  refreshing: { type: Boolean, default: false },
  bookmarkedPaths: { type: Array, default: () => [] },
  loadingRoot: { type: Boolean, default: false },
  rootError: { type: String, default: '' },
  createMode: { type: String, default: '' },
  newEntryName: { type: String, default: '' },
  creating: { type: Boolean, default: false },
  treeRows: { type: Array, default: () => [] },
  draggedEntry: { type: Object, default: null },
  dropTarget: { type: Object, default: null },
  showUnsupportedFiles: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:showAddMenu',
  'update:newEntryName',
  'empty-contextmenu',
  'reveal-active-file',
  'start-create',
  'open-daily-note',
  'cancel-relocate',
  'confirm-relocate',
  'submit-relocate',
  'refresh',
  'confirm-delete',
  'cancel-delete',
  'select-note',
  'toggle-bookmark',
  'drag-over-folder',
  'drag-over-file',
  'drag-leave-target',
  'drop-on-folder',
  'drag-start',
  'drag-end',
  'retry-root',
  'submit-create',
  'cancel-create',
  'open-contextmenu',
  'toggle-folder',
  'open-file',
])

const bookmarksExpanded = ref(true)
const createInputRef = ref(null)
const relocateInputRef = ref(null)

const stripMarkdownExtension = (name) => String(name || '').replace(/\.md$/i, '')

const focusCreateInput = () => {
  const el = Array.isArray(createInputRef.value) ? createInputRef.value[0] : createInputRef.value
  el?.focus?.()
}

const focusRelocateInput = () => {
  relocateInputRef.value?.focus?.()
}

defineExpose({ focusCreateInput, focusRelocateInput })
</script>
