<script setup>
defineOptions({ name: 'PropertiesPanel' })
import { ref, computed, watch, onUnmounted } from 'vue'
import {
  PROPERTY_TYPES,
  parseNoteDocument,
  addPropertyToMarkdown,
  setPropertyInMarkdown,
  removePropertyFromMarkdown,
  renamePropertyInMarkdownResult,
  reorderPropertiesInMarkdown,
  replaceRawYamlInMarkdown,
  inferPropertyType,
  coercePropertyValue,
  isPropertyValueCompatible,
  parsePropertyNumber,
  validateTagName,
} from './properties.js'
import { parseWikilink } from './links.js'

const props = defineProps({
  markdown: { type: String, required: true },
  confirmedMarkdown: { type: String, default: null },
  disabled: { type: Boolean, default: false },
  knownPropertyNames: { type: Array, default: () => [] },
  knownPropertyTypes: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['update:markdown', 'select-tag', 'open-link', 'pending-change'])

const collapsed = ref(false)
const rawMode = ref(false)
const addingProperty = ref(false)
const newKey = ref('')
const newValue = ref('')
const newType = ref('text')
const tagInputs = ref({})
const listInputs = ref({})
const tagError = ref('')
const typeError = ref('')
const addPropertyError = ref('')
const numberDrafts = ref({})
const keyRenameDrafts = ref({})

const parsed = computed(() => parseNoteDocument(props.markdown, props.knownPropertyTypes))

const typeOverrideMap = ref({})

const effectiveProperties = computed(() =>
  parsed.value.properties.map((p) => {
    const override = typeOverrideMap.value[p.key]
    if (
      override &&
      PROPERTY_TYPES.includes(override) &&
      isPropertyValueCompatible(p.value, override, p.key)
    ) {
      return {
        ...p,
        type: override,
        value: coercePropertyValue(p.value, override),
      }
    }
    return p
  })
)

const hasNumberDrafts = computed(() => Object.keys(numberDrafts.value).length > 0)
const pendingNumberConflicts = computed(() => Object.entries(numberDrafts.value)
  .filter(([key, draft]) => draft.conflict &&
    !effectiveProperties.value.some((property) => property.key === key && property.type === 'number'))
  .map(([key, draft]) => ({ key, ...draft })))

const numberDraftConflict = (key, draft, current = effectiveProperties.value.find((property) => property.key === key)) => {
  if (!current) return `Property "${key}" was removed or renamed while you were editing. Your draft is preserved.`
  if (current.type !== draft.baseType) return `Property "${key}" changed type while you were editing. Your draft is preserved.`
  if (current.value !== draft.baseValue) return `Property "${key}" changed while you were editing. Your draft is preserved.`
  if (props.confirmedMarkdown !== null) {
    const confirmed = parseNoteDocument(props.confirmedMarkdown, props.knownPropertyTypes).properties.find((property) => property.key === key)
    if (!confirmed) return `Property "${key}" was removed or renamed while you were editing. Your draft is preserved.`
    if (confirmed.type !== draft.baseType) return `Property "${key}" changed type while you were editing. Your draft is preserved.`
    if (confirmed.value !== draft.baseValue) return `Property "${key}" changed while you were editing. Your draft is preserved.`
  }
  return ''
}

watch(() => [props.markdown, props.confirmedMarkdown], () => {
  const nextDrafts = { ...numberDrafts.value }
  for (const [key, draft] of Object.entries(nextDrafts)) {
    nextDrafts[key] = { ...draft, conflict: numberDraftConflict(key, draft) }
  }
  numberDrafts.value = nextDrafts

  const existingKeys = new Set(parsed.value.properties.map((property) => property.key))
  const nextKeyDrafts = { ...keyRenameDrafts.value }
  for (const key of Object.keys(nextKeyDrafts)) {
    if (!existingKeys.has(key)) delete nextKeyDrafts[key]
  }
  keyRenameDrafts.value = nextKeyDrafts
})

const suggestedKeys = computed(() => {
  const defaults = ['title', 'type', 'tags', 'aliases', 'status', 'created']
  const existing = new Set(parsed.value.properties.map((p) => p.key))
  const combined = new Set([...defaults, ...props.knownPropertyNames])
  return [...combined].filter((k) => !existing.has(k))
})

const typeLabel = (type) => type === 'datetime' ? 'Date & time' : `${type[0].toUpperCase()}${type.slice(1)}`

const isInternalLinkValue = (val) => {
  if (typeof val !== 'string') return false
  const trimmed = val.trim()
  return (
    (trimmed.startsWith('[[') && trimmed.endsWith(']]')) ||
    /^\[([^\]]+)\]\(([^)\n]+)\)$/.test(trimmed)
  )
}

