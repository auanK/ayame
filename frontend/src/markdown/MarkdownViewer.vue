<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from 'vue'
import { getVaultMarkdown } from '../vaults/api.js'
import { renderMarkdown } from './render.js'

const props = defineProps({
  directory: {
    type: String,
    required: true,
  },
  path: {
    type: String,
    required: true,
  },
})

const emit = defineEmits(['back', 'unauthorized'])

const loading = ref(true)
const refreshing = ref(false)
const error = ref(null)
const errorCode = ref(null)
const content = ref('')
const hasConfirmedContent = ref(false)
const stale = ref(false)

let activeRequestId = 0
let isMounted = true

const filename = computed(() => {
  if (!props.path) return ''
  const parts = props.path.split('/')
  return parts[parts.length - 1] || props.path
})

const renderedHtml = computed(() => renderMarkdown(content.value))

const load = async (isRefresh = false) => {
  const reqId = ++activeRequestId

  if (!isRefresh) {
    loading.value = true
    error.value = null
    errorCode.value = null
    content.value = ''
    hasConfirmedContent.value = false
    stale.value = false
  } else {
    refreshing.value = true
  }

  try {
    const result = await getVaultMarkdown(props.directory, props.path)
    if (!isMounted || reqId !== activeRequestId) return

    content.value = result.content
    hasConfirmedContent.value = true
    error.value = null
    errorCode.value = null
    stale.value = false
  } catch (err) {
    if (!isMounted || reqId !== activeRequestId) return

    if (err.code === 'UNAUTHORIZED') {
      content.value = ''
      hasConfirmedContent.value = false
      stale.value = false
      error.value = null
      errorCode.value = null
      emit('unauthorized')
      return
    }

    errorCode.value = err.code || 'FAILED_TO_FETCH_MARKDOWN'

    if (isRefresh && hasConfirmedContent.value) {
      stale.value = true
    } else {
      if (err.code === 'VAULT_FILE_TOO_LARGE') {
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
    }
  } finally {
    if (isMounted && reqId === activeRequestId) {
      loading.value = false
      refreshing.value = false
    }
  }
}

watch(
  () => [props.directory, props.path],
  () => {
    load()
  }
)

onMounted(() => {
  isMounted = true
  load()
})

onUnmounted(() => {
  isMounted = false
  activeRequestId++
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
          type="button"
          class="action-button refresh-button"
          data-testid="markdown-refresh-button"
          :disabled="loading || refreshing"
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
      <div v-else-if="hasConfirmedContent" class="content-container">
        <div v-if="content === ''" class="empty-state" data-testid="markdown-empty">
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
</style>
