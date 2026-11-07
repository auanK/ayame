<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { getVaultMarkdown, saveVaultMarkdown, MAX_MARKDOWN_BYTES } from '../vaults/api.js'
import { renderMarkdown } from './render.js'
import MarkdownEditor from './MarkdownEditor.vue'

const props = defineProps({
  directory: { type: String, required: true },
  path: { type: String, required: true },
})

const emit = defineEmits(['back', 'unauthorized', 'state'])

const mode = ref('view')
const loading = ref(true)
const refreshing = ref(false)
const saving = ref(false)
const reloading = ref(false)
const error = ref(null)
const errorCode = ref(null)
const baseContent = ref('')
const draft = ref('')
const revision = ref(null)
const hasConfirmedContent = ref(false)
const stale = ref(false)
const saveError = ref('')
const conflict = ref(false)
const saveResultUnknown = ref(false)
const discardConfirm = ref(false)
const reloadConfirm = ref(false)
const copyMessage = ref('')
const saveNotice = ref('')

const dirty = computed(() => draft.value !== baseContent.value)
const revisionReady = computed(() => typeof revision.value === 'string' && /^[a-f0-9]{64}$/.test(revision.value))
const filename = computed(() => props.path.split('/').at(-1) || props.path)
const renderedHtml = computed(() => renderMarkdown(baseContent.value))
const editorText = computed(() => normalizeLineEndings(draft.value))

let activeRequestId = 0
let recoveryRequestId = 0
let authGeneration = 0
let isMounted = true
let unloadHandler = null

function normalizeLineEndings(text) {
  return text.replace(/\r\n|\r/g, '\n')
}

function newlineTokens(text) {
  return [...text.matchAll(/\r\n|\r|\n/g)].map(([ending]) => ending)
}

