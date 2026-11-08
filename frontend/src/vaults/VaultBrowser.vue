<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import {
  getVaultEntries,
  createVaultFolder,
  createVaultNote,
} from './api.js'
import { resolveLink } from '../markdown/links.js'
import MarkdownViewer from '../markdown/MarkdownViewer.vue'

const props = defineProps({
  vault: {
    type: Object,
    required: true,
  },
})

const emit = defineEmits(['back', 'unauthorized', 'state', 'logout'])

const viewerRef = ref(null)
const createInputRef = ref(null)

const folderEntriesMap = ref(new Map())
const expandedFolders = ref(new Set())
const loadingFolders = ref(new Set())

const loadingRoot = ref(true)
const refreshing = ref(false)
const rootError = ref(null)
const stale = ref(false)
const hasLoadedRoot = ref(false)

const explorerCollapsed = ref(false)
const selectedFolderPath = ref('')
const selectedFile = ref(null)
const selectedAnchor = ref(null)
const initialDocument = ref(null)

const createMode = ref(null) // 'note' | 'folder' | null
const newEntryName = ref('')
const creating = ref(false)
const createError = ref('')

const linkNotice = ref(null)
const pendingNavigation = ref(null)
const viewerState = ref({
  dirty: false,
  saving: false,
  reloading: false,
  saveState: 'saved',
})

let activeRequestId = 0
let isMounted = true

const isMarkdownFile = (name) => {
  const lower = name.toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

const isNavigationBlocked = () =>
  viewerState.value.dirty || viewerState.value.saving || viewerState.value.reloading

const treeRows = computed(() => {
  const rows = []
  const visited = new Set()
  const visit = (parentPath, depth) => {
    const entries = folderEntriesMap.value.get(parentPath) || []
    for (const entry of entries) {
      if (visited.has(entry.path)) continue
      visited.add(entry.path)
      const isDir = entry.type === 'directory'
      const isExpanded = isDir && expandedFolders.value.has(entry.path)
      const isLoading = isDir && loadingFolders.value.has(entry.path)
      rows.push({
        entry,
        depth,
        isDir,
        isExpanded,
        isLoading,
        isMarkdown: !isDir && isMarkdownFile(entry.name),
      })
      if (isDir && isExpanded) {
        visit(entry.path, depth + 1)
      }
    }
  }
  visit('', 0)
  return rows
})

const knownMarkdownFiles = computed(() => {
  const files = new Set()
  for (const entries of folderEntriesMap.value.values()) {
    for (const entry of entries) {
      if (entry.type === 'file' && isMarkdownFile(entry.name)) {
        files.add(entry.path)
      }
    }
  }
  return [...files]
})

const setFolderEntries = (folderPath, entries) => {
  const next = new Map(folderEntriesMap.value)
  next.set(folderPath, entries)
  folderEntriesMap.value = next
}

const fetchDirectory = async (folderPath, { isRefresh = false } = {}) => {
  const reqId = ++activeRequestId
  if (folderPath === '' && !hasLoadedRoot.value) {
    loadingRoot.value = true
    rootError.value = null
  } else if (folderPath !== '') {
    const nextLoading = new Set(loadingFolders.value)
    nextLoading.add(folderPath)
    loadingFolders.value = nextLoading
  }

  try {
    const result = await getVaultEntries(props.vault.directory, folderPath)
    if (!isMounted) return null
    setFolderEntries(folderPath, result.entries || [])
    if (folderPath === '') {
      hasLoadedRoot.value = true
      rootError.value = null
      stale.value = false
    }
    return result.entries || []
  } catch (err) {
    if (!isMounted) return null
    if (err.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return null
    }
    if (folderPath === '') {
      if (isRefresh && hasLoadedRoot.value) {
        stale.value = true
      } else {
        rootError.value = 'Could not load vault contents. Please try again.'
      }
    }
    return null
  } finally {
    if (isMounted) {
      if (folderPath === '' && reqId === activeRequestId) {
        loadingRoot.value = false
      }
      if (folderPath !== '') {
        const nextLoading = new Set(loadingFolders.value)
        nextLoading.delete(folderPath)
        loadingFolders.value = nextLoading
      }
    }
  }
}

const refreshWorkspace = async () => {
  if (refreshing.value || loadingRoot.value) return
  refreshing.value = true
  try {
    await fetchDirectory('', { isRefresh: true })
    const expanded = [...expandedFolders.value]
    for (const folderPath of expanded) {
      await fetchDirectory(folderPath, { isRefresh: true })
    }
  } finally {
    if (isMounted) {
      refreshing.value = false
    }
  }
}

const toggleFolder = async (folderPath) => {
  selectedFolderPath.value = folderPath
  const nextExpanded = new Set(expandedFolders.value)
  if (nextExpanded.has(folderPath)) {
    nextExpanded.delete(folderPath)
    expandedFolders.value = nextExpanded
    return
  }
  nextExpanded.add(folderPath)
  expandedFolders.value = nextExpanded
  if (!folderEntriesMap.value.has(folderPath)) {
    await fetchDirectory(folderPath)
  }
}

const expandAncestors = async (filePath) => {
  const segments = filePath.split('/')
  segments.pop()
  if (segments.length === 0) return
  const nextExpanded = new Set(expandedFolders.value)
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    if (!folderEntriesMap.value.has(current)) {
      await fetchDirectory(current)
    }
    nextExpanded.add(current)
  }
  expandedFolders.value = nextExpanded
}

