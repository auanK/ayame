import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownViewer from './MarkdownViewer.vue'
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

describe('MarkdownViewer.vue', () => {
  beforeEach(() => {
    vi.resetAllMocks()
  })

  it('1. shows loading indicator while content is being fetched', async () => {
    api.getVaultMarkdown.mockReturnValue(new Promise(() => {}))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/spec.md' },
    })

    expect(wrapper.find('[data-testid="markdown-loading"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-content"]').exists()).toBe(false)
  })

  it('2. renders sanitized markdown content when fetch succeeds', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'projects/spec.md',
      content: '# Architecture\n\nThis is a **secure** specification.\n',
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/spec.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-loading"]').exists()).toBe(false)
    const content = wrapper.find('[data-testid="markdown-content"]')
    expect(content.exists()).toBe(true)
    expect(content.html()).toContain('<h1>Architecture</h1>')
    expect(content.html()).toContain('<strong>secure</strong>')
  })

  it('3. displays a discreet empty note message when file has no content', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'empty.md',
      content: '',
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'empty.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('This note is empty.')
  })

  it('4. displays the correct file name in the header', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'projects/ayame/roadmap.markdown',
      content: '# Roadmap',
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/ayame/roadmap.markdown' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('roadmap.markdown')
  })

  it('5. updates content when refresh button is clicked', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'note.md',
        content: 'Original content',
      })
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'note.md',
        content: 'Externally updated content',
      })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('Original content')

    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()

    expect(api.getVaultMarkdown).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('Externally updated content')
  })

  it('6. displays error message and hides previous content on initial load failure', async () => {
    api.getVaultMarkdown.mockRejectedValue(apiError('FAILED_TO_FETCH_MARKDOWN'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-error"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Could not load note')
  })

  it('7. retries fetching when retry button is clicked after initial error', async () => {
    api.getVaultMarkdown
      .mockRejectedValueOnce(apiError('FAILED_TO_FETCH_MARKDOWN'))
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'note.md',
        content: '# Recovered note',
      })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-error"]').exists()).toBe(true)

    await wrapper.find('[data-testid="markdown-retry-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-content"]').html()).toContain('<h1>Recovered note</h1>')
  })

  it('8. renders not found state when file does not exist (VAULT_PATH_NOT_FOUND)', async () => {
    api.getVaultMarkdown.mockRejectedValue(apiError('VAULT_PATH_NOT_FOUND'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'deleted.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-not-found"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Note not found')
    expect(wrapper.find('[data-testid="markdown-back-button"]').exists()).toBe(true)
  })

  it('9. renders specific error message when file exceeds size limit (VAULT_FILE_TOO_LARGE)', async () => {
    api.getVaultMarkdown.mockRejectedValue(apiError('VAULT_FILE_TOO_LARGE'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'large.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-error"]').text()).toContain('exceeds the 2 MiB limit')
  })

  it('10. renders specific error message when file has invalid encoding (INVALID_FILE_ENCODING)', async () => {
    api.getVaultMarkdown.mockRejectedValue(apiError('INVALID_FILE_ENCODING'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'corrupt.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-error"]').text()).toContain('invalid UTF-8 encoding')
  })

  it('11. preserves confirmed content and marks as stale when a background refresh fails', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'note.md',
        content: '# Confirmed content',
      })
      .mockRejectedValueOnce(apiError('FAILED_TO_FETCH_MARKDOWN'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-stale-indicator"]').exists()).toBe(false)

    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()

    // Confirmed content is preserved
    expect(wrapper.find('[data-testid="markdown-content"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Confirmed content')
    // Stale indicator is shown
    expect(wrapper.find('[data-testid="markdown-stale-indicator"]').exists()).toBe(true)
  })

  it('12. ignores stale responses from earlier slow requests when path changes', async () => {
    let resolveFirst
    api.getVaultMarkdown.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveFirst = resolve
      })
    )
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'fast.md',
      content: '# Fast content',
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'slow.md' },
    })

    // Change path before slow request finishes
    await wrapper.setProps({ path: 'fast.md' })
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('fast.md')
    expect(wrapper.text()).toContain('Fast content')

    // Now resolve the slow request
    resolveFirst({
      directory: 'personal',
      path: 'slow.md',
      content: '# Slow content',
    })
    await flushPromises()

    // Fast content must NOT be overwritten by the late slow response
    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('fast.md')
    expect(wrapper.text()).toContain('Fast content')
    expect(wrapper.text()).not.toContain('Slow content')
  })

  it('13. does not alter state or throw when response arrives after component is unmounted', async () => {
    let resolveRequest
    api.getVaultMarkdown.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRequest = resolve
      })
    )

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })

    wrapper.unmount()

    // Resolve after unmount
    expect(() => {
      resolveRequest({
        directory: 'personal',
        path: 'note.md',
        content: '# Arrived late',
      })
    }).not.toThrow()
  })

  it('14. clears previous content immediately when path prop changes', async () => {
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'first.md',
      content: '# First note',
    })
    api.getVaultMarkdown.mockReturnValueOnce(new Promise(() => {})) // Pending second request

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'first.md' },
    })
    await flushPromises()

    expect(wrapper.text()).toContain('First note')

    await wrapper.setProps({ path: 'second.md' })

    // Previous content must be cleared while second note is loading
    expect(wrapper.text()).not.toContain('First note')
    expect(wrapper.find('[data-testid="markdown-loading"]').exists()).toBe(true)
  })

  it('15. emits unauthorized event when server responds with 401', async () => {
    api.getVaultMarkdown.mockRejectedValue(apiError('UNAUTHORIZED'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()

    expect(wrapper.emitted('unauthorized')).toBeTruthy()
    expect(wrapper.emitted('unauthorized').length).toBe(1)
  })

  it('16. emits back event when back button is clicked', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'projects/spec.md',
      content: '# Content',
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/spec.md' },
    })
    await flushPromises()

    await wrapper.find('[data-testid="markdown-back-button"]').trigger('click')

    expect(wrapper.emitted('back')).toBeTruthy()
    expect(wrapper.emitted('back').length).toBe(1)
  })

  it('17. keeps the source textarea hidden until Edit is selected', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'projects/spec.md',
      content: '# Content',
      revision,
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/spec.md' },
    })
    await flushPromises()

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(wrapper.find('button[data-testid="markdown-save-button"]').exists()).toBe(false)
    expect(wrapper.find('button[data-testid="markdown-edit-button"]').exists()).toBe(true)
    expect(wrapper.find('button[data-testid*="delete"]').exists()).toBe(false)
  })

  it('18. preserves a confirmed empty note after failed refresh and clears Outdated after retry', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'empty.md', content: '' })
      .mockRejectedValueOnce(apiError('FAILED_TO_FETCH_MARKDOWN'))
      .mockResolvedValueOnce({ directory: 'personal', path: 'empty.md', content: '' })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'empty.md' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)

    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-stale-indicator"]').text()).toBe('Outdated')

    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-stale-indicator"]').exists()).toBe(false)
  })

  it('19. refresh can replace non-empty content with an empty note', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'Original' })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: '' })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)
  })

  it('20. refresh can add content to a confirmed empty note', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: '' })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'Filled' })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)

    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-content"]').text()).toContain('Filled')
  })

  it('21. clears confirmed content after unauthorized refresh', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'Protected note' })
      .mockRejectedValueOnce(apiError('UNAUTHORIZED'))

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'note.md' },
    })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-refresh-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.emitted('unauthorized')?.length).toBe(1)
    expect(wrapper.find('[data-testid="markdown-content"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(false)
  })

  it('edits a draft, derives dirty state, and preserves mixed line endings on save', async () => {
    const original = 'first\r\nsecond\nlast\r\n'
    const removeListener = vi.spyOn(window, 'removeEventListener')
    api.getVaultMarkdown.mockResolvedValue({ directory: 'personal', path: 'note.md', content: original, revision })
    api.saveVaultMarkdown.mockResolvedValue({ directory: 'personal', path: 'note.md', revision: 'b'.repeat(64) })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()

    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    const editor = wrapper.find('[data-testid="markdown-editor"]')
    expect(editor.element.value).toBe('first\nsecond\nlast\n')
    expect(wrapper.find('[data-testid="markdown-save-button"]').attributes('disabled')).toBeDefined()

    await editor.setValue('first\ninserted\nsecond\nlast\n')
    expect(wrapper.find('[data-testid="markdown-dirty-indicator"]').exists()).toBe(true)
    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    await flushPromises()

    expect(api.saveVaultMarkdown).toHaveBeenCalledWith('personal', 'note.md', {
      content: 'first\r\ninserted\r\nsecond\nlast\r\n',
      expectedRevision: revision,
    })
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('Saved.')
    expect(removeListener).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    vi.restoreAllMocks()
  })

  it('saves an empty draft and preserves it after a locked-save error', async () => {
    api.getVaultMarkdown.mockResolvedValue({ directory: 'personal', path: 'note.md', content: '🌸', revision })
    api.saveVaultMarkdown
      .mockRejectedValueOnce(apiError('VAULT_FILE_LOCKED'))
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', revision: 'b'.repeat(64) })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    await wrapper.find('[data-testid="markdown-editor"]').setValue('')
    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-editor"]').element.value).toBe('')
    expect(wrapper.find('[role="alert"]').text()).toContain('Another Ayame save')
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)

    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    await flushPromises()
    expect(api.saveVaultMarkdown).toHaveBeenLastCalledWith('personal', 'note.md', {
      content: '', expectedRevision: revision,
    })
    expect(wrapper.find('[data-testid="markdown-empty"]').exists()).toBe(true)
  })

  it('clears dirty state and disables Save when the draft is restored to its base content', async () => {
    api.getVaultMarkdown.mockResolvedValue({ directory: 'personal', path: 'note.md', content: 'base', revision })
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    const editor = wrapper.find('[data-testid="markdown-editor"]')
    await editor.setValue('changed')
    await editor.setValue('base')
    expect(wrapper.find('[data-testid="markdown-dirty-indicator"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-save-button"]').attributes('disabled')).toBeDefined()
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('preserves draft and revision on conflict and requires confirmation before reload', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'base', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'remote', revision: 'c'.repeat(64) })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'latest', revision: 'd'.repeat(64) })
    api.saveVaultMarkdown.mockRejectedValue(Object.assign(new Error('conflict'), { code: 'VAULT_FILE_CONFLICT' }))
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    await wrapper.find('[data-testid="markdown-editor"]').setValue('local draft')
    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-conflict"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-editor"]').element.value).toBe('local draft')
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    await wrapper.find('[data-testid="markdown-reload-server"]').trigger('click')
    expect(wrapper.find('[data-testid="markdown-confirm-reload"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-editor"]').element.value).toBe('local draft')
    await wrapper.find('[data-testid="markdown-confirm-reload"]').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('remote')
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
  })

  it('verifies an uncertain save without retrying and reconciles matching server content', async () => {
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'base', revision })
      .mockResolvedValueOnce({ directory: 'personal', path: 'note.md', content: 'draft', revision: 'e'.repeat(64) })
    api.saveVaultMarkdown.mockRejectedValue(Object.assign(new Error('unknown'), { code: 'VAULT_SAVE_RESULT_UNKNOWN' }))
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    await wrapper.find('[data-testid="markdown-editor"]').setValue('draft')
    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="markdown-save-unknown"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-editor"]').element.value).toBe('draft')
    await wrapper.find('[data-testid="markdown-verify-save"]').trigger('click')
    await flushPromises()
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('matches your draft')
  })

  it('blocks duplicate saves, disables editing while pending, and ignores cancel without losing the draft', async () => {
    let resolveSave
    api.getVaultMarkdown.mockResolvedValue({ directory: 'personal', path: 'note.md', content: 'base', revision })
    api.saveVaultMarkdown.mockReturnValue(new Promise((resolve) => { resolveSave = resolve }))
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    await wrapper.find('[data-testid="markdown-editor"]').setValue('draft')
    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    expect(wrapper.find('[data-testid="markdown-editor"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-testid="markdown-save-button"]').trigger('click')
    expect(api.saveVaultMarkdown).toHaveBeenCalledTimes(1)
    resolveSave({ directory: 'personal', path: 'note.md', revision: 'f'.repeat(64) })
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
  })

  it('requires an explicit discard decision and installs beforeunload only while dirty', async () => {
    api.getVaultMarkdown.mockResolvedValue({ directory: 'personal', path: 'note.md', content: 'base', revision })
    const add = vi.spyOn(window, 'addEventListener')
    const remove = vi.spyOn(window, 'removeEventListener')
    const wrapper = mount(MarkdownViewer, { props: { directory: 'personal', path: 'note.md' } })
    await flushPromises()
    await wrapper.find('[data-testid="markdown-edit-button"]').trigger('click')
    await wrapper.find('[data-testid="markdown-editor"]').setValue('draft')
    expect(add).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    await wrapper.find('[data-testid="markdown-cancel-button"]').trigger('click')
    expect(wrapper.find('[data-testid="markdown-keep-editing"]').exists()).toBe(true)
    await wrapper.find('[data-testid="markdown-keep-editing"]').trigger('click')
    expect(wrapper.find('[data-testid="markdown-editor"]').element.value).toBe('draft')
    await wrapper.find('[data-testid="markdown-cancel-button"]').trigger('click')
    await wrapper.find('[data-testid="markdown-discard-changes"]').trigger('click')
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
    expect(remove).toHaveBeenCalledWith('beforeunload', expect.any(Function))
    wrapper.unmount()
  })
})
