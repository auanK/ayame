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
    expect(pos.left).toBe(250)
    expect(pos.top).toBe(300)
    expect(pos.left + menuDimensions.width).toBeLessThanOrEqual(viewport.width)
    expect(pos.top + menuDimensions.height).toBeLessThanOrEqual(viewport.height)
  })

  it('anchors to element rect (below the element) when within viewport', () => {
    const rect = { left: 100, top: 50, right: 140, bottom: 80, width: 40, height: 30 }
    const pos = calculateContextMenuPosition({
      anchor: { type: 'element', rect },
      menuDimensions,
      viewport,
    })
    expect(pos.left).toBe(rect.left)
    expect(pos.top).toBeGreaterThanOrEqual(rect.bottom)
    expect(pos.left + menuDimensions.width).toBeLessThanOrEqual(viewport.width)
    expect(pos.top + menuDimensions.height).toBeLessThanOrEqual(viewport.height)
  })

  it('prevents overflow and stays within viewport when pointer is near the right edge', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 1000, clientY: 200 },
      menuDimensions,
      viewport,
    })
    expect(pos.left).toBeGreaterThanOrEqual(0)
    expect(pos.left + menuDimensions.width).toBeLessThanOrEqual(viewport.width)
    expect(pos.top).toBe(200)
  })

  it('prevents overflow and stays within viewport when pointer is near the bottom edge', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 200, clientY: 700 },
      menuDimensions,
      viewport,
    })
    expect(pos.top).toBeGreaterThanOrEqual(0)
    expect(pos.top + menuDimensions.height).toBeLessThanOrEqual(viewport.height)
    expect(pos.left).toBe(200)
  })

  it('flips above element when element is near the bottom of viewport', () => {
    const rect = { left: 100, top: 700, right: 140, bottom: 730, width: 40, height: 30 }
    const pos = calculateContextMenuPosition({
      anchor: { type: 'element', rect },
      menuDimensions,
      viewport,
    })
    expect(pos.top + menuDimensions.height).toBeLessThanOrEqual(rect.top)
    expect(pos.top).toBeGreaterThanOrEqual(0)
  })

  it('keeps menu within viewport boundaries when coordinates are near origin', () => {
    const pos = calculateContextMenuPosition({
      anchor: { type: 'pointer', clientX: 2, clientY: 2 },
      menuDimensions,
      viewport,
    })
    expect(pos.left).toBeGreaterThanOrEqual(0)
    expect(pos.top).toBeGreaterThanOrEqual(0)
    expect(pos.left + menuDimensions.width).toBeLessThanOrEqual(viewport.width)
    expect(pos.top + menuDimensions.height).toBeLessThanOrEqual(viewport.height)
  })
})
