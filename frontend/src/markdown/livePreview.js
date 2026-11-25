import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { ensureSyntaxTree, syntaxTree } from '@codemirror/language'
import { classifyLinkDestination, parseWikilink, resolveLink } from './links.js'
import { validateTagName } from './properties.js'
import { ayameMarkdownParser } from './parser.js'

export const setLivePreviewContextEffect = StateEffect.define()
export const setCursorActiveEffect = StateEffect.define()

const IMAGE_EXTENSION_RE = /\.(png|jpe?g|webp|gif)$/i

const safeNormalizeRelativePath = (baseDir, rawTarget) => {
  if (typeof rawTarget !== 'string') return null
  let cleaned = rawTarget.trim()
  if (!cleaned || cleaned.includes('\0') || cleaned.includes('\\') || /^https?:\/\//i.test(cleaned)) {
    return null
  }
  try {
    cleaned = decodeURIComponent(cleaned)
  } catch {
    // Keep original if percent-encoding is malformed
  }
  cleaned = cleaned.replace(/^\/+/, '')
  const segments = (baseDir ? `${baseDir}/${cleaned}` : cleaned).split('/')
  const resolved = []
  for (const seg of segments) {
    if (!seg || seg === '.') continue
    if (seg === '..') {
      if (resolved.length === 0) return null
      resolved.pop()
      continue
    }
    resolved.push(seg)
  }
  return resolved.length > 0 ? resolved.join('/') : null
}

const resolveImageTarget = (rawTarget, sourcePath, allFiles) => {
  if (typeof rawTarget !== 'string' || !Array.isArray(allFiles) || allFiles.length === 0) {
    return null
  }
  const trimmed = rawTarget.trim()
  if (!trimmed || !IMAGE_EXTENSION_RE.test(trimmed)) {
    return null
  }

  const normalizedFiles = allFiles
    .map((entry) => (typeof entry === 'string' ? entry : entry?.path))
    .filter((entry) => typeof entry === 'string' && IMAGE_EXTENSION_RE.test(entry))

  if (normalizedFiles.length === 0) return null

  const cleanDirect = trimmed.replace(/^\.\//, '').replace(/^\/+/, '')
  const directExact = normalizedFiles.find((file) => file === cleanDirect)
  if (directExact) return directExact

  const directFold = normalizedFiles.find(
    (file) => file.toLowerCase() === cleanDirect.toLowerCase()
  )
  if (directFold) return directFold

  const sourceDir =
    typeof sourcePath === 'string' && sourcePath.includes('/')
      ? sourcePath.slice(0, sourcePath.lastIndexOf('/'))
      : ''
  const relCandidate = safeNormalizeRelativePath(sourceDir, trimmed)
  if (relCandidate) {
    const relExact = normalizedFiles.find((file) => file === relCandidate)
    if (relExact) return relExact
    const relFold = normalizedFiles.find(
      (file) => file.toLowerCase() === relCandidate.toLowerCase()
    )
    if (relFold) return relFold
  }

  const baseNeedle = cleanDirect.split('/').pop()?.toLowerCase()
  if (!baseNeedle) return null
  const suffixNeedle = `/${cleanDirect.toLowerCase()}`
  const suffixMatch = normalizedFiles.find(
    (file) => file.toLowerCase() === cleanDirect.toLowerCase() || file.toLowerCase().endsWith(suffixNeedle)
  )
  if (suffixMatch) return suffixMatch

  const baseMatches = normalizedFiles
    .filter((file) => (file.split('/').pop() || '').toLowerCase() === baseNeedle)
    .sort((a, b) => a.length - b.length || a.localeCompare(b))
  return baseMatches[0] || null
}

const buildVaultImageMediaUrl = (directory, filePath) =>
  `/vaults/${encodeURIComponent(String(directory ?? ''))}/media?path=${encodeURIComponent(String(filePath ?? ''))}`

const parseImageWidthOption = (value) => {
  if (typeof value !== 'string') return null
  const match = value.trim().match(/^(\d{2,4})(?:x\d{2,4})?$/i)
  if (!match) return null
  const width = Number.parseInt(match[1], 10)
  return width >= 24 && width <= 2400 ? width : null
}

class ImageEmbedWidget extends WidgetType {
  constructor(src, alt, rawTarget, resolvedPath, width = null) {
    super()
    this.src = src
    this.alt = alt
    this.rawTarget = rawTarget
    this.resolvedPath = resolvedPath
    this.width = width
  }

  eq(other) {
    return (
      other instanceof ImageEmbedWidget &&
      other.src === this.src &&
      other.alt === this.alt &&
      other.resolvedPath === this.resolvedPath &&
      other.width === this.width
    )
  }

  toDOM() {
    const wrap = document.createElement('span')
    wrap.className = 'cm-live-image-wrap'
    wrap.setAttribute('data-image-path', this.resolvedPath)
    wrap.setAttribute('data-link-raw', this.rawTarget)

    const img = document.createElement('img')
    img.className = 'cm-live-image-embed'
    img.src = this.src
    img.alt = this.alt || this.resolvedPath.split('/').pop() || 'Image attachment'
    img.loading = 'lazy'
    if (this.width) {
      img.style.maxWidth = `${this.width}px`
    }
    wrap.appendChild(img)
    return wrap
  }

  ignoreEvent() {
    return false
  }
}

const CALLOUT_LABELS = {
  note: 'Note',
  tip: 'Tip',
  hint: 'Hint',
  info: 'Info',
  todo: 'Todo',
  abstract: 'Abstract',
  summary: 'Summary',
  warning: 'Warning',
  caution: 'Caution',
  important: 'Important',
  danger: 'Danger',
  error: 'Error',
  bug: 'Bug',
  success: 'Success',
  check: 'Check',
  done: 'Done',
  question: 'Question',
  quote: 'Quote',
  example: 'Example',
}

const createSvgIcon = (size, paths) => {
  const ns = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(ns, 'svg')
  svg.setAttribute('viewBox', '0 0 16 16')
  svg.setAttribute('width', String(size))
  svg.setAttribute('height', String(size))
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.6')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('aria-hidden', 'true')
  for (const d of paths) {
    const p = document.createElementNS(ns, 'path')
    p.setAttribute('d', d)
    svg.appendChild(p)
  }
  return svg
}

const calloutIconPaths = (kind) => {
  if (kind === 'tip' || kind === 'hint') {
    return ['M8 2.2a3.6 3.6 0 0 0-2.1 6.5c.5.4.8.9.9 1.5h2.4c.1-.6.4-1.1.9-1.5A3.6 3.6 0 0 0 8 2.2Z', 'M6.5 12.2h3', 'M7 14h2']
  }
  if (kind === 'success' || kind === 'check' || kind === 'done') {
    return ['M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M5.5 8.2 7.2 9.9l3.5-3.7']
  }
  if (kind === 'warning' || kind === 'caution' || kind === 'important') {
    return ['M8 2.5 2.3 13h11.4L8 2.5Z', 'M8 6.4v3.4', 'M8 11.7h.01']
  }
  if (kind === 'danger' || kind === 'error' || kind === 'bug') {
    return ['M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M5.8 5.8l4.4 4.4', 'M10.2 5.8l-4.4 4.4']
  }
  if (kind === 'info' || kind === 'todo' || kind === 'abstract' || kind === 'summary') {
    return ['M8 14a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z', 'M8 7.5v3.6', 'M8 5.2h.01']
  }
  return ['M9.8 2.6a.9.9 0 0 1 1.3 0l2.3 2.3a.9.9 0 0 1 0 1.3L6.1 13.5H3.5v-2.6l6.3-8.3Z']
}

class ChecklistMarkerWidget extends WidgetType {
  constructor(stateCharPos, checked) {
    super()
    this.stateCharPos = stateCharPos
    this.checked = Boolean(checked)
  }

  eq(other) {
    return (
      other instanceof ChecklistMarkerWidget &&
      other.stateCharPos === this.stateCharPos &&
      other.checked === this.checked
    )
  }

  toDOM() {
    const marker = document.createElement('span')
    marker.className = 'cm-live-checklist-marker'
    marker.setAttribute('data-checklist-pos', String(this.stateCharPos))
    marker.setAttribute('data-checklist-checked', this.checked ? 'true' : 'false')
    marker.setAttribute('role', 'checkbox')
    marker.setAttribute('aria-checked', this.checked ? 'true' : 'false')

    const box = document.createElement('span')
    box.className = this.checked ? 'cm-live-checkbox-box cm-live-checkbox-box--checked' : 'cm-live-checkbox-box'
    box.setAttribute('aria-hidden', 'true')
    if (this.checked) {
      box.appendChild(createSvgIcon(11, ['M3.2 8.3 6.3 11.4 12.8 4.8']))
    }
    marker.appendChild(box)
    return marker
  }

  ignoreEvent() {
    return false
  }
}

class BulletDotWidget extends WidgetType {
  eq(other) {
    return other instanceof BulletDotWidget
  }

  toDOM() {
    const dot = document.createElement('span')
    dot.className = 'cm-live-list-bullet cm-live-bullet-dot'
    dot.setAttribute('aria-hidden', 'true')
    dot.textContent = '•'
    return dot
  }
}

const VALID_ENTITY_RE = /^&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[a-zA-Z][a-zA-Z0-9]{1,31});$/
let entityDecoderEl = null

