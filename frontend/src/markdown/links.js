import { parseNoteDocument } from './properties.js'
import { ayameMarkdownParser } from './parser.js'

const SUPPORTED_MARKDOWN_RE = /\.(md|markdown)$/i
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/

const dirnameOf = (filePath) => {
  if (typeof filePath !== 'string' || !filePath.includes('/')) return ''
  return filePath.slice(0, filePath.lastIndexOf('/'))
}

const basenameOf = (filePath) => {
  if (typeof filePath !== 'string') return ''
  const idx = filePath.lastIndexOf('/')
  return idx === -1 ? filePath : filePath.slice(idx + 1)
}

const stemOf = (filePath) => basenameOf(filePath).replace(SUPPORTED_MARKDOWN_RE, '')

const getExtension = (name) => {
  const base = basenameOf(name)
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot).toLowerCase()
}

const isSupportedMarkdownPath = (filePath) =>
  typeof filePath === 'string' &&
  filePath.length > 0 &&
  !filePath.includes('\0') &&
  !filePath.includes('\\') &&
  !filePath.startsWith('/') &&
  SUPPORTED_MARKDOWN_RE.test(filePath)

export const classifyLinkDestination = (rawDestination) => {
  if (typeof rawDestination !== 'string') {
    return { type: 'invalid' }
  }
  const trimmed = rawDestination.trim()
  if (trimmed.length === 0 || trimmed.includes('\0') || /[\x00-\x1f\x7f]/.test(trimmed)) {
    return { type: 'invalid' }
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return { type: 'external', href: trimmed }
  }
  if (SCHEME_RE.test(trimmed) || trimmed.startsWith('//')) {
    return { type: 'invalid' }
  }
  return { type: 'internal', target: trimmed }
}

export const parseWikilink = (raw) => {
  if (typeof raw !== 'string') return null
  let inner = raw.trim()
  const isEmbed = inner.startsWith('![[') && inner.endsWith(']]')
  if (isEmbed) {
    inner = inner.slice(3, -2)
  } else if (inner.startsWith('[[') && inner.endsWith(']]')) {
    inner = inner.slice(2, -2)
  }
  if (inner.length === 0 || inner.includes('\0') || inner.includes('\n') || inner.includes('\r')) {
    return null
  }

  let targetAndAnchor = inner
  let alias = null
  const pipeIndex = inner.indexOf('|')
  if (pipeIndex !== -1) {
    targetAndAnchor = inner.slice(0, pipeIndex).trim()
    alias = inner.slice(pipeIndex + 1).trim()
    if (!alias) return null
  } else {
    targetAndAnchor = inner.trim()
  }

  let target = targetAndAnchor
  let anchor = null
  const hashIndex = targetAndAnchor.indexOf('#')
  if (hashIndex !== -1) {
    target = targetAndAnchor.slice(0, hashIndex).trim()
    anchor = targetAndAnchor.slice(hashIndex + 1).trim()
    if (!anchor) return null
  }

  if (!target && !anchor) return null

  const blockId = anchor && anchor.startsWith('^') && anchor.length > 1 ? anchor.slice(1) : null

  const defaultDisplay = target
    ? anchor
      ? `${target}#${anchor}`
      : target
    : `#${anchor}`

  const result = {
    target,
    alias,
    anchor,
    displayText: alias || defaultDisplay,
  }
  if (blockId) {
    result.blockId = blockId
  }
  if (isEmbed) {
    result.isEmbed = true
  }
  return result
}

const normalizeRelativeSegments = (baseDir, targetPath, allowDotNavigation) => {
  if (
    typeof targetPath !== 'string' ||
    targetPath.length === 0 ||
    targetPath.includes('\0') ||
    targetPath.includes('\\') ||
    targetPath.startsWith('/') ||
    /^[a-zA-Z]:/.test(targetPath)
  ) {
    return null
  }

  const stack = baseDir ? baseDir.split('/').filter(Boolean) : []
  const rawSegments = targetPath.split('/')

  for (const seg of rawSegments) {
    if (seg === '') return null
    if (seg === '.') {
      if (!allowDotNavigation) return null
      continue
    }
    if (seg === '..') {
      if (!allowDotNavigation || stack.length === 0) return null
      stack.pop()
      continue
    }
    stack.push(seg)
  }

  return stack.length > 0 ? stack.join('/') : null
}