const selectNote = async (filePath, { anchor = null, initialDoc = null } = {}) => {
  linkNotice.value = null
  if (selectedFile.value === filePath) {
    if (anchor) {
      selectedAnchor.value = anchor
    }
    return
  }

  if (selectedFile.value && viewerRef.value) {
    if (
      viewerState.value.dirty &&
      viewerState.value.saveState !== 'conflict' &&
      viewerState.value.saveState !== 'unknown' &&
      viewerState.value.saveState !== 'error'
    ) {
      await viewerRef.value.flushPendingSave()
    }
    if (isNavigationBlocked()) {
      pendingNavigation.value = { type: 'file', path: filePath, anchor, initialDoc }
      return
    }
  }

  pendingNavigation.value = null
  initialDocument.value = initialDoc
  selectedAnchor.value = anchor
  selectedFile.value = filePath
  const parentSegments = filePath.split('/')
  parentSegments.pop()
  selectedFolderPath.value = parentSegments.join('/')
}

const openFile = async (entry) => {
  if (!isMarkdownFile(entry.name)) return
  await selectNote(entry.path)
}

const closeNote = () => {
  if (isNavigationBlocked()) {
    pendingNavigation.value = { type: 'close-note' }
    return
  }
  selectedFile.value = null
  selectedAnchor.value = null
  initialDocument.value = null
  viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
  emit('state', viewerState.value)
}

const requestBackToVaults = () => {
  if (isNavigationBlocked()) {
    pendingNavigation.value = { type: 'vaults' }
    return
  }
  emit('back')
}

const cancelPendingNavigation = () => {
  pendingNavigation.value = null
}

const confirmDiscardAndNavigate = async () => {
  if (viewerState.value.saving || viewerState.value.reloading) return
  const target = pendingNavigation.value
  pendingNavigation.value = null
  viewerRef.value?.discardChanges?.()
  viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
  emit('state', viewerState.value)

  if (!target || target.type === 'vaults') {
    emit('back')
  } else if (target.type === 'close-note') {
    selectedFile.value = null
    selectedAnchor.value = null
    initialDocument.value = null
  } else if (target.type === 'file') {
    initialDocument.value = target.initialDoc || null
    selectedAnchor.value = target.anchor || null
    selectedFile.value = target.path
  }
}

const handleViewerState = (nextState) => {
  viewerState.value = {
    dirty: Boolean(nextState?.dirty),
    saving: Boolean(nextState?.saving),
    reloading: Boolean(nextState?.reloading),
    saveState: nextState?.saveState || 'saved',
  }
  if (!isNavigationBlocked()) {
    pendingNavigation.value = null
  }
  emit('state', viewerState.value)
}