function defaultLineEnding(tokens) {
  if (!tokens.length) return '\n'
  const counts = new Map()
  for (const ending of tokens) counts.set(ending, (counts.get(ending) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

function updateDraft(nextValue) {
  const previous = normalizeLineEndings(draft.value)
  const next = normalizeLineEndings(nextValue)
  let prefix = 0
  while (prefix < previous.length && prefix < next.length && previous[prefix] === next[prefix]) prefix++
  let suffix = 0
  while (
    suffix < previous.length - prefix &&
    suffix < next.length - prefix &&
    previous[previous.length - 1 - suffix] === next[next.length - 1 - suffix]
  ) suffix++

  const oldTokens = newlineTokens(draft.value)
  const prefixTokens = newlineTokens(previous.slice(0, prefix)).length
  const oldMiddleEnd = previous.length - suffix
  const suffixTokens = newlineTokens(previous.slice(oldMiddleEnd)).length
  const addedBreaks = (next.slice(prefix, next.length - suffix).match(/\n/g) ?? []).length
  const lineEnding = defaultLineEnding(oldTokens)
  const tokens = [
    ...oldTokens.slice(0, prefixTokens),
    ...Array(addedBreaks).fill(lineEnding),
    ...(suffixTokens ? oldTokens.slice(-suffixTokens) : []),
  ]
  let tokenIndex = 0
  draft.value = next.replace(/\n/g, () => tokens[tokenIndex++] ?? lineEnding)
  saveNotice.value = ''
  copyMessage.value = ''
}

const publishState = () => emit('state', { dirty: dirty.value, saving: saving.value, reloading: reloading.value })

const clearProtectedContent = () => {
  authGeneration++
  recoveryRequestId++
  reloading.value = false
  mode.value = 'view'
  baseContent.value = ''
  draft.value = ''
  revision.value = null
  hasConfirmedContent.value = false
  conflict.value = false
  saveResultUnknown.value = false
  discardConfirm.value = false
  reloadConfirm.value = false
  publishState()
}

const load = async (isRefresh = false) => {
  if (isRefresh && (mode.value === 'edit' || dirty.value || saving.value)) return
  const reqId = ++activeRequestId
  recoveryRequestId++
  reloading.value = false

  if (!isRefresh) {
    loading.value = true
    error.value = null
    errorCode.value = null
    baseContent.value = ''
    draft.value = ''
    revision.value = null
    hasConfirmedContent.value = false
    stale.value = false
    mode.value = 'view'
    saveError.value = ''
    conflict.value = false
    saveResultUnknown.value = false
  } else {
    refreshing.value = true
  }

  try {
    const result = await getVaultMarkdown(props.directory, props.path)
    if (!isMounted || reqId !== activeRequestId) return
    baseContent.value = result.content
    draft.value = result.content
    revision.value = result.revision
    hasConfirmedContent.value = true
    error.value = null
    errorCode.value = null
    stale.value = false
    saveError.value = ''
    saveNotice.value = ''
  } catch (err) {
    if (!isMounted || reqId !== activeRequestId) return
    if (err.code === 'UNAUTHORIZED') {
      clearProtectedContent()
      stale.value = false
      error.value = null
      errorCode.value = null
      emit('unauthorized')
      return
    }
    errorCode.value = err.code || 'FAILED_TO_FETCH_MARKDOWN'
    if (isRefresh && hasConfirmedContent.value) {
      stale.value = true
    } else if (err.code === 'VAULT_FILE_TOO_LARGE') {
      error.value = 'Note exceeds the 2 MiB limit and cannot be displayed.'
    } else if (err.code === 'INVALID_FILE_ENCODING') {
      error.value = 'Note contains invalid UTF-8 encoding and cannot be displayed.'
    } else if (err.code === 'VAULT_PATH_NOT_FOUND') {
      error.value = 'Note not found in vault.'
    } else if (err.code === 'UNSUPPORTED_FILE_TYPE') {
      error.value = 'Unsupported file type. Only Markdown notes (.md, .markdown) are supported.'
    } else {
      error.value = 'Could not load note from server. Please try again.'
    }
  } finally {
    if (isMounted && reqId === activeRequestId) {
      loading.value = false
      refreshing.value = false
    }
  }
}

const cancelEdit = () => {
  if (dirty.value) {
    discardConfirm.value = true
    return
  }
  mode.value = 'view'
}

const discardDraft = () => {
  recoveryRequestId++
  reloading.value = false
  draft.value = baseContent.value
  mode.value = 'view'
  discardConfirm.value = false
  reloadConfirm.value = false
  conflict.value = false
  saveResultUnknown.value = false
  saveError.value = ''
}

const save = async () => {
  if (saving.value || reloading.value || !dirty.value || conflict.value || saveResultUnknown.value) return
  if (!hasConfirmedContent.value || !revisionReady.value) {
    saveError.value = 'Reload this note to confirm its current revision before saving.'
    return
  }
  const bytes = new TextEncoder().encode(draft.value)
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
    saveError.value = 'This note exceeds the 2 MiB limit.'
    return
  }
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== draft.value) {
    saveError.value = 'The draft contains invalid Unicode and cannot be saved.'
    return
  }

  const reqId = activeRequestId
  saving.value = true
  saveError.value = ''
  saveNotice.value = ''
  publishState()
  try {
    const result = await saveVaultMarkdown(props.directory, props.path, {
      content: draft.value,
      expectedRevision: revision.value,
    })
    if (!isMounted || reqId !== activeRequestId) return
    baseContent.value = draft.value
    revision.value = result.revision
    mode.value = 'view'
    conflict.value = false
    saveResultUnknown.value = false
    saveNotice.value = 'Saved.'
  } catch (err) {
    if (!isMounted || reqId !== activeRequestId) return
    if (err.code === 'UNAUTHORIZED') {
      clearProtectedContent()
      emit('unauthorized')
    } else if (err.code === 'VAULT_FILE_CONFLICT') {
      conflict.value = true
      saveError.value = 'This note changed on the server. Your draft is preserved.'
    } else if (err.code === 'VAULT_SAVE_RESULT_UNKNOWN') {
      saveResultUnknown.value = true
      saveError.value = 'The save result is uncertain. Verify the server copy before continuing.'
    } else if (err.code === 'VAULT_FILE_LOCKED') {
      saveError.value = 'Another Ayame save is using this note. Your draft is preserved.'
    } else if (err.code === 'VAULT_FILE_TOO_LARGE') {
      saveError.value = 'This note exceeds the 2 MiB limit.'
    } else if (err.code === 'INVALID_MARKDOWN_CONTENT') {
      saveError.value = 'The draft contains invalid Unicode and cannot be saved.'
    } else {
      saveError.value = 'Could not save this note. Your draft is preserved.'
    }
  } finally {
    if (isMounted && reqId === activeRequestId) {
      saving.value = false
      publishState()
    }
  }
}

const verifyServer = async () => {
  if (saving.value || reloading.value) return
  const reqId = activeRequestId
  const recoveryId = ++recoveryRequestId
  saveError.value = ''
  try {
    const remote = await getVaultMarkdown(props.directory, props.path)
    if (!isMounted || reqId !== activeRequestId || recoveryId !== recoveryRequestId) return
    if (remote.content === draft.value) {
      baseContent.value = remote.content
      draft.value = remote.content
      revision.value = remote.revision
      conflict.value = false
      saveResultUnknown.value = false
      mode.value = 'view'
      saveNotice.value = 'The server copy matches your draft.'
    } else {
      conflict.value = true
      saveResultUnknown.value = false
      saveError.value = 'The server has a different copy. Your draft remains unchanged.'
    }
  } catch (err) {
    if (!isMounted || reqId !== activeRequestId || recoveryId !== recoveryRequestId) return
    if (err.code === 'UNAUTHORIZED') {
      clearProtectedContent()
      emit('unauthorized')
    } else {
      saveError.value = 'Could not verify the server copy. Your draft is preserved.'
    }
  }
}

const reloadServerCopy = async () => {
  if (reloading.value || saving.value) return
  const reqId = activeRequestId
  const recoveryId = ++recoveryRequestId
  const authId = authGeneration
  const { directory, path } = props
  const expectedRevision = revision.value
  const expectedDraft = draft.value
  reloading.value = true
  reloadConfirm.value = false
  saveError.value = ''

  const isCurrent = () => isMounted && reqId === activeRequestId && recoveryId === recoveryRequestId &&
    authId === authGeneration && directory === props.directory && path === props.path
  try {
    const remote = await getVaultMarkdown(directory, path)
    if (!isCurrent()) return
    if (remote.directory !== directory || remote.path !== path) {
      saveError.value = 'Could not confirm the server copy. Your draft is preserved.'
      return
    }
    if (revision.value !== expectedRevision || draft.value !== expectedDraft) {
      saveError.value = 'Your draft changed while loading. The server copy was not applied.'
      return
    }
    baseContent.value = remote.content
    draft.value = remote.content
    revision.value = remote.revision
    mode.value = 'view'
    conflict.value = false
    saveResultUnknown.value = false
    reloadConfirm.value = false
    discardConfirm.value = false
    saveError.value = ''
    saveNotice.value = 'Loaded the current server copy.'
  } catch (err) {
    if (!isCurrent()) return
    if (err.code === 'UNAUTHORIZED') {
      clearProtectedContent()
      emit('unauthorized')
    } else {
      saveError.value = 'Could not load the server copy. Your draft is preserved.'
    }
  } finally {
    if (isCurrent()) {
      reloading.value = false
      publishState()
    }
  }
}

const copyDraft = async () => {
  try {
    await navigator.clipboard.writeText(draft.value)
    copyMessage.value = 'Draft copied.'
  } catch {
    copyMessage.value = 'Clipboard access is unavailable. Select the draft text and copy it.'
  }
}

const handleBeforeUnload = (event) => {
  event.preventDefault()
  event.returnValue = ''
}

watch(dirty, (isDirty) => {
  if (typeof window === 'undefined') return
  if (isDirty && !unloadHandler) {
    unloadHandler = handleBeforeUnload
    window.addEventListener('beforeunload', unloadHandler)
  } else if (!isDirty && unloadHandler) {
    window.removeEventListener('beforeunload', unloadHandler)
    unloadHandler = null
  }
  publishState()
}, { flush: 'sync' })

watch(saving, publishState, { flush: 'sync' })
watch(reloading, publishState, { flush: 'sync' })
watch(() => [props.directory, props.path], () => load())

onMounted(() => {
  isMounted = true
  load()
  publishState()
})

onUnmounted(() => {
  isMounted = false
  activeRequestId++
  recoveryRequestId++
  if (unloadHandler) window.removeEventListener('beforeunload', unloadHandler)
  emit('state', { dirty: false, saving: false, reloading: false })
})
</script>

<template>
  <div class="markdown-viewer" data-testid="markdown-viewer">
    <header class="viewer-header">
      <div class="header-left">
        <button
          type="button"
          class="back-button"
          data-testid="markdown-back-button"
          :disabled="saving || reloading"
          @click="emit('back')"
        >
          ← Back
        </button>
        <span class="file-title" data-testid="markdown-filename">{{ filename }}</span>
        <span
          v-if="stale"
          class="stale-badge"
          data-testid="markdown-stale-indicator"
          title="Could not refresh; displaying previously confirmed version"
        >
          Outdated
        </span>
      </div>

      <div class="header-actions">
        <button
          v-if="mode === 'view' && hasConfirmedContent && revisionReady"
          type="button"
          class="action-button"
          data-testid="markdown-edit-button"
          :disabled="loading || saving || reloading"
          @click="mode = 'edit'; saveNotice = ''; saveError = ''"
        >Edit</button>
        <button
          v-if="mode === 'view'"
          type="button"
          class="action-button refresh-button"
          data-testid="markdown-refresh-button"
          :disabled="loading || refreshing || saving || reloading"
          @click="load(true)"
        >
          {{ refreshing ? 'Refreshing...' : 'Refresh' }}
        </button>
      </div>
    </header>

    <main class="viewer-body">
      <!-- Loading State -->
      <div v-if="loading" class="state-container" data-testid="markdown-loading">
        <div class="loading-spinner"></div>
        <p>Loading note...</p>
      </div>

      <!-- Not Found State -->
      <div
        v-else-if="errorCode === 'VAULT_PATH_NOT_FOUND' && !hasConfirmedContent"
        class="state-container error-state"
        data-testid="markdown-not-found"
      >
        <p class="error-title">Note not found</p>
        <p class="error-desc">The requested note was not found or has been moved externally.</p>
        <button
          type="button"
          class="action-button back-fallback-button"
          data-testid="markdown-back-button"
          @click="emit('back')"
        >
          Return to directory
        </button>
      </div>

      <!-- Generic Error State -->
      <div
        v-else-if="error && !hasConfirmedContent"
        class="state-container error-state"
        data-testid="markdown-error"
      >
        <p class="error-title">{{ error }}</p>
        <button
          type="button"
          class="action-button retry-button"
          data-testid="markdown-retry-button"
          @click="load(false)"
        >
          Retry
        </button>
      </div>

      <!-- Content State -->
      <p v-show="saveNotice && mode === 'view'" class="editor-status" role="status">{{ saveNotice }}</p>
      <div v-if="mode === 'edit' && hasConfirmedContent" class="content-container editor-container">
        <div class="editor-heading">
          <strong>{{ filename }}</strong>
          <span v-if="dirty" data-testid="markdown-dirty-indicator">Unsaved changes</span>
        </div>
        <MarkdownEditor :model-value="editorText" :disabled="saving || reloading || loading" @update:model-value="updateDraft" />
        <p v-if="saving" class="editor-status" role="status" data-testid="markdown-saving">Saving…</p>
        <p v-if="reloading" class="editor-status" role="status" data-testid="markdown-reloading">Loading server copy…</p>
        <p v-if="saveError" class="editor-error" role="alert" data-testid="markdown-save-error">{{ saveError }}</p>
        <p v-if="saveNotice" class="editor-status" role="status">{{ saveNotice }}</p>
        <p v-if="copyMessage" class="editor-status" role="status">{{ copyMessage }}</p>
        <div v-if="conflict" class="editor-conflict" role="alert" data-testid="markdown-conflict">
          <p>This note changed on the server. Your local draft is still here.</p>
          <button type="button" class="action-button" data-testid="markdown-copy-draft" @click="copyDraft">Copy draft</button>
          <button type="button" class="action-button" data-testid="markdown-reload-server" :disabled="reloading" @click="reloadConfirm = true">Load server copy…</button>
        </div>
        <div v-if="saveResultUnknown" class="editor-conflict" role="alert" data-testid="markdown-save-unknown">
          <p>The server may have saved this note. Verify its current contents before trying again.</p>
          <button type="button" class="action-button" data-testid="markdown-verify-save" :disabled="saving || reloading" @click="verifyServer">Verify server copy</button>
        </div>
        <div class="editor-actions">
          <button type="button" class="action-button" data-testid="markdown-save-button" :disabled="!dirty || saving || reloading || conflict || saveResultUnknown" @click="save">
            {{ saving ? 'Saving…' : 'Save' }}
          </button>
          <button type="button" class="action-button" data-testid="markdown-cancel-button" :disabled="saving || reloading" @click="cancelEdit">Cancel</button>
        </div>
        <div v-if="discardConfirm" class="editor-confirm" role="dialog" aria-modal="true" aria-labelledby="discard-title">
          <p id="discard-title">Discard your unsaved changes?</p>
          <button type="button" class="action-button" data-testid="markdown-keep-editing" @click="discardConfirm = false">Keep editing</button>
          <button type="button" class="action-button" data-testid="markdown-discard-changes" @click="discardDraft">Discard changes</button>
        </div>
        <div v-if="reloadConfirm" class="editor-confirm" role="dialog" aria-modal="true" aria-labelledby="reload-title">
          <p id="reload-title">Discard your draft and load the current server copy?</p>
          <button type="button" class="action-button" @click="reloadConfirm = false">Keep editing</button>
          <button type="button" class="action-button" data-testid="markdown-confirm-reload" @click="reloadServerCopy">Discard draft and reload</button>
        </div>
      </div>

      <div v-else-if="hasConfirmedContent" class="content-container">
        <div v-if="baseContent === ''" class="empty-state" data-testid="markdown-empty">
          <p>This note is empty.</p>
        </div>
        <div
          v-else
          class="markdown-content"
          data-testid="markdown-content"
          v-html="renderedHtml"
        ></div>
      </div>
    </main>
  </div>
</template>

<style scoped>
.markdown-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: 900px;
  margin: 0 auto;
  color: var(--ayame-lavender, #d4cbe4);
}

.viewer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid rgba(212, 203, 228, 0.15);
  background: rgba(17, 18, 24, 0.6);
  backdrop-filter: blur(8px);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  overflow: hidden;
}

