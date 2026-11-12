<script>
export const AUTOSAVE_DELAY_MS = 700

export const PREFERENCES_STORAGE_KEY = 'ayame:editor-preferences'

export function loadEditorPreferences() {
  try {
    const raw = localStorage.getItem(PREFERENCES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw)
      return {
        propertiesInDocument: ['hidden', 'visible', 'source'].includes(parsed.propertiesInDocument)
          ? parsed.propertiesInDocument
          : 'hidden',
        readableLineLength: typeof parsed.readableLineLength === 'boolean'
          ? parsed.readableLineLength
          : true,
        inlineTitle: typeof parsed.inlineTitle === 'boolean'
          ? parsed.inlineTitle
          : true,
      }
    }
  } catch {}
  return {
    propertiesInDocument: 'hidden',
    readableLineLength: true,
    inlineTitle: true,
  }
}

export function saveEditorPreferences(prefs) {
  try {
    localStorage.setItem(PREFERENCES_STORAGE_KEY, JSON.stringify(prefs))
  } catch {}
}
</script>

<script setup>
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import * as vaultApi from '../vaults/api.js'
import { findHeadingOffset } from './links.js'
import { initialMarkdownH1 } from './render.js'
import { parseNoteDocument, splitFrontmatter, updateBodyInMarkdown } from './properties.js'
import MarkdownEditor from './MarkdownEditor.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import NoteContextBar from './components/NoteContextBar.vue'
import NoteAlertBanners from './components/NoteAlertBanners.vue'
import NoteStatusHud from './components/NoteStatusHud.vue'

const { getVaultMarkdown, saveVaultMarkdown, MAX_MARKDOWN_BYTES } = vaultApi
const hasVaultApi = (name) => name in vaultApi && typeof vaultApi[name] === 'function'

const props = defineProps({
  directory: { type: String, required: true },
  path: { type: String, required: true },
  knownFiles: { type: Array, default: () => [] },
  aliasesByFile: { type: Object, default: () => ({}) },
  indexComplete: { type: Boolean, default: true },
  knownPropertyNames: { type: Array, default: () => [] },
  knownPropertyTypes: { type: Object, default: () => ({}) },
  allFiles: { type: Array, default: () => [] },
  knownTags: { type: Array, default: () => [] },
  anchor: { type: String, default: null },
  initialDocument: { type: Object, default: null },
  relocating: { type: Boolean, default: false },
  vaultName: { type: String, default: '' },
  accentColor: { type: String, default: '' },
  bookmarked: { type: Boolean, default: false },
  backlinkCount: { type: Number, default: 0 },
})

const emit = defineEmits([
  'back',
  'unauthorized',
  'state',
  'open-link',
  'select-tag',
  'rename-note',
  'content-saved',
  'not-found',
  'attachment-uploaded',
  'toggle-bookmark',
  'open-backlinks',
  'reveal-in-explorer',
])

const editorPreferences = ref(loadEditorPreferences())

const setPropertiesMode = (mode) => {
  if (['hidden', 'visible', 'source'].includes(mode) &&
    (!propertyEditPending.value || mode === 'visible')) {
    editorPreferences.value.propertiesInDocument = mode
    saveEditorPreferences(editorPreferences.value)
  }
}

const cyclePropertiesMode = () => {
  const current = editorPreferences.value.propertiesInDocument
  const next = current === 'hidden' ? 'visible' : current === 'visible' ? 'source' : 'hidden'
  setPropertiesMode(next)
}

const toggleReadableLineLength = () => {
  editorPreferences.value.readableLineLength = !editorPreferences.value.readableLineLength
  saveEditorPreferences(editorPreferences.value)
}

const toggleInlineTitle = () => {
  editorPreferences.value.inlineTitle = !editorPreferences.value.inlineTitle
  saveEditorPreferences(editorPreferences.value)
}

const editorRef = ref(null)
const loading = ref(true)
const refreshing = ref(false)
const saving = ref(false)
const reloading = ref(false)
const error = ref(null)
const errorCode = ref(null)
const baseContent = ref('')
const draft = ref('')
const revision = ref(null)
const documentVersion = ref(0)
const saveState = ref('saved')
const hasConfirmedContent = ref(false)
const stale = ref(false)
const saveError = ref('')
const conflict = ref(false)
const saveResultUnknown = ref(false)
const reloadConfirm = ref(false)
const copyMessage = ref('')
const saveNotice = ref('')
const activeAnchor = ref(null)
const shouldAutoFocus = ref(false)
const propertiesPanelRef = ref(null)
const propertyEditPending = ref(false)

