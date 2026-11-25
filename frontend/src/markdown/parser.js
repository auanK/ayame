import { parser as baseMarkdownParser, GFM } from '@lezer/markdown'
import { validateTagName } from './properties.js'

const HighlightDelim = {
  resolve: 'ObsidianHighlight',
  mark: 'HighlightMark',
}

const isWhitespaceChar = (ch) =>
  ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r'

/**
 * YAML frontmatter block parser (only at document offset 0).
 * Prevents closing `---` from being misparsed as a SetextHeading2 when editing in source mode.
 */
const FrontmatterExtension = {
  defineNodes: [
    { name: 'Frontmatter', block: true },
    'FrontmatterMark',
  ],
  parseBlock: [
    {
      name: 'Frontmatter',
      before: 'HorizontalRule',
      parse(cx, line) {
        if (cx.lineStart !== 0 || cx.depth > 1) return false
        if (!/^---[ \t]*$/.test(line.text)) return false

        const nextLineText = cx.peekLine()
        if (
          nextLineText === null ||
          nextLineText === undefined ||
          !/^(?:---|\.\.\.|[a-zA-Z0-9_.-]+\s*:|#|\s+-\s)/.test(nextLineText)
        ) {
          return false
        }

        const start = cx.lineStart
        const openEnd = cx.lineStart + line.text.length
        const children = [cx.elt('FrontmatterMark', start, openEnd)]
        let end = openEnd

        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length
          if (/^(?:---|\.\.\.)[ \t]*$/.test(line.text)) {
            children.push(cx.elt('FrontmatterMark', cx.lineStart, end))
            cx.nextLine()
            cx.addElement(cx.elt('Frontmatter', start, end, children))
            return true
          }
        }

        cx.addElement(cx.elt('Frontmatter', start, end, children))
        return true
      },
    },
  ],
}

/**
 * Multiline $$ math block parser.
 */
const MathBlockExtension = {
  defineNodes: [
    { name: 'MathBlock', block: true },
    'MathMark',
  ],
  parseBlock: [
    {
      name: 'MathBlock',
      before: 'FencedCode',
      endLeaf(_cx, line) {
        return /^\$\$[ \t]*$/.test(line.text.slice(line.pos))
      },
      parse(cx, line) {
        const rest = line.text.slice(line.pos)
        if (!/^\$\$[ \t]*$/.test(rest)) return false

        const start = cx.lineStart + line.pos
        const openEnd = cx.lineStart + line.text.length
        const children = [cx.elt('MathMark', start, openEnd)]
        let end = openEnd

        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length
          if (/^\$\$[ \t]*$/.test(line.text.slice(line.pos))) {
            children.push(cx.elt('MathMark', cx.lineStart + line.pos, end))
            cx.nextLine()
            cx.addElement(cx.elt('MathBlock', start, end, children))
            return true
          }
        }

        cx.addElement(cx.elt('MathBlock', start, end, children))
        return true
      },
    },
  ],
}

/**
 * Multiline Obsidian comment block parser (%% ... %% across multiple lines).
 * Single-line %%comment%% stays handled by the inline ObsidianComment parser.
 */
const ObsidianCommentBlockExtension = {
  defineNodes: [
    { name: 'ObsidianCommentBlock', block: true },
  ],
  parseBlock: [
    {
      name: 'ObsidianCommentBlock',
      before: 'FencedCode',
      endLeaf(_cx, line) {
        const rest = line.text.slice(line.pos)
        return rest.startsWith('%%') && rest.indexOf('%%', 2) === -1
      },
      parse(cx, line) {
        const rest = line.text.slice(line.pos)
        if (!rest.startsWith('%%') || rest.indexOf('%%', 2) !== -1) return false

        const start = cx.lineStart + line.pos
        let end = cx.lineStart + line.text.length

        while (cx.nextLine()) {
          end = cx.lineStart + line.text.length
          if (line.text.includes('%%')) {
            cx.nextLine()
            cx.addElement(cx.elt('ObsidianCommentBlock', start, end))
            return true
          }
        }

        cx.addElement(cx.elt('ObsidianCommentBlock', start, end))
        return true
      },
    },
  ],
}

/**
 * Footnote definition block parser: `[^id]: body text with inline markdown`.
 */
const FootnoteDefinitionExtension = {
  defineNodes: [
    { name: 'FootnoteDefinition', block: true },
    'FootnoteDefMark',
  ],
  parseBlock: [
    {
      name: 'FootnoteDefinition',
      before: 'LinkReference',
      endLeaf(_cx, line) {
        return /^\[\^[^\]\s]+\]:/.test(line.text.slice(line.pos))
      },
      parse(cx, line) {
        const rest = line.text.slice(line.pos)
        const match = rest.match(/^(\[\^[^\]\s]+\]:)([ \t]*)/)
        if (!match) return false

        const start = cx.lineStart + line.pos
        const markEnd = start + match[1].length
        const bodyStart = markEnd + match[2].length
        const lineEnd = cx.lineStart + line.text.length
        const children = [cx.elt('FootnoteDefMark', start, markEnd)]

        if (bodyStart < lineEnd) {
          children.push(...cx.parser.parseInline(line.text.slice(bodyStart - cx.lineStart), bodyStart))
        }

        cx.nextLine()
        cx.addElement(cx.elt('FootnoteDefinition', start, lineEnd, children))
        return true
      },
    },
  ],
}

/**
 * Obsidian Flavored Markdown inline extensions layered cleanly onto CommonMark + GFM:
 * - [[Wikilink]] and ![[WikiEmbed]]
 * - %%ObsidianComment%%
 * - ==ObsidianHighlight==
 * - $InlineMath$ and $$InlineMath$$
 * - [^FootnoteRef]
 * - #InlineTag
 */