const formatLinkDisplay = (val) => {
  const trimmed = String(val ?? '').trim()
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    const parsedLink = parseWikilink(trimmed)
    return parsedLink ? parsedLink.displayText : trimmed.slice(2, -2)
  }
  const mdMatch = trimmed.match(/^\[([^\]]+)\]\(([^)\n]+)\)$/)
  if (mdMatch) return mdMatch[1]
  return trimmed
}

const triggerLinkClick = (rawLink) => {
  const trimmed = String(rawLink ?? '').trim()
  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    emit('open-link', {
      type: 'unverified',
      rawTarget: trimmed,
      kind: 'wikilink',
    })
  } else {
    const mdMatch = trimmed.match(/^\[([^\]]+)\]\(([^)\n]+)\)$/)
    if (mdMatch) {
      emit('open-link', {
        type: 'unverified',
        rawTarget: mdMatch[2].trim(),
        kind: 'markdown',
      })
    }
  }
}

const updatePropertyValue = (key, nextValue, type) => {
  if (props.disabled) return
  typeError.value = ''
  const nextMd = setPropertyInMarkdown(props.markdown, key, nextValue, type)
  emit('update:markdown', nextMd)
}

const propertyKeyDraftValue = (prop) => keyRenameDrafts.value[prop.key]?.text ?? prop.key

const updatePropertyKeyDraft = (key, text) => {
  if (props.disabled) return
  keyRenameDrafts.value = {
    ...keyRenameDrafts.value,
    [key]: { text, error: '' },
  }
}

const cancelPropertyKeyDraft = (key) => {
  const nextDrafts = { ...keyRenameDrafts.value }
  delete nextDrafts[key]
  keyRenameDrafts.value = nextDrafts
}

const moveKeyedPropertyState = (state, oldKey, newKey) => {
  if (!Object.prototype.hasOwnProperty.call(state.value, oldKey)) return
  const nextState = { ...state.value, [newKey]: state.value[oldKey] }
  delete nextState[oldKey]
  state.value = nextState
}

const numberDraftValue = (prop) =>
  numberDrafts.value[prop.key]?.text ?? String(prop.value)

const updateNumberDraft = (prop, value) => {
  if (props.disabled) return
  const hadDrafts = hasNumberDrafts.value
  const draft = numberDrafts.value[prop.key] ?? {
    baseValue: prop.value,
    baseType: prop.type,
    conflict: '',
  }
  numberDrafts.value = {
    ...numberDrafts.value,
    [prop.key]: { ...draft, text: value, error: '' },
  }
  if (!hadDrafts) emit('pending-change', true)
}

const commitNumberDraft = (key) => {
  if (props.disabled) return
  const draft = numberDrafts.value[key]
  if (!draft) return
  const current = effectiveProperties.value.find((property) => property.key === key)
  const conflict = numberDraftConflict(key, draft, current)
  if (conflict) {
    numberDrafts.value = { ...numberDrafts.value, [key]: { ...draft, conflict } }
    return
  }

  const parsedNumber = parsePropertyNumber(draft.text)
  if (!parsedNumber.ok) {
    numberDrafts.value = { ...numberDrafts.value, [key]: { ...draft, error: 'Enter a valid number.' } }
    return
  }

  const nextDrafts = { ...numberDrafts.value }
  delete nextDrafts[key]
  numberDrafts.value = nextDrafts
  if (parsedNumber.value !== current.value) {
    updatePropertyValue(key, parsedNumber.value, 'number')
  }
  if (!Object.keys(nextDrafts).length) emit('pending-change', false)
}

const cancelNumberDraft = (key) => {
  if (!numberDrafts.value[key]) return
  const nextDrafts = { ...numberDrafts.value }
  delete nextDrafts[key]
  numberDrafts.value = nextDrafts
  if (!Object.keys(nextDrafts).length) emit('pending-change', false)
}

const discardPendingNumberEdits = () => {
  if (!hasNumberDrafts.value) return
  numberDrafts.value = {}
  emit('pending-change', false)
}

const getPendingEditSnapshot = () => ({
  numberDrafts: Object.fromEntries(Object.entries(numberDrafts.value).map(([key, draft]) => [key, { ...draft }])),
})

const restorePendingEditSnapshot = (snapshot) => {
  const entries = Object.entries(snapshot?.numberDrafts ?? {})
  if (entries.some(([key, draft]) => !key || typeof draft?.text !== 'string' || typeof draft.baseValue !== 'number' || draft.baseType !== 'number')) {
    return false
  }
  numberDrafts.value = Object.fromEntries(entries.map(([key, draft]) => {
    const valid = parsePropertyNumber(draft.text).ok
    return [key, {
      ...draft,
      conflict: numberDraftConflict(key, draft),
      error: draft.error && !valid ? draft.error : '',
    }]
  }))
  if (entries.length) emit('pending-change', true)
  return true
}

