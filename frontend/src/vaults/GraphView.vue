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
import GraphControls from './GraphControls.vue'
import { createDefaultGraphFilters } from './graphSelection.js'
import {
  GRAPH_DISPLAY_LIMITS,
  createDefaultGraphSettings,
  normalizeForces,
  resolveLabelOpacity,
  computeArrowGeometry,
  applySimulationForces,
  stepExponentialZoom,
  anchorViewportOffset,
} from './graphSettings.js'

let graphLocatorInstanceSeq = 0

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
  filters: {
    type: Object,
    default: () => createDefaultGraphFilters(),
  },
  groups: {
    type: Array,
    default: () => [],
  },
  groupColors: {
    type: Object,
    default: () => ({}),
  },
  groupErrors: {
    type: Object,
    default: () => ({}),
  },
  display: {
    type: Object,
    default: () => createDefaultGraphSettings().global.display,
  },
  forces: {
    type: Object,
    default: () => createDefaultGraphSettings().global.forces,
  },
  storageWarning: {
    type: String,
    default: '',
  },
})

const emit = defineEmits([
  'open-note',
  'retry',
  'update:filters',
  'update:groups',
  'update:display',
  'update:forces',
  'restore-defaults',
  'reset-groups',
])

const MIN_SCALE = 0.15
const MAX_SCALE = 6
const ZOOM_TAU_MS = 100
const DRAG_THRESHOLD_PX = 4
const LOCATOR_LIMIT = 12
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5))
const locatorListId = `graph-locator-results-${++graphLocatorInstanceSeq}`

const containerRef = ref(null)
const stageRef = ref(null)
const canvasRef = ref(null)
const locatorRef = ref(null)
const settingsToggleRef = ref(null)
const settingsPopoverRef = ref(null)

const locatorQuery = ref('')
const locatorOpen = ref(false)
const locatorActiveIndex = ref(0)
const filtersOpen = ref(false)
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

