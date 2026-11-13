<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue'
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceX,
  forceY,
} from 'd3-force'

const props = defineProps({
  graph: {
    type: Object,
    required: true,
  },
  vaultDirectory: {
    type: String,
    default: '',
  },
  loading: {
    type: Boolean,
    default: false,
  },
  error: {
    type: Boolean,
    default: false,
  },
  activeNotePath: {
    type: String,
    default: null,
  },
})

const emit = defineEmits(['open-note', 'retry'])

const MIN_SCALE = 0.15
const MAX_SCALE = 6
const DRAG_THRESHOLD_PX = 4
const LOCATOR_LIMIT = 12
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))

const containerRef = ref(null)
const canvasRef = ref(null)
const locatorRef = ref(null)

const locatorQuery = ref('')
const locatorOpen = ref(false)
const locatorActiveIndex = ref(0)
const hoveredNodeInfo = ref(null)
const isGrabbing = ref(false)

const viewport = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  hoveredNodeId: null,
  draggingNodeId: null,
  panning: false,
}

let isUnmounted = false
let simulation = null
let simNodes = []
let simLinks = []
let simNodesById = new Map()
let neighborsById = new Map()
let duplicateLabelCounts = new Map()
let currentStructureKey = ''
let currentVaultKey = props.vaultDirectory

let viewWidth = 0
let viewHeight = 0
let dpr = 1
let rafId = null
let resizeObserver = null

let pointerDownPos = null
let panOrigin = null
let didDrag = false
let activePointerId = null

const hasNodes = computed(() => Array.isArray(props.graph?.nodes) && props.graph.nodes.length > 0)
const hasFailures = computed(
  () => Array.isArray(props.graph?.failures) && props.graph.failures.length > 0
)
const isIncomplete = computed(() => Boolean(props.graph && !props.graph.complete && hasFailures.value))

const viewStatus = computed(() => {
  if (props.loading && !hasNodes.value) return 'loading'
  if (props.error && !hasNodes.value) return 'error'
  if (!hasNodes.value && hasFailures.value) return 'incomplete-empty'
  if (!hasNodes.value) return 'empty'
  return 'ready'
})

const canvasAriaLabel = computed(() => {
  const nodesCount = props.graph?.nodes?.length || 0
  const edgesCount = props.graph?.edges?.length || 0
  return `Global graph with ${nodesCount} notes and ${edgesCount} connections`
})

const locatorMatches = computed(() => {
  const nodes = Array.isArray(props.graph?.nodes) ? props.graph.nodes : []
  const q = locatorQuery.value.trim().toLowerCase()
  const filtered = q
    ? nodes.filter(
        (n) => n.label.toLowerCase().includes(q) || n.path.toLowerCase().includes(q)
      )
    : nodes
  return filtered.slice(0, LOCATOR_LIMIT)
})

const clamp = (value, min, max) => Math.max(min, Math.min(max, value))

const computeStructureKey = (graph) => {
  const nodeIds = (graph?.nodes || []).map((n) => n.id).join('\n')
  const edgeKeys = (graph?.edges || []).map((e) => `${e.source}->${e.target}`).join('\n')
  return `${nodeIds}\0${edgeKeys}`
}

const nodeRadiusForDegree = (degree) => 3.8 + Math.min(8, Math.sqrt(Math.max(0, degree)) * 1.4)

const screenToWorld = (sx, sy) => ({
  x: (sx - viewWidth / 2 - viewport.offsetX) / viewport.scale,
  y: (sy - viewHeight / 2 - viewport.offsetY) / viewport.scale,
})

const findNodeAtScreen = (sx, sy) => {
  const { x: wx, y: wy } = screenToWorld(sx, sy)
  const scalePow = Math.pow(viewport.scale, 0.7)
  for (let i = simNodes.length - 1; i >= 0; i--) {
    const node = simNodes[i]
    if (typeof node.x !== 'number' || typeof node.y !== 'number') continue
    const screenRadius = Math.max(2.5, node.radius * scalePow)
    const hitRadiusWorld = Math.max(screenRadius + 5, 8) / viewport.scale
    const dx = wx - node.x
    const dy = wy - node.y
    if (dx * dx + dy * dy <= hitRadiusWorld * hitRadiusWorld) {
      return node
    }
  }
  return null
}

