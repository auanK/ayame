<template>
  <section
    class="vault-browser"
    data-testid="vault-browser"
    aria-labelledby="browser-heading"
    :aria-busy="loading"
  >
    <header class="vaults-panel-header browser-header">
      <nav class="browser-breadcrumbs" data-testid="breadcrumbs" aria-label="Breadcrumb">
        <ol class="breadcrumb-list">
          <li class="breadcrumb-item">
            <button
              type="button"
              class="btn-breadcrumb"
              @click="$emit('back')"
            >
              Vaults
            </button>
          </li>
          <li class="breadcrumb-separator" aria-hidden="true">/</li>
          <li class="breadcrumb-item">
            <button
              v-if="currentPath !== '' || selectedFile !== null"
              type="button"
              class="btn-breadcrumb"
              :disabled="loading"
              @click="closeFileAndNavigate('')"
            >
              {{ vault.name }}
            </button>
            <span v-else class="breadcrumb-current" aria-current="location">{{ vault.name }}</span>
          </li>
          <template v-for="(segment, idx) in segments" :key="pathTo(idx)">
            <li class="breadcrumb-separator" aria-hidden="true">/</li>
            <li class="breadcrumb-item">
              <button
                v-if="idx < segments.length - 1 || selectedFile !== null"
                type="button"
                class="btn-breadcrumb"
                :disabled="loading"
                @click="closeFileAndNavigate(pathTo(idx))"
              >
                {{ segment }}
              </button>
              <span v-else class="breadcrumb-current" aria-current="location">{{ segment }}</span>
            </li>
          </template>
          <template v-if="selectedFile !== null">
            <li class="breadcrumb-separator" aria-hidden="true">/</li>
            <li class="breadcrumb-item">
              <span class="breadcrumb-current" aria-current="location">{{ selectedFileName }}</span>
            </li>
          </template>
        </ol>
      </nav>

      <div class="browser-header-actions">
        <button
          v-if="selectedFile === null"
          type="button"
          class="btn btn-secondary"
          data-testid="refresh-button"
          :disabled="loading"
          @click="refresh"
        >
          {{ loading ? 'Refreshing...' : 'Refresh' }}
        </button>
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="back-to-vaults-button"
          @click="$emit('back')"
        >
          Back to vaults
        </button>
      </div>
    </header>

    <template v-if="selectedFile !== null">
      <MarkdownViewer
        :directory="vault.directory"
        :path="selectedFile"
        @back="closeFile"
        @unauthorized="emit('unauthorized')"
      />
    </template>

    <template v-else>
      <p v-if="error" class="error-message" role="alert" aria-live="polite">
        {{ error }}
      </p>

      <div v-if="error && !entries.length" class="browser-error-state">
        <button
          type="button"
          class="btn btn-secondary"
          data-testid="retry-button"
          @click="retry"
        >
          Retry
        </button>
      </div>

      <p v-if="stale" class="warning-message" role="alert">
        Listing may be out of date.
      </p>

      <p v-if="loading && !entries.length && !error" class="status-message" role="status" aria-busy="true">
        Loading directory...
      </p>

      <template v-if="hasLoaded && !error">
        <div v-if="currentPath !== ''" class="browser-nav-up">
          <button
            type="button"
            class="btn btn-secondary browser-parent-dir"
            data-testid="parent-dir-button"
            :disabled="loading || stale"
            @click="navigateTo(parentPath)"
          >
            .. (Parent directory)
          </button>
        </div>

        <div v-if="entries.length === 0" class="browser-empty-state">
          <p>No files or folders found.</p>
        </div>

        <div v-if="folders.length > 0" class="browser-section">
          <h3 class="browser-section-title">Folders</h3>
          <ul class="browser-folder-list" aria-label="Folders">
            <li v-for="folder in folders" :key="folder.path || folder.name" class="browser-folder-item">
              <button
                v-if="folder.path !== null"
                type="button"
                class="btn-folder"
                :disabled="loading || stale"
                @click="navigateTo(folder.path)"
              >
                {{ folder.name }}/
              </button>
              <span v-else class="browser-folder-unnavigable" title="Cannot navigate ambiguous path">
                {{ folder.name }}/
              </span>
            </li>
          </ul>
        </div>

        <div v-if="files.length > 0" class="browser-section">
          <h3 class="browser-section-title">Files</h3>
          <ul class="browser-file-list" aria-label="Files">
            <li v-for="file in files" :key="file.path || file.name" class="browser-file-item">
              <button
                v-if="isSupportedMarkdown(file.name) && file.path !== null"
                type="button"
                class="btn-file"
                data-testid="open-file-button"
                :disabled="loading || stale"
                @click="openFile(file.path)"
              >
                {{ file.name }}
              </button>
              <span
                v-else
                class="browser-file-unsupported"
                :title="file.path === null ? 'Ambiguous path' : 'Unsupported file type'"
              >
                {{ file.name }}
              </span>
            </li>
          </ul>
        </div>
      </template>
    </template>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { getVaultEntries } from './api.js'
import MarkdownViewer from '../markdown/MarkdownViewer.vue'

