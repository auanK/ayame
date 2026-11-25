<template>
  <BaseModal
    :title-id="mode === 'create' ? 'create-vault-modal-title' : 'edit-vault-modal-title'"
    :test-id="mode === 'create' ? 'create-vault-modal' : 'vault-editor-modal'"
    :close-disabled="Boolean(operation)"
    wide
    @close="emit('close')"
  >
    <form
      class="vault-editor"
      :data-testid="mode === 'create' ? 'create-vault-form' : 'vault-editor'"
      @submit.prevent="handleSubmit"
    >
      <header class="ayame-modal-header">
        <div class="ayame-modal-heading">
          <h3 :id="mode === 'create' ? 'create-vault-modal-title' : 'edit-vault-modal-title'">
            {{ mode === 'create' ? 'Create new vault' : 'Customize vault' }}
          </h3>
          <p v-if="mode === 'create'" class="ayame-modal-subtitle">
            Creates a vault folder and registers its hub metadata.
          </p>
          <p v-else-if="vault" class="vault-directory">{{ vault.directory }}/</p>
        </div>
        <button
          type="button"
          class="ayame-modal-close"
          aria-label="Close"
          :disabled="Boolean(operation)"
          @click="emit('close')"
        >
          ×
        </button>
      </header>

      <div class="ayame-modal-body">
        <div class="vault-editor-fields">
          <div class="form-group">
            <label class="form-label" :for="mode === 'create' ? 'create-vault-name' : 'vault-name'">
              Display name
            </label>
            <input
              :id="mode === 'create' ? 'create-vault-name' : 'vault-name'"
              v-model="draft.name"
              class="form-input"
              :name="mode === 'edit' ? 'name' : undefined"
              type="text"
              maxlength="100"
              :autocomplete="mode === 'edit' ? 'off' : undefined"
              :placeholder="mode === 'create' ? 'e.g. Research Hub' : undefined"
              :disabled="Boolean(operation)"
              required
            />
          </div>

          <div v-if="mode === 'create'" class="form-group">
            <label class="form-label" for="create-vault-dir">Folder name (optional)</label>
            <input
              id="create-vault-dir"
              v-model="draft.directory"
              class="form-input"
              type="text"
              maxlength="100"
              placeholder="Auto-derived from display name"
              :disabled="Boolean(operation)"
            />
          </div>

          <div class="form-group">
            <label class="form-label" :for="mode === 'create' ? 'create-vault-category' : 'edit-vault-category'">
              Category
            </label>
            <input
              :id="mode === 'create' ? 'create-vault-category' : 'edit-vault-category'"
              v-model="draft.category"
              class="form-input"
              type="text"
              maxlength="60"
              list="vault-categories-list"
              :placeholder="mode === 'create' ? 'e.g. Worldbuilding, Study' : 'Uncategorized'"
              :disabled="Boolean(operation)"
            />
          </div>

          <div class="form-group" :class="{ 'vault-editor-field-full': mode === 'edit' }">
            <label class="form-label" :for="mode === 'create' ? 'create-vault-description' : 'edit-vault-description'">
              Description
            </label>
            <input
              :id="mode === 'create' ? 'create-vault-description' : 'edit-vault-description'"
              v-model="draft.description"
              class="form-input"
              type="text"
              maxlength="280"
              :placeholder="mode === 'create' ? 'Short summary' : 'Short summary of this vault'"
              :disabled="Boolean(operation)"
            />
          </div>
        </div>

        <div class="form-group">
          <label class="form-label" :for="mode === 'create' ? 'create-vault-tag-input' : 'edit-vault-tag-input'">
            Tags
          </label>
          <TagEditor
            ref="tagEditorRef"
            v-model="draft.tags"
            :input-id="mode === 'create' ? 'create-vault-tag-input' : 'edit-vault-tag-input'"
            :placeholder="mode === 'create' ? 'Add tag and press Enter' : 'Add tag + Enter'"
            :disabled="Boolean(operation)"
          />
        </div>

        <div class="vault-editor-media-row">
          <div class="form-group">
            <span class="form-label">Accent</span>
            <AccentSwatchPicker v-model="draft.accentColor" />
          </div>

          <div v-if="mode === 'edit' && vault" class="vault-cover-controls">
            <span class="form-label">Cover image</span>
            <div class="vault-cover-preview">
              <img
                v-if="vault.hasCover"
                :src="coverUrl"
                class="vault-cover-thumb"
                alt=""
              />
              <button
                type="button"
                class="btn btn-secondary btn-compact"
                data-testid="editor-upload-cover-button"
                :disabled="Boolean(operation)"
                @click="emit('upload-cover', vault)"
              >
                Upload cover
              </button>
              <button
                v-if="vault.hasCover"
                type="button"
                class="btn btn-secondary btn-compact"
                data-testid="remove-cover-button"
                :disabled="Boolean(operation)"
                @click="emit('remove-cover', vault)"
              >
                Remove cover
              </button>
            </div>
          </div>
        </div>

        <label v-if="mode === 'create'" class="vault-checkbox-row">
          <input v-model="draft.createWelcomeNote" type="checkbox" :disabled="Boolean(operation)" />
          <span>Create an introductory Welcome.md note</span>
        </label>

        <p v-if="errorMessage" class="error-message" role="alert" aria-live="polite">
          {{ errorMessage }}
        </p>
      </div>

      <div class="ayame-modal-footer">
        <button type="button" class="btn btn-secondary" :disabled="Boolean(operation)" @click="emit('close')">
          Cancel
        </button>
        <button
          type="submit"
          class="btn btn-primary"
          :data-testid="mode === 'create' ? 'create-vault-submit' : 'save-vault-button'"
          :disabled="Boolean(operation)"
        >
          <template v-if="mode === 'create'">
            {{ operation === 'creating' ? 'Creating...' : 'Create vault' }}
          </template>
          <template v-else>
            {{ operation === 'saving' ? 'Saving...' : 'Save' }}
          </template>
        </button>
      </div>
    </form>
  </BaseModal>
</template>

<script setup>
import { ref } from 'vue'
import BaseModal from '../../components/BaseModal.vue'
import TagEditor from '../../components/TagEditor.vue'
import AccentSwatchPicker from '../../components/AccentSwatchPicker.vue'

defineProps({
  mode: {
    type: String,
    required: true, // 'create' | 'edit'
  },
  draft: {
    type: Object,
    required: true,
  },
  vault: {
    type: Object,
    default: null,
  },
  coverUrl: {
    type: String,
    default: '',
  },
  operation: {
    type: String,
    default: '',
  },
  errorMessage: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['close', 'submit', 'upload-cover', 'remove-cover'])

const tagEditorRef = ref(null)

const handleSubmit = () => {
  tagEditorRef.value?.flushPending?.()
  emit('submit')
}
</script>