const attachAnchor = (result, anchor) => {
  if (result.type === 'resolved' && anchor) {
    const withAnchor = { ...result, anchor }
    if (anchor.startsWith('^') && anchor.length > 1) {
      withAnchor.blockId = anchor.slice(1)
    }
    return withAnchor
  }
  return result
}

const finalizeNotFound = (indexComplete) =>
  indexComplete === false ? { type: 'unverified' } : { type: 'missing' }

export const createLinkLookup = (knownFiles = [], aliasesByFile = {}) => {
  const files = new Set(Array.isArray(knownFiles) ? knownFiles.filter(isSupportedMarkdownPath) : [])
  const paths = new Map()
  const foldedPaths = new Map()
  const names = new Map()
  const foldedNames = new Map()
  const aliases = new Map()
  const add = (map, key, path) => {
    const matches = map.get(key)
    if (matches) matches.push(path)
    else map.set(key, [path])
  }
  for (const path of files) {
    const name = basenameOf(path)
    paths.set(path, [path])
    add(foldedPaths, path.toLowerCase(), path)
    add(names, name, path)
    add(foldedNames, name.toLowerCase(), path)
    const fileAliases = aliasesByFile?.[path]
    if (Array.isArray(fileAliases)) {
      for (const alias of new Set(fileAliases.map((value) => String(value ?? '').trim().toLowerCase()))) {
        add(aliases, alias, path)
      }
    }
  }
  return { paths, foldedPaths, names, foldedNames, aliases }
}

const resolveMatches = (matches, indexComplete) => {
  if (matches.length === 1) return { type: 'resolved', path: matches[0] }
  if (matches.length > 1) return { type: 'ambiguous', candidates: [...matches].sort() }
  return finalizeNotFound(indexComplete)
}

const matchExactOrExtensions = (candidate, exact, folded, indexComplete) => {
  const ext = getExtension(candidate)
  if (ext && !SUPPORTED_MARKDOWN_RE.test(ext)) return { type: 'invalid' }
  const candidates = ext ? [candidate] : [`${candidate}.md`, `${candidate}.markdown`]
  const exactMatches = candidates.flatMap((key) => exact.get(key) ?? [])
  if (exactMatches.length) return resolveMatches(exactMatches, indexComplete)
  return resolveMatches(candidates.flatMap((key) => folded.get(key.toLowerCase()) ?? []), indexComplete)
}

