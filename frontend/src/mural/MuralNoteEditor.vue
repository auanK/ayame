<template>
  <div
    class="mural-sheet-backdrop"
    @click.self="!locked && emit('close')"
  >
    <div
      class="mural-sheet"
      :class="{ 'mural-sheet--image-only': imageOnly }"
      :data-mural-color="draft.color"
      :style="{ '--mural-accent': muralAccent(draft.color) }"
      data-testid="mural-note-editor"
      role="dialog"
      aria-modal="true"
      :aria-label="imageOnly ? 'Image card' : existing ? 'Note' : 'New note'"
      @keydown.tab="cycleFocus"
    >
      <div v-if="imageUrl" class="mural-sheet-hero">
        <img :src="imageUrl" :alt="imageOnly ? draft.title || 'Mural image' : ''" decoding="async" />
        <button
          v-if="imageOnly && canResize && !trashed"
          type="button"
          class="mural-hero-resize-btn"
          data-testid="mural-note-resize"
          :disabled="locked || conflict"
          @click="emit('start-resize')"
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9.2 6.8M2.5 13.5l4.3-4.3" />
          </svg>
          <span>Resize</span>
        </button>
      </div>

      <div class="mural-sheet-body">
        <div class="mural-sheet-title-row">
          <input
            ref="titleInput"
            class="mural-sheet-title"
            data-testid="mural-note-title"
            :value="draft.title"
            :maxlength="MURAL_MAX_TITLE_LENGTH"
            :disabled="locked || trashed"
            :placeholder="imageOnly ? 'Add a caption…' : 'Title'"
            :aria-label="imageOnly ? 'Caption' : 'Title'"
            @input="emit('change', { title: $event.target.value })"
            @keydown.enter.prevent="!imageOnly && !trashed && bodyInput?.focus()"
          />
          <button
            v-if="!imageOnly && canResize && !trashed"
            type="button"
            class="mural-ghost-btn"
            data-testid="mural-note-resize"
            :disabled="locked || conflict"
            title="Resize image on board"
            @click="emit('start-resize')"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M10 2.5h3.5V6M6 13.5H2.5V10M13.5 2.5 9.2 6.8M2.5 13.5l4.3-4.3" />
            </svg>
            <span>Resize</span>
          </button>
          <button
            v-if="!draft.archived && !trashed"
            type="button"
            class="mural-ghost-btn mural-pin-btn"
            :aria-pressed="draft.pinned"
            :disabled="locked"
            :title="draft.pinned ? 'Unpin note' : 'Pin note'"
            @click="emit('change', { pinned: !draft.pinned })"
          >
            <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M5.5 2.5h5l-.8 4.2 2 1.8v1.3H8.6v3.7l-.6.7-.6-.7V9.8H4.3V8.5l2-1.8z" />
            </svg>
            <span>{{ draft.pinned ? 'Unpin' : 'Pin' }}</span>
          </button>
        </div>

        <textarea
          v-if="!imageOnly"
          ref="bodyInput"
          class="mural-sheet-textarea"
          data-testid="mural-note-body"
          :value="draft.body"
          :maxlength="MURAL_MAX_BODY_LENGTH"
          :disabled="locked || trashed"
          placeholder="Take a note…"
          aria-label="Note"
          rows="4"
          @input="handleBodyInput"
          @keydown.ctrl.enter.prevent="!locked && !conflict && emit('close')"
          @keydown.meta.enter.prevent="!locked && !conflict && emit('close')"
        />

        <p v-if="trashed" class="mural-trashed-notice">This {{ imageOnly ? 'image' : 'note' }} is in the trash.</p>

        <div v-if="conflict || error || confirmDelete" class="mural-sheet-alerts">
          <p v-if="conflict" class="error-message" role="alert">This note changed in another session. Choose which version to keep.</p>
          <p v-else-if="error" class="error-message" role="alert">{{ error }}</p>

          <div v-if="confirmDelete && !conflict" class="mural-sheet-banner">
            <span>Permanently delete this {{ imageOnly ? 'image' : 'note' }}?</span>
            <button type="button" class="btn btn-secondary btn-compact" :disabled="locked" @click="confirmDelete = false">Cancel</button>
            <button type="button" class="btn btn-danger btn-compact" :disabled="locked" @click="emit('delete')">Confirm deletion</button>
          </div>

          <div v-if="conflict" class="mural-sheet-banner">
            <button type="button" class="btn btn-secondary btn-compact" @click="emit('use-server')">Use server version</button>
            <button type="button" class="btn btn-secondary btn-compact" @click="emit('keep-mine')">Save my version</button>
          </div>
          <div v-else-if="error && dirty" class="mural-sheet-banner">
            <button type="button" class="btn btn-secondary btn-compact" @click="emit('discard')">Discard changes</button>
            <button type="button" class="btn btn-secondary btn-compact" @click="emit('retry')">Retry save</button>
          </div>
        </div>
      </div>

      <footer class="mural-sheet-toolbar">
        <div class="mural-toolbar-left">
          <template v-if="!trashed">
            <div class="mural-colors" role="group" aria-label="Card color">
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
                :disabled="locked"
                @click="emit('change', { color: color.id })"
              />
            </div>

            <span class="mural-toolbar-divider" aria-hidden="true" />

            <input ref="imageInput" type="file" :accept="MURAL_IMAGE_TYPES.join(',')" class="sr-only-input" tabindex="-1" @change="selectImage" />
            <button
              type="button"
              class="mural-ghost-btn"
              :disabled="locked || conflict || (!existing && !dirty)"
              @click="imageInput?.click()"
            >
              <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <rect x="2" y="3" width="12" height="10" rx="1.5" />
                <circle cx="5.5" cy="6.2" r="1" />
                <path d="M2.5 11.5 6 8.3l2.6 2.3 2.1-1.9 2.8 2.8" />
              </svg>
              <span>{{ imageOnly ? 'Replace image' : imageUrl ? 'Replace background' : 'Add background' }}</span>
            </button>

            <button
              v-if="imageUrl && !imageOnly"
              type="button"
              class="mural-ghost-btn"
              :disabled="locked || conflict"
              @click="emit('remove-image')"
            >Remove background</button>

            <button
              v-if="existing"
              type="button"
              class="mural-ghost-btn"
              :disabled="locked || conflict"
              @click="emit('archive')"
            >{{ draft.archived ? 'Restore' : 'Archive' }}</button>

            <button
              v-if="existing"
              type="button"
              class="mural-ghost-btn mural-ghost-btn--danger"
              :disabled="locked || conflict"
              @click="emit('trash')"
            >Move to trash</button>
          </template>

          <template v-else>
            <button
              type="button"
              class="mural-ghost-btn"
              :disabled="locked || conflict"
              @click="emit('restore')"
            >Restore</button>
            <button
              type="button"
              class="mural-ghost-btn mural-ghost-btn--danger"
              :disabled="locked || conflict || confirmDelete"
              @click="confirmDelete = true"
            >Delete permanently</button>
          </template>
        </div>

        <div class="mural-toolbar-right">
          <span class="mural-save-status" role="status">{{ trashed ? '' : imageBusy ? 'Updating image…' : saving ? 'Saving…' : dirty ? 'Unsaved' : existing ? 'Saved' : '' }}</span>
          <button
            type="button"
            class="mural-done-btn"
            data-testid="mural-note-done"
            :disabled="locked || conflict"
            @click="emit('close')"
          >Done</button>
        </div>
      </footer>
    </div>
  </div>
