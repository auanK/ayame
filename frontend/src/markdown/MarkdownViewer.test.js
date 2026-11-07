import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import MarkdownViewer from './MarkdownViewer.vue'
import * as api from '../vaults/api.js'

vi.mock('../vaults/api.js', () => ({
  getVaultMarkdown: vi.fn(),
}))

const apiError = (code) => {
  const err = new Error(code)
  err.code = code
  return err
}

describe('MarkdownViewer.vue', () => {
  beforeEach(() => {
    vi.clearAllMocks()
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

  it('17. performs exclusively read-only operations without save, edit or mutate controls', async () => {
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'projects/spec.md',
      content: '# Content',
    })

    const wrapper = mount(MarkdownViewer, {
      props: { directory: 'personal', path: 'projects/spec.md' },
    })
    await flushPromises()

    expect(wrapper.find('textarea').exists()).toBe(false)
    expect(wrapper.find('input[type="text"]').exists()).toBe(false)
    expect(wrapper.find('button[data-testid*="save"]').exists()).toBe(false)
    expect(wrapper.find('button[data-testid*="edit"]').exists()).toBe(false)
    expect(wrapper.find('button[data-testid*="delete"]').exists()).toBe(false)
  })
})