export const resolveLink = ({
  sourcePath = '',
  linkTarget,
  knownFiles = [],
  aliasesByFile = {},
  lookup,
  indexComplete = true,
  kind,
} = {}) => {
  if (typeof linkTarget !== 'string' || typeof sourcePath !== 'string') {
    return { type: 'invalid' }
  }

  const trimmed = linkTarget.trim()
  if (trimmed.length === 0 || trimmed.includes('\0') || trimmed.includes('\\')) {
    return { type: 'invalid' }
  }

  const linkLookup = lookup ?? createLinkLookup(knownFiles, aliasesByFile)
  const { paths, foldedPaths, names, foldedNames, aliases } = linkLookup

  let resolvedKind = kind
  let rawTarget = trimmed

  if ((trimmed.startsWith('[[') || trimmed.startsWith('![[')) && trimmed.endsWith(']]')) {
    resolvedKind = 'wikilink'
  } else if (/^!?\[([^\]]*)\]\(([\s\S]+)\)$/.test(trimmed)) {
    const match = trimmed.match(/^!?\[([^\]]*)\]\(([\s\S]+)\)$/)
    rawTarget = match[2].trim()
    resolvedKind = 'markdown'
  } else if (!resolvedKind) {
    if (trimmed.includes('|')) {
      resolvedKind = 'wikilink'
    } else if (trimmed.startsWith('./') || trimmed.startsWith('../')) {
      resolvedKind = 'markdown'
    }
  }

  if (resolvedKind === 'wikilink') {
    const parsed = parseWikilink(rawTarget)
    if (!parsed) return { type: 'invalid' }

    const { target, anchor } = parsed
    if (!target && anchor) {
      if (!isSupportedMarkdownPath(sourcePath)) return { type: 'invalid' }
      return attachAnchor({ type: 'resolved', path: sourcePath }, anchor)
    }

    if (
      target.includes('\\') ||
      target.startsWith('/') ||
      /^[a-zA-Z]:/.test(target) ||
      SCHEME_RE.test(target)
    ) {
      return { type: 'invalid' }
    }

    if (target.includes('/')) {
      const normalized = normalizeRelativeSegments('', target, false)
      if (!normalized) return { type: 'invalid' }
      return attachAnchor(
        matchExactOrExtensions(normalized, paths, foldedPaths, indexComplete),
        anchor
      )
    }

    if (target === '.' || target === '..') return { type: 'invalid' }
    const ext = getExtension(target)
    if (ext !== '' && !SUPPORTED_MARKDOWN_RE.test(ext)) {
      return { type: 'invalid' }
    }

    // 1. Search current directory first
    const sourceDir = dirnameOf(sourcePath)
    const localPrefix = sourceDir ? `${sourceDir}/${target}` : target
    const localResult = matchExactOrExtensions(
      localPrefix,
      paths,
      foldedPaths,
      indexComplete
    )
    if (
      localResult.type === 'resolved' ||
      localResult.type === 'ambiguous' ||
      localResult.type === 'invalid'
    ) {
      return attachAnchor(localResult, anchor)
    }

    // 2. Search across entire vault by filename (exact case first, then case-insensitive)
    const basenameMatch = matchExactOrExtensions(target, names, foldedNames, indexComplete)
    if (basenameMatch.type === 'resolved' || basenameMatch.type === 'ambiguous') {
      return attachAnchor(basenameMatch, anchor)
    }

    // 3. Search by frontmatter aliases
    return attachAnchor(resolveMatches(aliases.get(target.toLowerCase()) ?? [], indexComplete), anchor)
  }

  // Markdown link or generic path resolution
  const classified = classifyLinkDestination(rawTarget)
  if (classified.type !== 'internal') {
    return { type: 'invalid' }
  }

  let decodedTarget
  try {
    decodedTarget = decodeURIComponent(classified.target)
  } catch {
    return { type: 'invalid' }
  }

  if (decodedTarget.includes('\0') || decodedTarget.includes('\\')) {
    return { type: 'invalid' }
  }

  let targetPart = decodedTarget
  let anchor = null
  const hashIndex = decodedTarget.indexOf('#')
  if (hashIndex !== -1) {
    targetPart = decodedTarget.slice(0, hashIndex)
    anchor = decodedTarget.slice(hashIndex + 1).trim()
    if (!anchor) return { type: 'invalid' }
  }

  if (!targetPart && anchor) {
    if (!isSupportedMarkdownPath(sourcePath)) return { type: 'invalid' }
    return attachAnchor({ type: 'resolved', path: sourcePath }, anchor)
  }

  const sourceDir = dirnameOf(sourcePath)
  const normalized = normalizeRelativeSegments(sourceDir, targetPart, true)
  if (!normalized) {
    return { type: 'invalid' }
  }

  const localMatch = matchExactOrExtensions(
    normalized,
    paths,
    foldedPaths,
    indexComplete
  )
  if (
    localMatch.type === 'resolved' ||
    localMatch.type === 'ambiguous' ||
    localMatch.type === 'invalid'
  ) {
    return attachAnchor(localMatch, anchor)
  }

  // Also try vault-root relative path for Markdown links without './' or '../'
  if (!targetPart.startsWith('./') && !targetPart.startsWith('../') && sourceDir !== '') {
    const rootNormalized = normalizeRelativeSegments('', targetPart, false)
    if (rootNormalized) {
      const rootMatch = matchExactOrExtensions(
        rootNormalized,
        paths,
        foldedPaths,
        indexComplete
      )
      if (rootMatch.type === 'resolved' || rootMatch.type === 'ambiguous') {
        return attachAnchor(rootMatch, anchor)
      }
    }
  }

  if (!resolvedKind && !targetPart.startsWith('./') && !targetPart.startsWith('../')) {
    return resolveLink({
      sourcePath,
      linkTarget: anchor ? `[[${targetPart}#${anchor}]]` : `[[${targetPart}]]`,
      lookup: linkLookup,
      indexComplete,
      kind: 'wikilink',
    })
  }

  return localMatch
}