</template>

<script setup>
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { MURAL_IMAGE_TYPES, MURAL_MAX_BODY_LENGTH, MURAL_MAX_TITLE_LENGTH } from '../../../shared/mural.js'
import { muralAccent, muralColors } from './colors.js'

const props = defineProps({
  draft: { type: Object, required: true },
  existing: { type: Boolean, required: true },
  dirty: { type: Boolean, required: true },
  saving: { type: Boolean, required: true },
  locked: { type: Boolean, required: true },
  trashed: { type: Boolean, default: false },
  canResize: { type: Boolean, default: false },
  canMoveUp: { type: Boolean, default: false },
  canMoveDown: { type: Boolean, default: false },
  conflict: { type: Boolean, required: true },
  error: { type: String, required: true },
  imageOnly: { type: Boolean, required: true },
  imageUrl: { type: String, default: '' },
  imageBusy: { type: Boolean, required: true },
})

const emit = defineEmits(['change', 'close', 'move', 'archive', 'trash', 'restore', 'delete', 'start-resize', 'use-server', 'keep-mine', 'retry', 'discard', 'upload-image', 'remove-image'])

const confirmDelete = ref(false)
const titleInput = ref(null)
const bodyInput = ref(null)
const imageInput = ref(null)

const resizeTextarea = () => {
  const el = bodyInput.value
  if (!el) return
  el.style.height = 'auto'
  el.style.height = `${el.scrollHeight}px`
}

