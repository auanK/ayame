<template>
  <section class="mural" aria-labelledby="mural-heading" data-testid="mural-panel">
    <header class="mural-header">
      <h3 id="mural-heading">Mural</h3>
      <div class="mural-actions">
        <button type="button" class="btn btn-secondary btn-compact" :aria-pressed="archived" :disabled="moving" @click="switchArchive">
          {{ archived ? 'Active notes' : 'Archive' }}
        </button>
        <input ref="createImageInput" type="file" :accept="MURAL_IMAGE_TYPES.join(',')" class="sr-only-input" tabindex="-1" @change="selectNewImage" />
        <button ref="createImageButton" type="button" class="btn btn-secondary btn-compact" :disabled="opening || imageBusy || moving" @click="createImageInput?.click()">New image</button>
        <button ref="createButton" type="button" class="btn btn-primary btn-compact" :disabled="opening || imageBusy || moving" @click="createNote">New note</button>
      </div>
    </header>

    <p v-if="listError" class="error-message" role="alert">
      {{ listError }}
      <button type="button" class="btn btn-secondary btn-compact" :disabled="moving" @click="loadCards()">Refresh</button>
    </p>
    <p v-else-if="loading && !cards.length" class="mural-empty" role="status">Loading notes…</p>
    <p v-else-if="!sections.length" class="mural-empty">{{ archived ? 'No archived notes.' : 'No quick notes yet.' }}</p>
    <p v-if="imageBusy && !draft" class="mural-empty" role="status">Uploading image…</p>
    <p v-if="creationError" class="error-message" role="alert">
      {{ creationError }}
      <button v-if="pendingImage" type="button" class="btn btn-secondary btn-compact" :disabled="imageBusy || moving" @click="createImageCard">Retry upload</button>
    </p>

    <MuralCardGrid
      v-if="sections.length"
      :sections="sections"
      :disabled="opening || imageBusy"
      :reorder-disabled="loading || Boolean(draft)"
      :loading="loading"
      :moving="moving"
      @open="openNote"
      @reorder="reorderCards"
      @resize="resizeCard"
      @more="loadCards"
    />
    <span class="sr-only" role="status">{{ reorderStatus }}</span>

    <MuralNoteEditor
      v-if="draft"
      :draft="draft"
      :existing="Boolean(savedNote)"
      :dirty="dirty"
      :saving="saving"
      :locked="closing || moving || imageBusy"
      :image-only="savedNote?.kind === 'image'"
      :image-url="savedNote?.imageVersion ? getMuralImageUrl(savedNote.id, savedNote.imageVersion, true) : ''"
      :image-busy="imageBusy"
      :can-move-up="canMoveUp"
      :can-move-down="canMoveDown"
      :conflict="Boolean(conflict)"
      :error="saveError"
      @change="changeDraft"
      @close="closeEditor"
      @move="moveNote"
      @archive="toggleNoteArchive"
      @delete="deleteNote"
      @use-server="acceptServerVersion"
      @keep-mine="retryMyVersion"
      @retry="save"
      @discard="discardEditor"
      @upload-image="updateImage"
      @remove-image="updateImage(null)"
    />
  </section>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue'
import { MURAL_IMAGE_TYPES, MURAL_MAX_IMAGE_BYTES, MURAL_PREVIEW_LENGTH } from '../../../shared/mural.js'
import { deleteMuralNote, getMuralImageUrl, listMuralCards, moveMuralNote, readMuralNote, removeMuralImage, resizeMuralCard, uploadMuralImage, writeMuralNote } from './api.js'
import { createMuralNoteCache, muralNoteCacheKey } from './noteCache.js'
import MuralCardGrid from './MuralCardGrid.vue'
import MuralNoteEditor from './MuralNoteEditor.vue'

