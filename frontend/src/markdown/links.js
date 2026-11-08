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
  let inner = raw
  if (inner.startsWith('[[') && inner.endsWith(']]')) {
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

  const defaultDisplay = target
    ? (anchor ? `${target}#${anchor}` : target)
    : `#${anchor}`

  return {
    target,
    alias,
    anchor,
    displayText: alias || defaultDisplay,
  }
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
    return { ...result, anchor }
  }
  return result
}

const matchExactOrExtensions = (candidateWithoutOrWithExt, validFilesSet, validFilesList) => {
  const ext = getExtension(candidateWithoutOrWithExt)
  if (ext !== '') {
    if (!SUPPORTED_MARKDOWN_RE.test(ext)) {
      return { type: 'invalid' }
    }
    if (validFilesSet.has(candidateWithoutOrWithExt)) {
      return { type: 'resolved', path: candidateWithoutOrWithExt }
    }
    return { type: 'missing' }
  }

  const mdCandidate = `${candidateWithoutOrWithExt}.md`
  const markdownCandidate = `${candidateWithoutOrWithExt}.markdown`
  const matches = validFilesList.filter((f) => f === mdCandidate || f === markdownCandidate).sort()
  if (matches.length === 1) {
    return { type: 'resolved', path: matches[0] }
  }
  if (matches.length > 1) {
    return { type: 'ambiguous', candidates: matches }
  }
  return { type: 'missing' }
}

export const resolveLink = ({ sourcePath = '', linkTarget, knownFiles = [], kind } = {}) => {
  if (typeof linkTarget !== 'string' || typeof sourcePath !== 'string') {
    return { type: 'invalid' }
  }

  const trimmed = linkTarget.trim()
  if (trimmed.length === 0 || trimmed.includes('\0') || trimmed.includes('\\')) {
    return { type: 'invalid' }
  }

  const validFilesList = Array.isArray(knownFiles)
    ? [...new Set(knownFiles.filter(isSupportedMarkdownPath))]
    : []
  const validFilesSet = new Set(validFilesList)

  // Determine whether this is a wikilink or markdown link
  let resolvedKind = kind
  let rawTarget = trimmed

  if (trimmed.startsWith('[[') && trimmed.endsWith(']]')) {
    resolvedKind = 'wikilink'
  } else if (/^\[([^\]]*)\]\(([\s\S]+)\)$/.test(trimmed)) {
    const match = trimmed.match(/^\[([^\]]*)\]\(([\s\S]+)\)$/)
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
    // Same-note heading link: [[#Introdução]]
    if (!target && anchor) {
      if (!isSupportedMarkdownPath(sourcePath)) return { type: 'invalid' }
      return { type: 'resolved', path: sourcePath, anchor }
    }

    if (
      target.includes('\\') ||
      target.startsWith('/') ||
      /^[a-zA-Z]:/.test(target) ||
      SCHEME_RE.test(target)
    ) {
      return { type: 'invalid' }
    }

    // Wikilinks with explicit path start from the vault root; dot segments are invalid
    if (target.includes('/')) {
      const normalized = normalizeRelativeSegments('', target, false)
      if (!normalized) return { type: 'invalid' }
      return attachAnchor(matchExactOrExtensions(normalized, validFilesSet, validFilesList), anchor)
    }

    // Bare wikilink without path: reject '.' and '..'
    if (target === '.' || target === '..') return { type: 'invalid' }
    const ext = getExtension(target)
    if (ext !== '' && !SUPPORTED_MARKDOWN_RE.test(ext)) {
      return { type: 'invalid' }
    }

    // 1. Search current directory first
    const sourceDir = dirnameOf(sourcePath)
    const localPrefix = sourceDir ? `${sourceDir}/${target}` : target
    const localResult = matchExactOrExtensions(localPrefix, validFilesSet, validFilesList)
    if (localResult.type === 'resolved' || localResult.type === 'ambiguous' || localResult.type === 'invalid') {
      return attachAnchor(localResult, anchor)
    }

    // 2. Search across entire vault
    const matches = validFilesList.filter((filePath) => {
      const base = basenameOf(filePath)
      if (ext !== '') {
        return base === target
      }
      return base === `${target}.md` || base === `${target}.markdown`
    }).sort()

    if (matches.length === 1) {
      return attachAnchor({ type: 'resolved', path: matches[0] }, anchor)
    }
    if (matches.length > 1) {
      return { type: 'ambiguous', candidates: matches }
    }
    return { type: 'missing' }
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
    return { type: 'resolved', path: sourcePath, anchor }
  }

  const sourceDir = dirnameOf(sourcePath)
  const normalized = normalizeRelativeSegments(sourceDir, targetPart, true)
  if (!normalized) {
    return { type: 'invalid' }
  }

  // If kind wasn't explicitly specified and there are no relative dot segments,
  // allow wikilink-style fallback when not found locally.
  const localMatch = matchExactOrExtensions(normalized, validFilesSet, validFilesList)
  if (localMatch.type === 'resolved' || localMatch.type === 'ambiguous' || localMatch.type === 'invalid') {
    return attachAnchor(localMatch, anchor)
  }

  if (!resolvedKind && !targetPart.startsWith('./') && !targetPart.startsWith('../')) {
    return resolveLink({
      sourcePath,
      linkTarget: anchor ? `[[${targetPart}#${anchor}]]` : `[[${targetPart}]]`,
      knownFiles,
      kind: 'wikilink',
    })
  }

  return localMatch
}

const slugifyHeading = (text) =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-')

export const findHeadingOffset = (docText, anchor) => {
  if (typeof docText !== 'string' || typeof anchor !== 'string' || !anchor.trim()) {
    return null
  }

  const targetRaw = anchor.trim()
  const targetLower = targetRaw.toLowerCase()
  const targetSlug = slugifyHeading(targetRaw)

  const lines = docText.split('\n')
  let offset = 0
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const match = line.match(/^(#{1,6})\s+(.+?)\s*$/)
    if (match) {
      const headingText = match[2].replace(/\s+#+\s*$/, '').trim()
      if (
        headingText === targetRaw ||
        headingText.toLowerCase() === targetLower ||
        slugifyHeading(headingText) === targetSlug
      ) {
        return {
          line: i + 1,
          from: offset,
        }
      }
    }
    offset += line.length + 1
  }

  return null
}