const discoverUnloadedFolders = async (maxDirectories = 48) => {
  const queue = []
  for (const entries of folderEntriesMap.value.values()) {
    for (const entry of entries) {
      if (entry.type === 'directory' && !folderEntriesMap.value.has(entry.path)) {
        queue.push(entry.path)
      }
    }
  }
  let scanned = 0
  while (queue.length > 0 && scanned < maxDirectories) {
    const folderPath = queue.shift()
    if (folderEntriesMap.value.has(folderPath)) continue
    scanned++
    const entries = await fetchDirectory(folderPath)
    if (!entries) continue
    for (const entry of entries) {
      if (entry.type === 'directory' && !folderEntriesMap.value.has(entry.path)) {
        queue.push(entry.path)
      }
    }
  }
}

const handleOpenLink = async (linkPayload) => {
  linkNotice.value = null
  if (!linkPayload) return

  let resolved = linkPayload
  const rawTarget = linkPayload.rawTarget || ''

  if (
    rawTarget &&
    (resolved.type === 'missing' || (linkPayload.kind === 'wikilink' && !rawTarget.includes('/')))
  ) {
    await discoverUnloadedFolders()
    resolved = resolveLink({
      sourcePath: selectedFile.value || '',
      linkTarget: rawTarget,
      knownFiles: knownMarkdownFiles.value,
      kind: linkPayload.kind || 'wikilink',
    })
  }

  if (resolved.type === 'resolved' && resolved.path) {
    await expandAncestors(resolved.path)
    await selectNote(resolved.path, { anchor: resolved.anchor || null })
  } else if (resolved.type === 'missing') {
    linkNotice.value = {
      type: 'missing',
      message: `Note "${rawTarget || 'target'}" does not exist in this vault.`,
    }
  } else if (resolved.type === 'ambiguous') {
    linkNotice.value = {
      type: 'ambiguous',
      message: `Multiple notes match "${rawTarget}". Choose a note:`,
      candidates: resolved.candidates || [],
      anchor: resolved.anchor || null,
    }
  } else {
    linkNotice.value = {
      type: 'invalid',
      message: 'This internal link points to an invalid vault path.',
    }
  }
}

const openCandidateLink = async (candidatePath, anchor = null) => {
  linkNotice.value = null
  await expandAncestors(candidatePath)
  await selectNote(candidatePath, { anchor })
}

const startCreate = async (mode) => {
  createMode.value = mode
  newEntryName.value = ''
  createError.value = ''
  await nextTick()
  createInputRef.value?.focus?.()
}

const cancelCreate = () => {
  if (creating.value) return
  createMode.value = null
  newEntryName.value = ''
  createError.value = ''
}

const formatCreateError = (err, mode) => {
  const label = mode === 'folder' ? 'folder' : 'note'
  if (err.code === 'VAULT_ENTRY_EXISTS') {
    return `A ${label} with that name already exists in this location.`
  }
  if (err.code === 'INVALID_VAULT_ENTRY_NAME' || err.code === 'INVALID_VAULT_PATH') {
    return `Enter a valid ${label} name without path separators.`
  }
  if (err.code === 'VAULT_PATH_NOT_FOUND') {
    return 'The target parent folder no longer exists.'
  }
  if (err.code === 'VAULT_CREATE_RESULT_UNKNOWN') {
    return `The ${label} creation result is uncertain. Refresh the explorer to verify.`
  }
  return `Could not create the ${label}. Please try again.`
}