const props = defineProps({
  vault: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits(['back', 'unauthorized'])

const currentPath = ref('')
const selectedFile = ref(null)
const entries = ref([])
const loading = ref(true)
const hasLoaded = ref(false)
const error = ref('')
const stale = ref(false)

let mounted = true
let latestRequestId = 0

const selectedFileName = computed(() => {
  if (!selectedFile.value) return ''
  const parts = selectedFile.value.split('/')
  return parts[parts.length - 1] || selectedFile.value
})

const isSupportedMarkdown = (filename) => {
  return typeof filename === 'string' && /\.(md|markdown)$/i.test(filename)
}

const openFile = (path) => {
  selectedFile.value = path
}

const closeFile = () => {
  selectedFile.value = null
}

const closeFileAndNavigate = (targetPath) => {
  selectedFile.value = null
  navigateTo(targetPath)
}

const segments = computed(() => {
  return currentPath.value ? currentPath.value.split('/') : []
})

const pathTo = (idx) => {
  return segments.value.slice(0, idx + 1).join('/')
}

const parentPath = computed(() => {
  return segments.value.slice(0, -1).join('/')
})

const folders = computed(() => {
  return entries.value.filter((e) => e.type === 'directory')
})

const files = computed(() => {
  return entries.value.filter((e) => e.type === 'file')
})

const loadDirectory = async (targetPath, { isRefresh = false } = {}) => {
  const requestId = ++latestRequestId
  loading.value = true

  if (!isRefresh) {
    entries.value = []
    stale.value = false
    error.value = ''
  }

  try {
    const result = await getVaultEntries(props.vault.directory, targetPath)
    if (!mounted || requestId !== latestRequestId) {
      return
    }

    currentPath.value = result.path
    entries.value = result.entries
    hasLoaded.value = true
    stale.value = false
    error.value = ''
  } catch (err) {
    if (!mounted || requestId !== latestRequestId) {
      return
    }

    if (err.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }

    if (isRefresh) {
      stale.value = true
      return
    }

    if (err.code === 'VAULT_PATH_NOT_FOUND') {
      error.value = 'Directory not found.'
    } else {
      error.value = 'Could not load directory.'
    }
  } finally {
    if (mounted && requestId === latestRequestId) {
      loading.value = false
    }
  }
}

const navigateTo = (targetPath) => {
  loadDirectory(targetPath)
}

const refresh = () => {
  loadDirectory(currentPath.value, { isRefresh: true })
}

const retry = () => {
  loadDirectory(currentPath.value)
}

onMounted(() => {
  loadDirectory('')
})

onBeforeUnmount(() => {
  mounted = false
})
</script>

<style scoped>
.vault-browser {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.browser-header {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
}

.browser-header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.browser-breadcrumbs {
  font-size: 1.0625rem;
}

.breadcrumb-list {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.breadcrumb-item {
  display: inline-flex;
  align-items: center;
}

.btn-breadcrumb {
  padding: 0;
  border: none;
  background: transparent;
  color: var(--ayame-primary, #a99aca);
  font-family: inherit;
  font-size: inherit;
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 3px;
}

.btn-breadcrumb:hover:not(:disabled) {
  color: var(--ayame-lavender, #d4cbe4);
}

.btn-breadcrumb:disabled {
  opacity: 0.5;
  cursor: default;
}

.breadcrumb-separator {
  color: var(--ayame-text-muted, #aaa6b8);
}

.breadcrumb-current {
  color: var(--ayame-text, #eeeaf3);
  font-weight: 500;
}

.warning-message {
  margin: 0;
  padding: 0.5rem 0.75rem;
  border: 1px solid #786232;
  border-radius: 4px;
  background: #251e12;
  color: #dfba73;
  font-size: 0.875rem;
}

.browser-nav-up {
  margin-bottom: 0.25rem;
}

.browser-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.browser-section-title {
  margin: 0.5rem 0 0.25rem;
  font-size: 0.9375rem;
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  color: var(--ayame-lavender, #d4cbe4);
}

.browser-folder-list,
.browser-file-list {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0;
  margin: 0;
  list-style: none;
}

.btn-folder {
  padding: 0.35rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ayame-primary, #a99aca);
  font-family: inherit;
  font-size: 0.9375rem;
  text-align: left;
  cursor: pointer;
  display: inline-block;
}

.btn-folder:hover:not(:disabled) {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-lavender, #d4cbe4);
}

.btn-folder:disabled {
  opacity: 0.5;
  cursor: default;
}

.browser-folder-unnavigable {
  padding: 0.35rem 0.5rem;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.9375rem;
}

.browser-file-item {
  color: var(--ayame-text, #eeeaf3);
  font-size: 0.9375rem;
  border-radius: 4px;
}

.btn-file {
  padding: 0.35rem 0.5rem;
  border: 1px solid transparent;
  border-radius: 4px;
  background: transparent;
  color: var(--ayame-lavender, #d4cbe4);
  font-family: inherit;
  font-size: 0.9375rem;
  text-align: left;
  cursor: pointer;
  display: inline-block;
  transition: all 0.15s ease;
}

.btn-file:hover:not(:disabled) {
  background: var(--ayame-hover, #242530);
  color: #fff;
}

.btn-file:disabled {
  opacity: 0.5;
  cursor: default;
}

.browser-file-unsupported {
  padding: 0.35rem 0.5rem;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.9375rem;
  display: inline-block;
}

.browser-empty-state {
  color: var(--ayame-text-muted, #aaa6b8);
  font-style: italic;
  margin: 1rem 0;
}

.browser-error-state {
  margin-top: 0.5rem;
}
</style>
