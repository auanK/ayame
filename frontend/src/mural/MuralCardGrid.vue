<template>
  <div
    ref="boardEl"
    class="mural-board"
    :class="{ 'mural-board--animated': layoutReady }"
    @pointerdown="startPointer"
    @click.capture="suppressDragClick"
    @dragstart.prevent
  >
    <section
      v-for="section in displaySections"
      :key="section.group"
      :data-mural-section="section.group"
      class="mural-section"
      :aria-label="section.label"
    >
      <h4>{{ section.label }}</h4>
      <div
        :ref="(el) => setCanvasRef(section.group, el)"
        class="mural-canvas"
        :style="{ height: `${sectionLayout(section.group).height}px` }"
      >
        <div
          v-if="placeholderSlot(section.group)"
          class="mural-placeholder"
          :style="{
            width: `${placeholderSlot(section.group).width}px`,
            height: `${placeholderSlot(section.group).height}px`,
            transform: `translate3d(${placeholderSlot(section.group).x}px, ${placeholderSlot(section.group).y}px, 0)`,
          }"
          aria-hidden="true"
        />

        <div
          v-for="card in section.cards"
          :key="card.id"
          :ref="(el) => setTileRef(card.id, el)"
          :data-mural-tile="card.id"
          class="mural-tile"
          :class="{
            'mural-tile--dragging': drag?.id === card.id,
            'mural-tile--resized': isResized(card),
            'mural-tile--resizing': activeResize?.id === card.id,
            'mural-tile--resize-mode': resizingCardId === card.id && card.imageVersion,
          }"
          :style="tileStyle(section.group, card)"
        >
          <button
            type="button"
            class="mural-card"
            :class="{
              'mural-card--with-image': card.imageVersion,
              'mural-card--image-only': card.kind === 'image' && card.imageVersion,
            }"
            :style="{ '--mural-accent': muralAccent(card.color) }"
            :disabled="disabled"
            :data-card-id="card.id"
            :aria-label="card.kind === 'image' && !card.title ? 'Open image card' : undefined"
            @click="emit('open', card.id, $event.currentTarget)"
            @keydown.alt.up.prevent="moveWithKeyboard(card.id, -1)"
            @keydown.alt.left.prevent="moveWithKeyboard(card.id, -1)"
            @keydown.alt.down.prevent="moveWithKeyboard(card.id, 1)"
            @keydown.alt.right.prevent="moveWithKeyboard(card.id, 1)"
          >
            <img
              v-if="card.imageVersion"
              class="mural-card-image"
              :src="getMuralImageUrl(card.id, card.imageVersion)"
              alt=""
              loading="lazy"
              decoding="async"
              draggable="false"
              @load="onImageLoad(card.id, $event)"
            />
            <span v-if="card.kind !== 'image' || card.title" class="mural-card-content">
              <strong v-if="card.title || !card.preview">{{ card.title || 'Untitled' }}</strong>
              <span v-if="card.preview" class="mural-card-preview">{{ card.preview }}</span>
            </span>
          </button>

          <template v-if="resizingCardId === card.id && card.imageVersion">
            <div class="mural-resize-bar" data-testid="mural-resize-bar">
              <span class="mural-resize-badge">{{ activeResize?.id === card.id ? activeResize.width : widthForCard(card) }}px</span>
              <button
                v-if="card.imageWidth != null"
                type="button"
                class="mural-resize-bar-btn"
                @click.stop="resetResize(card)"
              >Reset</button>
              <button
                type="button"
                class="mural-resize-bar-btn mural-resize-bar-btn--done"
                data-testid="mural-resize-done"
                @click.stop="emit('stop-resize')"
              >Done</button>
            </div>
            <button
              type="button"
              class="mural-resize-handle"
              data-mural-resize-handle
              :aria-label="`Resize ${cardLabel(card)}`"
              title="Drag to resize · Double-click to reset"
              :disabled="disabled"
              @pointerdown.stop="startResize($event, card)"
              @dblclick.stop="resetResize(card)"
              @click.stop
              @keydown.left.prevent="nudgeResize(card, -32)"
              @keydown.up.prevent="nudgeResize(card, -32)"
              @keydown.right.prevent="nudgeResize(card, 32)"
              @keydown.down.prevent="nudgeResize(card, 32)"
              @keydown.0.prevent="resetResize(card)"
              @keydown.backspace.prevent="resetResize(card)"
            ><span aria-hidden="true" /></button>
          </template>
        </div>
      </div>
      <button v-if="section.hasMore" type="button" class="btn btn-secondary btn-compact mural-more" :disabled="loading || moving" @click="emit('more', section.group)">
        {{ loading ? 'Loading…' : section.group === 'pinned' ? 'Load more pinned notes' : section.group === 'trashed' ? 'Load more trashed notes' : 'Load more notes' }}
      </button>
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { MURAL_MAX_IMAGE_WIDTH, MURAL_MIN_IMAGE_WIDTH } from '../../../shared/mural.js'
import { getMuralImageUrl } from './api.js'
import { muralAccent } from './colors.js'
import {
  MURAL_GAP,
  computeBaseColumnWidth,
  computeCardWidth,
  findBestDropIndex,
  packSkyline,
} from './layout.js'