const dirty = computed(() => draft.value !== baseContent.value)
const hasUnconfirmedChanges = computed(() =>
  dirty.value ||
  propertyEditPending.value ||
  saving.value ||
  conflict.value ||
  saveResultUnknown.value ||
  saveState.value === 'error'
)
const revisionReady = computed(() => typeof revision.value === 'string' && /^[a-f0-9]{64}$/.test(revision.value))
const filename = computed(() => props.path.split('/').at(-1) || props.path)
const noteStem = computed(() => filename.value.replace(/\.(md|markdown)$/i, ''))
const frontmatterSplit = computed(() => splitFrontmatter(draft.value))
const inlineTitleDuplicatesHeading = computed(() => {
  const heading = initialMarkdownH1(frontmatterSplit.value.body)
  const normalize = (value) => value.trim().replace(/\s+/g, ' ').normalize('NFC')
  return heading !== null && normalize(heading) === normalize(noteStem.value)
})
const editorText = computed(() => {
  if (editorPreferences.value.propertiesInDocument === 'source') {
    return normalizeLineEndings(draft.value)
  }
  return frontmatterSplit.value.hasFrontmatter
    ? normalizeLineEndings(frontmatterSplit.value.body)
    : normalizeLineEndings(draft.value)
})

const uploadedAttachments = ref([])
const effectiveAllFiles = computed(() =>
  Array.from(
    new Set([
      ...(Array.isArray(props.allFiles) ? props.allFiles : []),
      ...(Array.isArray(props.knownFiles) ? props.knownFiles : []),
      ...uploadedAttachments.value,
    ])
  )
)

const wordStats = computed(() => {
  const body = String(frontmatterSplit.value?.body || '')
  const matches = body.match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu)
  const words = matches ? matches.length : 0
  const readingMinutes = words === 0 ? 0 : Math.max(1, Math.ceil(words / 200))
  return { words, readingMinutes }
})

const folderTrail = computed(() => props.path.split('/').slice(0, -1).filter(Boolean))

const parsedDocMeta = computed(() => parseNoteDocument(draft.value, props.knownPropertyTypes))

const propertyCount = computed(() =>
  parsedDocMeta.value.valid ? parsedDocMeta.value.properties.length : 0
)

const frontmatterSummary = computed(() => {
  if (!parsedDocMeta.value.valid || !parsedDocMeta.value.hasFrontmatter) {
    return { tags: [], items: [] }
  }
  const tags = []
  const items = []
  const stemNorm = noteStem.value.trim().toLowerCase()
  for (const prop of parsedDocMeta.value.properties) {
    const keyLower = String(prop.key || '').toLowerCase()
    if (keyLower === 'tags' && Array.isArray(prop.value)) {
      for (const rawTag of prop.value) {
        const clean = String(rawTag || '').trim().replace(/^#+/, '')
        if (clean && !tags.includes(clean)) tags.push(clean)
      }
      continue
    }
    if (keyLower === 'title' && String(prop.value ?? '').trim().toLowerCase() === stemNorm) {
      continue
    }
    if (prop.value === null || prop.value === undefined || prop.value === '') continue
    const formatted = Array.isArray(prop.value)
      ? prop.value.filter(Boolean).join(', ')
      : typeof prop.value === 'boolean'
        ? prop.value ? 'yes' : 'no'
        : String(prop.value).trim()
    if (!formatted) continue
    items.push({ key: prop.key, value: formatted })
  }
  return { tags, items: items.slice(0, 3) }
})

const handleUploadImage = async (file) => {
  if (!hasVaultApi('uploadVaultAttachment')) return null
  const activeDir = props.directory
  try {
    const uploaded = await vaultApi.uploadVaultAttachment(activeDir, file)
    if (!isMounted || activeDir !== props.directory) return null
    if (uploaded && typeof uploaded.path === 'string' && uploaded.path) {
      if (!uploadedAttachments.value.includes(uploaded.path)) {
        uploadedAttachments.value = [...uploadedAttachments.value, uploaded.path]
      }
      emit('attachment-uploaded', uploaded)
    }
    return uploaded
  } catch (err) {
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return null
    }
    saveNotice.value = ''
    saveError.value = err?.message || 'Could not upload attachment.'
    return null
  }
}

const statusLabel = computed(() => {
  if (reloading.value) return 'Loading server copy…'
  if (saveState.value === 'saving' || saving.value) return 'Saving…'
  if (saveState.value === 'conflict' || conflict.value) return 'Conflict'
  if (saveState.value === 'unknown' || saveResultUnknown.value) return 'Save uncertain'
  if (saveState.value === 'error') return 'Save failed'
  if (saveState.value === 'dirty' || dirty.value) return 'Unsaved changes'
  return 'Saved'
})

let activeRequestId = 0
let recoveryRequestId = 0
let authGeneration = 0
let isMounted = true
let unloadHandler = null
let autosaveTimer = null
let activeSavePromise = null
let preservedRelocationPath = null
let propertyTransferPending = false

function clearAutosaveTimer() {
  if (autosaveTimer !== null) {
    clearTimeout(autosaveTimer)
    autosaveTimer = null
  }
}

function scheduleAutosave() {
  clearAutosaveTimer()
  if (props.relocating || conflict.value || saveResultUnknown.value || reloading.value || loading.value) return
  if (!dirty.value) return
  autosaveTimer = setTimeout(() => {
    autosaveTimer = null
    save()
  }, AUTOSAVE_DELAY_MS)
}

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
  if (next === previous) return

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
  documentVersion.value++
  saveNotice.value = ''
  copyMessage.value = ''

  if (conflict.value) {
    saveState.value = 'conflict'
    clearAutosaveTimer()
    publishState()
    return
  }
  if (saveResultUnknown.value) {
    saveState.value = 'unknown'
    clearAutosaveTimer()
    publishState()
    return
  }

  if (draft.value === baseContent.value) {
    clearAutosaveTimer()
    if (!saving.value) {
      saveState.value = 'saved'
      saveError.value = ''
    }
    publishState()
    return
  }

  saveError.value = ''
  if (saving.value) {
    // New edits occurred during an in-flight PUT; follow-up save will be scheduled when it finishes
    publishState()
    return
  }
  saveState.value = 'dirty'
  publishState()
  scheduleAutosave()
}