const updateHoveredNode = (node) => {
  const nextId = node ? node.id : null
  if (viewport.hoveredNodeId === nextId) return false
  viewport.hoveredNodeId = nextId
  hoveredNodeInfo.value = node
    ? { id: node.id, path: node.path, label: node.label, degree: node.degree }
    : null
  return true
}

const cancelPendingDraw = () => {
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

const draw = () => {
  rafId = null
  if (isUnmounted) return
  const canvas = canvasRef.value
  if (!canvas || viewWidth <= 0 || viewHeight <= 0) return
  const ctx = typeof canvas.getContext === 'function' ? canvas.getContext('2d') : null
  if (!ctx) return

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, viewWidth, viewHeight)

  const cx = viewWidth / 2 + viewport.offsetX
  const cy = viewHeight / 2 + viewport.offsetY
  const scale = viewport.scale
  const scalePow = Math.pow(scale, 0.7)

  for (let i = 0; i < simNodes.length; i++) {
    const n = simNodes[i]
    n._sx = (n.x || 0) * scale + cx
    n._sy = (n.y || 0) * scale + cy
    n._sr = Math.max(2.4, n.radius * scalePow)
  }

  const focusedId = viewport.draggingNodeId || viewport.hoveredNodeId
  const focusedNeighbors = focusedId ? neighborsById.get(focusedId) : null

  // Draw edges
  for (let i = 0; i < simLinks.length; i++) {
    const link = simLinks[i]
    const s = link.source
    const t = link.target
    if (!s || !t || s === t) continue

    const isHighlighted = focusedId && (s.id === focusedId || t.id === focusedId)
    if (focusedId && !isHighlighted) {
      ctx.strokeStyle = 'rgba(170, 166, 184, 0.08)'
      ctx.lineWidth = 0.8
    } else if (isHighlighted) {
      ctx.strokeStyle = 'rgba(169, 154, 202, 0.88)'
      ctx.lineWidth = 1.4
    } else {
      ctx.strokeStyle = 'rgba(170, 166, 184, 0.25)'
      ctx.lineWidth = 1
    }

    ctx.beginPath()
    ctx.moveTo(s._sx, s._sy)
    ctx.lineTo(t._sx, t._sy)
    ctx.stroke()
  }

  // Draw nodes
  for (let i = 0; i < simNodes.length; i++) {
    const n = simNodes[i]
    const isFocused = n.id === focusedId
    const isNeighbor = focusedNeighbors ? focusedNeighbors.has(n.id) : false
    const isActiveNote = props.activeNotePath && n.path === props.activeNotePath

    if (focusedId && !isFocused && !isNeighbor) {
      ctx.fillStyle = 'rgba(170, 166, 184, 0.2)'
    } else if (isFocused) {
      ctx.fillStyle = '#d4cbe4'
    } else if (isNeighbor || isActiveNote) {
      ctx.fillStyle = '#a99aca'
    } else {
      ctx.fillStyle = '#8f8ba3'
    }

    ctx.beginPath()
    ctx.arc(n._sx, n._sy, isFocused ? n._sr + 1.5 : n._sr, 0, Math.PI * 2)
    ctx.fill()

    if (isFocused || isActiveNote) {
      ctx.strokeStyle = isFocused ? 'rgba(238, 234, 243, 0.85)' : 'rgba(169, 154, 202, 0.65)'
      ctx.lineWidth = 1.25
      ctx.stroke()
    }
  }

  // Draw labels only when zoom justifies them or when node is focused/neighbor
  const baseLabelAlpha = scale < 0.48 ? 0 : Math.min(0.88, (scale - 0.48) / 0.45)
  if (baseLabelAlpha > 0 || focusedId) {
    ctx.font = '11.5px system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'

    for (let i = 0; i < simNodes.length; i++) {
      const n = simNodes[i]
      if (n._sx < -120 || n._sx > viewWidth + 120 || n._sy < -40 || n._sy > viewHeight + 40) {
        continue
      }

      const isFocused = n.id === focusedId
      const isNeighbor = focusedNeighbors ? focusedNeighbors.has(n.id) : false

      let alpha = baseLabelAlpha
      if (focusedId) {
        if (isFocused) alpha = 1
        else if (isNeighbor) alpha = Math.max(0.82, baseLabelAlpha)
        else alpha = baseLabelAlpha * 0.18
      }

      if (alpha < 0.05) continue

      const showFolderDisambiguator =
        isFocused && (duplicateLabelCounts.get(n.label) || 0) > 1
      const text = showFolderDisambiguator ? n.path.replace(/\.(md|markdown)$/i, '') : n.label

      ctx.fillStyle = isFocused
        ? `rgba(238, 234, 243, ${alpha})`
        : `rgba(212, 203, 228, ${alpha})`
      ctx.fillText(text, n._sx, n._sy + n._sr + 5)
    }
  }
}

