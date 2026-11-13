import { resolvePendingLinkCreationTarget } from '../markdown/links.js'
import { matchesTagQuery, validateTagName } from '../markdown/properties.js'

const SUPPORTED_OPERATORS = new Set(['file', 'path', 'tag'])

export const DEFAULT_GRAPH_FILTERS = Object.freeze({
  searchQuery: '',
  showTags: false,
  existingFilesOnly: true,
  showOrphans: true,
})

export const createDefaultGraphFilters = () => ({ ...DEFAULT_GRAPH_FILTERS })

const compareStrings = (a, b) => String(a || '').localeCompare(String(b || ''))

const endpointId = (end) => (typeof end === 'string' ? end : end?.id || '')

const stripMarkdownExtension = (name) =>
  typeof name === 'string' ? name.replace(/\.(md|markdown)$/i, '') : ''

const basenameOf = (filePath) => {
  if (typeof filePath !== 'string') return ''
  const idx = filePath.lastIndexOf('/')
  return idx === -1 ? filePath : filePath.slice(idx + 1)
}

const sortNodes = (nodes) => [...nodes].sort((a, b) => compareStrings(a.id, b.id))

const sortEdges = (edges) =>
  [...edges].sort(
    (a, b) =>
      compareStrings(a.source, b.source) ||
      compareStrings(a.target, b.target) ||
      compareStrings(a.type || '', b.type || '')
  )

const recomputeDegrees = (nodes, edges) => {
  const counts = new Map()
  for (const edge of edges) {
    counts.set(edge.source, (counts.get(edge.source) || 0) + 1)
    if (edge.target !== edge.source) {
      counts.set(edge.target, (counts.get(edge.target) || 0) + 1)
    }
  }
  return nodes.map((node) => ({
    ...node,
    degree: counts.get(node.id) || 0,
  }))
}

const tokenizeSearchInput = (raw) => {
  const tokens = []
  let current = ''
  let inQuotes = false
  let quoted = false

  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (ch === '"') {
      if (!inQuotes) {
        if (current.length > 0 && !current.endsWith(':')) {
          return { error: 'Malformed quotes in search query.' }
        }
        inQuotes = true
        quoted = true
      } else {
        const next = raw[i + 1]
        if (next !== undefined && !/\s/.test(next)) {
          return { error: 'Malformed quotes in search query.' }
        }
        inQuotes = false
      }
      current += ch
      continue
    }

    if (!inQuotes && /\s/.test(ch)) {
      if (current.length > 0) {
        tokens.push({ raw: current, quoted })
        current = ''
        quoted = false
      }
      continue
    }

    current += ch
  }

  if (inQuotes) {
    return { error: 'Unclosed quote in search query.' }
  }
  if (current.length > 0) {
    tokens.push({ raw: current, quoted })
  }
  return { tokens, error: '' }
}

const stripOuterQuotes = (value) =>
  value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1)
    : value

/**
 * Parse a formal subset of graph search queries (`text`, `file:`, `path:`, `tag:`),
 * explicitly marking unsupported syntax invalid instead of silently misinterpreting it.
 */