const GROUPS = ['pinned', 'notes']
const groupOf = (note) => note.pinned ? 'pinned' : 'notes'
const sortCards = (a, b) => Number(b.pinned) - Number(a.pinned) || b.position - a.position
const SAVE_DELAY_MS = 650
const emit = defineEmits(['state', 'unauthorized'])
const noteCache = inject(muralNoteCacheKey, null)?.value ?? createMuralNoteCache()

const cards = shallowRef([])
const nextPages = ref({})
const archived = ref(false)
const loading = ref(false)
const opening = ref(false)
const listError = ref('')
const createButton = ref(null)
const createImageButton = ref(null)
const createImageInput = ref(null)
const imageBusy = ref(false)
const creationError = ref('')
const pendingImage = shallowRef(null)
const draft = ref(null)
const savedNote = shallowRef(null)
const conflict = shallowRef(null)
const saving = ref(false)
const moving = ref(false)
const reorderStatus = ref('')
const closing = ref(false)
const saveError = ref('')

let mounted = false
let listRequest
let noteRequest
let saveTimer
let saveTask
let returnFocus
const resizeGenerations = new Map()
const serverPositions = new Map()
const reorderQueue = []
let drainingReorder = false
let lastConfirmedCards = null

const syncServerPositions = (list) => {
  for (const card of list) {
    if (card?.id && Number.isFinite(card.position)) {
      serverPositions.set(card.id, card.position)
    }
  }
}

const sections = computed(() => GROUPS.map((group) => ({
  group,
  label: group === 'pinned' ? 'Pinned' : archived.value ? 'Archived' : 'Notes',
  cards: cards.value.filter((card) => groupOf(card) === group),
  hasMore: Boolean(nextPages.value[group]),
})).filter((section) => section.cards.length || section.hasMore))
const noteFields = ({ title, body, color, pinned, archived }) => ({ title: title.trim(), body, color, pinned, archived })
const notePreview = (note) => ({
  id: note.id,
  title: note.title,
  color: note.color,
  kind: note.kind,
  imageVersion: note.imageVersion,
  imageWidth: note.imageWidth ?? null,
  pinned: note.pinned,
  archived: note.archived,
  position: note.position,
  preview: Array.from(note.body).slice(0, MURAL_PREVIEW_LENGTH).join(''),
})
const dirty = computed(() => {
  if (!draft.value) return false
  const fields = noteFields(draft.value)
  if (!savedNote.value) return Boolean(fields.title || fields.body.trim())
  return Object.entries(fields).some(([key, value]) => savedNote.value[key] !== value)
})

const positionsInGroup = computed(() => cards.value
  .filter((card) => card.pinned === savedNote.value?.pinned && card.id !== savedNote.value?.id)
  .map((card) => card.position))
const canMoveUp = computed(() => positionsInGroup.value.some((position) => position > savedNote.value?.position))
const canMoveDown = computed(() => positionsInGroup.value.some((position) => position < savedNote.value?.position) ||
  Boolean(savedNote.value && nextPages.value[groupOf(savedNote.value)]))

const useSessionError = (error) => {
  if (error?.code !== 'UNAUTHORIZED') return false
  emit('unauthorized')
  return true
}

const loadCards = async (group = null) => {
  if (group && (!nextPages.value[group] || loading.value)) return
  listRequest?.abort()
  const request = new AbortController()
  listRequest = request
  loading.value = true
  listError.value = ''
  try {
    const page = await listMuralCards({ archived: archived.value, after: nextPages.value[group], group, signal: request.signal })
    if (request.signal.aborted) return
    if (group) {
      cards.value = [...new Map([...cards.value, ...page.cards].map((card) => [card.id, card])).values()].sort(sortCards)
      nextPages.value[group] = page.next
    } else {
      cards.value = [...page.pinned.cards, ...page.notes.cards]
      nextPages.value = { pinned: page.pinned.next, notes: page.notes.next }
    }
    syncServerPositions(cards.value)
    lastConfirmedCards = cards.value
  } catch (error) {
    if (!request.signal.aborted && !useSessionError(error)) listError.value = 'Could not load the mural.'
  } finally {
    if (listRequest === request) {
      listRequest = null
      loading.value = false
    }
  }
}