onUnmounted(() => {
  if (hasNumberDrafts.value) emit('pending-change', false)
})

defineExpose({ discardPendingNumberEdits, getPendingEditSnapshot, restorePendingEditSnapshot })

const handleTypeChange = (prop, nextType) => {
  if (props.disabled) return
  if (!isPropertyValueCompatible(prop.value, nextType, prop.key)) {
    typeError.value = `Cannot convert "${prop.key}" to ${typeLabel(nextType)} without changing its value. The original value was preserved.`
    return
  }
  const coerced = coercePropertyValue(prop.value, nextType)
  if (JSON.stringify(coercePropertyValue(coerced, prop.type)) !== JSON.stringify(prop.value)) {
    typeError.value = `Cannot convert "${prop.key}" to ${typeLabel(nextType)} without changing its value. The original value was preserved.`
    return
  }
  typeError.value = ''
  typeOverrideMap.value = { ...typeOverrideMap.value, [prop.key]: nextType }
  const nextMd = setPropertyInMarkdown(props.markdown, prop.key, coerced, nextType)
  emit('update:markdown', nextMd)
}

const handleKeyRename = (oldKey, nextKeyRaw) => {
  if (props.disabled) return
  const draft = keyRenameDrafts.value[oldKey]
  if (!draft) return

  const result = renamePropertyInMarkdownResult(props.markdown, oldKey, nextKeyRaw)
  if (!result.ok) {
    const message = {
      INVALID_PROPERTY_NAME: 'Enter a property name.',
      PROPERTY_ALREADY_EXISTS: 'A property with this name already exists.',
      PROPERTY_NOT_FOUND: 'This property no longer exists.',
      INVALID_YAML: 'Fix invalid YAML frontmatter before renaming a property.',
    }[result.reason] || 'This property could not be renamed.'
    keyRenameDrafts.value = {
      ...keyRenameDrafts.value,
      [oldKey]: { ...draft, text: String(nextKeyRaw ?? ''), error: message },
    }
    return
  }

  cancelPropertyKeyDraft(oldKey)
  if (!result.changed) return
  const newKey = String(nextKeyRaw).trim()
  moveKeyedPropertyState(typeOverrideMap, oldKey, newKey)
  moveKeyedPropertyState(tagInputs, oldKey, newKey)
  moveKeyedPropertyState(listInputs, oldKey, newKey)
  emit('update:markdown', result.markdown)
}

const handleRemoveProperty = (key) => {
  if (props.disabled) return
  const nextMd = removePropertyFromMarkdown(props.markdown, key)
  emit('update:markdown', nextMd)
}

const handleMoveProperty = (index, direction) => {
  if (props.disabled) return
  const keys = effectiveProperties.value.map((p) => p.key)
  const targetIndex = index + direction
  if (targetIndex < 0 || targetIndex >= keys.length) return
  const swapped = [...keys]
  const [moved] = swapped.splice(index, 1)
  swapped.splice(targetIndex, 0, moved)
  const nextMd = reorderPropertiesInMarkdown(props.markdown, swapped)
  emit('update:markdown', nextMd)
}

const addTagToProperty = (prop) => {
  if (props.disabled) return
  const raw = tagInputs.value[prop.key] || ''
  if (!raw.trim()) return
  const valid = validateTagName(raw)
  if (!valid) {
    tagError.value = 'Tags cannot contain spaces or invalid characters.'
    return
  }
  tagError.value = ''
  const current = Array.isArray(prop.value) ? prop.value : []
  if (!current.some((t) => String(t).toLowerCase() === valid.toLowerCase())) {
    updatePropertyValue(prop.key, [...current, valid], 'tags')
  }
  tagInputs.value = { ...tagInputs.value, [prop.key]: '' }
}

const removeTagFromProperty = (prop, tagToRemove) => {
  if (props.disabled) return
  const current = Array.isArray(prop.value) ? prop.value : []
  const next = current.filter((t) => t !== tagToRemove)
  updatePropertyValue(prop.key, next, 'tags')
}

const addListItem = (prop) => {
  if (props.disabled) return
  const raw = (listInputs.value[prop.key] || '').trim()
  if (!raw) return
  const current = Array.isArray(prop.value) ? prop.value : []
  updatePropertyValue(prop.key, [...current, raw], 'list')
  listInputs.value = { ...listInputs.value, [prop.key]: '' }
}

const removeListItem = (prop, index) => {
  if (props.disabled) return
  const current = Array.isArray(prop.value) ? [...prop.value] : []
  current.splice(index, 1)
  updatePropertyValue(prop.key, current, 'list')
}