export const parseGraphSearchQuery = (rawQuery) => {
  if (typeof rawQuery !== 'string' || !rawQuery.trim()) {
    return { valid: true, isEmpty: true, raw: '', terms: [], error: '' }
  }

  const trimmed = rawQuery.trim()
  const { tokens, error: tokenError } = tokenizeSearchInput(trimmed)
  if (tokenError) {
    return { valid: false, isEmpty: false, raw: trimmed, terms: [], error: tokenError }
  }

  const terms = []
  for (const { raw: token, quoted } of tokens) {
    const outerQuoted = token.startsWith('"') && token.endsWith('"')

    if (!outerQuoted) {
      if (token === 'OR' || token.startsWith('(') || token.endsWith(')')) {
        return {
          valid: false,
          isEmpty: false,
          raw: trimmed,
          terms: [],
          error: `Unsupported boolean or grouping syntax "${token}".`,
        }
      }
      if (token.startsWith('-')) {
        return {
          valid: false,
          isEmpty: false,
          raw: trimmed,
          terms: [],
          error: `Negation filter "${token}" is not supported.`,
        }
      }
      if (token.length >= 2 && token.startsWith('/') && token.endsWith('/')) {
        return {
          valid: false,
          isEmpty: false,
          raw: trimmed,
          terms: [],
          error: `Regex filter "${token}" is not supported.`,
        }
      }

      const colonIdx = token.indexOf(':')
      if (colonIdx === 0) {
        return {
          valid: false,
          isEmpty: false,
          raw: trimmed,
          terms: [],
          error: `Unsupported filter syntax "${token}".`,
        }
      }

      if (colonIdx > 0) {
        const prefix = token.slice(0, colonIdx).toLowerCase()
        const rawVal = stripOuterQuotes(token.slice(colonIdx + 1)).trim()
        if (!SUPPORTED_OPERATORS.has(prefix)) {
          return {
            valid: false,
            isEmpty: false,
            raw: trimmed,
            terms: [],
            error: `Unsupported operator "${prefix}:". Supported: file:, path:, tag:.`,
          }
        }
        if (!rawVal) {
          return {
            valid: false,
            isEmpty: false,
            raw: trimmed,
            terms: [],
            error: `Operator "${prefix}:" requires a value.`,
          }
        }
        if (prefix === 'tag') {
          const validTag = validateTagName(rawVal)
          if (!validTag) {
            return {
              valid: false,
              isEmpty: false,
              raw: trimmed,
              terms: [],
              error: `Invalid tag filter "${rawVal}".`,
            }
          }
          terms.push({ kind: 'tag', value: validTag.toLowerCase() })
        } else {
          terms.push({ kind: prefix, value: rawVal.toLowerCase() })
        }
        continue
      }
    }

    const plain = stripOuterQuotes(token).trim()
    if (quoted && !plain) {
      return {
        valid: false,
        isEmpty: false,
        raw: trimmed,
        terms: [],
        error: 'Empty quoted search term.',
      }
    }
    if (plain) {
      terms.push({ kind: 'text', value: plain.toLowerCase() })
    }
  }

  return {
    valid: true,
    isEmpty: terms.length === 0,
    raw: trimmed,
    terms,
    error: '',
  }
}

export const noteMatchesTerms = (note, terms, tagsByFile) => {
  const pathLower = String(note.path || '').toLowerCase()
  const labelLower = String(note.label || '').toLowerCase()
  const fileLower = basenameOf(pathLower)
  const noteTags = tagsByFile?.[note.path] || []

  for (const term of terms) {
    if (term.kind === 'text') {
      if (!labelLower.includes(term.value) && !pathLower.includes(term.value)) return false
    } else if (term.kind === 'file') {
      if (!fileLower.includes(term.value) && !labelLower.includes(term.value)) return false
    } else if (term.kind === 'path') {
      if (!pathLower.includes(term.value)) return false
    } else if (term.kind === 'tag') {
      if (!matchesTagQuery(noteTags, term.value)) return false
    }
  }
  return true
}

const resolveUnresolvedDescriptor = (ref, sourcePath) => {
  if (ref?.status !== 'missing' || typeof ref.rawTarget !== 'string') return null
  const pending = resolvePendingLinkCreationTarget({
    linkTarget: ref.rawTarget,
    sourcePath,
    kind: ref.kind,
  })
  if (!pending?.path) return null

  const label = stripMarkdownExtension(pending.name) || pending.name
  return {
    id: `unresolved:${pending.path.toLowerCase()}`,
    path: pending.path,
    label,
  }
}

const buildTagDisplayMap = (vaultIndex) => {
  const displayByLower = new Map()
  if (Array.isArray(vaultIndex?.allTags)) {
    for (const entry of vaultIndex.allTags) {
      if (typeof entry?.tag === 'string' && entry.tag) {
        const lower = entry.tag.toLowerCase()
        if (!displayByLower.has(lower)) displayByLower.set(lower, entry.tag)
      }
    }
  }
  if (vaultIndex?.tagsByFile && typeof vaultIndex.tagsByFile === 'object') {
    for (const tags of Object.values(vaultIndex.tagsByFile)) {
      if (!Array.isArray(tags)) continue
      for (const tag of tags) {
        if (typeof tag === 'string' && tag) {
          const lower = tag.toLowerCase()
          if (!displayByLower.has(lower)) displayByLower.set(lower, tag)
        }
      }
    }
  }
  return displayByLower
}

/**
 * Apply Search, Orphans, Existing-files-only, and Tags filters onto a graph projection.
 */