export const resolvePendingLinkCreationTarget = ({
  linkTarget,
  sourcePath = '',
  kind,
  newNoteLocation = 'root', // 'root' | 'current' | 'folder'
  newNoteFolder = '',
} = {}) => {
  if (typeof linkTarget !== 'string') return null
  const trimmed = linkTarget.trim()
  if (!trimmed) return null

  const isWiki =
    kind === 'wikilink' ||
    ((trimmed.startsWith('[[') || trimmed.startsWith('![[')) && trimmed.endsWith(']]')) ||
    (!kind && !trimmed.startsWith('./') && !trimmed.startsWith('../'))

  let targetPathPart = ''
  let anchor = null

  if (isWiki) {
    const parsed = parseWikilink(trimmed)
    if (!parsed || !parsed.target) return null
    targetPathPart = parsed.target
    anchor = parsed.anchor || null
    if (targetPathPart.includes('\\') || targetPathPart.startsWith('/')) return null

    if (!targetPathPart.includes('/')) {
      const ext = getExtension(targetPathPart)
      if (ext !== '' && !SUPPORTED_MARKDOWN_RE.test(ext)) return null
      const fileName = ext === '' ? `${targetPathPart}.md` : targetPathPart
      let parentPath = ''
      if (newNoteLocation === 'current') {
        parentPath = dirnameOf(sourcePath)
      } else if (newNoteLocation === 'folder' && newNoteFolder) {
        parentPath = newNoteFolder.replace(/^\/+|\/+$/g, '')
      }
      const fullPath = parentPath ? `${parentPath}/${fileName}` : fileName
      return {
        parentPath,
        name: fileName,
        path: fullPath,
        anchor,
      }
    }

    const normalized = normalizeRelativeSegments('', targetPathPart, false)
    if (!normalized) return null
    const ext = getExtension(normalized)
    if (ext !== '' && !SUPPORTED_MARKDOWN_RE.test(ext)) return null
    const finalPath = ext === '' ? `${normalized}.md` : normalized
    return {
      parentPath: dirnameOf(finalPath),
      name: basenameOf(finalPath),
      path: finalPath,
      anchor,
    }
  }

  // Markdown relative link
  const classified = classifyLinkDestination(trimmed)
  if (classified.type !== 'internal') return null
  let decoded
  try {
    decoded = decodeURIComponent(classified.target)
  } catch {
    return null
  }
  const hashIdx = decoded.indexOf('#')
  if (hashIdx !== -1) {
    targetPathPart = decoded.slice(0, hashIdx).trim()
    anchor = decoded.slice(hashIdx + 1).trim() || null
  } else {
    targetPathPart = decoded.trim()
  }
  if (!targetPathPart) return null

  const normalized = normalizeRelativeSegments(dirnameOf(sourcePath), targetPathPart, true)
  if (!normalized) return null
  const ext = getExtension(normalized)
  if (ext !== '' && !SUPPORTED_MARKDOWN_RE.test(ext)) return null
  const finalPath = ext === '' ? `${normalized}.md` : normalized
  return {
    parentPath: dirnameOf(finalPath),
    name: basenameOf(finalPath),
    path: finalPath,
    anchor,
  }
}

const computeRelativePath = (fromDir, toPath) => {
  const fromParts = fromDir ? fromDir.split('/').filter(Boolean) : []
  const toParts = toPath.split('/').filter(Boolean)
  let common = 0
  while (
    common < fromParts.length &&
    common < toParts.length - 1 &&
    fromParts[common] === toParts[common]
  ) {
    common++
  }
  const upCount = fromParts.length - common
  const downParts = toParts.slice(common)
  if (upCount === 0) {
    return `./${downParts.join('/')}`
  }
  return `${'../'.repeat(upCount)}${downParts.join('/')}`
}

const encodeMarkdownLinkPath = (rawPath) =>
  rawPath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/')