const handleEditorUpdate = (nextBodyText) => {
  if (editorPreferences.value.propertiesInDocument === 'source') {
    updateDraft(nextBodyText)
    return
  }
  if (!frontmatterSplit.value.hasFrontmatter || /^---[ \t]*\r?\n/.test(nextBodyText)) {
    updateDraft(nextBodyText)
    return
  }
  updateDraft(updateBodyInMarkdown(draft.value, nextBodyText))
}

const handleTitleRename = (rawNewStem) => {
  const trimmed = String(rawNewStem ?? '').trim()
  if (!trimmed || trimmed === noteStem.value) return
  emit('rename-note', trimmed)
}

const handleBeforeUnload = (event) => {
  event.preventDefault()
  event.returnValue = ''
}

function syncUnloadListener() {
  if (typeof window === 'undefined') return
  const unconfirmed = hasUnconfirmedChanges.value
  if (unconfirmed && !unloadHandler) {
    unloadHandler = handleBeforeUnload
    window.addEventListener('beforeunload', unloadHandler)
  } else if (!unconfirmed && unloadHandler) {
    window.removeEventListener('beforeunload', unloadHandler)
    unloadHandler = null
  }
}

const publishState = () => {
  syncUnloadListener()
  emit('state', {
    dirty: hasUnconfirmedChanges.value,
    saving: saving.value,
    reloading: reloading.value,
    saveState: saveState.value,
  })
}

const handlePropertyDraftState = (pending) => {
  if (!pending && propertyTransferPending) return
  propertyEditPending.value = Boolean(pending)
  publishState()
}

const clearProtectedContent = () => {
  clearAutosaveTimer()
  authGeneration++
  recoveryRequestId++
  reloading.value = false
  saving.value = false
  baseContent.value = ''
  draft.value = ''
  revision.value = null
  documentVersion.value = 0
  saveState.value = 'saved'
  hasConfirmedContent.value = false
  conflict.value = false
  saveResultUnknown.value = false
  reloadConfirm.value = false
  publishState()
}

const applyAnchor = async (anchorName) => {
  if (!anchorName) return
  activeAnchor.value = anchorName
  await nextTick()
  const hit = findHeadingOffset(normalizeLineEndings(draft.value), anchorName)
  if (hit && editorRef.value) {
    editorRef.value.scrollToOffset(hit.from)
  }
}

const load = async (isRefresh = false) => {
  if (isRefresh && (dirty.value || saving.value || conflict.value || saveResultUnknown.value)) return
  clearAutosaveTimer()
  const reqId = ++activeRequestId
  recoveryRequestId++
  reloading.value = false
  saving.value = false

  if (
    !isRefresh &&
    props.initialDocument &&
    props.initialDocument.path === props.path &&
    typeof props.initialDocument.revision === 'string'
  ) {
    loading.value = false
    error.value = null
    errorCode.value = null
    const initialContent = props.initialDocument.content ?? ''
    baseContent.value = initialContent
    draft.value = initialContent
    revision.value = props.initialDocument.revision
    documentVersion.value = 0
    saveState.value = 'saved'
    hasConfirmedContent.value = true
    stale.value = false
    saveError.value = ''
    conflict.value = false
    saveResultUnknown.value = false
    shouldAutoFocus.value = true
    publishState()
    await nextTick()
    editorRef.value?.focus()
    return
  }

  shouldAutoFocus.value = false

  if (!isRefresh) {
    loading.value = true
    error.value = null
    errorCode.value = null
    baseContent.value = ''
    draft.value = ''
    revision.value = null
    documentVersion.value = 0
    saveState.value = 'saved'
    hasConfirmedContent.value = false
    stale.value = false
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
    revision.value = result.revision || null
    documentVersion.value = 0
    saveState.value = 'saved'
    hasConfirmedContent.value = true
    error.value = null
    errorCode.value = null
    stale.value = false
    saveError.value = ''
    saveNotice.value = ''
    if (props.anchor) {
      await applyAnchor(props.anchor)
    }
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
      emit('not-found', props.path)
    } else if (err.code === 'UNSUPPORTED_FILE_TYPE') {
      error.value = 'Unsupported file type. Only Markdown notes (.md, .markdown) are supported.'
    } else {
      error.value = 'Could not load note from server. Please try again.'
    }
  } finally {
    if (isMounted && reqId === activeRequestId) {
      loading.value = false
      refreshing.value = false
      publishState()
    }
  }
}