const submitCreate = async () => {
  if (creating.value || !createMode.value) return
  const mode = createMode.value
  const trimmed = newEntryName.value.trim()
  if (!trimmed) {
    createError.value = `Enter a ${mode === 'folder' ? 'folder' : 'note'} name.`
    return
  }

  creating.value = true
  createError.value = ''
  const parentPath = selectedFolderPath.value || ''

  try {
    if (mode === 'folder') {
      const created = await createVaultFolder(props.vault.directory, {
        parentPath,
        name: trimmed,
      })
      if (!isMounted) return
      await fetchDirectory(parentPath)
      if (parentPath) {
        const nextExpanded = new Set(expandedFolders.value)
        nextExpanded.add(parentPath)
        expandedFolders.value = nextExpanded
      }
      selectedFolderPath.value = created.path
      createMode.value = null
      newEntryName.value = ''
    } else {
      const created = await createVaultNote(props.vault.directory, {
        parentPath,
        name: trimmed,
      })
      if (!isMounted) return
      await fetchDirectory(parentPath)
      if (parentPath) {
        const nextExpanded = new Set(expandedFolders.value)
        nextExpanded.add(parentPath)
        expandedFolders.value = nextExpanded
      }
      createMode.value = null
      newEntryName.value = ''
      await selectNote(created.path, {
        initialDoc: {
          path: created.path,
          content: '',
          revision: created.revision,
        },
      })
    }
  } catch (err) {
    if (!isMounted) return
    if (err.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    createError.value = formatCreateError(err, mode)
  } finally {
    if (isMounted) {
      creating.value = false
    }
  }
}

watch(
  () => props.vault.directory,
  () => {
    folderEntriesMap.value = new Map()
    expandedFolders.value = new Set()
    selectedFolderPath.value = ''
    selectedFile.value = null
    selectedAnchor.value = null
    initialDocument.value = null
    hasLoadedRoot.value = false
    fetchDirectory('')
  }
)

onMounted(() => {
  isMounted = true
  fetchDirectory('')
})

onUnmounted(() => {
  isMounted = false
  activeRequestId++
})
</script>

<template>
  <section class="vault-browser workspace-shell" data-testid="vault-browser">
    <header class="workspace-topbar">
      <div class="workspace-topbar-left">
        <button
          type="button"
          class="btn-secondary btn-icon"
          data-testid="toggle-explorer-button"
          :aria-expanded="!explorerCollapsed ? 'true' : 'false'"
          title="Toggle file explorer"
          @click="explorerCollapsed = !explorerCollapsed"
        >
          ☰
        </button>
        <div class="vault-browser-title-row">
          <h2 class="vault-browser-title">{{ vault.name }}</h2>
          <span class="vault-directory-badge">{{ vault.directory }}</span>
        </div>
      </div>

      <div class="workspace-topbar-actions">
        <button
          type="button"
          class="btn-secondary"
          data-testid="refresh-browser-button"
          :disabled="loadingRoot || refreshing || viewerState.saving || viewerState.reloading"
          @click="refreshWorkspace"
        >
          {{ refreshing ? 'Refreshing…' : 'Refresh' }}
        </button>
        <button
          type="button"
          class="btn-secondary"
          data-testid="back-to-vaults-button"
          :disabled="viewerState.saving || viewerState.reloading"
          @click="requestBackToVaults"
        >
          Vaults
        </button>
        <button
          type="button"
          class="btn-secondary"
          data-testid="logout-button"
          :disabled="viewerState.saving || viewerState.reloading"
          @click="$emit('logout')"
        >
          Logout
        </button>
      </div>
    </header>

    <div
      v-if="pendingNavigation"
      class="browser-alert browser-navigation-confirm"
      role="alert"
    >
      <p>
        {{
          viewerState.saving
            ? 'Wait for the current save to finish before leaving this note.'
            : viewerState.reloading
              ? 'Wait for the server copy to finish loading before leaving this note.'
              : 'You have unconfirmed changes in this note. Discard them?'
        }}
      </p>
      <div class="workspace-confirm-actions">
        <button
          type="button"
          class="btn-secondary"
          data-testid="navigation-keep-editing"
          @click="cancelPendingNavigation"
        >
          Keep editing
        </button>
        <button
          v-if="!viewerState.saving && !viewerState.reloading"
          type="button"
          class="btn-secondary"
          data-testid="navigation-discard-changes"
          @click="confirmDiscardAndNavigate"
        >
          Discard changes
        </button>
      </div>
    </div>

    <div class="workspace-body">
      <aside
        class="workspace-explorer"
        :class="{ 'workspace-explorer--collapsed': explorerCollapsed }"
        data-testid="vault-explorer"
      >
        <div class="explorer-toolbar">
          <button
            type="button"
            class="explorer-target-folder"
            :class="{ 'explorer-target-folder--root': selectedFolderPath === '' }"
            title="Select root folder as creation target"
            @click="selectedFolderPath = ''"
          >
            /{{ selectedFolderPath }}
          </button>
          <div class="explorer-toolbar-buttons">
            <button
              type="button"
              class="btn-secondary btn-compact"
              data-testid="new-note-button"
              :disabled="creating"
              @click="startCreate('note')"
            >
              + Note
            </button>
            <button
              type="button"
              class="btn-secondary btn-compact"
              data-testid="new-folder-button"
              :disabled="creating"
              @click="startCreate('folder')"
            >
              + Folder
            </button>
          </div>
        </div>

        <form
          v-if="createMode"
          class="explorer-create-form"
          @submit.prevent="submitCreate"
        >
          <label class="explorer-create-label">
            New {{ createMode === 'folder' ? 'folder' : 'note' }} in
            <code>/{{ selectedFolderPath }}</code>
          </label>
          <input
            ref="createInputRef"
            v-model="newEntryName"
            type="text"
            class="explorer-create-input"
            data-testid="new-entry-input"
            :placeholder="createMode === 'folder' ? 'Folder name' : 'Note name'"
            :disabled="creating"
            @keydown.esc.prevent="cancelCreate"
          />
          <div class="explorer-create-actions">
            <button
              type="button"
              class="btn-primary btn-compact"
              data-testid="new-entry-submit"
              :disabled="creating"
              @click="submitCreate"
            >
              Create
            </button>
            <button
              type="button"
              class="btn-secondary btn-compact"
              data-testid="new-entry-cancel"
              :disabled="creating"
              @click="cancelCreate"
            >
              Cancel
            </button>
          </div>
        </form>

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

        <div class="workspace-tree" role="tree">
          <div
            v-if="loadingRoot"
            class="browser-loading"
            data-testid="browser-loading"
            role="status"
          >
            Loading vault contents…
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
              @click="fetchDirectory('')"
            >
              Try again
            </button>
          </div>

          <div
            v-else-if="treeRows.length === 0"
            class="browser-empty"
            data-testid="browser-empty"
          >
            This vault is empty.
          </div>

          <template v-else>
            <template v-for="row in treeRows" :key="row.entry.path">
              <button
                v-if="row.isDir"
                type="button"
                class="tree-row tree-folder"
                :class="{ 'tree-folder--selected': selectedFolderPath === row.entry.path }"
                data-testid="open-directory-button"
                :data-folder-path="row.entry.path"
                :aria-expanded="row.isExpanded ? 'true' : 'false'"
                :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
                @click="toggleFolder(row.entry.path)"
              >
                <span class="tree-chevron" aria-hidden="true">
                  {{ row.isExpanded ? '▾' : '▸' }}
                </span>
                <span class="tree-label">{{ row.entry.name }}</span>
              </button>

              <button
                v-else-if="row.isMarkdown"
                type="button"
                class="tree-row tree-file"
                :class="{ 'tree-file--active': selectedFile === row.entry.path }"
                data-testid="open-file-button"
                :data-file-path="row.entry.path"
                :style="{ paddingLeft: `${row.depth * 14 + 24}px` }"
                @click="openFile(row.entry)"
              >
                <span class="tree-label">{{ row.entry.name }}</span>
              </button>

              <div
                v-else
                class="tree-row tree-file tree-file--readonly"
                :style="{ paddingLeft: `${row.depth * 14 + 24}px` }"
              >
                <span class="tree-label">{{ row.entry.name }}</span>
                <span class="entry-badge">FILE</span>
              </div>
            </template>
          </template>
        </div>
      </aside>

      <main
        class="workspace-editor-pane"
        data-testid="workspace-editor-pane"
      >
        <div
          v-if="linkNotice"
          class="browser-alert workspace-link-notice"
          data-testid="workspace-link-notice"
          role="status"
        >
          <div class="workspace-link-notice-header">
            <span>{{ linkNotice.message }}</span>
            <button
              type="button"
              class="btn-secondary btn-compact"
              @click="linkNotice = null"
            >
              Dismiss
            </button>
          </div>
          <div
            v-if="linkNotice.candidates && linkNotice.candidates.length"
            class="workspace-link-candidates"
          >
            <button
              v-for="candidate in linkNotice.candidates"
              :key="candidate"
              type="button"
              class="btn-secondary btn-compact"
              :data-candidate-path="candidate"
              @click="openCandidateLink(candidate, linkNotice.anchor)"
            >
              {{ candidate }}
            </button>
          </div>
        </div>

        <MarkdownViewer
          v-if="selectedFile !== null"
          ref="viewerRef"
          :directory="vault.directory"
          :path="selectedFile"
          :known-files="knownMarkdownFiles"
          :anchor="selectedAnchor"
          :initial-document="initialDocument"
          @back="closeNote"
          @state="handleViewerState"
          @open-link="handleOpenLink"
          @unauthorized="emit('unauthorized')"
        />

        <div
          v-else
          class="workspace-empty-state"
          data-testid="workspace-empty-state"
        >
          <p class="workspace-empty-title">No note selected</p>
          <p class="workspace-empty-subtitle">
            Choose a Markdown note in the explorer or click <strong>+ Note</strong> to start writing.
          </p>
        </div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.workspace-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 76vh;
  background-color: var(--ayame-surface);
  border: 1px solid var(--ayame-border);
  border-radius: 12px;
  overflow: hidden;
}

