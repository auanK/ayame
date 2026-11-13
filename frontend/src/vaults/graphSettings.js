import {
  createDefaultGraphFilters,
  noteMatchesTerms,
  parseGraphSearchQuery,
} from './graphSelection.js'

export const GRAPH_SETTINGS_VERSION = 1
export const GRAPH_STORAGE_KEY_PREFIX = 'ayame:graph-settings:'

export const GRAPH_DISPLAY_LIMITS = {
  textFadeThreshold: { min: -1, max: 3, step: 0.05, default: 0.48 },
  nodeSize: { min: 0.4, max: 2.5, step: 0.05, default: 1 },
  linkThickness: { min: 0.4, max: 3, step: 0.05, default: 1 },
}

export const GRAPH_FORCE_LIMITS = {
  centerForce: { min: 0, max: 1, step: 0.005, default: 0.055 },
  repelForce: { min: 0, max: 500, step: 5, default: 165 },
  linkForce: { min: 0, max: 1, step: 0.05, default: 0.55 },
  linkDistance: { min: 20, max: 250, step: 5, default: 60 },
}

export const GRAPH_LOCAL_LIMITS = {
  depth: { min: 1, max: 5, step: 1, default: 1, integer: true },
  directions: ['both', 'incoming', 'outgoing'],
}

export const GRAPH_GROUP_PALETTE = [
  '#7c9cff',
  '#e06c75',
  '#98c379',
  '#e5c07b',
  '#c678dd',
  '#56b6c2',
]

export const GRAPH_GROUP_LIMITS = {
  maxGroups: 50,
  maxQueryLength: 240,
  defaultColor: GRAPH_GROUP_PALETTE[0],
}

const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i
const MAX_FILTER_QUERY_LENGTH = 500

const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)

const normalizeNumber = (value, { min, max, default: fallback, integer = false }) => {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  const clamped = Math.max(min, Math.min(max, value))
  return integer ? Math.round(clamped) : clamped
}

const normalizeBoolean = (value, fallback) => (typeof value === 'boolean' ? value : fallback)

const normalizeHexColor = (value, fallback = GRAPH_GROUP_LIMITS.defaultColor) => {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return HEX_COLOR_RE.test(trimmed) ? trimmed.toLowerCase() : fallback
}

const normalizeFilters = (raw) => {
  const defaults = createDefaultGraphFilters()
  const src = isPlainObject(raw) ? raw : {}
  return {
    searchQuery:
      typeof src.searchQuery === 'string'
        ? src.searchQuery.slice(0, MAX_FILTER_QUERY_LENGTH)
        : defaults.searchQuery,
    showTags: normalizeBoolean(src.showTags, defaults.showTags),
    existingFilesOnly: normalizeBoolean(src.existingFilesOnly, defaults.existingFilesOnly),
    showOrphans: normalizeBoolean(src.showOrphans, defaults.showOrphans),
  }
}

const normalizeDisplay = (raw) => {
  const src = isPlainObject(raw) ? raw : {}
  return {
    arrows: normalizeBoolean(src.arrows, false),
    textFadeThreshold: normalizeNumber(src.textFadeThreshold, GRAPH_DISPLAY_LIMITS.textFadeThreshold),
    nodeSize: normalizeNumber(src.nodeSize, GRAPH_DISPLAY_LIMITS.nodeSize),
    linkThickness: normalizeNumber(src.linkThickness, GRAPH_DISPLAY_LIMITS.linkThickness),
  }
}

const normalizeForces = (raw) => {
  const src = isPlainObject(raw) ? raw : {}
  return {
    centerForce: normalizeNumber(src.centerForce, GRAPH_FORCE_LIMITS.centerForce),
    repelForce: normalizeNumber(src.repelForce, GRAPH_FORCE_LIMITS.repelForce),
    linkForce: normalizeNumber(src.linkForce, GRAPH_FORCE_LIMITS.linkForce),
    linkDistance: normalizeNumber(src.linkDistance, GRAPH_FORCE_LIMITS.linkDistance),
  }
}