const save = async () => {
  clearAutosaveTimer()
  if (props.relocating || saving.value || reloading.value || !dirty.value || conflict.value || saveResultUnknown.value) return
  if (!hasConfirmedContent.value || !revisionReady.value) {
    saveState.value = 'error'
    saveError.value = 'Reload this note to confirm its current revision before saving.'
    publishState()
    return
  }
  const bytes = new TextEncoder().encode(draft.value)
  if (bytes.byteLength > MAX_MARKDOWN_BYTES) {
    saveState.value = 'error'
    saveError.value = 'This note exceeds the 2 MiB limit.'
    publishState()
    return
  }
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== draft.value) {
    saveState.value = 'error'
    saveError.value = 'The draft contains invalid Unicode and cannot be saved.'
    publishState()
    return
  }

  const reqId = activeRequestId
  const snapshotContent = draft.value
  const snapshotRevision = revision.value
  const snapshotVersion = documentVersion.value

  saving.value = true
  saveState.value = 'saving'
  saveError.value = ''
  saveNotice.value = ''
  publishState()

  const runSave = async () => {
    try {
      const result = await saveVaultMarkdown(props.directory, props.path, {
        content: snapshotContent,
        expectedRevision: snapshotRevision,
      })
      if (!isMounted || reqId !== activeRequestId) return

      baseContent.value = snapshotContent
      revision.value = result.revision
      conflict.value = false
      saveResultUnknown.value = false
      emit('content-saved', {
        path: props.path,
        content: snapshotContent,
        revision: result.revision,
      })

      if (documentVersion.value === snapshotVersion || draft.value === baseContent.value) {
        saveState.value = 'saved'
        saveNotice.value = ''
      } else {
        saveState.value = 'dirty'
      }
    } catch (err) {
      if (!isMounted || reqId !== activeRequestId) return
      if (err.code === 'UNAUTHORIZED') {
        clearProtectedContent()
        emit('unauthorized')
      } else if (err.code === 'VAULT_FILE_CONFLICT') {
        conflict.value = true
        saveState.value = 'conflict'
        saveError.value = 'This note changed on the server. Your draft is preserved.'
      } else if (err.code === 'VAULT_SAVE_RESULT_UNKNOWN') {
        saveResultUnknown.value = true
        saveState.value = 'unknown'
        saveError.value = 'The save result is uncertain. Verify the server copy before continuing.'
      } else if (err.code === 'VAULT_FILE_LOCKED') {
        saveState.value = 'error'
        saveError.value = 'Another Ayame save is using this note. Your draft is preserved.'
      } else if (err.code === 'VAULT_FILE_TOO_LARGE') {
        saveState.value = 'error'
        saveError.value = 'This note exceeds the 2 MiB limit.'
      } else if (err.code === 'INVALID_MARKDOWN_CONTENT') {
        saveState.value = 'error'
        saveError.value = 'The draft contains invalid Unicode and cannot be saved.'
      } else {
        saveState.value = 'error'
        saveError.value = 'Could not save this note. Your draft is preserved.'
      }
    } finally {
      if (isMounted && reqId === activeRequestId) {
        saving.value = false
        publishState()
        if (
          dirty.value &&
          !conflict.value &&
          !saveResultUnknown.value &&
          saveState.value === 'dirty'
        ) {
          scheduleAutosave()
        }
      }
    }
  }

  activeSavePromise = runSave()
  await activeSavePromise
  activeSavePromise = null
}

const flushPendingSave = async () => {
  clearAutosaveTimer()
  if (saving.value && activeSavePromise) {
    await activeSavePromise
  }
  if (
    dirty.value &&
    !propertyEditPending.value &&
    !saving.value &&
    !reloading.value &&
    !conflict.value &&
    !saveResultUnknown.value &&
    saveState.value !== 'error'
  ) {
    await save()
  }
  return {
    ok: !hasUnconfirmedChanges.value,
    saveState: saveState.value,
  }
}