const handleNewKeyInput = () => {
  addPropertyError.value = ''
  const key = newKey.value.trim()
  if (!key) return
  newType.value = inferPropertyType(key, newValue.value, props.knownPropertyTypes)
}

const startAddProperty = () => {
  if (props.disabled) return
  addingProperty.value = true
  newKey.value = ''
  newValue.value = ''
  newType.value = 'text'
  addPropertyError.value = ''
}

const newPropertyValue = (key) => {
  if (newType.value === 'number') return parsePropertyNumber(newValue.value)
  if (newType.value === 'checkbox' && !isPropertyValueCompatible(newValue.value, 'checkbox', key)) {
    return { ok: false, reason: 'INVALID_PROPERTY_VALUE' }
  }
  if (newType.value === 'tags') {
    const tags = newValue.value.trim() ? newValue.value.split(/[\s,]+/).filter(Boolean) : []
    if (tags.some((tag) => !validateTagName(tag))) {
      return { ok: false, reason: 'INVALID_PROPERTY_VALUE' }
    }
    return { ok: true, value: coercePropertyValue(tags, 'tags') }
  }

  const value = coercePropertyValue(newValue.value, newType.value)
  return isPropertyValueCompatible(value, newType.value, key)
    ? { ok: true, value }
    : { ok: false, reason: 'INVALID_PROPERTY_VALUE' }
}

const addPropertyErrorMessage = (reason) => {
  if (reason === 'INVALID_PROPERTY_NAME') return 'Enter a property name.'
  if (reason === 'PROPERTY_ALREADY_EXISTS') return 'A property with this name already exists.'
  if (reason === 'INVALID_YAML') return 'Fix invalid YAML frontmatter before adding a property.'
  return newType.value === 'number'
    ? 'Enter a valid number.'
    : `Enter a valid ${typeLabel(newType.value).toLowerCase()} value.`
}

const submitAddProperty = () => {
  if (props.disabled) return
  const key = newKey.value.trim()
  if (!key) {
    addPropertyError.value = addPropertyErrorMessage('INVALID_PROPERTY_NAME')
    return
  }
  if (!parsed.value.valid) {
    addPropertyError.value = addPropertyErrorMessage('INVALID_YAML')
    return
  }
  if (parsed.value.properties.some((property) => property.key.toLowerCase() === key.toLowerCase())) {
    addPropertyError.value = addPropertyErrorMessage('PROPERTY_ALREADY_EXISTS')
    return
  }

  const value = newPropertyValue(key)
  if (!value.ok) {
    addPropertyError.value = addPropertyErrorMessage(value.reason)
    return
  }
  const result = addPropertyToMarkdown(props.markdown, key, value.value, newType.value)
  if (!result.ok) {
    addPropertyError.value = addPropertyErrorMessage(result.reason)
    return
  }

  addPropertyError.value = ''
  addingProperty.value = false
  newKey.value = ''
  newValue.value = ''
  emit('update:markdown', result.markdown)
}

const handleRawYamlInput = (event) => {
  if (props.disabled) return
  const nextMd = replaceRawYamlInMarkdown(props.markdown, event.target.value)
  emit('update:markdown', nextMd)
}
</script>

