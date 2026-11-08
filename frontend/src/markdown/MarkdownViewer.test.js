import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownViewer, { AUTOSAVE_DELAY_MS } from './MarkdownViewer.vue'
import MarkdownEditor from './MarkdownEditor.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import * as api from '../vaults/api.js'

vi.mock('../vaults/api.js', () => ({
  getVaultMarkdown: vi.fn(),
  saveVaultMarkdown: vi.fn(),
  MAX_MARKDOWN_BYTES: 2 * 1024 * 1024,
}))

const revision = 'a'.repeat(64)

const apiError = (code) => {
  const err = new Error(code)
  err.code = code
  return err
}

const editNote = async (wrapper, nextText) => {
  const editor = wrapper.findComponent(MarkdownEditor)
  editor.vm.setText(nextText)
  await wrapper.vm.$nextTick()
}

describe('MarkdownViewer.vue (Live Preview + Autosave)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetAllMocks()
    localStorage.clear()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    localStorage.clear()
  })

  it('1. exports AUTOSAVE_DELAY_MS = 700 and opens notes directly in the Live Preview editor without Edit or Save buttons', async () => {
    expect(AUTOSAVE_DELAY_MS).toBe(700)
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'projects/spec.md',
      content: '# Architecture\n\nThis is **live**.\n',
      revision,
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/spec.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-loading"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-edit-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-save-button"]').exists()).toBe(false)
    expect(wrapper.find('.cm-live-h1').exists()).toBe(true)
    expect(wrapper.find('.cm-live-bold').text()).toBe('live')
  })

  it('does not duplicate an initial H1 that matches the filename, including after a visual preference toggle', async () => {
    const content = '---\ntitle: Ayame\n---\n\n# Ayame\n\nBody'
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ inlineTitle: false }))
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'Ayame.md', content, revision,
    })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Ayame.md' } })
    await flushPromises()

    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(false)
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toContain('# Ayame')
    wrapper.vm.toggleInlineTitle()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(false)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(wrapper.vm.getText()).toBe(content)
  })

  it('keeps inline titles when the first H1 differs or a matching-looking heading is code', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'Ayame.md', content: '# A different title', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'Ayame.md', content: '```md\n# Ayame\n```', revision })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Ayame.md' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(true)

    await wrapper.vm.reload()
    await flushPromises()
    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(true)
  })

  it('keeps the inline title for notes without H1 and compares Unicode filenames canonically after navigation', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'Plain.md', content: 'Body only', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'Cafe\u0301.md', content: '# Café', revision })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Plain.md' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(true)

    await wrapper.setProps({ path: 'Cafe\u0301.md' })
    await flushPromises()
    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(false)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('2. does not trigger any save during inactivity when no changes have been made', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      content: '# Static Note',
      revision,
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    vi.advanceTimersByTime(5000)
    await flushPromises()

    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="autosave-status"]').text()).toContain('Saved')
  })

  it('3. debounces rapid keystrokes into a single consolidated PUT after 700ms of inactivity and preserves CRLF/LF line endings', async () => {
    const original = 'first\r\nsecond\nlast\r\n'
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      content: original,
      revision,
    })
    api.saveVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      revision: 'b'.repeat(64),
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'first\nstep 1\nsecond\nlast\n')
    vi.advanceTimersByTime(300)
    await editNote(wrapper, 'first\nstep 2\nsecond\nlast\n')
    vi.advanceTimersByTime(300)
    await editNote(wrapper, 'first\ninserted\nsecond\nlast\n')

    // Still within 700ms of the last keystroke
    vi.advanceTimersByTime(699)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="markdown-dirty-indicator"]').exists()).toBe(true)

    // Cross the 700ms threshold
    vi.advanceTimersByTime(1)
    await flushPromises()

    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    expect(api.saveVaultMarkdown).toHaveBeenCalledWith('personal', 'note.md', {
      content: 'first\r\ninserted\r\nsecond\nlast\r\n',
      expectedRevision: revision,
    })
    expect(wrapper.find('[data-testid="autosave-status"]').text()).toContain('Saved')
  })

  it('does not add a persistent status line after a successful autosave', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'note.md', content: 'base', revision,
    })
    api.saveVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'note.md', revision: 'b'.repeat(64),
    })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await editNote(wrapper, 'updated')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('.editor-status').map((node) => node.text())).not.toContain('Saved.')
    expect(wrapper.find('[data-testid="autosave-status"]').text()).toContain('Saved')
  })

  it('4. cancels pending debounce if draft is reverted to baseContent before 700ms', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      content: 'base',
      revision,
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'changed')
    expect(wrapper.find('[data-testid="markdown-dirty-indicator"]').exists()).toBe(true)

    vi.advanceTimersByTime(300)
    await editNote(wrapper, 'base')
    expect(wrapper.find('[data-testid="markdown-dirty-indicator"]').exists()).toBe(false)

    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('5. allows typing while a PUT is in-flight, serializes saves, never overwrites newer draft with saved snapshot, and schedules a follow-up save with the updated revision', async () => {
    let resolveFirstSave
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      content: 'v0',
      revision: '0'.repeat(64),
    })
    api.saveVaultMarkdown
      .mockReturnValueOnce(new Promise((resolve) => { resolveFirstSave = resolve }))
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'note.md',
        revision: '2'.repeat(64),
      })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    // First edit -> wait 700ms -> PUT #1 starts
    await editNote(wrapper, 'v1')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    expect(api.saveVaultMarkdown).toHaveBeenLastCalledWith('personal', 'note.md', {
      content: 'v1',
      expectedRevision: '0'.repeat(64),
    })
    expect(wrapper.find('[data-testid="markdown-saving"]').exists()).toBe(true)

    // User continues typing while PUT #1 is in flight!
    await editNote(wrapper, 'v1 + v2')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
    // Must NOT send a second concurrent PUT while PUT #1 is still in flight
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('v1 + v2')

    // Now PUT #1 completes
    resolveFirstSave({
      directory: 'personal',
      path: 'note.md',
      revision: '1'.repeat(64),
    })
    await flushPromises()

    // Draft must still be 'v1 + v2', NOT reverted to 'v1', and must NOT be marked 'Saved' yet!
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('v1 + v2')
    expect(wrapper.find('[data-testid="markdown-dirty-indicator"]').exists()).toBe(true)

    // Follow-up autosave fires after debounce with the new revision '1'.repeat(64)
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(2)
    expect(api.saveVaultMarkdown).toHaveBeenLastCalledWith('personal', 'note.md', {
      content: 'v1 + v2',
      expectedRevision: '1'.repeat(64),
    })
    expect(wrapper.find('[data-testid="autosave-status"]').text()).toContain('Saved')
  })

  it('6. stops autosave on 409 conflict, preserves the draft, and requires confirmation before reloading server copy', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'base', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'remote copy', revision: 'c'.repeat(64) })
    api.saveVaultMarkdown
      .mockRejectedValueOnce(apiError('VAULT_FILE_CONFLICT'))
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', revision: 'e'.repeat(64) })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'local draft')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-conflict"]').exists()).toBe(true)
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('local draft')

    // Further edits while in conflict must NOT trigger automatic PUT requests
    await editNote(wrapper, 'local draft edited further')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 3)
    await flushPromises()
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)

    // Reload server copy with confirmation
    await wrapper.find('[data-testid="markdown-reload-server"]').trigger('click')
    expect(wrapper.find('[data-testid="markdown-confirm-reload"]').exists()).toBe(true)
    await wrapper.find('[data-testid="markdown-confirm-reload"]').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('remote copy')
    expect(wrapper.find('[data-testid="markdown-conflict"]').exists()).toBe(false)

    // Subsequent edit saves against the newly reloaded revision
    await editNote(wrapper, 'next draft')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()
    expect(api.saveVaultMarkdown).toHaveBeenLastCalledWith('personal', 'note.md', {
      content: 'next draft',
      expectedRevision: 'c'.repeat(64),
    })
  })

  it('7. suspends automatic writes on VAULT_SAVE_RESULT_UNKNOWN and reconciles via explicit remote verification', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'base', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'draft', revision: 'e'.repeat(64) })
    api.saveVaultMarkdown.mockRejectedValueOnce(apiError('VAULT_SAVE_RESULT_UNKNOWN'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'draft')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-save-unknown"]').exists()).toBe(true)
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('draft')

    // Automatic writes remain suspended even if time passes
    vi.advanceTimersByTime(5000)
    await flushPromises()
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)

    // Explicit verification reconciles matching server content
    await wrapper.find('[data-testid="markdown-verify-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-save-unknown"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="autosave-status"]').text()).toContain('Saved')
    expect(wrapper.text()).toContain('matches your draft')
  })

  it('8. transitions uncertain save to conflict when verification finds different remote content', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'base', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'different remote', revision: 'b'.repeat(64) })
    api.saveVaultMarkdown.mockRejectedValueOnce(apiError('VAULT_SAVE_RESULT_UNKNOWN'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'keep this draft')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    await wrapper.find('[data-testid="markdown-verify-save"]').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('keep this draft')
    expect(wrapper.find('[data-testid="markdown-conflict"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-save-error"]').text()).toContain('different copy')
  })

  it('9. preserves draft on network/locked save error without discarding content and registers beforeunload while unconfirmed changes exist', async () => {
    const addSpy = vi.spyOn(window, 'addEventListener')
    const removeSpy = vi.spyOn(window, 'removeEventListener')

    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      content: 'initial',
      revision,
    })
    api.saveVaultMarkdown
      .mockRejectedValueOnce(apiError('VAULT_FILE_LOCKED'))
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', revision: 'b'.repeat(64) })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'important draft')
    expect(addSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))

    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('important draft')
    expect(wrapper.find('[data-testid="markdown-save-error"]').text()).toContain('Another Ayame save')
    // beforeunload remains registered because the draft is still unconfirmed!
    expect(removeSpy).not.toHaveBeenCalledWith('beforeunload', expect.any(Function))

    // Explicit retry save succeeds and removes beforeunload
    await wrapper.find('[data-testid="markdown-retry-save"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="autosave-status"]').text()).toContain('Saved')
    expect(removeSpy).toHaveBeenCalledWith('beforeunload', expect.any(Function))
  })

  it('10. never mixes revisions or applies stale save responses when switching notes', async () => {
    let resolveSaveNoteA
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note-a.md', content: 'Note A', revision: 'a'.repeat(64) })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note-b.md', content: 'Note B', revision: 'b'.repeat(64) })
    api.saveVaultMarkdown
      .mockReturnValueOnce(new Promise((resolve) => { resolveSaveNoteA = resolve }))
      .mockResolvedValueOnce({ directory: 'personal', path: 'note-b.md', revision: 'c'.repeat(64) })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note-a.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'Note A edited')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)

    // Switch to note-b.md before Note A's save resolves
    await wrapper.setProps({ path: 'note-b.md' })
    await flushPromises()

    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('Note B')

    // Now Note A's save resolves late with revision 'f'.repeat(64)
    resolveSaveNoteA({ directory: 'personal', path: 'note-a.md', revision: 'f'.repeat(64) })
    await flushPromises()

    // Editing Note B must use Note B's revision ('b'.repeat(64)), NOT Note A's late revision!
    await editNote(wrapper, 'Note B edited')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(api.saveVaultMarkdown).toHaveBeenLastCalledWith('personal', 'note-b.md', {
      content: 'Note B edited',
      expectedRevision: 'b'.repeat(64),
    })
  })

  it('11. clears protected draft immediately when autosave, load, refresh, or reload returns 401 UNAUTHORIZED', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'note.md',
      content: 'secret base',
      revision,
    })
    api.saveVaultMarkdown.mockRejectedValueOnce(apiError('UNAUTHORIZED'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    await editNote(wrapper, 'secret draft')
    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(wrapper.emitted('unauthorized')?.length).toBe(1)
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('secret draft')
  })

  it('12. renders error states for missing, oversized, and invalid-encoding notes', async () => {
    api.getVaultMarkdown.mockRejectedValueOnce(apiError('VAULT_PATH_NOT_FOUND'))
    const wrapper1 = mount(MarkdownViewer, { props: { directory: 'personal', path: 'missing.md' } })
    await flushPromises()
    expect(wrapper1.find('[data-testid="markdown-not-found"]').exists()).toBe(true)

    api.getVaultMarkdown.mockRejectedValueOnce(apiError('VAULT_FILE_TOO_LARGE'))
    const wrapper2 = mount(MarkdownViewer, { props: { directory: 'personal', path: 'large.md' } })
    await flushPromises()
    expect(wrapper2.find('[data-testid="markdown-error"]').text()).toContain('exceeds the 2 MiB limit')

    api.getVaultMarkdown.mockRejectedValueOnce(apiError('INVALID_FILE_ENCODING'))
    const wrapper3 = mount(MarkdownViewer, { props: { directory: 'personal', path: 'corrupt.md' } })
    await flushPromises()
    expect(wrapper3.find('[data-testid="markdown-error"]').text()).toContain('invalid UTF-8 encoding')
  })

  it('13. coordinates Properties edits and body edits into a single versioned document without overwriting each other', async () => {
    const initialMd = [
      '---',
      'title: Cosmologia - A Memória do Mundo',
      'type: Rascunho',
      'tags:',
      '  - cosmologia',
      '---',
      '# Introdução',
      '',
      'Texto inicial.',
    ].join('\n')

    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Cosmologia.md',
      content: initialMd,
      revision,
    })
    api.saveVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Cosmologia.md',
      revision: 'b'.repeat(64),
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'Cosmologia.md' },
    })
    await flushPromises()

    // Heading title shows physical filename stem ('Cosmologia'), independent of YAML title
    const headingInput = wrapper.find('[data-testid="note-heading-title"]')
    expect(headingInput.exists()).toBe(true)
    expect(headingInput.element.value).toBe('Cosmologia')

    // Show Properties (hidden by default)
    wrapper.vm.setPropertiesMode('visible')
    await flushPromises()

    // 1. Add a tag in PropertiesPanel
    const addTagInput = wrapper.find('[data-testid="add-tag-input"]')
    await addTagInput.setValue('leis-universais')
    await addTagInput.trigger('keydown.enter')

    // 2. Simultaneously edit the Markdown body before the 700ms debounce timer fires
    await editNote(wrapper, '# Introdução\n\nTexto atualizado simultaneamente.')

    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
    await flushPromises()

    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    const savedPayload = api.saveVaultMarkdown.mock.calls[0][2]
    expect(savedPayload.expectedRevision).toBe(revision)
    expect(savedPayload.content).toContain('title: Cosmologia - A Memória do Mundo')
    expect(savedPayload.content).toContain('- cosmologia')
    expect(savedPayload.content).toContain('- leis-universais')
    expect(savedPayload.content).toContain('# Introdução\n\nTexto atualizado simultaneamente.')
  })

  describe('Properties display modes and editor preferences', () => {
    it('14. opens note with YAML properties hidden by default without reserving DOM space', async () => {
      const revision = 'a'.repeat(64)
      const yamlContent = '---\ntitle: Cosmologia\ntags:\n  - ciencia\n---\n# Início da nota\n'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal',
        path: 'Cosmologia.md',
        content: yamlContent,
        revision,
      })

      const wrapper = mount(MarkdownViewer, {
        props: { directory: 'personal', path: 'Cosmologia.md' },
      })
      await flushPromises()

      // PropertiesPanel is NOT rendered by default
      expect(wrapper.findComponent(PropertiesPanel).exists()).toBe(false)
      expect(wrapper.find('[data-testid="properties-panel"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="add-tag-input"]').exists()).toBe(false)

      // Content starts immediately with heading and editor
      expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(true)
      expect(wrapper.findComponent(MarkdownEditor).exists()).toBe(true)
      expect(wrapper.findComponent(MarkdownEditor).props('modelValue')).toContain('# Início da nota')

      // File text on disk is untouched
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      expect(wrapper.vm.getText()).toBe(yamlContent)
    })

    it('15. toggles to visible to show properties and back to hidden without dirtying or saving', async () => {
      const revision = 'b'.repeat(64)
      const yamlContent = '---\ntitle: Filosofia\ntags:\n  - pensar\n---\n# Corpo\n'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal',
        path: 'Filosofia.md',
        content: yamlContent,
        revision,
      })

      const wrapper = mount(MarkdownViewer, {
        props: { directory: 'personal', path: 'Filosofia.md' },
      })
      await flushPromises()

      expect(wrapper.findComponent(PropertiesPanel).exists()).toBe(false)

      // Toggle to visible
      wrapper.vm.setPropertiesMode('visible')
      await flushPromises()

      expect(wrapper.findComponent(PropertiesPanel).exists()).toBe(true)
      expect(wrapper.find('[data-testid="property-tag-chip"]').text()).toContain('pensar')

      // Toggle to source
      wrapper.vm.setPropertiesMode('source')
      await flushPromises()

      expect(wrapper.findComponent(PropertiesPanel).exists()).toBe(false)
      expect(wrapper.findComponent(MarkdownEditor).props('modelValue')).toContain('title: Filosofia')

      // Toggle back to hidden
      wrapper.vm.setPropertiesMode('hidden')
      await flushPromises()

      expect(wrapper.findComponent(PropertiesPanel).exists()).toBe(false)
      expect(wrapper.findComponent(MarkdownEditor).props('modelValue')).not.toContain('title: Filosofia')

      // No autosave triggered and draft matches original byte for byte
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
      await flushPromises()
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      expect(wrapper.vm.getText()).toBe(yamlContent)
    })

    it('16. persists preferences and falls back to hidden when preference is corrupted', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'invalid-mode' }))

      const revision = 'c'.repeat(64)
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal',
        path: 'Nota.md',
        content: '---\ntitle: Nota\n---\n# Conteúdo\n',
        revision,
      })

      const wrapper = mount(MarkdownViewer, {
        props: { directory: 'personal', path: 'Nota.md' },
      })
      await flushPromises()

      // Defaults to hidden on invalid mode
      expect(wrapper.findComponent(PropertiesPanel).exists()).toBe(false)
      expect(wrapper.vm.getPreferences().propertiesInDocument).toBe('hidden')
    })

    it('17. supports readableLineLength toggle persisting to localStorage', async () => {
      const revision = 'd'.repeat(64)
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal',
        path: 'Longo.md',
        content: '# Teste de linha legível\n',
        revision,
      })

      const wrapper = mount(MarkdownViewer, {
        props: { directory: 'personal', path: 'Longo.md' },
      })
      await flushPromises()

      const docContainer = wrapper.find('.viewer-document-container')
      expect(docContainer.exists()).toBe(true)
      expect(docContainer.classes()).toContain('viewer-document-container--readable')

      // Toggle off
      wrapper.vm.toggleReadableLineLength()
      await flushPromises()

      expect(docContainer.classes()).not.toContain('viewer-document-container--readable')

      const stored = JSON.parse(localStorage.getItem('ayame:editor-preferences'))
      expect(stored.readableLineLength).toBe(false)
    })
  })
})