const discardChanges = () => {
  clearAutosaveTimer()
  propertiesPanelRef.value?.discardPendingNumberEdits()
  recoveryRequestId++
  reloading.value = false
  draft.value = baseContent.value
  conflict.value = false
  saveResultUnknown.value = false
  reloadConfirm.value = false
  saveError.value = ''
  saveState.value = 'saved'
  publishState()
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
      saveState.value = 'saved'
      saveNotice.value = 'The server copy matches your draft.'
      publishState()
    } else {
      conflict.value = true
      saveResultUnknown.value = false
      saveState.value = 'conflict'
      saveError.value = 'The server has a different copy. Your draft remains unchanged.'
      publishState()
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
  clearAutosaveTimer()
  const reqId = activeRequestId
  const recoveryId = ++recoveryRequestId
  const authId = authGeneration
  const { directory, path } = props
  const expectedRevision = revision.value
  const expectedDraft = draft.value
  reloading.value = true
  reloadConfirm.value = false
  saveError.value = ''
  publishState()

  const isCurrent = () =>
    isMounted &&
    reqId === activeRequestId &&
    recoveryId === recoveryRequestId &&
    authId === authGeneration &&
    directory === props.directory &&
    path === props.path

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
    conflict.value = false
    saveResultUnknown.value = false
    saveState.value = 'saved'
    reloadConfirm.value = false
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

const preserveDraftForRelocatedPath = (path) => {
  const propertySnapshot = propertiesPanelRef.value?.getPendingEditSnapshot?.()
  const hasPropertyDraft = Object.keys(propertySnapshot?.numberDrafts ?? {}).length > 0
  if (dirty.value || conflict.value || saveResultUnknown.value || hasPropertyDraft) {
    preservedRelocationPath = {
      directory: props.directory,
      sourcePath: props.path,
      destinationPath: path,
      propertySnapshot: hasPropertyDraft ? propertySnapshot : null,
    }
    propertyTransferPending = hasPropertyDraft
  }
}

const reconcileRelocatedDraft = async (transfer) => {
  clearAutosaveTimer()
  const requestId = ++activeRequestId
  recoveryRequestId++
  const isCurrent = () =>
    isMounted &&
    requestId === activeRequestId &&
    preservedRelocationPath === transfer &&
    props.directory === transfer.directory &&
    props.path === transfer.destinationPath

  reloading.value = true
  publishState()
  try {
    const remote = await getVaultMarkdown(transfer.directory, transfer.destinationPath)
    if (!isCurrent()) return
    if (remote?.directory !== transfer.directory || remote.path !== transfer.destinationPath || typeof remote.content !== 'string') {
      throw new Error('The moved note response did not match its destination.')
    }

    const previousBase = baseContent.value
    const hadMarkdownDraft = dirty.value
    const hadConflict = conflict.value
    if (!hadMarkdownDraft) draft.value = remote.content
    baseContent.value = remote.content
    revision.value = remote.revision || null
    hasConfirmedContent.value = true
    stale.value = false
    const changedDuringMove = hadMarkdownDraft && remote.content !== previousBase && draft.value !== remote.content
    conflict.value = hadConflict || changedDuringMove
    saveState.value = conflict.value ? 'conflict' : saveResultUnknown.value ? 'unknown' : dirty.value ? 'dirty' : 'saved'
    if (changedDuringMove) saveError.value = 'The moved note changed during reconciliation. Your draft is preserved.'
    error.value = null
    errorCode.value = null
  } catch (err) {
    if (!isCurrent()) return
    if (err.code === 'UNAUTHORIZED') {
      preservedRelocationPath = null
      propertyTransferPending = false
      propertiesPanelRef.value?.discardPendingNumberEdits?.()
      clearProtectedContent()
      emit('unauthorized')
      return
    }
    conflict.value = true
    saveState.value = 'conflict'
    saveError.value = 'Could not confirm the moved note contents. Your draft is preserved; refresh the server copy to continue.'
    stale.value = true
  } finally {
    if (isCurrent()) {
      await nextTick()
      if (!isCurrent()) return
      const restored = !transfer.propertySnapshot ||
        propertiesPanelRef.value?.restorePendingEditSnapshot?.(transfer.propertySnapshot)
      if (restored) {
        propertyTransferPending = false
        preservedRelocationPath = null
      } else {
        conflict.value = true
        saveState.value = 'conflict'
        saveError.value = 'Could not restore the pending Properties edits. The snapshot is retained in this editor.'
      }
      reloading.value = false
      publishState()
      if (restored && !conflict.value && dirty.value) scheduleAutosave()
    }
  }
}

const handleOpenLink = (linkPayload) => {
  if (
    linkPayload.type === 'resolved' &&
    linkPayload.path === props.path &&
    linkPayload.anchor
  ) {
    applyAnchor(linkPayload.anchor)
    return
  }
  emit('open-link', linkPayload)
}

watch(hasUnconfirmedChanges, publishState)

watch(saving, publishState, { flush: 'sync' })
watch(reloading, publishState, { flush: 'sync' })
watch(() => props.relocating, (relocating) => {
  if (relocating) clearAutosaveTimer()
  else if (saveState.value === 'dirty') scheduleAutosave()
})
watch(
  () => [props.directory, props.path],
  ([directory, path], [previousDirectory, previousPath]) => {
    const transfer = preservedRelocationPath
    if (
      transfer?.directory === directory &&
      transfer.directory === previousDirectory &&
      transfer.sourcePath === previousPath &&
      transfer.destinationPath === path
    ) {
      void reconcileRelocatedDraft(transfer)
      return
    }
    preservedRelocationPath = null
    propertyTransferPending = false
    if (directory !== previousDirectory) {
      uploadedAttachments.value = []
    }
    load()
  }
)
watch(
  () => props.anchor,
  (nextAnchor) => {
    if (nextAnchor && hasConfirmedContent.value) {
      applyAnchor(nextAnchor)
    }
  }
)

const handleKeyDown = (event) => {
  const mod = event.ctrlKey || event.metaKey
  if (mod && event.key === ';') {
    event.preventDefault()
    cyclePropertiesMode()
  } else if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 's') {
    event.preventDefault()
    if (dirty.value && !saving.value && !reloading.value && !conflict.value) {
      void save()
    }
  }
}

onMounted(() => {
  isMounted = true
  window.addEventListener('keydown', handleKeyDown)
  load()
  publishState()
})