const handleBodyInput = (event) => {
  emit('change', { body: event.target.value })
  resizeTextarea()
}

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

const handleKeydown = (event) => {
  if (event.key === 'Escape' && !props.locked) {
    emit('close')
  }
}

watch(() => props.conflict, (conflict) => { if (conflict) confirmDelete.value = false })
watch(() => props.draft.body, () => { void nextTick(resizeTextarea) })

onMounted(() => {
  window.addEventListener('keydown', handleKeydown)
  if (props.trashed) return
  if (props.imageOnly) titleInput.value?.focus()
  else {
    bodyInput.value?.focus()
    resizeTextarea()
  }
})

onUnmounted(() => {
  window.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.mural-sheet-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.25rem;
  background: var(--ayame-scrim);
}

.mural-sheet {
  width: min(100%, 38rem);
  max-height: 90vh;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--radius-sm);
  border: 1px solid color-mix(in srgb, var(--mural-accent) 34%, var(--ayame-border));
  background: color-mix(in srgb, var(--mural-accent) 13%, var(--ayame-surface));
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.52);
  color: var(--ayame-text);
  transition: background-color 180ms ease, border-color 180ms ease;
  animation: mural-sheet-enter 140ms cubic-bezier(0.2, 0, 0, 1);
}

.mural-sheet--image-only {
  width: min(100%, 52rem);
}

@keyframes mural-sheet-enter {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.mural-sheet-hero {
  position: relative;
  width: 100%;
  background: color-mix(in srgb, var(--mural-accent) 6%, var(--ayame-background));
  display: flex;
  justify-content: center;
  border-bottom: 1px solid color-mix(in srgb, var(--mural-accent) 18%, var(--ayame-border));
}

.mural-sheet-hero img {
  display: block;
  width: 100%;
  max-height: min(40vh, 22rem);
  object-fit: cover;
}

.mural-sheet--image-only .mural-sheet-hero img {
  width: auto;
  max-width: 100%;
  max-height: min(68vh, 42rem);
  object-fit: contain;
}

.mural-hero-resize-btn {
  position: absolute;
  top: 0.65rem;
  right: 0.65rem;
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.32rem 0.6rem;
  border: 1px solid color-mix(in srgb, var(--mural-accent) 35%, var(--ayame-border));
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--ayame-surface) 84%, transparent);
  backdrop-filter: blur(6px);
  color: var(--ayame-text);
  font: inherit;
  font-size: 0.79rem;
  cursor: pointer;
}

.mural-hero-resize-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--ayame-surface) 96%, transparent);
}

.mural-sheet-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
  padding: 1rem 1.15rem 0.65rem;
}

.mural-sheet-title-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.mural-sheet-title {
  flex: 1;
  min-width: 0;
  border: 0;
  outline: none;
  background: transparent;
  padding: 0.15rem 0;
  color: var(--ayame-text);
  font: inherit;
  font-size: 1.12rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}