const props = defineProps({
  sections: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  moving: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  reorderDisabled: { type: Boolean, default: false },
  resizingCardId: { type: String, default: null },
})

const emit = defineEmits(['open', 'reorder', 'resize', 'stop-resize', 'more'])

const boardEl = ref(null)
const boardWidth = ref(1024)
const layoutReady = ref(false)
const layoutVersion = ref(0)
const drag = shallowRef(null)
const dragTarget = shallowRef(null)
const activeResize = shallowRef(null)

const canvasEls = new Map()
const tileEls = new Map()
const tileHeights = new Map()
const imageRatios = new Map()
const observedTiles = new Set()

let boardObserver = null
let tileObserver = null
let pointer = null
let resizeOp = null
let dragFrame = 0
let resizeFrame = 0
let blockClickUntil = 0
const liveDragPos = { x: 0, y: 0 }

const displaySections = computed(() => props.sections)
const cards = computed(() => displaySections.value.flatMap((section) => section.cards))
const cardsById = computed(() => new Map(cards.value.map((card) => [card.id, card])))

const cardLabel = (card) => card.title || card.preview?.trim().slice(0, 48) || (card.kind === 'image' ? 'Image card' : 'Untitled note')
const isResized = (card) => activeResize.value?.id === card.id || card.imageWidth != null
const clampWidth = (width, maxWidth = MURAL_MAX_IMAGE_WIDTH) =>
  Math.max(MURAL_MIN_IMAGE_WIDTH, Math.min(maxWidth, Math.round(width)))

const setCanvasRef = (group, el) => {
  if (el) canvasEls.set(group, el)
  else canvasEls.delete(group)
}

const setTileRef = (id, el) => {
  if (el) tileEls.set(id, el)
  else tileEls.delete(id)
}

const onImageLoad = (id, event) => {
  const img = event.target
  if (img?.naturalWidth > 0 && img?.naturalHeight > 0) {
    const ratio = img.naturalWidth / img.naturalHeight
    if (imageRatios.get(id) !== ratio) {
      imageRatios.set(id, ratio)
      layoutVersion.value++
    }
  }
}

const widthForCard = (card, widthOverride = null) => {
  const containerW = boardWidth.value || 1024
  const baseW = computeBaseColumnWidth(containerW, MURAL_GAP)
  const override = widthOverride ?? (activeResize.value?.id === card.id ? activeResize.value.width : null)
  return computeCardWidth(card, containerW, baseW, {
    overrideWidth: override,
    aspectRatio: imageRatios.get(card.id) ?? null,
  })
}

const heightForCard = (card, width) => {
  const measured = tileHeights.get(card.id)
  if (measured && measured > 0) return measured
  const ratio = imageRatios.get(card.id)
  if (card.imageVersion && ratio > 0) return Math.max(96, Math.round(width / ratio))
  return card.imageVersion ? Math.round(width * 0.75) : 120
}

const buildItemsForSection = (section) => {
  const activeDrag = drag.value
  const target = dragTarget.value
  const filtered = activeDrag
    ? section.cards.filter((card) => card.id !== activeDrag.id)
    : section.cards

  const items = filtered.map((card) => {
    const width = widthForCard(card)
    return {
      id: card.id,
      width,
      height: heightForCard(card, width),
    }
  })

  if (activeDrag && target && target.group === section.group) {
    const insertAt = Math.max(0, Math.min(items.length, target.index))
    items.splice(insertAt, 0, {
      id: activeDrag.id,
      width: activeDrag.width,
      height: activeDrag.height,
    })
  }

  return items
}

