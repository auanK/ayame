import MarkdownIt from 'markdown-it'
import DOMPurify from 'dompurify'

const md = new MarkdownIt({
  html: false, // Disallow raw HTML from source input
  xhtmlOut: false,
  breaks: false,
  linkify: false,
})

// Present images safely as discreet text placeholders without creating <img> tags or remote network requests
md.renderer.rules.image = (tokens, idx) => {
  const token = tokens[idx]
  const alt = token.content || token.children?.map((c) => c.content).join('') || 'Image'
  return `<span class="markdown-image-placeholder">[Image: ${md.utils.escapeHtml(alt)}]</span>`
}

// Intercept inline links: allow only http/https external links with safe target & rel;
// convert relative links or unknown protocols to non-clickable spans
md.core.ruler.after('inline', 'safe_links', (state) => {
  for (const blockToken of state.tokens) {
    if (blockToken.type === 'inline' && blockToken.children) {
      const children = blockToken.children
      for (let i = 0; i < children.length; i++) {
        const token = children[i]
        if (token.type === 'link_open') {
          const href = token.attrGet('href') || ''
          if (/^https?:\/\//i.test(href)) {
            token.attrSet('target', '_blank')
            token.attrSet('rel', 'noopener noreferrer')
          } else {
            // Convert to non-clickable span
            token.tag = 'span'
            token.attrs = [['class', 'markdown-non-navigable-link']]
            let depth = 1
            for (let j = i + 1; j < children.length; j++) {
              if (children[j].type === 'link_open') depth++
              if (children[j].type === 'link_close') {
                depth--
                if (depth === 0) {
                  children[j].tag = 'span'
                  break
                }
              }
            }
          }
        }
      }
    }
  }
})

const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    'h1',
    'h2',
    'h3',
    'h4',
    'h5',
    'h6',
    'p',
    'strong',
    'em',
    'del',
    's',
    'ul',
    'ol',
    'li',
    'blockquote',
    'code',
    'pre',
    'table',
    'thead',
    'tbody',
    'tr',
    'th',
    'td',
    'hr',
    'br',
    'a',
    'span',
  ],
  ALLOWED_ATTR: ['href', 'target', 'rel', 'class'],
  ALLOWED_URI_REGEXP: /^https?:\/\//i,
}

let hookInstalled = false
const getPurifier = () => {
  const purifier = typeof DOMPurify.sanitize === 'function'
    ? DOMPurify
    : (typeof window !== 'undefined' ? DOMPurify(window) : DOMPurify)

  if (!hookInstalled && typeof purifier.addHook === 'function') {
    purifier.addHook('afterSanitizeAttributes', (node) => {
      if (node.tagName === 'A' && node.hasAttribute('href')) {
        const href = node.getAttribute('href') || ''
        if (/^https?:\/\//i.test(href)) {
          node.setAttribute('target', '_blank')
          node.setAttribute('rel', 'noopener noreferrer')
        }
      }
    })
    hookInstalled = true
  }

  return purifier
}

/**
 * Pure rendering function: parses markdown and sanitizes output HTML before UI insertion.
 */
export const renderMarkdown = (source) => {
  if (typeof source !== 'string' || source.length === 0) {
    return ''
  }

  const rawHtml = md.render(source)
  const purifier = getPurifier()
  return purifier.sanitize(rawHtml, SANITIZE_CONFIG)
}

export const initialMarkdownH1 = (source) => {
  if (typeof source !== 'string' || !source) return null
  const tokens = md.parse(source, {})
  const index = tokens.findIndex((token) => token.level === 0 && token.type !== 'inline')
  if (index < 0 || tokens[index].type !== 'heading_open' || tokens[index].tag !== 'h1') return null
  const inline = tokens[index + 1]
  if (inline?.type !== 'inline') return null
  return (inline.children || []).map((token) =>
    token.type === 'softbreak' || token.type === 'hardbreak' ? ' ' : token.content
  ).join('').trim()
}
