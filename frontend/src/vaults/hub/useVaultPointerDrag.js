import { computed, nextTick, onBeforeUnmount, onMounted, shallowRef } from 'vue'

const DRAG_ACTIVATION_PX = 5
const TOUCH_HOLD_MS = 220
const TOUCH_CANCEL_MOVE_PX = 8
const HYSTERESIS_PX = 12
const FLIP_DURATION_MS = 200
const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea'

/**
 * Provides Google Keep-style pointer drag-and-drop reordering for Vault cards.
 * Supports Cards grid, Compact list, and Category-grouped views with FLIP gliding.
 */
export function useVaultPointerDrag({
  containerRef,
  viewMode,
  filteredVaults,
  categorizedGroups,
  disabled,
  onCommit,
}) {
  const pointerDrag = shallowRef(null)
  const pointerDragTarget = shallowRef(null)
  const isPointerDragging = computed(() => Boolean(pointerDrag.value))

  let pointer = null
  let dragFrame = 0
  let flipping = false
  let pendingFlip = null
  let blockClickUntil = 0
  let snapScrollX = 0
  let snapScrollY = 0
  let settledGroups = new Map()
  const flipCleanupTimers = new Map()
  const livePos = { x: 0, y: 0 }

  const draggedCardStyle = (directory) => {
    if (pointerDrag.value?.directory !== directory) return undefined
    return {
      width: `${pointerDrag.value.width}px`,
      height: `${pointerDrag.value.height}px`,
      transform: `translate3d(${livePos.x}px, ${livePos.y}px, 0)`,
    }
  }

  const clearFlipStyles = () => {
    for (const timer of flipCleanupTimers.values()) clearTimeout(timer)
    flipCleanupTimers.clear()
    const root = containerRef.value
    if (!root) return
    for (const el of root.querySelectorAll('[data-vault-directory]')) {
      el.style.transition = ''
      el.style.transform = ''
    }
  }

  const getSettledListElements = (listEl) =>
    Array.from(listEl.children).filter(
      (el) => el.matches('[data-vault-directory], [data-testid="vault-placeholder"]') && !el.classList.contains('vault-card--pointer-dragging')
    )

  const snapshotSettledSlots = () => {
    const root = containerRef.value
    if (!root) return

    snapScrollX = window.scrollX || 0
    snapScrollY = window.scrollY || 0
    const nextGroups = new Map()

    const captureListSlots = (key, listEl, sectionEl) => {
      const prev = settledGroups.get(key)
      const sectionRect = sectionEl ? sectionEl.getBoundingClientRect() : null
      const children = listEl ? getSettledListElements(listEl) : []
      const slots = []

      children.forEach((el, index) => {
        const rect = el.getBoundingClientRect()
        const valid = rect.width > 0 && rect.height > 0
        const fallback = prev?.slots?.[index]
        if (valid) {
          slots.push({
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
          })
        } else if (fallback) {
          slots.push({ ...fallback })
        }
      })

      if (slots.length === 0) {
        const emptyEl = sectionEl?.querySelector('.vault-category-empty-drop') || sectionEl || listEl
        const rect = emptyEl?.getBoundingClientRect()
        if (rect && (rect.width > 0 || rect.height > 0)) {
          slots.push({
            left: rect.left,
            top: rect.top,
            right: rect.right,
            bottom: rect.bottom,
            width: rect.width,
            height: rect.height,
            cx: rect.left + rect.width / 2,
            cy: rect.top + rect.height / 2,
          })
        }
      }

      nextGroups.set(key, { key, sectionRect, slots })
    }

    if (viewMode.value === 'categories') {
      for (const section of root.querySelectorAll('[data-testid="category-drop-zone"]')) {
        const key = section.dataset.categoryKey
        if (!key) continue
        captureListSlots(key, section.querySelector('ul'), section)
      }
    } else {
      const listEl = root.querySelector('.vault-grid, .vault-list')
      captureListSlots('__flat__', listEl, listEl)
    }

    settledGroups = nextGroups
  }

  const resolveDropTarget = (dragCenterX, dragCenterY) => {
    const active = pointerDrag.value
    const current = pointerDragTarget.value
    if (!active || !current) return null

    const dxScroll = (window.scrollX || 0) - snapScrollX
    const dyScroll = (window.scrollY || 0) - snapScrollY
    const cx = dragCenterX + dxScroll
    const cy = dragCenterY + dyScroll

    let targetKey = '__flat__'
    if (viewMode.value === 'categories') {
      let bestGroupDist = Number.POSITIVE_INFINITY
      for (const group of categorizedGroups.value) {
        const snap = settledGroups.get(group.key)
        const rect = snap?.sectionRect
        if (!rect) continue
        const dist = cy < rect.top ? rect.top - cy : (cy > rect.bottom ? cy - rect.bottom : 0)
        if (dist < bestGroupDist) {
          bestGroupDist = dist
          targetKey = group.key
        }
      }
    }

    const snap = settledGroups.get(targetKey)
    if (!snap || snap.slots.length === 0) {
      return { category: viewMode.value === 'categories' ? targetKey : null, index: 0 }
    }

    const candidates = snap.slots.map((slot, index) => ({ ...slot, index }))
    // When hovering a different category that does not hold the placeholder yet,
    // allow appending right after its last card so dropping at the end feels natural.
    if (
      viewMode.value === 'categories' &&
      current.category !== targetKey &&
      candidates.length > 0 &&
      (categorizedGroups.value.find((g) => g.key === targetKey)?.items?.length ?? 0) > 0
    ) {
      const last = candidates[candidates.length - 1]
      candidates.push({
        cx: last.cx + last.width * 0.75,
        cy: last.cy + 12,
        index: candidates.length,
      })
    }

    let bestIdx = candidates[0].index
    let bestDist = Number.POSITIVE_INFINITY
    let currentDist = Number.POSITIVE_INFINITY
    const sameGroup = (viewMode.value === 'categories' ? targetKey : null) === current.category

    for (const candidate of candidates) {
      const d = Math.hypot(candidate.cx - cx, candidate.cy - cy)
      if (sameGroup && candidate.index === current.index) {
        currentDist = d
      }
      if (d < bestDist) {
        bestDist = d
        bestIdx = candidate.index
      }
    }

    if (sameGroup && Number.isFinite(currentDist) && bestDist >= currentDist - HYSTERESIS_PX) {
      bestIdx = current.index
    }

    return {
      category: viewMode.value === 'categories' ? targetKey : null,
      index: bestIdx,
    }
  }

  const moveTargetWithFlip = async (nextCategory, nextIndex) => {
    const current = pointerDragTarget.value
    if (!current || (current.category === nextCategory && current.index === nextIndex)) return
    if (flipping) {
      pendingFlip = { category: nextCategory, index: nextIndex }
      return
    }

    const root = containerRef.value
    if (!root) {
      pointerDragTarget.value = { category: nextCategory, index: nextIndex }
      return
    }

    flipping = true
    const beforeRects = new Map()
    for (const el of root.querySelectorAll('[data-vault-directory]')) {
      if (el.classList.contains('vault-card--pointer-dragging')) continue
      el.style.transition = ''
      el.style.transform = ''
      beforeRects.set(el.dataset.vaultDirectory, el.getBoundingClientRect())
    }

    pointerDragTarget.value = { category: nextCategory, index: nextIndex }
    await nextTick()

    if (!pointerDrag.value) {
      flipping = false
      pendingFlip = null
      return
    }

    snapshotSettledSlots()

    const movedEls = []
    for (const el of root.querySelectorAll('[data-vault-directory]')) {
      if (el.classList.contains('vault-card--pointer-dragging')) continue
      const dir = el.dataset.vaultDirectory
      const before = beforeRects.get(dir)
      if (!before) continue
      const after = el.getBoundingClientRect()
      const dx = before.left - after.left
      const dy = before.top - after.top
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
        el.style.transition = 'none'
        el.style.transform = `translate3d(${dx}px, ${dy}px, 0)`
        movedEls.push({ dir, el })
      }
    }

    if (movedEls.length > 0) {
      void root.offsetHeight
      for (const { dir, el } of movedEls) {
        const oldTimer = flipCleanupTimers.get(dir)
        if (oldTimer) clearTimeout(oldTimer)
        el.style.transition = `transform ${FLIP_DURATION_MS}ms cubic-bezier(0.2, 0, 0, 1)`
        el.style.transform = ''
        const timer = setTimeout(() => {
          el.style.transition = ''
          flipCleanupTimers.delete(dir)
        }, FLIP_DURATION_MS + 40)
        flipCleanupTimers.set(dir, timer)
      }
    }

    flipping = false
    if (pendingFlip && pointerDrag.value) {
      const queued = pendingFlip
      pendingFlip = null
      void moveTargetWithFlip(queued.category, queued.index)
    }
  }

  const findInitialLocation = (cardEl, directory) => {
    if (viewMode.value === 'categories') {
      const categoryKey = cardEl.closest('[data-category-key]')?.dataset.categoryKey ?? null
      const group = categorizedGroups.value.find((g) => g.key === categoryKey)
      const index = group ? group.items.findIndex((v) => v.directory === directory) : 0
      return { sourceCategory: categoryKey, sourceIndex: Math.max(0, index) }
    }
    const index = filteredVaults.value.findIndex((v) => v.directory === directory)
    return { sourceCategory: null, sourceIndex: Math.max(0, index) }
  }

  const stepDrag = () => {
    dragFrame = 0
    if (!pointerDrag.value || !pointer) return

    const tx = pointer.x - pointer.offsetX
    const ty = pointer.y - pointer.offsetY
    livePos.x = tx
    livePos.y = ty

    const draggedEl = containerRef.value?.querySelector(`[data-vault-directory="${CSS?.escape ? CSS.escape(pointerDrag.value.directory) : pointerDrag.value.directory}"]`)
    if (draggedEl) {
      draggedEl.style.transform = `translate3d(${tx}px, ${ty}px, 0)`
    }

    const margin = 64
    const distance = pointer.y < margin ? pointer.y - margin : Math.max(0, pointer.y - (window.innerHeight - margin))
    if (distance && typeof window.scrollBy === 'function') {
      window.scrollBy(0, Math.sign(distance) * Math.min(26, Math.ceil(Math.abs(distance) / 3)))
    }

    const dragCenterX = tx + pointerDrag.value.width / 2
    const dragCenterY = ty + pointerDrag.value.height / 2
    const nextTarget = resolveDropTarget(dragCenterX, dragCenterY)
    if (nextTarget) {
      void moveTargetWithFlip(nextTarget.category, nextTarget.index)
    }

    if (pointerDrag.value) {
      dragFrame = requestAnimationFrame(stepDrag)
    }
  }

  const beginActiveDrag = async () => {
    if (!pointer || pointerDrag.value) return
    snapshotSettledSlots()

    try {
      containerRef.value?.setPointerCapture?.(pointer.pointerId)
    } catch {}

    livePos.x = pointer.x - pointer.offsetX
    livePos.y = pointer.y - pointer.offsetY
    pointerDragTarget.value = { category: pointer.sourceCategory, index: pointer.sourceIndex }
    pointerDrag.value = {
      directory: pointer.directory,
      sourceCategory: pointer.sourceCategory,
      sourceIndex: pointer.sourceIndex,
      width: pointer.width,
      height: pointer.height,
    }

    await nextTick()
    if (pointerDrag.value) {
      snapshotSettledSlots()
      if (!dragFrame) dragFrame = requestAnimationFrame(stepDrag)
    }
  }

  const startPointer = (event) => {
    if (pointer || pointerDrag.value || disabled.value || event.button !== 0 || event.isPrimary === false) return
    if (viewMode.value !== 'categories' && filteredVaults.value.length < 2) return
    if (event.target?.closest?.(INTERACTIVE_SELECTOR)) return

    const cardEl = event.target?.closest?.('[data-vault-directory]')
    const directory = cardEl?.dataset.vaultDirectory
    if (!directory) return

    const rect = cardEl.getBoundingClientRect()
    const { sourceCategory, sourceIndex } = findInitialLocation(cardEl, directory)
    const isTouch = event.pointerType === 'touch'

    pointer = {
      pointerId: event.pointerId,
      directory,
      sourceCategory,
      sourceIndex,
      isTouch,
      touchReady: !isTouch,
      holdTimer: null,
      startX: event.clientX,
      startY: event.clientY,
      x: event.clientX,
      y: event.clientY,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
      width: Math.round(rect.width || 290),
      height: Math.round(rect.height || 180),
    }

    if (isTouch) {
      pointer.holdTimer = setTimeout(() => {
        if (pointer) {
          pointer.touchReady = true
          void beginActiveDrag()
        }
      }, TOUCH_HOLD_MS)
    }
  }

  const trackPointer = (event) => {
    if (!pointer || event.pointerId !== pointer.pointerId) return
    pointer.x = event.clientX
    pointer.y = event.clientY

    if (!pointerDrag.value) {
      const moved = Math.hypot(pointer.x - pointer.startX, pointer.y - pointer.startY)
      if (pointer.isTouch && !pointer.touchReady) {
        if (moved > TOUCH_CANCEL_MOVE_PX) {
          clearTimeout(pointer.holdTimer)
          pointer = null
        }
        return
      }
      if (moved < DRAG_ACTIVATION_PX) return
      void beginActiveDrag()
    }
    event.preventDefault()
  }

  const resetDrag = () => {
    if (pointer?.holdTimer) clearTimeout(pointer.holdTimer)
    if (pointerDrag.value) blockClickUntil = performance.now() + 250
    pointer = null
    pointerDrag.value = null
    pointerDragTarget.value = null
    pendingFlip = null
    flipping = false
    settledGroups = new Map()
    cancelAnimationFrame(dragFrame)
    dragFrame = 0
    clearFlipStyles()
  }

  const endPointer = (event) => {
    if (!pointer || event.pointerId !== pointer.pointerId) return
    const active = pointerDrag.value
    const target = pointerDragTarget.value
    const shouldCommit = Boolean(
      active &&
      target &&
      event.type === 'pointerup' &&
      (target.category !== active.sourceCategory || target.index !== active.sourceIndex)
    )

    resetDrag()

    if (shouldCommit) {
      void onCommit({
        directory: active.directory,
        sourceCategory: active.sourceCategory,
        sourceIndex: active.sourceIndex,
        targetCategory: target.category,
        targetIndex: target.index,
      })
    }
  }

  const suppressDragClick = (event) => {
    if (event.detail === 0 || performance.now() >= blockClickUntil) return
    event.stopPropagation()
    event.preventDefault()
  }

  const cancelWithEscape = (event) => {
    if (event.key === 'Escape' && pointer) {
      resetDrag()
    }
  }

  onMounted(() => {
    window.addEventListener('pointermove', trackPointer, { passive: false })
    window.addEventListener('pointerup', endPointer)
    window.addEventListener('pointercancel', endPointer)
    window.addEventListener('keydown', cancelWithEscape)
  })

  onBeforeUnmount(() => {
    resetDrag()
    window.removeEventListener('pointermove', trackPointer)
    window.removeEventListener('pointerup', endPointer)
    window.removeEventListener('pointercancel', endPointer)
    window.removeEventListener('keydown', cancelWithEscape)
  })

  return {
    pointerDrag,
    pointerDragTarget,
    isPointerDragging,
    draggedCardStyle,
    startPointer,
    suppressDragClick,
    cancelDrag: resetDrag,
  }
}