onUnmounted(() => {
  isMounted = false
  window.removeEventListener('keydown', handleKeyDown)
  clearAutosaveTimer()
  activeRequestId++
  recoveryRequestId++
  if (unloadHandler) {
    window.removeEventListener('beforeunload', unloadHandler)
    unloadHandler = null
  }
  emit('state', { dirty: false, saving: false, reloading: false, saveState: 'saved' })
})

defineExpose({
  flushPendingSave,
  discardChanges,
  preserveDraftForRelocatedPath,
  revision,
  saveState,
  documentVersion,
  save,
  reloadServerCopy,
  getText: () => draft.value,
  setText: (text) => updateDraft(text),
  reload: () => load(true),
  refresh: () => load(true),
  setPropertiesMode,
  cyclePropertiesMode,
  toggleReadableLineLength,
  toggleInlineTitle,
  getPreferences: () => ({ ...editorPreferences.value }),
})
</script>

<template>
  <div
    class="markdown-viewer"
    data-testid="markdown-viewer"
    :data-active-anchor="activeAnchor || undefined"
  >
    <!-- Screen-reader and contract accessible filename without cluttering the canvas -->
    <span class="sr-only" data-testid="markdown-filename">{{ filename }}</span>

    <!-- Discreet status indicator: completely silent when saved -->
    <div
      v-if="hasConfirmedContent"
      class="editor-status-indicator"
      :class="[`editor-status-indicator--${saveState}`, { 'editor-status-indicator--silent': saveState === 'saved' }]"
      data-testid="autosave-status"
      role="status"
    >
      <span v-if="saveState === 'dirty' || (dirty && !saving)" data-testid="markdown-dirty-indicator">{{ statusLabel }}</span>
      <span v-else-if="saving || saveState === 'saving'" data-testid="markdown-saving">{{ statusLabel }}</span>
      <span v-else class="status-silent-text">{{ statusLabel }}</span>
    </div>

    <main class="viewer-body">
      <div v-if="loading" class="state-container" data-testid="markdown-loading">
        <div class="loading-spinner"></div>
        <p>Loading note...</p>
      </div>

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
          Close note
        </button>
      </div>

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

      <div v-else-if="hasConfirmedContent" class="content-container editor-container">
        <NoteAlertBanners
          :reloading="reloading"
          :saving="saving"
          :save-state="saveState"
          :save-error="saveError"
          :save-notice="saveNotice"
          :copy-message="copyMessage"
          :conflict="conflict"
          :save-result-unknown="saveResultUnknown"
          :reload-confirm="reloadConfirm"
          @retry-save="save"
          @copy-draft="copyDraft"
          @request-reload="reloadConfirm = true"
          @verify-server="verifyServer"
          @cancel-reload="reloadConfirm = false"
          @confirm-reload="reloadServerCopy"
        />

        <div
          class="viewer-document-container"
          :class="{ 'viewer-document-container--readable': editorPreferences.readableLineLength }"
        >
          <NoteContextBar
            :vault-name="vaultName"
            :folder-trail="folderTrail"
            :note-stem="noteStem"
            :properties-visible="editorPreferences.propertiesInDocument !== 'hidden'"
            :property-count="propertyCount"
            :readable-line-length="editorPreferences.readableLineLength"
            :bookmarked="bookmarked"
            @reveal-in-explorer="emit('reveal-in-explorer')"
            @cycle-properties="cyclePropertiesMode"
            @toggle-width="toggleReadableLineLength"
            @toggle-bookmark="emit('toggle-bookmark')"
          />

          <div v-if="editorPreferences.inlineTitle && !inlineTitleDuplicatesHeading" class="note-heading-row">
            <input
              type="text"
              class="note-heading-title"
              data-testid="note-heading-title"
              :value="noteStem"
              :disabled="relocating || reloading || loading"
              aria-label="Note file title"
              @change="handleTitleRename($event.target.value)"
              @keydown.enter.prevent="$event.target.blur()"
            />
          </div>

          <div
            v-if="
              editorPreferences.propertiesInDocument === 'hidden' &&
              !propertyEditPending &&
              (frontmatterSummary.tags.length > 0 || frontmatterSummary.items.length > 0)
            "
            class="note-frontmatter-strip"
            data-testid="note-frontmatter-strip"
          >
            <button
              v-for="tag in frontmatterSummary.tags"
              :key="`fm-tag-${tag}`"
              type="button"
              class="note-fm-tag"
              data-testid="frontmatter-tag-chip"
              @click="emit('select-tag', tag)"
            >
              #{{ tag }}
            </button>
            <span
              v-for="item in frontmatterSummary.items"
              :key="`fm-meta-${item.key}`"
              class="note-fm-meta"
            >
              <span class="note-fm-key">{{ item.key }}</span>
              <span class="note-fm-val">{{ item.value }}</span>
            </span>
            <button
              type="button"
              class="note-fm-edit"
              data-testid="frontmatter-strip-edit"
              @click="setPropertiesMode('visible')"
            >
              Edit
            </button>
          </div>

          <PropertiesPanel
            v-if="editorPreferences.propertiesInDocument === 'visible' || propertyEditPending"
            ref="propertiesPanelRef"
            :key="JSON.stringify([directory, path])"
            :markdown="draft"
            :confirmed-markdown="baseContent"
            :disabled="relocating || reloading || loading"
            :known-property-names="knownPropertyNames"
            :known-property-types="knownPropertyTypes"
            @update:markdown="updateDraft"
            @pending-change="handlePropertyDraftState"
            @select-tag="emit('select-tag', $event)"
            @open-link="handleOpenLink"
          />

          <MarkdownEditor
            ref="editorRef"
            :model-value="editorText"
            :disabled="relocating || reloading || loading"
            :source-path="path"
            :known-files="knownFiles"
            :aliases-by-file="aliasesByFile"
            :index-complete="indexComplete"
            :auto-focus="shouldAutoFocus"
            :vault-directory="directory"
            :all-files="effectiveAllFiles"
            :known-tags="knownTags"
            :upload-image="handleUploadImage"
            @update:model-value="handleEditorUpdate"
            @open-link="handleOpenLink"
            @click-tag="emit('select-tag', $event)"
          />
        </div>
      </div>
    </main>
    <NoteStatusHud
      v-if="hasConfirmedContent && !loading && !error"
      :backlink-count="backlinkCount"
      :words="wordStats.words"
      :reading-minutes="wordStats.readingMinutes"
      @open-backlinks="emit('open-backlinks')"
    />
  </div>