const switchArchive = () => {
  archived.value = !archived.value
  cards.value = []
  nextPages.value = {}
  void loadCards()
}

const showEditor = (id, note = null) => {
  saveError.value = ''
  conflict.value = null
  savedNote.value = note
  draft.value = { id, ...(note ? noteFields(note) : { title: '', body: '', color: 'neutral', pinned: false, archived: false }) }
}

const newCardId = () => Array.from(crypto.getRandomValues(new Uint8Array(16)), (byte) => byte.toString(16).padStart(2, '0')).join('')

const createNote = () => {
  returnFocus = createButton.value
  showEditor(newCardId())
}

const openNote = async (id, trigger) => {
  if (opening.value || imageBusy.value || moving.value) return
  noteRequest?.abort()
  listError.value = ''
  returnFocus = trigger
  const cached = noteCache.get(id)
  if (cached) {
    showEditor(id, cached.note)
    if (cached.fresh) return
  }

  const request = new AbortController()
  noteRequest = request
  opening.value = !cached
  try {
    const { note } = await readMuralNote(id, request.signal)
    if (!mounted || request.signal.aborted) return
    noteCache.put(note)
    if (!cached) {
      showEditor(id, note)
    } else if (
      savedNote.value === cached.note && !dirty.value && !conflict.value && !closing.value &&
      (note.revision !== cached.note.revision || note.position !== cached.note.position)
    ) {
      showEditor(id, note)
      updateBoard(note, cached.note)
    }
  } catch (error) {
    if (!mounted || request.signal.aborted || useSessionError(error)) return
    if (error.code === 'MURAL_NOTE_NOT_FOUND') noteCache.invalidate(id)
    if (!cached) listError.value = 'Could not open this note.'
    else if (error.code === 'MURAL_NOTE_NOT_FOUND') saveError.value = 'This note is no longer available.'
  } finally {
    if (noteRequest === request) {
      noteRequest = null
      if (mounted) opening.value = false
    }
  }
}

const updateBoard = (note, previous) => {
  if (!previous && archived.value && !note.archived) switchArchive()
  const updated = cards.value.filter((card) => card.id !== note.id)
  if (note.archived === archived.value) updated.push(notePreview(note))
  cards.value = updated.sort(sortCards)
  syncServerPositions(cards.value)
  if (!drainingReorder) lastConfirmedCards = cards.value
  if (listRequest) void loadCards()
}

const imageTooLarge = 'Image exceeds the 5 MiB limit.'
const imageUploadError = (error) => {
  if (error.status === 413) return imageTooLarge
  if (error.status === 415) return 'Use a valid PNG, JPEG, WebP or GIF image.'
  return 'Could not update the image. Try again.'
}

const createImageCard = async () => {
  if (!pendingImage.value || imageBusy.value || moving.value) return
  const { id, file } = pendingImage.value
  imageBusy.value = true
  creationError.value = ''
  try {
    const { note } = await uploadMuralImage(id, file)
    if (!mounted) return
    noteCache.put(note)
    pendingImage.value = null
    returnFocus = createImageButton.value
    showEditor(id, note)
    updateBoard(note, null)
  } catch (error) {
    if (!mounted || useSessionError(error)) return
    if ([409, 413, 415].includes(error.status)) pendingImage.value = null
    creationError.value = imageUploadError(error)
  } finally {
    imageBusy.value = false
  }
}

const selectNewImage = (event) => {
  const file = event.target.files?.[0]
  event.target.value = ''
  if (!file || imageBusy.value) return
  if (file.size > MURAL_MAX_IMAGE_BYTES) {
    pendingImage.value = null
    creationError.value = imageTooLarge
    return
  }
  pendingImage.value = { id: newCardId(), file }
  void createImageCard()
}