.mural-sheet--image-only .mural-sheet-title {
  font-size: 0.98rem;
  font-weight: 500;
}

.mural-sheet-title::placeholder,
.mural-sheet-textarea::placeholder {
  color: var(--ayame-text-muted);
  opacity: 0.72;
}

.mural-sheet-textarea {
  width: 100%;
  min-height: 7.5rem;
  max-height: 52vh;
  overflow-y: auto;
  resize: none;
  border: 0;
  outline: none;
  background: transparent;
  padding: 0.1rem 0 0.25rem;
  color: var(--ayame-text);
  font: inherit;
  font-size: 0.94rem;
  line-height: 1.58;
}

.mural-trashed-notice {
  margin: 0.15rem 0 0;
  color: var(--ayame-text-muted);
  font-size: 0.79rem;
}

.mural-sheet-alerts {
  display: grid;
  gap: 0.5rem;
  padding-top: 0.35rem;
}

.mural-sheet-alerts .error-message {
  margin: 0;
}

.mural-sheet-banner {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.45rem;
  font-size: 0.84rem;
}

.mural-sheet-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 0.55rem 0.75rem;
  padding: 0.6rem 1.05rem;
  border-top: 1px solid color-mix(in srgb, var(--mural-accent) 20%, var(--ayame-border));
  background: color-mix(in srgb, var(--mural-accent) 8%, var(--ayame-surface));
}

.mural-toolbar-left,
.mural-toolbar-right {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.mural-colors {
  display: flex;
  align-items: center;
  gap: 0.32rem;
}

.mural-swatch {
  width: 1.25rem;
  height: 1.25rem;
  padding: 0;
  border: 1.5px solid var(--swatch);
  border-radius: 50%;
  background: color-mix(in srgb, var(--swatch) 35%, var(--ayame-surface));
  cursor: pointer;
  transition: transform 100ms ease, box-shadow 120ms ease;
}

.mural-swatch:hover:not(:disabled) {
  transform: scale(1.1);
}

.mural-swatch[aria-pressed='true'] {
  box-shadow: inset 0 0 0 2.5px var(--ayame-surface);
  background: var(--swatch);
}

.mural-toolbar-divider {
  width: 1px;
  height: 1.1rem;
  margin-inline: 0.2rem;
  background: color-mix(in srgb, var(--mural-accent) 24%, var(--ayame-border));
}

.mural-ghost-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  padding: 0.28rem 0.52rem;
  border: 1px solid transparent;
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--ayame-text-muted);
  font: inherit;
  font-size: 0.79rem;
  cursor: pointer;
  transition: background-color 120ms ease, color 120ms ease, border-color 120ms ease;
}

.mural-ghost-btn:hover:not(:disabled),
.mural-ghost-btn:focus-visible:not(:disabled) {
  background: color-mix(in srgb, var(--mural-accent) 16%, transparent);
  color: var(--ayame-text);
}

.mural-pin-btn[aria-pressed='true'] {
  color: var(--mural-accent);
  background: color-mix(in srgb, var(--mural-accent) 16%, transparent);
}

.mural-ghost-btn--danger:hover:not(:disabled) {
  color: var(--ayame-error);
}

.mural-ghost-btn:disabled {
  opacity: 0.45;
  cursor: default;
}

.mural-save-status {
  color: var(--ayame-text-muted);
  font-size: 0.76rem;
  margin-right: 0.2rem;
}

.mural-done-btn {
  padding: 0.32rem 0.78rem;
  border: 1px solid color-mix(in srgb, var(--mural-accent) 32%, var(--ayame-border));
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--mural-accent) 18%, var(--ayame-surface));
  color: var(--ayame-text);
  font: inherit;
  font-size: 0.81rem;
  font-weight: 500;
  cursor: pointer;
  transition: background-color 120ms ease;
}

.mural-done-btn:hover:not(:disabled) {
  background: color-mix(in srgb, var(--mural-accent) 28%, var(--ayame-surface));
}

.mural-done-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
</style>
