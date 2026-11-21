<template>
  <BaseModal
    title="Vault settings"
    :subtitle="`${vault.name} (${vault.directory})`"
    aria-label="Vault Settings"
    test-id="vault-settings-modal"
    :close-on-esc="false"
    @close="emit('close')"
  >
    <div class="settings-form">
      <label class="settings-row">
        <span>Show unsupported files</span>
        <input
          v-model="settings.showUnsupportedFiles"
          type="checkbox"
          data-testid="setting-show-unsupported-files"
          @change="emit('persist')"
        />
      </label>
      <label class="settings-row">
        <span>Automatically update internal links on rename/move</span>
        <input
          v-model="settings.autoUpdateLinks"
          type="checkbox"
          data-testid="setting-auto-update-links"
          @change="emit('persist')"
        />
      </label>
      <label class="settings-row">
        <span>Use Wikilinks ([[Note]]) by default</span>
        <input
          v-model="settings.useWikilinks"
          type="checkbox"
          data-testid="setting-use-wikilinks"
          @change="emit('persist')"
        />
      </label>
      <label class="settings-row">
        <span>Default deletion behavior</span>
        <select
          v-model="settings.deleteBehavior"
          class="explorer-create-input"
          data-testid="setting-delete-behavior"
          @change="emit('persist')"
        >
          <option value="trash">Trash (.trash)</option>
          <option value="permanent">Permanent deletion</option>
        </select>
      </label>
      <label class="settings-row">
        <span>Daily notes folder</span>
        <input
          v-model="settings.dailyNotesFolder"
          type="text"
          class="explorer-create-input"
          data-testid="setting-daily-notes-folder"
          placeholder="e.g. Daily"
          @input="emit('persist')"
          @change="emit('persist')"
        />
      </label>
    </div>
  </BaseModal>
</template>

<script setup>
import BaseModal from '../../components/BaseModal.vue'

defineProps({
  vault: { type: Object, required: true },
  settings: { type: Object, required: true },
})

const emit = defineEmits(['close', 'persist'])
</script>
