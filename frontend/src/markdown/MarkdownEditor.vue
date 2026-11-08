<template>
  <div
    ref="editorHost"
    class="markdown-editor-surface"
    :class="{ 'markdown-editor-surface--disabled': disabled }"
    data-testid="markdown-editor"
    aria-label="Markdown editor"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="handleSurfaceClick"
  ></div>
</template>

<script setup>
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { Compartment, EditorState } from '@codemirror/state'
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
})

const emit = defineEmits(['update:modelValue', 'open-link', 'click-tag'])

const editorHost = ref(null)
const editableCompartment = new Compartment()
let view = null
let applyingExternalUpdate = false

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
      }),
      EditorView.domEventHandlers({
        focus(_event, editorView) {
          editorView.dispatch({ effects: setCursorActiveEffect.of(true) })
        },
        blur(_event, editorView) {
          editorView.dispatch({ effects: setCursorActiveEffect.of(false) })
        },
      }),
      EditorView.updateListener.of((update) => {
        if (update.docChanged && !applyingExternalUpdate) {
          emit('update:modelValue', update.state.doc.toString())
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
  () => [props.sourcePath, props.knownFiles, props.aliasesByFile, props.indexComplete],
  ([sourcePath, knownFiles, aliasesByFile, indexComplete]) => {
    if (!view) return
    view.dispatch({
      effects: setLivePreviewContextEffect.of({
        sourcePath,
        knownFiles: Array.isArray(knownFiles) ? [...knownFiles] : [],
        aliasesByFile: aliasesByFile && typeof aliasesByFile === 'object' ? { ...aliasesByFile } : {},
        indexComplete: indexComplete !== false,
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
  color: var(--workspace-text-normal, var(--ayame-text, #dcddde));
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
  font-family: var(--workspace-font-editor, system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif);
  font-size: 0.975rem;
  line-height: 1.68;
}

:deep(.cm-scroller) {
  padding: 0.5rem 0 3rem;
  font-family: inherit;
}

:deep(.cm-content) {
  caret-color: var(--ayame-lavender, #d4cbe4);
  color: var(--ayame-text, #eeeaf3);
}

:deep(.cm-focused) {
  outline: none;
}

:deep(.cm-line) {
  padding: 0.1rem 0;
}

:deep(.cm-live-syntax) {
  color: var(--ayame-text-muted, #aaa6b8);
  opacity: 0.7;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}

:deep(.cm-live-heading) {
  color: #fff;
  font-family: Georgia, 'Times New Roman', serif;
  font-weight: 600;
  line-height: 1.3;
  padding-top: 0.45rem;
  padding-bottom: 0.2rem;
}

:deep(.cm-live-h1) {
  font-size: 1.75rem;
  border-bottom: 1px solid rgba(212, 203, 228, 0.15);
  margin-bottom: 0.35rem;
}

:deep(.cm-live-h2) {
  font-size: 1.4rem;
  border-bottom: 1px solid rgba(212, 203, 228, 0.1);
  margin-bottom: 0.25rem;
}

:deep(.cm-live-h3) {
  font-size: 1.2rem;
}

:deep(.cm-live-h4) {
  font-size: 1.075rem;
}

:deep(.cm-live-h5),
:deep(.cm-live-h6) {
  font-size: 0.975rem;
  color: var(--ayame-lavender, #d4cbe4);
}

:deep(.cm-live-bold) {
  font-weight: 700;
  color: #fff;
}

:deep(.cm-live-italic) {
  font-style: italic;
}

:deep(.cm-live-strikethrough) {
  text-decoration: line-through;
  color: var(--ayame-text-muted, #aaa6b8);
}

:deep(.cm-live-inline-code) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88em;
  background: rgba(212, 203, 228, 0.12);
  padding: 0.1rem 0.35rem;
  border-radius: 3px;
  color: #f1eef8;
}

:deep(.cm-live-codeblock-fence) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.82rem;
  color: var(--ayame-text-muted, #aaa6b8);
  background: #0b0c10;
  padding-inline: 0.75rem;
}

:deep(.cm-live-codeblock-fence-hidden) {
  opacity: 0.35;
  font-size: 0.75rem;
}

:deep(.cm-live-codeblock-line) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.88rem;
  background: #0b0c10;
  padding-inline: 0.75rem;
  color: #e9e4f5;
}

:deep(.cm-live-blockquote) {
  border-left: 3px solid var(--ayame-primary, #a99aca);
  padding-left: 0.9rem;
  background: rgba(169, 154, 202, 0.06);
  color: rgba(212, 203, 228, 0.9);
  font-style: italic;
}

:deep(.cm-live-list-item) {
  padding-left: 0.5rem;
}

:deep(.cm-live-list-bullet),
:deep(.cm-live-list-number),
:deep(.cm-live-checklist-marker) {
  color: var(--ayame-primary, #a99aca);
  font-weight: 600;
}

:deep(.cm-live-checklist-checked .cm-live-checklist-text) {
  text-decoration: line-through;
  color: var(--ayame-text-muted, #aaa6b8);
}

:deep(.cm-live-hr) {
  border-bottom: 1px solid rgba(212, 203, 228, 0.25);
  margin: 0.5rem 0;
  min-height: 0.5rem;
}

:deep(.cm-live-table-row) {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.9rem;
  background: rgba(17, 18, 24, 0.55);
  border-left: 2px solid rgba(169, 154, 202, 0.25);
  padding-left: 0.5rem;
}

:deep(.cm-live-table-delimiter) {
  color: var(--ayame-text-muted, #aaa6b8);
}

:deep(.cm-live-table-pipe) {
  color: var(--ayame-primary, #a99aca);
  font-weight: 600;
}

:deep(.cm-live-link) {
  color: var(--ayame-link, #8ccff0);
  text-decoration: underline;
  text-underline-offset: 3px;
  cursor: pointer;
  border-radius: 2px;
  padding: 0 2px;
}

:deep(.cm-live-link:hover) {
  background: rgba(140, 207, 240, 0.15);
  color: var(--ayame-link-hover, #b5e2f8);
}

:deep(.cm-editor.cm-focused .cm-live-link[data-editing="true"]) {
  outline: 2px solid var(--ayame-link, #8ccff0);
  outline-offset: 2px;
}

:deep(.cm-live-link--missing) {
  color: var(--ayame-link-unresolved, #8b99b2);
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
</style>