</template>

<style>
.markdown-viewer {
  display: flex;
  flex-direction: column;
  width: 100%;
  min-width: 0;
  height: 100%;
  color: var(--reading-text);
  background: var(--reading-background);
  font-family: var(--reading-font-body);
  position: relative;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}

.editor-status-indicator {
  position: absolute;
  top: 0.65rem;
  right: 1.25rem;
  z-index: 10;
  font-size: 0.75rem;
  padding: 0.15rem 0.5rem;
  border-radius: 3px;
  transition: opacity 150ms ease;
  pointer-events: none;
}

.editor-status-indicator--silent {
  opacity: 0;
}

.editor-status-indicator--dirty {
  color: var(--reading-tag-text);
  background: var(--reading-tag-bg);
  border: 1px solid var(--reading-tag-border);
  opacity: 1;
}

.editor-status-indicator--saving {
  color: var(--reading-heading);
  background: var(--reading-background-elevated);
  border: 1px solid var(--reading-border);
  opacity: 1;
}

.autosave-badge--dirty,
.autosave-badge--saving {
  color: var(--reading-accent);
  border-color: var(--reading-border);
}

.autosave-badge--conflict,
.autosave-badge--unknown,
.autosave-badge--error {
  color: #ff9d76;
  border-color: rgba(220, 100, 50, 0.45);
  background: rgba(220, 100, 50, 0.14);
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
  background: var(--reading-control-bg);
  border: 1px solid var(--reading-control-border);
  color: var(--reading-text);
  padding: 0.25rem 0.65rem;
  border-radius: var(--radius-xs, 2px);
  font-size: 0.8rem;
  cursor: pointer;
  transition: background-color 0.12s ease, border-color 0.12s ease, color 0.12s ease;
}

