const MARKDOWN_EXT_RE = /\.(md|markdown)$/i

const isMarkdownNotePath = (filePath) =>
  typeof filePath === 'string' &&
  filePath.length > 0 &&
  !filePath.includes('\0') &&
  !filePath.includes('\\') &&
  !filePath.startsWith('/') &&
  MARKDOWN_EXT_RE.test(filePath)

const comparePaths = (a, b) =>
  a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b)

const getNoteLabel = (notePath) => {
  const base = notePath.split('/').pop() || notePath
  return base.replace(MARKDOWN_EXT_RE, '')
}

const toNoteNodeId = (notePath) => `note:${notePath}`

/**
 * Derive a pure, serializable Global Graph model from a built vault index.
 * Kept independent of Vue, D3, and Canvas so future node types (e.g. unresolved)
 * and filters can layer on without changing edge derivation.
 */
export const buildGraphModel = (vaultIndex) => {
  if (!vaultIndex || typeof vaultIndex !== 'object') {
    return {
      nodes: [],
      edges: [],
      complete: false,
      failures: [],
    }
  }

  const failures = Array.isArray(vaultIndex.failures)
    ? vaultIndex.failures.map((item) => (item && typeof item === 'object' ? { ...item } : item))
    : []
  const complete = Boolean(vaultIndex.complete) && failures.length === 0

  const notePathSet = new Set()
  if (vaultIndex.notesByPath && typeof vaultIndex.notesByPath === 'object') {
    for (const notePath of Object.keys(vaultIndex.notesByPath)) {
      if (isMarkdownNotePath(notePath)) {
        notePathSet.add(notePath)
      }
    }
  }
  if (Array.isArray(vaultIndex.files)) {
    for (const filePath of vaultIndex.files) {
      if (isMarkdownNotePath(filePath)) {
        notePathSet.add(filePath)
      }
    }
  }

  const sortedPaths = Array.from(notePathSet).sort(comparePaths)
  const nodesByPath = new Map()
  const nodes = sortedPaths.map((notePath) => {
    const node = {
      id: toNoteNodeId(notePath),
      path: notePath,
      label: getNoteLabel(notePath),
      type: 'note',
      degree: 0,
    }
    nodesByPath.set(notePath, node)
    return node
  })

  const edges = []
  const outgoingByFile =
    vaultIndex.outgoingByFile && typeof vaultIndex.outgoingByFile === 'object'
      ? vaultIndex.outgoingByFile
      : {}

  for (const sourcePath of sortedPaths) {
    const refs = outgoingByFile[sourcePath]
    if (!Array.isArray(refs) || refs.length === 0) continue

    const targetPaths = new Set()
    for (const ref of refs) {
      if (!ref || ref.status !== 'resolved' || typeof ref.targetPath !== 'string') continue
      if (ref.targetPath === sourcePath) continue
      if (!nodesByPath.has(ref.targetPath)) continue
      targetPaths.add(ref.targetPath)
    }

    const sortedTargets = Array.from(targetPaths).sort(comparePaths)
    const sourceNode = nodesByPath.get(sourcePath)
    for (const targetPath of sortedTargets) {
      const targetNode = nodesByPath.get(targetPath)
      edges.push({
        source: sourceNode.id,
        target: targetNode.id,
      })
      sourceNode.degree += 1
      targetNode.degree += 1
    }
  }

  return {
    nodes,
    edges,
    complete,
    failures,
  }
}