.workspace-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.7rem 1rem;
  border-bottom: 1px solid var(--ayame-border);
  background-color: rgba(17, 18, 24, 0.55);
}

.workspace-topbar-left {
  display: flex;
  align-items: center;
  gap: 0.65rem;
  min-width: 0;
}

.vault-browser-title-row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}

.vault-browser-title {
  font-size: 1rem;
  font-weight: 600;
  margin: 0;
  color: var(--ayame-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.vault-directory-badge {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.72rem;
  color: var(--ayame-muted);
  background-color: rgba(255, 255, 255, 0.04);
  padding: 0.12rem 0.45rem;
  border-radius: 4px;
  border: 1px solid var(--ayame-border);
}

.workspace-topbar-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}

.workspace-body {
  display: grid;
  grid-template-columns: 280px minmax(0, 1fr);
  flex: 1;
  min-height: 68vh;
}

.workspace-explorer {
  display: flex;
  flex-direction: column;
  width: 280px;
  border-right: 1px solid var(--ayame-border);
  background-color: rgba(17, 18, 24, 0.4);
  overflow: hidden;
}

.workspace-explorer--collapsed {
  display: none;
}

.workspace-explorer--collapsed + .workspace-editor-pane {
  grid-column: 1 / -1;
}

.explorer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.4rem;
  padding: 0.55rem 0.65rem;
  border-bottom: 1px solid var(--ayame-border);
}