const scheduleSave = () => {
  clearTimeout(saveTimer)
  if (dirty.value && !saving.value && !closing.value && !imageBusy.value && !conflict.value && !saveError.value) {
    saveTimer = setTimeout(() => void save(), SAVE_DELAY_MS)
  }
}

const changeDraft = (patch) => {
  saveError.value = ''
  Object.assign(draft.value, patch)
  scheduleSave()
}

const save = () => {
  if (saveTask) return saveTask
  if (!dirty.value || conflict.value) return Promise.resolve(!dirty.value)
  noteRequest?.abort()
  clearTimeout(saveTimer)
  const { id } = draft.value
  const previous = savedNote.value
  const payload = { ...noteFields(draft.value), expectedRevision: previous?.revision ?? null }
  saving.value = true
  saveError.value = ''
  saveTask = (async () => {
    try {
      const { note } = await writeMuralNote(id, payload)
      if (!mounted) return false
      noteCache.put(note)
      savedNote.value = note
      updateBoard(note, previous)
      return true
    } catch (error) {
      if (!mounted || useSessionError(error)) return false
      if (error.code === 'MURAL_NOTE_CONFLICT' && error.note) {
        noteCache.put(error.note)
        conflict.value = error.note
      } else saveError.value = 'Could not save. Your draft is still here.'
      return false
    }
  })().finally(() => {
    saveTask = null
    saving.value = false
    if (mounted) scheduleSave()
  })
  return saveTask
}

const discardEditor = async () => {
  clearTimeout(saveTimer)
  noteRequest?.abort()
  draft.value = null
  savedNote.value = null
  conflict.value = null
  await nextTick()
  if (returnFocus?.isConnected) returnFocus.focus()
  else createButton.value?.focus()
}

const closeEditor = async () => {
  if (closing.value || moving.value || imageBusy.value || conflict.value) return
  closing.value = true
  try {
    if (saveTask && !await saveTask) return
    if (dirty.value && !await save()) return
    if (mounted) await discardEditor()
  } finally {
    closing.value = false
  }
}

const updateImage = async (file) => {
  if (imageBusy.value || closing.value || conflict.value) return
  if (file?.size > MURAL_MAX_IMAGE_BYTES) {
    saveError.value = imageTooLarge
    return
  }
  imageBusy.value = true
  noteRequest?.abort()
  clearTimeout(saveTimer)
  try {
    if (saveTask && !await saveTask) return
    if (dirty.value && !await save()) return
    const previous = savedNote.value
    if (!previous) return
    saveError.value = ''
    const { id, revision } = previous
    const { note } = file ? await uploadMuralImage(id, file, revision) : await removeMuralImage(id, revision)
    if (!mounted) return
    noteCache.put(note)
    showEditor(id, note)
    updateBoard(note, previous)
  } catch (error) {
    if (!mounted || useSessionError(error)) return
    if (error.code === 'MURAL_NOTE_CONFLICT' && error.note) {
      noteCache.put(error.note)
      updateBoard(error.note, savedNote.value)
      showEditor(error.note.id, error.note)
      saveError.value = 'This note changed in another session. Try the image change again.'
    } else {
      saveError.value = imageUploadError(error)
    }
  } finally {
    imageBusy.value = false
    if (mounted) scheduleSave()
  }
}

const toggleNoteArchive = () => {
  changeDraft({ archived: !draft.value.archived })
  void closeEditor()
}

