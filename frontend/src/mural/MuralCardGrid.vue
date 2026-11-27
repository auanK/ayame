<template>
  <div
    ref="grid"
    class="mural-board"
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
      <div class="mural-grid" :class="{ 'mural-grid--packed': packed }">
        <div
          v-for="card in section.cards"
          :key="card.id"
          :data-mural-tile="card.id"
          class="mural-tile"
          :class="{
            'mural-tile--placeholder': drag?.id === card.id,
            'mural-tile--resized': effectiveWidthFor(card) !== null,
            'mural-tile--resizing': activeResize?.id === card.id,
          }"
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
            title="Drag to reorder · Arrow keys to move"
            :aria-disabled="reorderDisabled || disabled"
            @keydown.up.prevent="moveWithKeyboard(card.id, -1)"
            @keydown.left.prevent="moveWithKeyboard(card.id, -1)"
            @keydown.down.prevent="moveWithKeyboard(card.id, 1)"
            @keydown.right.prevent="moveWithKeyboard(card.id, 1)"
          ><span aria-hidden="true" /></button>
          <button
            v-if="card.imageVersion"
            type="button"
            class="mural-resize-handle"
            data-mural-resize-handle
            :aria-label="`Resize ${cardLabel(card)}`"
            title="Drag to resize · Double-click to reset"
            :disabled="disabled || reorderDisabled"
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
          <span v-if="activeResize?.id === card.id" class="mural-resize-badge" aria-hidden="true">{{ activeResize.width }}px</span>
        </div>
      </div>
      <button v-if="section.hasMore" type="button" class="btn btn-secondary btn-compact mural-more" :disabled="loading || moving" @click="emit('more', section.group)">
        {{ loading ? 'Loading…' : section.group === 'pinned' ? 'Load more pinned notes' : 'Load more notes' }}
      </button>
    </section>

    <Teleport to="body">
      <div
        v-if="drag"
        ref="ghostEl"
        class="mural-drag-ghost"
        :style="{
          width: `${drag.width}px`,
          minHeight: `${drag.height}px`,
          '--mural-accent': muralAccent(drag.card.color),
          transform: `translate3d(${drag.x}px, ${drag.y}px, 0) scale(1.02)`,
        }"
        aria-hidden="true"
      >
        <div
          class="mural-card mural-card--ghost"
          :class="{
            'mural-card--with-image': drag.card.imageVersion,
            'mural-card--image-only': drag.card.kind === 'image' && drag.card.imageVersion,
          }"
        >
          <img
            v-if="drag.card.imageVersion"
            class="mural-card-image"
            :src="getMuralImageUrl(drag.card.id, drag.card.imageVersion)"
            alt=""
            decoding="async"
            draggable="false"
          />
          <span v-if="drag.card.kind !== 'image' || drag.card.title" class="mural-card-content">
            <strong v-if="drag.card.title || !drag.card.preview">{{ drag.card.title || 'Untitled' }}</strong>
            <span v-if="drag.card.preview" class="mural-card-preview">{{ drag.card.preview }}</span>
          </span>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { MURAL_MAX_IMAGE_WIDTH, MURAL_MIN_IMAGE_WIDTH } from '../../../shared/mural.js'
import { getMuralImageUrl } from './api.js'
import { muralAccent } from './colors.js'

const props = defineProps({
  sections: { type: Array, required: true },
  loading: { type: Boolean, default: false },
  moving: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  reorderDisabled: { type: Boolean, default: false },
})

const emit = defineEmits(['open', 'reorder', 'resize', 'more'])

const grid = ref(null)
const ghostEl = ref(null)
const packed = ref(false)
const liveSections = shallowRef(null)
const drag = shallowRef(null)
const activeResize = shallowRef(null)
const displaySections = computed(() => liveSections.value ?? props.sections)
const cards = computed(() => displaySections.value.flatMap((section) => section.cards))
const cardsById = computed(() => new Map(cards.value.map((card) => [card.id, card])))

const observedTiles = new Set()
let observer
let pointer = null
let resizeOp = null
let dragFrame = 0
let resizeFrame = 0
let flipCleanupTimer = 0
let blockClickUntil = 0
let lastSwapAt = 0
let dragSourceSection = null
let dragSourceIndex = -1
let cachedTiles = []
let cachedSections = []

