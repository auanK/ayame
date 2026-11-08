import { StateEffect, StateField } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { classifyLinkDestination, parseWikilink, resolveLink } from './links.js'

export const setLivePreviewContextEffect = StateEffect.define()
export const setCursorActiveEffect = StateEffect.define()

const rangeIntersectsSelection = (selection, from, to) =>
  selection.ranges.some((range) => range.from <= to && range.to >= from)

const collectInlineTokens = (lineText, startOffset) => {
  const tokens = []
  const slice = lineText.slice(startOffset)
  const tokenRegex = /(`[^`\n]+`)|(!?\[\[[^\]]+\]\])|(!?\[[^\]]*\]\([^)\n]+\))|(\*\*|__)(?=\S)([^\n]+?\S|\S)\4|(~~)(?=\S)([^\n]+?\S|\S)\6|(\*|_)(?=\S)([^*\n_]+?\S|\S)\8/g

  let match
  while ((match = tokenRegex.exec(slice)) !== null) {
    const from = startOffset + match.index
    const raw = match[0]
    const to = from + raw.length

    if (match[1]) {
      tokens.push({ type: 'code', from, to, raw })
    } else if (match[2]) {
      tokens.push({
        type: raw.startsWith('!') ? 'embed' : 'wikilink',
        from,
        to,
        raw,
      })
    } else if (match[3]) {
      tokens.push({
        type: raw.startsWith('!') ? 'image' : 'mdlink',
        from,
        to,
        raw,
      })
    } else if (match[4]) {
      tokens.push({
        type: 'bold',
        from,
        to,
        delimLen: match[4].length,
      })
    } else if (match[6]) {
      tokens.push({
        type: 'strikethrough',
        from,
        to,
        delimLen: 2,
      })
    } else if (match[8]) {
      tokens.push({
        type: 'italic',
        from,
        to,
        delimLen: 1,
      })
    }
  }

  return tokens
}

const buildLivePreviewDecorations = (state, context, cursorActive) => {
  const decorations = []
  const doc = state.doc
  const selection = state.selection
  const { sourcePath = '', knownFiles = [] } = context || {}

  let inCodeBlock = false
  let codeFenceChar = ''

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
        decorations.push(Decoration.line({ class: 'cm-live-codeblock-fence cm-live-codeblock-open' }).range(line.from))
        if (!lineHasCursor && line.to > line.from) {
          decorations.push(Decoration.mark({ class: 'cm-live-codeblock-fence-hidden' }).range(line.from, line.to))
        } else if (line.to > line.from) {
          decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.to))
        }
        continue
      } else if (fenceMarker === codeFenceChar) {
        inCodeBlock = false
        codeFenceChar = ''
        decorations.push(Decoration.line({ class: 'cm-live-codeblock-fence cm-live-codeblock-close' }).range(line.from))
        if (!lineHasCursor && line.to > line.from) {
          decorations.push(Decoration.mark({ class: 'cm-live-codeblock-fence-hidden' }).range(line.from, line.to))
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

    // 2. Horizontal rules
    if (/^(?:[-]{3,}|[*]{3,}|[_]{3,})\s*$/.test(text)) {
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
      const isDelimiter = /^\|[\s:|-]+\|\s*$/.test(text)
      decorations.push(
        Decoration.line({
          class: isDelimiter ? 'cm-live-table-row cm-live-table-delimiter' : 'cm-live-table-row',
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
      // 5. Blockquotes
      const quoteMatch = text.match(/^((?:>\s?)+)(.*)$/)
      if (quoteMatch) {
        const prefixLen = quoteMatch[1].length
        inlineStartOffset = prefixLen
        decorations.push(Decoration.line({ class: 'cm-live-blockquote' }).range(line.from))
        if (!lineHasCursor && prefixLen > 0) {
          decorations.push(Decoration.replace({}).range(line.from, line.from + prefixLen))
        } else if (prefixLen > 0) {
          decorations.push(
            Decoration.mark({ class: 'cm-live-syntax' }).range(line.from, line.from + prefixLen)
          )
        }
      } else {
        // 6. Checklists
        const checkMatch = text.match(/^(\s*[-*+]\s+\[([ xX])\]\s+)(.*)$/)
        if (checkMatch) {
          const prefixLen = checkMatch[1].length
          const checked = checkMatch[2].toLowerCase() === 'x'
          inlineStartOffset = prefixLen
          decorations.push(
            Decoration.line({
              class: `cm-live-list-item cm-live-checklist-item${checked ? ' cm-live-checklist-checked' : ''}`,
            }).range(line.from)
          )
          decorations.push(
            Decoration.mark({ class: 'cm-live-checklist-marker' }).range(
              line.from,
              line.from + prefixLen
            )
          )
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
          const ulMatch = text.match(/^(\s*[-*+]\s+)(.*)$/)
          if (ulMatch) {
            const prefixLen = ulMatch[1].length
            inlineStartOffset = prefixLen
            decorations.push(
              Decoration.line({ class: 'cm-live-list-item cm-live-ul-item' }).range(line.from)
            )
            decorations.push(
              Decoration.mark({ class: 'cm-live-list-bullet' }).range(
                line.from,
                line.from + prefixLen
              )
            )
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

    // 9. Inline tokens (bold, italic, strikethrough, inline code, wikilinks, markdown links)
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
            decorations.push(Decoration.mark({ class: 'cm-live-inline-code' }).range(innerFrom, innerTo))
            decorations.push(Decoration.replace({}).range(innerTo, absTo))
          } else {
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(absFrom, innerFrom))
            decorations.push(Decoration.mark({ class: 'cm-live-inline-code' }).range(innerFrom, innerTo))
            decorations.push(Decoration.mark({ class: 'cm-live-syntax' }).range(innerTo, absTo))
          }
        }
      } else if (token.type === 'bold' || token.type === 'italic' || token.type === 'strikethrough') {
        const d = token.delimLen
        const innerFrom = absFrom + d
        const innerTo = absTo - d
        const styleClass =
          token.type === 'bold'
            ? 'cm-live-bold'
            : token.type === 'italic'
              ? 'cm-live-italic'
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
      } else if (token.type === 'wikilink') {
        const parsed = parseWikilink(token.raw)
        if (!parsed) continue
        const resolution = resolveLink({
          sourcePath,
          linkTarget: token.raw,
          knownFiles,
          kind: 'wikilink',
        })
        const statusClass = `cm-live-link--${resolution.type}`
        const attrs = {
          'data-link-kind': 'wikilink',
          'data-link-raw': token.raw,
          'data-link-status': resolution.type,
          'data-editing': tokenHasCursor ? 'true' : 'false',
        }
        if (resolution.path) attrs['data-link-resolved-path'] = resolution.path
        if (resolution.anchor) attrs['data-link-anchor'] = resolution.anchor

        const innerText = token.raw.slice(2, -2)
        const pipeIdx = innerText.indexOf('|')

        if (!tokenHasCursor) {
          if (pipeIdx !== -1 && absFrom + 2 + pipeIdx + 1 < absTo - 2) {
            const aliasFrom = absFrom + 2 + pipeIdx + 1
            const aliasTo = absTo - 2
            decorations.push(Decoration.replace({}).range(absFrom, aliasFrom))
            decorations.push(
              Decoration.mark({
                class: `cm-live-link cm-live-wikilink ${statusClass}`,
                attributes: attrs,
              }).range(aliasFrom, aliasTo)
            )
            decorations.push(Decoration.replace({}).range(aliasTo, absTo))
          } else {
            const targetFrom = absFrom + 2
            const targetTo = absTo - 2
            decorations.push(Decoration.replace({}).range(absFrom, targetFrom))
            decorations.push(
              Decoration.mark({
                class: `cm-live-link cm-live-wikilink ${statusClass}`,
                attributes: attrs,
              }).range(targetFrom, targetTo)
            )
            decorations.push(Decoration.replace({}).range(targetTo, absTo))
          }
        } else {
          decorations.push(
            Decoration.mark({
              class: `cm-live-link cm-live-wikilink ${statusClass}`,
              attributes: attrs,
            }).range(absFrom, absTo)
          )
        }
      } else if (token.type === 'mdlink') {
        const m = token.raw.match(/^\[([^\]]*)\]\(([^)\n]+)\)$/)
        if (!m) continue
        const label = m[1]
        const rawDest = m[2].trim()
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

        const labelFrom = absFrom + 1
        const labelTo = labelFrom + label.length

        if (!tokenHasCursor && label.length > 0) {
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
