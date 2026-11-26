<script setup>
import { ref, shallowRef, computed, watch, nextTick, onMounted, onUnmounted, toRaw, inject } from 'vue'
import * as vaultApi from './api.js'
import { noteCacheKey } from './noteCache.js'
import { loadVaultNavigation, saveVaultNavigation } from './vaultNavigationStorage.js'
import { createVaultIndexBuilder } from './vaultIndexBuilder.js'
import {
  resolveLink,
  resolvePendingLinkCreationTarget,
  formatInternalLink,
} from '../markdown/links.js'
import { buildInitialNoteContent } from '../markdown/properties.js'
import {
  buildVaultIndex,
  getBacklinksForNote,
  getOutgoingLinksForNote,
  getNotesByTag,
  searchVaultNotes,
} from './vaultIndex.js'
import { calculateContextMenuPosition } from './contextMenuPosition.js'
import { useAyameRouter, validateNoteQueryParam } from '../router/index.js'
import { buildGraphModel } from './graphModel.js'
import { projectGraphView } from './graphSelection.js'
import {
  normalizeGraphSettings,
  loadGraphSettings,
  saveGraphSettings,
  updateGraphViewSettings,
  resetGraphViewSettings,
  resetGraphGroups,
  evaluateGraphGroups,
} from './graphSettings.js'
import MarkdownViewer from '../markdown/MarkdownViewer.vue'
import GraphView from './GraphView.vue'
import WorkspaceTopbar from './workspace/WorkspaceTopbar.vue'
import WorkspaceExplorer from './workspace/WorkspaceExplorer.vue'
import WorkspaceContextPanel from './workspace/WorkspaceContextPanel.vue'
import WorkspaceEmptyState from './workspace/WorkspaceEmptyState.vue'
import WorkspaceContextMenu from './workspace/WorkspaceContextMenu.vue'
import WorkspaceToasts from './workspace/WorkspaceToasts.vue'
import TrashModal from './workspace/TrashModal.vue'
import CommandPaletteModal from './workspace/CommandPaletteModal.vue'
import QuickSwitcherModal from './workspace/QuickSwitcherModal.vue'
import VaultSettingsModal from './workspace/VaultSettingsModal.vue'

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

const emit = defineEmits(['back', 'unauthorized', 'state', 'logout', 'open-account'])
const noteCache = inject(noteCacheKey, null)

const { router, route } = useAyameRouter({
  initialVaultDirectory: props.vault.directory,
})

const layoutStorageKey = (directory = props.vault.directory) => `ayame:layout:${directory}`

const EXPLORER_MIN_WIDTH = 250
const EXPLORER_MAX_WIDTH = 480
const EXPLORER_DEFAULT_WIDTH = 260

const loadSavedLayout = (directory = props.vault.directory) => {
  try {
    const raw = localStorage.getItem(layoutStorageKey(directory))
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        explorerOpen: true,
        explorerWidth:
          typeof parsed.explorerWidth === 'number'
            ? Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, parsed.explorerWidth))
            : EXPLORER_DEFAULT_WIDTH,
        contextOpen: typeof parsed.contextOpen === 'boolean' ? parsed.contextOpen : false,
        contextWidth: typeof parsed.contextWidth === 'number' ? Math.max(200, Math.min(480, parsed.contextWidth)) : 280,
      }
    }
  } catch {}
  return {
    explorerOpen: true,
    explorerWidth: EXPLORER_DEFAULT_WIDTH,
    contextOpen: false,
    contextWidth: 280,
  }
}

const layout = ref(loadSavedLayout())