export const formatInternalLink = ({
  sourcePath = '',
  targetPath,
  alias = null,
  anchor = null,
  allFiles = [],
  format = 'shortest', // 'shortest' | 'relative' | 'absolute'
  useWikilinks = true,
} = {}) => {
  if (typeof targetPath !== 'string' || !targetPath) return ''

  const targetStem = stemOf(targetPath)
  const targetNoExt = targetPath.replace(/\.md$/i, '')

  // Check if targetStem is unique across allFiles
  const sameStemCount = allFiles.filter(
    (f) => stemOf(f).toLowerCase() === targetStem.toLowerCase()
  ).length
  const isUnique = sameStemCount <= 1

  let linkPath
  if (format === 'shortest') {
    linkPath = isUnique ? (useWikilinks ? targetStem : basenameOf(targetPath)) : (useWikilinks ? targetNoExt : targetPath)
  } else if (format === 'relative') {
    const rel = computeRelativePath(dirnameOf(sourcePath), targetPath)
    linkPath = useWikilinks ? rel.replace(/^\.\//, '').replace(/\.md$/i, '') : rel
  } else {
    // 'absolute' (vault root)
    linkPath = useWikilinks ? targetNoExt : targetPath
  }

  const anchorSuffix = anchor ? `#${anchor}` : ''

  if (useWikilinks) {
    const aliasSuffix = alias && alias !== linkPath ? `|${alias}` : ''
    return `[[${linkPath}${anchorSuffix}${aliasSuffix}]]`
  }

  const display = alias || targetStem
  const encodedPath = encodeMarkdownLinkPath(linkPath)
  return `[${display}](${encodedPath}${anchorSuffix})`
}

const slugifyHeading = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')

const computeLineNumberAt = (docText, offset) => {
  let line = 1
  for (let i = 0; i < offset && i < docText.length; i++) {
    if (docText.charCodeAt(i) === 10 /* \n */) line++
  }
  return line
}

export const extractHeadings = (docText) => {
  if (typeof docText !== 'string' || !docText) return []
  const tree = ayameMarkdownParser.parse(docText)
  const headings = []

  tree.iterate({
    enter(nodeRef) {
      const name = nodeRef.name
      if (
        name === 'Frontmatter' ||
        name === 'FencedCode' ||
        name === 'CodeBlock' ||
        name === 'MathBlock'
      ) {
        return false
      }

      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice('ATXHeading'.length))
        const raw = docText.slice(nodeRef.from, nodeRef.to)
        const text = raw
          .replace(/^[ \t]*#{1,6}[ \t]*/, '')
          .replace(/[ \t]+#+[ \t]*$/, '')
          .trim()
        if (text) {
          headings.push({
            level,
            text,
            line: computeLineNumberAt(docText, nodeRef.from),
            from: nodeRef.from,
          })
        }
        return false
      }

      if (name === 'SetextHeading1' || name === 'SetextHeading2') {
        const level = name === 'SetextHeading1' ? 1 : 2
        let headerMarkFrom = nodeRef.to
        for (let child = nodeRef.node.firstChild; child; child = child.nextSibling) {
          if (child.name === 'HeaderMark') {
            headerMarkFrom = child.from
            break
          }
        }
        const text = docText
          .slice(nodeRef.from, headerMarkFrom)
          .replace(/\r?\n/g, ' ')
          .replace(/\s+/g, ' ')
          .trim()
        if (text) {
          headings.push({
            level,
            text,
            line: computeLineNumberAt(docText, nodeRef.from),
            from: nodeRef.from,
          })
        }
        return false
      }
    },
  })

  return headings
}

export const extractBlocks = (docText) => {
  if (typeof docText !== 'string' || !docText) return []
  const lines = docText.split(/\r?\n/)
  const blocks = []
  let inFrontmatter = false
  let inCodeFence = false
  let fenceChar = ''
  let offset = 0

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (i === 0 && /^---[ \t]*$/.test(line)) {
      inFrontmatter = true
      offset += line.length + 1
      continue
    }
    if (inFrontmatter) {
      if (/^(---|\.\.\.)[ \t]*$/.test(line)) {
        inFrontmatter = false
      }
      offset += line.length + 1
      continue
    }

    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/)
    if (fenceMatch) {
      if (!inCodeFence) {
        inCodeFence = true
        fenceChar = fenceMatch[1][0]
      } else if (fenceMatch[1][0] === fenceChar) {
        inCodeFence = false
        fenceChar = ''
      }
      offset += line.length + 1
      continue
    }

    if (!inCodeFence) {
      const match = line.match(/(?:^|\s)\^([a-zA-Z0-9-]+)\s*$/)
      if (match) {
        blocks.push({
          id: match[1],
          line: i + 1,
          from: offset,
          to: offset + line.length,
          text: line.replace(/\s*\^[a-zA-Z0-9-]+\s*$/, '').trim(),
        })
      }
    }
    offset += line.length + 1
  }

  return blocks
}

