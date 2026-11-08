import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownViewer, { AUTOSAVE_DELAY_MS } from './MarkdownViewer.vue'
import MarkdownEditor from './MarkdownEditor.vue'
import PropertiesPanel from './PropertiesPanel.vue'
import { parseNoteDocument } from './properties.js'
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

  it('keeps the inline title when a matching H1 follows a paragraph, without changing the Markdown', async () => {
    const content = 'Introduction.\n\n# Ayame\n\nBody'
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'Ayame.md', content, revision,
    })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Ayame.md' } })
    await flushPromises()

    expect(wrapper.find('[data-testid="note-heading-title"]').exists()).toBe(true)
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe(content)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
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

  it('pauses autosave and preserves the draft while the parent reconciles a relocated note', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: '# Note', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'moved/note.md', content: '# Note', revision })
    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    await editNote(wrapper, 'draft across move')
    await wrapper.setProps({ relocating: true })

    vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
    await flushPromises()
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="markdown-editor"]').attributes('aria-disabled')).toBe('true')

    wrapper.vm.preserveDraftForRelocatedPath('moved/note.md')
    await wrapper.setProps({ path: 'moved/note.md' })
    await flushPromises()
    expect(wrapper.vm.getText()).toBe('draft across move')
    expect(api.getVaultMarkdown).toHaveBeenCalledTimes(2)
  })

  it('does not apply a pending relocation snapshot after the vault changes while the destination is loading', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    let finishMovedRead
    const movedRead = new Promise((resolve) => { finishMovedRead = resolve })
    api.getVaultMarkdown.mockImplementation(async (directory, path) => {
      if (directory === 'personal' && path === 'note.md') {
        return { directory, path, content: '---\nchapter: 42\n---\nBody', revision }
      }
      if (directory === 'personal' && path === 'moved/note.md') return movedRead
      return { directory, path, content: '---\nchapter: 7\n---\nOther vault', revision: 'b'.repeat(64) }
    })
    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    await wrapper.setProps({ relocating: true })
    wrapper.vm.preserveDraftForRelocatedPath('moved/note.md')
    await wrapper.setProps({ path: 'moved/note.md' })
    await wrapper.setProps({ directory: 'other', path: 'Other.md', relocating: false })
    await flushPromises()

    expect(wrapper.vm.getText()).toContain('Other vault')
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('7')
    finishMovedRead({
      directory: 'personal', path: 'moved/note.md',
      content: '---\nchapter: 100\n---\nMoved note', revision: 'c'.repeat(64),
    })
    await flushPromises()

    expect(wrapper.vm.getText()).toContain('Other vault')
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('7')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('does not apply a pending relocation snapshot after the editor unmounts', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    let finishMovedRead
    const movedRead = new Promise((resolve) => { finishMovedRead = resolve })
    api.getVaultMarkdown.mockImplementation(async (directory, path) => path === 'note.md'
      ? { directory, path, content: '---\nchapter: 42\n---\nBody', revision }
      : movedRead)
    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    await wrapper.setProps({ relocating: true })
    wrapper.vm.preserveDraftForRelocatedPath('moved/note.md')
    await wrapper.setProps({ path: 'moved/note.md' })
    wrapper.unmount()
    const stateCount = wrapper.emitted('state')?.length ?? 0

    finishMovedRead({
      directory: 'personal', path: 'moved/note.md',
      content: '---\nchapter: 100\n---\nMoved note', revision: 'c'.repeat(64),
    })
    await flushPromises()

    expect(wrapper.emitted('state')?.length ?? 0).toBe(stateCount)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('keeps the Number snapshot recoverable and blocks saving when the moved note cannot be verified', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: '---\nchapter: 42\n---\nBody', revision })
      .mockRejectedValueOnce(new Error('offline'))
    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    await wrapper.setProps({ relocating: true })
    wrapper.vm.preserveDraftForRelocatedPath('moved/note.md')
    await wrapper.setProps({ path: 'moved/note.md' })
    await flushPromises()

    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(wrapper.find('[data-testid="markdown-save-error"]').text()).toContain('Your draft is preserved')
    expect(wrapper.find('[data-testid="markdown-conflict"]').exists()).toBe(true)
    expect(wrapper.vm.getText()).toBe('---\nchapter: 42\n---\nBody')
    await wrapper.vm.save()
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
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
    it('does not alter the draft or autosave empty and intermediate numeric input', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const content = '---\nchapter: 42\n---\n\nBody'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Chapter.md', content, revision,
      })
      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Chapter.md' } })
      await flushPromises()
      const input = wrapper.find('[data-testid="property-number-input"]')

      await input.setValue('')
      expect(wrapper.vm.getText()).toBe(content)
      await input.setValue('-')
      expect(wrapper.vm.getText()).toBe(content)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()

      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
      await flushPromises()
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      expect(wrapper.vm.getText()).toBe(content)
    })

    it.each(['1e-9999', '9007199254740993', '0.123456789012345678901'])(
      'does not alter or autosave unsafe Number input %s',
      async (value) => {
        localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
        const content = '---\nchapter: 42\n---\nBody'
        api.getVaultMarkdown.mockResolvedValueOnce({
          directory: 'personal', path: 'Chapter.md', content, revision,
        })
        const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Chapter.md' } })
        await flushPromises()
        const input = wrapper.find('[data-testid="property-number-input"]')

        await input.setValue(value)
        await input.trigger('keydown.enter')
        vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
        await flushPromises()

        expect(wrapper.vm.getText()).toBe(content)
        expect(wrapper.vm.revision).toBe(revision)
        expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      }
    )

    it('autosaves a valid numeric value only after confirmation', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const content = '---\nchapter: 42\n---\n\nBody'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Chapter.md', content, revision,
      })
      api.saveVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Chapter.md', revision: 'b'.repeat(64),
      })
      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Chapter.md' } })
      await flushPromises()
      const input = wrapper.find('[data-testid="property-number-input"]')

      await input.setValue('-15')
      expect(wrapper.vm.getText()).toBe(content)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      await input.trigger('keydown.enter')
      await wrapper.vm.$nextTick()

      expect(parseNoteDocument(wrapper.vm.getText()).properties[0].value).toBe(-15)
      const confirmed = wrapper.vm.getText()
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
      await flushPromises()

      expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
      expect(api.saveVaultMarkdown).toHaveBeenCalledWith('personal', 'Chapter.md', {
        content: confirmed,
        expectedRevision: revision,
      })
    })

    it('does not update or autosave a rejected case-insensitive property rename', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const content = '---\nChapter: 3\nstatus: draft\n---\nBody'
      api.getVaultMarkdown
        .mockResolvedValueOnce({ directory: 'personal', path: 'First.md', content, revision })
        .mockResolvedValueOnce({
          directory: 'personal', path: 'Second.md', content: '# Second', revision: 'b'.repeat(64),
        })
      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'First.md' } })
      await flushPromises()

      const keyInput = wrapper.find('[data-property-key="status"] [data-testid="property-key-input"]')
      await keyInput.setValue('chapter')
      await keyInput.trigger('keydown.enter')
      expect(wrapper.find('[data-testid="property-key-error"]').text()).toContain('already exists')
      expect(wrapper.vm.getText()).toBe(content)

      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
      await flushPromises()
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()

      await wrapper.setProps({ path: 'Second.md' })
      await flushPromises()
      expect(wrapper.vm.getText()).toBe('# Second')
      expect(wrapper.find('[data-testid="property-key-error"]').exists()).toBe(false)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    })

    it('reports a local Number draft as unconfirmed and clears it only on cancel or explicit discard', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Chapter.md', content: '---\nchapter: 42\n---\nBody', revision,
      })
      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Chapter.md' } })
      await flushPromises()
      const input = wrapper.find('[data-testid="property-number-input"]')

      await input.setValue('-15')
      expect(wrapper.emitted('state').at(-1)[0].dirty).toBe(true)
      wrapper.vm.setPropertiesMode('hidden')
      expect(wrapper.vm.getPreferences().propertiesInDocument).toBe('visible')
      expect(wrapper.find('[data-testid="property-number-input"]').exists()).toBe(true)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()

      await wrapper.find('[data-testid="property-number-input"]').trigger('keydown.esc')
      expect(wrapper.emitted('state').at(-1)[0].dirty).toBe(false)

      await wrapper.find('[data-testid="property-number-input"]').setValue('-20')
      wrapper.vm.discardChanges()
      await wrapper.vm.$nextTick()
      expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('42')
      expect(wrapper.emitted('state').at(-1)[0].dirty).toBe(false)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    })

    it('keeps unsafe YAML number text exact while displaying it and autosaving an unrelated edit', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const content = '---\nlarge_id: 9007199254740993\nsmall: 1e-9999\nprecise: 0.123456789012345678901\nstatus: draft\n---\nBody'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Numbers.md', content, revision,
      })
      api.saveVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Numbers.md', revision: 'b'.repeat(64),
      })
      const wrapper = mount(MarkdownViewer, {
        props: {
          directory: 'personal',
          path: 'Numbers.md',
          knownPropertyTypes: { large_id: 'number', small: 'number', precise: 'number' },
        },
      })
      await flushPromises()

      expect(wrapper.find('[data-property-key="large_id"] [data-testid="property-text-input"]').element.value).toBe('9007199254740993')
      expect(wrapper.find('[data-property-key="small"] [data-testid="property-text-input"]').element.value).toBe('1e-9999')
      expect(wrapper.vm.getText()).toBe(content)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()

      await wrapper.find('[data-property-key="status"] [data-testid="property-text-input"]').setValue('reviewed')
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
      await flushPromises()

      expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
      const saved = api.saveVaultMarkdown.mock.calls[0][2].content
      expect(saved).toContain('large_id: 9007199254740993')
      expect(saved).toContain('small: 1e-9999')
      expect(saved).toContain('precise: 0.123456789012345678901')
      expect(saved).toContain('status: reviewed')
    })

    it('does not autosave invalid or duplicate Add property submissions', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const content = '---\n# Keep this comment\nchapter: 42\ncustom:\n  nested: value\n---\n\nBody'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Chapter.md', content, revision,
      })
      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Chapter.md' } })
      await flushPromises()
      await wrapper.find('[data-testid="add-property-button"]').trigger('click')
      await wrapper.find('[data-testid="new-property-key-input"]').setValue('rating')
      await wrapper.find('[data-testid="new-property-type-select"]').setValue('number')
      await wrapper.find('[data-testid="new-property-value-input"]').setValue('many')
      await wrapper.find('[data-testid="new-property-submit"]').trigger('click')
      expect(wrapper.vm.getText()).toBe(content)

      await wrapper.find('[data-testid="new-property-value-input"]').setValue('9007199254740993')
      await wrapper.find('[data-testid="new-property-submit"]').trigger('click')
      expect(wrapper.vm.getText()).toBe(content)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()

      await wrapper.find('[data-testid="new-property-key-input"]').setValue('chapter')
      await wrapper.find('[data-testid="new-property-type-select"]').setValue('number')
      await wrapper.find('[data-testid="new-property-value-input"]').setValue('100')
      await wrapper.find('[data-testid="new-property-submit"]').trigger('click')
      expect(wrapper.find('[data-testid="property-add-error"]').text()).toContain('already exists')
      expect(wrapper.vm.getText()).toBe(content)

      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
      await flushPromises()
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      expect(wrapper.vm.getText()).toBe(content)
    })

    it('resets property overrides and add-form state when the note changes', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const first = '---\nchapter: "3"\n---\n\nFirst'
      const second = '---\nchapter: many\n---\n\nSecond'
      api.getVaultMarkdown
        .mockResolvedValueOnce({ directory: 'personal', path: 'Same.md', content: first, revision: 'a'.repeat(64) })
        .mockResolvedValueOnce({ directory: 'research', path: 'Same.md', content: second, revision: 'b'.repeat(64) })

      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'Same.md' } })
      await flushPromises()

      await wrapper.find('[data-testid="property-type-select"]').setValue('number')
      await wrapper.find('[data-testid="add-property-button"]').trigger('click')
      await wrapper.find('[data-testid="new-property-key-input"]').setValue('status')
      expect(wrapper.find('[data-testid="property-number-input"]').exists()).toBe(true)
      await wrapper.find('[data-testid="property-number-input"]').setValue('-')

      await wrapper.setProps({ directory: 'research' })
      await flushPromises()

      const chapter = wrapper.find('[data-property-key="chapter"]')
      expect(chapter.find('[data-testid="property-number-input"]').exists()).toBe(false)
      expect(chapter.find('[data-testid="property-text-input"]').element.value).toBe('many')
      expect(wrapper.find('[data-testid="new-property-key-input"]').exists()).toBe(false)
      expect(wrapper.vm.getText()).toBe(second)
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    })

    it('clears property errors and raw YAML mode when the note changes', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      api.getVaultMarkdown
        .mockResolvedValueOnce({ directory: 'personal', path: 'First.md', content: '---\nchapter: many\n---\n', revision: 'a'.repeat(64) })
        .mockResolvedValueOnce({ directory: 'personal', path: 'Second.md', content: '---\nchapter: 4\n---\n', revision: 'b'.repeat(64) })

      const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'First.md' } })
      await flushPromises()
      await wrapper.find('[data-testid="property-type-select"]').setValue('number')
      expect(wrapper.find('[data-testid="property-type-error"]').exists()).toBe(true)
      await wrapper.find('[data-testid="toggle-yaml-source-button"]').trigger('click')
      expect(wrapper.find('[data-testid="raw-yaml-textarea"]').exists()).toBe(true)

      await wrapper.setProps({ path: 'Second.md' })
      await flushPromises()

      expect(wrapper.find('[data-testid="property-type-error"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="raw-yaml-textarea"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('4')
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    })

    it('does not autosave a compatible type suggestion for a numeric YAML string', async () => {
      localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
      const content = '---\nchapter: "3"\n---\n\nBody'
      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal', path: 'Chapter.md', content, revision: 'a'.repeat(64),
      })
      const wrapper = mount(MarkdownViewer, {
        props: {
          directory: 'personal',
          path: 'Chapter.md',
          knownPropertyTypes: { chapter: 'number' },
        },
      })
      await flushPromises()

      expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('3')
      expect(wrapper.vm.getText()).toBe(content)
      vi.advanceTimersByTime(AUTOSAVE_DELAY_MS * 2)
      await flushPromises()
      expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
      expect(wrapper.vm.getText()).toBe(content)
    })

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
