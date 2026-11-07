import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import MarkdownEditor from './MarkdownEditor.vue'

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
    expect(linesAtLine1[0].classes()).toContain('cm-live-heading')
    expect(linesAtLine1[0].classes()).toContain('cm-live-h1')
    // While cursor is on line 1, '# ' syntax is accessible in the line DOM
    expect(linesAtLine1[0].text()).toContain('# Meu título')

    // Move cursor to line 2 (outside heading line)
    wrapper.vm.setCursor('# Meu título\n'.length + 2)
    await wrapper.vm.$nextTick()

    const linesAtLine2 = wrapper.findAll('.cm-line')
    expect(linesAtLine2[0].classes()).toContain('cm-live-h1')
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
    expect(wikilink.classes()).toContain('cm-live-link--resolved')

    const mdLink = wrapper.find('.cm-live-markdown-link')
    expect(mdLink.exists()).toBe(true)
    expect(mdLink.text()).toBe('Design')
    expect(mdLink.classes()).toContain('cm-live-link--resolved')
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
})