const persistLayout = () => {
  try {
    localStorage.setItem(layoutStorageKey(), JSON.stringify(layout.value))
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
    const maxW = Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, containerWidth - contextW - 420))
    const newW = Math.max(EXPLORER_MIN_WIDTH, Math.min(maxW, dragStartWidth + delta))
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
  const maxW = Math.max(EXPLORER_MIN_WIDTH, Math.min(EXPLORER_MAX_WIDTH, containerWidth - contextW - 420))
  if (event.key === 'ArrowRight') {
    event.preventDefault()
    layout.value.explorerWidth = Math.min(maxW, layout.value.explorerWidth + step)
    persistLayout()
  } else if (event.key === 'ArrowLeft') {
    event.preventDefault()
    layout.value.explorerWidth = Math.max(EXPLORER_MIN_WIDTH, layout.value.explorerWidth - step)
    persistLayout()
  } else if (event.key === 'Home') {
    event.preventDefault()
    layout.value.explorerWidth = EXPLORER_MIN_WIDTH
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
const explorerRef = ref(null)
const contextPanelRef = ref(null)
const commandPaletteRef = ref(null)
const quickSwitcherRef = ref(null)

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
const graphTabOpen = ref(false)
const activeWorkspaceView = ref('note') // 'note' | 'graph'
const navHistory = ref([])
const navHistoryIndex = ref(-1)
let navigatingHistory = false
let lastReplacedTab = null
let selectionGeneration = 0
let initialIndexPending = false
let initialRootReady = false
let initialNoteReady = null

// Vault Index
const vaultIndexData = shallowRef(
  buildVaultIndex({ directory: '', complete: false, folders: [], files: [], notes: [] })
)
const indexBuilder = createVaultIndexBuilder()
const indexLoading = ref(false)
const indexError = ref(false)
let indexCanSupplyNotes = false
const openedNotePaths = new Set()

const takeIndexedDocument = (directory, path, useSnapshot) => {
  if (directory !== props.vault.directory || openedNotePaths.has(path)) return null
  openedNotePaths.add(path)
  if (!useSnapshot || !indexCanSupplyNotes || vaultIndexData.value.directory !== directory) return null
  const note = vaultIndexData.value.notesByPath[path]
  if (typeof note?.content !== 'string' || !/^[a-f0-9]{64}$/.test(note.revision)) return null
  return { content: note.content, revision: note.revision }
}
const graphModel = computed(() => buildGraphModel(vaultIndexData.value))
const globalGraphRef = ref(null)
const initialGraphLoad = loadGraphSettings(props.vault.directory)
const graphSettings = ref(initialGraphLoad.settings)
const graphStorageWarning = ref(initialGraphLoad.error || '')

const commitGraphSettings = (nextSettings) => {
  const saved = saveGraphSettings(props.vault.directory, nextSettings)
  graphSettings.value = saved.settings
  graphStorageWarning.value = saved.ok ? '' : saved.error || 'Could not save graph settings.'
}

const handleUpdateGraphView = (patch) => {
  commitGraphSettings(updateGraphViewSettings(graphSettings.value, patch))
}

const handleUpdateGraphGroups = (nextGroups) => {
  commitGraphSettings(
    normalizeGraphSettings({
      ...graphSettings.value,
      groups: nextGroups,
    })
  )
}

const handleRestoreGraphDefaults = () => {
  commitGraphSettings(resetGraphViewSettings(graphSettings.value))
}

const handleResetGraphGroups = () => {
  commitGraphSettings(resetGraphGroups(graphSettings.value))
}

const globalGraphView = computed(() =>
  projectGraphView({
    baseGraph: graphModel.value,
    vaultIndex: vaultIndexData.value,
    filters: graphSettings.value.global.filters,
  })
)

const globalGroupEvaluation = computed(() =>
  evaluateGraphGroups(
    graphSettings.value.groups,
    globalGraphView.value.nodes,
    vaultIndexData.value.tagsByFile
  )
)

// Vault Settings & Modals
const VAULT_SETTINGS_KEY_PREFIX = 'ayame:vault-settings:'
const BOOKMARKS_KEY_PREFIX = 'ayame:bookmarks:'

const DEFAULT_VAULT_SETTINGS = {
  newNoteLocation: 'root',
  newNoteFolder: '',
  linkFormat: 'shortest',
  useWikilinks: true,
  autoUpdateLinks: true,
  deleteBehavior: 'trash',
  defaultFrontmatterOnCreate: false,
  showUnsupportedFiles: false,
  dailyNotesFolder: '',
}

const loadSavedVaultSettings = (directory) => {
  if (!directory) return { ...DEFAULT_VAULT_SETTINGS }
  try {
    const raw = localStorage.getItem(`${VAULT_SETTINGS_KEY_PREFIX}${directory}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object') {
        return {
          ...DEFAULT_VAULT_SETTINGS,
          newNoteLocation: ['root', 'current', 'folder'].includes(parsed.newNoteLocation)
            ? parsed.newNoteLocation
            : DEFAULT_VAULT_SETTINGS.newNoteLocation,
          newNoteFolder: typeof parsed.newNoteFolder === 'string' ? parsed.newNoteFolder : '',
          linkFormat:
            typeof parsed.linkFormat === 'string'
              ? parsed.linkFormat
              : DEFAULT_VAULT_SETTINGS.linkFormat,
          useWikilinks:
            typeof parsed.useWikilinks === 'boolean'
              ? parsed.useWikilinks
              : DEFAULT_VAULT_SETTINGS.useWikilinks,
          autoUpdateLinks:
            typeof parsed.autoUpdateLinks === 'boolean'
              ? parsed.autoUpdateLinks
              : DEFAULT_VAULT_SETTINGS.autoUpdateLinks,
          deleteBehavior: ['trash', 'permanent'].includes(parsed.deleteBehavior)
            ? parsed.deleteBehavior
            : DEFAULT_VAULT_SETTINGS.deleteBehavior,
          defaultFrontmatterOnCreate:
            typeof parsed.defaultFrontmatterOnCreate === 'boolean'
              ? parsed.defaultFrontmatterOnCreate
              : DEFAULT_VAULT_SETTINGS.defaultFrontmatterOnCreate,
          showUnsupportedFiles:
            typeof parsed.showUnsupportedFiles === 'boolean'
              ? parsed.showUnsupportedFiles
              : DEFAULT_VAULT_SETTINGS.showUnsupportedFiles,
          dailyNotesFolder:
            typeof parsed.dailyNotesFolder === 'string' ? parsed.dailyNotesFolder : '',
        }
      }
    }
  } catch {}
  return { ...DEFAULT_VAULT_SETTINGS }
}

const persistVaultSettings = () => {
  const dir = props.vault?.directory
  if (!dir) return
  try {
    localStorage.setItem(`${VAULT_SETTINGS_KEY_PREFIX}${dir}`, JSON.stringify(vaultSettings.value))
  } catch {}
}

const loadSavedBookmarks = (directory) => {
  if (!directory) return []
  try {
    const raw = localStorage.getItem(`${BOOKMARKS_KEY_PREFIX}${directory}`)
    if (raw) {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        return Array.from(new Set(parsed.filter((p) => typeof p === 'string' && p.length > 0)))
      }
    }
  } catch {}
  return []
}

const vaultSettings = ref(loadSavedVaultSettings(props.vault.directory))
const bookmarkedPaths = ref(loadSavedBookmarks(props.vault.directory))
const bookmarksExpanded = ref(true)

const persistBookmarks = () => {
  const dir = props.vault?.directory
  if (!dir) return
  try {
    const key = `${BOOKMARKS_KEY_PREFIX}${dir}`
    if (bookmarkedPaths.value.length === 0) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, JSON.stringify(bookmarkedPaths.value))
    }
  } catch {}
}

const isBookmarked = (filePath) => Boolean(filePath && bookmarkedPaths.value.includes(filePath))

const toggleBookmark = (filePath) => {
  if (!filePath) return
  if (isBookmarked(filePath)) {
    bookmarkedPaths.value = bookmarkedPaths.value.filter((p) => p !== filePath)
  } else {
    bookmarkedPaths.value = [...bookmarkedPaths.value, filePath]
  }
  persistBookmarks()
}

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
const commandPaletteInputRef = ref(null)
const commandPaletteActiveIndex = ref(0)
const showQuickSwitcher = ref(false)
const quickSwitcherQuery = ref('')
const quickSwitcherInputRef = ref(null)
const quickSwitcherActiveIndex = ref(0)

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
let activeIndexFetchGeneration = null
let activeIndexFetchDirectory = ''
const pendingSavedNotesForFetch = new Map()
let savedNotesVersion = 0
const queuedIndexSaves = new Map()
let buildingSavedNotes = false
let isMounted = true

const clearActiveIndexFetch = () => {
  activeIndexFetchGeneration = null
  activeIndexFetchDirectory = ''
  pendingSavedNotesForFetch.clear()
  indexLoading.value = false
}

const invalidateVaultIndexRequest = () => {
  indexCanSupplyNotes = false
  indexRequestGeneration++
  clearActiveIndexFetch()
  queuedIndexSaves.clear()
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

const linkedBacklinks = computed(() => vaultIndexData.value.backlinksByFile[selectedFile.value] ?? [])
const activeBacklinks = computed(() =>
  selectedFile.value && layout.value.contextOpen && rightPanelTab.value === 'backlinks'
    ? getBacklinksForNote(vaultIndexData.value, selectedFile.value)
    : { linked: linkedBacklinks.value, unlinkedMentions: [] }
)

const activeOutgoingLinks = computed(() =>
  selectedFile.value
    ? getOutgoingLinksForNote(vaultIndexData.value, selectedFile.value)
    : { resolved: [], unresolved: [] }
)

const RIGHT_PANEL_TAB_ORDER = ['backlinks', 'outgoing', 'outline', 'tags', 'search']

const rightPanelTabs = computed(() => [
  { id: 'backlinks', testid: 'panel-tab-backlinks', label: `Backlinks (${linkedBacklinks.value.length})` },
  {
    id: 'outgoing',
    testid: 'panel-tab-outgoing',
    label: `Outgoing (${activeOutgoingLinks.value.resolved.length + activeOutgoingLinks.value.unresolved.length})`,
  },
  { id: 'outline', testid: 'panel-tab-outline', label: 'Outline' },
  { id: 'tags', testid: 'panel-tab-tags', label: 'Tags' },
  { id: 'search', testid: 'panel-tab-search', label: 'Search' },
])

const ensureRightPanelTabVisible = (tabId) => {
  contextPanelRef.value?.ensureTabVisible?.(tabId)
}

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
    { id: 'quick-switcher', label: 'Open quick switcher', run: () => openQuickSwitcherModal() },
    { id: 'daily-note', label: "Open today's daily note", run: () => openTodayDailyNote() },
    { id: 'new-note', label: 'New note', run: () => startCreate('note') },
    { id: 'new-folder', label: 'New folder', run: () => startCreate('folder') },
    { id: 'toggle-explorer', label: 'Toggle file explorer', run: () => { explorerCollapsed.value = !explorerCollapsed.value } },
    { id: 'toggle-right-panel', label: 'Toggle contextual panel', run: () => { rightPanelCollapsed.value = !rightPanelCollapsed.value } },
    { id: 'open-graph', label: 'Open graph view', run: () => openGraphView() },
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

const reconcileIndexWithPendingSaves = (raw, savedNotesMap) => {
  if (!savedNotesMap || savedNotesMap.size === 0) return raw
  const rawNotes = Array.isArray(raw.notes) ? raw.notes : []
  const mergedNotes = rawNotes.filter((n) => n && !savedNotesMap.has(n.path))
  const fileSet = new Set(Array.isArray(raw.files) ? raw.files : [])
  for (const doc of savedNotesMap.values()) {
    fileSet.add(doc.path)
    mergedNotes.push({
      path: doc.path,
      name: doc.name || doc.path.split('/').pop(),
      content: doc.content ?? '',
      revision: doc.revision ?? '',
    })
  }
  return {
    ...raw,
    files: Array.from(fileSet),
    notes: mergedNotes,
  }
}

const fetchVaultIndexSafe = async () => {
  const generation = ++indexRequestGeneration
  const directory = props.vault.directory
  const isCurrent = () =>
    isMounted && generation === indexRequestGeneration && directory === props.vault.directory

  activeIndexFetchGeneration = generation
  activeIndexFetchDirectory = directory
  pendingSavedNotesForFetch.clear()
  indexLoading.value = true

  try {
    if (!('getVaultIndex' in vaultApi) || typeof vaultApi.getVaultIndex !== 'function') {
      if (isCurrent()) {
        clearActiveIndexFetch()
        indexError.value = false
      }
      return false
    }
    const raw = await vaultApi.getVaultIndex(directory)
    if (!isCurrent()) return false
    if (!raw) {
      clearActiveIndexFetch()
      indexError.value = false
      return false
    }
    if (raw.directory !== directory) {
      clearActiveIndexFetch()
      indexError.value = true
      return false
    }
    while (isCurrent()) {
      const version = savedNotesVersion
      const reconciled = reconcileIndexWithPendingSaves(raw, pendingSavedNotesForFetch)
      const index = await indexBuilder.build(reconciled)
      if (!isCurrent()) return false
      if (savedNotesVersion !== version) continue
      for (const [path, note] of pendingSavedNotesForFetch) {
        if (queuedIndexSaves.get(path) === note) queuedIndexSaves.delete(path)
      }
      clearActiveIndexFetch()
      vaultIndexData.value = index
      indexCanSupplyNotes = true
      indexError.value = false
      return true
    }
    return false
  } catch (err) {
    if (!isCurrent()) return false
    clearActiveIndexFetch()
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return false
    }
    indexError.value = true
    return false
  }
}

const retryVaultIndex = async () => {
  if (indexLoading.value) return false
  return fetchVaultIndexSafe()
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
  const generation = directoryRequestGeneration
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
    if (!isMounted || generation !== directoryRequestGeneration) return
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
  const generation = directoryRequestGeneration
  const segments = String(filePath || '').split('/')
  segments.pop()
  if (segments.length === 0) return
  const expanded = []
  let current = ''
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment
    if (!folderEntriesMap.value.has(current)) {
      await fetchDirectory(current)
      if (!isMounted || generation !== directoryRequestGeneration) return
    }
    expanded.push(current)
  }
  expandedFolders.value = new Set([...expandedFolders.value, ...expanded])
}

const revealActiveFile = async () => {
  if (!selectedFile.value) return
  explorerCollapsed.value = false
  await expandAncestors(selectedFile.value)
}

const revealSelectedNote = (filePath) => {
  const generation = directoryRequestGeneration
  void nextTick(() => {
    if (isMounted && generation === directoryRequestGeneration && selectedFile.value === filePath) {
      return expandAncestors(filePath)
    }
  })
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

const openGraphView = () => {
  graphTabOpen.value = true
  activeWorkspaceView.value = 'graph'
}

const closeGraphTab = () => {
  graphTabOpen.value = false
  if (activeWorkspaceView.value === 'graph') {
    activeWorkspaceView.value = 'note'
  }
}

const openNoteFromGraph = async (notePath) => {
  if (!notePath) return
  await selectNote(notePath, { reveal: true })
}

const closeTab = async (tabPath) => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  if (relocateState.value?.stage === 'confirm' && tabPath === selectedFile.value) cancelRelocate()
  if (selectedFile.value === tabPath) {
    const wasViewingGraph = activeWorkspaceView.value === 'graph'
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
      await selectNote(nextTabs[nextTabs.length - 1], { activateView: !wasViewingGraph })
    } else {
      await closeNote()
      if (graphTabOpen.value && selectedFile.value === null) {
        activeWorkspaceView.value = 'graph'
      }
    }
  } else {
    openTabs.value = openTabs.value.filter((t) => t !== tabPath)
  }
}

const openFileInNewTab = async (filePath) => {
  closeContextMenu()
  await selectNote(filePath, { newTab: true })
}

const selectNote = async (
  filePath,
  { anchor = null, initialDoc = null, newTab = false, activateView = true, fromDoubleClick = false, reveal = false } = {}
) => {
  const selection = ++selectionGeneration
  const directory = props.vault.directory
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') {
    workspaceNotice.value = 'Wait for the move to be reconciled before navigating.'
    return
  }
  if (relocateState.value?.stage === 'confirm' && filePath !== selectedFile.value) {
    cancelRelocate()
  }
  linkNotice.value = null
  if (selectedFile.value === filePath) {
    if (
      fromDoubleClick &&
      newTab &&
      lastReplacedTab &&
      lastReplacedTab.byPath === filePath &&
      Date.now() - lastReplacedTab.timestamp < 700
    ) {
      const { replacedPath, atIndex } = lastReplacedTab
      lastReplacedTab = null
      if (replacedPath && !openTabs.value.includes(replacedPath)) {
        const next = [...openTabs.value]
        const insertAt = Math.max(0, Math.min(atIndex, next.length))
        next.splice(insertAt, 0, replacedPath)
        openTabs.value = next
      }
    }
    if (activateView) {
      activeWorkspaceView.value = 'note'
    }
    if (anchor) {
      selectedAnchor.value = anchor
    }
    if (reveal) revealSelectedNote(filePath)
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
    if (!isMounted || selection !== selectionGeneration || directory !== props.vault.directory) return
    if (isNavigationBlocked()) {
      pendingNavigation.value = { type: 'file', path: filePath, anchor, initialDoc, newTab, reveal }
      return
    }
  }

  pendingNavigation.value = null
  if (activateView) {
    activeWorkspaceView.value = 'note'
  }
  initialDocument.value = initialDoc
  selectedAnchor.value = anchor
  const prevActive = selectedFile.value
  selectedFile.value = filePath

  // Tab management: normal click reuses active tab; explicit newTab appends
  if (newTab || openTabs.value.length === 0) {
    lastReplacedTab = null
    if (!openTabs.value.includes(filePath)) {
      openTabs.value = [...openTabs.value, filePath]
    }
  } else {
    // Reusable tab
    if (!openTabs.value.includes(filePath)) {
      const activeIdx = prevActive ? openTabs.value.indexOf(prevActive) : -1
      if (activeIdx >= 0) {
        lastReplacedTab = {
          replacedPath: prevActive,
          byPath: filePath,
          atIndex: activeIdx,
          timestamp: Date.now(),
        }
        const next = [...openTabs.value]
        next[activeIdx] = filePath
        openTabs.value = next
      } else {
        lastReplacedTab = null
        openTabs.value = [...openTabs.value, filePath]
      }
    } else {
      lastReplacedTab = null
    }
  }

  recordNavigationHistory(filePath)
  const parentSegments = filePath.split('/')
  parentSegments.pop()
  selectedFolderPath.value = parentSegments.join('/')
  if (reveal) revealSelectedNote(filePath)
  await syncUrlWithNote(filePath)
}

const openFile = async (entry, { newTab = false, fromDoubleClick = false } = {}) => {
  if (!entry || entry.type !== 'file' || !isMarkdownFile(entry.name)) return
  await selectNote(entry.path, { newTab, fromDoubleClick })
}

const closeNote = async () => {
  if (relocateState.value?.loading || relocateState.value?.stage === 'uncertain') return
  if (relocateState.value?.stage === 'confirm') cancelRelocate()
  if (isNavigationBlocked()) {
    pendingNavigation.value = { type: 'close-note' }
    return
  }
  selectionGeneration++
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
      reveal: target.reveal,
    })
  }
}

const handleNoteNotFound = async (missingPath) => {
  if (!missingPath || selectedFile.value !== missingPath) return
  selectionGeneration++
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

const applyRouteFromUrl = async ({ isInitial = false, restorePath = null } = {}) => {
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
  if (!check.present && !restorePath) {
    if (selectedFile.value !== null) {
      selectionGeneration++
      pendingNavigation.value = null
      activeWorkspaceView.value = 'note'
      selectedFile.value = null
      selectedAnchor.value = null
      initialDocument.value = null
      viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
      emit('state', viewerState.value)
    }
    return
  }

  if (check.present && !check.valid) {
    selectionGeneration++
    pendingNavigation.value = null
    activeWorkspaceView.value = 'note'
    selectedFile.value = null
    selectedAnchor.value = null
    initialDocument.value = null
    viewerState.value = { dirty: false, saving: false, reloading: false, saveState: 'saved' }
    emit('state', viewerState.value)
    workspaceNotice.value = 'Invalid note path in URL.'
    await syncUrlWithNote(null, { replace: true })
    return
  }

  const notePath = check.path ?? restorePath
  if (selectedFile.value === notePath) {
    return
  }

  selectionGeneration++
  pendingNavigation.value = null
  activeWorkspaceView.value = 'note'
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
  if (restorePath && !check.present) void syncUrlWithNote(notePath, { replace: true })
  revealSelectedNote(notePath)
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

const applySavedNotesToIndex = async () => {
  if (buildingSavedNotes) return
  buildingSavedNotes = true
  try {
    while (isMounted && queuedIndexSaves.size) {
      const generation = indexRequestGeneration
      const base = vaultIndexData.value
      const changes = new Map(queuedIndexSaves)
      const { directory, complete, failures, folders, files, rawNotes: notes } = base
      const raw = reconcileIndexWithPendingSaves({ directory, complete, failures, folders, files, notes }, changes)
      const index = await indexBuilder.build(raw)
      if (!isMounted || generation !== indexRequestGeneration || base !== vaultIndexData.value) continue
      vaultIndexData.value = index
      for (const [path, note] of changes) {
        if (queuedIndexSaves.get(path) === note) queuedIndexSaves.delete(path)
      }
    }
  } catch {
    if (isMounted) indexError.value = true
  } finally {
    buildingSavedNotes = false
  }
}

const handleContentSaved = (savedDoc) => {
  if (!savedDoc?.path) return
  const note = { ...savedDoc }
  queuedIndexSaves.set(note.path, note)
  if (
    activeIndexFetchGeneration !== null &&
    activeIndexFetchGeneration === indexRequestGeneration &&
    activeIndexFetchDirectory === props.vault.directory
  ) {
    pendingSavedNotesForFetch.set(note.path, note)
    savedNotesVersion++
  }
  void applySavedNotesToIndex()
}

const handleOpenLink = async (linkPayload) => {
  linkNotice.value = null
  if (!linkPayload) return

  let resolved = linkPayload
  const rawTarget = linkPayload.rawTarget || linkPayload.target || ''
  const sourcePath = selectedFile.value || ''
  const folderOf = (path) => path.slice(0, path.lastIndexOf('/') + 1)
  const knownLocalTarget = resolved.type === 'resolved' && resolved.path &&
    folderOf(resolved.path) === folderOf(sourcePath)

  if (
    rawTarget &&
    (resolved.type === 'missing' ||
      resolved.type === 'unverified' ||
      (linkPayload.kind === 'wikilink' && !rawTarget.includes('/')))
  ) {
    if (!knownLocalTarget && !vaultIndexData.value.complete) {
      const selection = ++selectionGeneration
      await discoverUnloadedFolders()
      if (!isMounted || selection !== selectionGeneration) return
    }
    resolved = resolveLink({
      sourcePath,
      linkTarget: rawTarget,
      knownFiles: knownMarkdownFiles.value,
      aliasesByFile: vaultIndexData.value.aliasesByFile,
      indexComplete: !(vaultIndexData.value.failures && vaultIndexData.value.failures.length > 0),
      kind: linkPayload.kind || 'wikilink',
    })
  }

  if (resolved.type === 'resolved' && resolved.path) {
    await selectNote(resolved.path, { anchor: resolved.anchor || null, reveal: true })
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
    linkNotice.value = null
    handleContentSaved({
      path: created.path,
      name: created.path.split('/').pop(),
      content: initialContent || '',
      revision: created.revision,
    })
    await selectNote(created.path, {
      anchor: target.anchor || null,
      reveal: true,
      initialDoc: {
        path: created.path,
        content: initialContent || '',
        revision: created.revision,
      },
    })
    if (!isMounted || directory !== props.vault.directory) return false
    const folders = target.parentPath ? ['', target.parentPath] : ['']
    await Promise.all(folders.map((folder) => fetchDirectory(folder)))
    if (isMounted && directory === props.vault.directory) void fetchVaultIndexSafe()
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
  await selectNote(candidatePath, { anchor, reveal: true })
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
  explorerRef.value?.focusCreateInput?.()
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
      createMode.value = null
      newEntryName.value = ''
      handleContentSaved({
        path: created.path,
        name: created.path.split('/').pop(),
        content: initialContent,
        revision: created.revision,
      })
      await selectNote(created.path, {
        reveal: true,
        initialDoc: {
          path: created.path,
          content: initialContent,
          revision: created.revision,
        },
      })
      if (!isMounted || directory !== props.vault.directory) return
      await fetchDirectory(parentPath)
      if (isMounted && directory === props.vault.directory) void fetchVaultIndexSafe()
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
  explorerRef.value?.focusRelocateInput?.()
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
    noteCache?.invalidate(operation.vaultDirectory)
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
  noteCache?.invalidate(props.vault.directory, sourcePath)
  noteCache?.invalidate(props.vault.directory, newPath)
  const remapPath = (filePath) => {
    if (!filePath) return filePath
    if (filePath === sourcePath) return newPath
    if (filePath.startsWith(`${sourcePath}/`)) return `${newPath}/${filePath.slice(sourcePath.length + 1)}`
    return filePath
  }
  const previousSelected = selectedFile.value
  openTabs.value = openTabs.value.map(remapPath)
  navHistory.value = navHistory.value.map(remapPath)
  const nextBookmarks = Array.from(new Set(bookmarkedPaths.value.map(remapPath)))
  if (
    nextBookmarks.length !== bookmarkedPaths.value.length ||
    nextBookmarks.some((p, idx) => p !== bookmarkedPaths.value[idx])
  ) {
    bookmarkedPaths.value = nextBookmarks
    persistBookmarks()
  }
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
    for (const path of [...(res.updatedFiles ?? []), ...(res.failedFiles ?? [])]) {
      noteCache?.invalidate(directory, path)
    }
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
  noteCache?.invalidate(props.vault.directory, deletedPath)
  const isDeletedOrInside = (p) => p === deletedPath || p.startsWith(`${deletedPath}/`)
  const previousSelected = selectedFile.value
  openTabs.value = openTabs.value.filter((t) => !isDeletedOrInside(t))
  navHistory.value = navHistory.value.filter((p) => !isDeletedOrInside(p))
  const nextBookmarks = bookmarkedPaths.value.filter((p) => !isDeletedOrInside(p))
  if (nextBookmarks.length !== bookmarkedPaths.value.length) {
    bookmarkedPaths.value = nextBookmarks
    persistBookmarks()
  }
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
    noteCache?.invalidate(directory, targetPath)
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
    noteCache?.invalidate(directory, res.path)
    invalidateVaultIndexRequest()
    trashItems.value = trashItems.value.filter((i) => i.id !== item.id)
    trashRestoreConflict.value = null
    if (res.type === 'file' && isMarkdownFile(res.path)) {
      await selectNote(res.path, { reveal: true })
    }
    await refreshWorkspace()
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

// Daily Notes, Attachments & Command Palette / Quick Switcher
const getLocalIsoDate = (date = new Date()) => {
  const yyyy = String(date.getFullYear()).padStart(4, '0')
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd}`
}

const sanitizeDailyFolder = (rawFolder) => {
  const trimmed = String(rawFolder || '').trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('\\')) return ''
  const parts = trimmed.split('/').filter(Boolean)
  if (parts.some((p) => p === '.' || p === '..')) return ''
  return parts.join('/')
}

const openTodayDailyNote = async () => {
  const directory = props.vault.directory
  const dateStr = getLocalIsoDate()
  const folder = sanitizeDailyFolder(vaultSettings.value.dailyNotesFolder)
  const targetPath = folder ? `${folder}/${dateStr}.md` : `${dateStr}.md`

  const existing = knownMarkdownFiles.value.find(
    (f) => f.toLowerCase() === targetPath.toLowerCase()
  )
  if (existing) {
    await selectNote(existing, { reveal: true })
    return
  }

  if (!('createVaultNote' in vaultApi) || typeof vaultApi.createVaultNote !== 'function') {
    return
  }

  const initialContent = `# ${dateStr}\n\n`
  try {
    const created = await vaultApi.createVaultNote(directory, {
      path: targetPath,
      content: initialContent,
      createParents: Boolean(folder),
    })
    if (!isMounted || directory !== props.vault.directory) return
    const notePath = created?.path || targetPath
    invalidateVaultIndexRequest()
    handleContentSaved({
      path: notePath,
      name: notePath.split('/').pop(),
      content: initialContent,
      revision: created?.revision || '',
    })
    await selectNote(notePath, {
      reveal: true,
      initialDoc: {
        path: notePath,
        content: initialContent,
        revision: created?.revision,
      },
    })
    if (!isMounted || directory !== props.vault.directory) return
    const folders = folder ? ['', folder] : ['']
    await Promise.all(folders.map((folderPath) => fetchDirectory(folderPath)))
    if (isMounted && directory === props.vault.directory) void fetchVaultIndexSafe()
  } catch (err) {
    if (!isMounted) return
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    if (err?.code === 'VAULT_ENTRY_EXISTS') {
      await selectNote(targetPath, { reveal: true })
      return
    }
    addToast(err?.message || 'Could not open daily note.', 'error')
  }
}

const handleAttachmentUploaded = async (uploaded) => {
  if (!uploaded?.path) return
  if (!vaultIndexData.value.files.includes(uploaded.path)) {
    vaultIndexData.value = {
      ...vaultIndexData.value,
      files: [...vaultIndexData.value.files, uploaded.path].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' })
      ),
    }
  }
  const folder = uploaded.path.includes('/')
    ? uploaded.path.slice(0, uploaded.path.lastIndexOf('/'))
    : ''
  if (folder === '' || folderEntriesMap.value.has(folder)) {
    await fetchDirectory(folder)
  }
  void fetchVaultIndexSafe()
}

const startInitialIndex = () => {
  if (!initialIndexPending || !initialRootReady) return
  if (selectedFile.value && initialNoteReady !== selectedFile.value) return
  initialIndexPending = false
  if (!indexLoading.value) void fetchVaultIndexSafe()
}

const handleInitialNoteReady = () => {
  initialNoteReady = selectedFile.value
  startInitialIndex()
}

const startVaultWorkspace = async () => {
  const generation = directoryRequestGeneration
  const directory = props.vault.directory
  initialIndexPending = true
  initialRootReady = false
  initialNoteReady = null
  const navigation = noteCache ? loadVaultNavigation(directory) : { tabs: [], active: null }
  openTabs.value = navigation.tabs
  const root = fetchDirectory('')
  await applyRouteFromUrl({ isInitial: true, restorePath: navigation.active })
  await root
  if (!isMounted || generation !== directoryRequestGeneration || directory !== props.vault.directory) return
  initialRootReady = true
  startInitialIndex()
}

const openCommandPaletteModal = () => {
  commandPaletteQuery.value = ''
  commandPaletteActiveIndex.value = 0
  showCommandPalette.value = true
  void nextTick(() => {
    commandPaletteRef.value?.focusInput?.()
  })
}

const openQuickSwitcherModal = () => {
  quickSwitcherQuery.value = ''
  quickSwitcherActiveIndex.value = 0
  showQuickSwitcher.value = true
  void nextTick(() => {
    quickSwitcherRef.value?.focusInput?.()
  })
}

const canCreateFromQuickSwitcher = computed(() => {
  const q = quickSwitcherQuery.value.trim()
  if (!q) return false
  return !quickSwitcherResults.value.some((f) => f.toLowerCase() === `${q.toLowerCase()}.md`)
})

const handleCommandPaletteKeydown = (event) => {
  const items = commandPaletteItems.value
  if (items.length === 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    commandPaletteActiveIndex.value = (commandPaletteActiveIndex.value + 1) % items.length
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    commandPaletteActiveIndex.value = (commandPaletteActiveIndex.value - 1 + items.length) % items.length
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const item = items[commandPaletteActiveIndex.value] || items[0]
    if (item) {
      showCommandPalette.value = false
      item.run()
    }
  }
}

const handleQuickSwitcherKeydown = (event) => {
  const results = quickSwitcherResults.value
  const total = results.length + (canCreateFromQuickSwitcher.value ? 1 : 0)
  if (total === 0) return
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    quickSwitcherActiveIndex.value = (quickSwitcherActiveIndex.value + 1) % total
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    quickSwitcherActiveIndex.value = (quickSwitcherActiveIndex.value - 1 + total) % total
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const idx = quickSwitcherActiveIndex.value
    if (idx < results.length) {
      const target = results[idx]
      showQuickSwitcher.value = false
      void openCandidateLink(target)
    } else if (canCreateFromQuickSwitcher.value) {
      const q = quickSwitcherQuery.value.trim()
      showQuickSwitcher.value = false
      void createNoteFromPendingLink(`[[${q}]]`, 'wikilink')
    }
  }
}

