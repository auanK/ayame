import { describe, expect, it } from 'vitest'
import { calculateContextMenuPosition } from './contextMenuPosition.js'

describe('calculateContextMenuPosition', () => {
  const menuDimensions = { width: 180, height: 220 }
  const viewport = { width: 1024, height: 768 }

  it('anchors to pointer coordinates when within viewport', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 250, clientY: 300 },
      menuDimensions,
      viewport,
    })
    expect(pos).toEqual({ left: 250, top: 300 })
  })

  it('anchors to element rect (below the element) when within viewport', () => {
    const rect = { left: 100, top: 50, right: 140, bottom: 80, width: 40, height: 30 }
    const pos = calculateContextMenuPosition({
      anchor: { type: 'element', rect },
      menuDimensions,
      viewport,
    })
    expect(pos).toEqual({ left: 100, top: 82 })
  })

  it('clamps and flips left when pointer is near the right edge', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 1000, clientY: 200 },
      menuDimensions,
      viewport,
    })
    // 1000 - 180 = 820
    expect(pos.left).toBeLessThanOrEqual(viewport.width - menuDimensions.width - 8)
    expect(pos.left).toBe(820)
    expect(pos.top).toBe(200)
  })

  it('clamps and flips up when pointer is near the bottom edge', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 200, clientY: 700 },
      menuDimensions,
      viewport,
    })
    // 700 - 220 = 480
    expect(pos.top).toBeLessThanOrEqual(viewport.height - menuDimensions.height - 8)
    expect(pos.top).toBe(480)
    expect(pos.left).toBe(200)
  })

  it('flips above element when element is near the bottom of viewport', () => {
    const rect = { left: 100, top: 700, right: 140, bottom: 730, width: 40, height: 30 }
    const pos = calculateContextMenuPosition({
      anchor: { type: 'element', rect },
      menuDimensions,
      viewport,
    })
    // top = 700 - 220 - 2 = 478
    expect(pos.top).toBe(478)
  })

  it('never positions outside viewport margin (min 8px margin)', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 2, clientY: 2 },
      menuDimensions,
      viewport,
    })
    expect(pos.left).toBe(8)
    expect(pos.top).toBe(8)
  })
})
