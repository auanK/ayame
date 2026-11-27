<template>
  <BaseModal
    :title="imageOnly ? 'Image card' : existing ? 'Edit note' : 'Quick note'"
    title-id="mural-editor-title"
    test-id="mural-note-editor"
    :wide="true"
    :close-disabled="locked"
    @close="emit('close')"
    @keydown.tab="cycleFocus"
  >
    <div class="mural-editor-fields">
      <div v-if="imageUrl" class="mural-image-preview">
        <img :src="imageUrl" :alt="imageOnly ? draft.title || 'Mural image' : ''" decoding="async" />
      </div>
      <label class="mural-editor-label">
        <span>Title <small>(optional)</small></span>
        <input
          ref="titleInput"
          class="form-input"
          data-testid="mural-note-title"
          :value="draft.title"
          :maxlength="MURAL_MAX_TITLE_LENGTH"
          :disabled="locked"
          @input="emit('change', { title: $event.target.value })"
        />
      </label>
      <label v-if="!imageOnly" class="mural-editor-label">
        <span>Note</span>
        <textarea
          ref="bodyInput"
          class="form-input mural-note-body"
          data-testid="mural-note-body"
          :value="draft.body"
          :maxlength="MURAL_MAX_BODY_LENGTH"
          :disabled="locked"
          rows="7"
          @input="emit('change', { body: $event.target.value })"
        />
      </label>

      <fieldset class="mural-colors" :disabled="locked">
        <legend>Card color</legend>
        <button
          v-for="color in muralColors"
          :key="color.id"
          type="button"
          class="mural-swatch"
          :style="{ '--swatch': color.accent }"
          :aria-pressed="draft.color === color.id"
          :aria-label="color.label"
          :title="color.label"
          :data-color="color.id"
          @click="emit('change', { color: color.id })"
        />
      </fieldset>

      <div class="mural-editor-actions">
        <input ref="imageInput" type="file" :accept="MURAL_IMAGE_TYPES.join(',')" class="sr-only-input" tabindex="-1" @change="selectImage" />
        <button
          type="button"
          class="btn btn-secondary btn-compact"
          :disabled="locked || conflict || (!existing && !dirty)"
          @click="imageInput?.click()"
        >{{ imageOnly ? 'Replace image' : imageUrl ? 'Replace background' : 'Add background' }}</button>
        <button
          v-if="imageUrl && !imageOnly"
          type="button"
          class="btn btn-secondary btn-compact"
          :disabled="locked || conflict"
          @click="emit('remove-image')"
        >Remove background</button>
      </div>
    </div>

    <p v-if="conflict" class="error-message" role="alert">This note changed in another session. Choose which version to keep.</p>
    <p v-else-if="error" class="error-message" role="alert">{{ error }}</p>
    <div v-if="confirmDelete && !conflict" class="mural-editor-actions">
      <span>Permanently delete this {{ imageOnly ? 'image' : 'note' }}?</span>
      <button type="button" class="btn btn-secondary btn-compact" :disabled="locked" @click="confirmDelete = false">Cancel</button>
      <button type="button" class="btn btn-danger btn-compact" :disabled="locked" @click="emit('delete')">Confirm deletion</button>
    </div>

    <div v-if="conflict" class="mural-editor-actions">
      <button type="button" class="btn btn-secondary btn-compact" @click="emit('use-server')">Use server version</button>
      <button type="button" class="btn btn-secondary btn-compact" @click="emit('keep-mine')">Save my version</button>
    </div>
    <div v-else-if="error && dirty" class="mural-editor-actions">
      <button type="button" class="btn btn-secondary btn-compact" @click="emit('discard')">Discard changes</button>
      <button type="button" class="btn btn-secondary btn-compact" @click="emit('retry')">Retry save</button>
    </div>

    <template #footer>
      <div class="mural-editor-footer">
        <div class="mural-editor-actions">
          <button
            v-if="!draft.archived"
            type="button"
            class="btn btn-secondary btn-compact"
            :aria-pressed="draft.pinned"
            :disabled="locked"
            @click="emit('change', { pinned: !draft.pinned })"
          >{{ draft.pinned ? 'Unpin' : 'Pin' }}</button>
          <template v-if="existing && !draft.archived">
            <button type="button" class="btn btn-secondary btn-compact" :disabled="!canMoveUp || locked || saving || dirty" @click="emit('move', 'up')">Move up</button>
            <button type="button" class="btn btn-secondary btn-compact" :disabled="!canMoveDown || locked || saving || dirty" @click="emit('move', 'down')">Move down</button>
          </template>
          <button
            v-if="existing"
            type="button"
            class="btn btn-secondary btn-compact"
            :disabled="locked || conflict"
            @click="emit('archive')"
          >{{ draft.archived ? 'Restore' : 'Archive' }}</button>
          <button
            v-if="existing"
            type="button"
            class="btn btn-secondary btn-compact"
            :disabled="locked || conflict || confirmDelete"
            @click="confirmDelete = true"
          >Delete {{ imageOnly ? 'image' : 'note' }}</button>
        </div>
        <div class="mural-editor-actions">
          <span class="mural-save-status" role="status">{{ imageBusy ? 'Updating image…' : saving ? 'Saving…' : dirty ? 'Unsaved' : existing ? 'Saved' : '' }}</span>
          <button type="button" class="btn btn-primary btn-compact" data-testid="mural-note-done" :disabled="locked || conflict" @click="emit('close')">Done</button>
        </div>
      </div>
    </template>
  </BaseModal>