const decodeHtmlEntity = (rawEntity) => {
  if (typeof rawEntity !== 'string' || !VALID_ENTITY_RE.test(rawEntity)) return null
  if (rawEntity.startsWith('&#')) {
    const isHex = rawEntity[2] === 'x' || rawEntity[2] === 'X'
    const numStr = rawEntity.slice(isHex ? 3 : 2, -1)
    const codePoint = Number.parseInt(numStr, isHex ? 16 : 10)
    if (!Number.isFinite(codePoint) || codePoint <= 0 || codePoint > 0x10ffff) {
      return '\uFFFD'
    }
    try {
      return String.fromCodePoint(codePoint)
    } catch {
      return '\uFFFD'
    }
  }
  if (typeof document !== 'undefined') {
    if (!entityDecoderEl) {
      entityDecoderEl = document.createElement('textarea')
    }
    entityDecoderEl.innerHTML = rawEntity
    const decoded = entityDecoderEl.value
    return decoded !== rawEntity ? decoded : null
  }
  return null
}

class EntityWidget extends WidgetType {
  constructor(decoded) {
    super()
    this.decoded = decoded
  }

  eq(other) {
    return other instanceof EntityWidget && other.decoded === this.decoded
  }

  toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-live-entity'
    span.textContent = this.decoded
    return span
  }
}

class CalloutBadgeWidget extends WidgetType {
  constructor(calloutType, hasCustomTitle) {
    super()
    this.calloutType = calloutType
    this.hasCustomTitle = Boolean(hasCustomTitle)
  }

  eq(other) {
    return (
      other instanceof CalloutBadgeWidget &&
      other.calloutType === this.calloutType &&
      other.hasCustomTitle === this.hasCustomTitle
    )
  }

  toDOM() {
    const badge = document.createElement('span')
    badge.className = 'cm-live-callout-badge cm-live-callout-widget'
    badge.setAttribute('data-callout-kind', this.calloutType)
    badge.appendChild(createSvgIcon(14, calloutIconPaths(this.calloutType)))
    const label = document.createElement('span')
    label.textContent =
      CALLOUT_LABELS[this.calloutType] ||
      `${this.calloutType.charAt(0).toUpperCase()}${this.calloutType.slice(1)}`
    badge.appendChild(label)
    return badge
  }
}

