<template>
  <div
    ref="grid"
    class="mural-board"
    @pointerdown="startPointer"
    @click.capture="suppressDragClick"
    @dragstart.prevent
  >
    <section v-for="section in sections" :key="section.group" class="mural-section" :aria-label="section.label">
      <h4>{{ section.label }}</h4>
      <div class="mural-grid" :class="{ 'mural-grid--packed': packed }">
        <div
          v-for="card in section.cards"
          :key="card.id"
          :data-mural-tile="card.id"
          class="mural-tile"
          :class="{
            'mural-tile--dragging': drag?.id === card.id,
            'mural-tile--before': destination?.id === card.id && destination.placement === 'before',
            'mural-tile--after': destination?.id === card.id && destination.placement === 'after',
          }"
        >
          <button
            type="button"
            class="mural-card"
            :class="{ 'mural-card--with-image': card.imageVersion, 'mural-card--image-only': card.kind === 'image' && card.imageVersion }"
            :style="{ '--mural-accent': muralAccent(card.color) }"
            :disabled="disabled"
            :data-card-id="card.id"
            :aria-label="card.kind === 'image' && !card.title ? 'Open image card' : undefined"
            @click="emit('open', card.id, $event.currentTarget)"
          >
            <img
              v-if="card.imageVersion"
              class="mural-card-image"
              :src="getMuralImageUrl(card.id, card.imageVersion)"
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
            />
            <span v-if="card.kind !== 'image' || card.title" class="mural-card-content">
              <strong v-if="card.title || !card.preview">{{ card.title || 'Untitled' }}</strong>
              <span v-if="card.preview" class="mural-card-preview">{{ card.preview }}</span>
            </span>
          </button>
          <button
            v-if="cards.length > 1"
            type="button"
            class="mural-drag-handle"
            data-mural-drag-handle
            :aria-label="`Reorder ${cardLabel(card)}`"
            title="Drag to reorder · Up or Down to move"
            :aria-disabled="reorderDisabled || disabled"
            @keydown.up.prevent="moveWithKeyboard(card.id, -1)"
            @keydown.down.prevent="moveWithKeyboard(card.id, 1)"
          ><span aria-hidden="true" /></button>
        </div>
      </div>
      <button v-if="section.hasMore" type="button" class="btn btn-secondary btn-compact mural-more" :disabled="loading || moving" @click="emit('more', section.group)">
        {{ loading ? 'Loading…' : section.group === 'pinned' ? 'Load more pinned notes' : 'Load more notes' }}
      </button>
    </section>
    <Teleport to="body">
      <span
        v-if="drag"
        class="mural-drag-preview"
        :style="{ transform: `translate(${drag.x + 14}px, ${drag.y + 12}px)` }"
        aria-hidden="true"
      >{{ drag.label }}</span>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { getMuralImageUrl } from './api.js'
import { muralAccent } from './colors.js'

const props = defineProps({
  sections: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  moving: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  reorderDisabled: { type: Boolean, default: false },
})

const emit = defineEmits(['open', 'reorder', 'more'])
const cards = computed(() => props.sections.flatMap((section) => section.cards))
const grid = ref(null)
const packed = ref(false)
const drag = shallowRef(null)
const destination = shallowRef(null)
const observedTiles = new Set()
let observer
let pointer
let scrollFrame
let blockClickUntil = 0

const cardLabel = (card) => card.title || card.preview?.trim().slice(0, 48) || (card.kind === 'image' ? 'Image card' : 'Untitled note')

const sizeTiles = (tiles) => {
  if (!grid.value) return
  const measurements = []
  for (const tile of tiles) {
    if (!tile.parentElement) continue
    const gap = Number.parseFloat(getComputedStyle(tile.parentElement).columnGap) || 0
    const rows = Math.ceil(tile.getBoundingClientRect().height + gap)
    const image = tile.querySelector('.mural-card--image-only .mural-card-image')
    measurements.push({ tile, rows, imageWidth: image?.getBoundingClientRect().width })
  }
  for (const { tile, rows, imageWidth } of measurements) {
    tile.style.setProperty('--mural-card-rows', String(Math.max(1, rows)))
    // Match the caption to the image after both size limits have been applied.
    if (imageWidth) tile.style.setProperty('--mural-image-width', `${imageWidth}px`)
    else tile.style.removeProperty('--mural-image-width')
  }
}

