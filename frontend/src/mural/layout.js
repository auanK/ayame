import { MURAL_MAX_IMAGE_WIDTH, MURAL_MIN_IMAGE_WIDTH } from '../../../shared/mural.js'

export const MURAL_GAP = 12
const MIN_COLUMN_WIDTH = 256
const MAX_DEFAULT_IMAGE_HEIGHT = 360

export const computeBaseColumnWidth = (containerWidth, gap = MURAL_GAP) => {
  if (!Number.isFinite(containerWidth) || containerWidth <= 0) return 260
  if (containerWidth < 540) {
    const cols = containerWidth < 360 ? 1 : 2
    return Math.max(140, Math.floor((containerWidth - gap * (cols - 1)) / cols))
  }
  const cols = Math.max(2, Math.floor((containerWidth + gap) / (MIN_COLUMN_WIDTH + gap)))
  return Math.max(200, Math.floor((containerWidth - gap * (cols - 1)) / cols))
}

export const computeCardWidth = (
  card,
  containerWidth,
  baseWidth,
  { overrideWidth = null, aspectRatio = null, maxDefaultImageHeight = MAX_DEFAULT_IMAGE_HEIGHT } = {}
) => {
  const safeContainer = Number.isFinite(containerWidth) && containerWidth > 0 ? Math.floor(containerWidth) : 1024
  const maxW = Math.max(MURAL_MIN_IMAGE_WIDTH, Math.min(MURAL_MAX_IMAGE_WIDTH, safeContainer))

  if (overrideWidth != null && Number.isFinite(overrideWidth)) {
    return Math.min(maxW, Math.max(MURAL_MIN_IMAGE_WIDTH, Math.round(overrideWidth)))
  }

  if (card?.imageVersion) {
    if (card.imageWidth != null && Number.isFinite(card.imageWidth)) {
      return Math.min(maxW, Math.max(MURAL_MIN_IMAGE_WIDTH, Math.round(card.imageWidth)))
    }
    if (card.kind === 'note') {
      return Math.min(safeContainer, Math.max(140, Math.round(baseWidth)))
    }
    let width = Math.min(maxW, Math.round(baseWidth * 1.15))
    if (aspectRatio != null && Number.isFinite(aspectRatio) && aspectRatio > 0 && width / aspectRatio > maxDefaultImageHeight) {
      width = Math.min(maxW, Math.max(MURAL_MIN_IMAGE_WIDTH, Math.round(maxDefaultImageHeight * aspectRatio)))
    }
    return Math.max(MURAL_MIN_IMAGE_WIDTH, width)
  }

  return Math.min(safeContainer, Math.max(140, Math.round(baseWidth)))
}

const mergeSkyline = (skyline) => {
  if (skyline.length <= 1) return skyline
  const merged = [{ ...skyline[0] }]
  for (let i = 1; i < skyline.length; i++) {
    const seg = skyline[i]
    const prev = merged[merged.length - 1]
    if (Math.abs(prev.y - seg.y) < 0.5 && Math.abs(prev.x + prev.w - seg.x) < 0.5) {
      prev.w += seg.w
    } else if (seg.w > 0.25) {
      merged.push({ ...seg })
    }
  }
  return merged
}

const replaceSkylineRange = (skyline, startX, endX, newY) => {
  const next = []
  let inserted = false

  for (const seg of skyline) {
    const segEnd = seg.x + seg.w
    if (segEnd <= startX + 0.01 || seg.x >= endX - 0.01) {
      if (!inserted && seg.x >= endX - 0.01) {
        next.push({ x: startX, w: endX - startX, y: newY })
        inserted = true
      }
      next.push(seg)
      continue
    }

    if (seg.x < startX - 0.01) {
      next.push({ x: seg.x, w: startX - seg.x, y: seg.y })
    }
    if (!inserted) {
      next.push({ x: startX, w: endX - startX, y: newY })
      inserted = true
    }
    if (segEnd > endX + 0.01) {
      next.push({ x: endX, w: segEnd - endX, y: seg.y })
    }
  }

  if (!inserted) {
    next.push({ x: startX, w: endX - startX, y: newY })
  }

  return mergeSkyline(next)
}