const ObsidianInlineExtension = {
  defineNodes: [
    'Wikilink',
    'WikiEmbed',
    'ObsidianComment',
    'ObsidianHighlight',
    'HighlightMark',
    'InlineMath',
    'FootnoteRef',
    'InlineTag',
  ],
  parseInline: [
    {
      name: 'Wikilink',
      before: 'Link',
      parse(cx, next, pos) {
        let isEmbed = false
        let openLen = 2
        if (next === 33 /* ! */) {
          if (cx.char(pos + 1) !== 91 /* [ */ || cx.char(pos + 2) !== 91 /* [ */) return -1
          isEmbed = true
          openLen = 3
        } else if (next === 91 /* [ */) {
          if (cx.char(pos + 1) !== 91 /* [ */) return -1
        } else {
          return -1
        }

        const contentStart = pos + openLen
        let scan = contentStart
        while (scan < cx.end) {
          const ch = cx.char(scan)
          if (ch === 10 /* \n */ || ch === 13 /* \r */ || ch === 91 /* [ */) {
            return -1
          }
          if (ch === 93 /* ] */) {
            if (cx.char(scan + 1) === 93 /* ] */ && scan > contentStart) {
              const end = scan + 2
              return cx.addElement(cx.elt(isEmbed ? 'WikiEmbed' : 'Wikilink', pos, end))
            }
            return -1
          }
          scan++
        }
        return -1
      },
    },
    {
      name: 'FootnoteRef',
      before: 'Link',
      parse(cx, next, pos) {
        if (next !== 91 /* [ */ || cx.char(pos + 1) !== 94 /* ^ */) return -1
        let scan = pos + 2
        while (scan < cx.end) {
          const ch = cx.char(scan)
          if (ch === 10 || ch === 13 || ch === 91) return -1
          if (ch === 93 /* ] */) {
            if (scan === pos + 2) return -1
            // Do not hijack footnote definition `[^1]: ...` or link `[^1](url)`
            const after = cx.char(scan + 1)
            if (after === 40 /* ( */) return -1
            return cx.addElement(cx.elt('FootnoteRef', pos, scan + 1))
          }
          scan++
        }
        return -1
      },
    },
    {
      name: 'ObsidianComment',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 37 /* % */ || cx.char(pos + 1) !== 37 /* % */) return -1
        let scan = pos + 2
        while (scan < cx.end) {
          const ch = cx.char(scan)
          if (ch === 10 || ch === 13) return -1
          if (ch === 37 && cx.char(scan + 1) === 37) {
            if (scan === pos + 2) return -1
            return cx.addElement(cx.elt('ObsidianComment', pos, scan + 2))
          }
          scan++
        }
        return -1
      },
    },
    {
      name: 'ObsidianHighlight',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 61 /* = */ || cx.char(pos + 1) !== 61 /* = */) return -1
        const before = pos > cx.offset ? String.fromCharCode(cx.char(pos - 1)) : ''
        const after = pos + 2 < cx.end ? String.fromCharCode(cx.char(pos + 2)) : ''
        const open = Boolean(after) && !isWhitespaceChar(after)
        const close = Boolean(before) && !isWhitespaceChar(before)
        if (!open && !close) return -1
        return cx.addDelimiter(HighlightDelim, pos, pos + 2, open, close)
      },
    },
    {
      name: 'InlineMath',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 36 /* $ */) return -1
        const isDouble = cx.char(pos + 1) === 36
        const delimLen = isDouble ? 2 : 1
        const contentStart = pos + delimLen
        if (contentStart >= cx.end) return -1

        if (!isDouble) {
          const firstChar = String.fromCharCode(cx.char(contentStart))
          if (isWhitespaceChar(firstChar) || firstChar === '$') return -1
        }

        let scan = contentStart
        while (scan < cx.end) {
          const ch = cx.char(scan)
          if (ch === 10 || ch === 13) return -1
          if (ch === 92 /* \ */) {
            scan += 2
            continue
          }
          if (ch === 36 /* $ */) {
            if (isDouble) {
              if (cx.char(scan + 1) === 36 && scan > contentStart) {
                return cx.addElement(cx.elt('InlineMath', pos, scan + 2))
              }
            } else {
              const prevChar = String.fromCharCode(cx.char(scan - 1))
              if (!isWhitespaceChar(prevChar)) {
                return cx.addElement(cx.elt('InlineMath', pos, scan + 1))
              }
            }
          }
          scan++
        }
        return -1
      },
    },
    {
      name: 'InlineTag',
      before: 'Emphasis',
      parse(cx, next, pos) {
        if (next !== 35 /* # */) return -1
        if (pos > cx.offset) {
          const prevChar = String.fromCharCode(cx.char(pos - 1))
          if (!isWhitespaceChar(prevChar)) return -1
        }
        const rest = cx.slice(pos + 1, cx.end)
        const match = rest.match(/^[\p{L}\p{N}_\-/]+/u)
        if (!match) return -1
        const valid = validateTagName(match[0])
        if (!valid) return -1
        return cx.addElement(cx.elt('InlineTag', pos, pos + 1 + match[0].length))
      },
    },
  ],
}

export const ayameMarkdownExtensions = [
  GFM,
  { remove: ['HTMLBlock'] },
  FrontmatterExtension,
  MathBlockExtension,
  ObsidianCommentBlockExtension,
  FootnoteDefinitionExtension,
  ObsidianInlineExtension,
]

export const ayameMarkdownParser = baseMarkdownParser.configure(ayameMarkdownExtensions)