const cardLabel = (card) => card.title || card.preview?.trim().slice(0, 48) || (card.kind === 'image' ? 'Image card' : 'Untitled note')
const effectiveWidthFor = (card) => activeResize.value?.id === card.id ? activeResize.value.width : (card.imageWidth ?? null)
const clampWidth = (width, maxWidth = MURAL_MAX_IMAGE_WIDTH) =>
  Math.max(MURAL_MIN_IMAGE_WIDTH, Math.min(maxWidth, Math.round(width)))

const gridMetricsFor = (gridEl) => {
  const style = getComputedStyle(gridEl)
  const gap = Number.parseFloat(style.columnGap) || 0
  const tracks = style.gridTemplateColumns.split(' ').filter(Boolean)
  const firstTrack = Number.parseFloat(tracks[0])
  const parentWidth = gridEl.getBoundingClientRect().width
  const colCount = tracks.length > 0 && Number.isFinite(firstTrack) ? tracks.length : 1
  const colWidth = Number.isFinite(firstTrack) && firstTrack > 0 ? firstTrack : Math.max(256, parentWidth)
  return { gap, colCount, colWidth }
}

const sizeTiles = (tiles) => {
  if (!grid.value) return
  const metricsCache = new Map()
  const tileEntries = []

  // Pass 1: compute and apply column span and target image width before reading heights.
  for (const tile of tiles) {
    const parent = tile.parentElement
    if (!parent) continue
    let metrics = metricsCache.get(parent)
    if (!metrics) {
      metrics = gridMetricsFor(parent)
      metricsCache.set(parent, metrics)
    }
    const card = cardsById.value.get(tile.dataset.muralTile)
    const width = card ? effectiveWidthFor(card) : null
    if (width) {
      const colSpan = Math.min(metrics.colCount, Math.max(1, Math.ceil((width + metrics.gap - 12) / (metrics.colWidth + metrics.gap))))
      tile.style.gridColumn = colSpan > 1 ? `span ${colSpan}` : ''
      tile.style.setProperty('--mural-image-target-width', `${width}px`)
    } else {
      tile.style.gridColumn = ''
      tile.style.removeProperty('--mural-image-target-width')
    }
    tileEntries.push({ tile, gap: metrics.gap })
  }

  // Pass 2: measure heights and rendered image widths in one read batch.
  const measurements = tileEntries.map(({ tile, gap }) => {
    const rows = Math.ceil(tile.getBoundingClientRect().height + gap)
    const image = tile.querySelector('.mural-card--with-image .mural-card-image')
    return { tile, rows, imageWidth: image?.getBoundingClientRect().width }
  })

  // Pass 3: write row spans and caption widths in one write batch.
  for (const { tile, rows, imageWidth } of measurements) {
    tile.style.setProperty('--mural-card-rows', String(Math.max(1, rows)))
    if (imageWidth) tile.style.setProperty('--mural-image-width', `${imageWidth}px`)
    else tile.style.removeProperty('--mural-image-width')
  }
}

const observeTiles = () => {
  if (!grid.value) return
  const visible = new Set(grid.value.querySelectorAll('[data-mural-tile]'))
  if (observer) {
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
  }
  sizeTiles(visible)
  packed.value = true
}

const maxWidthForTile = (tile) => {
  const gridWidth = tile?.parentElement?.getBoundingClientRect().width || MURAL_MAX_IMAGE_WIDTH
  return Math.max(MURAL_MIN_IMAGE_WIDTH, Math.min(MURAL_MAX_IMAGE_WIDTH, Math.round(gridWidth)))
}

