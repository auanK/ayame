<template>
  <div class="markdown-editor-shell">
    <div
      ref="editorHost"
      class="markdown-editor-surface"
      :class="{ 'markdown-editor-surface--disabled': disabled }"
      data-testid="markdown-editor"
      aria-label="Markdown editor"
      :aria-disabled="disabled ? 'true' : undefined"
      @click="handleSurfaceClick"
    ></div>
    <ul
      v-if="autocompleteState.open && autocompleteState.items.length > 0 && !disabled"
      class="editor-autocomplete"
      data-testid="editor-autocomplete"
      role="listbox"
      aria-label="Editor suggestions"
    >
      <li
        v-for="(item, idx) in autocompleteState.items"
        :key="item.id"
        role="option"
        :aria-selected="idx === autocompleteState.activeIndex ? 'true' : 'false'"
        class="editor-autocomplete-item"
        :class="{ 'editor-autocomplete-item--active': idx === autocompleteState.activeIndex }"
        data-testid="editor-autocomplete-item"
        :data-autocomplete-value="item.insertText"
        @mousedown.prevent="applyAutocompleteItem(item)"
        @click="applyAutocompleteItem(item)"
      >
        <span class="editor-autocomplete-label">{{ item.label }}</span>
        <span v-if="item.hint" class="editor-autocomplete-hint">{{ item.hint }}</span>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { Compartment, EditorState, Prec } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { defaultKeymap, history, historyKeymap, undo, redo } from '@codemirror/commands'
import { markdown } from '@codemirror/lang-markdown'
import {
  createLivePreviewExtension,
  setCursorActiveEffect,
  setLivePreviewContextEffect,
} from './livePreview.js'

const props = defineProps({
  modelValue: { type: String, required: true },
  disabled: { type: Boolean, default: false },
  sourcePath: { type: String, default: '' },
  knownFiles: { type: Array, default: () => [] },
  aliasesByFile: { type: Object, default: () => ({}) },
  indexComplete: { type: Boolean, default: true },
  autoFocus: { type: Boolean, default: false },
  vaultDirectory: { type: String, default: '' },
  allFiles: { type: Array, default: () => [] },
  knownTags: { type: Array, default: () => [] },
  uploadImage: { type: Function, default: null },
})

const emit = defineEmits(['update:modelValue', 'open-link', 'click-tag'])

const editorHost = ref(null)
const editableCompartment = new Compartment()
let view = null
let applyingExternalUpdate = false

const IMAGE_UPLOAD_MIME_RE = /^image\/(png|jpeg|webp|gif)$/i
const IMAGE_UPLOAD_EXT_RE = /\.(png|jpe?g|webp|gif)$/i
const MARKDOWN_EXT_RE = /\.(md|markdown)$/i

const autocompleteState = ref({
  open: false,
  mode: null,
  from: 0,
  to: 0,
  items: [],
  activeIndex: 0,
})

const closeAutocomplete = () => {
  if (!autocompleteState.value.open && autocompleteState.value.items.length === 0) return
  autocompleteState.value = {
    open: false,
    mode: null,
    from: 0,
    to: 0,
    items: [],
    activeIndex: 0,
  }
}