const sectionLayouts = computed(() => {
  void layoutVersion.value
  const containerW = boardWidth.value || 1024
  const map = new Map()
  for (const section of displaySections.value) {
    const items = buildItemsForSection(section)
    map.set(section.group, packSkyline(items, containerW, MURAL_GAP))
  }
  return map
})

const sectionLayout = (group) => sectionLayouts.value.get(group) ?? { positions: new Map(), height: 0 }

const placeholderSlot = (group) => {
  if (!drag.value || !dragTarget.value || dragTarget.value.group !== group) return null
  return sectionLayout(group).positions.get(drag.value.id) ?? null
}

const tileStyle = (group, card) => {
  if (drag.value?.id === card.id) {
    return {
      width: `${drag.value.width}px`,
      height: `${drag.value.height}px`,
      transform: `translate3d(${liveDragPos.x}px, ${liveDragPos.y}px, 0)`,
    }
  }
  const slot = sectionLayout(group).positions.get(card.id)
  const width = slot?.width ?? widthForCard(card)
  const x = slot?.x ?? 0
  const y = slot?.y ?? 0
  const style = {
    width: `${width}px`,
    transform: `translate3d(${x}px, ${y}px, 0)`,
  }
  if (isResized(card)) {
    style['--mural-image-target-width'] = `${width}px`
  }
  return style
}

const syncObservers = () => {
  if (!boardEl.value) return
  const measuredBoardW = Math.floor(boardEl.value.getBoundingClientRect().width)
  if (measuredBoardW > 0 && measuredBoardW !== boardWidth.value) {
    boardWidth.value = measuredBoardW
  }

  if (tileObserver) {
    const visible = new Set(boardEl.value.querySelectorAll('[data-mural-tile]'))
    for (const el of observedTiles) {
      if (!visible.has(el)) {
        tileObserver.unobserve(el)
        observedTiles.delete(el)
      }
    }
    for (const el of visible) {
      if (!observedTiles.has(el)) {
        tileObserver.observe(el)
        observedTiles.add(el)
      }
      const id = el.dataset.muralTile
      const h = Math.ceil(el.getBoundingClientRect().height)
      if (id && h > 0 && tileHeights.get(id) !== h) {
        tileHeights.set(id, h)
        layoutVersion.value++
      }
    }
  }
}

const maxWidthForBoard = () => {
  const w = boardEl.value?.getBoundingClientRect().width || boardWidth.value || MURAL_MAX_IMAGE_WIDTH
  return Math.max(MURAL_MIN_IMAGE_WIDTH, Math.min(MURAL_MAX_IMAGE_WIDTH, Math.floor(w)))
}

const startResize = (event, card) => {
  if (resizeOp || drag.value || pointer || props.disabled || event.button !== 0 || event.isPrimary === false) return
  event.preventDefault()
  const tile = tileEls.get(card.id) || event.currentTarget.closest('[data-mural-tile]')
  const image = tile?.querySelector('.mural-card-image')
  const imgRect = image?.getBoundingClientRect()
  const maxWidth = maxWidthForBoard()
  const currentWidth = widthForCard(card)
  const startWidth = clampWidth(currentWidth, maxWidth)
  const aspectRatio = imgRect && imgRect.height > 0 ? imgRect.width / imgRect.height : (imageRatios.get(card.id) ?? 1)

  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {}

  resizeOp = {
    pointerId: event.pointerId,
    id: card.id,
    startX: event.clientX,
    startY: event.clientY,
    startWidth,
    latestWidth: startWidth,
    maxWidth,
    aspectRatio,
  }
  activeResize.value = { id: card.id, width: startWidth }
}

const resetResize = (card) => {
  if (props.disabled || card.imageWidth == null) return
  emit('resize', { id: card.id, imageWidth: null })
}

const nudgeResize = (card, delta) => {
  if (props.disabled) return
  const maxWidth = maxWidthForBoard()
  const current = widthForCard(card)
  const next = clampWidth(current + delta, maxWidth)
  if (next !== card.imageWidth) emit('resize', { id: card.id, imageWidth: next })
}