.back-button {
  background: transparent;
  border: 1px solid rgba(212, 203, 228, 0.2);
  color: var(--ayame-lavender, #d4cbe4);
  padding: 0.35rem 0.65rem;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.back-button:hover {
  background: rgba(169, 154, 202, 0.15);
  border-color: var(--ayame-primary, #a99aca);
}

.file-title {
  font-weight: 600;
  font-size: 1rem;
  color: #fff;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.stale-badge {
  font-size: 0.7rem;
  text-transform: uppercase;
  background: rgba(220, 100, 50, 0.25);
  color: #ff9d76;
  border: 1px solid rgba(220, 100, 50, 0.4);
  padding: 0.15rem 0.4rem;
  border-radius: 3px;
  letter-spacing: 0.05em;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-button {
  background: rgba(169, 154, 202, 0.12);
  border: 1px solid rgba(169, 154, 202, 0.25);
  color: var(--ayame-lavender, #d4cbe4);
  padding: 0.35rem 0.75rem;
  border-radius: 4px;
  font-size: 0.85rem;
  cursor: pointer;
  transition: all 0.15s ease;
}

.action-button:hover:not(:disabled) {
  background: rgba(169, 154, 202, 0.25);
  border-color: var(--ayame-primary, #a99aca);
}

.action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.viewer-body {
  padding: 1.5rem 1rem 3rem;
}

.state-container {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 1rem;
  text-align: center;
  gap: 1rem;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(212, 203, 228, 0.2);
  border-top-color: var(--ayame-primary, #a99aca);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.error-title {
  color: #ff9d76;
  font-weight: 500;
}

.error-desc {
  font-size: 0.9rem;
  color: rgba(212, 203, 228, 0.7);
}

.empty-state {
  padding: 3rem 1rem;
  text-align: center;
  color: rgba(212, 203, 228, 0.5);
  font-style: italic;
}

.markdown-content {
  line-height: 1.65;
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.9);
}

:deep(h1),
:deep(h2),
:deep(h3),
:deep(h4),
:deep(h5),
:deep(h6) {
  color: #fff;
  font-weight: 600;
  margin-top: 1.5rem;
  margin-bottom: 0.75rem;
  line-height: 1.3;
}

:deep(h1) {
  font-size: 1.75rem;
  border-bottom: 1px solid rgba(212, 203, 228, 0.15);
  padding-bottom: 0.4rem;
}

:deep(h2) {
  font-size: 1.4rem;
  border-bottom: 1px solid rgba(212, 203, 228, 0.1);
  padding-bottom: 0.3rem;
}

:deep(h3) {
  font-size: 1.15rem;
}

:deep(p) {
  margin-top: 0;
  margin-bottom: 1rem;
}

:deep(a) {
  color: var(--ayame-lavender, #d4cbe4);
  text-decoration: underline;
  text-underline-offset: 3px;
}

:deep(a:hover) {
  color: #fff;
}

:deep(span.markdown-non-navigable-link) {
  color: rgba(212, 203, 228, 0.8);
  border-bottom: 1px dotted rgba(212, 203, 228, 0.4);
}

:deep(span.markdown-image-placeholder) {
  display: inline-block;
  padding: 0.2rem 0.5rem;
  background: rgba(169, 154, 202, 0.1);
  border: 1px dashed rgba(169, 154, 202, 0.3);
  border-radius: 4px;
  font-size: 0.85rem;
  color: rgba(212, 203, 228, 0.75);
}

:deep(code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88em;
  background: rgba(212, 203, 228, 0.12);
  padding: 0.15rem 0.35rem;
  border-radius: 3px;
  color: #f1eef8;
}

:deep(pre) {
  background: #0b0c10;
  border: 1px solid rgba(212, 203, 228, 0.12);
  border-radius: 6px;
  padding: 1rem;
  overflow-x: auto;
  margin: 1rem 0;
}

:deep(pre code) {
  background: transparent;
  padding: 0;
  color: inherit;
  font-size: 0.88rem;
}

:deep(blockquote) {
  margin: 1rem 0;
  padding: 0.5rem 1rem;
  border-left: 3px solid var(--ayame-primary, #a99aca);
  background: rgba(169, 154, 202, 0.05);
  color: rgba(212, 203, 228, 0.85);
  font-style: italic;
}

:deep(blockquote p:last-child) {
  margin-bottom: 0;
}

:deep(ul),
:deep(ol) {
  margin-top: 0;
  margin-bottom: 1rem;
  padding-left: 1.5rem;
}

:deep(li) {
  margin-bottom: 0.35rem;
}

:deep(hr) {
  border: 0;
  border-top: 1px solid rgba(212, 203, 228, 0.15);
  margin: 1.5rem 0;
}

:deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: 1rem 0;
  overflow-x: auto;
  display: block;
}

:deep(th),
:deep(td) {
  border: 1px solid rgba(212, 203, 228, 0.18);
  padding: 0.5rem 0.75rem;
  text-align: left;
}

:deep(th) {
  background: rgba(169, 154, 202, 0.1);
  color: #fff;
  font-weight: 600;
}

:deep(tr:nth-child(even)) {
  background: rgba(212, 203, 228, 0.03);
}

.editor-container {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.editor-heading,
.editor-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.editor-heading span,
.editor-status {
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.875rem;
}

.editor-error {
  color: #ff9d76;
}

.editor-conflict,
.editor-confirm {
  padding: 0.75rem;
  border: 1px solid rgba(212, 203, 228, 0.2);
  border-radius: 6px;
  background: rgba(17, 18, 24, 0.9);
}

.editor-confirm {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