</template>

<script setup>
import { onMounted, ref, watch } from 'vue'
import BaseModal from '../components/BaseModal.vue'
import { MURAL_IMAGE_TYPES, MURAL_MAX_BODY_LENGTH, MURAL_MAX_TITLE_LENGTH } from '../../../shared/mural.js'
import { muralColors } from './colors.js'

const props = defineProps({
  draft: { type: Object, required: true },
  existing: { type: Boolean, required: true },
  dirty: { type: Boolean, required: true },
  saving: { type: Boolean, required: true },
  locked: { type: Boolean, required: true },
  canMoveUp: { type: Boolean, required: true },
  canMoveDown: { type: Boolean, required: true },
  conflict: { type: Boolean, required: true },
  error: { type: String, required: true },
  imageOnly: { type: Boolean, required: true },
  imageUrl: { type: String, default: '' },
  imageBusy: { type: Boolean, required: true },
})

const emit = defineEmits(['change', 'close', 'move', 'archive', 'delete', 'use-server', 'keep-mine', 'retry', 'discard', 'upload-image', 'remove-image'])
const confirmDelete = ref(false)
watch(() => props.conflict, (conflict) => { if (conflict) confirmDelete.value = false })
const titleInput = ref(null)
const bodyInput = ref(null)
const imageInput = ref(null)
const selectImage = (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (file) emit('upload-image', file)
}
const cycleFocus = (event) => {
  const controls = [...event.currentTarget.querySelectorAll('button, input, textarea')]
    .filter((control) => control.tabIndex >= 0 && !control.matches(':disabled'))
  const first = controls[0]
  const last = controls.at(-1)
  if (event.shiftKey ? event.target === first : event.target === last) {
    event.preventDefault()
    if (event.shiftKey) last?.focus()
    else first?.focus()
  }
}
onMounted(() => {
  if (props.imageOnly) titleInput.value?.focus()
  else bodyInput.value?.focus()
})
</script>

<style scoped>
.mural-editor-fields,
.mural-editor-label {
  display: grid;
  gap: 0.35rem;
}

.mural-editor-fields { gap: 0.85rem; }
.mural-editor-label, .mural-colors { color: var(--ayame-text); font-size: 0.85rem; }
.mural-editor-label small, .mural-save-status { color: var(--ayame-text-muted); font-size: 0.78rem; }
.mural-note-body { min-height: 9rem; resize: vertical; font-family: inherit; }

.mural-image-preview {
  display: grid;
  justify-items: center;
}

.mural-image-preview img { max-width: 100%; max-height: min(40vh, 22rem); border-radius: var(--radius-sm); display: block; }

.mural-colors {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  padding: 0.35rem 0 0;
  margin: 0;
  border: 0;
}

.mural-swatch {
  width: 1.85rem;
  height: 1.85rem;
  padding: 0;
  border: 1px solid var(--swatch);
  border-radius: 50%;
  background: color-mix(in srgb, var(--swatch) 25%, var(--ayame-surface));
  cursor: pointer;
}

.mural-swatch[aria-pressed='true'] { box-shadow: inset 0 0 0 4px var(--ayame-surface); background: var(--swatch); }
.mural-editor-footer, .mural-editor-actions { display: flex; align-items: center; flex-wrap: wrap; gap: 0.45rem; }
.mural-editor-footer { width: 100%; justify-content: space-between; }
</style>