const findCardLocation = (cardId) => {
  for (const section of displaySections.value) {
    const idx = section.cards.findIndex((c) => c.id === cardId)
    if (idx !== -1) return { group: section.group, index: idx }
  }
  return null
}

const beginActiveDrag = () => {
  if (!pointer || drag.value) return
  const loc = findCardLocation(pointer.id)
  if (!loc) return
  try {
    boardEl.value?.setPointerCapture?.(pointer.pointerId)
  } catch {}
  liveDragPos.x = pointer.x - pointer.offsetX
  liveDragPos.y = pointer.y - pointer.offsetY
  dragTarget.value = { group: loc.group, index: loc.index }
  drag.value = {
    id: pointer.id,
    sourceGroup: loc.group,
    sourceIndex: loc.index,
    width: pointer.width,
    height: pointer.height,
  }
  if (!dragFrame) dragFrame = requestAnimationFrame(stepDrag)
}

const stepDrag = () => {
  dragFrame = 0
  if (!drag.value || !pointer) return

  const tx = pointer.x - pointer.offsetX
  const ty = pointer.y - pointer.offsetY
  liveDragPos.x = tx
  liveDragPos.y = ty

  const draggedEl = tileEls.get(drag.value.id)
  if (draggedEl) {
    draggedEl.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
  }

  const margin = 64
  const distance = pointer.y < margin ? pointer.y - margin : Math.max(0, pointer.y - (window.innerHeight - margin))
  if (distance) {
    window.scrollBy(0, Math.sign(distance) * Math.min(26, Math.ceil(Math.abs(distance) / 3)))
  }

  const dragCenterX = tx + drag.value.width / 2
  const dragCenterY = ty + drag.value.height / 2

  let targetSection = null
  let bestSecDist = Number.POSITIVE_INFINITY
  for (const section of displaySections.value) {
    const canvas = canvasEls.get(section.group)
    if (!canvas) continue
    const rect = canvas.getBoundingClientRect()
    const dist = dragCenterY < rect.top ? rect.top - dragCenterY : (dragCenterY > rect.bottom ? dragCenterY - rect.bottom : 0)
    if (dist < bestSecDist) {
      bestSecDist = dist
      targetSection = { section, rect }
    }
  }

  if (targetSection) {
    const { section, rect } = targetSection
    const containerW = boardWidth.value || Math.floor(rect.width) || 1024
    const others = section.cards
      .filter((c) => c.id !== drag.value.id)
      .map((c) => {
        const width = widthForCard(c)
        return { id: c.id, width, height: heightForCard(c, width) }
      })

    const currentIndex = dragTarget.value?.group === section.group ? dragTarget.value.index : -1
    const nextIdx = findBestDropIndex({
      others,
      draggedId: drag.value.id,
      draggedSize: { width: drag.value.width, height: drag.value.height },
      currentIndex,
      centerX: dragCenterX - rect.left,
      centerY: dragCenterY - rect.top,
      containerWidth: containerW,
      gap: MURAL_GAP,
    })

    if (!dragTarget.value || dragTarget.value.group !== section.group || dragTarget.value.index !== nextIdx) {
      dragTarget.value = { group: section.group, index: nextIdx }
    }
  }

  if (drag.value) {
    dragFrame = requestAnimationFrame(stepDrag)
  }
}

const startPointer = (event) => {
  if (pointer || resizeOp || props.disabled || props.reorderDisabled || cards.value.length < 2 || event.button !== 0 || event.isPrimary === false) return
  if (event.target.closest('[data-mural-resize-handle], [data-testid="mural-resize-bar"]')) return

  const tileEl = event.target.closest('[data-mural-tile]')
  const id = tileEl?.dataset.muralTile
  if (!id || props.resizingCardId === id) return
  const card = cardsById.value.get(id)
  if (!card) return

  const rect = tileEl.getBoundingClientRect()
  const lockedWidth = widthForCard(card)
  const lockedHeight = Math.round(rect.height || heightForCard(card, lockedWidth))
  const isTouch = event.pointerType === 'touch'

  pointer = {
    pointerId: event.pointerId,
    id,
    card,
    isTouch,
    touchReady: !isTouch,
    holdTimer: null,
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: Math.round(rect.width || lockedWidth),
    height: lockedHeight,
  }

  if (isTouch) {
    pointer.holdTimer = setTimeout(() => {
      if (pointer) {
        pointer.touchReady = true
        beginActiveDrag()
      }
    }, 220)
  }
}