const scheduleDraw = () => {
  if (isUnmounted || rafId !== null) return
  if (typeof requestAnimationFrame !== 'function') return
  rafId = requestAnimationFrame(draw)
}

const stopSimulation = () => {
  if (simulation) {
    simulation.on('tick', null)
    simulation.on('end', null)
    simulation.stop()
    simulation = null
  }
}

const syncSimulationWithModel = (graph) => {
  const vaultChanged = currentVaultKey !== props.vaultDirectory
  if (vaultChanged) {
    currentVaultKey = props.vaultDirectory
    stopSimulation()
    simNodes = []
    simLinks = []
    simNodesById = new Map()
    neighborsById = new Map()
    currentStructureKey = ''
    viewport.scale = 1
    viewport.offsetX = 0
    viewport.offsetY = 0
    updateHoveredNode(null)
    viewport.draggingNodeId = null
    viewport.panning = false
    isGrabbing.value = false
  }

  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : []

  if (rawNodes.length === 0) {
    stopSimulation()
    simNodes = []
    simLinks = []
    simNodesById = new Map()
    neighborsById = new Map()
    duplicateLabelCounts = new Map()
    currentStructureKey = ''
    updateHoveredNode(null)
    cancelPendingDraw()
    return
  }

  const nextStructureKey = computeStructureKey(graph)
  const labelCounts = new Map()
  for (const n of rawNodes) {
    labelCounts.set(n.label, (labelCounts.get(n.label) || 0) + 1)
  }
  duplicateLabelCounts = labelCounts

  if (simulation && nextStructureKey === currentStructureKey) {
    // Update non-structural metadata without disturbing node positions or restarting physics.
    for (const rawNode of rawNodes) {
      const existing = simNodesById.get(rawNode.id)
      if (existing) {
        existing.label = rawNode.label
        existing.degree = rawNode.degree
        existing.radius = nodeRadiusForDegree(rawNode.degree)
      }
    }
    scheduleDraw()
    return
  }

  const hadExistingNodes = simNodesById.size > 0 && !vaultChanged
  const previousNodesById = simNodesById
  const nextNodesById = new Map()
  const nextNeighborsById = new Map()

  const nextNodes = rawNodes.map((rawNode, idx) => {
    const prev = previousNodesById.get(rawNode.id)
    const angle = idx * GOLDEN_ANGLE
    const spread = 18 * Math.sqrt(idx + 1)
    const node = {
      id: rawNode.id,
      path: rawNode.path,
      label: rawNode.label,
      type: rawNode.type,
      degree: rawNode.degree,
      radius: nodeRadiusForDegree(rawNode.degree),
      x: prev && typeof prev.x === 'number' ? prev.x : Math.cos(angle) * spread,
      y: prev && typeof prev.y === 'number' ? prev.y : Math.sin(angle) * spread,
      vx: prev && typeof prev.vx === 'number' ? prev.vx : 0,
      vy: prev && typeof prev.vy === 'number' ? prev.vy : 0,
      fx: prev ? prev.fx : null,
      fy: prev ? prev.fy : null,
      _isNew: !prev,
    }
    nextNodesById.set(node.id, node)
    nextNeighborsById.set(node.id, new Set())
    return node
  })

  const nextLinks = []
  for (const rawEdge of rawEdges) {
    if (!rawEdge || rawEdge.source === rawEdge.target) continue
    const sourceNode = nextNodesById.get(rawEdge.source)
    const targetNode = nextNodesById.get(rawEdge.target)
    if (!sourceNode || !targetNode) continue
    nextLinks.push({ source: sourceNode, target: targetNode })
    nextNeighborsById.get(sourceNode.id).add(targetNode.id)
    nextNeighborsById.get(targetNode.id).add(sourceNode.id)
  }

  // Place newly added notes near an existing connected neighbor to minimize layout disruption.
  if (hadExistingNodes) {
    for (const node of nextNodes) {
      if (!node._isNew) continue
      const neighbors = nextNeighborsById.get(node.id)
      if (!neighbors || neighbors.size === 0) continue
      for (const neighborId of neighbors) {
        const neighbor = nextNodesById.get(neighborId)
        if (neighbor && !neighbor._isNew) {
          node.x = neighbor.x + 28
          node.y = neighbor.y + 18
          break
        }
      }
    }
  }

  simNodes = nextNodes
  simLinks = nextLinks
  simNodesById = nextNodesById
  neighborsById = nextNeighborsById
  currentStructureKey = nextStructureKey

  if (viewport.hoveredNodeId && !simNodesById.has(viewport.hoveredNodeId)) {
    updateHoveredNode(null)
  }

  if (!simulation) {
    simulation = forceSimulation(simNodes)
      .force(
        'link',
        forceLink(simLinks)
          .id((d) => d.id)
          .distance(60)
          .strength(0.55)
      )
      .force('charge', forceManyBody().strength(-165).distanceMax(360))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.055))
      .force('y', forceY(0).strength(0.055))
      .alphaDecay(0.028)
      .velocityDecay(0.42)
      .on('tick', scheduleDraw)
      .on('end', scheduleDraw)
  } else {
    simulation.nodes(simNodes)
    const linkForce = simulation.force('link')
    if (linkForce) linkForce.links(simLinks)
    simulation.alpha(hadExistingNodes ? 0.35 : 0.9).restart()
  }

  scheduleDraw()
}

