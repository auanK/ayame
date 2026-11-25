<template>
  <BaseModal
    title="Trash"
    subtitle="Deleted items in this vault"
    aria-label="Vault trash"
    test-id="trash-panel"
    close-test-id="close-trash-modal-button"
    card-class="trash-modal"
    wide
    :close-on-esc="false"
    @close="emit('close')"
  >
    <div v-if="trashError" class="browser-alert browser-error" data-testid="trash-error">
      {{ trashError }}
    </div>

    <div
      v-if="trashRestoreConflict"
      class="trash-conflict-box"
      data-testid="trash-restore-conflict"
    >
      <p class="trash-conflict-text">
        The original path <code>{{ trashRestoreConflict.item.originalPath }}</code> is already occupied. Restore to:
      </p>
      <div class="trash-conflict-form">
        <input
          v-model="trashRestoreConflict.targetPath"
          type="text"
          class="explorer-create-input"
          data-testid="trash-restore-target-input"
        />
        <div class="trash-conflict-actions">
          <button
            type="button"
            class="btn-primary btn-compact"
            data-testid="trash-restore-alternate-submit"
            @click="emit('restore', trashRestoreConflict.item, trashRestoreConflict.targetPath)"
          >
            Restore to destination
          </button>
          <button
            type="button"
            class="btn-secondary btn-compact"
            @click="emit('cancel-conflict')"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>

    <div v-if="trashLoading" class="panel-empty">
      Loading trash…
    </div>
    <div v-else-if="trashItems.length === 0" class="trash-empty" data-testid="trash-empty">
      <p>Trash is empty.</p>
    </div>
    <div v-else class="trash-items-list">
      <div
        v-for="item in trashItems"
        :key="item.id"
        class="trash-item-card"
        data-testid="trash-item"
        :data-trash-id="item.id"
      >
        <div class="trash-item-details">
          <div class="trash-item-meta">
            <strong class="trash-item-name">{{ stripMarkdownExtension(item.name) }}</strong>
            <span class="trash-item-path">Deleted from /{{ item.originalPath }}</span>
          </div>
        </div>
        <div class="trash-item-actions">
          <button
            type="button"
            class="btn-primary btn-compact"
            data-testid="restore-trash-button"
            @click="emit('restore', item)"
          >
            Restore
          </button>
          <button
            type="button"
            class="btn-secondary btn-compact btn-danger"
            data-testid="delete-trash-permanently-button"
            @click="emit('delete-permanently', item)"
          >
            Delete permanently
          </button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup>
import BaseModal from '../../components/BaseModal.vue'

defineProps({
  trashItems: { type: Array, default: () => [] },
  trashLoading: { type: Boolean, default: false },
  trashError: { type: String, default: '' },
  trashRestoreConflict: { type: Object, default: null },
})

const emit = defineEmits(['close', 'restore', 'delete-permanently', 'cancel-conflict'])

const stripMarkdownExtension = (name) => String(name || '').replace(/\.md$/i, '')
</script>