<template>
  <section class="properties-panel" data-testid="properties-panel">
    <header class="properties-header">
      <button
        type="button"
        class="properties-toggle"
        data-testid="toggle-properties-collapse"
        :aria-expanded="!collapsed ? 'true' : 'false'"
        @click="collapsed = !collapsed"
      >
        <span class="properties-chevron" aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
        <span class="properties-title">Properties</span>
        <span v-if="effectiveProperties.length" class="properties-count">
          {{ effectiveProperties.length }}
        </span>
      </button>

      <div class="properties-header-actions">
        <button
          v-if="parsed.hasFrontmatter || rawMode"
          type="button"
          class="properties-action-btn"
          data-testid="toggle-yaml-source-button"
          :disabled="disabled || hasNumberDrafts"
          :title="hasNumberDrafts ? 'Confirm or cancel Number edits before editing raw YAML.' : undefined"
          @click="rawMode = !rawMode"
        >
          {{ rawMode ? 'Properties view' : 'Source YAML' }}
        </button>
      </div>
    </header>

    <p v-if="typeError" class="properties-inline-error" data-testid="property-type-error" role="alert">
      {{ typeError }}
    </p>

    <div v-if="!collapsed" class="properties-body">
      <div
        v-for="pending in pendingNumberConflicts"
        :key="pending.key"
        class="properties-inline-error"
        data-testid="pending-number-conflict"
        role="alert"
      >
        <span>{{ pending.conflict }} Draft: {{ pending.text }}</span>
        <button
          type="button"
          class="properties-action-btn"
          data-testid="cancel-number-conflict"
          @click="cancelNumberDraft(pending.key)"
        >
          Cancel edit
        </button>
      </div>
      <div
        v-if="!parsed.valid"
        class="properties-yaml-error"
        data-testid="properties-yaml-error"
        role="alert"
      >
        <p class="yaml-error-title">Invalid YAML frontmatter: {{ parsed.error }}</p>
        <p class="yaml-error-hint">Fix the raw YAML below to restore structured properties.</p>
        <textarea
          class="raw-yaml-textarea"
          data-testid="raw-yaml-textarea"
          :value="parsed.rawYaml"
          :disabled="disabled"
          rows="5"
          @input="handleRawYamlInput"
        />
      </div>

      <div v-else-if="rawMode" class="raw-yaml-container">
        <textarea
          class="raw-yaml-textarea"
          data-testid="raw-yaml-textarea"
          :value="parsed.rawYaml"
          :disabled="disabled"
          rows="6"
          placeholder="title: Note Title&#10;tags: []"
          @input="handleRawYamlInput"
        />
      </div>

      <template v-else>
        <div v-if="effectiveProperties.length > 0" class="properties-table">
          <div
            v-for="(prop, idx) in effectiveProperties"
            :key="prop.key"
            class="property-row"
            data-testid="property-row"
            :data-property-key="prop.key"
          >
            <div class="property-key-cell">
              <label class="sr-only" :for="`prop-type-${prop.key}`">Type</label>
              <select
                :id="`prop-type-${prop.key}`"
                class="property-type-select"
                data-testid="property-type-select"
                :value="prop.type"
                :disabled="disabled || prop.key.toLowerCase() === 'tags'"
                :title="`Property type: ${typeLabel(prop.type)}`"
                @change="handleTypeChange(prop, $event.target.value)"
              >
                <option v-for="t in PROPERTY_TYPES" :key="t" :value="t">
                  {{ typeLabel(t) }}
                </option>
              </select>

              <div class="property-key-editor">
                <input
                  type="text"
                  class="property-key-input"
                  data-testid="property-key-input"
                  :value="propertyKeyDraftValue(prop)"
                  :disabled="disabled"
                  :aria-invalid="Boolean(keyRenameDrafts[prop.key]?.error)"
                  :aria-describedby="keyRenameDrafts[prop.key]?.error ? `property-key-error-${idx}` : undefined"
                  list="vault-property-keys"
                  @input="updatePropertyKeyDraft(prop.key, $event.target.value)"
                  @keydown.enter.prevent="handleKeyRename(prop.key, $event.target.value)"
                  @keydown.esc.stop.prevent="cancelPropertyKeyDraft(prop.key)"
                  @blur="handleKeyRename(prop.key, $event.target.value)"
                />
                <p
                  v-if="keyRenameDrafts[prop.key]?.error"
                  :id="`property-key-error-${idx}`"
                  class="properties-inline-error"
                  data-testid="property-key-error"
                  role="alert"
                >
                  {{ keyRenameDrafts[prop.key].error }}
                </p>
              </div>
            </div>

            <div class="property-value-cell">
              <!-- Tags property (chips) -->
              <div v-if="prop.type === 'tags'" class="property-chips-container">
                <span
                  v-for="tag in prop.value"
                  :key="tag"
                  class="property-chip property-tag-chip"
                >
                  <button
                    type="button"
                    class="chip-label-btn"
                    data-testid="property-tag-chip"
                    :data-tag="tag"
                    @click="emit('select-tag', tag)"
                  >
                    {{ tag }}
                  </button>
                  <button
                    type="button"
                    class="chip-remove-btn"
                    data-testid="remove-tag-button"
                    :data-tag="tag"
                    :disabled="disabled"
                    aria-label="Remove tag"
                    @click="removeTagFromProperty(prop, tag)"
                  >
                    ×
                  </button>
                </span>
                <input
                  v-model="tagInputs[prop.key]"
                  type="text"
                  class="chip-inline-input"
                  data-testid="add-tag-input"
                  placeholder="Add tag…"
                  :disabled="disabled"
                  @keydown.enter.prevent="addTagToProperty(prop)"
                  @blur="addTagToProperty(prop)"
                />
              </div>

              <!-- List property (chips + clickable internal links) -->
              <div v-else-if="prop.type === 'list'" class="property-chips-container">
                <span
                  v-for="(item, itemIdx) in prop.value"
                  :key="`${item}-${itemIdx}`"
                  class="property-chip"
                  :class="{ 'property-chip--link': isInternalLinkValue(item) }"
                >
                  <button
                    v-if="isInternalLinkValue(item)"
                    type="button"
                    class="chip-label-btn chip-label-btn--link"
                    data-testid="property-list-chip"
                    data-is-link="true"
                    @click="triggerLinkClick(item)"
                  >
                    {{ formatLinkDisplay(item) }}
                  </button>
                  <span
                    v-else
                    class="chip-label"
                    data-testid="property-list-chip"
                    data-is-link="false"
                  >
                    {{ item }}
                  </span>
                  <button
                    type="button"
                    class="chip-remove-btn"
                    data-testid="remove-list-item-button"
                    :disabled="disabled"
                    @click="removeListItem(prop, itemIdx)"
                  >
                    ×
                  </button>
                </span>
                <input
                  v-model="listInputs[prop.key]"
                  type="text"
                  class="chip-inline-input"
                  data-testid="add-list-item-input"
                  placeholder="Add item…"
                  :disabled="disabled"
                  @keydown.enter.prevent="addListItem(prop)"
                  @blur="addListItem(prop)"
                />
              </div>

              <!-- Checkbox -->
              <input
                v-else-if="prop.type === 'checkbox'"
                type="checkbox"
                class="property-checkbox-input"
                data-testid="property-checkbox-input"
                :checked="Boolean(prop.value)"
                :disabled="disabled"
                @change="updatePropertyValue(prop.key, $event.target.checked, 'checkbox')"
              />

              <!-- Number -->
              <template v-else-if="prop.type === 'number'">
                <input
                  type="text"
                  inputmode="decimal"
                  class="property-text-input"
                  data-testid="property-number-input"
                  :value="numberDraftValue(prop)"
                  :disabled="disabled"
                  :aria-label="`${prop.key} value`"
                  :aria-invalid="Boolean(numberDrafts[prop.key]?.error || numberDrafts[prop.key]?.conflict)"
                  :aria-describedby="numberDrafts[prop.key]?.error || numberDrafts[prop.key]?.conflict ? `property-number-error-${idx}` : undefined"
                  @input="updateNumberDraft(prop, $event.target.value)"
                  @keydown.enter.prevent="commitNumberDraft(prop.key)"
                  @keydown.esc.stop.prevent="cancelNumberDraft(prop.key)"
                  @blur="commitNumberDraft(prop.key)"
                />
                <p
                  v-if="numberDrafts[prop.key]?.error || numberDrafts[prop.key]?.conflict"
                  :id="`property-number-error-${idx}`"
                  class="properties-inline-error"
                  data-testid="property-number-error"
                  role="alert"
                >
                  {{ numberDrafts[prop.key]?.conflict || numberDrafts[prop.key]?.error }}
                </p>
              </template>

              <!-- Date -->
              <input
                v-else-if="prop.type === 'date'"
                type="date"
                class="property-text-input"
                data-testid="property-date-input"
                :value="prop.value"
                :disabled="disabled"
                @input="updatePropertyValue(prop.key, $event.target.value, 'date')"
              />

              <!-- Date & time -->
              <input
                v-else-if="prop.type === 'datetime'"
                type="datetime-local"
                class="property-text-input"
                data-testid="property-datetime-input"
                :value="String(prop.value || '').slice(0, 16)"
                :disabled="disabled"
                @input="updatePropertyValue(prop.key, $event.target.value, 'datetime')"
              />

              <!-- Text (with optional link pill if value is a wikilink) -->
              <div v-else class="property-text-wrapper">
                <input
                  type="text"
                  class="property-text-input"
                  data-testid="property-text-input"
                  :value="typeof prop.value === 'object' ? JSON.stringify(prop.value) : prop.value"
                  :disabled="disabled"
                  @input="updatePropertyValue(prop.key, $event.target.value, 'text')"
                />
                <button
                  v-if="isInternalLinkValue(prop.value)"
                  type="button"
                  class="property-link-pill"
                  data-testid="property-link-pill"
                  title="Open linked note"
                  @click="triggerLinkClick(prop.value)"
                >
                  ↗ {{ formatLinkDisplay(prop.value) }}
                </button>
              </div>
            </div>

            <div class="property-row-actions">
              <button
                type="button"
                class="property-icon-btn"
                data-testid="move-property-up"
                :disabled="disabled || idx === 0"
                title="Move property up"
                @click="handleMoveProperty(idx, -1)"
              >
                ↑
              </button>
              <button
                type="button"
                class="property-icon-btn"
                data-testid="move-property-down"
                :disabled="disabled || idx === effectiveProperties.length - 1"
                title="Move property down"
                @click="handleMoveProperty(idx, 1)"
              >
                ↓
              </button>
              <button
                type="button"
                class="property-icon-btn property-icon-btn--danger"
                data-testid="remove-property-button"
                :disabled="disabled"
                title="Remove property"
                @click="handleRemoveProperty(prop.key)"
              >
                ×
              </button>
            </div>
          </div>
        </div>

        <p v-if="tagError" class="properties-inline-error" role="alert">{{ tagError }}</p>

        <div v-if="addingProperty" class="property-add-form">
          <input
            v-model="newKey"
            type="text"
            class="property-key-input"
            data-testid="new-property-key-input"
            placeholder="Property name (e.g. type)"
            list="vault-property-keys"
            :disabled="disabled"
            @input="handleNewKeyInput"
            @keydown.enter.prevent="submitAddProperty"
          />
          <select
            v-model="newType"
            class="property-type-select"
            data-testid="new-property-type-select"
            :disabled="disabled"
            @change="addPropertyError = ''"
          >
            <option v-for="t in PROPERTY_TYPES" :key="t" :value="t">
              {{ typeLabel(t) }}
            </option>
          </select>
          <input
            v-model="newValue"
            type="text"
            class="property-text-input"
            data-testid="new-property-value-input"
            placeholder="Value"
            :disabled="disabled"
            @input="addPropertyError = ''"
            @keydown.enter.prevent="submitAddProperty"
          />
          <button
            type="button"
            class="properties-action-btn properties-action-btn--primary"
            data-testid="new-property-submit"
            :disabled="disabled"
            @click="submitAddProperty"
          >
            Add
          </button>
          <button
            type="button"
            class="properties-action-btn"
            data-testid="new-property-cancel"
            @click="addingProperty = false"
          >
            Cancel
          </button>
          <p
            v-if="addPropertyError"
            class="properties-inline-error"
            data-testid="property-add-error"
            role="alert"
          >
            {{ addPropertyError }}
          </p>
        </div>

        <button
          v-else
          type="button"
          class="add-property-btn"
          data-testid="add-property-button"
          :disabled="disabled"
          @click="startAddProperty"
        >
          + Add property
        </button>

        <datalist id="vault-property-keys">
          <option v-for="k in suggestedKeys" :key="k" :value="k" />
        </datalist>
      </template>
    </div>
  </section>