const updateCanvasSize = () => {
  const container = containerRef.value
  const canvas = canvasRef.value
  if (!container || !canvas) return
  const rect = container.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) return

  const nextDpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1
  const nextWidth = rect.width
  const nextHeight = rect.height
  if (nextWidth === viewWidth && nextHeight === viewHeight && nextDpr === dpr) return

  viewWidth = nextWidth
  viewHeight = nextHeight
  dpr = nextDpr
  canvas.width = Math.max(1, Math.round(viewWidth * dpr))
  canvas.height = Math.max(1, Math.round(viewHeight * dpr))
  scheduleDraw()
}

const getCanvasRelativeCoords = (event) => {
  const canvas = canvasRef.value
  if (!canvas) return { sx: 0, sy: 0 }
  const rect = canvas.getBoundingClientRect()
  if (rect.width > 0 && viewWidth !== rect.width) {
    updateCanvasSize()
  }
  return {
    sx: event.clientX - rect.left,
    sy: event.clientY - rect.top,
  }
}

const handleWheel = (event) => {
  if (!hasNodes.value) return
  const { sx, sy } = getCanvasRelativeCoords(event)
  const rawDelta = clamp(event.deltaY, -240, 240)
  const factor = Math.exp(-rawDelta * 0.0018)
  const nextScale = clamp(viewport.scale * factor, MIN_SCALE, MAX_SCALE)
  if (nextScale === viewport.scale) return

  const world = screenToWorld(sx, sy)
  viewport.scale = nextScale
  viewport.offsetX = sx - viewWidth / 2 - world.x * nextScale
  viewport.offsetY = sy - viewHeight / 2 - world.y * nextScale
  scheduleDraw()
}

const handlePointerDown = (event) => {
  if (event.button !== 0 || !hasNodes.value) return
  const canvas = canvasRef.value
  const { sx, sy } = getCanvasRelativeCoords(event)
  const hit = findNodeAtScreen(sx, sy)

  pointerDownPos = { x: sx, y: sy }
  didDrag = false
  activePointerId = event.pointerId

  if (canvas && typeof canvas.setPointerCapture === 'function') {
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {}
  }

  if (hit) {
    viewport.draggingNodeId = hit.id
    isGrabbing.value = true
    updateHoveredNode(hit)
    const { x: wx, y: wy } = screenToWorld(sx, sy)
    hit.fx = wx
    hit.fy = wy
    scheduleDraw()
  } else {
    viewport.panning = true
    isGrabbing.value = true
    panOrigin = { x: sx, y: sy, offsetX: viewport.offsetX, offsetY: viewport.offsetY }
  }
}