const deleteNote = async () => {
  if (!savedNote.value || closing.value || moving.value || imageBusy.value || conflict.value) return
  closing.value = true
  clearTimeout(saveTimer)
  noteRequest?.abort()
  saveError.value = ''
  try {
    if (saveTask) await saveTask
    if (!mounted || conflict.value) return
    const { id, revision } = savedNote.value
    await deleteMuralNote(id, revision)
    if (!mounted) return
    noteCache.invalidate(id)
    cards.value = cards.value.filter((card) => card.id !== id)
    if (listRequest) void loadCards()
    await discardEditor()
  } catch (error) {
    if (!mounted || useSessionError(error)) return
    if (error.code === 'MURAL_NOTE_CONFLICT' && error.note) {
      noteCache.put(error.note)
      conflict.value = error.note
    } else saveError.value = 'Could not delete this note. Try again.'
  } finally {
    closing.value = false
  }
}

const acceptServerVersion = () => {
  updateBoard(conflict.value, savedNote.value)
  showEditor(draft.value.id, conflict.value)
}

const retryMyVersion = () => {
  updateBoard(conflict.value, savedNote.value)
  savedNote.value = conflict.value
  conflict.value = null
  void save()
}

const applyCardOrder = ({ note, positions }, updateVisual = true) => {
  const nextPositions = new Map(positions.map(({ id, position }) => [id, position]))
  for (const [id, position] of nextPositions) {
    noteCache.updatePosition(id, position)
    serverPositions.set(id, position)
  }
  serverPositions.set(note.id, note.position)
  noteCache.put(note)
  const base = (lastConfirmedCards ?? cards.value).map((card) => {
    if (card.id === note.id) return notePreview(note)
    if (nextPositions.has(card.id)) return { ...card, position: nextPositions.get(card.id) }
    return card
  }).sort(sortCards)
  lastConfirmedCards = base
  if (updateVisual) {
    cards.value = base
  }
  for (const group of GROUPS) {
    const last = (updateVisual ? base : cards.value).findLast((card) => groupOf(card) === group)
    if (nextPages.value[group] && last) nextPages.value[group] = `${Number(last.pinned)}:${last.position}`
  }
}

const resizeCard = async ({ id, imageWidth }) => {
  const existing = cards.value.find((item) => item.id === id)
  if (!existing || !existing.imageVersion) return
  const nextWidth = imageWidth ?? null
  const prevWidth = existing.imageWidth ?? null
  if (prevWidth === nextWidth) return

  const gen = (resizeGenerations.get(id) ?? 0) + 1
  resizeGenerations.set(id, gen)
  listError.value = ''
  cards.value = cards.value.map((item) => item.id === id ? { ...item, imageWidth: nextWidth } : item)
  noteCache.updateImageWidth(id, nextWidth)

  try {
    const { note } = await resizeMuralCard(id, nextWidth)
    if (!mounted || resizeGenerations.get(id) !== gen) return
    const savedWidth = note?.imageWidth ?? null
    cards.value = cards.value.map((item) => item.id === id ? { ...item, imageWidth: savedWidth } : item)
    noteCache.updateImageWidth(id, savedWidth)
  } catch (error) {
    if (!mounted || useSessionError(error) || resizeGenerations.get(id) !== gen) return
    cards.value = cards.value.map((item) => item.id === id ? { ...item, imageWidth: prevWidth } : item)
    noteCache.updateImageWidth(id, prevWidth)
    listError.value = 'Could not resize the image. Try again.'
  }
}

