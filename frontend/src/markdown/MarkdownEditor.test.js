import { describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownEditor from './MarkdownEditor.vue'
import editorRaw from './MarkdownEditor.vue?raw'

describe('MarkdownEditor.vue (CodeMirror 6 Live Preview)', () => {
  it('1. renders a single CodeMirror 6 surface without a separate preview HTML pane or textarea', () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '# Meu título\n\nTexto com **destaque**.',
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })

    expect(wrapper.find('.cm-editor').exists()).toBe(true)
    expect(wrapper.find('.cm-content[contenteditable="true"]').exists()).toBe(true)
    expect(wrapper.find('textarea').exists()).toBe(false)
  })

  it('2. reveals heading syntax while typing on the heading line and applies clean visual formatting when cursor leaves the line, restoring syntax when cursor returns', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '',
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })

    // Type heading on line 1 + newline to line 2
    wrapper.vm.setText('# Meu título\nSegunda linha')
    // Position cursor on line 1 (inside heading)
    wrapper.vm.setCursor(2)
    await wrapper.vm.$nextTick()

    const linesAtLine1 = wrapper.findAll('.cm-line')
    // While cursor is on line 1, '# ' syntax is accessible in the line DOM
    expect(linesAtLine1[0].text()).toContain('# Meu título')

    // Move cursor to line 2 (outside heading line)
    wrapper.vm.setCursor('# Meu título\n'.length + 2)
    await wrapper.vm.$nextTick()

    const linesAtLine2 = wrapper.findAll('.cm-line')
    // '# ' prefix is hidden by Decoration.replace when cursor is on line 2
    expect(linesAtLine2[0].text()).toBe('Meu título')

    // Move cursor back to line 1 -> '# ' syntax returns
    wrapper.vm.setCursor(4)
    await wrapper.vm.$nextTick()
    expect(wrapper.findAll('.cm-line')[0].text()).toContain('# Meu título')
    // Underlying Markdown source is always untouched
    expect(wrapper.vm.getText()).toBe('# Meu título\nSegunda linha')
  })

  it('3. formats bold, italic, strikethrough, inline code, fenced code blocks, lists, checklists, blockquotes, horizontal rules, markdown links, wikilinks, and tables in Live Preview', async () => {
    const doc = [
      '# H1',
      '## H2',
      '### H3',
      'Texto com **negrito**, *itálico*, ~~riscado~~ e `código`.',
      '- Item não ordenado',
      '1. Item ordenado',
      '- [ ] Tarefa pendente',
      '- [x] Tarefa concluída',
      '> Citação importante',
      '---',
      'Veja [[Projects/Roadmap|Roadmap do projeto]] e [Design](./Design.md).',
      '```js',
      'const x = 1;',
      '```',
      '| Col A | Col B |',
      '| ----- | ----- |',
      '| Val 1 | Val 2 |',
      'Linha final para posicionar o cursor.',
    ].join('\n')

    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: doc,
        sourcePath: 'Projects/Notes.md',
        knownFiles: ['Projects/Notes.md', 'Projects/Roadmap.md', 'Projects/Design.md'],
      },
    })

    // Place cursor on the very last line so all preceding lines render in collapsed Live Preview mode
    wrapper.vm.setCursor(doc.length)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.cm-live-h1').exists()).toBe(true)
    expect(wrapper.find('.cm-live-h2').exists()).toBe(true)
    expect(wrapper.find('.cm-live-h3').exists()).toBe(true)
    expect(wrapper.find('.cm-live-bold').text()).toBe('negrito')
    expect(wrapper.find('.cm-live-italic').text()).toBe('itálico')
    expect(wrapper.find('.cm-live-strikethrough').text()).toBe('riscado')
    expect(wrapper.find('.cm-live-inline-code').text()).toBe('código')
    expect(wrapper.find('.cm-live-ul-item').exists()).toBe(true)
    expect(wrapper.find('.cm-live-ol-item').exists()).toBe(true)
    expect(wrapper.find('.cm-live-checklist-item').exists()).toBe(true)
    expect(wrapper.find('.cm-live-checklist-checked').exists()).toBe(true)
    expect(wrapper.find('.cm-live-blockquote').exists()).toBe(true)
    expect(wrapper.find('.cm-live-hr').exists()).toBe(true)
    expect(wrapper.find('.cm-live-codeblock-line').exists()).toBe(true)
    expect(wrapper.find('.cm-live-table-row').exists()).toBe(true)

    const wikilink = wrapper.find('.cm-live-wikilink')
    expect(wikilink.exists()).toBe(true)
    expect(wikilink.text()).toBe('Roadmap do projeto')

    const mdLink = wrapper.find('.cm-live-markdown-link')
    expect(mdLink.exists()).toBe(true)
    expect(mdLink.text()).toBe('Design')
  })

  it('4. preserves cursor position and selection range across decorations and edits', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '# Título\n\nTexto **importante** aqui.',
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })

    wrapper.vm.setSelection(10, 15)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getSelection()).toEqual({ from: 10, to: 15 })

    // Insert text at cursor
    wrapper.vm.insertText('muito ', 16, 16)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('# Título\n\nTexto muito **importante** aqui.')
    expect(wrapper.vm.getSelection().from).toBe(22)
  })

  it('5. supports undo and redo via CodeMirror history while keeping raw Markdown intact', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '# Inicial',
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })

    wrapper.vm.insertText('\n\nNovo parágrafo com **negrito**.', 9, 9)
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('# Inicial\n\nNovo parágrafo com **negrito**.')

    wrapper.vm.performUndo()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('# Inicial')

    wrapper.vm.performRedo()
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('# Inicial\n\nNovo parágrafo com **negrito**.')
  })

  it('6. handles multiline paste, Unicode, and IME composition without corrupting Markdown bytes', async () => {
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: '# Notas\n',
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })

    const pasted = '\n## Seção Colada 🌸\n- Item A\n- Item B com 日本語 e acentuação\n'
    wrapper.vm.pasteText(pasted, 8)
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.getText()).toBe(`# Notas\n${pasted}`)
    expect(wrapper.emitted('update:modelValue')?.at(-1)).toEqual([`# Notas\n${pasted}`])

    // Simulate IME composition
    const contentDom = wrapper.find('.cm-content')
    await contentDom.trigger('compositionstart')
    wrapper.vm.insertText('あやめ', wrapper.vm.getText().length)
    await contentDom.trigger('compositionend')
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.getText().endsWith('あやめ')).toBe(true)
  })

  it('7. never executes raw HTML or dangerous scripts inside the note', async () => {
    window.__ayameEditorXss = false
    const malicious = '# Nota\n\n<script>window.__ayameEditorXss = true</script>\n<img src="x" onerror="window.__ayameEditorXss = true">\n[Click](javascript:window.__ayameEditorXss=true)'

    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: malicious,
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })
    await wrapper.vm.$nextTick()

    expect(window.__ayameEditorXss).toBe(false)
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img[src]').exists()).toBe(false)
    expect(wrapper.find('img[onerror]').exists()).toBe(false)
    expect(wrapper.find('.cm-live-link--invalid').exists()).toBe(true)
    delete window.__ayameEditorXss
  })

  it('8. prevents accidental navigation on plain click while editing link syntax, and navigates on Ctrl/Cmd+click or when clicking a rendered preview link', async () => {
    const doc = 'Consulte [[Design]] na documentação.\nOutra linha.'
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: doc,
        sourcePath: 'README.md',
        knownFiles: ['README.md', 'Projects/Design.md'],
      },
    })

    // 1. Place cursor inside [[Design]] (editing syntax mode)
    wrapper.vm.setCursor(12)
    await wrapper.vm.$nextTick()

    const editingLink = wrapper.find('.cm-live-wikilink')
    expect(editingLink.exists()).toBe(true)
    expect(editingLink.attributes('data-editing')).toBe('true')

    // Plain click while editing syntax must NOT emit open-link
    await editingLink.trigger('click')
    expect(wrapper.emitted('open-link')).toBeFalsy()

    // Ctrl+click while editing syntax DOES emit open-link
    await editingLink.trigger('click', { ctrlKey: true })
    expect(wrapper.emitted('open-link')?.length).toBe(1)
    expect(wrapper.emitted('open-link')[0][0]).toEqual({
      type: 'resolved',
      path: 'Projects/Design.md',
      rawTarget: '[[Design]]',
      kind: 'wikilink',
    })

    // 2. Move cursor to line 2 so [[Design]] is in collapsed Live Preview mode
    wrapper.vm.setCursor(doc.length)
    await wrapper.vm.$nextTick()

    const previewLink = wrapper.find('.cm-live-wikilink')
    expect(previewLink.attributes('data-editing')).toBe('false')
    await previewLink.trigger('click')
    expect(wrapper.emitted('open-link')?.length).toBe(2)
  })

  it('9. supports Obsidian Flavored Markdown (interactive checklists, ==highlights==, %%comments%%, > [!NOTE] callouts, ^block-ids, embeds, math, footnotes, and clickable #tags)', async () => {
    const doc = [
      '- [ ] Tarefa interativa',
      'Texto com ==destaque==, %%comentário interno%%, $E = mc^2$, [^1] e #conhecimento/filosofia ^bloco-chave',
      '> [!NOTE] Nota importante',
      '> Conteúdo do callout',
      '![[Projects/Design]]',
      'Linha final para posicionar o cursor.',
    ].join('\n')

    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: doc,
        sourcePath: 'README.md',
        knownFiles: ['README.md', 'Projects/Design.md'],
      },
    })

    // Position cursor on the last line
    wrapper.vm.setCursor(doc.length)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.cm-live-highlight').text()).toBe('destaque')
    // %%comentário interno%% is hidden when cursor is not on it
    expect(wrapper.findAll('.cm-line')[1].text()).not.toContain('comentário interno')
    expect(wrapper.find('.cm-live-math').text()).toBe('E = mc^2')
    expect(wrapper.find('.cm-live-footnote').text()).toBe('[^1]')
    expect(wrapper.find('.cm-live-block-id').text()).toBe('^bloco-chave')
    expect(wrapper.find('.cm-live-callout--note').exists()).toBe(true)
    expect(wrapper.find('.cm-live-embed').exists()).toBe(true)

    const inlineTag = wrapper.find('.cm-live-tag')
    expect(inlineTag.exists()).toBe(true)
    await inlineTag.trigger('click')
    expect(wrapper.emitted('click-tag')?.[0]).toEqual(['conhecimento/filosofia'])

    // Click interactive checklist marker -> toggles [ ] to [x] in the document!
    const checklistMarker = wrapper.find('.cm-live-checklist-marker')
    expect(checklistMarker.attributes('aria-checked')).toBe('false')
    await checklistMarker.trigger('click')
    await wrapper.vm.$nextTick()

    expect(wrapper.vm.getText().startsWith('- [x] Tarefa interativa')).toBe(true)
    expect(wrapper.find('.cm-live-checklist-marker').attributes('aria-checked')).toBe('true')
  })

  it('10. applies unified Ayame heading hierarchy, restrained lavender accents, compact top spacing, and readable tokens without pure white or broken editing', async () => {
    const editorStyles = editorRaw.match(/<style[^>]*>([\s\S]*?)<\/style>/)?.[1] || ''
    const extractRule = (pattern) => editorStyles.match(new RegExp(`${pattern}\\s*\\{([^}]*)\\}`, 's'))?.[1] || ''
    const parseLeadingRem = (val) => {
      const m = String(val || '').trim().match(/^([\d.]+)rem\b/)
      return m ? parseFloat(m[1]) : NaN
    }

    // Body text uses comfortable reading tokens, 16px-17px size, weight 400, comfortable line-height, and visible caret
    expect(editorStyles).toMatch(/\.markdown-editor-surface\s*\{[^}]*var\(--reading-text/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-editor\)\s*\{[^}]*var\(--reading-font-body/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-editor\)\s*\{[^}]*var\(--reading-font-size/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-editor\)\s*\{[^}]*font-weight:\s*400/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-editor\)\s*\{[^}]*var\(--reading-line-height/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-content\)\s*\{[^}]*caret-color:\s*var\(--reading-caret/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-content\)\s*\{[^}]*color:\s*var\(--reading-text/s)

    // Compact vertical rhythm: trimmed scroller top padding and zero extra top gap on first-line heading
    const scrollerRule = extractRule(':deep\\(\\.cm-scroller\\)')
    expect(parseLeadingRem(scrollerRule.match(/padding:\s*([^;]+);/)?.[1])).toBeLessThanOrEqual(0.2)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-heading:first-child\)\s*\{[^}]*padding-top:\s*0(?:\b|;)/s)

    // Unified heading hierarchy: differentiated by size, weight, spacing & structural borders (no rainbow of violet shades, never #fff)
    expect(editorStyles).not.toMatch(/#fff(?:fff)?\b/i)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-heading\)\s*\{[^}]*color:\s*var\(--reading-heading/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-heading\)\s*\{[^}]*var\(--reading-font-heading/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-h1\)\s*\{[^}]*font-weight:\s*600/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-h2\)\s*\{[^}]*color:\s*var\(--reading-heading-secondary/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-h2\)\s*\{[^}]*font-weight:\s*600/s)
    expect(extractRule(':deep\\(\\.cm-live-h2\\)')).not.toContain('var(--reading-accent)')
    expect(editorStyles).toMatch(/:deep\(\.cm-live-h3\)\s*\{[^}]*font-weight:\s*500/s)
    expect(extractRule(':deep\\(\\.cm-live-h3\\)')).not.toContain('var(--reading-accent)')
    expect(extractRule(':deep\\(\\.cm-live-h4\\)')).not.toContain('var(--reading-accent)')
    expect(editorStyles).toMatch(/:deep\(\.cm-live-h3\)\s*\{[^}]*color:\s*var\(--reading-heading-secondary/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-h4\)\s*\{[^}]*color:\s*var\(--reading-heading-secondary/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-bold\)\s*\{[^}]*font-weight:\s*600[^}]*var\(--reading-bold/s)

    // Lavender tags, markers, syntax delimiters, links, code, blockquotes, and tables
    expect(editorStyles).toMatch(/:deep\(\.cm-live-syntax\)\s*\{[^}]*var\(--reading-syntax/s)
    expect(editorStyles).not.toMatch(/:deep\(\.cm-live-syntax\)\s*\{[^}]*opacity:/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-tag\)\s*\{[^}]*var\(--reading-tag-text/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-tag\)\s*\{[^}]*var\(--reading-tag-bg/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-link\)\s*\{[^}]*var\(--reading-link/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-link:visited\)\s*\{[^}]*var\(--reading-link-visited/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-inline-code\)\s*\{[^}]*var\(--reading-code-text/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-codeblock-line\)\s*\{[^}]*var\(--reading-code-bg/s)
    expect(editorStyles).toMatch(/:deep\(\.cm-live-blockquote\)\s*\{[^}]*var\(--reading-blockquote-text/s)

    // Full Markdown semantics, tag clicks, & editing states remain operational across H1-H6, code, lists, tables, and hr
    const fullDoc = [
      '# H1 Principal',
      '## H2 Lavanda',
      '### H3 Destaque',
      '#### H4 Tópico',
      '##### H5 Nota',
      '###### H6 Rodapé',
      'Parágrafo com **negrito**, *itálico*, `codigo()` e [[Alvo|Link Interno]] além de #noite-lavanda.',
      '- [ ] Tarefa pendente',
      '> [!NOTE] Nota importante em callout',
      '---',
      '| Coluna A | Coluna B |',
      '| - | - |',
      '| 1 | 2 |',
      'Cursor final.',
    ].join('\n')

    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: fullDoc,
        sourcePath: 'Nota.md',
        knownFiles: ['Nota.md', 'Alvo.md'],
      },
    })
    wrapper.vm.setCursor(fullDoc.length)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.cm-live-h1').exists()).toBe(true)
    expect(wrapper.find('.cm-live-h2').exists()).toBe(true)
    expect(wrapper.find('.cm-live-h3').exists()).toBe(true)
    expect(wrapper.find('.cm-live-h4').exists()).toBe(true)
    expect(wrapper.find('.cm-live-h6').exists()).toBe(true)
    expect(wrapper.find('.cm-live-bold').text()).toBe('negrito')
    expect(wrapper.find('.cm-live-inline-code').text()).toBe('codigo()')
    expect(wrapper.find('.cm-live-link').text()).toBe('Link Interno')
    expect(wrapper.find('.cm-live-tag').text()).toBe('#noite-lavanda')
    expect(wrapper.find('.cm-live-callout').exists()).toBe(true)
    expect(wrapper.find('.cm-live-hr').exists()).toBe(true)
    expect(wrapper.find('.cm-live-table-row').exists()).toBe(true)

    await wrapper.find('.cm-live-tag').trigger('click')
    expect(wrapper.emitted('click-tag')?.[0]).toEqual(['noite-lavanda'])
  })

  it('11. renders vault image embeds in Live Preview while preserving note embeds', async () => {
    const doc = [
      '![[Attachments/diagram.png]]',
      '',
      '![[diagram.png|320]]',
      '',
      '![Diagram alt](Attachments/diagram.png)',
      '',
      '![[Projects/Design]]',
      '',
      'Tail cursor line.',
    ].join('\n')

    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: doc,
        vaultDirectory: 'Isekai',
        sourcePath: 'README.md',
        knownFiles: ['README.md', 'Projects/Design.md'],
        allFiles: ['README.md', 'Projects/Design.md', 'Attachments/diagram.png'],
      },
    })
    wrapper.vm.setCursor(doc.length)
    await wrapper.vm.$nextTick()

    const imgs = wrapper.findAll('img.cm-live-image-embed')
    expect(imgs).toHaveLength(3)
    expect(imgs[0].attributes('src')).toBe('/vaults/Isekai/media?path=Attachments%2Fdiagram.png')
    expect(imgs[1].attributes('style')).toContain('max-width: 320px')
    expect(imgs[2].attributes('alt')).toBe('Diagram alt')
    expect(imgs[2].attributes('src')).toBe('/vaults/Isekai/media?path=Attachments%2Fdiagram.png')

    expect(wrapper.find('.cm-live-wikilink.cm-live-embed').exists()).toBe(true)
    expect(wrapper.find('.cm-live-wikilink.cm-live-embed').text()).toBe('Projects/Design')
  })

  it('12. provides [[ wikilink and #tag autocomplete, Mod-b formatting, and image paste upload', async () => {
    const uploadImage = vi.fn().mockResolvedValue({ path: 'Attachments/shot.png' })
    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: 'See [[Des',
        knownFiles: ['Projects/Design.md', 'Ideas.md'],
        aliasesByFile: { 'Projects/Design.md': ['System Blueprint'] },
        knownTags: ['roadmap', 'release'],
        uploadImage,
      },
    })
    await wrapper.vm.$nextTick()

    wrapper.vm.setCursor('See [[Des'.length)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="editor-autocomplete"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-autocomplete-item"]').text()).toContain('Design')

    const contentDom = wrapper.vm.getView().contentDOM
    contentDom.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('See [[Design]]')
    expect(wrapper.find('[data-testid="editor-autocomplete"]').exists()).toBe(false)

    // Heading syntax should NOT trigger tag autocomplete, whereas #roa should
    wrapper.vm.setText('# Heading')
    wrapper.vm.setCursor('# Heading'.length)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="editor-autocomplete"]').exists()).toBe(false)

    wrapper.vm.setText('Tag #roa')
    wrapper.vm.setCursor('Tag #roa'.length)
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="editor-autocomplete"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="editor-autocomplete-item"]').text()).toContain('#roadmap')
    await wrapper.find('[data-testid="editor-autocomplete-item"]').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('Tag #roadmap ')

    // Mod-b bold wrap
    wrapper.vm.setText('hello world')
    wrapper.vm.setSelection(6, 11)
    await wrapper.vm.$nextTick()
    contentDom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'b', ctrlKey: true, bubbles: true, cancelable: true })
    )
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toBe('hello **world**')

    // Image paste upload
    wrapper.vm.setText('Shot: ')
    wrapper.vm.setCursor('Shot: '.length)
    await wrapper.vm.$nextTick()
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    const pasteEvent = new Event('paste', { bubbles: true, cancelable: true })
    Object.defineProperty(pasteEvent, 'clipboardData', {
      value: { files: [file] },
    })
    contentDom.dispatchEvent(pasteEvent)
    await Promise.resolve()
    await Promise.resolve()
    await wrapper.vm.$nextTick()

    expect(uploadImage).toHaveBeenCalledWith(file)
    expect(wrapper.vm.getText()).toBe('Shot: ![[Attachments/shot.png]]')
  })

  it('13. renders tactile Live Preview widgets for checklists, bullets, and callout badges off-cursor', async () => {
    const doc = [
      '- Bullet item',
      '- [x] Done task',
      '> [!TIP] Helpful hint',
      '> Details here.',
      'Tail cursor.',
    ].join('\n')

    const wrapper = mount(MarkdownEditor, {
      props: {
        modelValue: doc,
        sourcePath: 'README.md',
        knownFiles: ['README.md'],
      },
    })
    wrapper.vm.setCursor(doc.length)
    await wrapper.vm.$nextTick()

    expect(wrapper.find('.cm-live-bullet-dot').text()).toBe('•')
    expect(wrapper.find('.cm-live-checkbox-box--checked').exists()).toBe(true)
    expect(wrapper.find('.cm-live-callout-widget').text()).toContain('Tip')
    expect(wrapper.find('.cm-live-callout-end').exists()).toBe(true)

    await wrapper.find('.cm-live-checklist-marker').trigger('click')
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getText()).toContain('- [ ] Done task')
  })
})