const rangeIntersectsSelection = (selection, from, to) =>
  selection.ranges.some((range) => range.from <= to && range.to >= from)

const getSyntaxTree = (state) => {
  const docLen = state.doc.length
  const ensured = ensureSyntaxTree(state, docLen, 250)
  if (ensured && ensured.length >= docLen) return ensured
  const current = syntaxTree(state)
  if (current && current.length >= docLen) return current
  return ayameMarkdownParser.parse(state.doc.toString())
}

const getDirectChildren = (syntaxNode, name) => {
  const result = []
  for (let child = syntaxNode.firstChild; child; child = child.nextSibling) {
    if (!name || child.name === name) {
      result.push(child)
    }
  }
  return result
}

const addSyntaxOrHide = (decorations, from, to, showSyntax) => {
  if (from >= to) return
  if (showSyntax) {
    decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(from, to))
  } else {
    decorations.push(Decoration.replace({}).range(from, to))
  }
}

const normalizeReferenceLabel = (raw) =>
  String(raw ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()

const collectLinkReferences = (tree, doc) => {
  const refs = new Map()
  tree.iterate({
    enter(nodeRef) {
      if (
        nodeRef.name === 'Frontmatter' ||
        nodeRef.name === 'FencedCode' ||
        nodeRef.name === 'CodeBlock' ||
        nodeRef.name === 'MathBlock' ||
        nodeRef.name === 'ObsidianCommentBlock'
      ) {
        return false
      }
      if (nodeRef.name === 'LinkReference') {
        const syntaxNode = nodeRef.node
        const labelNode = getDirectChildren(syntaxNode, 'LinkLabel')[0]
        const urlNode = getDirectChildren(syntaxNode, 'URL')[0]
        if (labelNode && urlNode) {
          const rawLabel = doc.sliceString(labelNode.from, labelNode.to)
          const innerLabel = rawLabel.startsWith('[') && rawLabel.endsWith(']')
            ? rawLabel.slice(1, -1)
            : rawLabel
          const key = normalizeReferenceLabel(innerLabel)
          if (key && !refs.has(key)) {
            let url = doc.sliceString(urlNode.from, urlNode.to).trim()
            if (url.startsWith('<') && url.endsWith('>')) {
              url = url.slice(1, -1).trim()
            }
            if (url) {
              refs.set(key, url)
            }
          }
        }
        return false
      }
    },
  })
  return refs
}

const buildLivePreviewDecorations = (state, context, cursorActive) => {
  const decorations = []
  const doc = state.doc
  const selection = state.selection
  const {
    sourcePath = '',
    knownFiles = [],
    aliasesByFile = {},
    indexComplete = true,
    vaultDirectory = '',
    allFiles = [],
  } = context || {}

  const tree = getSyntaxTree(state)
  const linkReferences = collectLinkReferences(tree, doc)
  const rawBlockLines = new Set()
  const calloutLines = new Set()
  const decoratedQuoteLines = new Set()

  const lineHasCursor = (line) =>
    cursorActive && rangeIntersectsSelection(selection, line.from, line.to)

  const rangeHasCursor = (from, to) =>
    cursorActive && rangeIntersectsSelection(selection, from, to)

  tree.iterate({
    enter(nodeRef) {
      const name = nodeRef.name
      const from = nodeRef.from
      const to = nodeRef.to

      // 1. YAML Frontmatter (in source mode)
      if (name === 'Frontmatter') {
        const startLine = doc.lineAt(from).number
        const endLine = doc.lineAt(to).number
        for (let ln = startLine; ln <= endLine; ln++) {
          rawBlockLines.add(ln)
          const line = doc.line(ln)
          decorations.push(Decoration.line({ class: 'cm-live-frontmatter' }).range(line.from))
          if (ln === startLine || ln === endLine) {
            if (line.to > line.from) {
              decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.to))
            }
          }
        }
        return false
      }

      // 2. Fenced Code Blocks
      if (name === 'FencedCode') {
        const syntaxNode = nodeRef.node
        const startLine = doc.lineAt(from)
        const endLine = doc.lineAt(to)
        const marks = getDirectChildren(syntaxNode, 'CodeMark')
        const infoNode = getDirectChildren(syntaxNode, 'CodeInfo')[0]
        const codeLang = infoNode
          ? doc.sliceString(infoNode.from, infoNode.to).trim().split(/\s+/)[0].slice(0, 18)
          : ''
        const hasClosingMark =
          marks.length >= 2 && doc.lineAt(marks[marks.length - 1].from).number === endLine.number && endLine.number > startLine.number

        for (let ln = startLine.number; ln <= endLine.number; ln++) {
          rawBlockLines.add(ln)
          const line = doc.line(ln)
          if (ln === startLine.number) {
            decorations.push(
              Decoration.line({
                class: 'cm-live-codeblock-fence cm-live-codeblock-open',
                attributes: { 'data-code-lang': codeLang || 'code' },
              }).range(line.from)
            )
            if (line.to > line.from) {
              decorations.push(
                Decoration.mark({
                  class: lineHasCursor(line) ? 'cm-live-syntax' : 'cm-live-codeblock-fence-hidden',
                }).range(line.from, line.to)
              )
            }
          } else if (hasClosingMark && ln === endLine.number) {
            decorations.push(
              Decoration.line({ class: 'cm-live-codeblock-fence cm-live-codeblock-close' }).range(line.from)
            )
            if (line.to > line.from) {
              decorations.push(
                Decoration.mark({
                  class: lineHasCursor(line) ? 'cm-live-syntax' : 'cm-live-codeblock-fence-hidden',
                }).range(line.from, line.to)
              )
            }
          } else {
            decorations.push(Decoration.line({ class: 'cm-live-codeblock-line' }).range(line.from))
          }
        }
        return false
      }

      // 3. Indented Code Blocks (CommonMark 4-space code blocks)
      if (name === 'CodeBlock') {
        const startLine = doc.lineAt(from).number
        const endLine = doc.lineAt(to).number
        for (let ln = startLine; ln <= endLine; ln++) {
          rawBlockLines.add(ln)
          decorations.push(Decoration.line({ class: 'cm-live-codeblock-line' }).range(doc.line(ln).from))
        }
        return false
      }

      // 4. Multiline $$ Math Blocks
      if (name === 'MathBlock') {
        const syntaxNode = nodeRef.node
        const marks = getDirectChildren(syntaxNode, 'MathMark')
        const markLineNumbers = new Set(marks.map((m) => doc.lineAt(m.from).number))
        const startLine = doc.lineAt(from).number
        const endLine = doc.lineAt(to).number
        for (let ln = startLine; ln <= endLine; ln++) {
          rawBlockLines.add(ln)
          const line = doc.line(ln)
          decorations.push(Decoration.line({ class: 'cm-live-math-block' }).range(line.from))
          if (line.to > line.from) {
            decorations.push(
              Decoration.mark({
                class: markLineNumbers.has(ln) ? 'cm-live-syntax' : 'cm-live-math',
              }).range(line.from, line.to)
            )
          }
        }
        return false
      }

      // 4b. Multiline Obsidian Comment Blocks (%% ... %%)
      if (name === 'ObsidianCommentBlock') {
        const startLine = doc.lineAt(from).number
        const endLine = doc.lineAt(to).number
        const hasCursor = rangeHasCursor(from, to)
        for (let ln = startLine; ln <= endLine; ln++) {
          rawBlockLines.add(ln)
          const line = doc.line(ln)
          if (!hasCursor) {
            decorations.push(
              Decoration.line({ class: 'cm-live-comment-block-hidden' }).range(line.from)
            )
            if (line.to > line.from) {
              decorations.push(Decoration.replace({}).range(line.from, line.to))
            }
          } else {
            decorations.push(Decoration.line({ class: 'cm-live-comment-block' }).range(line.from))
            if (line.to > line.from) {
              decorations.push(Decoration.mark({ class: 'cm-live-comment' }).range(line.from, line.to))
            }
          }
        }
        return false
      }

      // 4c. Footnote Definitions ([^1]: body)
      if (name === 'FootnoteDefinition') {
        const line = doc.lineAt(from)
        decorations.push(Decoration.line({ class: 'cm-live-footnote-def-line' }).range(line.from))
        return
      }

      if (name === 'FootnoteDefMark') {
        decorations.push(Decoration.mark({ class: 'cm-live-footnote-def' }).range(from, to))
        return false
      }

      // 4d. Link Reference Definitions ([ref]: url "title")
      if (name === 'LinkReference') {
        const line = doc.lineAt(from)
        decorations.push(Decoration.line({ class: 'cm-live-link-def' }).range(line.from))
        const labelNode = getDirectChildren(nodeRef.node, 'LinkLabel')[0]
        if (labelNode) {
          decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(labelNode.from, labelNode.to))
        }
        return false
      }

      // 5. Horizontal Rules (CommonMark thematic breaks — never Setext underlines)
      if (name === 'HorizontalRule') {
        const line = doc.lineAt(from)
        decorations.push(Decoration.line({ class: 'cm-live-hr' }).range(line.from))
        addSyntaxOrHide(decorations, from, to, lineHasCursor(line))
        return false
      }

      // 6. ATX Headings (# .. ######)
      if (name.startsWith('ATXHeading')) {
        const level = Number(name.slice('ATXHeading'.length))
        const syntaxNode = nodeRef.node
        const line = doc.lineAt(from)
        const hasCursor = lineHasCursor(line)
        const marks = getDirectChildren(syntaxNode, 'HeaderMark')
        const openMark = marks[0]
        const closeMark = marks.length > 1 ? marks[marks.length - 1] : null

        decorations.push(
          Decoration.line({ class: `cm-live-heading cm-live-h${level}` }).range(line.from)
        )

        let contentStart = from
        if (openMark) {
          let afterOpen = openMark.to
          while (afterOpen < line.to) {
            const ch = doc.sliceString(afterOpen, afterOpen + 1)
            if (ch === ' ' || ch === '\t') afterOpen++
            else break
          }
          addSyntaxOrHide(decorations, openMark.from, afterOpen, hasCursor)
          contentStart = afterOpen
        }

        let contentEnd = to
        if (closeMark && closeMark.from >= contentStart) {
          let beforeClose = closeMark.from
          while (beforeClose > contentStart) {
            const ch = doc.sliceString(beforeClose - 1, beforeClose)
            if (ch === ' ' || ch === '\t') beforeClose--
            else break
          }
          addSyntaxOrHide(decorations, beforeClose, closeMark.to, hasCursor)
          contentEnd = beforeClose
        }

        if (contentStart < contentEnd) {
          decorations.push(
            Decoration.mark({ class: `cm-live-heading-text cm-live-h${level}-text` }).range(
              contentStart,
              contentEnd
            )
          )
        }
        return
      }

      // 7. Setext Headings (Heading\n=== and Heading\n---)
      if (name === 'SetextHeading1' || name === 'SetextHeading2') {
        const level = name === 'SetextHeading1' ? 1 : 2
        const syntaxNode = nodeRef.node
        const headerMark = getDirectChildren(syntaxNode, 'HeaderMark')[0]
        const hasCursor = rangeHasCursor(from, to)
        const startLineNum = doc.lineAt(from).number
        const markLine = headerMark ? doc.lineAt(headerMark.from) : doc.lineAt(to)

        for (let ln = startLineNum; ln < markLine.number; ln++) {
          const line = doc.line(ln)
          decorations.push(
            Decoration.line({
              class: `cm-live-heading cm-live-h${level} cm-live-setext-heading`,
            }).range(line.from)
          )
          if (line.from < line.to) {
            decorations.push(
              Decoration.mark({ class: `cm-live-heading-text cm-live-h${level}-text` }).range(
                line.from,
                line.to
              )
            )
          }
        }

        if (headerMark) {
          decorations.push(
            Decoration.line({
              class: hasCursor ? 'cm-live-setext-underline' : 'cm-live-setext-underline-hidden',
            }).range(markLine.from)
          )
          addSyntaxOrHide(decorations, headerMark.from, headerMark.to, hasCursor)
        }
        return
      }

      // 8. Blockquotes & Obsidian Callouts
      if (name === 'Blockquote') {
        const startLine = doc.lineAt(from)
        const endLine = doc.lineAt(to)
        const calloutMatch = startLine.text.match(/^(\s*(?:>\s*)+)(\[!([a-zA-Z]+)\][+-]?)(\s*.*)$/)

        if (calloutMatch && !calloutLines.has(startLine.number)) {
          const calloutType = calloutMatch[3].toLowerCase()
          const hasCustomTitle = Boolean(calloutMatch[4]?.trim())
          const tagFrom = startLine.from + calloutMatch[1].length
          const tagTo = tagFrom + calloutMatch[2].length

          for (let ln = startLine.number; ln <= endLine.number; ln++) {
            calloutLines.add(ln)
            decoratedQuoteLines.add(ln)
            const line = doc.line(ln)
            const isHeader = ln === startLine.number
            const isEnd = ln === endLine.number
            const classes = [
              'cm-live-blockquote',
              'cm-live-callout',
              `cm-live-callout--${calloutType}`,
              isHeader ? 'cm-live-callout-header' : '',
              isEnd ? 'cm-live-callout-end' : '',
            ]
              .filter(Boolean)
              .join(' ')

            decorations.push(
              Decoration.line({
                class: classes,
                attributes: isHeader ? { 'data-callout-type': calloutType } : undefined,
              }).range(line.from)
            )
          }

          if (!lineHasCursor(startLine)) {
            decorations.push(
              Decoration.replace({
                widget: new CalloutBadgeWidget(calloutType, hasCustomTitle),
              }).range(tagFrom, tagTo)
            )
          } else {
            decorations.push(
              Decoration.mark({ class: 'cm-live-callout-badge' }).range(tagFrom, tagTo)
            )
          }
        } else {
          for (let ln = startLine.number; ln <= endLine.number; ln++) {
            if (!decoratedQuoteLines.has(ln)) {
              decoratedQuoteLines.add(ln)
              decorations.push(Decoration.line({ class: 'cm-live-blockquote' }).range(doc.line(ln).from))
            }
          }
        }
        return
      }

      if (name === 'QuoteMark') {
        const line = doc.lineAt(from)
        let markTo = to
        if (markTo < line.to && doc.sliceString(markTo, markTo + 1) === ' ') {
          markTo++
        }
        addSyntaxOrHide(decorations, from, markTo, lineHasCursor(line))
        return false
      }

      // 9. Lists & GFM Task Lists (Checklists)
      if (name === 'ListItem') {
        const syntaxNode = nodeRef.node
        const listMark = getDirectChildren(syntaxNode, 'ListMark')[0]
        if (!listMark) return

        const line = doc.lineAt(listMark.from)
        const hasCursor = lineHasCursor(line)
        const markText = doc.sliceString(listMark.from, listMark.to)
        const isUnordered = markText === '-' || markText === '*' || markText === '+'

        let afterListMark = listMark.to
        while (afterListMark < line.to) {
          const ch = doc.sliceString(afterListMark, afterListMark + 1)
          if (ch === ' ' || ch === '\t') afterListMark++
          else break
        }

        const taskNode = getDirectChildren(syntaxNode, 'Task')[0]
        const taskMarker = taskNode ? getDirectChildren(taskNode, 'TaskMarker')[0] : null

        if (taskMarker) {
          const stateCharPos = taskMarker.from + 1
          const stateChar = doc.sliceString(stateCharPos, stateCharPos + 1)
          const checked = stateChar.toLowerCase() === 'x'
          let prefixEnd = taskMarker.to
          while (prefixEnd < line.to) {
            const ch = doc.sliceString(prefixEnd, prefixEnd + 1)
            if (ch === ' ' || ch === '\t') prefixEnd++
            else break
          }

          decorations.push(
            Decoration.line({
              class: `cm-live-list-item ${isUnordered ? '' : 'cm-live-ol-item '}cm-live-checklist-item${checked ? ' cm-live-checklist-checked' : ''}`,
            }).range(line.from)
          )

          if (!isUnordered) {
            decorations.push(
              Decoration.mark({ class: 'cm-live-list-number' }).range(listMark.from, afterListMark)
            )
          }

          const widgetFrom = isUnordered ? listMark.from : taskMarker.from
          if (!hasCursor) {
            decorations.push(
              Decoration.replace({
                widget: new ChecklistMarkerWidget(stateCharPos, checked),
              }).range(widgetFrom, prefixEnd)
            )
          } else {
            decorations.push(
              Decoration.mark({
                class: 'cm-live-checklist-marker',
                attributes: {
                  'data-checklist-pos': String(stateCharPos),
                  'data-checklist-checked': checked ? 'true' : 'false',
                  role: 'checkbox',
                  'aria-checked': checked ? 'true' : 'false',
                },
              }).range(widgetFrom, prefixEnd)
            )
          }
          if (prefixEnd < line.to) {
            decorations.push(
              Decoration.mark({ class: 'cm-live-checklist-text' }).range(prefixEnd, line.to)
            )
          }
        } else if (isUnordered) {
          decorations.push(
            Decoration.line({ class: 'cm-live-list-item cm-live-ul-item' }).range(line.from)
          )
          if (!hasCursor) {
            decorations.push(
              Decoration.replace({ widget: new BulletDotWidget() }).range(listMark.from, afterListMark)
            )
          } else {
            decorations.push(
              Decoration.mark({ class: 'cm-live-list-bullet' }).range(listMark.from, afterListMark)
            )
          }
        } else {
          decorations.push(
            Decoration.line({ class: 'cm-live-list-item cm-live-ol-item' }).range(line.from)
          )
          decorations.push(
            Decoration.mark({ class: 'cm-live-list-number' }).range(listMark.from, afterListMark)
          )
        }
        return
      }

      // 10. GFM Tables
      if (name === 'TableHeader') {
        decorations.push(
          Decoration.line({ class: 'cm-live-table-row cm-live-table-header' }).range(doc.lineAt(from).from)
        )
        return
      }

      if (name === 'TableRow') {
        decorations.push(
          Decoration.line({ class: 'cm-live-table-row' }).range(doc.lineAt(from).from)
        )
        return
      }

      if (name === 'TableDelimiter') {
        const parentName = nodeRef.node.parent?.name
        if (parentName === 'Table') {
          const line = doc.lineAt(from)
          decorations.push(
            Decoration.line({ class: 'cm-live-table-row cm-live-table-delimiter' }).range(line.from)
          )
          const text = line.text
          for (let i = 0; i < text.length; i++) {
            if (text[i] === '|') {
              decorations.push(
                Decoration.mark({ class: 'cm-live-table-pipe' }).range(line.from + i, line.from + i + 1)
              )
            }
          }
        } else {
          decorations.push(Decoration.mark({ class: 'cm-live-table-pipe' }).range(from, to))
        }
        return false
      }

      // 11. Inline Formatting (StrongEmphasis, Emphasis, Strikethrough, ObsidianHighlight)
      if (
        name === 'StrongEmphasis' ||
        name === 'Emphasis' ||
        name === 'Strikethrough' ||
        name === 'ObsidianHighlight'
      ) {
        const syntaxNode = nodeRef.node
        const markName =
          name === 'Strikethrough'
            ? 'StrikethroughMark'
            : name === 'ObsidianHighlight'
              ? 'HighlightMark'
              : 'EmphasisMark'
        const marks = getDirectChildren(syntaxNode, markName)
        if (marks.length < 2) return

        const openMark = marks[0]
        const closeMark = marks[marks.length - 1]
        const innerFrom = openMark.to
        const innerTo = closeMark.from
        if (innerFrom >= innerTo) return

        const hasCursor = rangeHasCursor(from, to)
        const styleClass =
          name === 'StrongEmphasis'
            ? 'cm-live-bold'
            : name === 'Emphasis'
              ? 'cm-live-italic'
              : name === 'ObsidianHighlight'
                ? 'cm-live-highlight'
                : 'cm-live-strikethrough'

        addSyntaxOrHide(decorations, openMark.from, openMark.to, hasCursor)
        decorations.push(Decoration.mark({ class: styleClass }).range(innerFrom, innerTo))
        addSyntaxOrHide(decorations, closeMark.from, closeMark.to, hasCursor)
        return
      }

      // 12. Inline Code (single and multi-backtick spans)
      if (name === 'InlineCode') {
        const syntaxNode = nodeRef.node
        const marks = getDirectChildren(syntaxNode, 'CodeMark')
        if (marks.length < 2) return false
        const openMark = marks[0]
        const closeMark = marks[marks.length - 1]
        const innerFrom = openMark.to
        const innerTo = closeMark.from
        if (innerFrom >= innerTo) return false

        const hasCursor = rangeHasCursor(from, to)
        addSyntaxOrHide(decorations, openMark.from, openMark.to, hasCursor)
        decorations.push(Decoration.mark({ class: 'cm-live-inline-code' }).range(innerFrom, innerTo))
        addSyntaxOrHide(decorations, closeMark.from, closeMark.to, hasCursor)
        return false
      }

      // 13. Backslash Escapes (\*, \#, \[, \\, etc.)
      if (name === 'Escape') {
        const hasCursor = rangeHasCursor(from, to)
        addSyntaxOrHide(decorations, from, from + 1, hasCursor)
        return false
      }

      // 13b. CommonMark HTML5 Entities & Numeric Character References (&mdash;, &copy;, &#x2014;)
      if (name === 'Entity') {
        const rawEntity = doc.sliceString(from, to)
        const decoded = decodeHtmlEntity(rawEntity)
        if (decoded !== null) {
          const hasCursor = rangeHasCursor(from, to)
          if (!hasCursor) {
            decorations.push(
              Decoration.replace({ widget: new EntityWidget(decoded) }).range(from, to)
            )
          } else {
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(from, to))
          }
        }
        return false
      }

      // 14. Obsidian Comments (%%...%%)
      if (name === 'ObsidianComment') {
        const hasCursor = rangeHasCursor(from, to)
        if (!hasCursor) {
          decorations.push(Decoration.replace({}).range(from, to))
        } else {
          decorations.push(Decoration.mark({ class: 'cm-live-comment' }).range(from, to))
        }
        return false
      }

      // 15. Inline Math ($...$ and $$...$$)
      if (name === 'InlineMath') {
        const isDouble = doc.sliceString(from, from + 2) === '$$'
        const d = isDouble ? 2 : 1
        const innerFrom = from + d
        const innerTo = to - d
        if (innerFrom < innerTo) {
          const hasCursor = rangeHasCursor(from, to)
          addSyntaxOrHide(decorations, from, innerFrom, hasCursor)
          decorations.push(Decoration.mark({ class: 'cm-live-math' }).range(innerFrom, innerTo))
          addSyntaxOrHide(decorations, innerTo, to, hasCursor)
        }
        return false
      }

      // 16. Footnote References ([^1])
      if (name === 'FootnoteRef') {
        decorations.push(Decoration.mark({ class: 'cm-live-footnote' }).range(from, to))
        return false
      }

      // 17. Inline Tags (#tag/subtag)
      if (name === 'InlineTag') {
        const tagName = validateTagName(doc.sliceString(from + 1, to))
        if (tagName) {
          decorations.push(
            Decoration.mark({
              class: 'cm-live-tag',
              attributes: { 'data-tag-name': tagName },
            }).range(from, to)
          )
        }
        return false
      }

      // 18. Wikilinks & Wiki Embeds ([[...]] and ![[...]])
      if (name === 'Wikilink' || name === 'WikiEmbed') {
        const isEmbed = name === 'WikiEmbed'
        const raw = doc.sliceString(from, to)
        const parsed = parseWikilink(raw)
        if (!parsed) return false

        const hasCursor = rangeHasCursor(from, to)

        if (isEmbed && !hasCursor && vaultDirectory && parsed.target) {
          const resolvedImagePath = resolveImageTarget(parsed.target, sourcePath, allFiles)
          if (resolvedImagePath) {
            const width = parseImageWidthOption(parsed.alias)
            const altText = width ? '' : parsed.alias || parsed.target
            decorations.push(
              Decoration.replace({
                widget: new ImageEmbedWidget(
                  buildVaultImageMediaUrl(vaultDirectory, resolvedImagePath),
                  altText,
                  raw,
                  resolvedImagePath,
                  width
                ),
              }).range(from, to)
            )
            return false
          }
        }

        const resolution = resolveLink({
          sourcePath,
          linkTarget: raw,
          knownFiles,
          aliasesByFile,
          indexComplete,
          kind: 'wikilink',
        })
        const statusClass = `cm-live-link--${resolution.type}`
        const embedClass = isEmbed ? ' cm-live-embed' : ''
        const attrs = {
          'data-link-kind': 'wikilink',
          'data-link-raw': raw,
          'data-link-status': resolution.type,
          'data-editing': hasCursor ? 'true' : 'false',
        }
        if (isEmbed) attrs['data-link-embed'] = 'true'
        if (resolution.path) attrs['data-link-resolved-path'] = resolution.path
        if (resolution.anchor) attrs['data-link-anchor'] = resolution.anchor

        const prefixLen = isEmbed ? 3 : 2
        const innerText = raw.slice(prefixLen, -2)
        const pipeIdx = innerText.indexOf('|')

        if (!hasCursor) {
          if (pipeIdx !== -1 && from + prefixLen + pipeIdx + 1 < to - 2) {
            const aliasFrom = from + prefixLen + pipeIdx + 1
            const aliasTo = to - 2
            decorations.push(Decoration.replace({}).range(from, aliasFrom))
            decorations.push(
              Decoration.mark({
                class: `cm-live-link cm-live-wikilink ${statusClass}${embedClass}`,
                attributes: attrs,
              }).range(aliasFrom, aliasTo)
            )
            decorations.push(Decoration.replace({}).range(aliasTo, to))
          } else {
            const targetFrom = from + prefixLen
            const targetTo = to - 2
            decorations.push(Decoration.replace({}).range(from, targetFrom))
            decorations.push(
              Decoration.mark({
                class: `cm-live-link cm-live-wikilink ${statusClass}${embedClass}`,
                attributes: attrs,
              }).range(targetFrom, targetTo)
            )
            decorations.push(Decoration.replace({}).range(targetTo, to))
          }
        } else {
          decorations.push(
            Decoration.mark({
              class: `cm-live-link cm-live-wikilink ${statusClass}${embedClass}`,
              attributes: attrs,
            }).range(from, to)
          )
        }
        return false
      }

      // 19. Standard Markdown Inline & Reference Links/Images ([label](dest), [label][ref], [ref][], [ref])
      if (name === 'Link' || name === 'Image') {
        const syntaxNode = nodeRef.node
        const isImage = name === 'Image'
        const linkMarks = getDirectChildren(syntaxNode, 'LinkMark')
        const openBracket = linkMarks[0]
        const closeBracket = linkMarks.find((m) => doc.sliceString(m.from, m.to) === ']')
        if (!openBracket || !closeBracket) return

        const raw = doc.sliceString(from, to)
        const labelFrom = openBracket.to
        const labelTo = closeBracket.from
        const label = doc.sliceString(labelFrom, labelTo)

        const urlNode = getDirectChildren(syntaxNode, 'URL')[0]
        let rawDest = null

        if (urlNode) {
          rawDest = doc.sliceString(urlNode.from, urlNode.to).trim()
          if (rawDest.startsWith('<') && rawDest.endsWith('>')) {
            rawDest = rawDest.slice(1, -1).trim()
          }
        } else {
          // Reference-style link/image: [label][ref], [ref][], or shortcut [ref]
          const refLabelNode = getDirectChildren(syntaxNode, 'LinkLabel')[0]
          let refKeyRaw = label
          if (refLabelNode) {
            const inner = doc.sliceString(refLabelNode.from, refLabelNode.to).slice(1, -1)
            if (inner.trim().length > 0) {
              refKeyRaw = inner
            }
          }
          const resolvedRefUrl = linkReferences.get(normalizeReferenceLabel(refKeyRaw))
          if (!resolvedRefUrl) {
            // Unresolved shortcut/reference brackets stay literal text per CommonMark
            return
          }
          rawDest = resolvedRefUrl
        }

        const hasCursor = rangeHasCursor(from, to)

        if (isImage && !hasCursor && vaultDirectory) {
          const resolvedImagePath = resolveImageTarget(rawDest, sourcePath, allFiles)
          if (resolvedImagePath) {
            const width = parseImageWidthOption(label)
            const altText = width ? '' : label
            decorations.push(
              Decoration.replace({
                widget: new ImageEmbedWidget(
                  buildVaultImageMediaUrl(vaultDirectory, resolvedImagePath),
                  altText,
                  raw,
                  resolvedImagePath,
                  width
                ),
              }).range(from, to)
            )
            return false
          }
        }

        const destClass = classifyLinkDestination(rawDest)
        let statusType = 'invalid'
        let resolvedPath = null
        let anchor = null
        let externalHref = null

        if (destClass.type === 'external') {
          statusType = 'external'
          externalHref = destClass.href
        } else if (destClass.type === 'internal') {
          const resolution = resolveLink({
            sourcePath,
            linkTarget: rawDest,
            knownFiles,
            aliasesByFile,
            indexComplete,
            kind: 'markdown',
          })
          statusType = resolution.type
          resolvedPath = resolution.path || null
          anchor = resolution.anchor || null
        }

        const statusClass = `cm-live-link--${statusType}`
        const attrs = {
          'data-link-kind': 'markdown',
          'data-link-raw': rawDest,
          'data-link-status': statusType,
          'data-editing': hasCursor ? 'true' : 'false',
        }
        if (resolvedPath) attrs['data-link-resolved-path'] = resolvedPath
        if (anchor) attrs['data-link-anchor'] = anchor
        if (externalHref) attrs['data-link-href'] = externalHref

        if (!hasCursor && labelFrom < labelTo && !isImage) {
          decorations.push(Decoration.replace({}).range(from, labelFrom))
          decorations.push(
            Decoration.mark({
              class: `cm-live-link cm-live-markdown-link ${statusClass}`,
              attributes: attrs,
            }).range(labelFrom, labelTo)
          )
          decorations.push(Decoration.replace({}).range(labelTo, to))
          // Descend into label so nested formatting like [**bold**](url) works
          return
        }

        decorations.push(
          Decoration.mark({
            class: `cm-live-link cm-live-markdown-link ${statusClass}`,
            attributes: attrs,
          }).range(from, to)
        )
        return false
      }

      // 20. CommonMark & GFM Autolinks (<https://...>, bare https://..., or GFM www.example.com)
      if (name === 'Autolink' || (name === 'URL' && nodeRef.node.parent?.name !== 'Link' && nodeRef.node.parent?.name !== 'Image' && nodeRef.node.parent?.name !== 'Autolink' && nodeRef.node.parent?.name !== 'LinkReference')) {
        const raw = doc.sliceString(from, to)
        const isAngle = raw.startsWith('<') && raw.endsWith('>')
        const innerFrom = isAngle ? from + 1 : from
        const innerTo = isAngle ? to - 1 : to
        const hrefText = doc.sliceString(innerFrom, innerTo)
        const normalizedCandidate = /^www\./i.test(hrefText) ? `https://${hrefText}` : hrefText
        const classified = classifyLinkDestination(normalizedCandidate)
        if (classified.type !== 'external') return false

        const hasCursor = rangeHasCursor(from, to)
        const attrs = {
          'data-link-kind': 'markdown',
          'data-link-raw': classified.href,
          'data-link-status': 'external',
          'data-link-href': classified.href,
          'data-editing': hasCursor ? 'true' : 'false',
        }

        if (isAngle && !hasCursor) {
          decorations.push(Decoration.replace({}).range(from, innerFrom))
          decorations.push(
            Decoration.mark({
              class: 'cm-live-link cm-live-markdown-link cm-live-link--external',
              attributes: attrs,
            }).range(innerFrom, innerTo)
          )
          decorations.push(Decoration.replace({}).range(innerTo, to))
        } else {
          decorations.push(
            Decoration.mark({
              class: 'cm-live-link cm-live-markdown-link cm-live-link--external',
              attributes: attrs,
            }).range(from, to)
          )
        }
        return false
      }
    },
  })

  // 21. Obsidian Block IDs at end of non-code lines: ^block-id
  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    if (rawBlockLines.has(lineNum)) continue
    const line = doc.line(lineNum)
    const blockIdMatch = line.text.match(/(?:^|\s)(\^[a-zA-Z0-9-]+)\s*$/)
    if (blockIdMatch) {
      const idStr = blockIdMatch[1]
      const idx = line.text.lastIndexOf(idStr)
      if (idx >= 0) {
        const blockFrom = line.from + idx
        const blockTo = blockFrom + idStr.length
        decorations.push(
          Decoration.mark({
            class: 'cm-live-block-id',
            attributes: { 'data-block-id': idStr.slice(1) },
          }).range(blockFrom, blockTo)
        )
      }
    }
  }

  return Decoration.set(decorations, true)
}

export const createLivePreviewExtension = (initialContext = {}) => {
  const field = StateField.define({
    create(state) {
      const context = { ...initialContext }
      const cursorActive = Boolean(initialContext.cursorActive)
      return {
        context,
        cursorActive,
        decorations: buildLivePreviewDecorations(state, context, cursorActive),
      }
    },
    update(value, tr) {
      let { context, cursorActive } = value
      let changed = tr.docChanged || tr.selection !== undefined

      if (tr.docChanged || tr.selection !== undefined) {
        cursorActive = true
      }

      for (const effect of tr.effects) {
        if (effect.is(setLivePreviewContextEffect)) {
          context = { ...context, ...effect.value }
          changed = true
        }
        if (effect.is(setCursorActiveEffect)) {
          cursorActive = Boolean(effect.value)
          changed = true
        }
      }

      if (!changed) return value

      return {
        context,
        cursorActive,
        decorations: buildLivePreviewDecorations(tr.state, context, cursorActive),
      }
    },
    provide: (f) => EditorView.decorations.from(f, (val) => val.decorations),
  })

  return field
}
