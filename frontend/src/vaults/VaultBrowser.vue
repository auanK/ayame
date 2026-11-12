<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted, toRaw } from 'vue'
import * as vaultApi from './api.js'
import {
  resolveLink,
  resolvePendingLinkCreationTarget,
  formatInternalLink,
} from '../markdown/links.js'
import { buildInitialNoteContent } from '../markdown/properties.js'
import {
  buildVaultIndex,
  updateNoteInVaultIndex,
  getBacklinksForNote,
  getOutgoingLinksForNote,
  getNotesByTag,
  searchVaultNotes,
} from './vaultIndex.js'
import { calculateContextMenuPosition } from './contextMenuPosition.js'
import { useAyameRouter, validateNoteQueryParam } from '../router/index.js'
import MarkdownViewer from '../markdown/MarkdownViewer.vue'

const isTestEnv = typeof process !== 'undefined' && process.env?.NODE_ENV === 'test'

const props = defineProps({
  vault: {
    type: Object,
    required: true,
  },
  pending: {
    type: Boolean,
    default: false,
  },
  editorSaving: {
    type: Boolean,
    default: false,
  },
  editorReloading: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['back', 'unauthorized', 'state', 'logout'])

const { router, route } = useAyameRouter({
  initialVaultDirectory: props.vault.directory,
})

const LAYOUT_STORAGE_KEY = `ayame:layout:${props.vault.directory}`

const loadSavedLayout = () => {
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        explorerOpen: typeof parsed.explorerOpen === 'boolean' ? parsed.explorerOpen : true,
        explorerWidth: typeof parsed.explorerWidth === 'number' ? Math.max(180, Math.min(480, parsed.explorerWidth)) : 260,
        contextOpen: typeof parsed.contextOpen === 'boolean' ? parsed.contextOpen : false,
        contextWidth: typeof parsed.contextWidth === 'number' ? Math.max(200, Math.min(480, parsed.contextWidth)) : 280,
      }
    }
  } catch {}
  return {
    explorerOpen: true,
    explorerWidth: 260,
    contextOpen: false,
    contextWidth: 280,
  }
}

const layout = ref(loadSavedLayout())

const persistLayout = () => {
  try {
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout.value))
  } catch {}
}

const explorerCollapsed = computed({
  get: () => !layout.value.explorerOpen,
  set: (val) => {
    layout.value.explorerOpen = !val
    persistLayout()
  },
})

const rightPanelCollapsed = computed({
  get: () => !layout.value.contextOpen,
  set: (val) => {
    layout.value.contextOpen = !val
    persistLayout()
  },
})

let draggingSplitter = null
let dragStartX = 0
let dragStartWidth = 0

function handleExplorerPointerDown(event) {
  event.preventDefault()
  draggingSplitter = 'explorer'
  dragStartX = event.clientX
  dragStartWidth = layout.value.explorerWidth
  if (event.currentTarget && event.currentTarget.setPointerCapture) {
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {}
  }
  window.addEventListener('pointermove', onSplitterPointerMove)
  window.addEventListener('pointerup', onSplitterPointerUp)
  window.addEventListener('pointercancel', onSplitterPointerUp)
}

function handleContextPointerDown(event) {
  event.preventDefault()
  draggingSplitter = 'context'
  dragStartX = event.clientX
  dragStartWidth = layout.value.contextWidth
  if (event.currentTarget && event.currentTarget.setPointerCapture) {
    try {
      event.currentTarget.setPointerCapture(event.pointerId)
    } catch {}
  }
  window.addEventListener('pointermove', onSplitterPointerMove)
  window.addEventListener('pointerup', onSplitterPointerUp)
  window.addEventListener('pointercancel', onSplitterPointerUp)
}

function onSplitterPointerMove(event) {
  if (!draggingSplitter) return
  const delta = event.clientX - dragStartX
  const containerWidth = window.innerWidth
  const contextW = layout.value.contextOpen ? layout.value.contextWidth : 0
  const explorerW = layout.value.explorerOpen ? layout.value.explorerWidth : 0

  if (draggingSplitter === 'explorer') {
    const maxW = Math.max(180, Math.min(480, containerWidth - contextW - 420))
    const newW = Math.max(180, Math.min(maxW, dragStartWidth + delta))
    layout.value.explorerWidth = newW
  } else if (draggingSplitter === 'context') {
    const maxW = Math.max(200, Math.min(480, containerWidth - explorerW - 420))
    const newW = Math.max(200, Math.min(maxW, dragStartWidth - delta))
    layout.value.contextWidth = newW
  }
}

function onSplitterPointerUp() {
  if (!draggingSplitter) return
  draggingSplitter = null
  window.removeEventListener('pointermove', onSplitterPointerMove)
  window.removeEventListener('pointerup', onSplitterPointerUp)
  window.removeEventListener('pointercancel', onSplitterPointerUp)
  persistLayout()
}

function handleExplorerSplitterKey(event) {
  const step = event.shiftKey ? 50 : 10
  const containerWidth = window.innerWidth
  const contextW = layout.value.contextOpen ? layout.value.contextWidth : 0
  const maxW = Math.max(180, Math.min(480, containerWidth - contextW - 420))
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    layout.value.explorerWidth = Math.min(maxW, layout.value.explorerWidth + step)
    persistLayout()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    layout.value.explorerWidth = Math.max(180, layout.value.explorerWidth - step)
    persistLayout()
  } else if (event.key === 'Home') {
    event.preventDefault()
    layout.value.explorerWidth = 180
    persistLayout()
  } else if (event.key === 'End') {
    event.preventDefault()
    layout.value.explorerWidth = maxW
    persistLayout()
  }
}

function handleContextSplitterKey(event) {
  const step = event.shiftKey ? 50 : 10
  const containerWidth = window.innerWidth
  const explorerW = layout.value.explorerOpen ? layout.value.explorerWidth : 0
  const maxW = Math.max(200, Math.min(480, containerWidth - explorerW - 420))
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    layout.value.contextWidth = Math.min(maxW, layout.value.contextWidth + step)
    persistLayout()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    layout.value.contextWidth = Math.max(200, layout.value.contextWidth - step)
    persistLayout()
  } else if (event.key === 'Home') {
    event.preventDefault()
    layout.value.contextWidth = 200
    persistLayout()
  } else if (event.key === 'End') {
    event.preventDefault()
    layout.value.contextWidth = maxW
    persistLayout()
  }
}

const stripMarkdownExtension = (name) => {
  if (typeof name !== 'string') return ''
  return name.replace(/\.(md|markdown)$/i, '')
}

const viewerRef = ref(null)
const createInputRef = ref(null)
const relocateInputRef = ref(null)

const folderEntriesMap = ref(new Map())
const expandedFolders = ref(new Set())
const loadingFolders = ref(new Set())

const loadingRoot = ref(true)
const refreshing = ref(false)
const rootError = ref(null)
const stale = ref(false)
const hasLoadedRoot = ref(false)

const rightPanelTab = ref('backlinks')

const selectedFolderPath = ref('')
const selectedFile = ref(null)
const selectedAnchor = ref(null)
const initialDocument = ref(null)

// Tabs & Navigation History
const openTabs = ref([])
const navHistory = ref([])
const navHistoryIndex = ref(-1)
let navigatingHistory = false

// Vault Index
const vaultIndexData = ref(
  buildVaultIndex({ directory: '', complete: false, folders: [], files: [], notes: [] })
)

// Vault Settings & Modals
const vaultSettings = ref({
  newNoteLocation: 'root',
  newNoteFolder: '',
  linkFormat: 'shortest',
  useWikilinks: true,
  autoUpdateLinks: true,
  deleteBehavior: 'trash',
  defaultFrontmatterOnCreate: false,
  showUnsupportedFiles: false,
})
const showSettingsModal = ref(false)
const showVaultMenu = ref(false)
const showAddMenu = ref(false)

// Creation state
const createMode = ref(null) // 'note' | 'folder' | null
const newEntryName = ref('')
const creating = ref(false)
const createError = ref('')

// Context menu
const contextMenu = ref(null)
const contextMenuPos = ref({ left: 0, top: 0 })

// Floating toasts
let toastCounter = 0
const toasts = ref([])

const addToast = (message, type = 'info', duration = 2800) => {
  const id = ++toastCounter
  toasts.value.push({ id, message, type })
  if (duration > 0) {
    setTimeout(() => {
      removeToast(id)
    }, duration)
  }
  return id
}

const removeToast = (id) => {
  toasts.value = toasts.value.filter((t) => t.id !== id)
}

// Relocate (Rename / Move) & Delete state
const relocateState = ref(null)
const deleteConfirmState = ref(null)
const draggedEntry = ref(null)
const dropTarget = ref(null)
const viewerStateGeneration = ref(0)

// Trash state
const showTrashModal = ref(false)
const trashItems = ref([])
const trashLoading = ref(false)
const trashError = ref('')
const trashRestoreConflict = ref(null)

// Search, Tag Filter, Command Palette & Quick Switcher
const searchQuery = ref('')
const activeTagFilter = ref('')
const showCommandPalette = ref(false)
const commandPaletteQuery = ref('')
const showQuickSwitcher = ref(false)
const quickSwitcherQuery = ref('')

const linkNotice = ref(null)
const workspaceNotice = ref('')
const pendingNavigation = ref(null)
const viewerState = ref({
  dirty: false,
  saving: false,
  reloading: false,
  saveState: 'saved',
})

const directoryRequestIds = new Map()
let directoryRequestGeneration = 0
let indexRequestGeneration = 0
let isMounted = true

const invalidateVaultIndexRequest = () => {
  indexRequestGeneration++
}

const isMarkdownFile = (name) => {
  const lower = String(name || '').toLowerCase()
  return lower.endsWith('.md') || lower.endsWith('.markdown')
}

const isInternalAyameEntry = (name) =>
  typeof name === 'string' &&
  (name === '.trash' || name.endsWith('.ayame.lock') || /^\..*\.ayame-[a-f0-9]+\.tmp$/i.test(name))

const isVisibleEntry = (entry, showUnsupported) => {
  if (!entry?.path || isInternalAyameEntry(entry.name)) return false
  if (entry.type === 'directory') {
    return entry.name !== '.obsidian' || Boolean(showUnsupported)
  }
  if (entry.type !== 'file') return false
  return isMarkdownFile(entry.name) || Boolean(showUnsupported)
}

const isNavigationBlocked = () =>
  viewerState.value.dirty || viewerState.value.saving || viewerState.value.reloading

const createDepth = computed(() => {
  if (!selectedFolderPath.value) return 0
  return selectedFolderPath.value.split('/').length
})

const treeRows = computed(() => {
  const rows = []
  const visited = new Set()
  const showUnsupported = vaultSettings.value.showUnsupportedFiles
  const visit = (parentPath, depth) => {
    const rawEntries = folderEntriesMap.value.get(parentPath) || []
    const entries = [...rawEntries].sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1
      }
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
    })
    for (const entry of entries) {
      if (!isVisibleEntry(entry, showUnsupported)) continue
      const visitKey = `${entry.type}:${entry.path}`
      if (visited.has(visitKey)) continue
      visited.add(visitKey)
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
  const files = new Set(vaultIndexData.value.files.filter(isMarkdownFile))
  for (const entries of folderEntriesMap.value.values()) {
    for (const entry of entries) {
      if (entry.type === 'file' && entry.path && isMarkdownFile(entry.name)) {
        files.add(entry.path)
      }
    }
  }
  return [...files].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
})

const activeBacklinks = computed(() =>
  selectedFile.value
    ? getBacklinksForNote(vaultIndexData.value, selectedFile.value)
    : { linked: [], unlinkedMentions: [] }
)

const activeOutgoingLinks = computed(() =>
  selectedFile.value
    ? getOutgoingLinksForNote(vaultIndexData.value, selectedFile.value)
    : { resolved: [], unresolved: [] }
)

const activeOutline = computed(() =>
  selectedFile.value ? vaultIndexData.value.headingsByFile?.[selectedFile.value] || [] : []
)

const filteredTagNotes = computed(() =>
  activeTagFilter.value ? getNotesByTag(vaultIndexData.value, activeTagFilter.value) : []
)

const searchResults = computed(() =>
  searchVaultNotes(vaultIndexData.value, searchQuery.value)
)

const availableCommands = computed(() => {
  const cmds = [
    { id: 'new-note', label: 'New note', run: () => startCreate('note') },
    { id: 'new-folder', label: 'New folder', run: () => startCreate('folder') },
    { id: 'toggle-explorer', label: 'Toggle file explorer', run: () => { explorerCollapsed.value = !explorerCollapsed.value } },
    { id: 'toggle-right-panel', label: 'Toggle contextual panel', run: () => { rightPanelCollapsed.value = !rightPanelCollapsed.value } },
    { id: 'toggle-properties', label: 'Toggle properties (Hidden / Visible / Source)', run: () => viewerRef.value?.cyclePropertiesMode?.() },
    { id: 'toggle-readable-line', label: 'Toggle readable line length', run: () => viewerRef.value?.toggleReadableLineLength?.() },
    { id: 'reveal-active', label: 'Reveal active note in explorer', run: () => revealActiveFile() },
    { id: 'open-trash', label: 'Open vault trash', run: () => openTrashModal() },
    { id: 'vault-settings', label: 'Vault settings', run: () => { showSettingsModal.value = true } },
    { id: 'refresh', label: 'Refresh vault', run: () => refreshWorkspace() },
    { id: 'switch-vault', label: 'Switch vault', run: () => requestBackToVaults() },
    { id: 'nav-back', label: 'Navigate backward in history', run: () => navigateHistoryBack() },
    { id: 'nav-forward', label: 'Navigate forward in history', run: () => navigateHistoryForward() },
    { id: 'logout', label: 'Logout', run: () => emit('logout') },
  ]
  return cmds
})

const commandPaletteItems = computed(() => {
  const q = commandPaletteQuery.value.trim().toLowerCase()
  const cmds = availableCommands.value
  if (!q) return cmds

  const matchedCmds = cmds.filter((c) => c.label.toLowerCase().includes(q))
  const matchedFiles = knownMarkdownFiles.value
    .filter((f) => f.toLowerCase().includes(q))
    .slice(0, 15)
    .map((f) => ({
      id: `file-${f}`,
      label: `Note: ${stripMarkdownExtension(f.split('/').pop())} (${f})`,
      run: () => {
        openCandidateLink(f)
      },
    }))
  return [...matchedCmds, ...matchedFiles]
})

const quickSwitcherResults = computed(() => {
  const q = quickSwitcherQuery.value.trim().toLowerCase()
  const files = knownMarkdownFiles.value
  if (!q) return files.slice(0, 30)
  return files.filter((f) => f.toLowerCase().includes(q)).slice(0, 30)
})

const setFolderEntries = (folderPath, entries) => {
  const next = new Map(folderEntriesMap.value)
  next.set(folderPath, entries)
  folderEntriesMap.value = next
}

const fetchVaultIndexSafe = async () => {
  const generation = ++indexRequestGeneration
  const directory = props.vault.directory
  const isCurrent = () =>
    isMounted && generation === indexRequestGeneration && directory === props.vault.directory

  try {
    if (!('getVaultIndex' in vaultApi) || typeof vaultApi.getVaultIndex !== 'function') return false
    const raw = await vaultApi.getVaultIndex(directory)
    if (!isCurrent() || !raw || raw.directory !== directory) return false
    vaultIndexData.value = buildVaultIndex(raw)
    return true
  } catch (err) {
    if (!isCurrent()) return false
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
    }
    return false
  }
}