const handlePointerMove = (event) => {
  if (!hasNodes.value) return
  const { sx, sy } = getCanvasRelativeCoords(event)

  if (viewport.draggingNodeId) {
    const draggedNode = simNodesById.get(viewport.draggingNodeId)
    if (!draggedNode) return
    if (
      !didDrag &&
      pointerDownPos &&
      Math.hypot(sx - pointerDownPos.x, sy - pointerDownPos.y) >= DRAG_THRESHOLD_PX
    ) {
      didDrag = true
      simulation?.alphaTarget(0.28).restart()
    }
    if (didDrag) {
      const { x: wx, y: wy } = screenToWorld(sx, sy)
      draggedNode.fx = wx
      draggedNode.fy = wy
      scheduleDraw()
    }
    return
  }

  if (viewport.panning && panOrigin) {
    const dx = sx - panOrigin.x
    const dy = sy - panOrigin.y
    if (!didDrag && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
      didDrag = true
    }
    if (didDrag) {
      viewport.offsetX = panOrigin.offsetX + dx
      viewport.offsetY = panOrigin.offsetY + dy
      scheduleDraw()
    }
    return
  }

  const hit = findNodeAtScreen(sx, sy)
  if (updateHoveredNode(hit)) {
    scheduleDraw()
  }
}

const finishPointerInteraction = (event, allowClick) => {
  const canvas = canvasRef.value
  if (
    canvas &&
    activePointerId !== null &&
    typeof canvas.hasPointerCapture === 'function' &&
    canvas.hasPointerCapture(activePointerId)
  ) {
    try {
      canvas.releasePointerCapture(activePointerId)
    } catch {}
  }
  activePointerId = null

  if (viewport.draggingNodeId) {
    const draggedNode = simNodesById.get(viewport.draggingNodeId)
    viewport.draggingNodeId = null
    if (draggedNode) {
      draggedNode.fx = null
      draggedNode.fy = null
      if (didDrag) {
        simulation?.alphaTarget(0)
      } else if (allowClick) {
        emit('open-note', draggedNode.path)
      }
    }
    scheduleDraw()
  } else if (viewport.panning) {
    viewport.panning = false
    panOrigin = null
  }

  isGrabbing.value = false
  pointerDownPos = null
  didDrag = false
}

const handlePointerUp = (event) => finishPointerInteraction(event, true)
const handlePointerCancel = (event) => finishPointerInteraction(event, false)

const handlePointerLeave = () => {
  if (viewport.draggingNodeId || viewport.panning) return
  if (updateHoveredNode(null)) {
    scheduleDraw()
  }
}

const handleCanvasKeydown = (event) => {
  const step = event.shiftKey ? 80 : 36
  if (event.key === 'ArrowLeft') {
    event.preventDefault()
    viewport.offsetX += step
    scheduleDraw()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    viewport.offsetX -= step
    scheduleDraw()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    viewport.offsetY += step
    scheduleDraw()
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    viewport.offsetY -= step
    scheduleDraw()
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    viewport.scale = clamp(viewport.scale * 1.18, MIN_SCALE, MAX_SCALE)
    scheduleDraw()
  } else if (event.key === '-') {
    event.preventDefault()
    viewport.scale = clamp(viewport.scale / 1.18, MIN_SCALE, MAX_SCALE)
    scheduleDraw()
  } else if (event.key === '0') {
    event.preventDefault()
    viewport.scale = 1
    viewport.offsetX = 0
    viewport.offsetY = 0
    scheduleDraw()
  }
}

const focusNodeOnCanvas = (nodePath) => {
  const node = simNodesById.get(`note:${nodePath}`)
  if (!node) return
  updateHoveredNode(node)
  scheduleDraw()
}

const moveLocatorSelection = (delta) => {
  const list = locatorMatches.value
  if (list.length === 0) return
  locatorOpen.value = true
  const nextIdx = clamp(locatorActiveIndex.value + delta, 0, list.length - 1)
  locatorActiveIndex.value = nextIdx
  focusNodeOnCanvas(list[nextIdx].path)
}

const openHighlightedMatch = () => {
  const list = locatorMatches.value
  if (list.length === 0) return
  const target = list[clamp(locatorActiveIndex.value, 0, list.length - 1)]
  if (!target) return
  locatorOpen.value = false
  emit('open-note', target.path)
}

const selectLocatorNode = (node) => {
  locatorOpen.value = false
  emit('open-note', node.path)
}

const closeLocator = () => {
  locatorOpen.value = false
  if (!viewport.draggingNodeId && updateHoveredNode(null)) {
    scheduleDraw()
  }
}

const handleDocumentPointerDown = (event) => {
  if (!locatorOpen.value) return
  if (locatorRef.value && !locatorRef.value.contains(event.target)) {
    closeLocator()
  }
}

