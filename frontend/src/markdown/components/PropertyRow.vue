<template>
  <div
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
        @change="emit('change-type', prop, $event.target.value)"
      >
        <option v-for="t in propertyTypes" :key="t" :value="t">
          {{ typeLabel(t) }}
        </option>
      </select>

      <div class="property-key-editor">
        <input
          type="text"
          class="property-key-input"
          data-testid="property-key-input"
          :value="keyDraftValue"
          :disabled="disabled"
          :aria-invalid="Boolean(keyError)"
          :aria-describedby="keyError ? `property-key-error-${idx}` : undefined"
          list="vault-property-keys"
          @input="emit('input-key', prop.key, $event.target.value)"
          @keydown.enter.prevent="emit('rename-key', prop.key, $event.target.value)"
          @keydown.esc.stop.prevent="emit('cancel-key', prop.key)"
          @blur="emit('rename-key', prop.key, $event.target.value)"
        />
        <p
          v-if="keyError"
          :id="`property-key-error-${idx}`"
          class="properties-inline-error"
          data-testid="property-key-error"
          role="alert"
        >
          {{ keyError }}
        </p>
      </div>
    </div>

    <div class="property-value-cell">
      <!-- Tags property -->
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
            :aria-label="`Remove tag ${tag}`"
            @click="emit('remove-tag', prop, tag)"
          >
            ×
          </button>
        </span>
        <input
          :value="tagInput"
          type="text"
          class="chip-inline-input"
          data-testid="add-tag-input"
          placeholder="Add tag…"
          :disabled="disabled"
          @input="emit('update-tag-input', prop.key, $event.target.value)"
          @keydown.enter.prevent="emit('add-tag', prop)"
          @blur="emit('add-tag', prop)"
        />
      </div>

      <!-- List property -->
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
            @click="emit('open-link', item)"
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
            :aria-label="`Remove item ${item}`"
            @click="emit('remove-list-item', prop, itemIdx)"
          >
            ×
          </button>
        </span>
        <input
          :value="listInput"
          type="text"
          class="chip-inline-input"
          data-testid="add-list-item-input"
          placeholder="Add item…"
          :disabled="disabled"
          @input="emit('update-list-input', prop.key, $event.target.value)"
          @keydown.enter.prevent="emit('add-list-item', prop)"
          @blur="emit('add-list-item', prop)"
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
        @change="emit('update-value', prop.key, $event.target.checked, 'checkbox')"
      />

      <!-- Number -->
      <template v-else-if="prop.type === 'number'">
        <input
          type="text"
          inputmode="decimal"
          class="property-text-input"
          data-testid="property-number-input"
          :value="numberDraftValue"
          :disabled="disabled"
          :aria-label="`${prop.key} value`"
          :aria-invalid="Boolean(numberError)"
          :aria-describedby="numberError ? `property-number-error-${idx}` : undefined"
          @input="emit('input-number', prop, $event.target.value)"
          @keydown.enter.prevent="emit('commit-number', prop.key)"
          @keydown.esc.stop.prevent="emit('cancel-number', prop.key)"
          @blur="emit('commit-number', prop.key)"
        />
        <p
          v-if="numberError"
          :id="`property-number-error-${idx}`"
          class="properties-inline-error"
          data-testid="property-number-error"
          role="alert"
        >
          {{ numberError }}
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
        @input="emit('update-value', prop.key, $event.target.value, 'date')"
      />

      <!-- Date & time -->
      <input
        v-else-if="prop.type === 'datetime'"
        type="datetime-local"
        class="property-text-input"
        data-testid="property-datetime-input"
        :value="String(prop.value || '').slice(0, 16)"
        :disabled="disabled"
        @input="emit('update-value', prop.key, $event.target.value, 'datetime')"
      />

      <!-- Text -->
      <div v-else class="property-text-wrapper">
        <input
          type="text"
          class="property-text-input"
          data-testid="property-text-input"
          :value="typeof prop.value === 'object' ? JSON.stringify(prop.value) : prop.value"
          :disabled="disabled"
          @input="emit('update-value', prop.key, $event.target.value, 'text')"
        />
        <button
          v-if="isInternalLinkValue(prop.value)"
          type="button"
          class="property-link-pill"
          data-testid="property-link-pill"
          title="Open linked note"
          @click="emit('open-link', prop.value)"
        >
          {{ formatLinkDisplay(prop.value) }}
        </button>
      </div>
    </div>

    <div class="property-row-actions">
      <button
        type="button"
        class="property-action-btn"
        data-testid="move-property-up"
        :disabled="disabled || idx === 0"
        title="Move property up"
        aria-label="Move property up"
        @click="emit('move', idx, -1)"
      >
        ↑
      </button>
      <button
        type="button"
        class="property-action-btn"
        data-testid="move-property-down"
        :disabled="disabled || idx === totalCount - 1"
        title="Move property down"
        aria-label="Move property down"
        @click="emit('move', idx, 1)"
      >
        ↓
      </button>
      <button
        type="button"
        class="property-action-btn property-action-btn--danger"
        data-testid="remove-property-button"
        :disabled="disabled"
        title="Remove property"
        aria-label="Remove property"
        @click="emit('remove', prop.key)"
      >
        ×
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  prop: { type: Object, required: true },
  idx: { type: Number, required: true },
  totalCount: { type: Number, required: true },
  propertyTypes: { type: Array, required: true },
  typeLabel: { type: Function, required: true },
  disabled: { type: Boolean, default: false },
  keyDraftValue: { type: String, default: '' },
  keyError: { type: String, default: '' },
  tagInput: { type: String, default: '' },
  listInput: { type: String, default: '' },
  numberDraftValue: { type: String, default: '' },
  numberError: { type: String, default: '' },
  isInternalLinkValue: { type: Function, required: true },
  formatLinkDisplay: { type: Function, required: true },
})

const emit = defineEmits([
  'change-type',
  'input-key',
  'rename-key',
  'cancel-key',
  'select-tag',
  'remove-tag',
  'update-tag-input',
  'add-tag',
  'open-link',
  'remove-list-item',
  'update-list-input',
  'add-list-item',
  'update-value',
  'input-number',
  'commit-number',
  'cancel-number',
  'move',
  'remove',
])
</script>