const cameraTarget = {
  animating: false,
  scale: 1,
  anchorSx: 0,
  anchorSy: 0,
  anchorWx: 0,
  anchorWy: 0,
  lastTimestamp: null,
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
let appliedForcesKey = ''

const computeForcesKey = (rawForces) => {
  const f = normalizeForces(rawForces)
  return `${f.centerForce}|${f.repelForce}|${f.linkForce}|${f.linkDistance}`
}

let viewWidth = 0
let viewHeight = 0
let dpr = 1
let rafId = null
let resizeObserver = null

let pointerDownPos = null
let panOrigin = null
let dragOffset = null
let didDrag = false
let activePointerId = null

const prefersReducedMotion = () =>
  typeof window !== 'undefined' &&
  typeof window.matchMedia === 'function' &&
  window.matchMedia('(prefers-reduced-motion: reduce)').matches

const cancelCameraAnimation = () => {
  cameraTarget.animating = false
  cameraTarget.lastTimestamp = null
  cameraTarget.scale = viewport.scale
}

const hasNodes = computed(() => Array.isArray(props.graph?.nodes) && props.graph.nodes.length > 0)
const hasFailures = computed(
  () => Array.isArray(props.graph?.failures) && props.graph.failures.length > 0
)
const isIncomplete = computed(() => Boolean(props.graph && !props.graph.complete && hasFailures.value))
const hasRefreshError = computed(() => Boolean(props.error && hasNodes.value))
const queryError = computed(() =>
  props.graph?.queryValid === false ? props.graph.queryError || 'Invalid search filter.' : ''
)
const hasActiveFilters = computed(
  () =>
    Boolean(props.filters?.searchQuery?.trim()) ||
    Boolean(props.filters?.showTags) ||
    props.filters?.existingFilesOnly === false ||
    props.filters?.showOrphans === false
)

const handleRetry = () => {
  if (props.loading) return
  emit('retry')
}

const clearFilters = () => {
  emit('update:filters', createDefaultGraphFilters())
}

const viewStatus = computed(() => {
  if (props.loading && !hasNodes.value) return 'loading'
  if (props.error && !hasNodes.value) return 'error'
  if (!hasNodes.value && props.graph?.filteredOut) return 'filtered-empty'
  if (!hasNodes.value && hasFailures.value) return 'incomplete-empty'
  if (!hasNodes.value) return 'empty'
  return 'ready'
})

const showOverlayControls = computed(
  () => viewStatus.value === 'ready' || viewStatus.value === 'filtered-empty'
)

const canvasAriaLabel = computed(() => {
  const nodesCount = props.graph?.nodes?.length || 0
  const edgesCount = props.graph?.edges?.length || 0
  return `Global graph with ${nodesCount} notes and ${edgesCount} connections`
})

const locatorMatches = computed(() => {
  const nodes = (Array.isArray(props.graph?.nodes) ? props.graph.nodes : []).filter(
    (n) => (n?.type === 'note' || !n?.type) && typeof n?.path === 'string' && n.path
  )
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
  const nodeIds = (graph?.nodes || []).map((n) => `${n.id}:${n.type || 'note'}`).join('\n')
  const edgeKeys = (graph?.edges || [])
    .map((e) => `${e.source}->${e.target}:${e.type || 'note'}`)
    .join('\n')
  return `${nodeIds}\0${edgeKeys}`
}

const nodeRadiusForDegree = (degree) => 3.8 + Math.min(8, Math.sqrt(Math.max(0, degree)) * 1.4)

const clampDisplayMetric = (raw, { min, max, default: fallback }) =>
  typeof raw === 'number' && Number.isFinite(raw) ? Math.max(min, Math.min(max, raw)) : fallback

const screenToWorld = (sx, sy) => ({
  x: (sx - viewWidth / 2 - viewport.offsetX) / viewport.scale,
  y: (sy - viewHeight / 2 - viewport.offsetY) / viewport.scale,
})

const findNodeAtScreen = (sx, sy) => {
  const { x: wx, y: wy } = screenToWorld(sx, sy)
  const scalePow = Math.pow(viewport.scale, 0.7)
  const nodeSizeMult = clampDisplayMetric(props.display?.nodeSize, GRAPH_DISPLAY_LIMITS.nodeSize)
  for (let i = simNodes.length - 1; i >= 0; i--) {
    const node = simNodes[i]
    if (typeof node.x !== 'number' || typeof node.y !== 'number') continue
    const screenRadius = Math.max(2, node.radius * nodeSizeMult * scalePow)
    const hitRadiusWorld = Math.max(screenRadius + 5, 8) / viewport.scale
    const dx = wx - node.x
    const dy = wy - node.y
    if (dx * dx + dy * dy <= hitRadiusWorld * hitRadiusWorld) {
      return node
    }
  }
  return null
}

const formatHoverCaption = (node) => {
  if (!node) return ''
  if (node.type === 'tag') return node.label
  if (node.type === 'unresolved') {
    const origins =
      Array.isArray(node.sourcePaths) && node.sourcePaths.length > 0
        ? ` — ${node.sourcePaths.join(', ')}`
        : ''
    const targetDisplay = node.path || node.label
    return `${targetDisplay} (unresolved${origins})`
  }
  return node.path || node.label
}

const updateHoveredNode = (node) => {
  const nextId = node ? node.id : null
  if (viewport.hoveredNodeId === nextId) return false
  viewport.hoveredNodeId = nextId
  hoveredNodeInfo.value = node
    ? {
        id: node.id,
        path: node.path,
        label: node.label,
        type: node.type || 'note',
        degree: node.degree,
        caption: formatHoverCaption(node),
      }
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
  const nodeSizeMult = clampDisplayMetric(props.display?.nodeSize, GRAPH_DISPLAY_LIMITS.nodeSize)
  const linkThicknessMult = clampDisplayMetric(
    props.display?.linkThickness,
    GRAPH_DISPLAY_LIMITS.linkThickness
  )
  const showArrows = Boolean(props.display?.arrows)

  for (let i = 0; i < simNodes.length; i++) {
    const n = simNodes[i]
    n._sx = (n.x || 0) * scale + cx
    n._sy = (n.y || 0) * scale + cy
    n._sr = Math.max(2, n.radius * nodeSizeMult * scalePow)
  }

  const focusedId = viewport.draggingNodeId || viewport.hoveredNodeId
  const focusedNeighbors = focusedId ? neighborsById.get(focusedId) : null
  const canDash = typeof ctx.setLineDash === 'function'

  const noteEdgeKeys = showArrows ? new Set() : null
  if (noteEdgeKeys) {
    for (let i = 0; i < simLinks.length; i++) {
      const link = simLinks[i]
      const s = link.source
      const t = link.target
      if (!s || !t || s === t) continue
      if (
        (!link.type || link.type === 'note') &&
        (!s.type || s.type === 'note') &&
        (!t.type || t.type === 'note')
      ) {
        noteEdgeKeys.add(`${s.id}\0${t.id}`)
      }
    }
  }

  // Draw edges
  for (let i = 0; i < simLinks.length; i++) {
    const link = simLinks[i]
    const s = link.source
    const t = link.target
    if (!s || !t || s === t) continue

    const isHighlighted = focusedId && (s.id === focusedId || t.id === focusedId)
    const linkType = link.type || 'note'
    if (focusedId && !isHighlighted) {
      ctx.strokeStyle = 'rgba(170, 166, 184, 0.08)'
      ctx.lineWidth = 0.8 * linkThicknessMult
    } else if (linkType === 'tag') {
      ctx.strokeStyle = isHighlighted ? 'rgba(110, 196, 159, 0.78)' : 'rgba(110, 196, 159, 0.28)'
      ctx.lineWidth = (isHighlighted ? 1.3 : 0.9) * linkThicknessMult
    } else if (linkType === 'unresolved') {
      ctx.strokeStyle = isHighlighted ? 'rgba(170, 166, 184, 0.55)' : 'rgba(170, 166, 184, 0.18)'
      ctx.lineWidth = (isHighlighted ? 1.1 : 0.85) * linkThicknessMult
    } else if (isHighlighted) {
      ctx.strokeStyle = 'rgba(169, 154, 202, 0.88)'
      ctx.lineWidth = 1.4 * linkThicknessMult
    } else {
      ctx.strokeStyle = 'rgba(170, 166, 184, 0.25)'
      ctx.lineWidth = 1 * linkThicknessMult
    }

    if (canDash) {
      ctx.setLineDash(linkType === 'unresolved' ? [4, 3] : [])
    }

    const isNoteEdge =
      linkType === 'note' && (!s.type || s.type === 'note') && (!t.type || t.type === 'note')
    const arrow =
      showArrows && isNoteEdge
        ? computeArrowGeometry({
            sx: s._sx,
            sy: s._sy,
            tx: t._sx,
            ty: t._sy,
            sourceRadius: s._sr,
            targetRadius: t._sr,
            bidirectional: noteEdgeKeys.has(`${t.id}\0${s.id}`),
            arrowSize: Math.max(4.5, Math.min(8.5, 5.5 * Math.sqrt(linkThicknessMult))),
          })
        : null

    ctx.beginPath()
    if (arrow) {
      ctx.moveTo(arrow.x1, arrow.y1)
      ctx.lineTo(arrow.tipX, arrow.tipY)
      ctx.stroke()

      ctx.fillStyle = ctx.strokeStyle
      ctx.beginPath()
      ctx.moveTo(arrow.tipX, arrow.tipY)
      ctx.lineTo(arrow.leftX, arrow.leftY)
      ctx.lineTo(arrow.rightX, arrow.rightY)
      ctx.closePath?.()
      ctx.fill()
    } else {
      ctx.moveTo(s._sx, s._sy)
      ctx.lineTo(t._sx, t._sy)
      ctx.stroke()
    }
  }
  if (canDash) ctx.setLineDash([])

  // Draw nodes
  for (let i = 0; i < simNodes.length; i++) {
    const n = simNodes[i]
    const nodeType = n.type || 'note'
    const isFocused = n.id === focusedId
    const isNeighbor = focusedNeighbors ? focusedNeighbors.has(n.id) : false
    const isActiveNote =
      nodeType === 'note' && Boolean(props.activeNotePath && n.path === props.activeNotePath)
    const groupColor = nodeType === 'note' ? props.groupColors?.[n.id] || null : null

    if (focusedId && !isFocused && !isNeighbor) {
      ctx.fillStyle = 'rgba(170, 166, 184, 0.2)'
    } else if (nodeType === 'tag') {
      ctx.fillStyle = isFocused ? '#9ae0c1' : '#6ec49f'
    } else if (nodeType === 'unresolved') {
      ctx.fillStyle = isFocused ? 'rgba(182, 178, 196, 0.72)' : 'rgba(143, 139, 163, 0.36)'
    } else if (groupColor) {
      ctx.fillStyle = groupColor
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

    if (nodeType === 'unresolved') {
      ctx.strokeStyle = isFocused ? 'rgba(212, 203, 228, 0.75)' : 'rgba(170, 166, 184, 0.5)'
      ctx.lineWidth = 1
      if (canDash) ctx.setLineDash([2.5, 2])
      ctx.stroke()
      if (canDash) ctx.setLineDash([])
    } else if (isFocused || isActiveNote) {
      ctx.strokeStyle = isFocused ? 'rgba(238, 234, 243, 0.88)' : 'rgba(169, 154, 202, 0.65)'
      ctx.lineWidth = 1.25
      ctx.stroke()
    }
  }

  // Draw labels only when zoom justifies them or when node is focused/neighbor
  const baseLabelAlpha = resolveLabelOpacity(scale, props.display?.textFadeThreshold)
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

      const showDisambiguator =
        isFocused &&
        typeof n.path === 'string' &&
        (duplicateLabelCounts.get(n.label) || 0) > 1
      const text = showDisambiguator
        ? n.type === 'unresolved'
          ? n.path
          : n.path.replace(/\.(md|markdown)$/i, '')
        : n.label

      ctx.fillStyle = isFocused
        ? `rgba(238, 234, 243, ${alpha})`
        : `rgba(212, 203, 228, ${alpha})`
      ctx.fillText(text, n._sx, n._sy + n._sr + 5)
    }
  }
}

const renderFrame = (timestamp) => {
  rafId = null
  if (isUnmounted) return

  if (cameraTarget.animating) {
    const hasPrev = cameraTarget.lastTimestamp !== null && typeof timestamp === 'number'
    const rawDt = hasPrev ? timestamp - cameraTarget.lastTimestamp : 16
    const dtMs = Number.isFinite(rawDt) && rawDt > 0 ? Math.min(rawDt, 100) : 16
    cameraTarget.lastTimestamp = typeof timestamp === 'number' ? timestamp : null

    const step = stepExponentialZoom({
      currentScale: viewport.scale,
      targetScale: cameraTarget.scale,
      dtMs,
      tauMs: ZOOM_TAU_MS,
      minScale: MIN_SCALE,
      maxScale: MAX_SCALE,
    })
    viewport.scale = step.scale
    const anchored = anchorViewportOffset({
      scale: viewport.scale,
      anchorScreenX: cameraTarget.anchorSx,
      anchorScreenY: cameraTarget.anchorSy,
      anchorWorldX: cameraTarget.anchorWx,
      anchorWorldY: cameraTarget.anchorWy,
      viewWidth,
      viewHeight,
    })
    viewport.offsetX = anchored.offsetX
    viewport.offsetY = anchored.offsetY

    if (step.done) {
      cameraTarget.animating = false
      cameraTarget.lastTimestamp = null
    }
  }

  draw()

  if (cameraTarget.animating && !isUnmounted) {
    scheduleDraw()
  }
}

const scheduleDraw = () => {
  if (isUnmounted || rafId !== null) return
  if (typeof requestAnimationFrame !== 'function') return
  rafId = requestAnimationFrame(renderFrame)
}

const stopSimulation = () => {
  appliedForcesKey = ''
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
    cancelActiveInteraction()
    cancelCameraAnimation()
    cancelPendingDraw()
    stopSimulation()
    simNodes = []
    simLinks = []
    simNodesById = new Map()
    neighborsById = new Map()
    currentStructureKey = ''
    viewport.scale = 1
    viewport.offsetX = 0
    viewport.offsetY = 0
    cameraTarget.scale = 1
    updateHoveredNode(null)
  }

  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : []

  if (rawNodes.length === 0) {
    cancelActiveInteraction()
    cancelCameraAnimation()
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
        existing.sourcePaths = Array.isArray(rawNode.sourcePaths) ? [...rawNode.sourcePaths] : []
        const nodeType = rawNode.type || 'note'
        existing.radius = nodeRadiusForDegree(rawNode.degree) * (nodeType === 'note' ? 1 : 0.85)
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
    const nodeType = rawNode.type || 'note'
    const node = {
      id: rawNode.id,
      path: rawNode.path ?? null,
      label: rawNode.label,
      type: nodeType,
      tag: rawNode.tag ?? null,
      sourcePaths: Array.isArray(rawNode.sourcePaths) ? [...rawNode.sourcePaths] : [],
      degree: rawNode.degree,
      radius: nodeRadiusForDegree(rawNode.degree) * (nodeType === 'note' ? 1 : 0.85),
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
    nextLinks.push({ source: sourceNode, target: targetNode, type: rawEdge.type || 'note' })
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

  if (viewport.draggingNodeId && !nextNodesById.has(viewport.draggingNodeId)) {
    cancelActiveInteraction()
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
      .alphaDecay(0.032)
      .alphaMin(0.002)
      .velocityDecay(0.46)
      .on('tick', scheduleDraw)
      .on('end', scheduleDraw)
    applySimulationForces(simulation, props.forces, { restart: false })
  } else {
    simulation.nodes(simNodes)
    const linkForce = simulation.force('link')
    if (linkForce) linkForce.links(simLinks)
    applySimulationForces(simulation, props.forces, { restart: false })
    simulation.alpha(hadExistingNodes ? 0.25 : 0.85).restart()
  }
  appliedForcesKey = computeForcesKey(props.forces)

  scheduleDraw()
}

const updateCanvasSize = () => {
  const container = stageRef.value || containerRef.value
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

const normalizePointerId = (event) => (event?.pointerId !== undefined && event?.pointerId !== null ? event.pointerId : 'mouse')

const applyImmediateScale = (nextScale, sx, sy, wx, wy) => {
  cancelCameraAnimation()
  viewport.scale = clamp(nextScale, MIN_SCALE, MAX_SCALE)
  cameraTarget.scale = viewport.scale
  const anchored = anchorViewportOffset({
    scale: viewport.scale,
    anchorScreenX: sx,
    anchorScreenY: sy,
    anchorWorldX: wx,
    anchorWorldY: wy,
    viewWidth,
    viewHeight,
  })
  viewport.offsetX = anchored.offsetX
  viewport.offsetY = anchored.offsetY
  scheduleDraw()
}

const handleWheel = (event) => {
  if (!hasNodes.value) return
  const { sx, sy } = getCanvasRelativeCoords(event)
  const rawDelta = clamp(event.deltaY, -240, 240)
  const factor = Math.exp(-rawDelta * 0.0018)
  const baseScale = cameraTarget.animating ? cameraTarget.scale : viewport.scale
  const nextTarget = clamp(baseScale * factor, MIN_SCALE, MAX_SCALE)
  const world = screenToWorld(sx, sy)

  if (prefersReducedMotion()) {
    if (nextTarget === viewport.scale) return
    applyImmediateScale(nextTarget, sx, sy, world.x, world.y)
    return
  }

  if (Math.abs(nextTarget - viewport.scale) <= 1e-6 && !cameraTarget.animating) return
  cameraTarget.scale = nextTarget
  cameraTarget.anchorSx = sx
  cameraTarget.anchorSy = sy
  cameraTarget.anchorWx = world.x
  cameraTarget.anchorWy = world.y
  cameraTarget.animating = true
  scheduleDraw()
}

const handlePointerDown = (event) => {
  if (event.button !== 0 || !hasNodes.value) return
  if (activePointerId !== null) return
  const canvas = canvasRef.value
  const { sx, sy } = getCanvasRelativeCoords(event)
  const hit = findNodeAtScreen(sx, sy)

  activePointerId = normalizePointerId(event)
  pointerDownPos = { x: sx, y: sy }
  didDrag = false

  if (canvas && event.pointerId !== undefined && typeof canvas.setPointerCapture === 'function') {
    try {
      canvas.setPointerCapture(event.pointerId)
    } catch {}
  }

  cancelCameraAnimation()

  if (hit) {
    const { x: wx, y: wy } = screenToWorld(sx, sy)
    dragOffset = {
      x: (hit.x || 0) - wx,
      y: (hit.y || 0) - wy,
      originX: hit.x || 0,
      originY: hit.y || 0,
    }
    viewport.draggingNodeId = hit.id
    isGrabbing.value = true
    updateHoveredNode(hit)
    scheduleDraw()
  } else {
    viewport.panning = true
    isGrabbing.value = true
    panOrigin = { x: sx, y: sy, offsetX: viewport.offsetX, offsetY: viewport.offsetY }
  }
}

const handlePointerMove = (event) => {
  if (!hasNodes.value) return
  const pointerId = normalizePointerId(event)
  const { sx, sy } = getCanvasRelativeCoords(event)

  if (viewport.draggingNodeId) {
    if (activePointerId !== null && pointerId !== activePointerId) return
    const draggedNode = simNodesById.get(viewport.draggingNodeId)
    if (!draggedNode) {
      cancelActiveInteraction()
      return
    }
    if (
      !didDrag &&
      pointerDownPos &&
      Math.hypot(sx - pointerDownPos.x, sy - pointerDownPos.y) >= DRAG_THRESHOLD_PX
    ) {
      didDrag = true
      if (dragOffset) {
        dragOffset.x += (draggedNode.x || 0) - dragOffset.originX
        dragOffset.y += (draggedNode.y || 0) - dragOffset.originY
      }
      simulation?.alphaTarget(0.28).restart()
    }
    if (didDrag) {
      const { x: wx, y: wy } = screenToWorld(sx, sy)
      const ox = dragOffset ? dragOffset.x : 0
      const oy = dragOffset ? dragOffset.y : 0
      const nextX = wx + ox
      const nextY = wy + oy
      draggedNode.x = nextX
      draggedNode.y = nextY
      draggedNode.fx = nextX
      draggedNode.fy = nextY
      draggedNode.vx = 0
      draggedNode.vy = 0
      scheduleDraw()
    }
    return
  }

  if (viewport.panning && panOrigin) {
    if (activePointerId !== null && pointerId !== activePointerId) return
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

function finishPointerInteraction(event, allowClick, force = false) {
  if (!force) {
    if (activePointerId === null) return
    const pointerId = normalizePointerId(event)
    if (pointerId !== activePointerId) return
  }

  const canvas = canvasRef.value
  if (
    canvas &&
    activePointerId !== null &&
    activePointerId !== 'mouse' &&
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
    if (didDrag) {
      simulation?.alphaTarget(0)
    }
    if (draggedNode) {
      if (didDrag) {
        if (Number.isFinite(draggedNode.fx)) draggedNode.x = draggedNode.fx
        if (Number.isFinite(draggedNode.fy)) draggedNode.y = draggedNode.fy
      } else if (allowClick && (draggedNode.type === 'note' || !draggedNode.type) && draggedNode.path) {
        emit('open-note', draggedNode.path)
      }
      draggedNode.fx = null
      draggedNode.fy = null
    }
    scheduleDraw()
  } else if (viewport.panning) {
    viewport.panning = false
    panOrigin = null
  }

  isGrabbing.value = false
  pointerDownPos = null
  dragOffset = null
  didDrag = false
}

function cancelActiveInteraction() {
  finishPointerInteraction(null, false, true)
}

const handlePointerUp = (event) => finishPointerInteraction(event, true)
const handlePointerCancel = (event) => finishPointerInteraction(event, false)

const handleWindowBlur = () => {
  cancelActiveInteraction()
  cancelCameraAnimation()
}

const handleVisibilityChange = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
    cancelActiveInteraction()
    cancelCameraAnimation()
  }
}

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
    cancelCameraAnimation()
    viewport.offsetX += step
    scheduleDraw()
  } else if (event.key === 'ArrowRight') {
    event.preventDefault()
    cancelCameraAnimation()
    viewport.offsetX -= step
    scheduleDraw()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    cancelCameraAnimation()
    viewport.offsetY += step
    scheduleDraw()
  } else if (event.key === 'ArrowDown') {
    event.preventDefault()
    cancelCameraAnimation()
    viewport.offsetY -= step
    scheduleDraw()
  } else if (event.key === '+' || event.key === '=') {
    event.preventDefault()
    cancelCameraAnimation()
    viewport.scale = clamp(viewport.scale * 1.18, MIN_SCALE, MAX_SCALE)
    cameraTarget.scale = viewport.scale
    scheduleDraw()
  } else if (event.key === '-') {
    event.preventDefault()
    cancelCameraAnimation()
    viewport.scale = clamp(viewport.scale / 1.18, MIN_SCALE, MAX_SCALE)
    cameraTarget.scale = viewport.scale
    scheduleDraw()
  } else if (event.key === '0') {
    event.preventDefault()
    cancelCameraAnimation()
    viewport.scale = 1
    viewport.offsetX = 0
    viewport.offsetY = 0
    cameraTarget.scale = 1
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
  if (locatorOpen.value && locatorRef.value && !locatorRef.value.contains(event.target)) {
    closeLocator()
  }
  if (
    filtersOpen.value &&
    !settingsPopoverRef.value?.contains(event.target) &&
    !settingsToggleRef.value?.contains(event.target)
  ) {
    filtersOpen.value = false
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
  } else {
    cancelActiveInteraction()
    cancelCameraAnimation()
  }
})

watch(
  () => [props.activeNotePath, props.display, props.groupColors],
  () => {
    scheduleDraw()
  },
  { deep: true }
)

watch(
  () => props.forces,
  (nextForces) => {
    const nextKey = computeForcesKey(nextForces)
    if (!simulation || nextKey === appliedForcesKey) return
    appliedForcesKey = nextKey
    applySimulationForces(simulation, nextForces)
    scheduleDraw()
  },
  { deep: true }
)

onMounted(() => {
  isUnmounted = false
  syncSimulationWithModel(props.graph)
  updateCanvasSize()

  const resizeTarget = stageRef.value || containerRef.value
  if (typeof ResizeObserver !== 'undefined' && resizeTarget) {
    resizeObserver = new ResizeObserver(() => {
      updateCanvasSize()
    })
    resizeObserver.observe(resizeTarget)
  }
  window.addEventListener('resize', updateCanvasSize)
  window.addEventListener('blur', handleWindowBlur)
  document.addEventListener('pointerdown', handleDocumentPointerDown)
  document.addEventListener('visibilitychange', handleVisibilityChange)
})

onUnmounted(() => {
  isUnmounted = true
  cancelActiveInteraction()
  cancelCameraAnimation()
  cancelPendingDraw()
  stopSimulation()
  if (resizeObserver) {
    resizeObserver.disconnect()
    resizeObserver = null
  }
  window.removeEventListener('resize', updateCanvasSize)
  window.removeEventListener('blur', handleWindowBlur)
  document.removeEventListener('pointerdown', handleDocumentPointerDown)
  document.removeEventListener('visibilitychange', handleVisibilityChange)
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
    <div ref="stageRef" class="graph-stage">
      <!-- Floating top overlay HUD: unobtrusive locator on left, gear trigger + corner popover on right -->
      <div v-if="showOverlayControls" class="graph-hud">
        <div
          v-if="viewStatus === 'ready'"
          ref="locatorRef"
          class="graph-locator"
        >
          <input
            v-model="locatorQuery"
            type="search"
            class="graph-locator-input"
            data-testid="graph-node-locator"
            aria-label="Find note in graph"
            :aria-expanded="locatorOpen ? 'true' : 'false'"
            :aria-controls="locatorListId"
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
            :id="locatorListId"
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

        <div class="graph-settings-anchor">
          <button
            ref="settingsToggleRef"
            type="button"
            class="graph-filters-toggle"
            :class="{
              'graph-filters-toggle--open': filtersOpen,
              'graph-filters-toggle--active': hasActiveFilters || groups.length > 0,
            }"
            data-testid="graph-filters-toggle"
            aria-label="Graph settings"
            title="Graph settings"
            :aria-expanded="filtersOpen ? 'true' : 'false'"
            @click="filtersOpen = !filtersOpen"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="1.8"
              stroke-linecap="round"
              stroke-linejoin="round"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span
              v-if="hasActiveFilters || groups.length > 0"
              class="graph-settings-dot"
              aria-hidden="true"
            />
          </button>

          <div
            v-if="filtersOpen"
            ref="settingsPopoverRef"
            class="graph-settings-popover"
          >
            <GraphControls
              :filters="filters"
              :query-error="queryError"
              :groups="groups"
              :group-errors="groupErrors"
              :display="display"
              :forces="forces"
              @update:filters="emit('update:filters', $event)"
              @update:groups="emit('update:groups', $event)"
              @update:display="emit('update:display', $event)"
              @update:forces="emit('update:forces', $event)"
              @restore-defaults="emit('restore-defaults')"
              @reset-groups="emit('reset-groups')"
              @close="filtersOpen = false"
            />
          </div>
        </div>
      </div>

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
          :disabled="loading"
          @click="handleRetry"
        >
          Try again
        </button>
      </div>

      <div
        v-else-if="viewStatus === 'filtered-empty'"
        class="graph-state"
        data-testid="graph-filtered-empty-state"
        role="status"
      >
        <p>No nodes match the current filters.</p>
        <button
          type="button"
          class="btn-secondary btn-compact"
          data-testid="graph-clear-filters-button"
          @click="clearFilters"
        >
          Clear filters
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
            'graph-canvas--hover': Boolean(hoveredNodeInfo && hoveredNodeInfo.type === 'note'),
            'graph-canvas--grabbing': isGrabbing,
          }"
          data-testid="graph-canvas"
          tabindex="0"
          role="img"
          :aria-label="canvasAriaLabel"
          :title="hoveredNodeInfo ? hoveredNodeInfo.caption : undefined"
          @wheel.prevent="handleWheel"
          @pointerdown="handlePointerDown"
          @pointermove="handlePointerMove"
          @pointerup="handlePointerUp"
          @pointercancel="handlePointerCancel"
          @pointerleave="handlePointerLeave"
          @keydown="handleCanvasKeydown"
        />

        <div
          v-if="hasRefreshError || isIncomplete || storageWarning"
          class="graph-notices"
        >
          <div
            v-if="hasRefreshError"
            class="graph-refresh-error-notice"
            data-testid="graph-refresh-error-notice"
            role="alert"
          >
            <span>Could not refresh graph. Showing previous data.</span>
            <button
              type="button"
              class="btn-secondary btn-compact"
              data-testid="graph-retry-button"
              :disabled="loading"
              @click="handleRetry"
            >
              {{ loading ? 'Retrying...' : 'Try again' }}
            </button>
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
            v-if="storageWarning"
            class="graph-incomplete-notice"
            data-testid="graph-storage-warning"
            role="status"
          >
            {{ storageWarning }}
          </div>
        </div>

        <div
          v-if="hoveredNodeInfo"
          class="graph-hover-caption"
          data-testid="graph-hover-caption"
        >
          {{ hoveredNodeInfo.caption }}
        </div>
      </template>
    </div>
  </section>
</template>

<style scoped>
.graph-view {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--ayame-background, #111218);
  overflow: hidden;
  user-select: none;
}

.graph-hud {
  position: absolute;
  top: 0.75rem;
  left: 0.75rem;
  right: 0.75rem;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.5rem;
  z-index: 16;
  pointer-events: none;
}

.graph-settings-anchor {
  position: relative;
  margin-left: auto;
  display: flex;
  align-items: center;
  pointer-events: auto;
  flex-shrink: 0;
}

.graph-filters-toggle {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  background: rgba(27, 28, 37, 0.86);
  backdrop-filter: blur(8px);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 7px;
  color: var(--ayame-text-muted, #aaa6b8);
  cursor: pointer;
  flex-shrink: 0;
}

.graph-filters-toggle:hover,
.graph-filters-toggle--open {
  background: rgba(36, 37, 48, 0.95);
  color: var(--ayame-text, #eeeaf3);
  border-color: rgba(169, 154, 202, 0.45);
}

.graph-filters-toggle--active {
  color: var(--ayame-lavender, #d4cbe4);
  border-color: rgba(169, 154, 202, 0.55);
}

.graph-settings-dot {
  position: absolute;
  top: 5px;
  right: 5px;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--ayame-primary, #a99aca);
}

.graph-settings-popover {
  position: absolute;
  top: calc(100% + 0.4rem);
  right: 0;
  z-index: 25;
}

.graph-stage {
  position: relative;
  flex: 1 1 auto;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
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
  position: relative;
  flex: 0 1 220px;
  min-width: 130px;
  max-width: 240px;
  pointer-events: auto;
  z-index: 18;
}

.graph-locator-input {
  width: 100%;
  height: 32px;
  padding: 0.28rem 0.6rem;
  background: rgba(27, 28, 37, 0.86);
  backdrop-filter: blur(8px);
  color: var(--ayame-text, #eeeaf3);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 7px;
  font-size: 0.78rem;
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
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  min-width: 170px;
  list-style: none;
  margin: 0.25rem 0 0;
  padding: 0.25rem;
  max-height: 240px;
  overflow-y: auto;
  background: var(--ayame-surface, #1b1c25);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 6px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.55);
  z-index: 20;
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

.graph-notices {
  position: absolute;
  bottom: 0.75rem;
  right: 0.75rem;
  z-index: 5;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.4rem;
  max-width: min(380px, calc(100% - 1.5rem));
  pointer-events: none;
}

.graph-refresh-error-notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: 0.5rem;
  padding: 0.35rem 0.6rem;
  background: rgba(27, 28, 37, 0.92);
  border: 1px solid var(--ayame-border, #34323f);
  border-radius: 5px;
  color: var(--ayame-text, #eeeaf3);
  font-size: 0.78rem;
  pointer-events: auto;
  backdrop-filter: blur(4px);
}

.graph-incomplete-notice {
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