const trackPointer = (event) => {
  if (resizeOp && event.pointerId === resizeOp.pointerId) {
    event.preventDefault()
    const dx = event.clientX - resizeOp.startX
    const dy = event.clientY - resizeOp.startY
    const delta = Math.abs(dx) >= Math.abs(dy) ? dx : dy * resizeOp.aspectRatio
    resizeOp.latestWidth = clampWidth(resizeOp.startWidth + delta, resizeOp.maxWidth)
    if (!resizeFrame) {
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        if (!resizeOp) return
        activeResize.value = { id: resizeOp.id, width: resizeOp.latestWidth }
      })
    }
    return
  }

  if (!pointer || event.pointerId !== pointer.pointerId) return
  pointer.x = event.clientX
  pointer.y = event.clientY

  if (!drag.value) {
    const moved = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY)
    if (pointer.isTouch && !pointer.touchReady) {
      if (moved > 8) {
        clearTimeout(pointer.holdTimer)
        pointer = null
      }
      return
    }
    if (moved < 5) return
    beginActiveDrag()
  }
  event.preventDefault()
}

const resetDrag = () => {
  if (pointer?.holdTimer) clearTimeout(pointer.holdTimer)
  if (drag.value) blockClickUntil = performance.now() + 250
  pointer = null
  drag.value = null
  dragTarget.value = null
  cancelAnimationFrame(dragFrame)
  dragFrame = 0
}

const endPointer = (event) => {
  if (resizeOp && event.pointerId === resizeOp.pointerId) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = 0
    const { id, startWidth, latestWidth } = resizeOp
    resizeOp = null
    activeResize.value = null
    blockClickUntil = performance.now() + 250
    void nextTick(() => syncObservers())
    if (event.type === 'pointerup' && latestWidth !== startWidth) {
      emit('resize', { id, imageWidth: latestWidth })
    }
    return
  }

  if (!pointer || event.pointerId !== pointer.pointerId) return
  let movePayload = null

  if (drag.value && event.type === 'pointerup' && dragTarget.value) {
    const { group, index } = dragTarget.value
    if (group !== drag.value.sourceGroup || index !== drag.value.sourceIndex) {
      const targetSection = displaySections.value.find((s) => s.group === group)
      const others = (targetSection?.cards ?? []).filter((c) => c.id !== drag.value.id)
      const insertAt = Math.max(0, Math.min(others.length, index))
      if (insertAt > 0) {
        movePayload = { id: drag.value.id, targetId: others[insertAt - 1].id, placement: 'after' }
      } else if (others.length > 0) {
        movePayload = { id: drag.value.id, targetId: others[0].id, placement: 'before' }
      }
    }
  }

  if (movePayload) emit('reorder', movePayload)
  resetDrag()
}

const handleOutsidePointerDown = (event) => {
  if (!props.resizingCardId) return
  if (!event.target?.closest?.(`[data-mural-tile="${props.resizingCardId}"]`)) {
    emit('stop-resize')
  }
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
  if (event.key !== 'Escape') return
  if (resizeOp) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = 0
    resizeOp = null
    activeResize.value = null
    return
  }
  if (props.resizingCardId) {
    emit('stop-resize')
    return
  }
  if (pointer) resetDrag()
}

watch(cards, () => {
  void nextTick(() => syncObservers())
}, { flush: 'post' })

onMounted(() => {
  if (typeof ResizeObserver === 'function') {
    boardObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const w = Math.floor(entry.contentRect.width)
        if (w > 0 && w !== boardWidth.value) boardWidth.value = w
      }
    })
    if (boardEl.value) boardObserver.observe(boardEl.value)

    tileObserver = new ResizeObserver((entries) => {
      let changed = false
      for (const entry of entries) {
        const id = entry.target.dataset.muralTile
        if (!id || drag.value?.id === id) continue
        const h = Math.ceil(entry.target.getBoundingClientRect().height)
        if (h > 0 && tileHeights.get(id) !== h) {
          tileHeights.set(id, h)
          changed = true
        }
      }
      if (changed) layoutVersion.value++
    })
  }
  syncObservers()
  requestAnimationFrame(() => { layoutReady.value = true })

  window.addEventListener('pointerdown', handleOutsidePointerDown, true)
  window.addEventListener('pointermove', trackPointer, { passive: false })
  window.addEventListener('pointerup', endPointer)
  window.addEventListener('pointercancel', endPointer)
  window.addEventListener('keydown', cancelWithEscape)
})