watch(locatorQuery, () => {
  locatorActiveIndex.value = 0
  if (locatorMatches.value.length > 0 && locatorOpen.value) {
    focusNodeOnCanvas(locatorMatches.value[0].path)
  }
})

watch(
  () => [props.graph, props.vaultDirectory],
  async ([nextGraph]) => {
    syncSimulationWithModel(nextGraph)
    await nextTick()
    updateCanvasSize()
  },
  { immediate: false }
)

watch(viewStatus, async (status) => {
  if (status === 'ready') {
    await nextTick()
    updateCanvasSize()
    scheduleDraw()
  }
})

watch(
  () => props.activeNotePath,
  () => {
    scheduleDraw()
  }
)

onMounted(() => {
  isUnmounted = false
  syncSimulationWithModel(props.graph)
  updateCanvasSize()

  if (typeof ResizeObserver !== 'undefined' && containerRef.value) {
    resizeObserver = new ResizeObserver(() => {
      updateCanvasSize()
    })
    resizeObserver.observe(containerRef.value)
  }
  window.addEventListener('resize', updateCanvasSize)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
})

onUnmounted(() => {
  isUnmounted = true
  cancelPendingDraw()
  stopSimulation()
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  window.removeEventListener('resize', updateCanvasSize)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  simNodes = []
  simLinks = []
  simNodesById.clear()
  neighborsById.clear()
})

defineExpose({
  updateCanvasSize,
})
</script>

<template>
  <section
    ref="containerRef"
    class="graph-view"
    data-testid="graph-view"
    aria-label="Global graph view"
  >
    <div
      v-if="viewStatus === 'loading'"
      class="graph-state"
      data-testid="graph-loading-state"
      role="status"
    >
      <p>Loading graph...</p>
    </div>

    <div
      v-else-if="viewStatus === 'error'"
      class="graph-state"
      data-testid="graph-error-state"
      role="alert"
    >
      <p>Unable to load graph data.</p>
      <button
        type="button"
        class="btn-secondary btn-compact"
        data-testid="graph-retry-button"
        @click="emit('retry')"
      >
        Try again
      </button>
    </div>

    <div
      v-else-if="viewStatus === 'incomplete-empty'"
      class="graph-state"
      data-testid="graph-incomplete-state"
      role="status"
    >
      <p>Graph data is incomplete.</p>
    </div>

    <div
      v-else-if="viewStatus === 'empty'"
      class="graph-state"
      data-testid="graph-empty-state"
    >
      <p>No notes in this vault.</p>
    </div>

    <template v-else>
      <canvas
        ref="canvasRef"
        class="graph-canvas"
        :class="{
          'graph-canvas--hover': Boolean(hoveredNodeInfo),
          'graph-canvas--grabbing': isGrabbing,
        }"
        data-testid="graph-canvas"
        tabindex="0"
        role="img"
        :aria-label="canvasAriaLabel"
        :title="hoveredNodeInfo ? hoveredNodeInfo.path : undefined"
        @wheel.prevent="handleWheel"
        @pointerdown="handlePointerDown"
        @pointermove="handlePointerMove"
        @pointerup="handlePointerUp"
        @pointercancel="handlePointerCancel"
        @pointerleave="handlePointerLeave"
        @keydown="handleCanvasKeydown"
      />

      <!-- Accessible keyboard note locator without overlaying dozens of DOM buttons -->
      <div ref="locatorRef" class="graph-locator">
        <input
          v-model="locatorQuery"
          type="search"
          class="graph-locator-input"
          data-testid="graph-node-locator"
          aria-label="Find note in graph"
          :aria-expanded="locatorOpen ? 'true' : 'false'"
          aria-controls="graph-locator-results"
          placeholder="Find note…"
          @focus="locatorOpen = true"
          @input="locatorOpen = true"
          @keydown.down.prevent="moveLocatorSelection(1)"
          @keydown.up.prevent="moveLocatorSelection(-1)"
          @keydown.enter.prevent="openHighlightedMatch"
          @keydown.esc.prevent="closeLocator"
        />
        <ul
          v-if="locatorOpen && locatorMatches.length > 0"
          id="graph-locator-results"
          class="graph-locator-results"
          role="listbox"
          aria-label="Notes in graph"
          data-testid="graph-locator-results"
        >
          <li
            v-for="(node, idx) in locatorMatches"
            :key="node.id"
            role="option"
            :aria-selected="idx === locatorActiveIndex ? 'true' : 'false'"
          >
            <button
              type="button"
              class="graph-locator-item"
              :class="{ 'graph-locator-item--active': idx === locatorActiveIndex }"
              data-testid="graph-locator-item"
              :data-note-path="node.path"
              @mouseenter="locatorActiveIndex = idx; focusNodeOnCanvas(node.path)"
              @focus="locatorActiveIndex = idx; focusNodeOnCanvas(node.path)"
              @click="selectLocatorNode(node)"
            >
              <span class="graph-locator-label">{{ node.label }}</span>
              <span v-if="node.path !== `${node.label}.md`" class="graph-locator-path">
                {{ node.path }}
              </span>
            </button>
          </li>
        </ul>
      </div>

      <div
        v-if="isIncomplete"
        class="graph-incomplete-notice"
        data-testid="graph-incomplete-notice"
        role="status"
      >
        Graph data is incomplete.
      </div>

      <div
        v-if="hoveredNodeInfo"
        class="graph-hover-caption"
        data-testid="graph-hover-caption"
      >
        {{ hoveredNodeInfo.path }}
      </div>
    </template>
  </section>