const buildWikilinkSuggestions = (query, isEmbed) => {
  const qLower = String(query || '').trim().toLowerCase()
  const files = Array.isArray(props.knownFiles) ? props.knownFiles : []
  const stemCounts = new Map()
  for (const filePath of files) {
    if (typeof filePath !== 'string') continue
    const stem = (filePath.split('/').pop() || '').replace(MARKDOWN_EXT_RE, '').toLowerCase()
    stemCounts.set(stem, (stemCounts.get(stem) || 0) + 1)
  }

  const seen = new Set()
  const results = []
  const pushSuggestion = (entry) => {
    const key = entry.insertText.toLowerCase()
    if (seen.has(key)) return
    seen.add(key)
    results.push(entry)
  }

  if (isEmbed && Array.isArray(props.allFiles)) {
    for (const fileEntry of props.allFiles) {
      const filePath = typeof fileEntry === 'string' ? fileEntry : fileEntry?.path
      if (typeof filePath !== 'string' || !IMAGE_UPLOAD_EXT_RE.test(filePath)) continue
      const name = filePath.split('/').pop() || filePath
      if (!qLower || name.toLowerCase().includes(qLower) || filePath.toLowerCase().includes(qLower)) {
        pushSuggestion({
          id: `img:${filePath}`,
          mode: 'wikilink',
          label: name,
          hint: filePath !== name ? filePath : 'Image',
          insertText: filePath,
        })
      }
    }
  }

  for (const filePath of files) {
    if (typeof filePath !== 'string') continue
    const fileName = filePath.split('/').pop() || filePath
    const stem = fileName.replace(MARKDOWN_EXT_RE, '')
    const pathNoExt = filePath.replace(MARKDOWN_EXT_RE, '')
    const insertText = (stemCounts.get(stem.toLowerCase()) || 0) > 1 ? pathNoExt : stem
    if (
      !qLower ||
      stem.toLowerCase().includes(qLower) ||
      filePath.toLowerCase().includes(qLower)
    ) {
      pushSuggestion({
        id: `file:${filePath}`,
        mode: 'wikilink',
        label: stem,
        hint: filePath !== `${stem}.md` ? filePath : '',
        insertText,
      })
    }
  }

  if (!isEmbed && props.aliasesByFile && typeof props.aliasesByFile === 'object') {
    for (const [notePath, aliases] of Object.entries(props.aliasesByFile)) {
      if (!Array.isArray(aliases)) continue
      const fileName = notePath.split('/').pop() || notePath
      const stem = fileName.replace(MARKDOWN_EXT_RE, '')
      const pathNoExt = notePath.replace(MARKDOWN_EXT_RE, '')
      const targetBase = (stemCounts.get(stem.toLowerCase()) || 0) > 1 ? pathNoExt : stem
      for (const rawAlias of aliases) {
        const alias = String(rawAlias || '').trim()
        if (!alias) continue
        if (
          !qLower ||
          alias.toLowerCase().includes(qLower) ||
          notePath.toLowerCase().includes(qLower)
        ) {
          pushSuggestion({
            id: `alias:${notePath}:${alias}`,
            mode: 'wikilink',
            label: alias,
            hint: `Alias → ${notePath}`,
            insertText: `${targetBase}|${alias}`,
          })
        }
      }
    }
  }

  return results.slice(0, 8)
}

