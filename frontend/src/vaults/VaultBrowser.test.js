import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import VaultBrowser from './VaultBrowser.vue'
import * as api from './api.js'

vi.mock('./api.js', () => ({
  getVaultEntries: vi.fn(),
  getVaultMarkdown: vi.fn(),
}))

const vault = {
  id: 'vault-1',
  name: 'Personal Notes',
  directory: 'personal',
  registered: true,
}

const rootEntries = [
  { name: 'projects', path: 'projects', type: 'directory' },
  { name: 'journal', path: 'journal', type: 'directory' },
  { name: 'README.md', path: 'README.md', type: 'file' },
]

const projectsEntries = [
  { name: 'ayame', path: 'projects/ayame', type: 'directory' },
  { name: 'todo.txt', path: 'projects/todo.txt', type: 'file' },
]

const codedError = (code) => Object.assign(new Error(code), { code })

const mountBrowser = async (props = { vault }, initialEntries = rootEntries) => {
  api.getVaultEntries.mockResolvedValueOnce({
    directory: props.vault.directory,
    path: '',
    entries: initialEntries,
  })
  const wrapper = mount(VaultBrowser, { props })
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('VaultBrowser', () => {
  it('displays loading state during initial load', () => {
    api.getVaultEntries.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(VaultBrowser, { props: { vault } })

    expect(wrapper.text()).toContain('Loading directory...')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(api.getVaultEntries).toHaveBeenCalledWith('personal', '')
  })

  it('renders root listing with distinct folders and files', async () => {
    const wrapper = await mountBrowser()

    expect(wrapper.text()).toContain('Vaults')
    expect(wrapper.text()).toContain('Personal Notes')
    expect(wrapper.text()).toContain('Folders')
    expect(wrapper.text()).toContain('projects/')
    expect(wrapper.text()).toContain('journal/')
    expect(wrapper.text()).toContain('Files')
    expect(wrapper.text()).toContain('README.md')
  })

  it('navigates into directory when folder is clicked', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects',
      entries: projectsEntries,
    })

    const folderButton = wrapper.findAll('button').find((b) => b.text() === 'projects/')
    expect(folderButton).toBeDefined()
    await folderButton.trigger('click')
    await flushPromises()

    expect(api.getVaultEntries).toHaveBeenCalledWith('personal', 'projects')
    expect(wrapper.text()).toContain('ayame/')
    expect(wrapper.text()).toContain('todo.txt')
    expect(wrapper.text()).not.toContain('journal/')
  })

  it('navigates back to parent directory', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects',
      entries: projectsEntries,
    })

    await wrapper.findAll('button').find((b) => b.text() === 'projects/').trigger('click')
    await flushPromises()

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: rootEntries,
    })

    const parentButton = wrapper.find('[data-testid="parent-dir-button"]')
    expect(parentButton.exists()).toBe(true)
    await parentButton.trigger('click')
    await flushPromises()

    expect(api.getVaultEntries).toHaveBeenLastCalledWith('personal', '')
    expect(wrapper.text()).toContain('journal/')
  })

  it('renders breadcrumbs and navigates on breadcrumb segment click', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects/ayame',
      entries: [{ name: 'spec.md', path: 'projects/ayame/spec.md', type: 'file' }],
    })

    // Navigate directly into nested path via helper or state
    await wrapper.findAll('button').find((b) => b.text() === 'projects/').trigger('click')
    await flushPromises()

    const breadcrumbs = wrapper.find('[data-testid="breadcrumbs"]')
    expect(breadcrumbs.text()).toContain('Vaults')
    expect(breadcrumbs.text()).toContain('Personal Notes')
    expect(breadcrumbs.text()).toContain('projects')

    // Click root segment in breadcrumb to return to root
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: rootEntries,
    })
    const rootBreadcrumb = breadcrumbs.findAll('button').find((b) => b.text() === 'Personal Notes')
    await rootBreadcrumb.trigger('click')
    await flushPromises()

    expect(api.getVaultEntries).toHaveBeenLastCalledWith('personal', '')
  })

  it('emits back when returning to vaults list', async () => {
    const wrapper = await mountBrowser()

    const backButton = wrapper.find('[data-testid="back-to-vaults-button"]')
    expect(backButton.exists()).toBe(true)
    await backButton.trigger('click')

    expect(wrapper.emitted('back')).toBeTruthy()
  })

  it('displays empty directory state when entries array is empty', async () => {
    const wrapper = await mountBrowser({ vault }, [])

    expect(wrapper.text()).toContain('No files or folders found.')
  })

  it('refreshes current directory when Refresh button is clicked', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: [
        ...rootEntries,
        { name: 'new-folder', path: 'new-folder', type: 'directory' },
      ],
    })

    const refreshButton = wrapper.find('[data-testid="refresh-button"]')
    await refreshButton.trigger('click')
    await flushPromises()

    expect(api.getVaultEntries).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('new-folder/')
  })

  it('shows error with retry button on load failure, and retrying recovers', async () => {
    api.getVaultEntries.mockRejectedValueOnce(codedError('FAILED_TO_FETCH_ENTRIES'))
    const wrapper = mount(VaultBrowser, { props: { vault } })
    await flushPromises()

    expect(wrapper.text()).toContain('Could not load directory.')
    const retryButton = wrapper.find('[data-testid="retry-button"]')
    expect(retryButton.exists()).toBe(true)

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: rootEntries,
    })
    await retryButton.trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('projects/')
  })

  it('handles externally deleted directory with specific message and return button', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockRejectedValueOnce(codedError('VAULT_PATH_NOT_FOUND'))
    await wrapper.findAll('button').find((b) => b.text() === 'projects/').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('Directory not found.')
    // Previous directory entries must NOT be displayed as if they belong to the failed directory
    expect(wrapper.text()).not.toContain('journal/')
  })

  it('preserves existing listing on refresh failure but marks it stale', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockRejectedValueOnce(codedError('FAILED_TO_FETCH_ENTRIES'))
    await wrapper.find('[data-testid="refresh-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('projects/')
    expect(wrapper.text()).toContain('Listing may be out of date.')
  })

  it('emits unauthorized when getVaultEntries fails with UNAUTHORIZED', async () => {
    api.getVaultEntries.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
    const wrapper = mount(VaultBrowser, { props: { vault } })
    await flushPromises()

    expect(wrapper.emitted('unauthorized')).toBeTruthy()
  })

  it('ignores late responses after unmount', async () => {
    const pendingPromise = new Promise(() => {})
    api.getVaultEntries.mockReturnValueOnce(pendingPromise)
    const wrapper = mount(VaultBrowser, { props: { vault } })

    wrapper.unmount()
    // Should not throw or warn
    expect(wrapper.emitted('unauthorized')).toBeFalsy()
  })

  it('ignores older concurrent requests when a newer request finishes first', async () => {
    const wrapper = await mountBrowser()

    let resolveFirst
    const firstPromise = new Promise((res) => { resolveFirst = res })
    let resolveSecond
    const secondPromise = new Promise((res) => { resolveSecond = res })

    api.getVaultEntries.mockReturnValueOnce(firstPromise)
    // First navigation to projects
    wrapper.findAll('button').find((b) => b.text() === 'projects/').trigger('click')

    api.getVaultEntries.mockReturnValueOnce(secondPromise)
    // Second navigation back to root
    wrapper.find('[data-testid="refresh-button"]').trigger('click')

    // Second request finishes before first
    resolveSecond({
      directory: 'personal',
      path: '',
      entries: [{ name: 'latest.txt', path: 'latest.txt', type: 'file' }],
    })
    await flushPromises()
    expect(wrapper.text()).toContain('latest.txt')

    // Now first request finishes late
    resolveFirst({
      directory: 'personal',
      path: 'projects',
      entries: projectsEntries,
    })
    await flushPromises()

    // Must not be overwritten by late first response!
    expect(wrapper.text()).toContain('latest.txt')
    expect(wrapper.text()).not.toContain('ayame/')
  })

  it('unsupported files and ambiguous entries are displayed as static text and do not trigger navigation', async () => {
    const mixedEntries = [
      { name: 'notes.txt', path: 'notes.txt', type: 'file' },
      { name: 'photo.png', path: 'photo.png', type: 'file' },
      { name: 'ambiguous.md', path: null, type: 'file' },
    ]
    const wrapper = await mountBrowser({ vault }, mixedEntries)

    const items = wrapper.findAll('.browser-file-item')
    expect(items.length).toBe(3)
    for (const item of items) {
      expect(item.find('button').exists()).toBe(false)
      expect(item.find('a').exists()).toBe(false)
    }
  })

  describe('Markdown Viewer integration', () => {
    beforeEach(() => {
      api.getVaultMarkdown.mockResolvedValue({
        directory: 'personal',
        path: 'README.md',
        content: '# Hello README',
      })
    })

    it('opens .md file and displays MarkdownViewer receiving correct props', async () => {
      const wrapper = await mountBrowser()

      const readmeButton = wrapper.findAll('button[data-testid="open-file-button"]').find((b) => b.text().includes('README.md'))
      expect(readmeButton).toBeDefined()
      await readmeButton.trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)
      expect(api.getVaultMarkdown).toHaveBeenCalledWith('personal', 'README.md')
      expect(wrapper.text()).toContain('Hello README')
    })

    it('opens .markdown file', async () => {
      const markdownEntry = [{ name: 'spec.markdown', path: 'spec.markdown', type: 'file' }]
      const wrapper = await mountBrowser({ vault }, markdownEntry)

      const button = wrapper.find('button[data-testid="open-file-button"]')
      expect(button.exists()).toBe(true)
      expect(button.text()).toBe('spec.markdown')

      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal',
        path: 'spec.markdown',
        content: '# Spec Content',
      })

      await button.trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Spec Content')
    })

    it('updates breadcrumbs to include the selected file name at the end', async () => {
      const wrapper = await mountBrowser()

      await wrapper.find('button[data-testid="open-file-button"]').trigger('click')
      await flushPromises()

      const breadcrumbs = wrapper.find('[data-testid="breadcrumbs"]')
      expect(breadcrumbs.text()).toContain('Vaults')
      expect(breadcrumbs.text()).toContain('Personal Notes')
      expect(breadcrumbs.text()).toContain('README.md')
      expect(breadcrumbs.find('.breadcrumb-current').text()).toBe('README.md')
    })

    it('returning from MarkdownViewer restores the directory view with previous entries', async () => {
      const wrapper = await mountBrowser()

      await wrapper.find('button[data-testid="open-file-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)

      // Click back button inside viewer
      await wrapper.find('[data-testid="markdown-back-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(false)
      expect(wrapper.text()).toContain('Folders')
      expect(wrapper.text()).toContain('README.md')
    })

    it('opening a different file does not display content from the previous note', async () => {
      const entries = [
        { name: 'note-a.md', path: 'note-a.md', type: 'file' },
        { name: 'note-b.md', path: 'note-b.md', type: 'file' },
      ]
      const wrapper = await mountBrowser({ vault }, entries)

      api.getVaultMarkdown.mockResolvedValueOnce({
        directory: 'personal',
        path: 'note-a.md',
        content: '# Note A Content',
      })

      const buttons = wrapper.findAll('button[data-testid="open-file-button"]')
      await buttons[0].trigger('click')
      await flushPromises()
      expect(wrapper.text()).toContain('Note A Content')

      // Return to directory
      await wrapper.find('[data-testid="markdown-back-button"]').trigger('click')
      await flushPromises()

      // Open second file with delayed response
      let resolveSecond
      api.getVaultMarkdown.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSecond = resolve
        })
      )

      await wrapper.findAll('button[data-testid="open-file-button"]')[1].trigger('click')
      // Note A content must NOT be displayed
      expect(wrapper.text()).not.toContain('Note A Content')

      resolveSecond({
        directory: 'personal',
        path: 'note-b.md',
        content: '# Note B Content',
      })
      await flushPromises()
      expect(wrapper.text()).toContain('Note B Content')
    })

    it('propagates unauthorized error from MarkdownViewer by emitting unauthorized', async () => {
      const wrapper = await mountBrowser()

      api.getVaultMarkdown.mockRejectedValueOnce(codedError('UNAUTHORIZED'))

      await wrapper.find('button[data-testid="open-file-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.emitted('unauthorized')).toBeTruthy()
      expect(wrapper.emitted('unauthorized').length).toBe(1)
    })

    it('navigating breadcrumb back to vaults emits back and leaves viewer', async () => {
      const wrapper = await mountBrowser()

      await wrapper.find('button[data-testid="open-file-button"]').trigger('click')
      await flushPromises()

      // Click "Vaults" in breadcrumbs
      const vaultsBreadcrumb = wrapper.findAll('.btn-breadcrumb').find((b) => b.text() === 'Vaults')
      await vaultsBreadcrumb.trigger('click')

      expect(wrapper.emitted('back')).toBeTruthy()
    })
  })
})
