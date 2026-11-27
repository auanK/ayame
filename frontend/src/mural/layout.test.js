import { describe, expect, it } from 'vitest'
import {
  MURAL_GAP,
  computeBaseColumnWidth,
  computeCardWidth,
  findBestDropIndex,
  packSkyline,
} from './layout.js'

describe('mural skyline layout & drop math', () => {
  it('packs equal-width text notes cleanly into Keep-style masonry columns', () => {
    const containerWidth = 800
    const colW = computeBaseColumnWidth(containerWidth, MURAL_GAP)
    const items = [
      { id: 'a', width: colW, height: 140 },
      { id: 'b', width: colW, height: 90 },
      { id: 'c', width: colW, height: 110 },
      { id: 'd', width: colW, height: 100 },
    ]
    const { positions, height } = packSkyline(items, containerWidth, MURAL_GAP)

    expect(positions.get('a')).toEqual({ x: 0, y: 0, width: colW, height: 140 })
    expect(positions.get('b')).toEqual({ x: colW + MURAL_GAP, y: 0, width: colW, height: 90 })
    expect(positions.get('c')).toEqual({ x: (colW + MURAL_GAP) * 2, y: 0, width: colW, height: 110 })
    // 4th item goes under shortest column ('b', height 90 + gap)
    expect(positions.get('d')).toEqual({ x: colW + MURAL_GAP, y: 90 + MURAL_GAP, width: colW, height: 100 })
    expect(height).toBe(90 + MURAL_GAP + 100)
  })

  it('packs shrunk (160px) and enlarged (480px) images tightly with zero empty column voids', () => {
    const containerWidth = 1000
    const base = computeBaseColumnWidth(containerWidth, MURAL_GAP)
    const shrunkWidth = computeCardWidth({ imageVersion: 'v1', imageWidth: 160 }, containerWidth, base)
    const largeWidth = computeCardWidth({ imageVersion: 'v2', imageWidth: 480 }, containerWidth, base)
    expect(shrunkWidth).toBe(160)
    expect(largeWidth).toBe(480)

    const items = [
      { id: 'small', width: 160, height: 120 },
      { id: 'large', width: 480, height: 220 },
      { id: 'note', width: base, height: 140 },
    ]
    const { positions } = packSkyline(items, containerWidth, MURAL_GAP)

    // Large card starts immediately at 160 + MURAL_GAP, NOT at ~300px CSS Grid track boundary!
    expect(positions.get('small').x).toBe(0)
    expect(positions.get('large').x).toBe(160 + MURAL_GAP)
    // Note fits directly at 160 + MURAL_GAP + 480 + MURAL_GAP on the same row
    expect(positions.get('note').x).toBe(160 + MURAL_GAP + 480 + MURAL_GAP)
    expect(positions.get('note').y).toBe(0)
  })

  it('selects drop index across unequal-width cards without ping-pong oscillation', () => {
    const containerWidth = 800
    const draggedSize = { width: 160, height: 120 }
    const otherLarge = { id: 'big', width: 420, height: 200 }
    const otherNote = { id: 'note', width: 200, height: 120 }
    const others = [otherLarge, otherNote]

    // Move dragged card from index 0 toward the right side of 'big' (where index 1 lands)
    const idx1 = findBestDropIndex({
      others,
      draggedId: 'small',
      draggedSize,
      currentIndex: 0,
      centerX: 450,
      centerY: 100,
      containerWidth,
    })
    expect(idx1).toBe(1)

    // Re-evaluating at the exact same pointer coordinates must stay at index 1 (never ping-pong back to 0)
    const idx1Stable = findBestDropIndex({
      others,
      draggedId: 'small',
      draggedSize,
      currentIndex: idx1,
      centerX: 450,
      centerY: 100,
      containerWidth,
    })
    expect(idx1Stable).toBe(1)
  })

  it('keeps un-resized text notes with a background image at base column width while honoring explicit resize', () => {
    const containerWidth = 1000
    const base = computeBaseColumnWidth(containerWidth, MURAL_GAP)
    expect(computeCardWidth({ kind: 'note', imageVersion: 'v1' }, containerWidth, base, { aspectRatio: 0.4 })).toBe(base)
    expect(computeCardWidth({ kind: 'note', imageVersion: 'v1', imageWidth: 420 }, containerWidth, base)).toBe(420)
    expect(computeCardWidth({ kind: 'image', imageVersion: 'v1' }, containerWidth, base)).toBe(Math.round(base * 1.15))
  })
})