watch(commandPaletteQuery, () => {
  commandPaletteActiveIndex.value = 0
})

watch(quickSwitcherQuery, () => {
  quickSwitcherActiveIndex.value = 0
})

watch([openTabs, selectedFile], () => {
  if (noteCache) saveVaultNavigation(props.vault.directory, openTabs.value, selectedFile.value)
  startInitialIndex()
})

const handleGlobalKeydown = (event) => {
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.altKey && event.key.toLowerCase() === 'd') {
    event.preventDefault()
    void openTodayDailyNote()
  } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'o') {
    event.preventDefault()
    openQuickSwitcherModal()
  } else if (mod && !event.altKey && event.key.toLowerCase() === 'p') {
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
    selectionGeneration++
    openedNotePaths.clear()
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
    graphTabOpen.value = false
    activeWorkspaceView.value = 'note'
    const loadedGraph = loadGraphSettings(props.vault.directory)
    graphSettings.value = loadedGraph.settings
    graphStorageWarning.value = loadedGraph.error || ''
    vaultSettings.value = loadSavedVaultSettings(props.vault.directory)
    bookmarkedPaths.value = loadSavedBookmarks(props.vault.directory)
    layout.value = loadSavedLayout(props.vault.directory)
    indexLoading.value = false
    indexError.value = false
    navHistory.value = []
    navHistoryIndex.value = -1
    hasLoadedRoot.value = false
    await startVaultWorkspace()
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

watch(
  () => [layout.value.contextOpen, rightPanelTab.value, activeWorkspaceView.value, layout.value.contextWidth],
  async ([contextOpen, panelTab, wsView]) => {
    await nextTick()
    if (contextOpen) {
      ensureRightPanelTabVisible(panelTab)
    }
    if (wsView === 'graph' && graphTabOpen.value) {
      globalGraphRef.value?.updateCanvasSize?.()
    }
  }
)

onMounted(() => {
  isMounted = true
  window.addEventListener('keydown', handleGlobalKeydown)
  document.addEventListener('pointerdown', handleDocumentClick)
  window.addEventListener('resize', closeContextMenu)
  void startVaultWorkspace()
})

onUnmounted(() => {
  isMounted = false
  indexBuilder.close()
  selectionGeneration++
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
  <section
    class="vault-browser workspace-shell"
    data-testid="vault-browser"
    :style="{ '--vault-accent': vault.accentColor || undefined }"
  >
    <WorkspaceTopbar
      :vault="vault"
      :explorer-open="layout.explorerOpen"
      :explorer-width="layout.explorerWidth"
      :context-open="layout.contextOpen"
      :show-vault-menu="showVaultMenu"
      :open-tabs="openTabs"
      :graph-tab-open="graphTabOpen"
      :active-workspace-view="activeWorkspaceView"
      :selected-file="selectedFile"
      :loading-root="loadingRoot"
      :refreshing="refreshing"
      :busy-saving="viewerState.saving || viewerState.reloading"
      :logout-disabled="pending || editorSaving || editorReloading || viewerState.saving || viewerState.reloading"
      @update:show-vault-menu="showVaultMenu = $event"
      @toggle-explorer="layout.explorerOpen = !layout.explorerOpen; persistLayout()"
      @toggle-context="layout.contextOpen = !layout.contextOpen; persistLayout()"
      @back-to-vaults="requestBackToVaults"
      @open-settings="showSettingsModal = true"
      @open-trash="openTrashModal"
      @refresh="refreshWorkspace"
      @toggle-readable-line="viewerRef?.toggleReadableLineLength?.()"
      @toggle-properties="viewerRef?.cyclePropertiesMode?.()"
      @open-account="emit('open-account')"
      @logout="emit('logout')"
      @select-note="selectNote"
      @close-tab="closeTab"
      @open-graph="openGraphView"
      @close-graph-tab="closeGraphTab"
      @open-quick-switcher="openQuickSwitcherModal"
      @open-daily-note="openTodayDailyNote"
      @open-command-palette="openCommandPaletteModal"
    />

    <!-- Incomplete index warning banner -->
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
      <WorkspaceExplorer
        ref="explorerRef"
        :explorer-open="layout.explorerOpen"
        :explorer-width="layout.explorerWidth"
        :show-add-menu="showAddMenu"
        :selected-file="selectedFile"
        :selected-folder-path="selectedFolderPath"
        :relocate-state="relocateState"
        :delete-confirm-state="deleteConfirmState"
        :create-error="createError"
        :stale="stale"
        :refreshing="refreshing"
        :bookmarked-paths="bookmarkedPaths"
        :loading-root="loadingRoot"
        :root-error="rootError"
        :create-mode="createMode"
        :new-entry-name="newEntryName"
        :creating="creating"
        :tree-rows="treeRows"
        :dragged-entry="draggedEntry"
        :drop-target="dropTarget"
        :show-unsupported-files="vaultSettings.showUnsupportedFiles"
        @update:show-add-menu="showAddMenu = $event"
        @update:new-entry-name="newEntryName = $event"
        @empty-contextmenu="openEmptyAreaContextMenu"
        @reveal-active-file="revealActiveFile"
        @start-create="startCreate"
        @open-daily-note="openTodayDailyNote"
        @cancel-relocate="cancelRelocate"
        @confirm-relocate="confirmRelocate"
        @submit-relocate="submitRelocateForm"
        @refresh="refreshWorkspace"
        @confirm-delete="confirmDeleteEntry"
        @cancel-delete="deleteConfirmState = null"
        @select-note="selectNote"
        @toggle-bookmark="toggleBookmark"
        @drag-over-folder="handleDragOverFolder"
        @drag-over-file="handleDragOverFile"
        @drag-leave-target="handleDragLeaveTarget"
        @drop-on-folder="handleDropOnFolder"
        @drag-start="handleDragStart"
        @drag-end="clearDragState"
        @retry-root="fetchDirectory('')"
        @submit-create="submitCreate"
        @cancel-create="cancelCreate"
        @open-contextmenu="openContextMenu"
        @toggle-folder="toggleFolder"
        @open-file="openFile"
      />

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
        :aria-valuemin="EXPLORER_MIN_WIDTH"
        :aria-valuemax="EXPLORER_MAX_WIDTH"
        @pointerdown="handleExplorerPointerDown"
        @keydown="handleExplorerSplitterKey"
      />

      <!-- Main Editor Pane -->
      <main class="workspace-editor-pane" data-testid="workspace-editor-pane">
        <!-- Pending Link Notice -->
        <div
          v-if="linkNotice && activeWorkspaceView === 'note'"
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
          v-show="activeWorkspaceView === 'note'"
          ref="viewerRef"
          :directory="vault.directory"
          :path="selectedFile"
          :vault-name="vault.name"
          :accent-color="vault.accentColor || ''"
          :bookmarked="isBookmarked(selectedFile)"
          :backlink-count="linkedBacklinks.length"
          :known-files="knownMarkdownFiles"
          :aliases-by-file="vaultIndexData.aliasesByFile"
          :index-complete="vaultIndexData.complete"
          :known-property-names="vaultIndexData.knownPropertyNames"
          :known-property-types="vaultIndexData.knownPropertyTypes"
          :all-files="vaultIndexData.files"
          :known-tags="vaultIndexData.allTags.map((t) => t.tag)"
          :anchor="selectedAnchor"
          :initial-document="initialDocument"
          :take-indexed-document="takeIndexedDocument"
          :relocating="Boolean(relocateState?.affectedDocumentPath && (relocateState.stage === 'confirm' || relocateState.loading || relocateState.stage === 'uncertain'))"
          @back="closeNote"
          @state="handleViewerState"
          @open-link="handleOpenLink"
          @select-tag="handleSelectTag"
          @rename-note="handleRenameFromNoteTitle"
          @content-saved="handleContentSaved"
          @content-ready="handleInitialNoteReady"
          @attachment-uploaded="handleAttachmentUploaded"
          @toggle-bookmark="selectedFile && toggleBookmark(selectedFile)"
          @open-backlinks="layout.contextOpen = true; rightPanelTab = 'backlinks'; persistLayout()"
          @reveal-in-explorer="revealActiveFile"
          @not-found="handleNoteNotFound"
          @unauthorized="emit('unauthorized')"
        />

        <!-- Global Graph View Surface -->
        <GraphView
          v-if="graphTabOpen"
          v-show="activeWorkspaceView === 'graph'"
          ref="globalGraphRef"
          :graph="globalGraphView"
          :vault-directory="vault.directory"
          :loading="indexLoading"
          :error="indexError"
          :active-note-path="selectedFile"
          :filters="graphSettings.global.filters"
          :groups="graphSettings.groups"
          :group-colors="globalGroupEvaluation.colorsByNodeId"
          :group-errors="globalGroupEvaluation.errorsByGroupId"
          :display="graphSettings.global.display"
          :forces="graphSettings.global.forces"
          :storage-warning="graphStorageWarning"
          @open-note="openNoteFromGraph"
          @retry="retryVaultIndex"
          @update:filters="handleUpdateGraphView({ filters: $event })"
          @update:groups="handleUpdateGraphGroups"
          @update:display="handleUpdateGraphView({ display: $event })"
          @update:forces="handleUpdateGraphView({ forces: $event })"
          @restore-defaults="handleRestoreGraphDefaults()"
          @reset-groups="handleResetGraphGroups"
        />

        <WorkspaceEmptyState
          v-if="selectedFile === null && activeWorkspaceView === 'note'"
          :vault-name="vault.name"
          :known-markdown-files="knownMarkdownFiles"
          :tags-count="vaultIndexData.allTags.length"
          @create-note="startCreate('note')"
          @daily-note="openTodayDailyNote"
          @quick-switcher="openQuickSwitcherModal"
          @open-graph="openGraphView"
          @select-note="selectNote"
        />
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

      <WorkspaceContextPanel
        ref="contextPanelRef"
        :context-open="layout.contextOpen"
        :context-width="layout.contextWidth"
        :tabs="rightPanelTabs"
        :active-tab="rightPanelTab"
        :backlinks="activeBacklinks"
        :outgoing-links="activeOutgoingLinks"
        :outline="activeOutline"
        :all-tags="vaultIndexData.allTags"
        :active-tag-filter="activeTagFilter"
        :filtered-tag-notes="filteredTagNotes"
        :search-query="searchQuery"
        :search-results="searchResults"
        @update:active-tab="rightPanelTab = $event"
        @update:active-tag-filter="activeTagFilter = $event"
        @update:search-query="searchQuery = $event"
        @open-note="openCandidateLink"
        @create-missing-link="createNoteFromPendingLink"
        @select-anchor="selectedAnchor = $event"
      />
    </div>

    <WorkspaceContextMenu
      :context-menu="contextMenu"
      :position="contextMenuPos"
      :is-bookmarked="Boolean(contextMenu?.entry && isBookmarked(contextMenu.entry.path))"
      :is-test-env="isTestEnv"
      @create="startCreate"
      @relocate="startRelocate"
      @copy-path="copyRelativePath"
      @copy-link="copyWikilink"
      @delete="requestDeleteEntry"
      @open="(p) => { selectNote(p); closeContextMenu() }"
      @open-new-tab="openFileInNewTab"
      @toggle-bookmark="(p) => { toggleBookmark(p); closeContextMenu() }"
    />

    <WorkspaceToasts
      :workspace-notice="workspaceNotice"
      :toasts="toasts"
      :is-test-env="isTestEnv"
      @dismiss-notice="workspaceNotice = ''"
      @dismiss-toast="removeToast"
    />

    <TrashModal
      v-if="showTrashModal"
      :trash-items="trashItems"
      :trash-loading="trashLoading"
      :trash-error="trashError"
      :trash-restore-conflict="trashRestoreConflict"
      @close="showTrashModal = false"
      @restore="handleRestoreTrashItem"
      @delete-permanently="handleDeleteTrashPermanently"
      @cancel-conflict="trashRestoreConflict = null"
    />

    <CommandPaletteModal
      v-if="showCommandPalette"
      ref="commandPaletteRef"
      :query="commandPaletteQuery"
      :items="commandPaletteItems"
      :active-index="commandPaletteActiveIndex"
      @close="showCommandPalette = false"
      @update:query="commandPaletteQuery = $event"
      @keydown="handleCommandPaletteKeydown"
      @run="(cmd) => { showCommandPalette = false; cmd.run() }"
    />

    <QuickSwitcherModal
      v-if="showQuickSwitcher"
      ref="quickSwitcherRef"
      :query="quickSwitcherQuery"
      :results="quickSwitcherResults"
      :active-index="quickSwitcherActiveIndex"
      :can-create="canCreateFromQuickSwitcher"
      @close="showQuickSwitcher = false"
      @update:query="quickSwitcherQuery = $event"
      @keydown="handleQuickSwitcherKeydown"
      @select="(p) => { showQuickSwitcher = false; openCandidateLink(p) }"
      @create="(q) => { showQuickSwitcher = false; createNoteFromPendingLink(`[[${q}]]`, 'wikilink') }"
    />

    <VaultSettingsModal
      v-if="showSettingsModal"
      :vault="vault"
      :settings="vaultSettings"
      @close="showSettingsModal = false"
      @persist="persistVaultSettings"
    />
  </section>
</template>