const startResize = (event, card) => {
  if (resizeOp || drag.value || pointer || props.disabled || props.reorderDisabled || event.button !== 0 || event.isPrimary === false) return
  event.preventDefault()
  const tile = event.currentTarget.closest('[data-mural-tile]')
  const image = tile?.querySelector('.mural-card-image')
  const imgRect = image?.getBoundingClientRect()
  const maxWidth = maxWidthForTile(tile)
  const rawStartWidth = card.imageWidth || imgRect?.width || tile?.getBoundingClientRect().width || 280
  const startWidth = clampWidth(rawStartWidth, maxWidth)
  const aspectRatio = imgRect && imgRect.height > 0 ? imgRect.width / imgRect.height : 1

  try {
    event.currentTarget.setPointerCapture?.(event.pointerId)
  } catch {}

  resizeOp = {
    pointerId: event.pointerId,
    id: card.id,
    tile,
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
  if (props.disabled || props.reorderDisabled || card.imageWidth == null) return
  emit('resize', { id: card.id, imageWidth: null })
}

const nudgeResize = (card, delta) => {
  if (props.disabled || props.reorderDisabled) return
  const tile = grid.value?.querySelector(`[data-mural-tile="${card.id}"]`)
  const image = tile?.querySelector('.mural-card-image')
  const maxWidth = maxWidthForTile(tile)
  const current = card.imageWidth || image?.getBoundingClientRect().width || tile?.getBoundingClientRect().width || 280
  const next = clampWidth(current + delta, maxWidth)
  if (next !== card.imageWidth) emit('resize', { id: card.id, imageWidth: next })
}

const buildLayoutCache = (rectMap = null) => {
  if (!grid.value) {
    cachedTiles = []
    cachedSections = []
    return
  }
  const dragId = drag.value?.id
  cachedTiles = []
  cachedSections = []
  for (const sectionEl of grid.value.querySelectorAll('[data-mural-section]')) {
    const group = sectionEl.dataset.muralSection
    const secRect = sectionEl.getBoundingClientRect()
    cachedSections.push({ group, top: secRect.top, bottom: secRect.bottom })
    for (const tileEl of sectionEl.querySelectorAll('[data-mural-tile]')) {
      const id = tileEl.dataset.muralTile
      if (id === dragId) continue
      const rect = rectMap?.get(id) ?? tileEl.getBoundingClientRect()
      cachedTiles.push({
        id,
        group,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
        cx: rect.left + rect.width / 2,
        cy: rect.top + rect.height / 2,
      })
    }
  }
}

const findCardLocation = (sectionsList, cardId) => {
  for (let s = 0; s < sectionsList.length; s++) {
    const idx = sectionsList[s].cards.findIndex((c) => c.id === cardId)
    if (idx !== -1) return { sectionIndex: s, group: sectionsList[s].group, cardIndex: idx }
  }
  return null
}

const computeTargetSlot = (x, y) => {
  if (!cachedTiles.length || !liveSections.value) return null
  const dragId = drag.value?.id
  const currentLoc = findCardLocation(liveSections.value, dragId)
  if (!currentLoc) return null

  // 1. Direct hit inside a sibling tile
  for (const tile of cachedTiles) {
    if (x >= tile.left && x <= tile.right && y >= tile.top && y <= tile.bottom) {
      const targetLoc = findCardLocation(liveSections.value, tile.id)
      if (!targetLoc) return null
      if (targetLoc.group === currentLoc.group) {
        return {
          targetId: tile.id,
          placement: currentLoc.cardIndex < targetLoc.cardIndex ? 'after' : 'before',
          group: targetLoc.group,
        }
      }
      return {
        targetId: tile.id,
        placement: y < tile.cy ? 'before' : 'after',
        group: targetLoc.group,
      }
    }
  }

  // 2. Free-space hit (gaps, trailing space, or across section boundaries)
  let targetSection = cachedSections.find((sec) => y >= sec.top && y <= sec.bottom)
  if (!targetSection) {
    targetSection = cachedSections.reduce((best, sec) => {
      const dist = y < sec.top ? sec.top - y : y - sec.bottom
      const bestDist = y < best.top ? best.top - y : y - best.bottom
      return dist < bestDist ? sec : best
    }, cachedSections[0])
  }

  const sectionTiles = cachedTiles.filter((tile) => tile.group === targetSection?.group)
  const pool = sectionTiles.length ? sectionTiles : cachedTiles
  const firstTile = pool[0]
  const lastTile = pool[pool.length - 1]

  if (y < firstTile.top || (y <= firstTile.bottom && x < firstTile.left)) {
    return { targetId: firstTile.id, placement: 'before', group: firstTile.group }
  }
  if (y > lastTile.bottom || (y >= lastTile.top && x > lastTile.right)) {
    return { targetId: lastTile.id, placement: 'after', group: lastTile.group }
  }

  let closest = pool[0]
  let minDist = Number.POSITIVE_INFINITY
  for (const tile of pool) {
    const dx = Math.max(tile.left - x, 0, x - tile.right)
    const dy = Math.max(tile.top - y, 0, y - tile.bottom)
    const dist = dx * dx + dy * dy
    if (dist < minDist) {
      minDist = dist
      closest = tile
    }
  }
  const sameRow = y >= closest.top && y <= closest.bottom
  const placement = sameRow ? (x < closest.cx ? 'before' : 'after') : (y < closest.cy ? 'before' : 'after')
  return { targetId: closest.id, placement, group: closest.group }
}

const applyLiveReorder = async ({ targetId, placement }) => {
  if (!liveSections.value || !drag.value || !grid.value) return
  const sourceId = drag.value.id
  const current = liveSections.value
  const srcLoc = findCardLocation(current, sourceId)
  const dstLoc = findCardLocation(current, targetId)
  if (!srcLoc || !dstLoc) return

  const draggedCard = current[srcLoc.sectionIndex].cards[srcLoc.cardIndex]
  const targetPinned = current[dstLoc.sectionIndex].group === 'pinned'

  const nextSections = current.map((section) => ({
    ...section,
    cards: section.cards.filter((card) => card.id !== sourceId),
  }))

  const insertSection = nextSections[dstLoc.sectionIndex]
  const targetIdx = insertSection.cards.findIndex((card) => card.id === targetId)
  const insertAt = targetIdx + Number(placement === 'after')
  insertSection.cards.splice(insertAt, 0, { ...draggedCard, pinned: targetPinned })

  const unchanged = nextSections.every((sec, sIdx) =>
    sec.cards.length === current[sIdx].cards.length &&
    sec.cards.every((c, cIdx) => c.id === current[sIdx].cards[cIdx].id)
  )
  if (unchanged) return

  // FLIP First: record current sibling positions before DOM reorder.
  const tileNodes = new Map()
  const beforeRects = new Map()
  for (const el of grid.value.querySelectorAll('[data-mural-tile]')) {
    const id = el.dataset.muralTile
    if (id !== sourceId) {
      tileNodes.set(id, el)
      beforeRects.set(id, el.getBoundingClientRect())
    }
  }

  lastSwapAt = performance.now()
  liveSections.value = nextSections

  await nextTick()
  if (!drag.value || !grid.value) return

  sizeTiles(grid.value.querySelectorAll('[data-mural-tile]'))

  // FLIP Last + Invert: capture settled rects first so cachedTiles stay exact.
  const settledRects = new Map()
  const movedNodes = []
  for (const el of grid.value.querySelectorAll('[data-mural-tile]')) {
    const id = el.dataset.muralTile
    if (id === sourceId) continue
    const after = el.getBoundingClientRect()
    settledRects.set(id, after)
    const before = beforeRects.get(id)
    if (!before) continue
    const dx = before.left - after.left
    const dy = before.top - after.top
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      el.style.transition = 'none'
      el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
      movedNodes.push(el)
    }
  }

  if (movedNodes.length) {
    void grid.value.offsetHeight
    for (const el of movedNodes) {
      el.style.transition = 'transform 180ms cubic-bezier(0.2, 0, 0, 1)'
      el.style.transform = ''
    }
    clearTimeout(flipCleanupTimer)
    flipCleanupTimer = setTimeout(() => {
      for (const el of movedNodes) {
        el.style.transition = ''
        el.style.transform = ''
      }
    }, 190)
  }

  buildLayoutCache(settledRects)
}

