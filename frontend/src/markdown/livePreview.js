import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView, WidgetType } from '@codemirror/view'
import { classifyLinkDestination, parseWikilink, resolveLink } from './links.js'
import { validateTagName } from './properties.js'

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

const collectInlineTokens = (lineText, startOffset) => {
  const tokens = []
  const slice = lineText.slice(startOffset)
  const tokenRegex =
    /(`[^`\n]+`)|(%%[^%\n]+%%)|(!?\[\[[^\]]+\]\])|(!?\[[^\]]*\]\([^)\n]+\))|(==)(?=\S)([^\n]+?\S|\S)\5|(\*\*|__)(?=\S)([^\n]+?\S|\S)\7|(~~)(?=\S)([^\n]+?\S|\S)\9|(\*|_)(?=\S)([^*\n_]+?\S|\S)\11|(\$\$[^$\n]+\$\$|\$(?=\S)[^$\n]+?\S\$|\$(?=\S)\S\$)|(\[\^[^\]]+\])|((?:^|(?<=\s))#[\p{L}\p{N}_\-/]+)/gu

  let match
  while ((match = tokenRegex.exec(slice)) !== null) {
    const from = startOffset + match.index
    const raw = match[0]
    const to = from + raw.length

    if (match[1]) {
      tokens.push({ type: 'code', from, to, raw })
    } else if (match[2]) {
      tokens.push({ type: 'comment', from, to, raw, delimLen: 2 })
    } else if (match[3]) {
      tokens.push({
        type: raw.startsWith('!') ? 'embed' : 'wikilink',
        from,
        to,
        raw,
      })
    } else if (match[4]) {
      tokens.push({
        type: raw.startsWith('!') ? 'image' : 'mdlink',
        from,
        to,
        raw,
      })
    } else if (match[5]) {
      tokens.push({
        type: 'highlight',
        from,
        to,
        delimLen: 2,
      })
    } else if (match[7]) {
      tokens.push({
        type: 'bold',
        from,
        to,
        delimLen: match[7].length,
      })
    } else if (match[9]) {
      tokens.push({
        type: 'strikethrough',
        from,
        to,
        delimLen: 2,
      })
    } else if (match[11]) {
      tokens.push({
        type: 'italic',
        from,
        to,
        delimLen: 1,
      })
    } else if (match[13]) {
      tokens.push({
        type: 'math',
        from,
        to,
        raw,
        delimLen: raw.startsWith('$$') ? 2 : 1,
      })
    } else if (match[14]) {
      tokens.push({
        type: 'footnote',
        from,
        to,
        raw,
      })
    } else if (match[15]) {
      const tagCandidate = validateTagName(raw.slice(1))
      if (tagCandidate) {
        tokens.push({
          type: 'tag',
          from,
          to,
          raw,
          tagName: tagCandidate,
        })
      }
    }
  }

  return tokens
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

  let inCodeBlock = false
  let codeFenceChar = ''
  let inMathBlock = false
  let activeCalloutType = null

  for (let lineNum = 1; lineNum <= doc.lines; lineNum++) {
    const line = doc.line(lineNum)
    const text = line.text
    const lineHasCursor = cursorActive && rangeIntersectsSelection(selection, line.from, line.to)

    // 1. Check fenced code blocks
    const fenceMatch = text.match(/^(\s*)(`{3,}|~{3,})(.*)$/)
    if (fenceMatch) {
      const fenceMarker = fenceMatch[2][0]
      if (!inCodeBlock) {
        inCodeBlock = true
        codeFenceChar = fenceMarker
        const codeLang = (fenceMatch[3] || '').trim().split(/\s+/)[0].slice(0, 18)
        decorations.push(
          Decoration.line({
            class: 'cm-live-codeblock-fence cm-live-codeblock-open',
            attributes: { 'data-code-lang': codeLang || 'code' },
          }).range(line.from)
        )
        if (!lineHasCursor && line.to > line.from) {
          decorations.push(
            Decoration.mark({ class: 'cm-live-codeblock-fence-hidden' }).range(line.from, line.to)
          )
        } else if (line.to > line.from) {
          decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.to))
        }
        continue
      } else if (fenceMarker === codeFenceChar) {
        inCodeBlock = false
        codeFenceChar = ''
        decorations.push(
          Decoration.line({ class: 'cm-live-codeblock-fence cm-live-codeblock-close' }).range(line.from)
        )
        if (!lineHasCursor && line.to > line.from) {
          decorations.push(
            Decoration.mark({ class: 'cm-live-codeblock-fence-hidden' }).range(line.from, line.to)
          )
        } else if (line.to > line.from) {
          decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.to))
        }
        continue
      }
    }

    if (inCodeBlock) {
      decorations.push(Decoration.line({ class: 'cm-live-codeblock-line' }).range(line.from))
      continue
    }

    // 1b. Multiline $$ math block
    if (/^\s*\$\$\s*$/.test(text)) {
      inMathBlock = !inMathBlock
      decorations.push(Decoration.line({ class: 'cm-live-math-block' }).range(line.from))
      decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.to))
      continue
    }
    if (inMathBlock) {
      decorations.push(Decoration.line({ class: 'cm-live-math-block' }).range(line.from))
      if (line.to > line.from) {
        decorations.push(Decoration.mark({ class: 'cm-live-math' }).range(line.from, line.to))
      }
      continue
    }

    // 2. Horizontal rules
    if (/^(?:[-]{3,}|[*]{3,}|[_]{3,})\s*$/.test(text)) {
      activeCalloutType = null
      decorations.push(Decoration.line({ class: 'cm-live-hr' }).range(line.from))
      if (!lineHasCursor && line.to > line.from) {
        decorations.push(Decoration.replace({}).range(line.from, line.to))
      } else if (line.to > line.from) {
        decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.to))
      }
      continue
    }

    // 3. Tables
    if (/^\|.*\|\s*$/.test(text)) {
      activeCalloutType = null
      const isDelimiter = /^\|[\s:|-]+\|\s*$/.test(text)
      const nextLineText = lineNum < doc.lines ? doc.line(lineNum + 1).text : ''
      const isHeader = !isDelimiter && /^\|[\s:|-]+\|\s*$/.test(nextLineText)
      decorations.push(
        Decoration.line({
          class: isDelimiter
            ? 'cm-live-table-row cm-live-table-delimiter'
            : isHeader
              ? 'cm-live-table-row cm-live-table-header'
              : 'cm-live-table-row',
        }).range(line.from)
      )
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '|') {
          decorations.push(
            Decoration.mark({ class: 'cm-live-table-pipe' }).range(line.from + i, line.from + i + 1)
          )
        }
      }
    }

    let inlineStartOffset = 0

    // 4. Headings H1-H6
    const headingMatch = text.match(/^(#{1,6})(\s+)(.+)$/)
    if (headingMatch) {
      activeCalloutType = null
      const level = headingMatch[1].length
      const prefixLen = headingMatch[1].length + headingMatch[2].length
      inlineStartOffset = prefixLen

      decorations.push(
        Decoration.line({ class: `cm-live-heading cm-live-h${level}` }).range(line.from)
      )
      if (!lineHasCursor) {
        decorations.push(Decoration.replace({}).range(line.from, line.from + prefixLen))
      } else {
        decorations.push(
          Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.from + prefixLen)
        )
      }
      if (line.from + prefixLen < line.to) {
        decorations.push(
          Decoration.mark({ class: `cm-live-heading-text cm-live-h${level}-text` }).range(
            line.from + prefixLen,
            line.to
          )
        )
      }
    } else {
      // 5. Callouts & Blockquotes
      const calloutHeaderMatch = text.match(/^((?:>\s*)+)(\[!([a-zA-Z]+)\][+-]?)(\s*.*)$/)
      const quoteMatch = !calloutHeaderMatch ? text.match(/^((?:>\s?)+)(.*)$/) : null

      if (calloutHeaderMatch) {
        const quotePrefixLen = calloutHeaderMatch[1].length
        const calloutTagLen = calloutHeaderMatch[2].length
        const calloutType = calloutHeaderMatch[3].toLowerCase()
        const nextLineText = lineNum < doc.lines ? doc.line(lineNum + 1).text : ''
        const isLastCalloutLine = !/^>\s?/.test(nextLineText)
        activeCalloutType = calloutType
        inlineStartOffset = quotePrefixLen + calloutTagLen

        decorations.push(
          Decoration.line({
            class: `cm-live-blockquote cm-live-callout cm-live-callout--${calloutType} cm-live-callout-header${isLastCalloutLine ? ' cm-live-callout-end' : ''}`,
            attributes: { 'data-callout-type': calloutType },
          }).range(line.from)
        )
        if (!lineHasCursor && quotePrefixLen > 0) {
          decorations.push(Decoration.replace({}).range(line.from, line.from + quotePrefixLen))
        } else if (quotePrefixLen > 0) {
          decorations.push(
            Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.from + quotePrefixLen)
          )
        }
        if (!lineHasCursor) {
          decorations.push(
            Decoration.replace({
              widget: new CalloutBadgeWidget(calloutType, Boolean(calloutHeaderMatch[4]?.trim())),
            }).range(line.from + quotePrefixLen, line.from + quotePrefixLen + calloutTagLen)
          )
        } else {
          decorations.push(
            Decoration.mark({ class: 'cm-live-callout-badge' }).range(
              line.from + quotePrefixLen,
              line.from + quotePrefixLen + calloutTagLen
            )
          )
        }
      } else if (quoteMatch) {
        const prefixLen = quoteMatch[1].length
        inlineStartOffset = prefixLen
        const nextLineText = lineNum < doc.lines ? doc.line(lineNum + 1).text : ''
        const isLastCalloutLine = Boolean(activeCalloutType) && !/^>\s?/.test(nextLineText)
        const calloutClasses = activeCalloutType
          ? ` cm-live-callout cm-live-callout--${activeCalloutType}${isLastCalloutLine ? ' cm-live-callout-end' : ''}`
          : ''
        decorations.push(
          Decoration.line({ class: `cm-live-blockquote${calloutClasses}` }).range(line.from)
        )
        if (!lineHasCursor && prefixLen > 0) {
          decorations.push(Decoration.replace({}).range(line.from, line.from + prefixLen))
        } else if (prefixLen > 0) {
          decorations.push(
            Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.from + prefixLen)
          )
        }
      } else {
        activeCalloutType = null
        // 6. Checklists
        const checkMatch = text.match(/^(\s*)([-*+]\s+\[)([ xX])(\]\s+)(.*)$/)
        if (checkMatch) {
          const indentLen = checkMatch[1].length
          const preBracket = checkMatch[1] + checkMatch[2]
          const stateChar = checkMatch[3]
          const postBracket = checkMatch[4]
          const prefixLen = preBracket.length + 1 + postBracket.length
          const stateCharPos = line.from + preBracket.length
          const checked = stateChar.toLowerCase() === 'x'
          inlineStartOffset = prefixLen

          decorations.push(
            Decoration.line({
              class: `cm-live-list-item cm-live-checklist-item${checked ? ' cm-live-checklist-checked' : ''}`,
            }).range(line.from)
          )
          if (!lineHasCursor) {
            decorations.push(
              Decoration.replace({
                widget: new ChecklistMarkerWidget(stateCharPos, checked),
              }).range(line.from + indentLen, line.from + prefixLen)
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
              }).range(line.from + indentLen, line.from + prefixLen)
            )
          }
          if (line.from + prefixLen < line.to) {
            decorations.push(
              Decoration.mark({ class: 'cm-live-checklist-text' }).range(
                line.from + prefixLen,
                line.to
              )
            )
          }
        } else {
          // 7. Unordered lists
          const ulMatch = text.match(/^(\s*)([-*+]\s+)(.*)$/)
          if (ulMatch) {
            const indentLen = ulMatch[1].length
            const prefixLen = indentLen + ulMatch[2].length
            inlineStartOffset = prefixLen
            decorations.push(
              Decoration.line({ class: 'cm-live-list-item cm-live-ul-item' }).range(line.from)
            )
            if (!lineHasCursor) {
              decorations.push(
                Decoration.replace({ widget: new BulletDotWidget() }).range(
                  line.from + indentLen,
                  line.from + prefixLen
                )
              )
            } else {
              decorations.push(
                Decoration.mark({ class: 'cm-live-list-bullet' }).range(
                  line.from + indentLen,
                  line.from + prefixLen
                )
              )
            }
          } else {
            // 8. Ordered lists
            const olMatch = text.match(/^(\s*\d+\.\s+)(.*)$/)
            if (olMatch) {
              const prefixLen = olMatch[1].length
              inlineStartOffset = prefixLen
              decorations.push(
                Decoration.line({ class: 'cm-live-list-item cm-live-ol-item' }).range(line.from)
              )
              decorations.push(
                Decoration.mark({ class: 'cm-live-list-number' }).range(
                  line.from,
                  line.from + prefixLen
                )
              )
            }
          }
        }
      }
    }

    // 9. Inline tokens
    const inlineTokens = collectInlineTokens(text, inlineStartOffset)
    for (const token of inlineTokens) {
      const absFrom = line.from + token.from
      const absTo = line.from + token.to
      const tokenHasCursor = cursorActive && rangeIntersectsSelection(selection, absFrom, absTo)

      if (token.type === 'code') {
        const innerFrom = absFrom + 1
        const innerTo = absTo - 1
        if (innerFrom < innerTo) {
          if (!tokenHasCursor) {
            decorations.push(Decoration.replace({}).range(absFrom, innerFrom))
            decorations.push(
              Decoration.mark({ class: 'cm-live-inline-code' }).range(innerFrom, innerTo)
            )
            decorations.push(Decoration.replace({}).range(innerTo, absTo))
          } else {
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(absFrom, innerFrom))
            decorations.push(
              Decoration.mark({ class: 'cm-live-inline-code' }).range(innerFrom, innerTo)
            )
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(innerTo, absTo))
          }
        }
      } else if (token.type === 'comment') {
        if (!tokenHasCursor) {
          decorations.push(Decoration.replace({}).range(absFrom, absTo))
        } else {
          decorations.push(Decoration.mark({ class: 'cm-live-comment' }).range(absFrom, absTo))
        }
      } else if (
        token.type === 'bold' ||
        token.type === 'italic' ||
        token.type === 'strikethrough' ||
        token.type === 'highlight'
      ) {
        const d = token.delimLen
        const innerFrom = absFrom + d
        const innerTo = absTo - d
        const styleClass =
          token.type === 'bold'
            ? 'cm-live-bold'
            : token.type === 'italic'
              ? 'cm-live-italic'
              : token.type === 'highlight'
                ? 'cm-live-highlight'
                : 'cm-live-strikethrough'

        if (innerFrom < innerTo) {
          if (!tokenHasCursor) {
            decorations.push(Decoration.replace({}).range(absFrom, innerFrom))
            decorations.push(Decoration.mark({ class: styleClass }).range(innerFrom, innerTo))
            decorations.push(Decoration.replace({}).range(innerTo, absTo))
          } else {
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(absFrom, innerFrom))
            decorations.push(Decoration.mark({ class: styleClass }).range(innerFrom, innerTo))
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(innerTo, absTo))
          }
        }
      } else if (token.type === 'math') {
        const d = token.delimLen
        const innerFrom = absFrom + d
        const innerTo = absTo - d
        if (innerFrom < innerTo) {
          if (!tokenHasCursor) {
            decorations.push(Decoration.replace({}).range(absFrom, innerFrom))
            decorations.push(Decoration.mark({ class: 'cm-live-math' }).range(innerFrom, innerTo))
            decorations.push(Decoration.replace({}).range(innerTo, absTo))
          } else {
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(absFrom, innerFrom))
            decorations.push(Decoration.mark({ class: 'cm-live-math' }).range(innerFrom, innerTo))
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(innerTo, absTo))
          }
        }
      } else if (token.type === 'footnote') {
        decorations.push(Decoration.mark({ class: 'cm-live-footnote' }).range(absFrom, absTo))
      } else if (token.type === 'tag') {
        decorations.push(
          Decoration.mark({
            class: 'cm-live-tag',
            attributes: {
              'data-tag-name': token.tagName,
            },
          }).range(absFrom, absTo)
        )
      } else if (token.type === 'wikilink' || token.type === 'embed') {
        const isEmbed = token.type === 'embed'
        const parsed = parseWikilink(token.raw)
        if (!parsed) continue

        if (isEmbed && !tokenHasCursor && vaultDirectory && parsed.target) {
          const resolvedImagePath = resolveImageTarget(parsed.target, sourcePath, allFiles)
          if (resolvedImagePath) {
            const width = parseImageWidthOption(parsed.alias)
            const altText = width ? '' : parsed.alias || parsed.target
            decorations.push(
              Decoration.replace({
                widget: new ImageEmbedWidget(
                  buildVaultImageMediaUrl(vaultDirectory, resolvedImagePath),
                  altText,
                  token.raw,
                  resolvedImagePath,
                  width
                ),
              }).range(absFrom, absTo)
            )
            continue
          }
        }

        const resolution = resolveLink({
          sourcePath,
          linkTarget: token.raw,
          knownFiles,
          aliasesByFile,
          indexComplete,
          kind: 'wikilink',
        })
        const statusClass = `cm-live-link--${resolution.type}`
        const embedClass = isEmbed ? ' cm-live-embed' : ''
        const attrs = {
          'data-link-kind': 'wikilink',
          'data-link-raw': token.raw,
          'data-link-status': resolution.type,
          'data-editing': tokenHasCursor ? 'true' : 'false',
        }
        if (isEmbed) attrs['data-link-embed'] = 'true'
        if (resolution.path) attrs['data-link-resolved-path'] = resolution.path
        if (resolution.anchor) attrs['data-link-anchor'] = resolution.anchor

        const prefixLen = isEmbed ? 3 : 2
        const innerText = token.raw.slice(prefixLen, -2)
        const pipeIdx = innerText.indexOf('|')

        if (!tokenHasCursor) {
          if (pipeIdx !== -1 && absFrom + prefixLen + pipeIdx + 1 < absTo - 2) {
            const aliasFrom = absFrom + prefixLen + pipeIdx + 1
            const aliasTo = absTo - 2
            decorations.push(Decoration.replace({}).range(absFrom, aliasFrom))
            decorations.push(
              Decoration.mark({
                class: `cm-live-link cm-live-wikilink ${statusClass}${embedClass}`,
                attributes: attrs,
              }).range(aliasFrom, aliasTo)
            )
            decorations.push(Decoration.replace({}).range(aliasTo, absTo))
          } else {
            const targetFrom = absFrom + prefixLen
            const targetTo = absTo - 2
            decorations.push(Decoration.replace({}).range(absFrom, targetFrom))
            decorations.push(
              Decoration.mark({
                class: `cm-live-link cm-live-wikilink ${statusClass}${embedClass}`,
                attributes: attrs,
              }).range(targetFrom, targetTo)
            )
            decorations.push(Decoration.replace({}).range(targetTo, absTo))
          }
        } else {
          decorations.push(
            Decoration.mark({
              class: `cm-live-link cm-live-wikilink ${statusClass}${embedClass}`,
              attributes: attrs,
            }).range(absFrom, absTo)
          )
        }
      } else if (token.type === 'mdlink' || token.type === 'image') {
        const isImage = token.type === 'image'
        const m = token.raw.match(/^!?\[([^\]]*)\]\(([^)\n]+)\)$/)
        if (!m) continue
        const label = m[1]
        const rawDest = m[2].trim()

        if (isImage && !tokenHasCursor && vaultDirectory) {
          const resolvedImagePath = resolveImageTarget(rawDest, sourcePath, allFiles)
          if (resolvedImagePath) {
            const width = parseImageWidthOption(label)
            const altText = width ? '' : label
            decorations.push(
              Decoration.replace({
                widget: new ImageEmbedWidget(
                  buildVaultImageMediaUrl(vaultDirectory, resolvedImagePath),
                  altText,
                  token.raw,
                  resolvedImagePath,
                  width
                ),
              }).range(absFrom, absTo)
            )
            continue
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
          'data-editing': tokenHasCursor ? 'true' : 'false',
        }
        if (resolvedPath) attrs['data-link-resolved-path'] = resolvedPath
        if (anchor) attrs['data-link-anchor'] = anchor
        if (externalHref) attrs['data-link-href'] = externalHref

        const labelFrom = absFrom + (isImage ? 2 : 1)
        const labelTo = labelFrom + label.length

        if (!tokenHasCursor && label.length > 0 && !isImage) {
          decorations.push(Decoration.replace({}).range(absFrom, labelFrom))
          decorations.push(
            Decoration.mark({
              class: `cm-live-link cm-live-markdown-link ${statusClass}`,
              attributes: attrs,
            }).range(labelFrom, labelTo)
          )
          decorations.push(Decoration.replace({}).range(labelTo, absTo))
        } else {
          decorations.push(
            Decoration.mark({
              class: `cm-live-link cm-live-markdown-link ${statusClass}`,
              attributes: attrs,
            }).range(absFrom, absTo)
          )
        }
      }
    }

    // 10. Block ID at end of line: ^block-id
    const blockIdMatch = text.match(/(?:^|\s)(\^[a-zA-Z0-9-]+)\s*$/)
    if (blockIdMatch) {
      const idStr = blockIdMatch[1]
      const idx = text.lastIndexOf(idStr)
      if (idx >= inlineStartOffset) {
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
