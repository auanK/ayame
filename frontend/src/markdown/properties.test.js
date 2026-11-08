import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import PropertiesPanel from './PropertiesPanel.vue'
import {
  parseNoteDocument,
  updateBodyInMarkdown,
  setPropertyInMarkdown,
  addPropertyToMarkdown,
  removePropertyFromMarkdown,
  renamePropertyInMarkdown,
  renamePropertyInMarkdownResult,
  reorderPropertiesInMarkdown,
  replaceRawYamlInMarkdown,
  buildInitialNoteContent,
  inferPropertyType,
  coercePropertyValue,
  parsePropertyNumber,
  validateTagName,
  extractBodyTags,
  extractAllNoteTags,
  matchesTagQuery,
} from './properties.js'

describe('Properties & YAML Frontmatter (Obsidian parity)', () => {
  it('1. parses existing YAML frontmatter with title, type, tags, aliases, dates, booleans, numbers, and custom properties', () => {
    const md = [
      '---',
      'title: Cosmologia - A Memória do Mundo',
      'type: Cosmologia',
      'tags:',
      '  - cosmologia',
      '  - leis-universais',
      'aliases:',
      '  - Memória do Mundo',
      'status: Em desenvolvimento',
      'published: false',
      'chapter: 3',
      'created: 2026-11-07',
      'updated: 2026-11-07T14:30',
      '---',
      '',
      '# Introdução',
      '',
      'Conteúdo da nota.',
    ].join('\n')

    const parsed = parseNoteDocument(md)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.valid).toBe(true)
    expect(parsed.body).toBe('\n# Introdução\n\nConteúdo da nota.')
    expect(parsed.properties).toEqual([
      { key: 'title', value: 'Cosmologia - A Memória do Mundo', type: 'text' },
      { key: 'type', value: 'Cosmologia', type: 'text' },
      { key: 'tags', value: ['cosmologia', 'leis-universais'], type: 'tags' },
      { key: 'aliases', value: ['Memória do Mundo'], type: 'list' },
      { key: 'status', value: 'Em desenvolvimento', type: 'text' },
      { key: 'published', value: false, type: 'checkbox' },
      { key: 'chapter', value: 3, type: 'number' },
      { key: 'created', value: '2026-11-07', type: 'date' },
      { key: 'updated', value: '2026-11-07T14:30', type: 'datetime' },
    ])
  })

  it('2. does not invent or insert frontmatter when opening a note without frontmatter', () => {
    const md = '# Nota Simples\n\nSem frontmatter aqui.\n---\nIsto é uma linha horizontal, não YAML.'
    const parsed = parseNoteDocument(md)

    expect(parsed.hasFrontmatter).toBe(false)
    expect(parsed.valid).toBe(true)
    expect(parsed.properties).toEqual([])
    expect(parsed.body).toBe(md)
  })

  it('3. preserves comments, key ordering, unknown properties, multiline strings, and exact body when updating a single property', () => {
    const md = [
      '---',
      '# Comentário importante no topo',
      'title: Cosmologia',
      'type: Conceito',
      'custom_multiline: |',
      '  Linha 1',
      '  Linha 2',
      'unknown_nested:',
      '  nested_key: valor',
      'tags:',
      '  - física',
      '---',
      '',
      '# Corpo Principal',
      '',
      'Texto intacto com [[Link]].',
    ].join('\n')

    const updated = setPropertyInMarkdown(md, 'type', 'Cosmologia', 'text')
    expect(updated).toContain('# Comentário importante no topo')
    expect(updated).toContain('custom_multiline: |\n  Linha 1\n  Linha 2')
    expect(updated).toContain('unknown_nested:\n  nested_key: valor')
    expect(updated.endsWith('\n# Corpo Principal\n\nTexto intacto com [[Link]].')).toBe(true)

    // Ensure no duplicate --- delimiters
    const delimiterMatches = updated.match(/^---$/gm)
    expect(delimiterMatches?.length).toBe(2)

    const reparsed = parseNoteDocument(updated)
    expect(reparsed.properties.map((p) => p.key)).toEqual([
      'title',
      'type',
      'custom_multiline',
      'unknown_nested',
      'tags',
    ])
    expect(reparsed.properties.find((p) => p.key === 'type')?.value).toBe('Cosmologia')
  })

  it('4. creates frontmatter cleanly when adding the first property to a note without YAML, and preserves CRLF line endings', () => {
    const md = '# Nota CRLF\r\n\r\nParágrafo original.\r\n'
    const withTitle = setPropertyInMarkdown(md, 'title', 'Nota CRLF', 'text')

    expect(withTitle.startsWith('---\r\ntitle: Nota CRLF\r\n---\r\n')).toBe(true)
    expect(withTitle.endsWith('# Nota CRLF\r\n\r\nParágrafo original.\r\n')).toBe(true)

    const parsed = parseNoteDocument(withTitle)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.properties).toEqual([{ key: 'title', value: 'Nota CRLF', type: 'text' }])
    expect(parsed.body).toBe('# Nota CRLF\r\n\r\nParágrafo original.\r\n')
  })

  it('5. supports removing, renaming, and reordering properties without corrupting YAML or body', () => {
    const md = [
      '---',
      'title: Original',
      'type: Rascunho',
      'status: Ativo',
      '---',
      '',
      'Corpo.',
    ].join('\n')

    const renamed = renamePropertyInMarkdown(md, 'status', 'estado')
    expect(parseNoteDocument(renamed).properties.map((p) => p.key)).toEqual(['title', 'type', 'estado'])
    expect(parseNoteDocument(renamed).properties.find((p) => p.key === 'estado')?.value).toBe('Ativo')

    const reordered = reorderPropertiesInMarkdown(renamed, ['estado', 'title', 'type'])
    expect(parseNoteDocument(reordered).properties.map((p) => p.key)).toEqual(['estado', 'title', 'type'])

    const removed = removePropertyFromMarkdown(reordered, 'type')
    expect(parseNoteDocument(removed).properties.map((p) => p.key)).toEqual(['estado', 'title'])
    expect(parseNoteDocument(removed).body).toBe('\nCorpo.')
  })

  it.each([
    ['Chapter', 'chapter'],
    ['chapter', 'CHAPTER'],
  ])('rejects renaming another property to a case-insensitive duplicate of %s', (existingKey, newKey) => {
    const markdown = `---\n${existingKey}: 3\nstatus: draft\n---\nBody`

    expect(renamePropertyInMarkdown(markdown, 'status', newKey)).toBe(markdown)
    expect(renamePropertyInMarkdownResult(markdown, 'status', newKey)).toEqual({
      ok: false,
      reason: 'PROPERTY_ALREADY_EXISTS',
    })
    expect(parseNoteDocument(markdown).properties.map(({ key }) => key)).toEqual([existingKey, 'status'])
  })

  it('allows changing only the casing of the same property key', () => {
    const markdown = '---\nChapter: 3\n---\nBody'
    const result = renamePropertyInMarkdownResult(markdown, 'Chapter', 'chapter')

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(result.markdown).toContain('chapter: 3')
    expect(parseNoteDocument(result.markdown).properties.map(({ key }) => key)).toEqual(['chapter'])
  })

  it('reports no-op, missing-key, invalid-name, and invalid-YAML rename outcomes explicitly', () => {
    const markdown = '---\nChapter: 3\n---\nBody'
    const invalidYaml = '---\nvalue: [broken\n---\nBody'

    expect(renamePropertyInMarkdownResult(markdown, 'Chapter', 'Chapter')).toEqual({ ok: true, changed: false })
    expect(renamePropertyInMarkdownResult(markdown, 'missing', 'newName')).toEqual({
      ok: false,
      reason: 'PROPERTY_NOT_FOUND',
    })
    expect(renamePropertyInMarkdownResult(markdown, 'Chapter', '   ')).toEqual({
      ok: false,
      reason: 'INVALID_PROPERTY_NAME',
    })
    expect(renamePropertyInMarkdownResult(invalidYaml, 'value', 'renamed')).toEqual({
      ok: false,
      reason: 'INVALID_YAML',
    })
    expect(renamePropertyInMarkdown(markdown, 'Chapter', 'Chapter')).toBe(markdown)
    expect(renamePropertyInMarkdown(markdown, 'missing', 'newName')).toBe(markdown)
    expect(renamePropertyInMarkdown(invalidYaml, 'value', 'renamed')).toBe(invalidYaml)
  })

  it('preserves comments, nested metadata, unsafe numbers, Unicode, CRLF, and Markdown body on rename', () => {
    const markdown = [
      '---',
      '# Important comment',
      'metadata:',
      '  nested:',
      '    count: 3',
      'large_id: 9007199254740993',
      'status: draft # Review later',
      '---',
      '',
      '[See](note.md)',
      '',
    ].join('\r\n')
    const result = renamePropertyInMarkdownResult(markdown, 'status', 'progrès')

    expect(result).toMatchObject({ ok: true, changed: true })
    expect(result.markdown).toContain('# Important comment')
    expect(result.markdown).toContain('progrès: draft # Review later')
    expect(result.markdown).toContain('large_id: 9007199254740993')
    expect(result.markdown).toContain('    count: 3')
    expect(result.markdown).toContain('\r\n[See](note.md)\r\n')
    expect(result.markdown.replace(/\r\n/g, '')).not.toContain('\n')
    expect(parseNoteDocument(result.markdown).properties.map(({ key }) => key)).toEqual([
      'metadata', 'large_id', 'progrès',
    ])
    expect(parseNoteDocument(result.markdown).body).toBe('\r\n[See](note.md)\r\n')
  })

  it('6. handles invalid YAML explicitly without throwing or losing the broken YAML or body', () => {
    const invalidMd = [
      '---',
      'title: [unclosed bracket',
      'tags: : invalid',
      '---',
      '',
      '# Corpo Seguro',
    ].join('\n')

    const parsed = parseNoteDocument(invalidMd)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.valid).toBe(false)
    expect(typeof parsed.error).toBe('string')
    expect(parsed.error.length).toBeGreaterThan(0)
    expect(parsed.rawYaml).toContain('title: [unclosed bracket')
    expect(parsed.body).toBe('\n# Corpo Seguro')

    // Updating the body while YAML is invalid still preserves the raw invalid YAML block untouched!
    const bodyEdited = updateBodyInMarkdown(invalidMd, '\n# Corpo Editado com Segurança')
    expect(bodyEdited).toContain('title: [unclosed bracket')
    expect(bodyEdited.endsWith('\n# Corpo Editado com Segurança')).toBe(true)

    // Fixing raw YAML restores validity
    const fixedMd = replaceRawYamlInMarkdown(bodyEdited, 'title: Corrigido\ntags:\n  - ok')
    const reparsed = parseNoteDocument(fixedMd)
    expect(reparsed.valid).toBe(true)
    expect(reparsed.properties).toEqual([
      { key: 'title', value: 'Corrigido', type: 'text' },
      { key: 'tags', value: ['ok'], type: 'tags' },
    ])
    expect(reparsed.body).toBe('\n# Corpo Editado com Segurança')
  })

  it('7. supports properties containing internal wikilinks and Unicode values', () => {
    const md = '---\ntitle: Nota\n---\n\nCorpo'
    const withRelated = setPropertyInMarkdown(
      md,
      'related',
      ['[[Cosmologia]]', '[[Física Quântica|Física]]'],
      'list'
    )

    const parsed = parseNoteDocument(withRelated)
    expect(parsed.valid).toBe(true)
    expect(parsed.properties.find((p) => p.key === 'related')).toEqual({
      key: 'related',
      value: ['[[Cosmologia]]', '[[Física Quântica|Física]]'],
      type: 'list',
    })
  })

  it('8. reuses known vault property types and coerces values safely across types', () => {
    expect(inferPropertyType('rating', '5', { rating: 'number' })).toBe('number')
    expect(coercePropertyValue('42', 'number')).toBe(42)
    expect(coercePropertyValue('true', 'checkbox')).toBe(true)
    expect(coercePropertyValue('a, b', 'list')).toEqual(['a', 'b'])
    expect(coercePropertyValue(['#cosmologia', 'leis-universais'], 'tags')).toEqual([
      'cosmologia',
      'leis-universais',
    ])
  })

  it('9. builds default frontmatter for newly created notes', () => {
    const initial = buildInitialNoteContent('Cosmologia - A Memória do Mundo')
    expect(initial).toBe('---\ntitle: Cosmologia - A Memória do Mundo\ntags: []\n---\n\n')
    const parsed = parseNoteDocument(initial)
    expect(parsed.hasFrontmatter).toBe(true)
    expect(parsed.valid).toBe(true)
    expect(parsed.properties).toEqual([
      { key: 'title', value: 'Cosmologia - A Memória do Mundo', type: 'text' },
      { key: 'tags', value: [], type: 'tags' },
    ])
  })

  it('10. extracts tags from frontmatter and Markdown body while ignoring code blocks, links, headings, and invalid tags with spaces', () => {
    expect(validateTagName('cosmologia')).toBe('cosmologia')
    expect(validateTagName('#conhecimento/filosofia')).toBe('conhecimento/filosofia')
    expect(validateTagName('tag com espaço')).toBeNull()
    expect(validateTagName('12345')).toBeNull()

    const md = [
      '---',
      'tags:',
      '  - Cosmologia',
      '  - leis-universais',
      '---',
      '# Título não é tag',
      '',
      'Estudando #cosmologia e #conhecimento/filosofia no texto.',
      'Link com âncora [[Nota#Seção]] e [Link](url#ancora) não são tags.',
      'Código inline `#nao-eh-tag` também é ignorado.',
      '```js',
      '// #tambem-nao-eh-tag',
      'const x = "#ignorado"',
      '```',
    ].join('\n')

    const bodyTags = extractBodyTags( parseNoteDocument(md).body )
    expect(bodyTags).toEqual(['cosmologia', 'conhecimento/filosofia'])

    // Case-insensitive deduplication between frontmatter 'Cosmologia' and body '#cosmologia'
    const allTags = extractAllNoteTags(md)
    expect(allTags).toEqual(['Cosmologia', 'leis-universais', 'conhecimento/filosofia'])

    // Hierarchical and case-insensitive matching
    expect(matchesTagQuery(allTags, 'cosmologia')).toBe(true)
    expect(matchesTagQuery(allTags, '#COSMOLOGIA')).toBe(true)
    expect(matchesTagQuery(allTags, 'conhecimento')).toBe(true)
    expect(matchesTagQuery(allTags, 'conhecimento/filosofia')).toBe(true)
    expect(matchesTagQuery(allTags, 'nao-eh-tag')).toBe(false)
  })

  it('11. renders PropertiesPanel matching Obsidian layout: title, type, tag chips with remove and click, + Add property, internal links in properties, and raw YAML toggle', async () => {
    let currentMd = [
      '---',
      'title: Cosmologia - A Memória do Mundo',
      'type: Cosmologia',
      'tags:',
      '  - cosmologia',
      '  - leis-universais',
      'related:',
      '  - "[[Física]]"',
      '---',
      '',
      '# Corpo',
    ].join('\n')

    const wrapper = mount(PropertiesPanel, {
      props: {
        markdown: currentMd,
        knownPropertyNames: ['title', 'type', 'tags', 'aliases', 'status'],
        knownPropertyTypes: { status: 'text' },
        'onUpdate:markdown': async (next) => {
          currentMd = next
          await wrapper.setProps({ markdown: currentMd })
        },
      },
    })

    expect(wrapper.find('[data-testid="properties-panel"]').exists()).toBe(true)
    const rows = wrapper.findAll('[data-testid="property-row"]')
    expect(rows.length).toBe(4)

    // Tag chips rendered with remove buttons
    const tagChips = wrapper.findAll('[data-testid="property-tag-chip"]')
    expect(tagChips.map((c) => c.attributes('data-tag'))).toEqual(['cosmologia', 'leis-universais'])

    // Clicking a tag chip emits select-tag
    await tagChips[0].trigger('click')
    expect(wrapper.emitted('select-tag')?.[0]).toEqual(['cosmologia'])

    // Removing a tag chip updates YAML
    await wrapper.find('[data-testid="remove-tag-button"][data-tag="cosmologia"]').trigger('click')
    expect(parseNoteDocument(currentMd).properties.find((p) => p.key === 'tags')?.value).toEqual([
      'leis-universais',
    ])

    // Adding a new tag via input
    const addTagInput = wrapper.find('[data-testid="add-tag-input"]')
    await addTagInput.setValue('conhecimento/filosofia')
    await addTagInput.trigger('keydown.enter')
    expect(parseNoteDocument(currentMd).properties.find((p) => p.key === 'tags')?.value).toEqual([
      'leis-universais',
      'conhecimento/filosofia',
    ])

    // Clicking an internal link chip inside a list property emits open-link
    const linkChip = wrapper.find('[data-testid="property-list-chip"][data-is-link="true"]')
    expect(linkChip.exists()).toBe(true)
    await linkChip.trigger('click')
    expect(wrapper.emitted('open-link')?.[0]?.[0]).toMatchObject({
      rawTarget: '[[Física]]',
      kind: 'wikilink',
    })

    // Adding a new property via + Add property
    await wrapper.find('[data-testid="add-property-button"]').trigger('click')
    await wrapper.find('[data-testid="new-property-key-input"]').setValue('status')
    await wrapper.find('[data-testid="new-property-value-input"]').setValue('Revisado')
    await wrapper.find('[data-testid="new-property-submit"]').trigger('click')
    expect(parseNoteDocument(currentMd).properties.find((p) => p.key === 'status')?.value).toBe('Revisado')

    // Toggle to raw YAML mode and back
    await wrapper.find('[data-testid="toggle-yaml-source-button"]').trigger('click')
    expect(wrapper.find('[data-testid="raw-yaml-textarea"]').exists()).toBe(true)
  })

  it('12. preserves mixed CRLF and LF line endings in untouched regions when updating body or properties', () => {
    // Body with mixed CRLF on line 1, LF on line 2, CRLF on line 3
    const mixedBody = '\nLinha 1\r\nLinha 2\nLinha 3\r\n'
    const docWithMixed = `---\ntitle: Nota\ntags: []\n---${mixedBody}`

    // 1. Updating a single word on line 2 (CodeMirror delivers newline-normalized text)
    const nextBodyFromEditor = '\nLinha 1\nLinha 2 modificada\nLinha 3\n'
    const updated = updateBodyInMarkdown(docWithMixed, nextBodyFromEditor)

    // Prefix line 1 must still have \r\n, suffix line 3 must still have \r\n
    expect(updated).toContain('Linha 1\r\n')
    expect(updated).toContain('Linha 2 modificada\n')
    expect(updated).toContain('Linha 3\r\n')

    // 2. Editing frontmatter property must preserve the mixed body byte-for-byte
    const propUpdated = setPropertyInMarkdown(docWithMixed, 'status', 'ativo')
    expect(propUpdated.endsWith(mixedBody)).toBe(true)
  })

  it('13. uses a dark readable type selector without changing YAML until a valid type is selected', async () => {
    let currentMd = '---\nchapter: "3"\n---\n\nBody'
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: currentMd, 'onUpdate:markdown': (value) => { currentMd = value } },
    })
    const selector = wrapper.find('[data-testid="property-type-select"]')
    expect(selector.exists()).toBe(true)
    expect(selector.classes()).toContain('property-type-select')
    expect(selector.findAll('option').map((option) => option.text().trim())).toEqual([
      'Text', 'List', 'Number', 'Checkbox', 'Date', 'Date & time', 'Tags',
    ])
    expect(currentMd).toBe('---\nchapter: "3"\n---\n\nBody')

    await selector.setValue('number')
    expect(currentMd).toContain('chapter: 3')
  })

  it('14. rejects lossy property type conversion and preserves the prior value', async () => {
    let currentMd = '---\nchapter: many\n---\n\nBody'
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: currentMd, 'onUpdate:markdown': (value) => { currentMd = value } },
    })
    await wrapper.find('[data-testid="property-type-select"]').setValue('number')

    expect(currentMd).toBe('---\nchapter: many\n---\n\nBody')
    expect(wrapper.find('[role="alert"]').text()).toContain('preserved')
  })

  it('preserves incompatible known property values and nested YAML structures', () => {
    const markdown = [
      '---',
      'chapter: many',
      'published: perhaps',
      'created: yesterday',
      'custom:',
      '  nested:',
      '    value: preserved',
      '---',
      'Body',
    ].join('\n')
    const parsed = parseNoteDocument(markdown, {
      chapter: 'number',
      published: 'checkbox',
      created: 'date',
      custom: 'list',
    })

    expect(parsed.properties).toEqual([
      { key: 'chapter', value: 'many', type: 'text' },
      { key: 'published', value: 'perhaps', type: 'text' },
      { key: 'created', value: 'yesterday', type: 'text' },
      { key: 'custom', value: { nested: { value: 'preserved' } }, type: 'text' },
    ])
    expect(markdown).toContain('chapter: many')
  })

  it('can suggest Number for a numeric string without changing the source value', () => {
    const markdown = '---\nchapter: "3"\n---\nBody'
    const parsed = parseNoteDocument(markdown, { chapter: 'number' })

    expect(parsed.properties).toEqual([{ key: 'chapter', value: 3, type: 'number' }])
    expect(markdown).toBe('---\nchapter: "3"\n---\nBody')
  })

  it('rejects an invalid date type without changing its YAML value', async () => {
    let currentMd = '---\ncreated: yesterday\n---\nBody'
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: currentMd, 'onUpdate:markdown': (value) => { currentMd = value } },
    })

    await wrapper.find('[data-testid="property-type-select"]').setValue('date')

    expect(currentMd).toBe('---\ncreated: yesterday\n---\nBody')
    expect(wrapper.find('[data-testid="property-type-error"]').text()).toContain('preserved')
  })

  it('never converts an invalid number to a fallback value', () => {
    let error
    try {
      coercePropertyValue('many', 'number')
    } catch (caught) {
      error = caught
    }

    expect(error?.code).toBe('INVALID_PROPERTY_NUMBER')
  })

  it.each([
    [0, { ok: true, value: 0 }],
    ['42', { ok: true, value: 42 }],
    ['-15', { ok: true, value: -15 }],
    ['3.14', { ok: true, value: 3.14 }],
    ['1e3', { ok: true, value: 1000 }],
    ['1000', { ok: true, value: 1000 }],
    ['1000.0', { ok: true, value: 1000 }],
    ['0.1', { ok: true, value: 0.1 }],
    ['-15.75', { ok: true, value: -15.75 }],
    ['1.5e2', { ok: true, value: 150 }],
    ['0.000001', { ok: true, value: 0.000001 }],
    ['9007199254740991', { ok: true, value: Number.MAX_SAFE_INTEGER }],
    ['-9007199254740991', { ok: true, value: Number.MIN_SAFE_INTEGER }],
    ['-0', { ok: true, value: -0 }],
    ['0.0', { ok: true, value: 0 }],
    ['0e100', { ok: true, value: 0 }],
    ['', { ok: false, reason: 'EMPTY' }],
    [' ', { ok: false, reason: 'EMPTY' }],
    ['-', { ok: false, reason: 'INCOMPLETE' }],
    ['.', { ok: false, reason: 'INCOMPLETE' }],
    ['1e', { ok: false, reason: 'INCOMPLETE' }],
    ['many', { ok: false, reason: 'INVALID' }],
    ['Infinity', { ok: false, reason: 'INVALID' }],
    ['NaN', { ok: false, reason: 'INVALID' }],
    ['1e9999', { ok: false, reason: 'OVERFLOW' }],
    ['1e-9999', { ok: false, reason: 'UNDERFLOW' }],
    ['-1e-9999', { ok: false, reason: 'UNDERFLOW' }],
    ['1e-324', { ok: false, reason: 'UNDERFLOW' }],
    ['9007199254740992', { ok: false, reason: 'UNSAFE_INTEGER' }],
    ['-9007199254740992', { ok: false, reason: 'UNSAFE_INTEGER' }],
    ['9007199254740993', { ok: false, reason: 'UNSAFE_INTEGER' }],
    ['9.007199254740993e15', { ok: false, reason: 'UNSAFE_INTEGER' }],
    ['0.123456789012345678901', { ok: false, reason: 'PRECISION_LOSS' }],
    ['1.234567890123456789', { ok: false, reason: 'PRECISION_LOSS' }],
    ['9007199254740990.5', { ok: false, reason: 'PRECISION_LOSS' }],
  ])('parses numeric input explicitly: %s', (input, expected) => {
    expect(parsePropertyNumber(input)).toEqual(expected)
  })

  it('preserves unsafe numeric scalars as their exact YAML text during unrelated edits', () => {
    const markdown = '---\nlarge_id: 9007199254740993\nsmall: 1e-9999\nprecise: 0.123456789012345678901\ncustom:\n  nested_id: 9007199254740993\nstatus: draft\n---\nBody'
    const parsed = parseNoteDocument(markdown, {
      large_id: 'number',
      small: 'number',
      precise: 'number',
    })
    expect(parsed.properties.slice(0, 3)).toEqual([
      { key: 'large_id', value: '9007199254740993', type: 'text' },
      { key: 'small', value: '1e-9999', type: 'text' },
      { key: 'precise', value: '0.123456789012345678901', type: 'text' },
    ])

    const updated = setPropertyInMarkdown(markdown, 'status', 'reviewed', 'text')
    expect(updated).toContain('large_id: 9007199254740993')
    expect(updated).toContain('small: 1e-9999')
    expect(updated).toContain('precise: 0.123456789012345678901')
    expect(updated).toContain('nested_id: 9007199254740993')
    expect(updated).toContain('status: reviewed')

    const renamed = renamePropertyInMarkdown(updated, 'status', 'state')
    const reordered = reorderPropertiesInMarkdown(
      renamed,
      parseNoteDocument(renamed).properties.map((property) => property.key).reverse()
    )
    const removed = removePropertyFromMarkdown(reordered, 'state')
    const added = addPropertyToMarkdown(removed, 'rating', 4.5, 'number')
    expect(added.ok).toBe(true)
    expect(added.markdown).toContain('large_id: 9007199254740993')
    expect(added.markdown).toContain('small: 1e-9999')
    expect(added.markdown).toContain('precise: 0.123456789012345678901')
    expect(added.markdown).toContain('nested_id: 9007199254740993')
  })

  it('keeps a numeric draft after unrelated changes and confirms against the latest Markdown', async () => {
    const initial = '---\nchapter: 42\nstatus: draft\n---\nBody'
    const wrapper = mount(PropertiesPanel, { props: { markdown: initial } })
    const input = wrapper.find('[data-testid="property-number-input"]')
    await input.setValue('-15')
    await wrapper.setProps({ markdown: '---\nchapter: 42\nstatus: reviewed\n---\nBody' })

    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    await wrapper.find('[data-testid="property-number-input"]').trigger('keydown.enter')

    const updated = parseNoteDocument(wrapper.emitted('update:markdown')[0][0])
    expect(updated.properties.find((property) => property.key === 'chapter')?.value).toBe(-15)
    expect(updated.properties.find((property) => property.key === 'status')?.value).toBe('reviewed')
  })

  it('keeps independent Number drafts when another Number is confirmed', async () => {
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: '---\nchapter: 42\nrating: 5\n---\nBody' },
    })
    const rows = wrapper.findAll('[data-testid="property-row"]')
    await rows[0].find('[data-testid="property-number-input"]').setValue('-15')
    await rows[1].find('[data-testid="property-number-input"]').setValue('7')
    await rows[1].find('[data-testid="property-number-input"]').trigger('keydown.enter')
    const ratingUpdate = wrapper.emitted('update:markdown')[0][0]
    await wrapper.setProps({ markdown: ratingUpdate })

    expect(wrapper.find('[data-property-key="chapter"] [data-testid="property-number-input"]').element.value).toBe('-15')
    await wrapper.find('[data-property-key="chapter"] [data-testid="property-number-input"]').trigger('keydown.enter')
    const final = parseNoteDocument(wrapper.emitted('update:markdown')[1][0])
    expect(final.properties.find((property) => property.key === 'chapter')?.value).toBe(-15)
    expect(final.properties.find((property) => property.key === 'rating')?.value).toBe(7)
  })

  it('keeps a Number draft when a tag is changed and preserves the tag on confirmation', async () => {
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: '---\nchapter: 42\ntags: []\n---\nBody' },
    })
    await wrapper.find('[data-property-key="chapter"] [data-testid="property-number-input"]').setValue('-15')
    const tagInput = wrapper.find('[data-property-key="tags"] [data-testid="add-tag-input"]')
    await tagInput.setValue('science')
    await tagInput.trigger('keydown.enter')
    await wrapper.setProps({ markdown: wrapper.emitted('update:markdown')[0][0] })

    const chapter = wrapper.find('[data-property-key="chapter"] [data-testid="property-number-input"]')
    expect(chapter.element.value).toBe('-15')
    await chapter.trigger('keydown.enter')
    const updated = parseNoteDocument(wrapper.emitted('update:markdown')[1][0])
    expect(updated.properties.find((property) => property.key === 'chapter')?.value).toBe(-15)
    expect(updated.properties.find((property) => property.key === 'tags')?.value).toEqual(['science'])
  })

  it('preserves a Number draft and validation error after a body-only update', async () => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 42\n---\n\nOld body' } })
    const input = wrapper.find('[data-testid="property-number-input"]')
    await input.setValue('many')
    await input.trigger('blur')
    await wrapper.setProps({ markdown: '---\nchapter: 42\n---\n\nNew body' })

    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('many')
    expect(wrapper.find('[data-testid="property-number-error"]').exists()).toBe(true)
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
  })

  it('copies and restores Number drafts without Markdown updates, recalculating confirmed-value conflicts', async () => {
    const content = '---\nchapter: 42\n---\nBody'
    const source = mount(PropertiesPanel, { props: { markdown: content } })
    const input = source.find('[data-testid="property-number-input"]')
    await input.setValue('-')
    await input.trigger('blur')

    const snapshot = source.vm.getPendingEditSnapshot()
    snapshot.numberDrafts.chapter.text = 'mutated copy'
    expect(source.find('[data-testid="property-number-input"]').element.value).toBe('-')

    const destination = mount(PropertiesPanel, {
      props: { markdown: content, confirmedMarkdown: '---\nchapter: 100\n---\nBody' },
    })
    const restored = source.vm.getPendingEditSnapshot()
    expect(restored.numberDrafts.chapter.text).toBe('-')
    expect(destination.vm.restorePendingEditSnapshot(restored)).toBe(true)
    await destination.vm.$nextTick()

    expect(destination.find('[data-testid="property-number-input"]').element.value).toBe('-')
    expect(destination.find('[data-testid="property-number-error"]').text()).toContain('changed while you were editing')
    expect(destination.emitted('update:markdown')).toBeUndefined()
    expect(destination.emitted('pending-change').at(-1)).toEqual([true])
  })

  it('keeps a draft visible but refuses to overwrite a concurrently changed Number', async () => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 42\n---\nBody' } })
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    await wrapper.setProps({ markdown: '---\nchapter: 100\n---\nBody' })

    const input = wrapper.find('[data-testid="property-number-input"]')
    expect(input.element.value).toBe('-15')
    expect(wrapper.find('[data-testid="property-number-error"]').text()).toContain('changed while you were editing')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    expect(wrapper.props('markdown')).toBe('---\nchapter: 100\n---\nBody')
  })

  it.each([
    ['removed', '---\nstatus: draft\n---\nBody'],
    ['changed type', '---\nchapter: forty-two\nstatus: draft\n---\nBody'],
  ])('preserves a Number draft as a recoverable conflict when its property is %s', async (_change, markdown) => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 42\nstatus: draft\n---\nBody' } })
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    await wrapper.setProps({ markdown })

    expect(wrapper.find('[data-testid="pending-number-conflict"]').text()).toContain('-15')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    await wrapper.find('[data-testid="cancel-number-conflict"]').trigger('click')
    expect(wrapper.find('[data-testid="pending-number-conflict"]').exists()).toBe(false)
  })

  it('keeps a pending Number draft separate when its property is renamed', async () => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 42\n---\nBody' } })
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    const keyInput = wrapper.find('[data-property-key="chapter"] [data-testid="property-key-input"]')
    await keyInput.setValue('section')
    await keyInput.trigger('keydown.enter')
    await wrapper.setProps({ markdown: wrapper.emitted('update:markdown')[0][0] })

    expect(wrapper.find('[data-testid="pending-number-conflict"]').text()).toContain('-15')
    expect(parseNoteDocument(wrapper.props('markdown')).properties[0]).toEqual({
      key: 'section', value: 42, type: 'number',
    })
    await wrapper.find('[data-property-key="section"] [data-testid="property-number-input"]').trigger('keydown.enter')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    await wrapper.find('[data-testid="cancel-number-conflict"]').trigger('click')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
  })

  it('does not emit for an exact same-name confirmation', async () => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nChapter: 3\n---\nBody' } })
    const input = wrapper.find('[data-testid="property-key-input"]')

    await input.setValue('Chapter')
    await input.trigger('keydown.enter')

    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    expect(wrapper.find('[data-testid="property-key-error"]').exists()).toBe(false)
    expect(input.element.value).toBe('Chapter')
  })

  it('moves a local type override with its property key after a successful rename', async () => {
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: '---\ncreated: "2026-11-08"\n---\nBody' },
    })
    await wrapper.find('[data-testid="property-type-select"]').setValue('text')
    await wrapper.setProps({ markdown: wrapper.emitted('update:markdown')[0][0] })
    expect(wrapper.find('[data-testid="property-type-select"]').element.value).toBe('text')

    const keyInput = wrapper.find('[data-testid="property-key-input"]')
    await keyInput.setValue('dateText')
    await keyInput.trigger('keydown.enter')
    await wrapper.setProps({ markdown: wrapper.emitted('update:markdown')[1][0] })

    expect(wrapper.find('[data-property-key="dateText"] [data-testid="property-type-select"]').element.value).toBe('text')
  })

  it('shows a rename collision beside the key and lets the user correct it without losing the value', async () => {
    const markdown = '---\nChapter: 3\nstatus: draft\n---\nBody'
    const wrapper = mount(PropertiesPanel, { props: { markdown } })
    const input = wrapper.find('[data-property-key="status"] [data-testid="property-key-input"]')

    await input.setValue('chapter')
    await input.trigger('keydown.enter')

    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    expect(wrapper.props('markdown')).toBe(markdown)
    expect(input.element.value).toBe('chapter')
    expect(wrapper.find('[data-testid="property-key-error"]').text()).toContain('already exists')
    expect(wrapper.find('[data-testid="property-key-error"]').attributes('role')).toBe('alert')

    await input.setValue('progress')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    const renamed = wrapper.emitted('update:markdown')[0][0]
    expect(parseNoteDocument(renamed).properties.map(({ key }) => key)).toEqual(['Chapter', 'progress'])
    expect(parseNoteDocument(renamed).properties.find(({ key }) => key === 'progress')?.value).toBe('draft')
    await wrapper.setProps({ markdown: renamed })
    await wrapper.find('[data-property-key="progress"] [data-testid="property-key-input"]').trigger('blur')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
  })

  it('cancels a rejected rename with Escape and commits a valid rename on blur only once', async () => {
    const markdown = '---\nChapter: 3\nstatus: draft\n---\nBody'
    const wrapper = mount(PropertiesPanel, { props: { markdown } })
    const input = wrapper.find('[data-property-key="status"] [data-testid="property-key-input"]')

    await input.setValue('chapter')
    await input.trigger('keydown.enter')
    await input.trigger('keydown.esc')
    expect(input.element.value).toBe('status')
    expect(wrapper.find('[data-testid="property-key-error"]').exists()).toBe(false)
    expect(wrapper.emitted('update:markdown')).toBeUndefined()

    await input.setValue('progress')
    await input.trigger('blur')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    await wrapper.setProps({ markdown: wrapper.emitted('update:markdown')[0][0] })
    await wrapper.find('[data-property-key="progress"] [data-testid="property-key-input"]').trigger('blur')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
  })

  it.each(['1e-9999', '9007199254740993', '0.123456789012345678901'])(
    'rejects unsafe Number edit %s without emitting Markdown',
    async (value) => {
      const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 42\n---\nBody' } })
      const input = wrapper.find('[data-testid="property-number-input"]')
      await input.setValue(value)
      await input.trigger('keydown.enter')

      expect(wrapper.emitted('update:markdown')).toBeUndefined()
      expect(input.element.value).toBe(value)
      expect(wrapper.find('[data-testid="property-number-error"]').text()).toContain('valid number')
    }
  )

  it('keeps numeric edits local until Enter confirms a valid number', async () => {
    const markdown = '---\nchapter: 42\n---\nBody'
    const wrapper = mount(PropertiesPanel, { props: { markdown } })
    const input = wrapper.find('[data-testid="property-number-input"]')

    expect(input.attributes('type')).toBe('text')
    await input.setValue('')
    expect(input.element.value).toBe('')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()

    await input.setValue('-')
    expect(input.element.value).toBe('-')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()

    await input.setValue('-15')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    await input.trigger('keydown.enter')

    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    expect(parseNoteDocument(wrapper.emitted('update:markdown')[0][0]).properties[0].value).toBe(-15)
  })

  it('keeps an incomplete decimal local and accepts decimal values and zero on confirmation', async () => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 3\n---\nBody' } })
    const input = wrapper.find('[data-testid="property-number-input"]')

    await input.setValue('')
    await input.setValue('3.')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    await input.setValue('3.14')
    await input.trigger('keydown.enter')
    expect(parseNoteDocument(wrapper.emitted('update:markdown')[0][0]).properties[0].value).toBe(3.14)

    await wrapper.setProps({ markdown: '---\nchapter: 42\n---\nBody' })
    const zeroInput = wrapper.find('[data-testid="property-number-input"]')
    await zeroInput.setValue('0')
    await zeroInput.trigger('keydown.enter')
    expect(parseNoteDocument(wrapper.emitted('update:markdown')[1][0]).properties[0].value).toBe(0)
  })

  it('cancels an unconfirmed number draft with Escape and ignores disabled edits', async () => {
    const markdown = '---\nchapter: 42\n---\nBody'
    const wrapper = mount(PropertiesPanel, { props: { markdown } })
    const input = wrapper.find('[data-testid="property-number-input"]')

    await input.setValue('-')
    await input.trigger('keydown.esc')
    expect(input.element.value).toBe('42')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()

    await wrapper.setProps({ disabled: true })
    await input.setValue('9')
    await input.trigger('keydown.enter')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
  })

  it('commits valid numeric drafts on blur once and leaves invalid drafts uncommitted', async () => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\nchapter: 42\n---\nBody' } })
    const input = wrapper.find('[data-testid="property-number-input"]')

    await input.trigger('blur')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()

    await input.setValue('many')
    await input.trigger('blur')
    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    expect(wrapper.find('[data-testid="property-number-error"]').text()).toContain('valid number')
    expect(input.attributes('aria-invalid')).toBe('true')

    await input.setValue('-15')
    await input.trigger('blur')
    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    expect(parseNoteDocument(wrapper.emitted('update:markdown')[0][0]).properties[0].value).toBe(-15)
  })

  it('adds a valid numeric property once and rejects invalid YAML without changing its source', async () => {
    const wrapper = mount(PropertiesPanel, {
      props: { markdown: '---\r\ntitle: Note\r\n---\r\n\r\nBody\r\n' },
    })
    await wrapper.find('[data-testid="add-property-button"]').trigger('click')
    await wrapper.find('[data-testid="new-property-key-input"]').setValue('rating')
    await wrapper.find('[data-testid="new-property-type-select"]').setValue('number')
    await wrapper.find('[data-testid="new-property-value-input"]').setValue('4.5')
    await wrapper.find('[data-testid="new-property-submit"]').trigger('click')

    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    const added = wrapper.emitted('update:markdown')[0][0]
    expect(parseNoteDocument(added).properties.find((property) => property.key === 'rating')).toEqual({
      key: 'rating', value: 4.5, type: 'number',
    })

    const invalid = '---\ntitle: [broken\n---\n\nBody\n'
    expect(addPropertyToMarkdown(invalid, 'rating', 4.5, 'number')).toEqual({
      ok: false,
      reason: 'INVALID_YAML',
    })
    expect(invalid).toBe('---\ntitle: [broken\n---\n\nBody\n')
  })

  it.each([
    ['list', 'related', 'one, two', ['one', 'two']],
    ['tags', 'tags', 'one, two', ['one', 'two']],
    ['date', 'created', '2026-11-08', '2026-11-08'],
    ['checkbox', 'published', 'false', false],
    ['text', 'html', '<img src=x onerror=alert(1)>', '<img src=x onerror=alert(1)>'],
  ])('preserves Add property semantics for %s values', async (type, key, value, expected) => {
    const wrapper = mount(PropertiesPanel, { props: { markdown: '---\ntitle: Note\n---\nBody' } })
    await wrapper.find('[data-testid="add-property-button"]').trigger('click')
    await wrapper.find('[data-testid="new-property-key-input"]').setValue(key)
    await wrapper.find('[data-testid="new-property-type-select"]').setValue(type)
    await wrapper.find('[data-testid="new-property-value-input"]').setValue(value)
    await wrapper.find('[data-testid="new-property-submit"]').trigger('click')

    expect(wrapper.emitted('update:markdown')).toHaveLength(1)
    expect(parseNoteDocument(wrapper.emitted('update:markdown')[0][0]).properties.find((p) => p.key === key)?.value).toEqual(expected)
    expect(wrapper.find('img').exists()).toBe(false)
  })

  it.each([
    ['tags', 'tags', 'bad:tag'],
    ['date', 'created', 'yesterday'],
    ['checkbox', 'published', 'perhaps'],
  ])('rejects incompatible Add property %s values', async (type, key, value) => {
    const markdown = '---\ntitle: Note\n---\nBody'
    const wrapper = mount(PropertiesPanel, { props: { markdown } })
    await wrapper.find('[data-testid="add-property-button"]').trigger('click')
    await wrapper.find('[data-testid="new-property-key-input"]').setValue(key)
    await wrapper.find('[data-testid="new-property-type-select"]').setValue(type)
    await wrapper.find('[data-testid="new-property-value-input"]').setValue(value)
    await wrapper.find('[data-testid="new-property-submit"]').trigger('click')

    expect(wrapper.emitted('update:markdown')).toBeUndefined()
    expect(wrapper.props('markdown')).toBe(markdown)
    expect(wrapper.find('[data-testid="property-add-error"]').attributes('role')).toBe('alert')
  })

  it.each(['many', '', '1e9999', '1e-9999', '9007199254740993', '0.123456789012345678901'])(
    'rejects invalid Add property number %j without changing the form or exact YAML',
    async (value) => {
      const markdown = '---\r\n# Keep this comment\r\ntitle: Note\r\nchapter: 42\r\ncustom:\r\n  nested: value\r\n---\r\n\r\n# Body\r\n'
      const wrapper = mount(PropertiesPanel, { props: { markdown } })
      await wrapper.find('[data-testid="add-property-button"]').trigger('click')
      await wrapper.find('[data-testid="new-property-key-input"]').setValue('rating')
      await wrapper.find('[data-testid="new-property-type-select"]').setValue('number')
      await wrapper.find('[data-testid="new-property-value-input"]').setValue(value)
      await wrapper.find('[data-testid="new-property-submit"]').trigger('click')

      expect(wrapper.emitted('update:markdown')).toBeUndefined()
      expect(wrapper.props('markdown')).toBe(markdown)
      expect(wrapper.find('[data-testid="new-property-key-input"]').element.value).toBe('rating')
      expect(wrapper.find('[data-testid="new-property-value-input"]').element.value).toBe(value)
      expect(wrapper.find('[data-testid="property-add-error"]').text()).toContain('valid number')
      expect(markdown).toBe('---\r\n# Keep this comment\r\ntitle: Note\r\nchapter: 42\r\ncustom:\r\n  nested: value\r\n---\r\n\r\n# Body\r\n')
    }
  )

  it.each(['chapter', 'Chapter'])(
    'rejects Add property for an existing key regardless of casing: %s',
    async (duplicateKey) => {
      const markdown = '---\n# Keep this comment\nChapter: 42\ntags:\n  - astronomy\naliases:\n  - Cosmos\ncustom:\n  nested: value\n---\n\n# Body\n\nSee [[Link]].\n'
      const wrapper = mount(PropertiesPanel, { props: { markdown } })
      await wrapper.find('[data-testid="add-property-button"]').trigger('click')
      await wrapper.find('[data-testid="new-property-key-input"]').setValue(duplicateKey)
      await wrapper.find('[data-testid="new-property-value-input"]').setValue('100')
      await wrapper.find('[data-testid="new-property-submit"]').trigger('click')

      expect(wrapper.emitted('update:markdown')).toBeUndefined()
      expect(wrapper.props('markdown')).toBe(markdown)
      expect(wrapper.find('[data-testid="new-property-key-input"]').element.value).toBe(duplicateKey)
      expect(wrapper.find('[data-testid="new-property-value-input"]').element.value).toBe('100')
      expect(wrapper.find('[data-testid="property-add-error"]').text()).toContain('already exists')
      expect(markdown).toBe('---\n# Keep this comment\nChapter: 42\ntags:\n  - astronomy\naliases:\n  - Cosmos\ncustom:\n  nested: value\n---\n\n# Body\n\nSee [[Link]].\n')
    }
  )
})