const observeTiles = () => {
  if (!observer) return
  const visible = new Set(grid.value.querySelectorAll('[data-mural-tile]'))
  for (const tile of observedTiles) {
    if (!visible.has(tile)) {
      observer.unobserve(tile)
      observedTiles.delete(tile)
    }
  }
  for (const tile of visible) {
    if (!observedTiles.has(tile)) {
      observer.observe(tile)
      observedTiles.add(tile)
    }
  }
  sizeTiles(visible)
  packed.value = true
}

const startPointer = (event) => {
  if (pointer || props.disabled || props.reorderDisabled || cards.value.length < 2 || event.button !== 0 || event.isPrimary === false) return
  if (event.pointerType !== 'mouse' && !event.target.closest('[data-mural-drag-handle]')) return
  const id = event.target.closest('[data-mural-tile]')?.dataset.muralTile
  const card = cards.value.find((item) => item.id === id)
  if (!card) return
  pointer = { pointerId: event.pointerId, id, label: cardLabel(card), x: event.clientX, y: event.clientY }
}

const findDestination = (x, y) => {
  const hovered = document.elementFromPoint(x, y)?.closest('[data-mural-tile]')
  if (!hovered || !grid.value.contains(hovered) || hovered.dataset.muralTile === pointer.id) return null
  const rect = hovered.getBoundingClientRect()
  return { id: hovered.dataset.muralTile, placement: y < rect.top + rect.height / 2 ? 'before' : 'after' }
}

const scrollOnDrag = () => {
  if (!drag.value) return
  const { x, y } = drag.value
  const margin = 56
  const distance = y < margin ? y - margin : Math.max(0, y - (window.innerHeight - margin))
  if (distance) {
    window.scrollBy(0, Math.sign(distance) * Math.min(24, Math.ceil(Math.abs(distance) / 3)))
    destination.value = findDestination(x, y)
  }
  scrollFrame = requestAnimationFrame(scrollOnDrag)
}

const trackPointer = (event) => {
  if (!pointer || event.pointerId !== pointer.pointerId) return
  const { clientX: x, clientY: y } = event
  if (!drag.value) {
    if (Math.hypot(x - pointer.x, y - pointer.y) < 7) return
    try {
      grid.value.setPointerCapture?.(event.pointerId)
    } catch {}
    scrollFrame = requestAnimationFrame(scrollOnDrag)
  }
  event.preventDefault()
  drag.value = { id: pointer.id, label: pointer.label, x, y }
  destination.value = findDestination(x, y)
}

const resetDrag = () => {
  if (drag.value) blockClickUntil = performance.now() + 250
  pointer = null
  drag.value = null
  destination.value = null
  cancelAnimationFrame(scrollFrame)
}

const endPointer = (event) => {
  if (!pointer || event.pointerId !== pointer.pointerId) return
  const source = pointer.id
  const target = drag.value && event.type === 'pointerup' ? findDestination(event.clientX, event.clientY) : null
  resetDrag()
  if (target) emit('reorder', { id: source, targetId: target.id, placement: target.placement })
}

const suppressDragClick = (event) => {
  if (event.detail === 0 || performance.now() >= blockClickUntil) return
  event.stopPropagation()
  event.preventDefault()
}

const moveWithKeyboard = (id, direction) => {
  if (props.disabled || props.reorderDisabled) return
  const index = cards.value.findIndex((card) => card.id === id)
  const target = cards.value[index + direction]
  if (target) emit('reorder', { id, targetId: target.id, placement: direction < 0 ? 'before' : 'after' })
}

const cancelWithEscape = (event) => {
  if (event.key === 'Escape' && pointer) resetDrag()
}

watch(cards, observeTiles, { flush: 'post' })
onMounted(() => {
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver((entries) => sizeTiles(entries.map(({ target }) => target)))
    observeTiles()
  }
  window.addEventListener('pointermove', trackPointer, { passive: false })
  window.addEventListener('pointerup', endPointer)
  window.addEventListener('pointercancel', endPointer)
  window.addEventListener('keydown', cancelWithEscape)
})
onBeforeUnmount(() => {
  resetDrag()
  observer?.disconnect()
  window.removeEventListener('pointermove', trackPointer)
  window.removeEventListener('pointerup', endPointer)
  window.removeEventListener('pointercancel', endPointer)
  window.removeEventListener('keydown', cancelWithEscape)
})
</script>