.explorer-target-folder {
  background: transparent;
  border: none;
  color: var(--ayame-muted);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.75rem;
  padding: 0.2rem 0.35rem;
  border-radius: 4px;
  cursor: pointer;
  text-align: left;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 120px;
}

.explorer-target-folder:hover {
  color: var(--ayame-text);
  background-color: rgba(255, 255, 255, 0.04);
}

.explorer-toolbar-buttons {
  display: flex;
  gap: 0.35rem;
  flex-shrink: 0;
}

.explorer-create-form {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.65rem;
  border-bottom: 1px solid var(--ayame-border);
  background-color: rgba(169, 154, 202, 0.06);
}

.explorer-create-label {
  font-size: 0.75rem;
  color: var(--ayame-muted);
}

.explorer-create-input {
  width: 100%;
  padding: 0.4rem 0.55rem;
  background-color: var(--ayame-background);
  border: 1px solid var(--ayame-border);
  border-radius: 6px;
  color: var(--ayame-text);
  font-size: 0.84rem;
}

.explorer-create-input:focus {
  outline: none;
  border-color: var(--ayame-primary);
}

.explorer-create-actions {
  display: flex;
  gap: 0.4rem;
}

.explorer-alert {
  margin: 0.5rem;
  font-size: 0.8rem;
}