export const findBlockOffset = (docText, rawBlockId) => {
  if (typeof docText !== 'string' || typeof rawBlockId !== 'string') return null
  const cleanId = rawBlockId.trim().replace(/^\^/, '').toLowerCase()
  if (!cleanId) return null
  const blocks = extractBlocks(docText)
  return blocks.find((b) => b.id.toLowerCase() === cleanId) || null
}

export const findHeadingOffset = (docText, anchor) => {
  if (typeof docText !== 'string' || typeof anchor !== 'string' || !anchor.trim()) {
    return null
  }

  const targetRaw = anchor.trim()
  if (targetRaw.startsWith('^')) {
    return findBlockOffset(docText, targetRaw)
  }

  const targetLower = targetRaw.toLowerCase()
  const targetSlug = slugifyHeading(targetRaw)

  for (const heading of extractHeadings(docText)) {
    if (
      heading.text === targetRaw ||
      heading.text.toLowerCase() === targetLower ||
      slugifyHeading(heading.text) === targetSlug
    ) {
      return {
        line: heading.line,
        from: heading.from,
      }
    }
  }

  return null
}

const parseInlineLinksFromString = (text, location, extra = {}) => {
  const refs = []
  const linkRegex = /(!?\[\[[^\]]+\]\])|(!?\[([^\]]*)\]\(([^)\n]+)\))/g
  let m
  while ((m = linkRegex.exec(text)) !== null) {
    if (m[1]) {
      const raw = m[1]
      const parsed = parseWikilink(raw)
      if (!parsed) continue
      refs.push({
        raw,
        target: parsed.target || '',
        anchor: parsed.anchor || null,
        blockId: parsed.blockId || null,
        alias: parsed.alias || null,
        kind: 'wikilink',
        isEmbed: Boolean(parsed.isEmbed),
        location,
        ...extra,
      })
    } else if (m[2]) {
      const raw = m[2]
      const isEmbed = raw.startsWith('!')
      const label = m[3]
      const destRaw = m[4].trim()
      const classified = classifyLinkDestination(destRaw)
      if (classified.type !== 'internal') continue
      let decoded = classified.target
      try {
        decoded = decodeURIComponent(classified.target)
      } catch {
        continue
      }
      let target = decoded
      let anchor = null
      const hashIdx = decoded.indexOf('#')
      if (hashIdx !== -1) {
        target = decoded.slice(0, hashIdx)
        anchor = decoded.slice(hashIdx + 1) || null
      }
      refs.push({
        raw,
        target,
        anchor,
        blockId: anchor && anchor.startsWith('^') ? anchor.slice(1) : null,
        alias: label || null,
        kind: 'markdown',
        isEmbed,
        location,
        ...extra,
      })
    }
  }
  return refs
}

const getDirectAstChildren = (syntaxNode, name) => {
  const result = []
  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    if (!name || child.name === name) {
      result.push(child)
    }
  }
  return result
}

const normalizeRefKey = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

const buildInternalMarkdownRef = (raw, isEmbed, label, destRaw, location, extra = {}) => {
  const classified = classifyLinkDestination(destRaw)
  if (classified.type !== 'internal') return null
  let decoded = classified.target
  try {
    decoded = decodeURIComponent(classified.target)
  } catch {
    return null
  }
  let target = decoded
  let anchor = null
  const hashIdx = decoded.indexOf('#')
  if (hashIdx !== -1) {
    target = decoded.slice(0, hashIdx)
    anchor = decoded.slice(hashIdx + 1) || null
  }
  return {
    raw,
    target,
    anchor,
    blockId: anchor && anchor.startsWith('^') ? anchor.slice(1) : null,
    alias: label || null,
    kind: 'markdown',
    isEmbed,
    location,
    ...extra,
  }
}