</template>

<style scoped>
.graph-view {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--ayame-background, #111218);
  overflow: hidden;
  user-select: none;
}

.graph-canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: grab;
  touch-action: none;
}

.graph-canvas:focus-visible {
  outline: 2px solid var(--ayame-primary, #a99aca);
  outline-offset: -2px;
}

.graph-canvas--hover {
  cursor: pointer;
}

.graph-canvas--grabbing {
  cursor: grabbing;
}

.graph-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.75rem;
  width: 100%;
  height: 100%;
  padding: 2rem;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.9rem;
  text-align: center;
}

.graph-state p {
  margin: 0;
}

.graph-locator {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  z-index: 5;
  width: min(240px, calc(100% - 1.5rem));
}

.graph-locator-input {
  width: 100%;
  padding: 0.35rem 0.55rem;
  background: rgba(27, 28, 37, 0.85);
  color: var(--ayame-text, #eeeaf3);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 5px;
  font-size: 0.8rem;
  backdrop-filter: blur(4px);
}

.graph-locator-input::placeholder {
  color: var(--ayame-text-muted, #aaa6b8);
}

.graph-locator-input:focus-visible {
  border-color: var(--ayame-primary, #a99aca);
  outline: 2px solid rgba(169, 154, 202, 0.28);
  outline-offset: 1px;
}

.graph-locator-results {
  list-style: none;
  margin: 0.3rem 0 0;
  padding: 0.25rem;
  max-height: 240px;
  overflow-y: auto;
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
}

.graph-locator-item {
  display: flex;
  flex-direction: column;
  width: 100%;
  padding: 0.35rem 0.5rem;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--ayame-text, #eeeaf3);
  text-align: left;
  cursor: pointer;
}

.graph-locator-item:hover,
.graph-locator-item:focus-visible,
.graph-locator-item--active {
  background: var(--ayame-hover, #242530);
  outline: none;
}

.graph-locator-label {
  font-size: 0.8rem;
  font-weight: 500;
}

.graph-locator-path {
  font-size: 0.72rem;
  color: var(--ayame-text-muted, #aaa6b8);
}

.graph-incomplete-notice {
  position: absolute;
  top: 0.75rem;
  right: 0.75rem;
  z-index: 4;
  padding: 0.3rem 0.6rem;
  background: rgba(27, 28, 37, 0.88);
  border: 1px solid var(--ayame-primary, #a99aca);
  border-radius: 4px;
  color: var(--ayame-lavender, #d4cbe4);
  font-size: 0.78rem;
  pointer-events: none;
}

.graph-hover-caption {
  position: absolute;
  left: 0.75rem;
  bottom: 0.75rem;
  z-index: 4;
  padding: 0.2rem 0.5rem;
  background: rgba(17, 18, 24, 0.82);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  color: var(--ayame-text-muted, #aaa6b8);
  font-size: 0.75rem;
  pointer-events: none;
}

.btn-secondary {
  background: transparent;
  color: var(--ayame-lavender, #d4cbe4);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 4px;
  font-weight: 600;
  cursor: pointer;
}

.btn-secondary:hover {
  background: var(--ayame-hover, #242530);
  color: var(--ayame-text, #eeeaf3);
}

.btn-compact {
  padding: 0.25rem 0.55rem;
  font-size: 0.78rem;
}
</style>