.workspace-tree {
  flex: 1;
  overflow-y: auto;
  padding: 0.4rem 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
  padding-top: 0.36rem;
  padding-bottom: 0.36rem;
  padding-right: 0.55rem;
  border: 1px solid transparent;
  border-radius: 6px;
  background: transparent;
  color: var(--ayame-text);
  font-size: 0.86rem;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}

.tree-row:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.tree-folder {
  font-weight: 500;
}

.tree-folder--selected {
  background-color: rgba(169, 154, 202, 0.08);
}

.tree-chevron {
  width: 0.85rem;
  color: var(--ayame-muted);
  font-size: 0.75rem;
  flex-shrink: 0;
}

.tree-file--active {
  background-color: rgba(169, 154, 202, 0.16);
  border-color: rgba(169, 154, 202, 0.34);
  color: var(--ayame-primary);
  font-weight: 500;
}

.tree-file--readonly {
  color: var(--ayame-muted);
  cursor: default;
  justify-content: space-between;
}

.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.entry-badge {
  font-size: 0.65rem;
  color: var(--ayame-muted);
  letter-spacing: 0.05em;
}

.workspace-editor-pane {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 1rem 1.25rem;
  overflow-y: auto;
  background-color: var(--ayame-surface);
}

.workspace-empty-state {
  margin: auto;
  text-align: center;
  max-width: 360px;
  padding: 2rem 1rem;
  color: var(--ayame-muted);
}

.workspace-empty-title {
  margin: 0 0 0.35rem;
  font-size: 1rem;
  font-weight: 600;
  color: var(--ayame-text);
}

.workspace-empty-subtitle {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.5;
}

.browser-alert {
  padding: 0.7rem 0.9rem;
  border-radius: 8px;
  font-size: 0.85rem;
}

.browser-error {
  background-color: var(--ayame-error-bg);
  border: 1px solid rgba(229, 115, 115, 0.3);
  color: var(--ayame-error);
}

.browser-stale,
.browser-navigation-confirm,
.workspace-link-notice {
  background-color: rgba(169, 154, 202, 0.08);
  border: 1px solid rgba(169, 154, 202, 0.28);
  color: var(--ayame-text);
}

.browser-navigation-confirm {
  margin: 0.65rem 1rem 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.browser-navigation-confirm p {
  margin: 0;
}

.workspace-confirm-actions {
  display: flex;
  gap: 0.45rem;
}

.workspace-link-notice {
  margin-bottom: 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.workspace-link-notice-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.workspace-link-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}

.browser-loading,
.browser-empty {
  padding: 1.5rem 0.75rem;
  text-align: center;
  color: var(--ayame-muted);
  font-size: 0.85rem;
}

.btn-primary {
  padding: 0.38rem 0.7rem;
  background-color: var(--ayame-primary);
  color: #111218;
  border: 1px solid var(--ayame-primary);
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 600;
  cursor: pointer;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  padding: 0.38rem 0.7rem;
  background-color: transparent;
  color: var(--ayame-text);
  border: 1px solid var(--ayame-border);
  border-radius: 6px;
  font-size: 0.8rem;
  font-weight: 500;
  cursor: pointer;
}

.btn-secondary:hover:not(:disabled) {
  border-color: var(--ayame-primary);
  color: var(--ayame-primary);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-compact {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
}

.btn-icon {
  padding: 0.3rem 0.55rem;
  font-size: 0.9rem;
}

@media (max-width: 760px) {
  .workspace-body {
    grid-template-columns: 1fr;
  }

  .workspace-explorer {
    width: 100%;
    max-height: 240px;
    border-right: none;
    border-bottom: 1px solid var(--ayame-border);
  }
}
</style>