const drainReorderQueue = async () => {
  if (drainingReorder) return
  drainingReorder = true
  moving.value = true
  listError.value = ''
  reorderStatus.value = ''
  try {
    while (reorderQueue.length > 0 && mounted) {
      const { id, targetId, placement } = reorderQueue.shift()
      const card = cards.value.find((item) => item.id === id) ?? lastConfirmedCards?.find((item) => item.id === id)
      const target = cards.value.find((item) => item.id === targetId) ?? lastConfirmedCards?.find((item) => item.id === targetId)
      const expectedPosition = serverPositions.get(id) ?? card?.position
      const expectedTargetPosition = serverPositions.get(targetId) ?? target?.position
      if (!expectedPosition || !expectedTargetPosition) continue

      const result = await moveMuralNote(id, {
        targetId,
        placement,
        expectedPosition,
        expectedTargetPosition,
      })
      if (!mounted) return
      applyCardOrder(result, reorderQueue.length === 0)
    }
    if (mounted) reorderStatus.value = 'Card order saved.'
  } catch (error) {
    reorderQueue.length = 0
    if (!mounted || useSessionError(error)) return
    if (lastConfirmedCards) cards.value = lastConfirmedCards
    if (error.code === 'MURAL_POSITION_CONFLICT') {
      if (error.note) noteCache.put(error.note)
      await loadCards()
    }
    listError.value = 'Could not reorder the card. Try again.'
  } finally {
    drainingReorder = false
    moving.value = false
  }
}

const reorderCards = ({ id, targetId, placement }) => {
  if (draft.value || loading.value || imageBusy.value || opening.value) return
  const previous = cards.value
  const card = previous.find((item) => item.id === id)
  const target = previous.find((item) => item.id === targetId)
  if (!card || !target || id === targetId) return

  const reordered = previous.filter((item) => item.id !== id)
  reordered.splice(reordered.indexOf(target) + Number(placement === 'after'), 0, { ...card, pinned: target.pinned })
  if (reordered.every((item, index) => item.id === previous[index].id && item.pinned === previous[index].pinned)) return

  if (!drainingReorder && reorderQueue.length === 0) {
    syncServerPositions(previous)
    lastConfirmedCards = previous
  }
  cards.value = reordered
  reorderQueue.push({ id, targetId, placement })
  void drainReorderQueue()
}

const moveNote = async (direction) => {
  if (!savedNote.value || dirty.value || moving.value) return
  noteRequest?.abort()
  const { id, position } = savedNote.value
  moving.value = true
  saveError.value = ''
  try {
    const result = await moveMuralNote(id, { direction, expectedPosition: position })
    if (!mounted) return
    const movedUnloadedCard = result.positions.some(({ id: cardId }) => !cards.value.some((card) => card.id === cardId))
    applyCardOrder(result)
    if (movedUnloadedCard) void loadCards()
    showEditor(id, result.note)
  } catch (error) {
    if (!mounted || useSessionError(error)) return
    if (error.code === 'MURAL_POSITION_CONFLICT' && error.note) {
      noteCache.put(error.note)
      showEditor(id, error.note)
      void loadCards()
    }
    saveError.value = 'Could not move this note. Try again.'
  } finally {
    moving.value = false
  }
}

const protectDraft = (event) => {
  if (!dirty.value && !saving.value && !imageBusy.value) return
  event.preventDefault()
  event.returnValue = ''
}

watch([dirty, saving, opening, moving, imageBusy], () => emit('state', {
  dirty: dirty.value, saving: saving.value || moving.value || imageBusy.value, reloading: opening.value,
}), { flush: 'sync' })

onMounted(() => {
  mounted = true
  window.addEventListener('beforeunload', protectDraft)
  void loadCards()
})

onUnmounted(() => {
  mounted = false
  clearTimeout(saveTimer)
  listRequest?.abort()
  noteRequest?.abort()
  window.removeEventListener('beforeunload', protectDraft)
  emit('state', { dirty: false, saving: false, reloading: false })
})
</script>

<style scoped>
.mural {
  padding: 1.25rem 0 0;
  margin-top: 1.35rem;
  border-top: 1px solid var(--ayame-border);
}

.mural-header, .mural-actions { display: flex; align-items: center; gap: 0.5rem; }
.mural-header { justify-content: space-between; flex-wrap: wrap; margin-bottom: 0.75rem; }
.mural-header h3 { margin: 0; font-size: 0.98rem; font-weight: 600; }
.mural-actions { flex-wrap: wrap; }
.mural-empty { margin: 0; color: var(--ayame-text-muted); font-size: 0.82rem; }
</style>