export const packSkyline = (items, containerWidth, gap = MURAL_GAP) => {
  const positions = new Map()
  if (!Array.isArray(items) || items.length === 0) {
    return { positions, height: 0 }
  }

  const safeWidth = Number.isFinite(containerWidth) && containerWidth > 0 ? containerWidth : 1024
  let skyline = [{ x: 0, w: safeWidth, y: 0 }]

  for (const item of items) {
    const w = Math.min(safeWidth, Math.max(1, item.width))
    const h = Math.max(1, item.height)

    let bestX = 0
    let bestY = Number.POSITIVE_INFINITY

    for (const seg of skyline) {
      if (seg.x + w > safeWidth + 0.5) continue
      const candidateEnd = seg.x + w
      let maxY = 0
      for (const span of skyline) {
        const spanEnd = span.x + span.w
        if (spanEnd <= seg.x + 0.01) continue
        if (span.x >= candidateEnd - 0.01) break
        if (span.y > maxY) maxY = span.y
      }
      if (maxY < bestY - 1.5 || (Math.abs(maxY - bestY) <= 1.5 && seg.x < bestX)) {
        bestY = maxY
        bestX = seg.x
      }
    }

    if (!Number.isFinite(bestY)) {
      bestX = 0
      bestY = Math.max(...skyline.map((s) => s.y))
    }

    positions.set(item.id, { x: bestX, y: bestY, width: w, height: h })
    const occupiedEnd = Math.min(safeWidth, bestX + w + gap)
    skyline = replaceSkylineRange(skyline, bestX, occupiedEnd, bestY + h + gap)
  }

  const maxBottom = Math.max(...skyline.map((s) => s.y))
  return {
    positions,
    height: Math.max(0, Math.ceil(maxBottom - gap)),
  }
}

export const findBestDropIndex = ({
  others,
  draggedId,
  draggedSize,
  currentIndex = -1,
  centerX,
  centerY,
  containerWidth,
  gap = MURAL_GAP,
  hysteresis = 10,
}) => {
  if (!Array.isArray(others) || others.length === 0) return 0

  let candidateIndices
  if (others.length <= 24) {
    candidateIndices = Array.from({ length: others.length + 1 }, (_, i) => i)
  } else {
    const { positions } = packSkyline(others, containerWidth, gap)
    const ranked = others
      .map((item, idx) => {
        const pos = positions.get(item.id)
        const d = pos
          ? Math.hypot(pos.x + pos.width / 2 - centerX, pos.y + pos.height / 2 - centerY)
          : Number.POSITIVE_INFINITY
        return { idx, d }
      })
      .sort((a, b) => a.d - b.d)
      .slice(0, 6)

    const set = new Set([0, others.length])
    if (currentIndex >= 0) {
      set.add(Math.max(0, currentIndex - 1))
      set.add(Math.min(others.length, currentIndex))
      set.add(Math.min(others.length, currentIndex + 1))
    }
    for (const { idx } of ranked) {
      set.add(idx)
      set.add(idx + 1)
    }
    candidateIndices = Array.from(set).sort((a, b) => a - b)
  }

  const probeItem = { id: draggedId, width: draggedSize.width, height: draggedSize.height }
  let bestIdx = candidateIndices[0]
  let bestDist = Number.POSITIVE_INFINITY
  let currentDist = Number.POSITIVE_INFINITY

  for (const idx of candidateIndices) {
    const trial = [...others]
    trial.splice(idx, 0, probeItem)
    const { positions } = packSkyline(trial, containerWidth, gap)
    const slot = positions.get(draggedId)
    if (!slot) continue
    const dist = Math.hypot(slot.x + slot.width / 2 - centerX, slot.y + slot.height / 2 - centerY)
    if (idx === currentIndex) currentDist = dist
    if (dist < bestDist) {
      bestDist = dist
      bestIdx = idx
    }
  }

  if (currentIndex >= 0 && currentIndex <= others.length && Number.isFinite(currentDist)) {
    if (bestDist >= currentDist - hysteresis) return currentIndex
  }

  return bestIdx
}