const fetchDirectory = async (folderPath, { isRefresh = false } = {}) => {
  const generation = directoryRequestGeneration
  const reqId = (directoryRequestIds.get(folderPath) || 0) + 1
  const directory = props.vault.directory
  directoryRequestIds.set(folderPath, reqId)
  const isCurrent = () =>
    isMounted && generation === directoryRequestGeneration && directory === props.vault.directory &&
    directoryRequestIds.get(folderPath) === reqId
  if (folderPath === '' && !hasLoadedRoot.value) {
    loadingRoot.value = true
    rootError.value = null
  } else if (folderPath !== '') {
    const nextLoading = new Set(loadingFolders.value)
    nextLoading.add(folderPath)
    loadingFolders.value = nextLoading
  }

  try {
    const result = await vaultApi.getVaultEntries(directory, folderPath)
    if (!isCurrent()) return null
    setFolderEntries(folderPath, result.entries || [])
    if (folderPath === '') {
      hasLoadedRoot.value = true
      rootError.value = null
      stale.value = false
    }
    return result.entries || []
  } catch (err) {
    if (!isCurrent()) return null
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
    if (isCurrent()) {
      if (folderPath === '') {
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

const discoverUnloadedFolders = async (maxDirectories = 48) => {
  if (vaultIndexData.value.complete && vaultIndexData.value.files.length > 0) return
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

const refreshWorkspace = async () => {
  if (refreshing.value || loadingRoot.value) return
  refreshing.value = true
  invalidateVaultIndexRequest()
  try {
    const rootEntries = await fetchDirectory('', { isRefresh: true })
    const expanded = [...expandedFolders.value]
    for (const folderPath of expanded) {
      await fetchDirectory(folderPath, { isRefresh: true })
    }
    const indexLoaded = await fetchVaultIndexSafe()
    if (rootEntries && indexLoaded && vaultIndexData.value.complete) {
      await reconcileUncertainRelocation()
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
  const segments = String(filePath || '').split('/')
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

const revealActiveFile = async () => {
  if (!selectedFile.value) return
  explorerCollapsed.value = false
  await expandAncestors(selectedFile.value)
}

const recordNavigationHistory = (filePath) => {
  if (!filePath || navigatingHistory) return
  const current = navHistory.value[navHistoryIndex.value]
  if (current === filePath) return
  const truncated = navHistory.value.slice(0, navHistoryIndex.value + 1)
  truncated.push(filePath)
  navHistory.value = truncated
  navHistoryIndex.value = truncated.length - 1
}

let suppressRouteWatch = false
let internalRouteNavigation = false

const buildVaultLocation = (notePath = null, directory = props.vault.directory) => {
  const query = { ...(route.value?.query || {}) }
  if (notePath) {
    query.note = notePath
  } else {
    delete query.note
  }
  return {
    name: 'vault',
    params: { directory },
    query,
  }
}

const syncUrlWithNote = async (notePath, { replace = false } = {}) => {
  if (!isMounted) return
  const currentDir = route.value?.params?.directory
  const currentNote = typeof route.value?.query?.note === 'string' ? route.value.query.note : null
  const hasExtraNoteQuery = route.value?.query?.note !== undefined && currentNote === null
  if (
    route.value?.name === 'vault' &&
    currentDir === props.vault.directory &&
    currentNote === (notePath || null) &&
    !hasExtraNoteQuery
  ) {
    return
  }
  const targetLocation = buildVaultLocation(notePath, props.vault.directory)
  suppressRouteWatch = true
  internalRouteNavigation = true
  try {
    if (replace) {
      await router.replace(targetLocation)
    } else {
      await router.push(targetLocation)
    }
  } finally {
    internalRouteNavigation = false
    suppressRouteWatch = false
  }
}

const navigateRouterHistory = (delta) =>
  new Promise((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      removeAfter()
      removeError()
      nextTick().then(resolve)
    }
    const removeAfter = router.afterEach(() => {
      finish()
    })
    const removeError = router.onError(() => {
      finish()
    })
    router.go(delta)
    let p = Promise.resolve()
    for (let i = 0; i < 12; i++) {
      p = p.then(() => undefined)
    }
    p.then(finish)
  })

const canNavigateBack = computed(() => navHistoryIndex.value > 0)
const canNavigateForward = computed(() => navHistoryIndex.value >= 0 && navHistoryIndex.value < navHistory.value.length - 1)

const navigateHistoryBack = async () => {
  if (!canNavigateBack.value || relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  await navigateRouterHistory(-1)
}

const navigateHistoryForward = async () => {
  if (!canNavigateForward.value || relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  await navigateRouterHistory(1)
}

const ensureTabOpen = (filePath) => {
  if (!filePath) return
  if (!openTabs.value.includes(filePath)) {
    openTabs.value = [...openTabs.value, filePath]
  }
}

const closeTab = async (tabPath) => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  if (relocateState.value?.stage === 'confirm' && tabPath === selectedFile.value) cancelRelocate()
  if (selectedFile.value === tabPath) {
    if (viewerRef.value) {
      if (
        viewerState.value.dirty &&
        viewerState.value.saveState !== 'conflict' &&
        viewerState.value.saveState !== 'unknown' &&
        viewerState.value.saveState !== 'error'
      ) {
        await viewerRef.value.flushPendingSave()
      }
      if (isNavigationBlocked()) {
        pendingNavigation.value = { type: 'close-tab', tabPath }
        return
      }
    }
    const nextTabs = openTabs.value.filter((t) => t !== tabPath)
    openTabs.value = nextTabs
    if (nextTabs.length > 0) {
      await selectNote(nextTabs[nextTabs.length - 1])
    } else {
      await closeNote()
    }
  } else {
    openTabs.value = openTabs.value.filter((t) => t !== tabPath)
  }
}

const openFileInNewTab = async (filePath) => {
  closeContextMenu()
  await selectNote(filePath, { newTab: true })
}

const selectNote = async (filePath, { anchor = null, initialDoc = null, newTab = false } = {}) => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') {
    workspaceNotice.value = 'Wait for the move to be reconciled before navigating.'
    return
  }
  if (relocateState.value?.stage === 'confirm' && filePath !== selectedFile.value) {
    cancelRelocate()
  }
  linkNotice.value = null
  if (selectedFile.value === filePath) {
    if (anchor) {
      selectedAnchor.value = anchor
    }
    await syncUrlWithNote(filePath)
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
      pendingNavigation.value = { type: 'file', path: filePath, anchor, initialDoc, newTab }
      return
    }
  }

  pendingNavigation.value = null
  initialDocument.value = initialDoc
  selectedAnchor.value = anchor
  const prevActive = selectedFile.value
  selectedFile.value = filePath

  // Tab management: normal click reuses active tab; explicit newTab appends
  if (newTab || openTabs.value.length === 0) {
    if (!openTabs.value.includes(filePath)) {
      openTabs.value = [...openTabs.value, filePath]
    }
  } else {
    // Reusable tab
    if (!openTabs.value.includes(filePath)) {
      const activeIdx = prevActive ? openTabs.value.indexOf(prevActive) : -1
      if (activeIdx >= 0) {
        const next = [...openTabs.value]
        next[activeIdx] = filePath
        openTabs.value = next
      } else {
        openTabs.value = [...openTabs.value, filePath]
      }
    }
  }

  recordNavigationHistory(filePath)
  const parentSegments = filePath.split('/')
  parentSegments.pop()
  selectedFolderPath.value = parentSegments.join('/')
  await syncUrlWithNote(filePath)
}

const openFile = async (entry, { newTab = false } = {}) => {
  if (!entry || entry.type !== 'file' || !isMarkdownFile(entry.name)) return
  await selectNote(entry.path, { newTab })
}

const closeNote = async () => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  if (relocateState.value?.stage === 'confirm') cancelRelocate()
  if (isNavigationBlocked()) {
    pendingNavigation.value = { type: 'close-note' }
    return
  }
  selectedFile.value = null
  selectedAnchor.value = null
  initialDocument.value = null
  viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
  emit('state', viewerState.value)
  await syncUrlWithNote(null)
}

const requestBackToVaults = () => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  if (relocateState.value?.stage === 'confirm') cancelRelocate()
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
  if (viewerState.value.saving || viewerState.value.reloading || relocateState.value?.loading) return
  if (relocateState.value?.stage === 'confirm') cancelRelocate()
  const target = pendingNavigation.value
  pendingNavigation.value = null
  viewerRef.value?.discardChanges?.()
  viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
  emit('state', viewerState.value)

  if (!target || target.type === 'vaults') {
    if (target?.historyDelta === -1 || target?.historyDelta === 1) {
      await navigateRouterHistory(target.historyDelta)
    } else if (target?.to && target.to.name && target.to.name !== 'vaults') {
      await router.push(target.to)
    } else {
      emit('back')
    }
  } else if (target.type === 'close-note') {
    if (target.historyDelta === -1 || target.historyDelta === 1) {
      await navigateRouterHistory(target.historyDelta)
    } else {
      await closeNote()
    }
  } else if (target.type === 'close-tab') {
    await closeTab(target.tabPath)
  } else if (target.type === 'route-note') {
    if (target.historyDelta === -1 || target.historyDelta === 1) {
      await navigateRouterHistory(target.historyDelta)
    } else if (target.path) {
      await selectNote(target.path)
    }
  } else if (target.type === 'file') {
    await selectNote(target.path, {
      anchor: target.anchor,
      initialDoc: target.initialDoc,
      newTab: target.newTab,
    })
  }
}

const handleNoteNotFound = async (missingPath) => {
  if (!missingPath || selectedFile.value !== missingPath) return
  openTabs.value = openTabs.value.filter((t) => t !== missingPath)
  if (navHistory.value[navHistoryIndex.value] === missingPath) {
    navHistory.value = navHistory.value.filter((_, idx) => idx !== navHistoryIndex.value)
    navHistoryIndex.value = Math.min(navHistoryIndex.value, navHistory.value.length - 1)
  }
  selectedFile.value = null
  selectedAnchor.value = null
  initialDocument.value = null
  viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
  emit('state', viewerState.value)
  workspaceNotice.value = `Note "${missingPath}" was not found in this vault.`
  await syncUrlWithNote(null, { replace: true })
}

const applyRouteFromUrl = async ({ isInitial = false } = {}) => {
  if (!isMounted || suppressRouteWatch) return
  if (route.value?.matched?.length === 0) {
    suppressRouteWatch = true
    internalRouteNavigation = true
    try {
      await router.replace(router.options.history.location || `/vault/${encodeURIComponent(props.vault.directory)}`)
    } catch {} finally {
      internalRouteNavigation = false
      suppressRouteWatch = false
    }
  }
  if (!isMounted) return
  if (route.value?.name !== 'vault' || route.value?.params?.directory !== props.vault.directory) {
    return
  }

  const check = validateNoteQueryParam(route.value?.query?.note)
  if (!check.present) {
    if (selectedFile.value !== null) {
      pendingNavigation.value = null
      selectedFile.value = null
      selectedAnchor.value = null
      initialDocument.value = null
      viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
      emit('state', viewerState.value)
    }
    return
  }

  if (!check.valid) {
    pendingNavigation.value = null
    selectedFile.value = null
    selectedAnchor.value = null
    initialDocument.value = null
    viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
    emit('state', viewerState.value)
    workspaceNotice.value = 'Invalid note path in URL.'
    await syncUrlWithNote(null, { replace: true })
    return
  }

  const notePath = check.path
  if (selectedFile.value === notePath) {
    return
  }

  pendingNavigation.value = null
  linkNotice.value = null
  initialDocument.value = null
  selectedAnchor.value = null
  const prevActive = selectedFile.value
  selectedFile.value = notePath

  if (openTabs.value.length === 0) {
    openTabs.value = [notePath]
  } else if (!openTabs.value.includes(notePath)) {
    const activeIdx = prevActive ? openTabs.value.indexOf(prevActive) : -1
    if (activeIdx >= 0) {
      const next = [...openTabs.value]
      next[activeIdx] = notePath
      openTabs.value = next
    } else {
      openTabs.value = [...openTabs.value, notePath]
    }
  }

  const delta = router.lastHistoryDelta || 0
  router.lastHistoryDelta = 0
  if (isInitial && navHistory.value.length === 0) {
    navHistory.value = [notePath]
    navHistoryIndex.value = 0
  } else if (delta < 0 && navHistoryIndex.value > 0 && navHistory.value[navHistoryIndex.value - 1] === notePath) {
    navHistoryIndex.value -= 1
  } else if (
    delta > 0 &&
    navHistoryIndex.value >= 0 &&
    navHistoryIndex.value < navHistory.value.length - 1 &&
    navHistory.value[navHistoryIndex.value + 1] === notePath
  ) {
    navHistoryIndex.value += 1
  } else if (navHistoryIndex.value > 0 && navHistory.value[navHistoryIndex.value - 1] === notePath) {
    navHistoryIndex.value -= 1
  } else if (
    navHistoryIndex.value >= 0 &&
    navHistoryIndex.value < navHistory.value.length - 1 &&
    navHistory.value[navHistoryIndex.value + 1] === notePath
  ) {
    navHistoryIndex.value += 1
  } else {
    recordNavigationHistory(notePath)
  }

  const parentSegments = notePath.split('/')
  parentSegments.pop()
  selectedFolderPath.value = parentSegments.join('/')
  void expandAncestors(notePath)
}

const unregisterRouterGuard = router.beforeEach(async (to, from) => {
  if (!isMounted || internalRouteNavigation) return true
  if (from.name !== 'vault' || from.params?.directory !== props.vault.directory) {
    return true
  }

  const isSameVault = to.name === 'vault' && to.params?.directory === props.vault.directory
  const toNote = isSameVault && typeof to.query?.note === 'string' ? to.query.note : null
  const leavingCurrentNote =
    selectedFile.value !== null && (!isSameVault || toNote !== selectedFile.value)

  if (!leavingCurrentNote && isSameVault) {
    return true
  }

  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') {
    workspaceNotice.value = 'Wait for the move to be reconciled before navigating.'
    return false
  }
  if (relocateState.value?.stage === 'confirm') {
    cancelRelocate()
  }

  if (isNavigationBlocked()) {
    let historyDelta = router.lastHistoryDelta || 0
    if (!historyDelta && isSameVault) {
      if (navHistoryIndex.value > 0 && navHistory.value[navHistoryIndex.value - 1] === toNote) {
        historyDelta = -1
      } else if (
        navHistoryIndex.value >= 0 &&
        navHistoryIndex.value < navHistory.value.length - 1 &&
        navHistory.value[navHistoryIndex.value + 1] === toNote
      ) {
        historyDelta = 1
      }
    }
    router.lastHistoryDelta = 0
    pendingNavigation.value = {
      type: isSameVault ? (toNote ? 'route-note' : 'close-note') : 'vaults',
      path: toNote,
      to: { name: to.name, params: { ...to.params }, query: { ...to.query } },
      historyDelta,
    }
    return false
  }

  return true
})

const handleViewerState = (state) => {
  viewerStateGeneration.value++
  viewerState.value = state
  emit('state', state)
}

const handleContentSaved = (savedDoc) => {
  if (!savedDoc?.path) return
  invalidateVaultIndexRequest()
  vaultIndexData.value = updateNoteInVaultIndex(vaultIndexData.value, savedDoc)
}

const handleOpenLink = async (linkPayload) => {
  linkNotice.value = null
  if (!linkPayload) return

  let resolved = linkPayload
  const rawTarget = linkPayload.rawTarget || linkPayload.target || ''

  if (
    rawTarget &&
    (resolved.type === 'missing' ||
      resolved.type === 'unverified' ||
      (linkPayload.kind === 'wikilink' && !rawTarget.includes('/')))
  ) {
    await discoverUnloadedFolders()
    resolved = resolveLink({
      sourcePath: selectedFile.value || '',
      linkTarget: rawTarget,
      knownFiles: knownMarkdownFiles.value,
      aliasesByFile: vaultIndexData.value.aliasesByFile,
      indexComplete: !(vaultIndexData.value.failures && vaultIndexData.value.failures.length > 0),
      kind: linkPayload.kind || 'wikilink',
    })
  }

  if (resolved.type === 'resolved' && resolved.path) {
    await expandAncestors(resolved.path)
    await selectNote(resolved.path, { anchor: resolved.anchor || null })
  } else if (resolved.type === 'unverified') {
    linkNotice.value = {
      type: 'unverified',
      rawTarget,
      kind: linkPayload.kind || 'wikilink',
      message: 'Warning: Vault indexing is incomplete. Could not verify if target note exists.',
      anchor: resolved.anchor || null,
      candidates: resolved.candidates || [],
    }
  } else if (resolved.type === 'ambiguous') {
    linkNotice.value = {
      type: 'ambiguous',
      rawTarget,
      kind: linkPayload.kind || 'wikilink',
      message: `Multiple notes match "${rawTarget}". Choose one:`,
      anchor: resolved.anchor || null,
      candidates: resolved.candidates || [],
    }
  } else {
    // Missing target
    linkNotice.value = {
      type: 'missing',
      rawTarget,
      kind: linkPayload.kind || 'wikilink',
      message: `Note "${rawTarget}" does not exist. Create note?`,
      anchor: resolved.anchor || null,
      candidates: [],
    }
  }
}

const createNoteFromPendingLink = async (rawTarget, kind = 'wikilink') => {
  const target = resolvePendingLinkCreationTarget({
    linkTarget: rawTarget,
    sourcePath: selectedFile.value || '',
    kind,
    newNoteLocation: vaultSettings.value.newNoteLocation,
    newNoteFolder: vaultSettings.value.newNoteFolder,
  })
  if (!target) {
    linkNotice.value = {
      type: 'invalid',
      message: 'This internal link points to an invalid vault path.',
    }
    return false
  }

  const initialContent = vaultSettings.value.defaultFrontmatterOnCreate
    ? buildInitialNoteContent(target.name)
    : undefined

  const payload = {
    parentPath: target.parentPath,
    name: target.name,
  }
  if (initialContent !== undefined) payload.content = initialContent
  if (target.parentPath) payload.createParents = true

  const directory = props.vault.directory
  try {
    const created = await vaultApi.createVaultNote(directory, payload)
    if (!created || !created.path) {
      return false
    }
    if (!isMounted || directory !== props.vault.directory) return false
    invalidateVaultIndexRequest()
    await fetchDirectory('')
    if (target.parentPath) {
      await expandAncestors(created.path)
      await fetchDirectory(target.parentPath)
    }
    linkNotice.value = null
    vaultIndexData.value = updateNoteInVaultIndex(vaultIndexData.value, {
      path: created.path,
      name: created.path.split('/').pop(),
      content: initialContent || '',
      revision: created.revision,
    })
    await fetchVaultIndexSafe()
    await selectNote(created.path, {
      anchor: target.anchor || null,
      initialDoc: {
        path: created.path,
        content: initialContent || '',
        revision: created.revision,
      },
    })
    return true
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return false
    }
    linkNotice.value = {
      type: 'error',
      rawTarget,
      kind,
      message: err?.code === 'VAULT_ENTRY_EXISTS'
        ? `A note named "${target.name}" already exists.`
        : 'Could not create note from link.',
    }
    return false
  }
}

const openCandidateLink = async (candidatePath, anchor = null) => {
  linkNotice.value = null
  await expandAncestors(candidatePath)
  await selectNote(candidatePath, { anchor })
}

const handleSelectTag = (tag) => {
  activeTagFilter.value = tag
  rightPanelTab.value = 'tags'
  layout.value.contextOpen = true
  persistLayout()
}

// Creation operations
const startCreate = async (mode, overrideFolderPath = null) => {
  if (overrideFolderPath !== null) {
    selectedFolderPath.value = overrideFolderPath
  }
  closeContextMenu()
  showAddMenu.value = false
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
  if (
    err.code === 'INVALID_VAULT_ENTRY_NAME' ||
    err.code === 'INVALID_ENTRY_NAME' ||
    err.code === 'INVALID_VAULT_PATH'
  ) {
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
  const directory = props.vault.directory

  try {
    if (mode === 'folder') {
      const created = await vaultApi.createVaultFolder(directory, {
        parentPath,
        name: trimmed,
      })
      if (!isMounted || directory !== props.vault.directory) return
      invalidateVaultIndexRequest()
      await fetchDirectory(parentPath)
      if (parentPath) {
        const nextExpanded = new Set(expandedFolders.value)
        nextExpanded.add(parentPath)
        expandedFolders.value = nextExpanded
      }
      selectedFolderPath.value = created.path
      createMode.value = null
      newEntryName.value = ''
      await fetchVaultIndexSafe()
    } else {
      const payload = {
        parentPath,
        name: trimmed,
      }
      const initialContent = vaultSettings.value.defaultFrontmatterOnCreate
        ? buildInitialNoteContent(trimmed)
        : ''
      if (vaultSettings.value.defaultFrontmatterOnCreate) {
        payload.content = initialContent
      }

      const created = await vaultApi.createVaultNote(directory, payload)
      if (!isMounted || directory !== props.vault.directory) return
      invalidateVaultIndexRequest()
      await fetchDirectory(parentPath)
      if (parentPath) {
        const nextExpanded = new Set(expandedFolders.value)
        nextExpanded.add(parentPath)
        expandedFolders.value = nextExpanded
      }
      createMode.value = null
      newEntryName.value = ''
      vaultIndexData.value = updateNoteInVaultIndex(vaultIndexData.value, {
        path: created.path,
        name: created.path.split('/').pop(),
        content: initialContent,
        revision: created.revision,
      })
      await fetchVaultIndexSafe()
      await selectNote(created.path, {
        initialDoc: {
          path: created.path,
          content: initialContent,
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

// Context Menu
const openContextMenu = (event, entry) => {
  if (event) {
    event.preventDefault()
    event.stopPropagation()
  }
  const isPointer = event && event.type === 'contextmenu'
  let anchor
  if (isPointer) {
    anchor = { type: 'pointer', clientX: event.clientX, clientY: event.clientY }
  } else if (event?.currentTarget && typeof event.currentTarget.getBoundingClientRect === 'function') {
    anchor = { type: 'element', rect: event.currentTarget.getBoundingClientRect() }
  } else {
    anchor = { type: 'pointer', clientX: event?.clientX || 120, clientY: event?.clientY || 120 }
  }

  contextMenu.value = {
    type: 'entry',
    entry,
    anchor,
  }
  contextMenuPos.value = calculateContextMenuPosition({
    anchor,
    menuDimensions: { width: 190, height: entry.type === 'directory' ? 220 : 250 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })
}

const openEmptyAreaContextMenu = (event) => {
  if (event) {
    event.preventDefault()
    event.stopPropagation()
  }
  const anchor = { type: 'pointer', clientX: event.clientX, clientY: event.clientY }
  contextMenu.value = {
    type: 'empty',
    entry: null,
    anchor,
  }
  contextMenuPos.value = calculateContextMenuPosition({
    anchor,
    menuDimensions: { width: 160, height: 90 },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  })
}

const closeContextMenu = () => {
  contextMenu.value = null
}

const copyRelativePath = async (entry) => {
  closeContextMenu()
  if (!entry?.path) return
  try {
    if (!navigator?.clipboard?.writeText) {
      throw new Error('Clipboard API unavailable')
    }
    await navigator.clipboard.writeText(entry.path)
    addToast('Path copied', 'success')
  } catch {
    addToast('Could not copy path', 'error')
  }
}

const copyWikilink = async (entry) => {
  closeContextMenu()
  if (!entry?.path) return
  const formatted = formatInternalLink({
    sourcePath: selectedFile.value || '',
    targetPath: entry.path,
    allFiles: knownMarkdownFiles.value,
    format: vaultSettings.value.linkFormat,
    useWikilinks: vaultSettings.value.useWikilinks,
  })
  try {
    if (!navigator?.clipboard?.writeText) {
      throw new Error('Clipboard API unavailable')
    }
    await navigator.clipboard.writeText(formatted)
    addToast('Link copied', 'success')
  } catch {
    addToast('Could not copy link', 'error')
  }
}

const hasUnsavedChangesForPath = (entryPath) => {
  if (!entryPath || !selectedFile.value) return false
  const isAffected = selectedFile.value === entryPath || selectedFile.value.startsWith(`${entryPath}/`)
  if (!isAffected) return false
  return (
    viewerState.value.dirty ||
    viewerState.value.saving ||
    viewerState.value.reloading ||
    viewerState.value.saveState === 'conflict' ||
    viewerState.value.saveState === 'unknown'
  )
}

const documentVersion = () => {
  const version = viewerRef.value?.documentVersion
  return typeof version === 'number' ? version : version?.value ?? null
}

const relocationSnapshot = (sourcePath, targetPath) => {
  const affectedDocumentPath = selectedFile.value &&
    (selectedFile.value === sourcePath || selectedFile.value.startsWith(`${sourcePath}/`))
    ? selectedFile.value
    : null
  return {
    vaultId: props.vault.id,
    vaultDirectory: props.vault.directory,
    sourcePath,
    targetPath,
    selectedFile: selectedFile.value,
    affectedDocumentPath,
    documentVersion: affectedDocumentPath ? documentVersion() : null,
    viewerStateGeneration: affectedDocumentPath ? viewerStateGeneration.value : null,
  }
}

const sameRelocationIdentity = (left, right) =>
  left.vaultId === right.vaultId &&
  left.vaultDirectory === right.vaultDirectory &&
  left.sourcePath === right.sourcePath &&
  left.targetPath === right.targetPath &&
  left.selectedFile === right.selectedFile &&
  left.affectedDocumentPath === right.affectedDocumentPath

const sameRelocationEditorState = (left, right) =>
  left.documentVersion === right.documentVersion &&
  left.viewerStateGeneration === right.viewerStateGeneration

const relocationBlockMessage = (affectedDocumentPath) => {
  if (!affectedDocumentPath) return ''
  if (viewerState.value.saving || viewerState.value.saveState === 'saving') {
    return 'Wait for the note to finish saving before moving it.'
  }
  if (viewerState.value.reloading) return 'Wait for the note to finish reloading before moving it.'
  if (viewerState.value.saveState === 'conflict') return 'Resolve the note conflict before moving it.'
  if (viewerState.value.saveState === 'unknown') return 'Verify the save result before moving this note.'
  if (viewerState.value.saveState === 'error') return 'Resolve the save error before moving this note.'
  return ''
}

const knownEntryPaths = () => [
  ...vaultIndexData.value.files,
  ...vaultIndexData.value.folders,
  ...[...folderEntriesMap.value.values()].flat().map((entry) => entry.path),
].filter(Boolean)

const getDropTargetStatus = (targetFolderPath, source = draggedEntry.value) => {
  if (!source?.path) return { valid: false, reason: 'invalid-source' }
  const baseName = source.path.split('/').pop()
  const targetPath = targetFolderPath ? `${targetFolderPath}/${baseName}` : baseName
  if (
    targetPath.toLowerCase() === source.path.toLowerCase() ||
    (source.type === 'directory' &&
      (targetFolderPath.toLowerCase() === source.path.toLowerCase() ||
        targetFolderPath.toLowerCase().startsWith(`${source.path.toLowerCase()}/`)))
  ) return { valid: false, reason: 'invalid-path', targetPath }

  if (knownEntryPaths().some((entryPath) => entryPath.toLowerCase() === targetPath.toLowerCase())) {
    return { valid: false, reason: 'occupied', targetPath }
  }

  const indexComplete = vaultIndexData.value.directory === props.vault.directory && vaultIndexData.value.complete
  if (!folderEntriesMap.value.has(targetFolderPath) && !indexComplete) {
    return { valid: false, reason: 'unknown', targetPath }
  }
  return { valid: true, reason: '', targetPath }
}

const relocationPathError = (sourcePath, targetPath, entry, requireKnownDrop = false) => {
  const isDirectory = entry?.type === 'directory' || vaultIndexData.value.folders.includes(sourcePath)
  if (
    sourcePath.toLowerCase() === targetPath.toLowerCase() ||
    (isDirectory && targetPath.toLowerCase().startsWith(`${sourcePath.toLowerCase()}/`))
  ) return 'Cannot move a folder into itself.'
  if (knownEntryPaths().some((entryPath) => entryPath.toLowerCase() === targetPath.toLowerCase())) {
    return 'An entry with that name already exists at the destination.'
  }
  if (requireKnownDrop) {
    const parentPath = targetPath.includes('/') ? targetPath.slice(0, targetPath.lastIndexOf('/')) : ''
    const indexComplete = vaultIndexData.value.directory === props.vault.directory && vaultIndexData.value.complete
    if (!folderEntriesMap.value.has(parentPath) && !indexComplete) {
      return 'Cannot verify the destination right now. Refresh the vault and try again.'
    }
  }
  return ''
}

const getKnownRevisionForPath = async (filePath) => {
  if (selectedFile.value === filePath) {
    const r = viewerRef.value?.revision
    const revStr = typeof r === 'string' ? r : r?.value
    if (typeof revStr === 'string' && /^[a-f0-9]{64}$/.test(revStr)) {
      return revStr
    }
  }
  const fromIndex = vaultIndexData.value.notesByPath?.[filePath]?.revision
  if (typeof fromIndex === 'string' && /^[a-f0-9]{64}$/.test(fromIndex)) {
    return fromIndex
  }
  try {
    const res = await vaultApi.getVaultMarkdown(props.vault.directory, filePath)
    if (res?.revision && /^[a-f0-9]{64}$/.test(res.revision)) {
      return res.revision
    }
  } catch {}
  return undefined
}

const startRelocate = async (entry, mode = 'rename') => {
  closeContextMenu()
  if (!entry?.path) return
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  relocateState.value = {
    entry,
    mode,
    origin: 'manual',
    sourcePath: entry.path,
    targetPath: entry.path,
    stage: 'edit',
    hasUnsavedDraft: hasUnsavedChangesForPath(entry.path),
    loading: false,
    error: '',
  }
  await nextTick()
  relocateInputRef.value?.focus?.()
}

const setRelocationConfirmation = (operation, snapshot, error = '') => {
  const state = toRaw(relocateState.value) === toRaw(operation) ? relocateState.value : operation
  Object.assign(state, {
    ...snapshot,
    snapshot,
    stage: 'confirm',
    hasUnsavedDraft: true,
    loading: false,
    error,
  })
  relocateState.value = state
  clearDragState()
}

const setRelocationError = (operation, err) => {
  if (err?.code === 'UNAUTHORIZED') {
    relocateState.value = null
    emit('unauthorized')
    return
  }

  if (err?.code === 'FAILED_TO_RELOCATE_ENTRY' || err?.code === 'INVALID_VAULT_RESPONSE') {
    const message = 'The move result is uncertain. Refresh the vault before retrying.'
    Object.assign(operation, { stage: 'uncertain', loading: false, error: message })
    relocateState.value = operation
    workspaceNotice.value = message
    return
  }

  const message = err?.code === 'VAULT_ENTRY_EXISTS'
    ? 'An entry with that name already exists at the destination.'
    : err?.code === 'INVALID_VAULT_MOVE'
      ? 'Cannot move a folder into itself.'
      : err?.code === 'VAULT_FILE_CONFLICT'
        ? 'This note changed before it could be moved.'
        : 'Could not move this entry.'
  operation.loading = false
  operation.error = message
  if (operation.origin === 'manual') {
    operation.stage = operation.hasUnsavedDraft ? 'confirm' : 'edit'
    relocateState.value = operation
  } else {
    relocateState.value = null
    workspaceNotice.value = message
  }
}

const remapRelocatedPaths = (sourcePath, newPath) => {
  const remapPath = (filePath) => {
    if (!filePath) return filePath
    if (filePath === sourcePath) return newPath
    if (filePath.startsWith(`${sourcePath}/`)) return `${newPath}/${filePath.slice(sourcePath.length + 1)}`
    return filePath
  }
  const previousSelected = selectedFile.value
  openTabs.value = openTabs.value.map(remapPath)
  navHistory.value = navHistory.value.map(remapPath)
  selectedFile.value = remapPath(selectedFile.value)
  selectedFolderPath.value = remapPath(selectedFolderPath.value)
  if (selectedFile.value !== previousSelected) {
    void syncUrlWithNote(selectedFile.value, { replace: true })
  }
}

const reconcileUncertainRelocation = async () => {
  const operation = relocateState.value
  if (operation?.stage !== 'uncertain' || !isCurrentRelocation(operation) || !vaultIndexData.value.complete) return
  const paths = operation.entry?.type === 'directory' ? vaultIndexData.value.folders : vaultIndexData.value.files
  const sourceExists = paths.includes(operation.sourcePath)
  const targetExists = paths.includes(operation.targetPath)

  if (sourceExists && !targetExists) {
    relocateState.value = null
    workspaceNotice.value = 'Refresh confirmed the entry is still at its original path. You can retry the move.'
  } else if (!sourceExists && targetExists) {
    const remappedDocument = operation.affectedDocumentPath === operation.sourcePath
      ? operation.targetPath
      : operation.affectedDocumentPath?.startsWith(`${operation.sourcePath}/`)
        ? `${operation.targetPath}/${operation.affectedDocumentPath.slice(operation.sourcePath.length + 1)}`
        : null
    if (remappedDocument && viewerState.value.dirty) {
      viewerRef.value?.preserveDraftForRelocatedPath?.(remappedDocument)
    }
    remapRelocatedPaths(operation.sourcePath, operation.targetPath)
    if (selectedFile.value) await expandAncestors(selectedFile.value)
    if (toRaw(relocateState.value) === toRaw(operation)) relocateState.value = null
    workspaceNotice.value = viewerState.value.dirty
      ? 'The move completed. Your draft remains open at the destination.'
      : 'The move completed after the vault was refreshed.'
  } else {
    operation.error = 'Refresh could not confirm whether the move completed. Keep the note open and refresh again.'
  }
}

const isCurrentRelocation = (operation) =>
  isMounted &&
  toRaw(relocateState.value) === toRaw(operation) &&
  props.vault.id === operation.vaultId &&
  props.vault.directory === operation.vaultDirectory

const executeRelocate = async (sourcePath, rawTargetPath, options = {}) => {
  if (typeof sourcePath !== 'string' || !sourcePath) return false
  let targetPath = String(rawTargetPath || '').trim()
  if (!targetPath) return false
  if (isMarkdownFile(sourcePath) && !isMarkdownFile(targetPath)) {
    const ext = sourcePath.toLowerCase().endsWith('.markdown') ? '.markdown' : '.md'
    targetPath = `${targetPath}${ext}`
  }
  if (sourcePath === targetPath) {
    return false
  }

  if (relocateState.value?.stage === 'uncertain') {
    workspaceNotice.value = 'The move result is uncertain. Refresh the vault before retrying.'
    return false
  }
  if (relocateState.value?.loading) return false
  if (options.intent && toRaw(relocateState.value) !== toRaw(options.intent)) return false

  const mode = options.mode || options.intent?.mode || 'move'
  const entry = options.entry || options.intent?.entry || {
    path: sourcePath,
    name: sourcePath.split('/').pop(),
    type: vaultIndexData.value.folders.includes(sourcePath) ? 'directory' : 'file',
  }
  const origin = options.origin || options.intent?.origin || (options.requireKnownDrop ? 'drag' : 'title')
  let operation = options.intent || {
    entry,
    mode,
    origin,
    sourcePath,
    targetPath,
  }
  operation.origin = origin
  const snapshot = relocationSnapshot(sourcePath, targetPath)
  const authorization = options.authorization

  if (authorization && !sameRelocationIdentity(authorization, snapshot)) {
    relocateState.value = null
    workspaceNotice.value = 'The move confirmation expired. Review the source and destination, then try again.'
    return false
  }

  const pathError = relocationPathError(sourcePath, targetPath, entry, Boolean(options.requireKnownDrop))
  if (pathError) {
    operation.error = pathError
    if (operation.origin === 'manual') relocateState.value = operation
    else workspaceNotice.value = pathError
    return false
  }

  const blockMessage = relocationBlockMessage(snapshot.affectedDocumentPath)
  if (blockMessage) {
    operation.error = blockMessage
    if (operation.origin === 'manual') relocateState.value = operation
    else workspaceNotice.value = blockMessage
    return false
  }

  if (snapshot.affectedDocumentPath && viewerState.value.dirty) {
    if (!authorization || !sameRelocationEditorState(authorization, snapshot)) {
      setRelocationConfirmation(
        operation,
        snapshot,
        authorization ? 'Your note changed. Review and confirm the latest draft.' : ''
      )
      return false
    }
  }

  operation.entry = entry
  operation.mode = mode
  operation.sourcePath = sourcePath
  operation.targetPath = targetPath
  operation.vaultId = snapshot.vaultId
  operation.vaultDirectory = snapshot.vaultDirectory
  operation.selectedFile = snapshot.selectedFile
  operation.affectedDocumentPath = snapshot.affectedDocumentPath
  operation.documentVersion = snapshot.documentVersion
  operation.viewerStateGeneration = snapshot.viewerStateGeneration
  operation.snapshot = snapshot
  operation.requireKnownDrop = Boolean(options.requireKnownDrop || operation.requireKnownDrop)
  operation.loading = true
  operation.stage = 'executing'
  operation.error = ''
  relocateState.value = operation
  operation = relocateState.value

  const payload = {
    sourcePath,
    targetPath,
    updateLinks: vaultSettings.value.autoUpdateLinks,
  }
  const directory = snapshot.vaultDirectory
  try {
    let revision
    if (isMarkdownFile(sourcePath)) revision = await getKnownRevisionForPath(sourcePath)
    if (!isCurrentRelocation(operation)) return false

    const beforeRequest = relocationSnapshot(sourcePath, targetPath)
    if (!sameRelocationIdentity(snapshot, beforeRequest)) {
      relocateState.value = null
      workspaceNotice.value = 'The move confirmation expired. Review the source and destination, then try again.'
      return false
    }
    const currentBlock = relocationBlockMessage(beforeRequest.affectedDocumentPath)
    if (currentBlock) {
      operation.loading = false
      operation.error = currentBlock
      operation.stage = operation.hasUnsavedDraft ? 'confirm' : 'edit'
      if (operation.origin === 'manual') relocateState.value = operation
      else {
        relocateState.value = null
        workspaceNotice.value = currentBlock
      }
      return false
    }
    if (beforeRequest.affectedDocumentPath && viewerState.value.dirty) {
      if (!authorization || !sameRelocationEditorState(authorization, beforeRequest)) {
        setRelocationConfirmation(operation, beforeRequest, 'Your note changed. Review and confirm the latest draft.')
        return false
      }
      if (beforeRequest.affectedDocumentPath === sourcePath && !revision) {
        operation.loading = false
        operation.error = 'Could not confirm this note version. Refresh the vault before moving it.'
        operation.stage = 'confirm'
        return false
      }
    }

    const finalPathError = relocationPathError(sourcePath, targetPath, entry, operation.requireKnownDrop)
    if (finalPathError) {
      operation.loading = false
      operation.error = finalPathError
      if (operation.origin === 'manual') {
        operation.stage = operation.hasUnsavedDraft ? 'confirm' : 'edit'
        relocateState.value = operation
      } else {
        relocateState.value = null
        workspaceNotice.value = finalPathError
      }
      return false
    }
    if (revision) payload.expectedRevision = revision

    const res = await vaultApi.relocateVaultEntry(directory, payload)
    if (!isCurrentRelocation(operation)) return false
    if (
      !res ||
      res.newPath !== targetPath ||
      (res.oldPath && res.oldPath !== sourcePath) ||
      (res.directory && res.directory !== directory)
    ) {
      operation.newPath = targetPath
      setRelocationError(operation, Object.assign(new Error('Invalid relocation response'), { code: 'INVALID_VAULT_RESPONSE' }))
      return false
    }

    invalidateVaultIndexRequest()
    if (operation.affectedDocumentPath && viewerState.value.dirty) {
      const afterRequest = relocationSnapshot(sourcePath, targetPath)
      if (!authorization || !sameRelocationIdentity(snapshot, afterRequest) || !sameRelocationEditorState(authorization, afterRequest)) {
        operation.newPath = res.newPath
        Object.assign(operation, {
          stage: 'uncertain',
          loading: false,
          error: 'The move completed while the note changed. Refresh the vault before continuing.',
        })
        relocateState.value = operation
        workspaceNotice.value = operation.error
        await refreshWorkspace()
        return false
      }
      viewerRef.value?.discardChanges?.()
    }
    remapRelocatedPaths(sourcePath, res.newPath)

    await refreshWorkspace()
    if (selectedFile.value) await expandAncestors(selectedFile.value)

    if (res.failedFiles?.length > 0) {
      workspaceNotice.value = `Entry moved, but failed to update links in: ${res.failedFiles.join(', ')}. Please update them manually.`
    } else if (res.updatedFiles?.length > 0) {
      workspaceNotice.value = `Updated links in ${res.updatedFiles.length} note(s).`
    }
    if (toRaw(relocateState.value) === toRaw(operation)) relocateState.value = null
    return true
  } catch (err) {
    if (isCurrentRelocation(operation)) setRelocationError(operation, err)
    return false
  }
}

const submitRelocateForm = async () => {
  const operation = relocateState.value
  if (!operation || operation.loading || operation.stage !== 'edit') return
  return executeRelocate(operation.sourcePath || operation.entry.path, operation.targetPath, {
    intent: operation,
    entry: operation.entry,
    mode: operation.mode,
    origin: operation.origin,
  })
}

const confirmRelocate = async () => {
  const operation = relocateState.value
  if (!operation || operation.loading || operation.stage !== 'confirm') return
  return executeRelocate(operation.sourcePath, operation.targetPath, {
    intent: operation,
    entry: operation.entry,
    mode: operation.mode,
    origin: operation.origin,
    requireKnownDrop: operation.requireKnownDrop,
    authorization: operation.snapshot,
  })
}

const cancelRelocate = () => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  relocateState.value = null
  clearDragState()
}

const handleRenameFromNoteTitle = async (newStem) => {
  if (!selectedFile.value) return
  const trimmed = String(newStem || '').trim()
  if (!trimmed) return
  const currentPath = selectedFile.value
  const entry = { path: currentPath, name: currentPath.split('/').pop(), type: 'file' }
  const ext = currentPath.toLowerCase().endsWith('.markdown') ? '.markdown' : '.md'
  const parentDir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : ''
  const targetPath = parentDir ? `${parentDir}/${trimmed}${ext}` : `${trimmed}${ext}`
  await executeRelocate(currentPath, targetPath, { mode: 'rename', entry, origin: 'title' })
}

// Drag & Drop in Explorer
const clearDragState = () => {
  draggedEntry.value = null
  dropTarget.value = null
}

const handleDragStart = (entry, event) => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') {
    event.preventDefault()
    return
  }
  draggedEntry.value = entry
  dropTarget.value = null
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', entry.path)
  }
}

const handleDragOverFolder = (targetFolderPath, event) => {
  if (!draggedEntry.value) return
  const target = getDropTargetStatus(targetFolderPath)
  dropTarget.value = { path: targetFolderPath, ...target }
  if (event.dataTransfer) event.dataTransfer.dropEffect = target.valid ? 'move' : 'none'
}

const handleDragOverFile = (filePath, event) => {
  if (!draggedEntry.value) return
  dropTarget.value = { path: filePath, valid: false }
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'none'
}

const handleDragLeaveTarget = (targetFolderPath, event) => {
  if (event.currentTarget?.contains(event.relatedTarget)) return
  if (dropTarget.value?.path === targetFolderPath) dropTarget.value = null
}

const handleDropOnFolder = async (targetFolderPath) => {
  const source = draggedEntry.value
  const target = getDropTargetStatus(targetFolderPath, source)
  clearDragState()
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain' || !source?.path) return
  if (!target.valid) {
    workspaceNotice.value = target.reason === 'occupied'
      ? 'An entry with that name already exists at the destination.'
      : target.reason === 'unknown'
        ? 'Cannot verify the destination right now. Refresh the vault and try again.'
        : 'Cannot move a folder into itself.'
    return
  }
  return executeRelocate(source.path, target.targetPath, {
    entry: source,
    mode: 'move',
    origin: 'drag',
    requireKnownDrop: true,
  })
}

// Delete & Trash Operations
const requestDeleteEntry = (entry) => {
  closeContextMenu()
  if (!entry?.path) return
  deleteConfirmState.value = {
    entry,
    hasUnsavedDraft: hasUnsavedChangesForPath(entry.path),
    loading: false,
    error: '',
  }
}

const cleanupAfterDeletedPath = (deletedPath) => {
  const isDeletedOrInside = (p) => p === deletedPath || p.startsWith(`${deletedPath}/`)
  const previousSelected = selectedFile.value
  openTabs.value = openTabs.value.filter((t) => !isDeletedOrInside(t))
  navHistory.value = navHistory.value.filter((p) => !isDeletedOrInside(p))
  if (selectedFile.value && isDeletedOrInside(selectedFile.value)) {
    selectedFile.value = openTabs.value[openTabs.value.length - 1] || null
    selectedAnchor.value = null
    initialDocument.value = null
  }
  navHistoryIndex.value = selectedFile.value
    ? navHistory.value.lastIndexOf(selectedFile.value)
    : navHistory.value.length - 1
  if (selectedFolderPath.value && isDeletedOrInside(selectedFolderPath.value)) {
    selectedFolderPath.value = ''
  }
  if (selectedFile.value !== previousSelected) {
    void syncUrlWithNote(selectedFile.value, { replace: true })
  }
}

const confirmDeleteEntry = async (mode = vaultSettings.value.deleteBehavior) => {
  if (!deleteConfirmState.value || deleteConfirmState.value.loading) return
  const targetEntry = deleteConfirmState.value.entry
  const targetPath = targetEntry.path
  const directory = props.vault.directory
  deleteConfirmState.value.loading = true
  deleteConfirmState.value.error = ''

  const payload = { path: targetPath }
  if (targetEntry.type === 'file' || isMarkdownFile(targetPath)) {
    const rev = await getKnownRevisionForPath(targetPath)
    if (directory !== props.vault.directory) return
    if (rev) payload.expectedRevision = rev
  }

  try {
    if (mode === 'permanent') {
      await vaultApi.deleteVaultEntryPermanently(directory, payload)
    } else {
      await vaultApi.trashVaultEntry(directory, payload)
    }
    if (!isMounted || directory !== props.vault.directory) return
    invalidateVaultIndexRequest()
    if (deleteConfirmState.value?.hasUnsavedDraft) {
      viewerRef.value?.discardChanges?.()
      viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
      emit('state', viewerState.value)
    }
    deleteConfirmState.value = null
    cleanupAfterDeletedPath(targetPath)
    await refreshWorkspace()
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    if (deleteConfirmState.value) {
      deleteConfirmState.value.error =
        err?.code === 'VAULT_FILE_CONFLICT'
          ? 'This note was modified externally. Reload it before deleting.'
          : err?.code === 'VAULT_TRASH_RESULT_UNKNOWN'
            ? 'The item was moved to trash, but recording its metadata failed. Please refresh the trash list.'
            : 'Could not delete this entry.'
      deleteConfirmState.value.loading = false
    }
  }
}

const openTrashModal = async () => {
  showTrashModal.value = true
  trashLoading.value = true
  trashError.value = ''
  trashRestoreConflict.value = null
  try {
    const res = await vaultApi.getVaultTrash(props.vault.directory)
    trashItems.value = res.items || []
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    trashError.value = 'Could not load vault trash.'
  } finally {
    trashLoading.value = false
  }
}

const handleRestoreTrashItem = async (item, customTargetPath = undefined) => {
  trashError.value = ''
  const directory = props.vault.directory
  try {
    const res = await vaultApi.restoreVaultTrashEntry(directory, {
      id: item.id,
      targetPath: customTargetPath,
    })
    if (!isMounted || directory !== props.vault.directory) return
    invalidateVaultIndexRequest()
    trashItems.value = trashItems.value.filter((i) => i.id !== item.id)
    trashRestoreConflict.value = null
    await refreshWorkspace()
    if (res.type === 'file' && isMarkdownFile(res.path)) {
      await expandAncestors(res.path)
      await selectNote(res.path)
    }
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    if (err?.code === 'VAULT_ENTRY_EXISTS') {
      const ext = item.originalPath.endsWith('.md') ? '.md' : ''
      const baseNoExt = ext ? item.originalPath.slice(0, -3) : item.originalPath
      trashRestoreConflict.value = {
        item,
        targetPath: `${baseNoExt} (Restored)${ext}`,
      }
    } else {
      trashError.value = 'Could not restore trash item.'
    }
  }
}

const handleDeleteTrashPermanently = async (item) => {
  trashError.value = ''
  try {
    await vaultApi.deleteVaultTrashItem(props.vault.directory, item.id)
    trashItems.value = trashItems.value.filter((i) => i.id !== item.id)
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    trashError.value = 'Could not permanently delete item.'
  }
}

// Command Palette & Quick Switcher
const openCommandPaletteModal = () => {
  commandPaletteQuery.value = ''
  showCommandPalette.value = true
}

const openQuickSwitcherModal = () => {
  quickSwitcherQuery.value = ''
  showQuickSwitcher.value = true
}

const handleGlobalKeydown = (event) => {
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    openCommandPaletteModal()
  } else if (mod && event.key.toLowerCase() === 'p') {
    event.preventDefault()
    openCommandPaletteModal()
  } else if (event.key === 'Escape') {
    if (contextMenu.value) {
      closeContextMenu()
      return
    }
    showCommandPalette.value = false
    showQuickSwitcher.value = false
    showSettingsModal.value = false
    showTrashModal.value = false
    showVaultMenu.value = false
    showAddMenu.value = false
  }
}

const handleDocumentClick = (e) => {
  if (contextMenu.value) {
    if (!e.target?.closest || !e.target.closest('[data-testid="explorer-context-menu"]')) {
      closeContextMenu()
    }
  }
  if (showVaultMenu.value) {
    if (!e.target?.closest || !e.target.closest('.vault-dropdown-wrapper')) {
      showVaultMenu.value = false
    }
  }
  if (showAddMenu.value) {
    if (!e.target?.closest || !e.target.closest('.explorer-header-actions')) {
      showAddMenu.value = false
    }
  }
}

watch(
  () => [props.vault.id, props.vault.directory],
  async () => {
    relocateState.value = null
    clearDragState()
    pendingNavigation.value = null
    viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
    viewerStateGeneration.value++
    invalidateVaultIndexRequest()
    vaultIndexData.value = buildVaultIndex({
      directory: props.vault.directory,
      complete: false,
      folders: [],
      files: [],
      notes: [],
    })
    directoryRequestGeneration++
    directoryRequestIds.clear()
    folderEntriesMap.value = new Map()
    expandedFolders.value = new Set()
    selectedFolderPath.value = ''
    selectedFile.value = null
    selectedAnchor.value = null
    initialDocument.value = null
    openTabs.value = []
    navHistory.value = []
    navHistoryIndex.value = -1
    hasLoadedRoot.value = false
    fetchDirectory('')
    fetchVaultIndexSafe()
    if (route.value?.name === 'vault' && route.value?.params?.directory === props.vault.directory) {
      await applyRouteFromUrl({ isInitial: true })
    } else {
      await syncUrlWithNote(null, { replace: true })
    }
  }
)

watch(
  () => [route.value?.name, route.value?.params?.directory, route.value?.query?.note],
  () => {
    if (!suppressRouteWatch) {
      void applyRouteFromUrl({ isInitial: false })
    }
  }
)

onMounted(() => {
  isMounted = true
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('pointerdown', handleDocumentClick)
  window.addEventListener('resize', closeContextMenu)
  fetchDirectory('')
  fetchVaultIndexSafe()
  void applyRouteFromUrl({ isInitial: true })
})

onUnmounted(() => {
  isMounted = false
  unregisterRouterGuard()
  relocateState.value = null
  clearDragState()
  directoryRequestGeneration++
  invalidateVaultIndexRequest()
  window.removeEventListener('keydown', handleGlobalKeydown)
  document.removeEventListener('pointerdown', handleDocumentClick)
  window.removeEventListener('resize', closeContextMenu)
  window.removeEventListener('pointermove', onSplitterPointerMove)
  window.removeEventListener('pointerup', onSplitterPointerUp)
  window.removeEventListener('pointercancel', onSplitterPointerUp)
})

defineExpose({
  layout,
  getLayout: () => layout.value,
  persistLayout,
  getExplorerWidth: () => layout.value.explorerWidth,
  getContextWidth: () => layout.value.contextWidth,
  isExplorerOpen: () => layout.value.explorerOpen,
  isContextOpen: () => layout.value.contextOpen,
  openFileInNewTab,
  selectNote,
  requestDeleteEntry,
  handleOpenLink,
  confirmDeleteEntry,
  startCreate,
  submitCreate,
  executeRelocate,
  startRelocate,
  copyRelativePath,
  copyWikilink,
  toasts,
  addToast,
  removeToast,
  openContextMenu,
  openEmptyAreaContextMenu,
  closeContextMenu,
  openTrashModal,
  handleRestoreTrashItem,
  handleDeleteTrashPermanently,
  navigateHistoryBack,
  navigateHistoryForward,
})
</script>

<template>
  <section class="vault-browser workspace-shell" data-testid="vault-browser">
    <!-- Minimal Ayame Workspace Topbar -->
    <header class="workspace-topbar">
      <div class="workspace-topbar-left">
        <button
          type="button"
          class="workspace-text-button"
          :class="{ 'workspace-text-button--active': layout.explorerOpen }"
          data-testid="toggle-explorer-button"
          :aria-expanded="layout.explorerOpen ? 'true' : 'false'"
          title="Toggle file explorer"
          @click="layout.explorerOpen = !layout.explorerOpen; persistLayout()"
        >
          Explorer
        </button>

        <button
          type="button"
          class="workspace-text-button"
          data-testid="workspace-home-button"
          aria-label="Back to vaults"
          title="Back to vaults"
          :disabled="viewerState.saving || viewerState.reloading"
          @click="requestBackToVaults"
        >
          Home
        </button>

        <div class="vault-dropdown-wrapper">
          <button
            type="button"
            class="vault-name-trigger"
            data-testid="vault-name-trigger"
            :aria-expanded="showVaultMenu ? 'true' : 'false'"
            title="Vault menu"
            @click.stop="showVaultMenu = !showVaultMenu"
          >
            <span class="vault-name">{{ vault.name }}</span>
          </button>

          <!-- Vault Dropdown Menu -->
          <div
            v-show="showVaultMenu"
            class="vault-dropdown-menu"
            role="menu"
            data-testid="vault-dropdown-menu"
            @click.stop
          >
            <button
              type="button"
              class="dropdown-menu-item"
              data-testid="back-to-vaults-button"
              :disabled="viewerState.saving || viewerState.reloading"
              @click="showVaultMenu = false; requestBackToVaults()"
            >
              <span>Switch vault</span>
            </button>
            <button
              type="button"
              class="dropdown-menu-item"
              data-testid="vault-settings-button"
              @click="showVaultMenu = false; showSettingsModal = true"
            >
              <span>Vault settings…</span>
            </button>
            <button
              type="button"
              class="dropdown-menu-item"
              data-testid="open-trash-button"
              @click="showVaultMenu = false; openTrashModal()"
            >
              <span>Trash</span>
            </button>
            <button
              type="button"
              class="dropdown-menu-item"
              data-testid="refresh-browser-button"
              :disabled="loadingRoot || refreshing || viewerState.saving || viewerState.reloading"
              @click="showVaultMenu = false; refreshWorkspace()"
            >
              <span>{{ refreshing ? 'Refreshing…' : 'Refresh vault' }}</span>
            </button>
            <button
              type="button"
              class="dropdown-menu-item"
              data-testid="toggle-readable-line-button"
              @click="showVaultMenu = false; viewerRef?.toggleReadableLineLength?.()"
            >
              <span>Readable line length</span>
            </button>
            <button
              type="button"
              class="dropdown-menu-item"
              data-testid="toggle-properties-button"
              @click="showVaultMenu = false; viewerRef?.cyclePropertiesMode?.()"
            >
              <span>Toggle properties</span>
            </button>
            <div class="dropdown-divider" />
            <button
              type="button"
              class="dropdown-menu-item dropdown-menu-item--danger"
              data-testid="logout-button"
              :disabled="pending || editorSaving || editorReloading || viewerState.saving || viewerState.reloading"
              @click="showVaultMenu = false; emit('logout')"
            >
              <span>Logout</span>
            </button>
          </div>
        </div>
      </div>

      <!-- Discreet Tabs Bar (Center) -->
      <div
        v-if="openTabs.length > 0"
        class="workspace-tabs-bar"
        data-testid="workspace-tabs"
        role="tablist"
      >
        <div
          v-for="tabPath in openTabs"
          :key="tabPath"
          class="workspace-tab-item"
          :class="{ 'workspace-tab-item--active': selectedFile === tabPath }"
        >
          <button
            type="button"
            class="workspace-tab-btn"
            :class="{ 'workspace-tab--active': selectedFile === tabPath }"
            data-testid="workspace-tab"
            :data-tab-path="tabPath"
            @click="selectNote(tabPath)"
          >
            {{ stripMarkdownExtension(tabPath.split('/').pop()) }}
          </button>
          <button
            type="button"
            class="workspace-tab-close"
            data-testid="close-tab-button"
            :data-tab-path="tabPath"
            aria-label="Close tab"
            @click.stop="closeTab(tabPath)"
          >
            ×
          </button>
        </div>
      </div>
      <div v-else class="workspace-tabs-spacer" aria-hidden="true" />

      <div class="workspace-topbar-actions">
        <button
          type="button"
          class="workspace-text-button"
          data-testid="command-palette-button"
          title="Commands (Ctrl+P)"
          @click="openCommandPaletteModal"
        >
          Commands
        </button>
        <button
          type="button"
          class="workspace-text-button"
          :class="{ 'workspace-text-button--active': layout.contextOpen }"
          data-testid="toggle-right-panel-button"
          :aria-expanded="layout.contextOpen ? 'true' : 'false'"
          title="Toggle contextual panel"
          @click="layout.contextOpen = !layout.contextOpen; persistLayout()"
        >
          Panel
        </button>
      </div>
    </header>

    <!-- Incomplete index warning banner (critical status, stays at top) -->
    <div
      v-if="!vaultIndexData.complete && vaultIndexData.failures && vaultIndexData.failures.length > 0"
      class="browser-alert workspace-index-notice"
      data-testid="index-partial-warning"
      role="status"
    >
      <span>Warning: Vault indexing is incomplete. Some links and searches may not be fully verified.</span>
    </div>

    <!-- Navigation confirmation banner if changes pending -->
    <div
      v-if="pendingNavigation"
      class="browser-alert browser-navigation-confirm"
      role="alert"
    >
      <p>
        {{
          viewerState.saving
            ? 'Please wait for the current save to finish before leaving this note.'
            : viewerState.reloading
              ? 'Please wait for the server copy to load before leaving this note.'
              : 'There are unsaved changes in this note. Do you want to discard them?'
        }}
      </p>
      <div class="workspace-confirm-actions">
        <button
          type="button"
          class="btn-secondary btn-compact"
          data-testid="navigation-keep-editing"
          @click="cancelPendingNavigation"
        >
          Keep editing
        </button>
        <button
          v-if="!viewerState.saving && !viewerState.reloading"
          type="button"
          class="btn-primary btn-compact"
          data-testid="navigation-discard-changes"
          @click="confirmDiscardAndNavigate"
        >
          Discard changes
        </button>
      </div>
    </div>

    <div class="workspace-body">
      <!-- File Explorer Sidebar -->
      <aside
        class="workspace-explorer"
        :class="{ 'workspace-explorer--collapsed': !layout.explorerOpen }"
        :style="{ width: `${layout.explorerWidth}px` }"
        data-testid="vault-explorer"
        @contextmenu.prevent="openEmptyAreaContextMenu($event)"
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
              @click.stop="showAddMenu = !showAddMenu"
            >
              +
            </button>
            <button
              v-if="selectedFile"
              type="button"
              class="explorer-action-btn"
              data-testid="reveal-active-file-button"
              title="Reveal active note in explorer"
              @click="revealActiveFile"
            >
              Reveal
            </button>

            <!-- Small Add Menu -->
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
                @click="showAddMenu = false; startCreate('note', selectedFolderPath)"
              >
                New note
              </button>
              <button
                type="button"
                class="dropdown-menu-item"
                data-testid="new-folder-button"
                @click="showAddMenu = false; startCreate('folder', selectedFolderPath)"
              >
                New folder
              </button>
            </div>
          </div>
        </div>

        <!-- Relocate Form (Rename / Move) -->
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
              @click="cancelRelocate"
            >
              Keep editing
            </button>
            <button
              type="button"
              class="btn-primary btn-compact"
              data-testid="relocate-confirm"
              :disabled="relocateState.loading"
              @click="confirmRelocate"
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
            @click="refreshWorkspace"
          >
            {{ refreshing ? 'Refreshing…' : 'Refresh vault' }}
          </button>
        </div>
        <form
          v-else-if="relocateState?.origin === 'manual' && (relocateState.stage === 'edit' || relocateState.stage === 'executing')"
          class="explorer-create-form"
          data-testid="relocate-form"
          @submit.prevent="submitRelocateForm"
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
            @keydown.esc.prevent="cancelRelocate"
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
              @click="submitRelocateForm"
            >
              Apply
            </button>
            <button
              type="button"
              class="btn-secondary btn-compact"
              data-testid="relocate-cancel"
              :disabled="relocateState.loading"
              @click="cancelRelocate"
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
              @click="confirmDeleteEntry('trash')"
            >
              Move to trash
            </button>
            <button
              type="button"
              class="btn-secondary btn-compact"
              data-testid="confirm-permanent-delete-button"
              :disabled="deleteConfirmState.loading"
              @click="confirmDeleteEntry('permanent')"
            >
              Delete permanently
            </button>
            <button
              type="button"
              class="btn-secondary btn-compact"
              @click="deleteConfirmState = null"
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

        <!-- File Tree -->
        <div
          class="workspace-tree"
          :class="{
            'workspace-tree--drop-valid': dropTarget?.path === '' && dropTarget.valid,
            'workspace-tree--drop-invalid': dropTarget?.path === '' && dropTarget && !dropTarget.valid,
          }"
          role="tree"
          data-testid="workspace-tree"
          @dragover.self.prevent="handleDragOverFolder('', $event)"
          @dragleave.self="handleDragLeaveTarget('', $event)"
          @drop.self.prevent="handleDropOnFolder('')"
          @contextmenu.prevent="openEmptyAreaContextMenu($event)"
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
              @click="fetchDirectory('')"
            >
              Try again
            </button>
          </div>

          <template v-else>
            <!-- Inline Create at Root if selectedFolderPath is empty -->
            <form
              v-if="createMode && !selectedFolderPath"
              class="tree-row tree-row--create"
              :style="{ paddingLeft: '10px' }"
              data-testid="new-entry-form"
              @submit.prevent="submitCreate"
            >
              <input
                ref="createInputRef"
                v-model="newEntryName"
                type="text"
                class="tree-inline-input"
                data-testid="new-entry-input"
                :placeholder="createMode === 'folder' ? 'Folder name' : 'Note name'"
                :disabled="creating"
                @keydown.esc.prevent="cancelCreate"
              />
              <div class="tree-create-actions">
                <button
                  type="button"
                  class="tree-btn-action"
                  data-testid="new-entry-submit"
                  :disabled="creating"
                  title="Create"
                  aria-label="Create"
                  @click="submitCreate"
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
                  @click="cancelCreate"
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
                  @dragstart.stop="handleDragStart(row.entry, $event)"
                  @dragend="clearDragState"
                  @dragover.stop.prevent="handleDragOverFolder(row.entry.path, $event)"
                  @dragleave.stop="handleDragLeaveTarget(row.entry.path, $event)"
                  @drop.stop.prevent="handleDropOnFolder(row.entry.path)"
                  @contextmenu.prevent.stop="openContextMenu($event, row.entry)"
                >
                  <button
                    type="button"
                    class="tree-row tree-folder"
                    :class="{ 'tree-folder--selected': selectedFolderPath === row.entry.path }"
                    data-testid="open-directory-button"
                    :data-folder-path="row.entry.path"
                    :aria-expanded="row.isExpanded ? 'true' : 'false'"
                    :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
                    @click="toggleFolder(row.entry.path)"
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
                    @click.stop="openContextMenu($event, row.entry)"
                  >
                    …
                  </button>
                </div>

                <!-- Inline Create inside folder if this folder is target -->
                <form
                  v-if="createMode && selectedFolderPath === row.entry.path"
                  class="tree-row tree-row--create"
                  :style="{ paddingLeft: `${(row.depth + 1) * 14 + 10}px` }"
                  data-testid="new-entry-form"
                  @submit.prevent="submitCreate"
                >
                  <input
                    ref="createInputRef"
                    v-model="newEntryName"
                    type="text"
                    class="tree-inline-input"
                    data-testid="new-entry-input"
                    :placeholder="createMode === 'folder' ? 'Folder name' : 'Note name'"
                    :disabled="creating"
                    @keydown.esc.prevent="cancelCreate"
                  />
                  <div class="tree-create-actions">
                    <button
                      type="button"
                      class="tree-btn-action"
                      data-testid="new-entry-submit"
                      :disabled="creating"
                      title="Create"
                      aria-label="Create"
                      @click="submitCreate"
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
                      @click="cancelCreate"
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
                @dragstart.stop="handleDragStart(row.entry, $event)"
                @dragend="clearDragState"
                @dragover.stop.prevent="handleDragOverFile(row.entry.path, $event)"
                @dragleave.stop="handleDragLeaveTarget(row.entry.path, $event)"
                @drop.stop.prevent="clearDragState"
                @contextmenu.prevent.stop="openContextMenu($event, row.entry)"
              >
                <button
                  type="button"
                  class="tree-row tree-file"
                  :class="{ 'tree-file--active': selectedFile === row.entry.path }"
                  data-testid="open-file-button"
                  :data-file-path="row.entry.path"
                  :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
                  @click="openFile(row.entry)"
                  @click.middle.prevent="openFile(row.entry, { newTab: true })"
                >
                  <span class="tree-chevron tree-chevron--spacer" aria-hidden="true" />
                  <span class="tree-label">{{ stripMarkdownExtension(row.entry.name) }}</span>
                </button>
                <button
                  type="button"
                  class="tree-row-menu-btn"
                  data-testid="entry-context-button"
                  :data-entry-path="row.entry.path"
                  aria-label="Note actions"
                  title="Note actions"
                  @click.stop="openContextMenu($event, row.entry)"
                >
                  …
                </button>
              </div>

              <div
                v-else-if="vaultSettings.showUnsupportedFiles"
                class="tree-row tree-file tree-file--unsupported"
                :class="{ 'tree-file--drop-invalid': dropTarget?.path === row.entry.path && dropTarget && !dropTarget.valid }"
                :style="{ paddingLeft: `${row.depth * 14 + 10}px` }"
                @dragover.stop.prevent="handleDragOverFile(row.entry.path, $event)"
                @dragleave.stop="handleDragLeaveTarget(row.entry.path, $event)"
                @drop.stop.prevent="clearDragState"
              >
                <span class="tree-chevron tree-chevron--spacer" aria-hidden="true" />
                <span class="tree-label">{{ row.entry.name }}</span>
              </div>
            </template>
          </template>
        </div>
      </aside>

      <!-- Left Splitter -->
      <div
        v-if="layout.explorerOpen"
        class="workspace-splitter"
        data-testid="resize-handle-explorer"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize file explorer"
        :aria-valuenow="layout.explorerWidth"
        aria-valuemin="180"
        aria-valuemax="480"
        @pointerdown="handleExplorerPointerDown"
        @keydown="handleExplorerSplitterKey"
      />

      <!-- Main Editor Pane -->
      <main
        class="workspace-editor-pane"
        data-testid="workspace-editor-pane"
      >
        <!-- Pending Link Notice -->
        <div
          v-if="linkNotice"
          class="browser-alert workspace-link-notice"
          data-testid="workspace-link-notice"
          role="status"
        >
          <div class="workspace-link-notice-header">
            <span>{{ linkNotice.message }}</span>
            <div class="workspace-link-notice-actions">
              <button
                v-if="linkNotice.type === 'missing' && linkNotice.rawTarget"
                type="button"
                class="btn-primary btn-compact"
                data-testid="create-missing-link-button"
                @click="createNoteFromPendingLink(linkNotice.rawTarget, linkNotice.kind)"
              >
                Create note
              </button>
              <button
                type="button"
                class="btn-secondary btn-compact"
                @click="linkNotice = null"
              >
                Dismiss
              </button>
            </div>
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

        <!-- Markdown Document View/Edit Surface -->
        <MarkdownViewer
          v-if="selectedFile !== null"
          ref="viewerRef"
          :directory="vault.directory"
          :path="selectedFile"
          :known-files="knownMarkdownFiles"
          :aliases-by-file="vaultIndexData.aliasesByFile"
          :index-complete="vaultIndexData.complete"
          :known-property-names="vaultIndexData.knownPropertyNames"
          :known-property-types="vaultIndexData.knownPropertyTypes"
          :anchor="selectedAnchor"
          :initial-document="initialDocument"
          :relocating="Boolean(relocateState?.affectedDocumentPath && (relocateState.stage === 'confirm' || relocateState.loading || relocateState.stage === 'uncertain'))"
          @back="closeNote"
          @state="handleViewerState"
          @open-link="handleOpenLink"
          @select-tag="handleSelectTag"
          @rename-note="handleRenameFromNoteTitle"
          @content-saved="handleContentSaved"
          @not-found="handleNoteNotFound"
          @unauthorized="emit('unauthorized')"
        />

        <div
          v-else
          class="workspace-empty-state"
          data-testid="workspace-empty-state"
        >
          <div class="workspace-empty-card">
            <h3>No note open</h3>
            <p>Select a note in the explorer on the left or create a new one to get started.</p>
            <div class="workspace-empty-actions">
              <button
                type="button"
                class="btn-primary btn-compact"
                @click="startCreate('note')"
              >
                Create new note
              </button>
            </div>
          </div>
        </div>
      </main>

      <!-- Right Splitter -->
      <div
        v-if="layout.contextOpen"
        class="workspace-splitter"
        data-testid="resize-handle-context"
        role="separator"
        tabindex="0"
        aria-orientation="vertical"
        aria-label="Resize context panel"
        :aria-valuenow="layout.contextWidth"
        aria-valuemin="200"
        aria-valuemax="480"
        @pointerdown="handleContextPointerDown"
        @keydown="handleContextSplitterKey"
      />

      <!-- Context Sidebar (Backlinks, Outgoing, Outline, Tags, Search) -->
      <aside
        class="workspace-right-panel"
        :class="{ 'workspace-right-panel--collapsed': !layout.contextOpen }"
        :style="{ width: `${layout.contextWidth}px` }"
        data-testid="workspace-right-panel"
      >
        <nav class="right-panel-tabs" role="tablist">
          <button
            type="button"
            class="right-panel-tab"
            :class="{ 'right-panel-tab--active': rightPanelTab === 'backlinks' }"
            data-testid="panel-tab-backlinks"
            @click="rightPanelTab = 'backlinks'"
          >
            Backlinks ({{ activeBacklinks.linked.length }})
          </button>
          <button
            type="button"
            class="right-panel-tab"
            :class="{ 'right-panel-tab--active': rightPanelTab === 'outgoing' }"
            data-testid="panel-tab-outgoing"
            @click="rightPanelTab = 'outgoing'"
          >
            Outgoing ({{ activeOutgoingLinks.resolved.length + activeOutgoingLinks.unresolved.length }})
          </button>
          <button
            type="button"
            class="right-panel-tab"
            :class="{ 'right-panel-tab--active': rightPanelTab === 'outline' }"
            data-testid="panel-tab-outline"
            @click="rightPanelTab = 'outline'"
          >
            Outline
          </button>
          <button
            type="button"
            class="right-panel-tab"
            :class="{ 'right-panel-tab--active': rightPanelTab === 'tags' }"
            data-testid="panel-tab-tags"
            @click="rightPanelTab = 'tags'"
          >
            Tags
          </button>
          <button
            type="button"
            class="right-panel-tab"
            :class="{ 'right-panel-tab--active': rightPanelTab === 'search' }"
            data-testid="panel-tab-search"
            @click="rightPanelTab = 'search'"
          >
            Search
          </button>
        </nav>

        <div class="right-panel-body">
          <!-- Backlinks Tab -->
          <div v-if="rightPanelTab === 'backlinks'" data-testid="backlinks-panel">
            <h4 class="panel-section-title">Linked mentions ({{ activeBacklinks.linked.length }})</h4>
            <p v-if="activeBacklinks.linked.length === 0" class="panel-empty">No linked mentions yet.</p>
            <button
              v-for="(item, idx) in activeBacklinks.linked"
              :key="`bl-${idx}-${item.sourcePath}`"
              type="button"
              class="panel-list-item"
              data-testid="backlink-item"
              :data-source-path="item.sourcePath"
              @click="openCandidateLink(item.sourcePath)"
            >
              <strong class="panel-item-title">{{ item.sourceName }}</strong>
              <span class="panel-item-snippet">{{ item.snippet || item.raw }}</span>
            </button>

            <h4 class="panel-section-title">Unlinked mentions ({{ activeBacklinks.unlinkedMentions.length }})</h4>
            <p v-if="activeBacklinks.unlinkedMentions.length === 0" class="panel-empty">No unlinked mentions.</p>
            <button
              v-for="(item, idx) in activeBacklinks.unlinkedMentions"
              :key="`ul-${idx}-${item.sourcePath}`"
              type="button"
              class="panel-list-item"
              data-testid="unlinked-mention-item"
              :data-source-path="item.sourcePath"
              @click="openCandidateLink(item.sourcePath)"
            >
              <strong class="panel-item-title">{{ item.sourceName }}</strong>
              <span class="panel-item-snippet">{{ item.snippet }}</span>
            </button>
          </div>

          <!-- Outgoing Links Tab -->
          <div v-else-if="rightPanelTab === 'outgoing'" data-testid="outgoing-links-panel">
            <h4 class="panel-section-title">Resolved links ({{ activeOutgoingLinks.resolved.length }})</h4>
            <p v-if="activeOutgoingLinks.resolved.length === 0" class="panel-empty">No outgoing resolved links.</p>
            <button
              v-for="(item, idx) in activeOutgoingLinks.resolved"
              :key="`out-res-${idx}-${item.targetPath}`"
              type="button"
              class="panel-list-item"
              data-testid="outgoing-resolved-item"
              :data-target-path="item.targetPath"
              @click="openCandidateLink(item.targetPath, item.anchor)"
            >
              <strong class="panel-item-title">{{ item.targetPath }}</strong>
              <span class="panel-item-snippet">{{ item.raw }}</span>
            </button>

            <h4 class="panel-section-title">Pending / Unresolved ({{ activeOutgoingLinks.unresolved.length }})</h4>
            <p v-if="activeOutgoingLinks.unresolved.length === 0" class="panel-empty">No pending links.</p>
            <button
              v-for="(item, idx) in activeOutgoingLinks.unresolved"
              :key="`out-unres-${idx}-${item.raw}`"
              type="button"
              class="panel-list-item panel-list-item--pending"
              data-testid="outgoing-unresolved-item"
              :data-raw-target="item.rawTarget"
              @click="createNoteFromPendingLink(item.raw, item.kind)"
            >
              <strong class="panel-item-title">{{ item.rawTarget }} (create)</strong>
              <span class="panel-item-snippet">{{ item.raw }}</span>
            </button>
          </div>

          <!-- Outline Tab -->
          <div v-else-if="rightPanelTab === 'outline'" data-testid="outline-panel">
            <h4 class="panel-section-title">Document Outline</h4>
            <p v-if="activeOutline.length === 0" class="panel-empty">No headings in this note.</p>
            <button
              v-for="(heading, idx) in activeOutline"
              :key="`h-${idx}-${heading.line}`"
              type="button"
              class="panel-list-item"
              data-testid="outline-heading-item"
              :style="{ paddingLeft: `${(heading.level - 1) * 10 + 8}px` }"
              @click="selectedAnchor = heading.text"
            >
              <span class="panel-item-title">H{{ heading.level }} · {{ heading.text }}</span>
            </button>
          </div>

          <!-- Tags Tab -->
          <div v-else-if="rightPanelTab === 'tags'" data-testid="tags-panel">
            <h4 class="panel-section-title">Vault Tags</h4>
            <div class="panel-tags-cloud">
              <button
                v-for="tagEntry in vaultIndexData.allTags"
                :key="tagEntry.tag"
                type="button"
                class="tag-cloud-chip"
                :class="{ 'tag-cloud-chip--active': activeTagFilter.toLowerCase() === tagEntry.tag.toLowerCase() }"
                data-testid="vault-tag-item"
                :data-tag-name="tagEntry.tag"
                @click="activeTagFilter = tagEntry.tag"
              >
                #{{ tagEntry.tag }} ({{ tagEntry.count }})
              </button>
            </div>
            <div v-if="activeTagFilter" class="tag-filter-results">
              <div class="tag-filter-header">
                <strong>Notes with #{{ activeTagFilter }}</strong>
                <button type="button" class="btn-secondary btn-compact" @click="activeTagFilter = ''">Clear</button>
              </div>
              <button
                v-for="note in filteredTagNotes"
                :key="note.path"
                type="button"
                class="panel-list-item"
                data-testid="tag-result-item"
                :data-note-path="note.path"
                @click="openCandidateLink(note.path)"
              >
                <strong class="panel-item-title">{{ note.title }}</strong>
                <span class="panel-item-snippet">{{ note.path }}</span>
              </button>
            </div>
          </div>

          <!-- Search Tab -->
          <div v-else-if="rightPanelTab === 'search'" data-testid="search-panel">
            <input
              v-model="searchQuery"
              type="search"
              class="explorer-create-input"
              data-testid="vault-search-input"
              placeholder="Search notes, #tags, aliases…"
            />
            <div class="vault-search-results" data-testid="vault-search-results">
              <button
                v-for="res in searchResults"
                :key="res.path"
                type="button"
                class="panel-list-item"
                data-testid="search-result-item"
                :data-note-path="res.path"
                @click="openCandidateLink(res.path)"
              >
                <strong class="panel-item-title">{{ res.name }}</strong>
                <span class="panel-item-snippet">{{ res.snippet || res.path }}</span>
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>

    <!-- Teleported Clamped Context Menu -->
    <Teleport to="body" :disabled="isTestEnv">
      <div
        v-if="contextMenu"
        class="explorer-context-menu"
        data-testid="explorer-context-menu"
        role="menu"
        :style="{
          position: 'fixed',
          left: `${contextMenuPos.left}px`,
          top: `${contextMenuPos.top}px`,
          zIndex: 1200,
        }"
        @click.stop
      >
        <template v-if="contextMenu.type === 'empty'">
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-new-note"
            @click="startCreate('note', '')"
          >
            New note
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-new-folder"
            @click="startCreate('folder', '')"
          >
            New folder
          </button>
        </template>
        <template v-else-if="contextMenu.entry && contextMenu.entry.type === 'directory'">
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-new-note"
            @click="startCreate('note', contextMenu.entry.path)"
          >
            New note
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-new-folder"
            @click="startCreate('folder', contextMenu.entry.path)"
          >
            New subfolder
          </button>
          <div class="dropdown-divider" />
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-rename"
            @click="startRelocate(contextMenu.entry, 'rename')"
          >
            Rename
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-move"
            @click="startRelocate(contextMenu.entry, 'move')"
          >
            Move to…
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-copy-path"
            @click="copyRelativePath(contextMenu.entry)"
          >
            Copy relative path
          </button>
          <div class="dropdown-divider" />
          <button
            type="button"
            class="context-menu-item context-menu-item--danger"
            data-testid="ctx-delete"
            @click="requestDeleteEntry(contextMenu.entry)"
          >
            Delete folder
          </button>
        </template>
        <template v-else-if="contextMenu.entry">
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-open"
            @click="selectNote(contextMenu.entry.path); closeContextMenu()"
          >
            Open
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-open-new-tab"
            @click="openFileInNewTab(contextMenu.entry.path)"
          >
            Open in new tab
          </button>
          <div class="dropdown-divider" />
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-rename"
            @click="startRelocate(contextMenu.entry, 'rename')"
          >
            Rename
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-move"
            @click="startRelocate(contextMenu.entry, 'move')"
          >
            Move to…
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-copy-link"
            @click="copyWikilink(contextMenu.entry)"
          >
            Copy internal link
          </button>
          <button
            type="button"
            class="context-menu-item"
            data-testid="ctx-copy-path"
            @click="copyRelativePath(contextMenu.entry)"
          >
            Copy relative path
          </button>
          <div class="dropdown-divider" />
          <button
            type="button"
            class="context-menu-item context-menu-item--danger"
            data-testid="ctx-delete"
            @click="requestDeleteEntry(contextMenu.entry)"
          >
            Delete note
          </button>
        </template>
      </div>
    </Teleport>

    <!-- Teleported Floating Toasts Container (Zero Layout Shift) -->
    <Teleport to="body" :disabled="isTestEnv">
      <aside class="workspace-toast-container" data-testid="workspace-toast-container">
        <div
          v-if="workspaceNotice"
          class="workspace-toast workspace-toast--info"
          data-testid="workspace-notice"
          role="status"
        >
          <span>{{ workspaceNotice }}</span>
          <button type="button" class="toast-close-btn" aria-label="Dismiss notice" @click="workspaceNotice = ''">×</button>
        </div>
        <div
          v-for="t in toasts"
          :key="t.id"
          class="workspace-toast"
          :class="`workspace-toast--${t.type}`"
          data-testid="workspace-toast"
          role="status"
        >
          <span>{{ t.message }}</span>
          <button type="button" class="toast-close-btn" aria-label="Dismiss notification" @click="removeToast(t.id)">×</button>
        </div>
      </aside>
    </Teleport>

    <!-- Redesigned Ayame Trash Modal -->
    <div
      v-if="showTrashModal"
      class="workspace-modal-backdrop"
      data-testid="trash-panel"
      role="dialog"
      aria-label="Vault trash"
      @click.self="showTrashModal = false"
    >
      <div class="workspace-modal trash-modal">
        <header class="workspace-modal-header">
          <div>
            <h3 class="trash-modal-title">Trash</h3>
            <p class="trash-modal-subtitle">Deleted items in this vault</p>
          </div>
          <button
            type="button"
            class="modal-close-btn"
            data-testid="close-trash-modal-button"
            aria-label="Close"
            @click="showTrashModal = false"
          >
            ×
          </button>
        </header>

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
                @click="handleRestoreTrashItem(trashRestoreConflict.item, trashRestoreConflict.targetPath)"
              >
                Restore to destination
              </button>
              <button
                type="button"
                class="btn-secondary btn-compact"
                @click="trashRestoreConflict = null"
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
                @click="handleRestoreTrashItem(item)"
              >
                Restore
              </button>
              <button
                type="button"
                class="btn-secondary btn-compact btn-danger"
                data-testid="delete-trash-permanently-button"
                @click="handleDeleteTrashPermanently(item)"
              >
                Delete permanently
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Command Palette Modal -->
    <div
      v-if="showCommandPalette"
      class="workspace-modal-backdrop"
      data-testid="command-palette-modal"
      role="dialog"
      aria-label="Command palette"
      @click.self="showCommandPalette = false"
    >
      <div class="workspace-modal">
        <header class="workspace-modal-header">
          <div>
            <h3 class="trash-modal-title">Command palette</h3>
            <p class="trash-modal-subtitle">Search commands or notes</p>
          </div>
          <button type="button" class="modal-close-btn" aria-label="Close" @click="showCommandPalette = false">×</button>
        </header>
        <input
          v-model="commandPaletteQuery"
          type="text"
          class="explorer-create-input"
          data-testid="command-palette-input"
          placeholder="Type a command or note name…"
          autofocus
        />
        <div class="trash-list">
          <button
            v-for="cmd in commandPaletteItems"
            :key="cmd.id"
            type="button"
            class="panel-list-item"
            @click="showCommandPalette = false; cmd.run()"
          >
            <span class="panel-item-title">{{ cmd.label }}</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Quick Switcher Modal (accessible via shortcut or command) -->
    <div
      v-if="showQuickSwitcher"
      class="workspace-modal-backdrop"
      data-testid="quick-switcher-modal"
      role="dialog"
      aria-label="Quick switcher"
      @click.self="showQuickSwitcher = false"
    >
      <div class="workspace-modal">
        <header class="workspace-modal-header">
          <div>
            <h3 class="trash-modal-title">Open note</h3>
            <p class="trash-modal-subtitle">Type to navigate quickly</p>
          </div>
          <button type="button" class="modal-close-btn" aria-label="Close" @click="showQuickSwitcher = false">×</button>
        </header>
        <input
          v-model="quickSwitcherQuery"
          type="text"
          class="explorer-create-input"
          data-testid="quick-switcher-input"
          placeholder="Note name…"
        />
        <div class="trash-list">
          <button
            v-for="filePath in quickSwitcherResults"
            :key="filePath"
            type="button"
            class="panel-list-item"
            data-testid="quick-switcher-item"
            :data-file-path="filePath"
            @click="showQuickSwitcher = false; openCandidateLink(filePath)"
          >
            {{ filePath }}
          </button>
          <button
            v-if="quickSwitcherQuery.trim() && !quickSwitcherResults.includes(`${quickSwitcherQuery.trim()}.md`)"
            type="button"
            class="panel-list-item panel-list-item--pending"
            data-testid="quick-switcher-create"
            @click="showQuickSwitcher = false; createNoteFromPendingLink(`[[${quickSwitcherQuery.trim()}]]`, 'wikilink')"
          >
            Create "{{ quickSwitcherQuery.trim() }}"
          </button>
        </div>
      </div>
    </div>

    <!-- Vault Settings Modal -->
    <div
      v-if="showSettingsModal"
      class="workspace-modal-backdrop"
      data-testid="vault-settings-modal"
      role="dialog"
      aria-label="Vault Settings"
      @click.self="showSettingsModal = false"
    >
      <div class="workspace-modal">
        <header class="workspace-modal-header">
          <div>
            <h3 class="trash-modal-title">Vault settings</h3>
            <p class="trash-modal-subtitle">{{ vault.name }} ({{ vault.directory }})</p>
          </div>
          <button type="button" class="modal-close-btn" aria-label="Close" @click="showSettingsModal = false">×</button>
        </header>
        <div class="settings-form">
          <label class="settings-row">
            <span>Show unsupported files</span>
            <input
              v-model="vaultSettings.showUnsupportedFiles"
              type="checkbox"
              data-testid="setting-show-unsupported-files"
            />
          </label>
          <label class="settings-row">
            <span>Automatically update internal links on rename/move</span>
            <input
              v-model="vaultSettings.autoUpdateLinks"
              type="checkbox"
              data-testid="setting-auto-update-links"
            />
          </label>
          <label class="settings-row">
            <span>Use Wikilinks ([[Note]]) by default</span>
            <input
              v-model="vaultSettings.useWikilinks"
              type="checkbox"
              data-testid="setting-use-wikilinks"
            />
          </label>
          <label class="settings-row">
            <span>Default deletion behavior</span>
            <select
              v-model="vaultSettings.deleteBehavior"
              class="explorer-create-input"
              data-testid="setting-delete-behavior"
            >
              <option value="trash">Trash (.trash)</option>
              <option value="permanent">Permanent deletion</option>
            </select>
          </label>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.workspace-shell {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  background: var(--ayame-background, #111218);
  border: none;
  border-radius: 0;
  overflow: hidden;
  position: relative;
}

/* Minimal Ayame Topbar */
.workspace-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  height: 40px;
  min-height: 40px;
  padding: 0 0.85rem;
  background: var(--ayame-surface, #1b1c25);
  border-bottom: 1px solid var(--ayame-border, #34323f);
}

.workspace-topbar-left {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-shrink: 0;
}

.workspace-text-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  height: 28px;
  min-height: 28px;
  padding: 0 0.55rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.8125rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  user-select: none;
  transition: all 0.12s ease;
}

.workspace-text-button:hover,
.workspace-text-button:focus-visible {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
  border-color: var(--ayame-border, #34323f);
  outline: none;
}

.workspace-text-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.workspace-text-button--active {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-primary, #a99aca);
  border-color: var(--ayame-border, #34323f);
}

.vault-dropdown-wrapper {
  position: relative;
}

.vault-name-trigger {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 5px;
  padding: 0.28rem 0.55rem;
  color: var(--ayame-text, #eeeaf3);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.12s ease;
}

.vault-name-trigger:hover,
.vault-name-trigger:focus-visible {
  background: var(--ayame-hover, #242530);
  border-color: var(--ayame-border, #34323f);
  outline: none;
}

.vault-name {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.vault-dropdown-menu {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 100;
  min-width: 220px;
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
  padding: 0.35rem;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.65);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.workspace-topbar-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}

.dropdown-menu-item {
  background: transparent;
  border: none;
  color: var(--ayame-text, #eeeaf3);
  padding: 0.45rem 0.65rem;
  font-size: 0.8125rem;
  border-radius: 4px;
  text-align: left;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  transition: background-color 0.1s ease;
  width: 100%;
}

.dropdown-menu-item:hover:not(:disabled) {
  background: var(--ayame-hover, #242530);
}

.dropdown-menu-item:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.dropdown-menu-item--danger {
  color: var(--ayame-error, #d8a6b0);
}

.dropdown-menu-item--danger:hover:not(:disabled) {
  background: rgba(216, 166, 176, 0.12);
}

.dropdown-divider {
  border: none;
  border-top: 1px solid var(--ayame-border, #34323f);
  margin: 0.25rem 0;
}

/* Workspace Body */
.workspace-body {
  display: flex;
  flex-direction: row;
  flex: 1;
  width: 100%;
  height: calc(100% - 40px);
  min-height: 0;
  min-width: 0;
  overflow: hidden;
  position: relative;
}

.workspace-splitter {
  width: 1px;
  flex: 0 0 1px;
  background: var(--ayame-border, #34323f);
  cursor: col-resize;
  position: relative;
  user-select: none;
  touch-action: none;
  z-index: 20;
  transition: background-color 0.15s ease;
}

.workspace-splitter::before {
  content: '';
  position: absolute;
  top: 0;
  bottom: 0;
  left: -4px;
  right: -4px;
  cursor: col-resize;
  z-index: 1;
}

.workspace-splitter:hover,
.workspace-splitter:focus-visible {
  background: var(--ayame-primary, #a99aca);
  outline: none;
}

/* Explorer Sidebar */
.workspace-explorer {
  display: flex;
  flex-direction: column;
  background: var(--ayame-surface, #1b1c25);
  border-right: none;
  height: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}

.workspace-explorer--collapsed {
  display: none;
}

.explorer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 38px;
  min-height: 38px;
  padding: 0 0.75rem;
  border-bottom: 1px solid var(--ayame-border, #34323f);
}

.explorer-title {
  font-size: 0.75rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--ayame-text-muted, #aaa6b8);
}

.explorer-header-actions {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  position: relative;
}

.explorer-action-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ayame-text-muted, #aaa6b8);
  height: 22px;
  padding: 0 0.45rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  cursor: pointer;
  font-size: 0.75rem;
  font-weight: 500;
  transition: all 0.1s ease;
}

.explorer-action-btn:hover,
.explorer-action-btn:focus-visible {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
  border-color: var(--ayame-border, #34323f);
  outline: none;
}

.explorer-add-menu {
  position: absolute;
  top: calc(100% + 4px);
  right: 0;
  z-index: 60;
  min-width: 150px;
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
  padding: 0.3rem;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6);
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.explorer-create-form {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
  padding: 0.65rem;
  background: rgba(169, 154, 202, 0.06);
  border-bottom: 1px solid var(--ayame-border, #34323f);
}

.explorer-create-label {
  font-size: 0.78rem;
  color: var(--ayame-text-muted, #aaa6b8);
  margin: 0;
}

.explorer-create-input {
  width: 100%;
  box-sizing: border-box;
  padding: 0.38rem 0.55rem;
  background: var(--ayame-background, #111218);
  color: var(--ayame-text, #eeeaf3);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  font-size: 0.8125rem;
}

.explorer-create-input:focus {
  border-color: var(--ayame-primary, #a99aca);
  outline: none;
}

.explorer-create-actions {
  display: flex;
  gap: 0.4rem;
  flex-wrap: wrap;
}

/* File Tree */
.workspace-tree {
  flex: 1;
  overflow-y: auto;
  padding: 0.25rem 0.35rem;
}

.workspace-tree--drop-valid {
  box-shadow: inset 0 0 0 1px var(--ayame-primary, #a99aca);
}

.workspace-tree--drop-invalid {
  box-shadow: inset 0 0 0 1px var(--ayame-error, #d8a6b0);
}

.tree-row-wrapper {
  display: flex;
  align-items: center;
  width: 100%;
  margin-bottom: 1px;
}

.tree-row-wrapper--dragging {
  opacity: 0.42;
}

.tree-row-wrapper--drop-valid .tree-row {
  background: rgba(169, 154, 202, 0.22);
  box-shadow: inset 0 0 0 1px var(--ayame-primary, #a99aca);
  color: var(--ayame-text, #eeeaf3);
  cursor: move;
}

.tree-row-wrapper--drop-invalid .tree-row {
  background: rgba(216, 166, 176, 0.1);
  box-shadow: inset 0 0 0 1px var(--ayame-error, #d8a6b0);
  color: var(--ayame-error, #d8a6b0);
  cursor: not-allowed;
}

.tree-row {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 0.45rem;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.84rem;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.1s ease, color 0.1s ease;
}

.tree-row:hover {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
}

.tree-row:focus {
  outline: none;
}

.tree-row:focus-visible {
  outline: 2px solid var(--ayame-primary, #a99aca);
  outline-offset: -2px;
}

.tree-chevron {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  font-size: 0.72rem;
  color: var(--ayame-text-muted, #aaa6b8);
  flex-shrink: 0;
  user-select: none;
  line-height: 1;
}

.tree-chevron--spacer {
  visibility: hidden;
  pointer-events: none;
}

.tree-row:hover .tree-chevron {
  color: var(--ayame-text, #eeeaf3);
}

.tree-row-menu-btn {
  opacity: 0;
  background: transparent;
  border: 1px solid transparent;
  color: var(--ayame-text-muted, #aaa6b8);
  cursor: pointer;
  width: 22px;
  height: 22px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.85rem;
  line-height: 1;
  border-radius: 3px;
  flex-shrink: 0;
  margin-right: 2px;
  transition: opacity 0.1s ease, background-color 0.1s ease, color 0.1s ease;
}

.tree-row-wrapper:has(.tree-file--active) .tree-row-menu-btn,
.tree-row-wrapper:has(.tree-folder--selected) .tree-row-menu-btn,
.tree-file--active + .tree-row-menu-btn,
.tree-folder--selected + .tree-row-menu-btn {
  opacity: 0.72;
}

.tree-row-wrapper:hover .tree-row-menu-btn,
.tree-row-wrapper:focus-within .tree-row-menu-btn,
.tree-row-menu-btn:focus-visible,
.tree-row-wrapper:has(.tree-file--active) .tree-row-menu-btn:hover,
.tree-row-wrapper:has(.tree-folder--selected) .tree-row-menu-btn:hover,
.tree-file--active + .tree-row-menu-btn:hover,
.tree-folder--selected + .tree-row-menu-btn:hover {
  opacity: 1;
}

.tree-row-menu-btn:hover,
.tree-row-menu-btn:focus-visible {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
  border-color: var(--ayame-border, #34323f);
  outline: none;
}

@media (hover: none) {
  .tree-row-menu-btn {
    opacity: 0.6;
  }
}

.tree-folder--selected {
  background: rgba(169, 154, 202, 0.1);
  color: var(--ayame-text, #eeeaf3);
  font-weight: 500;
}

.tree-file--active {
  background: rgba(169, 154, 202, 0.16);
  color: var(--ayame-lavender, #d4cbe4);
  font-weight: 500;
}

.tree-file--unsupported {
  opacity: 0.72;
  cursor: default;
}

.tree-file--unsupported:hover {
  background: transparent;
  color: var(--ayame-text, #eeeaf3);
}

.tree-file--unsupported.tree-file--drop-invalid {
  background: rgba(216, 166, 176, 0.1);
  box-shadow: inset 0 0 0 1px var(--ayame-error, #d8a6b0);
  color: var(--ayame-error, #d8a6b0);
  cursor: not-allowed;
}

.tree-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}

/* Inline Create Row */
.tree-row--create {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  height: 32px;
  background: rgba(169, 154, 202, 0.08);
  border: 1px solid var(--ayame-primary, #a99aca);
  border-radius: 4px;
  margin: 2px 0;
  padding-right: 0.35rem;
}

.tree-inline-input {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: none;
  color: var(--ayame-text, #eeeaf3);
  font-size: 0.8125rem;
  outline: none;
}

.tree-create-actions {
  display: flex;
  gap: 2px;
}

.tree-btn-action {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ayame-text-muted, #aaa6b8);
  height: 20px;
  padding: 0 0.35rem;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 3px;
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.1s ease;
}

.tree-btn-action:hover,
.tree-btn-action:focus-visible {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
  border-color: var(--ayame-border, #34323f);
  outline: none;
}

/* Teleported Context Menu */
.explorer-context-menu {
  position: fixed;
  z-index: 1200;
  min-width: 185px;
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
  padding: 0.35rem;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.65);
}

.context-menu-item {
  background: transparent;
  border: none;
  color: var(--ayame-text, #eeeaf3);
  text-align: left;
  padding: 0.4rem 0.65rem;
  border-radius: 4px;
  font-size: 0.8125rem;
  cursor: pointer;
  transition: background-color 0.1s ease;
  width: 100%;
}

.context-menu-item:hover {
  background: var(--ayame-hover, #242530);
}

.context-menu-item--danger {
  color: var(--ayame-error, #d8a6b0);
}

.context-menu-item--danger:hover {
  background: rgba(216, 166, 176, 0.12);
}

/* Editor Pane & Discreet Tabs */
.workspace-editor-pane {
  display: flex;
  flex-direction: column;
  flex: 1 1 0%;
  min-width: 420px;
  height: 100%;
  min-height: 0;
  background: var(--ayame-background, #111218);
  overflow: hidden;
}

.workspace-tabs-bar {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 0;
  gap: 3px;
  padding: 0 0.35rem;
  height: 100%;
  overflow-x: auto;
  scrollbar-width: thin;
  scrollbar-color: var(--ayame-border, #34323f) transparent;
}

.workspace-tabs-bar::-webkit-scrollbar {
  height: 3px;
}

.workspace-tabs-bar::-webkit-scrollbar-thumb {
  background: var(--ayame-border, #34323f);
  border-radius: 2px;
}

.workspace-tabs-spacer {
  flex: 1 1 auto;
  min-width: 0;
}

.workspace-tab-item {
  display: inline-flex;
  align-items: center;
  height: 28px;
  padding: 0 0.55rem;
  background: rgba(255, 255, 255, 0.03);
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.8rem;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
  transition: all 0.1s ease;
}

.workspace-tab-item:hover {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
}

.workspace-tab-item--active {
  background: var(--ayame-background, #111218);
  border-color: var(--ayame-border, #34323f);
  color: var(--ayame-text, #eeeaf3);
  font-weight: 500;
}

.workspace-tab-btn {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  padding: 0;
  cursor: pointer;
  white-space: nowrap;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
}

.workspace-tab-close {
  background: transparent;
  border: 1px solid transparent;
  color: inherit;
  font-size: 0.85rem;
  line-height: 1;
  margin-left: 0.35rem;
  padding: 0;
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: 3px;
  opacity: 0.6;
  transition: all 0.1s ease;
}

.workspace-tab-close:hover,
.workspace-tab-close:focus-visible {
  opacity: 1;
  background: rgba(255, 255, 255, 0.12);
  border-color: rgba(255, 255, 255, 0.18);
  outline: none;
}

/* Right Panel */
.workspace-right-panel {
  display: flex;
  flex-direction: column;
  background: var(--ayame-surface, #1b1c25);
  border-left: none;
  height: 100%;
  min-height: 0;
  min-width: 0;
  position: relative;
  overflow: hidden;
  flex-shrink: 0;
}

.workspace-right-panel--collapsed {
  display: none;
}

.right-panel-tabs {
  display: flex;
  flex-wrap: nowrap;
  gap: 0.2rem;
  padding: 0.35rem 0.45rem;
  border-bottom: 1px solid var(--ayame-border, #34323f);
  overflow-x: auto;
  scrollbar-width: none;
}

.right-panel-tabs::-webkit-scrollbar {
  display: none;
}

.right-panel-tab {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.75rem;
  padding: 0.2rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
  white-space: nowrap;
  flex-shrink: 0;
}

.right-panel-tab:hover {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
}

.right-panel-tab--active {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-lavender, #d4cbe4);
  border-color: var(--ayame-border, #34323f);
}

.right-panel-body {
  padding: 0.65rem;
  overflow-y: auto;
  flex: 1;
}

.panel-section-title {
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--ayame-text-muted, #aaa6b8);
  margin: 0.5rem 0 0.35rem;
}

.panel-list-item {
  display: flex;
  flex-direction: column;
  width: 100%;
  text-align: left;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  padding: 0.35rem 0.45rem;
  margin-bottom: 0.2rem;
  color: var(--ayame-text, #eeeaf3);
  cursor: pointer;
  transition: background-color 0.1s ease;
}

.panel-list-item:hover {
  background: var(--ayame-hover, #242530);
}

.panel-item-title {
  font-size: 0.8125rem;
}

.panel-item-snippet {
  font-size: 0.72rem;
  color: var(--ayame-text-muted, #aaa6b8);
}

.panel-tags-cloud {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.65rem;
}

.tag-cloud-chip {
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--ayame-border, #34323f);
  color: var(--ayame-text, #eeeaf3);
  border-radius: 999px;
  padding: 0.12rem 0.45rem;
  font-size: 0.75rem;
  cursor: pointer;
}

.tag-cloud-chip:hover {
  background: var(--ayame-hover, #242530);
}

.tag-cloud-chip--active {
  background: var(--ayame-primary, #a99aca);
  color: #111218;
}

/* Modals */
.workspace-modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.workspace-modal {
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 8px;
  padding: 1.25rem;
  width: min(540px, 92vw);
  max-height: 80vh;
  overflow-y: auto;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.7);
}

.workspace-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 1rem;
}

.trash-modal-title {
  margin: 0;
  font-size: 1.15rem;
  color: var(--ayame-text, #eeeaf3);
}

.trash-modal-subtitle {
  margin: 0.2rem 0 0;
  font-size: 0.8125rem;
  color: var(--ayame-text-muted, #aaa6b8);
}

.modal-close-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 1.15rem;
  cursor: pointer;
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  border-radius: 4px;
  transition: all 0.1s ease;
}

.modal-close-btn:hover,
.modal-close-btn:focus-visible {
  color: var(--ayame-text, #eeeaf3);
  background: var(--ayame-hover, #242530);
  border-color: var(--ayame-border, #34323f);
  outline: none;
}

.trash-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 2.5rem 1rem;
  color: var(--ayame-text-muted, #aaa6b8);
  gap: 0.5rem;
}

.trash-items-list {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.trash-item-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.65rem 0.75rem;
  background: var(--ayame-background, #111218);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
}

.trash-item-details {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  min-width: 0;
}

.trash-item-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.trash-item-name {
  font-size: 0.875rem;
  color: var(--ayame-text, #eeeaf3);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-item-path {
  font-size: 0.75rem;
  color: var(--ayame-text-muted, #aaa6b8);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.trash-item-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}

.trash-conflict-box {
  padding: 0.75rem;
  background: rgba(216, 166, 176, 0.1);
  border: 1px solid var(--ayame-error, #d8a6b0);
  border-radius: 6px;
  margin-bottom: 0.75rem;
}

.trash-conflict-text {
  margin: 0 0 0.5rem;
  font-size: 0.8125rem;
  color: var(--ayame-text, #eeeaf3);
}

.trash-conflict-form {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.trash-conflict-actions {
  display: flex;
  gap: 0.4rem;
}

.btn-danger {
  color: var(--ayame-error, #d8a6b0);
  border-color: rgba(216, 166, 176, 0.3);
}

.btn-danger:hover {
  background: rgba(216, 166, 176, 0.15);
}

/* Floating Toast Container (Zero Layout Shift) */
.workspace-toast-container {
  position: fixed;
  bottom: 1.5rem;
  right: 1.5rem;
  z-index: 2000;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  pointer-events: none;
}

.workspace-toast {
  pointer-events: auto;
  display: inline-flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 0.9rem;
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
  color: var(--ayame-text, #eeeaf3);
  font-size: 0.8125rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.5);
  animation: toast-slide-in 0.15s ease-out;
}

.workspace-toast--success {
  border-left: 3px solid var(--ayame-lavender, #d4cbe4);
}

.workspace-toast--error {
  border-left: 3px solid var(--ayame-error, #d8a6b0);
  color: var(--ayame-error, #d8a6b0);
}

.workspace-toast--info {
  border-left: 3px solid var(--ayame-primary, #a99aca);
}

.toast-close-btn {
  background: transparent;
  border: 1px solid transparent;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.95rem;
  cursor: pointer;
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  line-height: 1;
  border-radius: 3px;
  transition: all 0.1s ease;
}

.toast-close-btn:hover,
.toast-close-btn:focus-visible {
  color: var(--ayame-text, #eeeaf3);
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.15);
  outline: none;
}

@keyframes toast-slide-in {
  from {
    transform: translateY(8px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

/* Settings Form */
.settings-form {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.settings-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.86rem;
  color: var(--ayame-text, #eeeaf3);
}

/* Empty State */
.workspace-empty-state {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
  padding: 2rem;
}

.workspace-empty-card {
  max-width: 420px;
  text-align: center;
  color: var(--ayame-text-muted, #aaa6b8);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.workspace-empty-card h3 {
  margin: 0;
  color: var(--ayame-text, #eeeaf3);
  font-size: 1.15rem;
}

.workspace-empty-card p {
  margin: 0;
  font-size: 0.875rem;
  line-height: 1.5;
}

.workspace-empty-actions {
  margin-top: 0.5rem;
}

/* Buttons */
.btn-primary,
.btn-secondary {
  padding: 0.42rem 0.85rem;
  font-size: 0.85rem;
  font-weight: 600;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.12s ease;
}

.btn-primary {
  background: var(--ayame-primary, #a99aca);
  color: #111218;
  border: none;
}

.btn-primary:hover:not(:disabled) {
  background: var(--ayame-lavender, #d4cbe4);
}

.btn-secondary {
  background: transparent;
  color: var(--ayame-lavender, #d4cbe4);
  border: 1px solid var(--ayame-border, #34323f);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
}

.btn-compact {
  padding: 0.25rem 0.55rem;
  font-size: 0.78rem;
}

.browser-alert {
  padding: 0.65rem 0.85rem;
  font-size: 0.8125rem;
  border-radius: 4px;
  margin: 0.5rem;
}

.browser-error {
  background: rgba(216, 166, 176, 0.15);
  border: 1px solid var(--ayame-error, #d8a6b0);
  color: var(--ayame-error, #d8a6b0);
}

.workspace-index-notice {
  background: rgba(169, 154, 202, 0.12);
  border: 1px solid var(--ayame-primary, #a99aca);
  color: var(--ayame-text, #eeeaf3);
  margin: 0.35rem 0.75rem 0;
}

.browser-navigation-confirm {
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  color: var(--ayame-text, #eeeaf3);
  margin: 0.5rem 0.75rem;
}

.workspace-confirm-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.relocate-error,
.draft-warning {
  font-size: 0.78rem;
  margin: 0.25rem 0 0;
}

.relocate-error {
  color: var(--ayame-error, #d8a6b0);
}

.draft-warning {
  color: var(--ayame-primary, #a99aca);
}

.workspace-link-notice {
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  margin: 0.5rem;
}

.workspace-link-notice-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

.workspace-link-notice-actions {
  display: flex;
  gap: 0.35rem;
}

.workspace-link-candidates {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-top: 0.5rem;
}
</style>