const updateGhostPosition = () => {
  if (!ghostEl.value || !pointer) return
  const tx = pointer.x - pointer.offsetX
  const ty = pointer.y - pointer.offsetY
  ghostEl.value.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(1.02)`
}

const stepDrag = () => {
  dragFrame = 0
  if (!drag.value || !pointer) return

  updateGhostPosition()

  const margin = 64
  const distance = pointer.y < margin ? pointer.y - margin : Math.max(0, pointer.y - (window.innerHeight - margin))
  if (distance) {
    const step = Math.sign(distance) * Math.min(26, Math.ceil(Math.abs(distance) / 3))
    const prevY = window.scrollY
    window.scrollBy(0, step)
    const scrolled = window.scrollY - prevY
    if (scrolled) {
      for (const tile of cachedTiles) {
        tile.top -= scrolled
        tile.bottom -= scrolled
        tile.cy -= scrolled
      }
      for (const sec of cachedSections) {
        sec.top -= scrolled
        sec.bottom -= scrolled
      }
    }
  }

  if (lastSwapAt === 0 || performance.now() - lastSwapAt >= 120) {
    const target = computeTargetSlot(pointer.x, pointer.y)
    if (target) void applyLiveReorder(target)
  }

  if (drag.value) {
    dragFrame = requestAnimationFrame(stepDrag)
  }
}

const startPointer = (event) => {
  if (pointer || resizeOp || props.disabled || props.reorderDisabled || cards.value.length < 2 || event.button !== 0 || event.isPrimary === false) return
  if (event.target.closest('[data-mural-resize-handle]')) return
  if (event.pointerType === 'touch' && !event.target.closest('[data-mural-drag-handle]')) return
  const tileEl = event.target.closest('[data-mural-tile]')
  const id = tileEl?.dataset.muralTile
  const card = cardsById.value.get(id)
  if (!card || !tileEl) return
  const rect = tileEl.getBoundingClientRect()
  pointer = {
    pointerId: event.pointerId,
    id,
    card,
    label: cardLabel(card),
    startX: event.clientX,
    startY: event.clientY,
    x: event.clientX,
    y: event.clientY,
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top,
    width: rect.width,
    height: rect.height,
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
        void nextTick(() => {
          if (resizeOp?.tile?.parentElement) {
            sizeTiles(resizeOp.tile.parentElement.querySelectorAll('[data-mural-tile]'))
          }
        })
      })
    }
    return
  }

  if (!pointer || event.pointerId !== pointer.pointerId) return
  pointer.x = event.clientX
  pointer.y = event.clientY

  if (!drag.value) {
    if (Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY) < 5) return
    try {
      grid.value.setPointerCapture?.(event.pointerId)
    } catch {}
    const loc = findCardLocation(props.sections, pointer.id)
    dragSourceSection = loc?.group ?? null
    dragSourceIndex = loc?.cardIndex ?? -1
    lastSwapAt = 0
    liveSections.value = props.sections.map((section) => ({ ...section, cards: [...section.cards] }))
    drag.value = {
      id: pointer.id,
      card: pointer.card,
      label: pointer.label,
      width: pointer.width,
      height: pointer.height,
      x: pointer.x - pointer.offsetX,
      y: pointer.y - pointer.offsetY,
    }
    void nextTick(() => {
      if (!drag.value) return
      buildLayoutCache()
      updateGhostPosition()
      if (!dragFrame) dragFrame = requestAnimationFrame(stepDrag)
    })
  }
  event.preventDefault()
}

const resetDrag = () => {
  if (drag.value) blockClickUntil = performance.now() + 250
  pointer = null
  drag.value = null
  liveSections.value = null
  dragSourceSection = null
  dragSourceIndex = -1
  lastSwapAt = 0
  cachedTiles = []
  cachedSections = []
  cancelAnimationFrame(dragFrame)
  dragFrame = 0
  clearTimeout(flipCleanupTimer)
}

const endPointer = (event) => {
  if (resizeOp && event.pointerId === resizeOp.pointerId) {
    cancelAnimationFrame(resizeFrame)
    resizeFrame = 0
    const { id, startWidth, latestWidth } = resizeOp
    resizeOp = null
    activeResize.value = null
    blockClickUntil = performance.now() + 250
    void nextTick(() => observeTiles())
    if (event.type === 'pointerup' && latestWidth !== startWidth) {
      emit('resize', { id, imageWidth: latestWidth })
    }
    return
  }

  if (!pointer || event.pointerId !== pointer.pointerId) return
  let movePayload = null

  if (drag.value && event.type === 'pointerup' && liveSections.value) {
    const loc = findCardLocation(liveSections.value, pointer.id)
    if (loc && (loc.group !== dragSourceSection || loc.cardIndex !== dragSourceIndex)) {
      const sectionCards = liveSections.value[loc.sectionIndex].cards
      if (loc.cardIndex > 0) {
        movePayload = { id: pointer.id, targetId: sectionCards[loc.cardIndex - 1].id, placement: 'after' }
      } else if (sectionCards.length > 1) {
        movePayload = { id: pointer.id, targetId: sectionCards[1].id, placement: 'before' }
      }
    }
  }

  if (movePayload) {
    emit('reorder', movePayload)
  }
  resetDrag()
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
    void nextTick(() => observeTiles())
    return
  }
  if (pointer) resetDrag()
}

watch(() => props.sections, () => {
  if (!drag.value) liveSections.value = null
}, { flush: 'sync' })

watch(cards, observeTiles, { flush: 'post' })

onMounted(() => {
  if (typeof ResizeObserver === 'function') {
    observer = new ResizeObserver((entries) => sizeTiles(entries.map(({ target }) => target)))
  }
  observeTiles()
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
  grid-template-columns: repeat(auto-fill, minmax(min(100%, 16rem), 1fr));
  grid-auto-flow: dense;
  gap: 0.85rem;
}
.mural-grid--packed { grid-auto-rows: 1px; row-gap: 0; }
.mural-grid--packed .mural-tile { grid-row-end: span var(--mural-card-rows, 1); }
.mural-section + .mural-section { margin-top: 0.95rem; }
.mural-section h4 { margin: 0 0 0.55rem; font-size: 0.78rem; font-weight: 600; color: var(--ayame-text-muted); }
.mural-more { margin-top: 0.45rem; }

.mural-tile {
  position: relative;
  min-width: 0;
  container-type: inline-size;
  will-change: transform;
}

.mural-tile--placeholder {
  border: 1.5px dashed color-mix(in srgb, var(--ayame-primary) 45%, var(--ayame-border));
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ayame-surface) 45%, transparent);
}
.mural-tile--placeholder > * { opacity: 0; pointer-events: none; }

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
  max-height: min(26rem, 62vh);
  border-radius: var(--radius-sm);
}
.mural-tile--resized .mural-card-image {
  width: min(100cqi, var(--mural-image-target-width));
  height: auto;
  max-height: min(46rem, 80vh);
}
.mural-card-content { width: 100%; display: grid; gap: 0.4rem; padding: 0.75rem; }
.mural-card--with-image .mural-card-content {
  width: var(--mural-image-width, 100cqi);
  max-width: 100cqi;
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

.mural-resize-handle {
  position: absolute;
  right: 0.25rem;
  bottom: 0.25rem;
  display: grid;
  place-items: center;
  width: 1.4rem;
  height: 1.4rem;
  padding: 0;
  border: 1px solid var(--ayame-border);
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ayame-surface) 92%, transparent);
  color: var(--ayame-text-muted);
  opacity: 0;
  cursor: nwse-resize;
  touch-action: none;
}
.mural-resize-handle span {
  width: 8px;
  height: 8px;
  border-right: 2px solid currentColor;
  border-bottom: 2px solid currentColor;
}
.mural-tile:hover .mural-resize-handle,
.mural-tile:focus-within .mural-resize-handle,
.mural-tile--resizing .mural-resize-handle { opacity: 1; }

.mural-resize-badge {
  position: absolute;
  left: 0.35rem;
  bottom: 0.35rem;
  padding: 0.12rem 0.38rem;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--ayame-surface-elevated) 92%, transparent);
  border: 1px solid var(--ayame-border);
  color: var(--ayame-text);
  font-size: 0.72rem;
  pointer-events: none;
}

.mural-drag-ghost {
  position: fixed;
  top: 0;
  left: 0;
  z-index: 1000;
  pointer-events: none;
  will-change: transform;
  transform-origin: center center;
}
.mural-card--ghost {
  box-shadow: 0 18px 36px rgba(0, 0, 0, 0.42), 0 0 0 1px color-mix(in srgb, var(--ayame-primary) 55%, var(--ayame-border));
  opacity: 0.96;
}
.mural-card--ghost .mural-card-image { max-width: 100%; }
.mural-card--ghost.mural-card--with-image .mural-card-content { width: 100%; }

@media (max-width: 650px) { .mural-grid { grid-template-columns: repeat(auto-fill, minmax(min(100%, 10.5rem), 1fr)); } }
@media (hover: none) {
  .mural-drag-handle,
  .mural-resize-handle { opacity: 1; }
}
</style>