const normalizeGroups = (raw) => {
  if (!Array.isArray(raw)) return []
  const seenIds = new Set()
  const result = []

  for (let i = 0; i < raw.length && result.length < GRAPH_GROUP_LIMITS.maxGroups; i += 1) {
    const entry = raw[i]
    if (!isPlainObject(entry)) continue
    let id = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `group-${i + 1}`
    while (seenIds.has(id)) {
      id = `${id}-${result.length + 1}`
    }
    seenIds.add(id)
    const paletteFallback = GRAPH_GROUP_PALETTE[result.length % GRAPH_GROUP_PALETTE.length]
    result.push({
      id,
      query:
        typeof entry.query === 'string' ? entry.query.slice(0, GRAPH_GROUP_LIMITS.maxQueryLength) : '',
      color: normalizeHexColor(entry.color, paletteFallback),
    })
  }
  return result
}

const createDefaultViewSettings = (isLocal = false) => {
  const base = {
    filters: createDefaultGraphFilters(),
    display: normalizeDisplay(),
    forces: normalizeForces(),
  }
  if (!isLocal) return base
  return {
    depth: GRAPH_LOCAL_LIMITS.depth.default,
    direction: GRAPH_LOCAL_LIMITS.directions[0],
    ...base,
  }
}

const normalizeViewSettings = (raw, isLocal = false) => {
  const src = isPlainObject(raw) ? raw : {}
  const base = {
    filters: normalizeFilters(src.filters),
    display: normalizeDisplay(src.display),
    forces: normalizeForces(src.forces),
  }
  if (!isLocal) return base
  return {
    depth: normalizeNumber(src.depth, GRAPH_LOCAL_LIMITS.depth),
    direction: GRAPH_LOCAL_LIMITS.directions.includes(src.direction)
      ? src.direction
      : GRAPH_LOCAL_LIMITS.directions[0],
    ...base,
  }
}

/** Create fresh normalized graph settings matching Stage 1/2 baseline defaults. */
export const createDefaultGraphSettings = () => ({
  version: GRAPH_SETTINGS_VERSION,
  groups: [],
  global: createDefaultViewSettings(false),
  local: createDefaultViewSettings(true),
})

/** Validate and strip unknown fields from untrusted settings input. */
export const normalizeGraphSettings = (raw) => {
  if (!isPlainObject(raw)) return createDefaultGraphSettings()
  if (raw.version !== undefined && raw.version !== GRAPH_SETTINGS_VERSION) {
    return createDefaultGraphSettings()
  }
  return {
    version: GRAPH_SETTINGS_VERSION,
    groups: normalizeGroups(raw.groups),
    global: normalizeViewSettings(raw.global, false),
    local: normalizeViewSettings(raw.local, true),
  }
}

export const getGraphSettingsStorageKey = (vaultDirectory) => {
  if (typeof vaultDirectory !== 'string' || !vaultDirectory.trim()) return null
  return `${GRAPH_STORAGE_KEY_PREFIX}${vaultDirectory}`
}