.action-button:hover:not(:disabled) {
  background: var(--ayame-hover, #242530);
  border-color: var(--reading-accent);
  color: var(--reading-heading);
}

.action-button:focus-visible:not(:disabled) {
  outline: 2px solid var(--reading-focus-ring);
  outline-offset: 2px;
}

.action-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.inline-retry-button {
  margin-left: 0.75rem;
}

.viewer-body {
  flex: 1;
  overflow-y: auto;
  padding: 0;
  background: var(--reading-background);
}

.viewer-document-container {
  width: 100%;
  min-width: 0;
  padding: 1.1rem 2.25rem 3.5rem;
  box-sizing: border-box;
}

.viewer-document-container--readable {
  max-width: 800px;
  margin-inline: auto;
}

@media (max-width: 640px) {
  .viewer-document-container {
    padding: 0.9rem 1.1rem 2.75rem;
  }
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
  color: var(--ayame-error, #e2a8b4);
  font-weight: 500;
}

.error-desc {
  font-size: 0.9rem;
  color: var(--reading-muted);
}

.editor-status {
  margin: 0 0 0.75rem;
  font-size: 0.85rem;
  color: var(--reading-muted);
}

.editor-error {
  margin: 0 0 0.75rem;
  padding: 0.65rem 0.8rem;
  border: 1px solid var(--ayame-error-border, #684651);
  border-radius: var(--radius-xs, 2px);
  background: rgba(104, 70, 81, 0.18);
  color: var(--ayame-error, #d8a6b0);
  font-size: 0.88rem;
}

.editor-conflict,
.editor-confirm {
  margin: 0 0 0.9rem;
  padding: 0.85rem;
  border: 1px solid var(--reading-control-border);
  border-radius: var(--radius-xs, 2px);
  background: var(--reading-background-elevated);
}

.conflict-actions,
.confirm-actions {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.5rem;
}

.note-context-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-height: 26px;
  margin-bottom: 0.55rem;
  flex-wrap: wrap;
  font-family: var(--ui-font-sans);
}

.note-breadcrumbs {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  min-width: 0;
  max-width: 100%;
  padding: 0.14rem 0.42rem;
  margin-left: -0.42rem;
  border: none;
  border-radius: var(--radius-xs, 2px);
  background: transparent;
  color: var(--reading-muted);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  overflow: hidden;
  transition: background-color 120ms ease, color 120ms ease;
}

.note-breadcrumbs:hover {
  background: rgba(169, 154, 202, 0.08);
  color: var(--reading-heading-secondary);
}

.note-breadcrumbs--static {
  cursor: default;
}

.note-breadcrumbs--static:hover {
  background: transparent;
  color: var(--reading-muted);
}

.note-crumb-seg {
  color: var(--reading-syntax);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-crumb-sep {
  color: var(--reading-syntax);
}

.note-crumb-current {
  color: var(--reading-muted);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.note-quick-tools {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  flex-shrink: 0;
}

.note-tool-btn {
  display: inline-flex;
  align-items: center;
  gap: 0.32rem;
  height: 24px;
  padding: 0 0.48rem;
  border: 1px solid var(--reading-border-subtle);
  border-radius: var(--radius-xs, 2px);
  background: var(--ayame-surface, #1b1c25);
  color: var(--reading-muted);
  font: inherit;
  font-size: 0.72rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 110ms ease, color 110ms ease, background-color 110ms ease;
}

.note-tool-btn--icon {
  padding: 0 0.4rem;
}

.note-tool-btn:hover {
  border-color: var(--reading-accent);
  color: var(--reading-heading);
  background: var(--ayame-hover, #242530);
}

.note-tool-btn--active {
  border-color: rgba(169, 154, 202, 0.45);
  color: var(--ayame-lavender, #d4cbe4);
  background: rgba(169, 154, 202, 0.14);
}

.note-tool-btn--bookmarked {
  border-color: rgba(230, 195, 135, 0.5);
  color: #e6c387;
  background: rgba(230, 195, 135, 0.1);
}

.note-tool-count {
  padding: 0 0.28rem;
  border-radius: var(--radius-xs, 2px);
  background: rgba(169, 154, 202, 0.14);
  color: var(--reading-tag-text);
  font-size: 0.68rem;
}

.note-heading-row {
  margin-bottom: 0.45rem;
}

.note-frontmatter-strip {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 0.38rem;
  margin-bottom: 0.9rem;
  padding-bottom: 0.65rem;
  border-bottom: 1px solid var(--reading-border-subtle);
}

.note-fm-tag {
  padding: 0.14rem 0.46rem;
  border: 1px solid var(--reading-tag-border);
  border-radius: var(--radius-xs, 2px);
  background: var(--reading-tag-bg);
  color: var(--reading-tag-text);
  font: inherit;
  font-size: 0.73rem;
  cursor: pointer;
  transition: border-color 110ms ease, background-color 110ms ease;
}

.note-fm-tag:hover {
  border-color: var(--reading-accent);
  background: rgba(169, 154, 202, 0.2);
}

.note-fm-meta {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.14rem 0.46rem;
  border: 1px solid var(--reading-border-subtle);
  border-radius: var(--radius-xs, 2px);
  background: var(--ayame-surface, #1b1c25);
  font-size: 0.72rem;
}

.note-fm-key {
  color: var(--reading-syntax);
}

.note-fm-val {
  color: var(--reading-heading-secondary);
}

.note-fm-edit {
  margin-left: auto;
  padding: 0.1rem 0.4rem;
  border: 1px solid transparent;
  border-radius: var(--radius-xs, 2px);
  background: transparent;
  color: var(--reading-syntax);
  font: inherit;
  font-size: 0.72rem;
  cursor: pointer;
  transition: color 120ms ease, border-color 120ms ease, background-color 120ms ease;
}

.note-fm-edit:hover {
  color: var(--reading-heading);
  border-color: var(--reading-border);
  background: rgba(27, 28, 37, 0.65);
}

.note-heading-title {
  width: 100%;
  padding: 0.1rem 0 0.2rem;
  background: transparent;
  border: none;
  border-bottom: 1px solid transparent;
  color: var(--reading-heading);
  font-family: var(--reading-font-heading);
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
}

.note-heading-title:focus {
  outline: none;
  border-bottom-color: var(--reading-accent);
}

.note-heading-title:focus-visible {
  outline: 2px solid var(--reading-focus-ring);
  outline-offset: 4px;
  border-radius: 3px;
}

.editor-bottom-hud {
  position: absolute;
  bottom: 0.65rem;
  right: 1.25rem;
  z-index: 8;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--ui-font-sans);
}

.editor-hud-pill,
.editor-word-count {
  font-size: 0.72rem;
  color: var(--reading-syntax);
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--reading-border);
  border-radius: var(--radius-xs, 2px);
  padding: 0.16rem 0.5rem;
  user-select: none;
}

.editor-word-count {
  pointer-events: none;
}

.editor-hud-pill--interactive {
  font-family: inherit;
  color: var(--reading-muted);
  cursor: pointer;
  transition: border-color 120ms ease, color 120ms ease, background-color 120ms ease;
}

.editor-hud-pill--interactive:hover {
  color: var(--reading-tag-text);
  border-color: var(--reading-accent);
  background: rgba(169, 154, 202, 0.12);
}
</style>