export const applyGraphFilters = (graph, rawFilters = {}, vaultIndex = {}) => {
  const filters = { ...DEFAULT_GRAPH_FILTERS, ...(rawFilters || {}) }
  const parsedQuery = parseGraphSearchQuery(filters.searchQuery)
  const rawNodes = Array.isArray(graph?.nodes) ? graph.nodes : []
  const rawEdges = Array.isArray(graph?.edges) ? graph.edges : []
  const noteNodes = rawNodes.filter((n) => n?.type === 'note' || !n?.type)
  const rawNoteCount = noteNodes.length

  const tagsByFile = vaultIndex?.tagsByFile || {}
  const outgoingByFile = vaultIndex?.outgoingByFile || {}

  const keptNotes = []
  const keptNoteIds = new Set()

  for (const node of noteNodes) {
    const baseDegree = node.degree ?? 0
    if (filters.showOrphans === false && baseDegree === 0) continue
    if (parsedQuery.valid && !parsedQuery.isEmpty) {
      if (!noteMatchesTerms(node, parsedQuery.terms, tagsByFile)) continue
    }
    keptNotes.push({
      ...node,
      type: 'note',
    })
    keptNoteIds.add(node.id)
  }

  const finalEdges = []
  const seenEdges = new Set()
  const addEdge = (edge) => {
    const key = `${edge.source}\0${edge.target}\0${edge.type || ''}`
    if (seenEdges.has(key)) return
    seenEdges.add(key)
    finalEdges.push(edge)
  }

  for (const edge of rawEdges) {
    const src = endpointId(edge?.source)
    const dst = endpointId(edge?.target)
    if (!keptNoteIds.has(src) || !keptNoteIds.has(dst)) continue
    addEdge({ source: src, target: dst })
  }

  const finalNodes = [...keptNotes]

  if (filters.existingFilesOnly === false) {
    const unresolvedMap = new Map()

    for (const note of keptNotes) {
      const refs = outgoingByFile[note.path]
      if (!Array.isArray(refs)) continue

      for (const ref of refs) {
        const desc = resolveUnresolvedDescriptor(ref, note.path)
        if (!desc) continue

        let uNode = unresolvedMap.get(desc.id)
        if (!uNode) {
          uNode = {
            id: desc.id,
            path: desc.path,
            label: desc.label,
            type: 'unresolved',
            sourcePaths: new Set(),
            degree: 0,
          }
          unresolvedMap.set(desc.id, uNode)
        }
        uNode.sourcePaths.add(note.path)
        addEdge({ source: note.id, target: desc.id, type: 'unresolved' })
      }
    }

    for (const uNode of unresolvedMap.values()) {
      finalNodes.push({
        id: uNode.id,
        path: uNode.path,
        label: uNode.label,
        type: 'unresolved',
        sourcePaths: [...uNode.sourcePaths].sort(compareStrings),
        degree: 0,
      })
    }
  }

  if (filters.showTags === true) {
    const tagDisplayByLower = buildTagDisplayMap(vaultIndex)
    const tagMap = new Map()

    for (const note of keptNotes) {
      const noteTags = tagsByFile[note.path]
      if (!Array.isArray(noteTags)) continue

      for (const rawTag of noteTags) {
        if (typeof rawTag !== 'string' || !rawTag) continue
        const lower = rawTag.toLowerCase()
        const tagId = `tag:${lower}`
        const displayTag = tagDisplayByLower.get(lower) || rawTag
        if (!tagMap.has(tagId)) {
          tagMap.set(tagId, {
            id: tagId,
            tag: displayTag,
            path: null,
            label: `#${displayTag}`,
            type: 'tag',
            degree: 0,
          })
        }
        addEdge({ source: note.id, target: tagId, type: 'tag' })
      }
    }

    for (const tagNode of tagMap.values()) {
      finalNodes.push(tagNode)
    }
  }

  const sortedEdges = sortEdges(finalEdges)
  const nodesWithDegree = recomputeDegrees(sortNodes(finalNodes), sortedEdges)

  return {
    nodes: nodesWithDegree,
    edges: sortedEdges,
    complete: Boolean(graph?.complete),
    failures: Array.isArray(graph?.failures) ? [...graph.failures] : [],
    queryValid: parsedQuery.valid,
    queryError: parsedQuery.error,
    rawNodeCount: rawNoteCount,
    filteredOut: rawNoteCount > 0 && nodesWithDegree.length === 0,
    reason: rawNoteCount > 0 && nodesWithDegree.length === 0 ? 'filtered-empty' : null,
  }
}

/**
 * Project the Global Graph with active filters cleanly isolated from base state.
 */
export const projectGraphView = ({
  baseGraph,
  vaultIndex,
  filters = DEFAULT_GRAPH_FILTERS,
} = {}) => applyGraphFilters(baseGraph, filters, vaultIndex)