onBeforeUnmount(() => {
  resetDrag()
  cancelAnimationFrame(resizeFrame)
  resizeOp = null
  activeResize.value = null
  boardObserver?.disconnect()
  tileObserver?.disconnect()
  window.removeEventListener('pointerdown', handleOutsidePointerDown, true)
  window.removeEventListener('pointermove', trackPointer)
  window.removeEventListener('pointerup', endPointer)
  window.removeEventListener('pointercancel', endPointer)
  window.removeEventListener('keydown', cancelWithEscape)
})
</script>

<style scoped>
.mural-board { width: 100%; }
.mural-section + .mural-section { margin-top: 1rem; }
.mural-section h4 { margin: 0 0 0.55rem; font-size: 0.78rem; font-weight: 600; color: var(--ayame-text-muted); }
.mural-more { margin-top: 0.55rem; }

.mural-canvas {
  position: relative;
  width: 100%;
  transition: height 180ms cubic-bezier(0.2, 0, 0, 1);
}

.mural-placeholder {
  position: absolute;
  top: 0;
  left: 0;
  border: 1.5px dashed color-mix(in srgb, var(--ayame-primary) 48%, var(--ayame-border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ayame-surface) 40%, transparent);
  pointer-events: none;
  transition: transform 180ms cubic-bezier(0.2, 0, 0, 1), width 180ms ease, height 180ms ease;
}

.mural-tile {
  position: absolute;
  top: 0;
  left: 0;
  min-width: 0;
  will-change: transform;
}

.mural-board--animated .mural-tile {
  transition: transform 200ms cubic-bezier(0.2, 0, 0, 1);
}

.mural-tile--resizing {
  transition: none !important;
  z-index: 20;
}

.mural-tile--resize-mode {
  z-index: 15;
  outline: 2px solid var(--ayame-primary);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.mural-tile--dragging {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1000;
  transition: none !important;
  pointer-events: none;
}

.mural-tile--dragging .mural-card {
  cursor: grabbing;
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.45), 0 0 0 1px color-mix(in srgb, var(--ayame-primary) 55%, var(--ayame-border));
}

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
  width: 100%;
  background: transparent;
  border: 0;
  align-items: start;
}
.mural-card-image {
  display: block;
  width: 100%;
  height: auto;
  border-radius: var(--radius-sm);
}
.mural-card-content { width: 100%; display: grid; gap: 0.4rem; padding: 0.75rem; }
.mural-card--with-image .mural-card-content {
  width: 100%;
  margin-top: 2px;
  border: 1px solid color-mix(in srgb, var(--mural-accent) 26%, var(--ayame-border));
  border-radius: var(--radius-sm);
  background: var(--mural-card-surface);
}
.mural-card--image-only .mural-card-content { padding: 0.35rem 0.45rem; }
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

.mural-resize-bar {
  position: absolute;
  left: 0.35rem;
  bottom: 0.35rem;
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  padding: 0.16rem 0.3rem;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ayame-surface-elevated) 94%, transparent);
  border: 1px solid var(--ayame-border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.35);
}

.mural-resize-badge {
  color: var(--ayame-text-muted);
  font-size: 0.72rem;
  padding-inline: 0.16rem;
}

.mural-resize-bar-btn {
  padding: 0.14rem 0.4rem;
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-xs);
  background: transparent;
  color: var(--ayame-text);
  font: inherit;
  font-size: 0.72rem;
  cursor: pointer;
}

.mural-resize-bar-btn--done {
  background: var(--ayame-primary);
  border-color: var(--ayame-primary);
  color: var(--ayame-surface);
  font-weight: 600;
}

.mural-resize-handle {
  position: absolute;
  right: 0.25rem;
  bottom: 0.25rem;
  display: grid;
  place-items: center;
  width: 1.7rem;
  height: 1.7rem;
  padding: 0;
  border: 1px solid var(--ayame-primary);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ayame-surface) 94%, transparent);
  color: var(--ayame-primary);
  cursor: nwse-resize;
  touch-action: none;
}
.mural-resize-handle span {
  width: 9px;
  height: 9px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
}
</style>