<style scoped>
.mural-grid {
  display: grid;
  align-items: start;
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 14rem), 15.5rem));
  gap: 0.75rem;
}
.mural-grid--packed { grid-auto-rows: 1px; row-gap: 0; }
.mural-grid--packed .mural-tile { grid-row-end: span var(--mural-card-rows, 1); }
.mural-section + .mural-section { margin-top: 0.85rem; }
.mural-section h4 { margin: 0 0 0.55rem; font-size: 0.78rem; font-weight: 600; color: var(--ayame-text-muted); }
.mural-more { margin-top: 0.45rem; }
.mural-tile { position: relative; min-width: 0; container-type: inline-size; }

.mural-card {
  width: 100%;
  min-width: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 0;
  text-align: left;
  font: inherit;
  color: var(--ayame-text);
  border: 1px solid color-mix(in srgb, var(--mural-accent) 26%, var(--ayame-border));
  border-radius: var(--radius-sm);
  --mural-card-surface: color-mix(in srgb, var(--mural-accent) 11%, var(--ayame-surface));
  background: var(--mural-card-surface);
  cursor: pointer;
  user-select: none;
}
.mural-card:hover { --mural-card-surface: color-mix(in srgb, var(--mural-accent) 16%, var(--ayame-surface)); }
.mural-card:disabled { cursor: progress; }
.mural-card--with-image {
  width: fit-content;
  max-width: 100%;
  background: transparent;
  border: 0;
  align-items: start;
}
.mural-card--image-only { width: var(--mural-image-width, fit-content); }
.mural-card-image {
  display: block;
  width: auto;
  height: auto;
  max-width: 100cqi;
  max-height: min(22rem, 55vh);
  border-radius: var(--radius-sm);
}
.mural-card-content { width: 100%; display: grid; gap: 0.4rem; padding: 0.75rem; }
.mural-card--with-image .mural-card-content {
  width: 100cqi;
  margin-top: 2px;
  border: 1px solid color-mix(in srgb, var(--mural-accent) 26%, var(--ayame-border));
  border-radius: var(--radius-sm);
  background: var(--mural-card-surface);
}
.mural-tile:has(.mural-drag-handle) .mural-card-content { padding-right: 2rem; }
.mural-card--image-only .mural-card-content {
  width: 100%;
  contain: inline-size;
  padding: 0.35rem 0.45rem;
}
.mural-card-content strong { overflow: hidden; overflow-wrap: anywhere; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; font-size: 0.86rem; }
.mural-card-preview {
  overflow: hidden;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 16;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
  color: var(--ayame-text-muted);
  font-size: 0.81rem;
  line-height: 1.4;
}
.mural-drag-handle {
  position: absolute;
  top: 0.3rem;
  left: 0.3rem;
  display: grid;
  place-items: center;
  width: 1.65rem;
  height: 1.65rem;
  padding: 0;
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-sm);
  background: var(--ayame-surface);
  color: var(--ayame-text-muted);
  opacity: 0;
  cursor: grab;
  touch-action: none;
}
.mural-tile:not(:has(.mural-card--with-image)) .mural-drag-handle { left: auto; right: 0.3rem; }
.mural-drag-handle span {
  width: 10px;
  height: 15px;
  background: radial-gradient(circle, currentColor 1px, transparent 1.5px) 0 0 / 5px 5px;
}
.mural-tile:hover .mural-drag-handle, .mural-tile:focus-within .mural-drag-handle { opacity: 1; }
.mural-drag-handle:active { cursor: grabbing; }
.mural-tile--dragging { opacity: 0.45; }
.mural-tile--before::before, .mural-tile--after::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--ayame-primary);
  pointer-events: none;
}
.mural-tile--before::before { top: -0.33rem; }
.mural-tile--after::after { bottom: -0.33rem; }
.mural-drag-preview {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1000;
  max-width: 12rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  padding: 0.35rem 0.5rem;
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-sm);
  background: var(--ayame-surface-elevated);
  color: var(--ayame-text);
  font-size: 0.8rem;
  pointer-events: none;
}

@media (max-width: 650px) { .mural-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 9rem), 1fr)); } }
@media (hover: none) { .mural-drag-handle { opacity: 1; } }
</style>
