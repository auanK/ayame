import { describe, it, expect } from 'vitest'
import { renderMarkdown } from './render.js'

const toDOM = (html) => {
  const container = document.createElement('div')
  container.innerHTML = html
  return container
}

describe('renderMarkdown', () => {
  describe('Standard Markdown syntax support', () => {
    it('renders headings H1 through H6', () => {
      const src = '# Heading 1\n## Heading 2\n### Heading 3\n#### Heading 4\n##### Heading 5\n###### Heading 6'
      const html = renderMarkdown(src)
      expect(html).toContain('<h1>Heading 1</h1>')
      expect(html).toContain('<h2>Heading 2</h2>')
      expect(html).toContain('<h3>Heading 3</h3>')
      expect(html).toContain('<h4>Heading 4</h4>')
      expect(html).toContain('<h5>Heading 5</h5>')
      expect(html).toContain('<h6>Heading 6</h6>')
    })

    it('renders paragraphs and line breaks', () => {
      const src = 'First paragraph.\n\nSecond paragraph.'
      const html = renderMarkdown(src)
      expect(html).toContain('<p>First paragraph.</p>')
      expect(html).toContain('<p>Second paragraph.</p>')
    })

    it('renders bold and italic formatting', () => {
      const src = '**bold text** and *italic text* and ***both***'
      const html = renderMarkdown(src)
      expect(html).toContain('<strong>bold text</strong>')
      expect(html).toContain('<em>italic text</em>')
    })

    it('renders ordered and unordered lists', () => {
      const unordered = '- Item A\n- Item B\n- Item C'
      const ordered = '1. First\n2. Second\n3. Third'
      const htmlUnordered = renderMarkdown(unordered)
      const htmlOrdered = renderMarkdown(ordered)

      expect(htmlUnordered).toContain('<ul>')
      expect(htmlUnordered).toContain('<li>Item A</li>')
      expect(htmlOrdered).toContain('<ol>')
      expect(htmlOrdered).toContain('<li>First</li>')
    })

    it('renders static checklists without task state mutation', () => {
      const src = '- [ ] Pending task\n- [x] Completed task'
      const html = renderMarkdown(src)
      expect(html).toContain('Pending task')
      expect(html).toContain('Completed task')
      expect(html).not.toContain('<input type="checkbox" name=')
    })

    it('renders blockquotes', () => {
      const src = '> A thoughtful quote from notes.'
      const html = renderMarkdown(src)
      expect(html).toContain('<blockquote>')
      expect(html).toContain('<p>A thoughtful quote from notes.</p>')
      expect(html).toContain('</blockquote>')
    })

    it('renders inline code and code blocks', () => {
      const src = 'Use `const x = 1` in code.\n\n```js\nfunction test() {\n  return 42\n}\n```'
      const html = renderMarkdown(src)
      expect(html).toContain('<code>const x = 1</code>')
      expect(html).toContain('<pre><code')
      expect(html).toContain('return 42')
    })

    it('renders tables', () => {
      const src = '| Name | Age |\n| --- | --- |\n| Alice | 30 |\n| Bob | 25 |'
      const html = renderMarkdown(src)
      expect(html).toContain('<table>')
      expect(html).toContain('<thead>')
      expect(html).toContain('<th>Name</th>')
      expect(html).toContain('<tbody>')
      expect(html).toContain('<td>Alice</td>')
    })

    it('renders horizontal rules', () => {
      const src = 'Above\n\n---\n\nBelow'
      const html = renderMarkdown(src)
      expect(html).toContain('<hr>')
    })

    it('renders strikethrough', () => {
      const src = 'This is ~~deleted~~ text.'
      const html = renderMarkdown(src)
      expect(html).toContain('<s>deleted</s>')
    })

    it('handles empty input gracefully', () => {
      expect(renderMarkdown('')).toBe('')
      expect(renderMarkdown(null)).toBe('')
      expect(renderMarkdown(undefined)).toBe('')
    })
  })

  describe('Security and Sanitization (DOM and attribute verification)', () => {
    it('disallows raw HTML elements from source input', () => {
      const src = '<div class="custom-div"><span id="raw-span">Hello raw</span></div>'
      const dom = toDOM(renderMarkdown(src))
      expect(dom.querySelector('div')).toBeNull()
      expect(dom.querySelector('#raw-span')).toBeNull()
      expect(dom.textContent).toContain('Hello raw')
    })

    it('disallows script tags and execution vectors in DOM', () => {
      const src = '<script>alert("XSS")</script>\n\n<script src="https://evil.com/payload.js"></script>'
      const dom = toDOM(renderMarkdown(src))
      expect(dom.querySelector('script')).toBeNull()
      expect(dom.querySelectorAll('*[src*="evil.com"]').length).toBe(0)
    })

    it('disallows inline event handlers like onclick and onerror on any DOM element', () => {
      const payloads = [
        '<img src="x" onerror="alert(1)">',
        '<a href="https://example.com" onclick="alert(1)">Click</a>',
        '<b onmouseover="alert(1)">Hover me</b>',
      ]
      for (const payload of payloads) {
        const dom = toDOM(renderMarkdown(payload))
        const elements = dom.querySelectorAll('*')
        for (const el of elements) {
          expect(el.getAttribute('onerror')).toBeNull()
          expect(el.getAttribute('onclick')).toBeNull()
          expect(el.getAttribute('onmouseover')).toBeNull()
        }
      }
    })

    it('disallows javascript:, data:, and vbscript: URIs in links', () => {
      const payloads = [
        '[Evil JS](javascript:alert(1))',
        '[Evil Data](data:text/html,<script>alert(1)</script>)',
        '[Evil VBS](vbscript:msgbox(1))',
      ]
      for (const payload of payloads) {
        const dom = toDOM(renderMarkdown(payload))
        const anchors = dom.querySelectorAll('a')
        for (const a of anchors) {
          const href = a.getAttribute('href') || ''
          expect(href.toLowerCase()).not.toMatch(/^(javascript:|data:|vbscript:)/)
        }
      }
    })

    it('disallows iframe, embedded svg, and object/embed tags in DOM', () => {
      const payloads = [
        '<iframe src="https://evil.com"></iframe>',
        '<svg onload="alert(1)"><circle r="10"/></svg>',
        '<object data="exploit.swf"></object>',
        '<embed src="exploit.swf"></embed>',
      ]
      for (const payload of payloads) {
        const dom = toDOM(renderMarkdown(payload))
        expect(dom.querySelector('iframe')).toBeNull()
        expect(dom.querySelector('svg')).toBeNull()
        expect(dom.querySelector('object')).toBeNull()
        expect(dom.querySelector('embed')).toBeNull()
      }
    })

    it('disallows arbitrary style attributes and style tags in DOM', () => {
      const src = '<style>body { display: none; }</style><p style="color: red; position: fixed;">Text</p>'
      const dom = toDOM(renderMarkdown(src))
      expect(dom.querySelector('style')).toBeNull()
      const elements = dom.querySelectorAll('*')
      for (const el of elements) {
        expect(el.getAttribute('style')).toBeNull()
      }
    })

    it('neutralizes HTML entity bypass attempts for script execution', () => {
      const src = '[Bypass](&javascript:alert(1))'
      const dom = toDOM(renderMarkdown(src))
      for (const a of dom.querySelectorAll('a')) {
        expect(a.getAttribute('href')).not.toMatch(/javascript:/i)
      }
    })

    it('renders external HTTP and HTTPS links safely with target="_blank" and rel="noopener noreferrer"', () => {
      const src = '[Ayame Project](https://github.com/ayame) and [Insecure](http://insecure.org)'
      const dom = toDOM(renderMarkdown(src))
      const anchors = dom.querySelectorAll('a')
      expect(anchors.length).toBe(2)

      expect(anchors[0].getAttribute('href')).toBe('https://github.com/ayame')
      expect(anchors[0].getAttribute('target')).toBe('_blank')
      expect(anchors[0].getAttribute('rel')).toBe('noopener noreferrer')
      expect(anchors[0].textContent).toBe('Ayame Project')

      expect(anchors[1].getAttribute('href')).toBe('http://insecure.org')
      expect(anchors[1].getAttribute('target')).toBe('_blank')
      expect(anchors[1].getAttribute('rel')).toBe('noopener noreferrer')
      expect(anchors[1].textContent).toBe('Insecure')
    })

    it('renders relative links and internal references as non-clickable text without anchor tags', () => {
      const src = '[Other Note](projects/roadmap.md) and [Sibling](./spec.md) and [Anchor](#heading)'
      const dom = toDOM(renderMarkdown(src))
      expect(dom.querySelectorAll('a').length).toBe(0)
      expect(dom.textContent).toContain('Other Note')
      expect(dom.textContent).toContain('Sibling')
      expect(dom.textContent).toContain('Anchor')
    })

    it('presents markdown image syntax safely without loading remote images or creating network requests', () => {
      const src = '![Diagram](https://example.com/diagram.png "Title") and ![Local](projects/pic.jpg)'
      const dom = toDOM(renderMarkdown(src))
      expect(dom.querySelector('img')).toBeNull()
      expect(dom.querySelectorAll('*[src]').length).toBe(0)
      expect(dom.textContent).toContain('Diagram')
      expect(dom.textContent).toContain('Local')
    })
  })
})
