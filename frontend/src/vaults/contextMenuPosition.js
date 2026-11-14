/**
 * Calculates clamped and viewport-aware position for contextual menus.
 *
 * @param {Object} options
 * @param {Object} options.anchor - { type: 'pointer', clientX, clientY } or { type: 'element', rect: { left, top, right, bottom, width, height } }
 * @param {{ width: number, height: number }} options.menuDimensions - Dimensions of the menu element
 * @param {{ width: number, height: number }} options.viewport - Viewport dimensions
 * @param {number} [options.margin=8] - Minimum distance from viewport edges
 * @returns {{ left: number, top: number }}
 */
export function calculateContextMenuPosition({
  anchor,
  menuDimensions = { width: 180, height: 200 },
  viewport = { width: 1024, height: 768 },
  margin = 8,
}) {
  let left = 0
  let top = 0

  if (!anchor) {
    return { left: margin, top: margin }
  }

  if (anchor.type === 'element' && anchor.rect) {
    // Prefer opening just below the element, aligned to its left
    left = anchor.rect.left
    top = anchor.rect.bottom + 2

    // If it would overflow right, align to element's right
    if (left + menuDimensions.width > viewport.width - margin) {
      left = anchor.rect.right - menuDimensions.width
    }

    // If still overflows, clamp to right edge
    if (left + menuDimensions.width > viewport.width - margin) {
      left = viewport.width - menuDimensions.width - margin
    }

    // If it overflows bottom, flip to above the element
    if (top + menuDimensions.height > viewport.height - margin) {
      top = anchor.rect.top - menuDimensions.height - 2
    }
  } else {
    // Pointer anchor (right click)
    left = anchor.clientX ?? 0
    top = anchor.clientY ?? 0

    // If opening to the right would overflow, shift to left of pointer
    if (left + menuDimensions.width > viewport.width - margin) {
      left = Math.max(margin, left - menuDimensions.width)
    }

    // If opening downwards would overflow, shift upwards
    if (top + menuDimensions.height > viewport.height - margin) {
      top = Math.max(margin, top - menuDimensions.height)
    }
  }

  // Ensure within bounds
  left = Math.max(margin, Math.min(left, viewport.width - menuDimensions.width - margin))
  top = Math.max(margin, Math.min(top, viewport.height - menuDimensions.height - margin))

  return { left: Math.round(left), top: Math.round(top) }
}