const buildTagSuggestions = (query) => {
  const qLower = String(query || '').trim().toLowerCase()
  const rawTags = Array.isArray(props.knownTags) ? props.knownTags : []
  const seen = new Set()
  const results = []
  for (const raw of rawTags) {
    const clean = String(typeof raw === 'string' ? raw : raw?.tag || '')
      .trim()
      .replace(/^#+/, '')
    if (!clean) continue
    const key = clean.toLowerCase()
    if (seen.has(key)) continue
    if (!qLower || key.includes(qLower)) {
      seen.add(key)
      results.push({
        id: `tag:${key}`,
        mode: 'tag',
        label: `#${clean}`,
        hint: '',
        insertText: clean,
      })
    }
    if (results.length >= 8) break
  }
  return results
}

const refreshAutocomplete = (editorView) => {
  if (!editorView || props.disabled) {
    closeAutocomplete()
    return
  }
  const sel = editorView.state.selection.main
  if (!sel.empty) {
    closeAutocomplete()
    return
  }
  const pos = sel.head
  const line = editorView.state.doc.lineAt(pos)
  const linePrefix = editorView.state.doc.sliceString(line.from, pos)

  const wikilinkMatch = linePrefix.match(/(!?\[\[)([^[\]\n|]*)$/)
  if (wikilinkMatch) {
    const isEmbed = wikilinkMatch[1] === '![['
    const query = wikilinkMatch[2]
    const items = buildWikilinkSuggestions(query, isEmbed)
    if (items.length === 0) {
      closeAutocomplete()
      return
    }
    const hasClosingBrackets = editorView.state.doc.sliceString(pos, pos + 2) === ']]'
    autocompleteState.value = {
      open: true,
      mode: 'wikilink',
      from: pos - query.length,
      to: hasClosingBrackets ? pos + 2 : pos,
      items,
      activeIndex: 0,
    }
    return
  }

  const tagMatch = linePrefix.match(/(?:^|\s)#([\p{L}\p{N}_\-/]+)$/u)
  if (tagMatch) {
    const query = tagMatch[1]
    const items = buildTagSuggestions(query)
    if (items.length === 0) {
      closeAutocomplete()
      return
    }
    autocompleteState.value = {
      open: true,
      mode: 'tag',
      from: pos - query.length - 1,
      to: pos,
      items,
      activeIndex: 0,
    }
    return
  }

  closeAutocomplete()
}

const applyAutocompleteItem = (item) => {
  if (!view || !autocompleteState.value.open || !item) return
  const { mode, from, to } = autocompleteState.value
  closeAutocomplete()

  const insertStr = mode === 'wikilink' ? `${item.insertText}]]` : `#${item.insertText} `
  const docLen = view.state.doc.length
  const safeFrom = Math.max(0, Math.min(from, docLen))
  const safeTo = Math.max(safeFrom, Math.min(to, docLen))
  view.dispatch({
    changes: { from: safeFrom, to: safeTo, insert: insertStr },
    selection: { anchor: safeFrom + insertStr.length },
  })
  view.focus()
}

const moveAutocompleteSelection = (delta) => {
  if (!autocompleteState.value.open || autocompleteState.value.items.length === 0) return false
  const len = autocompleteState.value.items.length
  autocompleteState.value = {
    ...autocompleteState.value,
    activeIndex: (autocompleteState.value.activeIndex + delta + len) % len,
  }
  return true
}

const acceptActiveAutocomplete = () => {
  if (!autocompleteState.value.open || autocompleteState.value.items.length === 0) return false
  const item =
    autocompleteState.value.items[autocompleteState.value.activeIndex] ||
    autocompleteState.value.items[0]
  if (!item) return false
  applyAutocompleteItem(item)
  return true
}

const toggleWrapFormatting = (editorView, marker) => {
  if (!editorView || props.disabled) return false
  const { from, to } = editorView.state.selection.main
  const doc = editorView.state.doc
  const len = marker.length

  if (from === to) {
    const before = from >= len ? doc.sliceString(from - len, from) : ''
    const after = from + len <= doc.length ? doc.sliceString(from, from + len) : ''
    if (before === marker && after === marker) {
      editorView.dispatch({
        changes: { from: from - len, to: from + len, insert: '' },
        selection: { anchor: from - len },
      })
      return true
    }
    editorView.dispatch({
      changes: { from, to, insert: `${marker}${marker}` },
      selection: { anchor: from + len },
    })
    return true
  }

  const selected = doc.sliceString(from, to)
  const hasOuterMarkers =
    from >= len &&
    to + len <= doc.length &&
    doc.sliceString(from - len, from) === marker &&
    doc.sliceString(to, to + len) === marker
  if (hasOuterMarkers) {
    editorView.dispatch({
      changes: { from: from - len, to: to + len, insert: selected },
      selection: { anchor: from - len, head: to - len },
    })
    return true
  }

  if (selected.length >= len * 2 && selected.startsWith(marker) && selected.endsWith(marker)) {
    const unwrapped = selected.slice(len, selected.length - len)
    editorView.dispatch({
      changes: { from, to, insert: unwrapped },
      selection: { anchor: from, head: from + unwrapped.length },
    })
    return true
  }

  editorView.dispatch({
    changes: { from, to, insert: `${marker}${selected}${marker}` },
    selection: { anchor: from + len, head: to + len },
  })
  return true
}

const toggleChecklistLine = (editorView) => {
  if (!editorView || props.disabled) return false
  const head = editorView.state.selection.main.head
  const line = editorView.state.doc.lineAt(head)
  const text = line.text

  const taskMatch = text.match(/^(\s*[-*+]\s+\[)([ xX])(\](?:\s.*|$))/)
  if (taskMatch) {
    const checkPos = line.from + taskMatch[1].length
    const nextChar = taskMatch[2] === ' ' ? 'x' : ' '
    editorView.dispatch({
      changes: { from: checkPos, to: checkPos + 1, insert: nextChar },
    })
    return true
  }

  const bulletMatch = text.match(/^(\s*)([-*+]\s+)(.*)$/)
  if (bulletMatch) {
    const bulletStart = line.from + bulletMatch[1].length
    const bulletEnd = bulletStart + bulletMatch[2].length
    const replacement = '- [ ] '
    const cursorDelta = replacement.length - bulletMatch[2].length
    editorView.dispatch({
      changes: { from: bulletStart, to: bulletEnd, insert: replacement },
      selection: { anchor: Math.max(line.from, head + cursorDelta) },
    })
    return true
  }

  editorView.dispatch({
    changes: { from: line.from, to: line.from, insert: '- [ ] ' },
    selection: { anchor: head + 6 },
  })
  return true
}

const extractUploadableImages = (fileList) => {
  if (!fileList || fileList.length === 0) return []
  const images = []
  for (const file of Array.from(fileList)) {
    if (!file) continue
    if (IMAGE_UPLOAD_MIME_RE.test(file.type || '') || IMAGE_UPLOAD_EXT_RE.test(file.name || '')) {
      images.push(file)
    }
  }
  return images
}

const insertUploadedImages = async (files, editorView, insertAtPos = null) => {
  if (!editorView || props.disabled || typeof props.uploadImage !== 'function' || files.length === 0) {
    return
  }
  const snippets = []
  for (const file of files) {
    try {
      const uploaded = await props.uploadImage(file)
      if (uploaded && typeof uploaded.path === 'string' && uploaded.path) {
        snippets.push(`![[${uploaded.path}]]`)
      }
    } catch {
      // Errors are surfaced by parent upload handler if applicable
    }
  }
  if (!view || view !== editorView || props.disabled || snippets.length === 0) return
  const textToInsert = snippets.join('\n')
  const docLen = view.state.doc.length
  const targetPos =
    typeof insertAtPos === 'number' && insertAtPos >= 0
      ? Math.min(insertAtPos, docLen)
      : view.state.selection.main.from
  const replaceTo =
    typeof insertAtPos === 'number' ? targetPos : view.state.selection.main.to
  view.dispatch({
    changes: { from: targetPos, to: replaceTo, insert: textToInsert },
    selection: { anchor: targetPos + textToInsert.length },
  })
  view.focus()
}

const getText = () => (view ? view.state.doc.toString() : props.modelValue)

const setText = (nextText) => {
  if (!view) return
  const str = String(nextText ?? '')
  const current = view.state.doc.toString()
  if (str === current) return
  view.dispatch({
    changes: { from: 0, to: current.length, insert: str },
    selection: { anchor: str.length },
  })
}

const insertText = (text, from = getText().length, to = from) => {
  if (!view) return
  const str = String(text ?? '')
  view.dispatch({
    changes: { from, to, insert: str },
    selection: { anchor: from + str.length },
  })
}

const pasteText = (text, from = view?.state.selection.main.from ?? 0, to = from) => {
  if (!view) return
  const str = String(text ?? '')
  view.dispatch({
    changes: { from, to, insert: str },
    selection: { anchor: from + str.length },
    userEvent: 'input.paste',
  })
}

const setCursor = (pos) => {
  if (!view) return
  const clamped = Math.max(0, Math.min(pos, view.state.doc.length))
  view.dispatch({
    selection: { anchor: clamped, head: clamped },
    effects: setCursorActiveEffect.of(true),
  })
}

const setSelection = (from, to = from) => {
  if (!view) return
  const max = view.state.doc.length
  const anchor = Math.max(0, Math.min(from, max))
  const head = Math.max(0, Math.min(to, max))
  view.dispatch({
    selection: { anchor, head },
    effects: setCursorActiveEffect.of(true),
  })
}

const getSelection = () => {
  if (!view) return { from: 0, to: 0 }
  const main = view.state.selection.main
  return { from: main.from, to: main.to }
}

const performUndo = () => {
  if (!view) return false
  return undo(view)
}

const performRedo = () => {
  if (!view) return false
  return redo(view)
}

const focus = () => {
  if (!view) return
  view.focus()
  view.dispatch({ effects: setCursorActiveEffect.of(true) })
}

const scrollToOffset = (offset) => {
  if (!view) return
  const clamped = Math.max(0, Math.min(offset, view.state.doc.length))
  view.dispatch({
    selection: { anchor: clamped },
    effects: [EditorView.scrollIntoView(clamped, { y: 'start' }), setCursorActiveEffect.of(true)],
  })
}

const getView = () => view

const handleSurfaceClick = (event) => {
  if (props.disabled) return

  const checklistEl = event.target?.closest?.('.cm-live-checklist-marker')
  if (checklistEl && view) {
    const posStr = checklistEl.getAttribute('data-checklist-pos')
    const pos = Number(posStr)
    if (Number.isInteger(pos) && pos >= 0 && pos < view.state.doc.length) {
      const currentChar = view.state.doc.sliceString(pos, pos + 1)
      if (currentChar === ' ' || currentChar === 'x' || currentChar === 'X') {
        event.preventDefault()
        const nextChar = currentChar === ' ' ? 'x' : ' '
        view.dispatch({
          changes: { from: pos, to: pos + 1, insert: nextChar },
        })
        return
      }
    }
  }

  const tagEl = event.target?.closest?.('.cm-live-tag')
  if (tagEl) {
    const tagName = tagEl.getAttribute('data-tag-name')
    if (tagName) {
      event.preventDefault()
      emit('click-tag', tagName)
      return
    }
  }

  const linkEl = event.target?.closest?.('.cm-live-link')
  if (!linkEl) return

  const isEditing = linkEl.getAttribute('data-editing') === 'true'
  const hasModifier = Boolean(event.ctrlKey || event.metaKey)

  // While editing the link syntax directly, a plain click only positions the cursor
  if (isEditing && !hasModifier) {
    return
  }

  const status = linkEl.getAttribute('data-link-status')
  const kind = linkEl.getAttribute('data-link-kind')
  const rawTarget = linkEl.getAttribute('data-link-raw')
  const resolvedPath = linkEl.getAttribute('data-link-resolved-path')
  const anchor = linkEl.getAttribute('data-link-anchor')
  const href = linkEl.getAttribute('data-link-href')

  if (status === 'invalid') {
    event.preventDefault()
    return
  }

  if (status === 'external' && href) {
    event.preventDefault()
    if (typeof window !== 'undefined' && typeof window.open === 'function') {
      window.open(href, '_blank', 'noopener,noreferrer')
    }
    return
  }

  event.preventDefault()
  const payload = {
    type: status,
    rawTarget,
    kind,
  }
  if (resolvedPath) payload.path = resolvedPath
  if (anchor) payload.anchor = anchor
  emit('open-link', payload)
}

onMounted(() => {
  if (typeof Range !== 'undefined') {
    if (typeof Range.prototype.getClientRects !== 'function') {
      Range.prototype.getClientRects = () => []
    }
    if (typeof Range.prototype.getBoundingClientRect !== 'function') {
      Range.prototype.getBoundingClientRect = () => ({
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
        x: 0,
        y: 0,
      })
    }
  }

  const state = EditorState.create({
    doc: props.modelValue,
    extensions: [
      history(),
      Prec.highest(
        keymap.of([
          {
            key: 'ArrowDown',
            run: () => moveAutocompleteSelection(1),
          },
          {
            key: 'ArrowUp',
            run: () => moveAutocompleteSelection(-1),
          },
          {
            key: 'Enter',
            run: () => acceptActiveAutocomplete(),
          },
          {
            key: 'Tab',
            run: () => acceptActiveAutocomplete(),
          },
          {
            key: 'Escape',
            run: () => {
              if (!autocompleteState.value.open) return false
              closeAutocomplete()
              return true
            },
          },
          {
            key: 'Mod-b',
            run: (editorView) => toggleWrapFormatting(editorView, '**'),
          },
          {
            key: 'Mod-i',
            run: (editorView) => toggleWrapFormatting(editorView, '*'),
          },
          {
            key: 'Mod-Shift-x',
            run: (editorView) => toggleWrapFormatting(editorView, '~~'),
          },
          {
            key: 'Mod-e',
            run: (editorView) => toggleWrapFormatting(editorView, '`'),
          },
          {
            key: 'Mod-Enter',
            run: (editorView) => toggleChecklistLine(editorView),
          },
        ])
      ),
      keymap.of([...defaultKeymap, ...historyKeymap]),
      markdown(),
      EditorView.lineWrapping,
      editableCompartment.of([
        EditorView.editable.of(!props.disabled),
        EditorState.readOnly.of(props.disabled),
      ]),
      createLivePreviewExtension({
        sourcePath: props.sourcePath,
        knownFiles: props.knownFiles,
        aliasesByFile: props.aliasesByFile,
        indexComplete: props.indexComplete,
        cursorActive: props.autoFocus,
        vaultDirectory: props.vaultDirectory,
        allFiles: props.allFiles,
      }),
      EditorView.domEventHandlers({
        focus(_event, editorView) {
          editorView.dispatch({ effects: setCursorActiveEffect.of(true) })
        },
        blur(_event, editorView) {
          closeAutocomplete()
          editorView.dispatch({ effects: setCursorActiveEffect.of(false) })
        },
        paste(event, editorView) {
          if (props.disabled || typeof props.uploadImage !== 'function') return false
          const images = extractUploadableImages(event.clipboardData?.files)
          if (images.length === 0) return false
          event.preventDefault()
          void insertUploadedImages(images, editorView)
          return true
        },
        drop(event, editorView) {
          if (props.disabled || typeof props.uploadImage !== 'function') return false
          const images = extractUploadableImages(event.dataTransfer?.files)
          if (images.length === 0) return false
          event.preventDefault()
          const dropPos =
            typeof editorView.posAtCoords === 'function'
              ? editorView.posAtCoords({ x: event.clientX || 0, y: event.clientY || 0 })
              : null
          void insertUploadedImages(images, editorView, typeof dropPos === 'number' ? dropPos : null)
          return true
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternalUpdate) {
          emit('update:modelValue', update.state.doc.toString())
        }
        if ((update.docChanged || update.selectionSet) && !applyingExternalUpdate) {
          refreshAutocomplete(update.view)
        }
      }),
    ],
  })

  view = new EditorView({
    state,
    parent: editorHost.value,
  })

  if (editorHost.value) {
    Object.defineProperty(editorHost.value, 'value', {
      configurable: true,
      get: () => getText(),
      set: (val) => setText(val),
    })
  }

  if (props.autoFocus && !props.disabled) {
    focus()
  }
})

watch(
  () => props.modelValue,
  (nextValue) => {
    if (!view) return
    const current = view.state.doc.toString()
    if (nextValue === current) return
    applyingExternalUpdate = true
    try {
      const main = view.state.selection.main
      const clampedAnchor = Math.min(main.anchor, nextValue.length)
      const clampedHead = Math.min(main.head, nextValue.length)
      view.dispatch({
        changes: { from: 0, to: current.length, insert: nextValue },
        selection: { anchor: clampedAnchor, head: clampedHead },
      })
    } finally {
      applyingExternalUpdate = false
    }
  }
)

watch(
  () => props.disabled,
  (isDisabled) => {
    if (!view) return
    view.dispatch({
      effects: editableCompartment.reconfigure([
        EditorView.editable.of(!isDisabled),
        EditorState.readOnly.of(isDisabled),
      ]),
    })
  }
)

watch(
  () => [
    props.sourcePath,
    props.knownFiles,
    props.aliasesByFile,
    props.indexComplete,
    props.vaultDirectory,
    props.allFiles,
  ],
  ([sourcePath, knownFiles, aliasesByFile, indexComplete, vaultDirectory, allFiles]) => {
    if (!view) return
    view.dispatch({
      effects: setLivePreviewContextEffect.of({
        sourcePath,
        knownFiles: Array.isArray(knownFiles) ? [...knownFiles] : [],
        aliasesByFile: aliasesByFile && typeof aliasesByFile === 'object' ? { ...aliasesByFile } : {},
        indexComplete: indexComplete !== false,
        vaultDirectory: typeof vaultDirectory === 'string' ? vaultDirectory : '',
        allFiles: Array.isArray(allFiles) ? [...allFiles] : [],
      }),
    })
  },
  { deep: true }
)

onBeforeUnmount(() => {
  if (view) {
    view.destroy()
    view = null
  }
})

defineExpose({
  getText,
  setText,
  insertText,
  pasteText,
  setCursor,
  setSelection,
  getSelection,
  performUndo,
  performRedo,
  focus,
  scrollToOffset,
  getView,
})
</script>

<style scoped>
.markdown-editor-surface {
  width: 100%;
  min-height: 100%;
  border: none;
  background: transparent;
  color: var(--reading-text);
}

.markdown-editor-surface:focus-within {
  border: none;
  outline: none;
}

.markdown-editor-surface--disabled {
  opacity: 0.65;
  pointer-events: none;
}

:deep(.cm-editor) {
  min-height: 100%;
  background: transparent;
  outline: none;
  font-family: var(--reading-font-body);
  font-size: var(--reading-font-size);
  font-weight: 400;
  line-height: var(--reading-line-height);
}

:deep(.cm-scroller) {
  padding: 0.1rem 0 3.25rem;
  font-family: inherit;
}

:deep(.cm-content) {
  caret-color: var(--reading-caret);
  color: var(--reading-text);
}

:deep(.cm-focused) {
  outline: none;
}

:deep(.cm-line) {
  padding: 0.12rem 0;
}

:deep(.cm-live-syntax) {
  color: var(--reading-syntax);
  font-family: var(--reading-font-mono);
}

:deep(.cm-live-heading) {
  color: var(--reading-heading);
  font-family: var(--reading-font-heading);
  font-weight: 600;
  line-height: 1.3;
  letter-spacing: -0.01em;
  padding-top: 0.5rem;
  padding-bottom: 0.16rem;
}

:deep(.cm-live-heading:first-child) {
  padding-top: 0;
}

:deep(.cm-live-h1) {
  font-size: 1.75rem;
  font-weight: 600;
  line-height: 1.25;
  border-bottom: 1px solid var(--reading-border);
  margin-bottom: 0.32rem;
}

:deep(.cm-live-h2) {
  color: var(--reading-heading-secondary);
  font-size: 1.38rem;
  font-weight: 600;
  line-height: 1.3;
  padding-top: 0.65rem;
  border-bottom: 1px solid var(--reading-border-subtle);
  margin-bottom: 0.24rem;
}

:deep(.cm-live-h3) {
  color: var(--reading-heading-secondary);
  font-size: 1.18rem;
  font-weight: 500;
  line-height: 1.34;
  padding-top: 0.45rem;
}

:deep(.cm-live-h4) {
  color: var(--reading-heading-secondary);
  font-size: 1.06rem;
  font-weight: 500;
  line-height: 1.38;
}

:deep(.cm-live-h5),
:deep(.cm-live-h6) {
  font-size: 0.98rem;
  font-weight: 500;
  color: var(--reading-muted);
}

:deep(.cm-live-bold) {
  font-weight: 600;
  color: var(--reading-bold);
}

:deep(.cm-live-italic) {
  font-style: italic;
}

:deep(.cm-live-strikethrough) {
  text-decoration: line-through;
  color: var(--reading-muted);
}

:deep(.cm-live-highlight) {
  background: var(--reading-tag-bg);
  color: var(--reading-heading);
  padding: 0.02rem 0.24rem;
  border-radius: 3px;
}

:deep(.cm-live-inline-code) {
  font-family: var(--reading-font-mono);
  font-size: 0.88em;
  background: var(--reading-code-inline-bg);
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  color: var(--reading-code-text);
}

:deep(.cm-live-codeblock-fence) {
  font-family: var(--reading-font-mono);
  font-size: 0.82rem;
  color: var(--reading-syntax);
  background: var(--reading-code-bg);
  padding-inline: 0.85rem;
}

:deep(.cm-live-codeblock-fence-hidden) {
  color: var(--reading-syntax);
  font-size: 0.75rem;
}

:deep(.cm-live-codeblock-line) {
  font-family: var(--reading-font-mono);
  font-size: 0.88rem;
  line-height: 1.6;
  background: var(--reading-code-bg);
  padding-inline: 0.85rem;
  color: var(--reading-code-text);
}

:deep(.cm-live-blockquote) {
  border-left: 3px solid var(--reading-blockquote-border);
  padding-left: 1rem;
  background: var(--reading-blockquote-bg);
  color: var(--reading-blockquote-text);
  font-style: italic;
}

:deep(.cm-live-callout-badge) {
  color: var(--reading-accent);
  font-weight: 600;
}

:deep(.cm-live-list-item) {
  padding-left: 0.5rem;
}

:deep(.cm-live-list-bullet),
:deep(.cm-live-list-number),
:deep(.cm-live-checklist-marker) {
  color: var(--reading-accent);
  font-weight: 600;
}

:deep(.cm-live-checklist-marker:focus-visible) {
  outline: 2px solid var(--reading-focus-ring);
  outline-offset: 2px;
  border-radius: 3px;
}

:deep(.cm-live-checklist-checked .cm-live-checklist-text) {
  text-decoration: line-through;
  color: var(--reading-muted);
}

:deep(.cm-live-hr) {
  border-bottom: 1px solid var(--reading-border);
  margin: 0.6rem 0;
  min-height: 0.45rem;
}

:deep(.cm-live-table-row) {
  font-family: var(--reading-font-mono);
  font-size: 0.89rem;
  background: var(--reading-table-bg);
  border-left: 2px solid var(--reading-border);
  padding-left: 0.65rem;
}

:deep(.cm-live-table-delimiter) {
  color: var(--reading-muted);
}

:deep(.cm-live-table-pipe) {
  color: var(--reading-muted);
  font-weight: 600;
}

:deep(.cm-live-tag) {
  color: var(--reading-tag-text);
  background: var(--reading-tag-bg);
  border: 1px solid var(--reading-tag-border);
  border-radius: 4px;
  padding: 0.02rem 0.38rem;
  font-size: 0.87em;
}

:deep(.cm-live-comment) {
  color: var(--reading-syntax);
  font-style: italic;
}

:deep(.cm-live-math) {
  font-family: var(--reading-font-mono);
  color: var(--reading-code-text);
  background: var(--reading-code-inline-bg);
  padding: 0.05rem 0.25rem;
  border-radius: 3px;
}

:deep(.cm-live-footnote) {
  color: var(--reading-link);
}

:deep(.cm-live-link) {
  color: var(--reading-link);
  text-decoration: underline;
  text-underline-color: rgba(140, 207, 240, 0.45);
  text-underline-offset: 3px;
  cursor: pointer;
  border-radius: 2px;
  padding: 0 2px;
  transition: color 0.12s ease, background-color 0.12s ease;
}

:deep(.cm-live-link:visited) {
  color: var(--reading-link-visited);
}

:deep(.cm-live-link:hover) {
  background: var(--reading-link-hover-bg);
  color: var(--reading-link-hover);
}

:deep(.cm-live-link:focus-visible) {
  outline: 2px solid var(--reading-focus-ring);
  outline-offset: 2px;
}

:deep(.cm-editor.cm-focused .cm-live-link[data-editing="true"]) {
  outline: 2px solid var(--reading-link);
  outline-offset: 2px;
}

:deep(.cm-live-link--missing) {
  color: var(--ayame-link-unresolved, #92a0b9);
  text-decoration-style: dashed;
}

:deep(.cm-live-link--ambiguous) {
  color: var(--ayame-link-ambiguous, #e5be83);
  text-decoration-style: wavy;
}

:deep(.cm-live-link--invalid) {
  color: var(--ayame-error, #d8a6b0);
  text-decoration: line-through;
  cursor: not-allowed;
}

.markdown-editor-shell {
  position: relative;
  width: 100%;
  min-height: 100%;
}

:deep(.cm-live-image-wrap) {
  display: inline-block;
  max-width: 100%;
  margin: 0.45rem 0;
  vertical-align: middle;
}

:deep(.cm-live-image-embed) {
  display: block;
  max-width: 100%;
  max-height: 520px;
  width: auto;
  height: auto;
  border-radius: 6px;
  border: 1px solid var(--reading-control-border, rgba(169, 154, 202, 0.22));
  background: var(--reading-background-elevated, #1b1c25);
}

.editor-autocomplete {
  position: sticky;
  bottom: 0.75rem;
  z-index: 25;
  margin: 0.35rem 0 0;
  padding: 0.25rem;
  list-style: none;
  max-width: 24rem;
  background: var(--reading-background-elevated, #1b1c25);
  border: 1px solid var(--reading-control-border, #34323f);
  border-radius: 7px;
  box-shadow: 0 10px 26px rgba(8, 8, 12, 0.55);
}

.editor-autocomplete-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.65rem;
  padding: 0.36rem 0.55rem;
  border-radius: 4px;
  cursor: pointer;
  color: var(--reading-text);
  font-size: 0.85rem;
}

.editor-autocomplete-item:hover,
.editor-autocomplete-item--active {
  background: var(--reading-link-hover-bg, rgba(169, 154, 202, 0.16));
  color: var(--reading-heading);
}

.editor-autocomplete-label {
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.editor-autocomplete-hint {
  font-size: 0.75rem;
  color: var(--reading-syntax);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex-shrink: 1;
}
</style>