const resolveDefaultStorage = () => {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

/** Safely load and normalize persisted graph settings for a vault directory. */
export const loadGraphSettings = (vaultDirectory, storage = resolveDefaultStorage()) => {
  const key = getGraphSettingsStorageKey(vaultDirectory)
  if (!key || !storage || typeof storage.getItem !== 'function') {
    return { settings: createDefaultGraphSettings(), error: null }
  }

  let rawJson = null
  try {
    rawJson = storage.getItem(key)
  } catch {
    return {
      settings: createDefaultGraphSettings(),
      error: 'Could not access saved graph settings in browser storage.',
    }
  }

  if (!rawJson) {
    return { settings: createDefaultGraphSettings(), error: null }
  }

  try {
    const parsed = JSON.parse(rawJson)
    return { settings: normalizeGraphSettings(parsed), error: null }
  } catch {
    return { settings: createDefaultGraphSettings(), error: null }
  }
}

/** Normalize and persist graph settings per vault without throwing on storage errors. */
export const saveGraphSettings = (vaultDirectory, settings, storage = resolveDefaultStorage()) => {
  const normalized = normalizeGraphSettings(settings)
  const key = getGraphSettingsStorageKey(vaultDirectory)
  if (!key || !storage || typeof storage.setItem !== 'function') {
    return {
      ok: false,
      settings: normalized,
      error: 'Browser storage unavailable for graph settings.',
    }
  }

  try {
    storage.setItem(key, JSON.stringify(normalized))
    return { ok: true, settings: normalized, error: null }
  } catch {
    return {
      ok: false,
      settings: normalized,
      error: 'Could not save graph settings to browser storage.',
    }
  }
}

/** Return a normalized copy with patched settings for either 'global' or 'local'. */
export const updateGraphViewSettings = (settings, mode, patch) => {
  const current = normalizeGraphSettings(settings)
  const viewKey = mode === 'local' ? 'local' : 'global'
  const prevView = current[viewKey]
  const srcPatch = isPlainObject(patch) ? patch : {}

  const nextView = {
    ...prevView,
    ...(viewKey === 'local'
      ? {
          depth: srcPatch.depth !== undefined ? srcPatch.depth : prevView.depth,
          direction: srcPatch.direction !== undefined ? srcPatch.direction : prevView.direction,
        }
      : {}),
    filters: isPlainObject(srcPatch.filters) ? { ...prevView.filters, ...srcPatch.filters } : prevView.filters,
    display: isPlainObject(srcPatch.display) ? { ...prevView.display, ...srcPatch.display } : prevView.display,
    forces: isPlainObject(srcPatch.forces) ? { ...prevView.forces, ...srcPatch.forces } : prevView.forces,
  }

  return normalizeGraphSettings({
    ...current,
    [viewKey]: nextView,
  })
}

const nextUniqueGroupId = (groups) => {
  const used = new Set(groups.map((g) => g.id))
  let idx = groups.length + 1
  while (used.has(`group-${idx}`)) idx += 1
  return `group-${idx}`
}

export const addColorGroup = (settings, initial = {}) => {
  const current = normalizeGraphSettings(settings)
  if (current.groups.length >= GRAPH_GROUP_LIMITS.maxGroups) return current
  const fallbackColor = GRAPH_GROUP_PALETTE[current.groups.length % GRAPH_GROUP_PALETTE.length]
  const id =
    typeof initial.id === 'string' && initial.id.trim() ? initial.id.trim() : nextUniqueGroupId(current.groups)
  const nextGroup = {
    id,
    query: typeof initial.query === 'string' ? initial.query : '',
    color: normalizeHexColor(initial.color, fallbackColor),
  }
  return normalizeGraphSettings({
    ...current,
    groups: [...current.groups, nextGroup],
  })
}

export const updateColorGroup = (settings, groupId, patch) => {
  const current = normalizeGraphSettings(settings)
  const srcPatch = isPlainObject(patch) ? patch : {}
  return normalizeGraphSettings({
    ...current,
    groups: current.groups.map((group) =>
      group.id === groupId
        ? {
            ...group,
            ...(typeof srcPatch.query === 'string' ? { query: srcPatch.query } : {}),
            ...(srcPatch.color !== undefined ? { color: srcPatch.color } : {}),
          }
        : group
    ),
  })
}

export const removeColorGroup = (settings, groupId) => {
  const current = normalizeGraphSettings(settings)
  return normalizeGraphSettings({
    ...current,
    groups: current.groups.filter((group) => group.id !== groupId),
  })
}

export const moveColorGroup = (settings, groupId, delta) => {
  const current = normalizeGraphSettings(settings)
  const index = current.groups.findIndex((group) => group.id === groupId)
  if (index < 0) return current
  const targetIndex = index + (delta < 0 ? -1 : 1)
  if (targetIndex < 0 || targetIndex >= current.groups.length) return current

  const reordered = [...current.groups]
  const [moved] = reordered.splice(index, 1)
  reordered.splice(targetIndex, 0, moved)
  return normalizeGraphSettings({
    ...current,
    groups: reordered,
  })
}

/** Restore default settings for one view while preserving shared groups unless opted in. */
export const resetGraphViewSettings = (settings, mode, { includeGroups = false } = {}) => {
  const current = normalizeGraphSettings(settings)
  const viewKey = mode === 'local' ? 'local' : 'global'
  return normalizeGraphSettings({
    ...current,
    groups: includeGroups ? [] : current.groups,
    [viewKey]: createDefaultViewSettings(viewKey === 'local'),
  })
}

export const resetGraphGroups = (settings) => {
  const current = normalizeGraphSettings(settings)
  return normalizeGraphSettings({
    ...current,
    groups: [],
  })
}

/** Evaluate ordered color groups against note nodes without altering tags, unresolved nodes, or input arrays. */
export const evaluateGraphGroups = (groups, nodes, tagsByFile) => {
  const normalizedGroups = normalizeGroups(groups)
  const errorsByGroupId = {}
  const activeRules = []

  for (const group of normalizedGroups) {
    const parsed = parseGraphSearchQuery(group.query)
    if (!parsed.valid) {
      errorsByGroupId[group.id] = parsed.error || 'Invalid group query'
      continue
    }
    if (!parsed.isEmpty) {
      activeRules.push({ group, terms: parsed.terms })
    }
  }

  const colorsByNodeId = {}
  if (activeRules.length === 0 || !Array.isArray(nodes)) {
    return { colorsByNodeId, errorsByGroupId }
  }

  for (const node of nodes) {
    if (!node || (node.type && node.type !== 'note')) continue
    for (const rule of activeRules) {
      if (noteMatchesTerms(node, rule.terms, tagsByFile)) {
        colorsByNodeId[node.id] = rule.group.color
        break
      }
    }
  }

  return { colorsByNodeId, errorsByGroupId }
}

/** Monotonic zoom-threshold fade opacity matching Obsidian's text fade control. */
export const resolveLabelOpacity = (scale, textFadeThreshold = GRAPH_DISPLAY_LIMITS.textFadeThreshold.default) => {
  if (!Number.isFinite(scale)) return 0
  const threshold = Number.isFinite(textFadeThreshold)
    ? textFadeThreshold
    : GRAPH_DISPLAY_LIMITS.textFadeThreshold.default
  if (scale < threshold) return 0
  return Math.min(0.88, Math.max(0, (scale - threshold) / 0.45))
}

/** Compute finite directional arrow geometry shortened outside node circles; separates bidirectional links. */
export const computeArrowGeometry = ({
  sx,
  sy,
  tx,
  ty,
  sourceRadius = 0,
  targetRadius = 0,
  bidirectional = false,
  arrowSize = 6,
}) => {
  if (
    !Number.isFinite(sx) ||
    !Number.isFinite(sy) ||
    !Number.isFinite(tx) ||
    !Number.isFinite(ty) ||
    !Number.isFinite(sourceRadius) ||
    !Number.isFinite(targetRadius)
  ) {
    return null
  }

  const dx = tx - sx
  const dy = ty - sy
  const len = Math.hypot(dx, dy)
  if (!Number.isFinite(len) || len <= 1e-6) return null

  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux

  const lateralOffset = bidirectional ? 2.5 : 0
  const ox = nx * lateralOffset
  const oy = ny * lateralOffset

  const startPad = Math.max(0, sourceRadius) + 1.5
  const endPad = Math.max(0, targetRadius) + 2
  const usableLen = len - startPad - endPad
  if (usableLen <= 2) return null

  const x1 = sx + ox + ux * startPad
  const y1 = sy + oy + uy * startPad
  const tipX = tx + ox - ux * endPad
  const tipY = ty + oy - uy * endPad

  const headLen = Math.max(2, Math.min(arrowSize, usableLen * 0.55))
  const headHalfWidth = headLen * 0.52

  return {
    x1,
    y1,
    tipX,
    tipY,
    leftX: tipX - ux * headLen + nx * headHalfWidth,
    leftY: tipY - uy * headLen + ny * headHalfWidth,
    rightX: tipX - ux * headLen - nx * headHalfWidth,
    rightY: tipY - uy * headLen - ny * headHalfWidth,
  }
}

/** Update live D3 force parameters without recreating the simulation or dropping node positions. */
export const applySimulationForces = (simulation, rawForces, { restart = true } = {}) => {
  if (!simulation || typeof simulation.force !== 'function') return
  const forces = normalizeForces(rawForces)

  simulation.force('x')?.strength?.(forces.centerForce)
  simulation.force('y')?.strength?.(forces.centerForce)
  simulation.force('charge')?.strength?.(-forces.repelForce)
  const linkForce = simulation.force('link')
  if (linkForce) {
    linkForce.strength?.(forces.linkForce)
    linkForce.distance?.(forces.linkDistance)
  }

  if (restart) {
    simulation.alpha?.(0.32)?.restart?.()
  }
}