</template>

<style scoped>
.properties-panel {
  margin-bottom: 1rem;
  padding-bottom: 0.75rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.properties-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.45rem;
}

.properties-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  background: transparent;
  border: none;
  color: var(--ayame-muted);
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0.2rem 0.3rem;
  border-radius: 4px;
  cursor: pointer;
}

.properties-toggle:hover {
  color: var(--ayame-text);
  background-color: rgba(255, 255, 255, 0.04);
}

.properties-count {
  font-size: 0.7rem;
  padding: 0.05rem 0.38rem;
  border-radius: 999px;
  background-color: rgba(169, 154, 202, 0.14);
  color: var(--ayame-lavender);
}

.properties-action-btn {
  padding: 0.2rem 0.5rem;
  font-size: 0.74rem;
  background: transparent;
  color: var(--ayame-muted);
  border: 1px solid var(--ayame-border);
  border-radius: 5px;
  cursor: pointer;
}

.properties-action-btn:hover {
  color: var(--ayame-primary);
  border-color: var(--ayame-primary);
}

.properties-action-btn--primary {
  background-color: var(--ayame-primary);
  color: #111218;
  border-color: var(--ayame-primary);
  font-weight: 600;
}

.properties-table {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.property-row {
  display: grid;
  grid-template-columns: 220px minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.5rem;
  padding: 0.22rem 0.35rem;
  border-radius: 6px;
  transition: background-color 0.12s ease;
}

.property-row:hover {
  background-color: rgba(255, 255, 255, 0.025);
}

.property-key-cell {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}

.property-key-editor {
  flex: 1;
  min-width: 0;
}

.property-type-select {
  color-scheme: dark;
  width: 7rem;
  flex: 0 0 7rem;
  padding: 0.25rem 0.4rem;
  background-color: var(--ayame-surface, #1b1c25);
  color: var(--ayame-text, #eeeaf3);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  font-size: 0.78rem;
  cursor: pointer;
}

.property-type-select option {
  color: #eeeaf3;
  background: #1b1c25;
}

.property-type-select:focus-visible {
  outline: 2px solid var(--ayame-primary, #a99aca);
  outline-offset: 1px;
}

.property-type-select:hover:not(:disabled) {
  border-color: var(--ayame-primary, #a99aca);
}

.property-key-input {
  width: 100%;
  min-width: 0;
  padding: 0.22rem 0.35rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--ayame-muted);
  font-size: 0.82rem;
}

.property-key-input:focus {
  outline: none;
  border-color: var(--ayame-primary);
  color: var(--ayame-text);
  background-color: rgba(17, 18, 24, 0.5);
}

.property-value-cell {
  display: flex;
  align-items: center;
  min-width: 0;
}

.property-text-wrapper {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  width: 100%;
}

.property-text-input {
  width: 100%;
  padding: 0.24rem 0.45rem;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 4px;
  color: var(--ayame-text);
  font-size: 0.85rem;
}

.property-text-input:focus {
  outline: none;
  border-color: var(--ayame-primary);
  background-color: rgba(17, 18, 24, 0.5);
}

.property-link-pill {
  flex-shrink: 0;
  padding: 0.15rem 0.45rem;
  background-color: rgba(140, 207, 240, 0.1);
  color: var(--ayame-link, #8ccff0);
  border: 1px solid rgba(140, 207, 240, 0.3);
  border-radius: 999px;
  font-size: 0.75rem;
  cursor: pointer;
}

.property-link-pill:hover {
  color: var(--ayame-link-hover, #b5e2f8);
}

.property-link-pill:focus-visible,
.chip-label-btn--link:focus-visible {
  outline: 2px solid var(--ayame-link, #8ccff0);
  outline-offset: 2px;
}

.property-chips-container {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  width: 100%;
  padding: 0.15rem 0.25rem;
}

.property-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  padding: 0.1rem 0.5rem;
  background-color: rgba(169, 154, 202, 0.16);
  border: 1px solid rgba(169, 154, 202, 0.3);
  border-radius: 999px;
  font-size: 0.78rem;
  color: var(--ayame-lavender);
}

.chip-label-btn {
  background: transparent;
  border: none;
  color: inherit;
  font: inherit;
  padding: 0;
  cursor: pointer;
}

.chip-label-btn--link {
  text-decoration: underline;
  color: var(--ayame-link, #8ccff0);
}

.chip-label-btn--link:hover {
  color: var(--ayame-link-hover, #b5e2f8);
}

.chip-remove-btn {
  background: transparent;
  border: none;
  color: var(--ayame-muted);
  font-size: 0.85rem;
  line-height: 1;
  padding: 0 0.1rem;
  cursor: pointer;
}

.chip-remove-btn:hover {
  color: var(--ayame-text);
}

.chip-inline-input {
  flex: 1;
  min-width: 85px;
  padding: 0.18rem 0.3rem;
  background: transparent;
  border: none;
  color: var(--ayame-text);
  font-size: 0.8rem;
}

.chip-inline-input:focus {
  outline: none;
}

.property-row-actions {
  display: flex;
  align-items: center;
  gap: 0.15rem;
  opacity: 0.65;
}

.property-row:hover .property-row-actions {
  opacity: 1;
}

.property-icon-btn {
  background: transparent;
  border: none;
  color: var(--ayame-muted);
  font-size: 0.78rem;
  padding: 0.15rem 0.3rem;
  border-radius: 4px;
  cursor: pointer;
}

.property-icon-btn:hover:not(:disabled) {
  color: var(--ayame-text);
  background-color: rgba(255, 255, 255, 0.06);
}

.property-icon-btn--danger:hover:not(:disabled) {
  color: var(--ayame-error);
}

.add-property-btn {
  margin-top: 0.35rem;
  padding: 0.25rem 0.45rem;
  background: transparent;
  border: none;
  color: var(--ayame-muted);
  font-size: 0.8rem;
  cursor: pointer;
  border-radius: 4px;
}

.add-property-btn:hover:not(:disabled) {
  color: var(--ayame-primary);
  background-color: rgba(169, 154, 202, 0.08);
}

.property-add-form {
  margin-top: 0.4rem;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  padding: 0.4rem;
  background-color: rgba(17, 18, 24, 0.45);
  border: 1px solid var(--ayame-border);
  border-radius: 6px;
}

.raw-yaml-textarea {
  width: 100%;
  padding: 0.55rem 0.7rem;
  background-color: rgba(17, 18, 24, 0.65);
  border: 1px solid var(--ayame-border);
  border-radius: 6px;
  color: var(--ayame-text);
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-size: 0.82rem;
  line-height: 1.45;
}

.properties-yaml-error {
  padding: 0.65rem;
  border-radius: 6px;
  background-color: var(--ayame-error-bg);
  border: 1px solid var(--ayame-error-border);
  color: var(--ayame-error);
}

.yaml-error-title {
  margin: 0 0 0.2rem;
  font-size: 0.82rem;
  font-weight: 600;
}

.yaml-error-hint {
  margin: 0 0 0.5rem;
  font-size: 0.76rem;
  color: var(--ayame-text);
}

.properties-inline-error {
  margin: 0.3rem 0 0;
  font-size: 0.76rem;
  color: var(--ayame-error);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  border: 0;
}
</style>