export const extractNoteReferences = (fullMarkdown) => {
  if (typeof fullMarkdown !== 'string' || !fullMarkdown) return []
  const parsedDoc = parseNoteDocument(fullMarkdown)
  const references = []

  // 1. Extract references from frontmatter properties
  if (parsedDoc.valid) {
    for (const prop of parsedDoc.properties) {
      if (prop.type === 'tags') continue
      const values = Array.isArray(prop.value) ? prop.value : [prop.value]
      for (const val of values) {
        if (typeof val === 'string') {
          references.push(
            ...parseInlineLinksFromString(val, 'property', { propertyKey: prop.key, line: 1 })
          )
        }
      }
    }
  }

  // 2. Extract references from Markdown body using CommonMark + GFM + Obsidian AST
  const body = parsedDoc.body
  if (!body) return references

  const tree = ayameMarkdownParser.parse(body)

  // First pass: collect CommonMark LinkReference definitions ([ref]: target)
  const linkRefs = new Map()
  tree.iterate({
    enter(nodeRef) {
      const name = nodeRef.name
      if (
        name === 'Frontmatter' ||
        name === 'FencedCode' ||
        name === 'CodeBlock' ||
        name === 'MathBlock' ||
        name === 'ObsidianCommentBlock'
      ) {
        return false
      }
      if (name === 'LinkReference') {
        const labelNode = getDirectAstChildren(nodeRef.node, 'LinkLabel')[0]
        const urlNode = getDirectAstChildren(nodeRef.node, 'URL')[0]
        if (labelNode && urlNode) {
          const key = normalizeRefKey(body.slice(labelNode.from + 1, labelNode.to - 1))
          if (key && !linkRefs.has(key)) {
            let url = body.slice(urlNode.from, urlNode.to).trim()
            if (url.startsWith('<') && url.endsWith('>')) {
              url = url.slice(1, -1).trim()
            }
            if (url) linkRefs.set(key, url)
          }
        }
        return false
      }
    },
  })

  // Second pass: collect wikilinks, embeds, inline markdown links, and resolved reference links
  tree.iterate({
    enter(nodeRef) {
      const name = nodeRef.name
      if (
        name === 'Frontmatter' ||
        name === 'FencedCode' ||
        name === 'CodeBlock' ||
        name === 'MathBlock' ||
        name === 'ObsidianCommentBlock' ||
        name === 'InlineCode' ||
        name === 'InlineMath' ||
        name === 'ObsidianComment' ||
        name === 'LinkReference'
      ) {
        return false
      }

      if (name === 'Wikilink' || name === 'WikiEmbed') {
        const raw = body.slice(nodeRef.from, nodeRef.to)
        const parsed = parseWikilink(raw)
        if (parsed) {
          references.push({
            raw,
            target: parsed.target || '',
            anchor: parsed.anchor || null,
            blockId: parsed.blockId || null,
            alias: parsed.alias || null,
            kind: 'wikilink',
            isEmbed: Boolean(parsed.isEmbed),
            location: 'body',
            line: computeLineNumberAt(body, nodeRef.from),
          })
        }
        return false
      }

      if (name === 'Link' || name === 'Image') {
        const syntaxNode = nodeRef.node
        const isEmbed = name === 'Image'
        const linkMarks = getDirectAstChildren(syntaxNode, 'LinkMark')
        const openBracket = linkMarks[0]
        const closeBracket = linkMarks.find((m) => body.slice(m.from, m.to) === ']')
        if (!openBracket || !closeBracket) return

        const raw = body.slice(nodeRef.from, nodeRef.to)
        const label = body.slice(openBracket.to, closeBracket.from)
        const urlNode = getDirectAstChildren(syntaxNode, 'URL')[0]
        let destRaw = null

        if (urlNode) {
          destRaw = body.slice(urlNode.from, urlNode.to).trim()
          if (destRaw.startsWith('<') && destRaw.endsWith('>')) {
            destRaw = destRaw.slice(1, -1).trim()
          }
        } else {
          const refLabelNode = getDirectAstChildren(syntaxNode, 'LinkLabel')[0]
          let refKeyRaw = label
          if (refLabelNode) {
            const inner = body.slice(refLabelNode.from + 1, refLabelNode.to - 1)
            if (inner.trim().length > 0) refKeyRaw = inner
          }
          destRaw = linkRefs.get(normalizeRefKey(refKeyRaw)) || null
        }

        if (destRaw) {
          const ref = buildInternalMarkdownRef(raw, isEmbed, label, destRaw, 'body', {
            line: computeLineNumberAt(body, nodeRef.from),
          })
          if (ref) references.push(ref)
        }
        return false
      }
    },
  })

  return references
}
