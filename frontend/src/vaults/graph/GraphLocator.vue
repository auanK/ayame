<template>
  <div
    ref="rootRef"
    class="graph-locator"
    @focusout="emit('focusout', $event)"
    @pointerdown="emit('pointer-pending', true)"
    @pointerup="emit('pointer-pending', false)"
    @pointercancel="emit('pointer-pending', false)"
  >
    <input
      :value="query"
      type="search"
      class="graph-locator-input"
      data-testid="graph-node-locator"
      aria-label="Find note in graph"
      :aria-expanded="open ? 'true' : 'false'"
      :aria-controls="listId"
      placeholder="Find note…"
      @focus="emit('update:open', true)"
      @input="emit('update:query', $event.target.value); emit('update:open', true)"
      @keydown.down.prevent="emit('move-selection', 1)"
      @keydown.up.prevent="emit('move-selection', -1)"
      @keydown.enter.prevent="emit('open-highlighted')"
    />
    <ul
      v-if="open && matches.length > 0"
      :id="listId"
      class="graph-locator-results"
      role="listbox"
      aria-label="Notes in graph"
      data-testid="graph-locator-results"
    >
      <li
        v-for="(node, idx) in matches"
        :key="node.id"
        role="option"
        :aria-selected="idx === activeIndex ? 'true' : 'false'"
      >
        <button
          type="button"
          class="graph-locator-item"
          :class="{ 'graph-locator-item--active': idx === activeIndex }"
          data-testid="graph-locator-item"
          :data-note-path="node.path"
          @mousedown.prevent
          @mouseenter="emit('highlight', idx, node.path)"
          @focus="emit('highlight', idx, node.path)"
          @click="emit('select', node)"
        >
          <span class="graph-locator-label">{{ node.label }}</span>
          <span v-if="node.path !== `${node.label}.md`" class="graph-locator-path">
            {{ node.path }}
          </span>
        </button>
      </li>
    </ul>
  </div>
</template>

<script setup>
import { ref } from 'vue'

defineProps({
  query: { type: String, default: '' },
  open: { type: Boolean, default: false },
  listId: { type: String, required: true },
  matches: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
})

const emit = defineEmits([
  'update:query',
  'update:open',
  'focusout',
  'pointer-pending',
  'move-selection',
  'open-highlighted',
  'highlight',
  'select',
])

const rootRef = ref(null)
const contains = (el) => Boolean(rootRef.value && el && rootRef.value.contains(el))

defineExpose({ contains })
</script>
