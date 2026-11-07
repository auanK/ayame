import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import VaultBrowser from './VaultBrowser.vue'
import * as api from './api.js'

vi.mock('./api.js', () => ({
  getVaultEntries: vi.fn(),
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

  it('files are displayed as static text and do not trigger navigation', async () => {
    const wrapper = await mountBrowser()

    const readmeItem = wrapper.findAll('.browser-file-item').find((i) => i.text().includes('README.md'))
    expect(readmeItem).toBeDefined()
    expect(readmeItem.find('button').exists()).toBe(false)
    expect(readmeItem.find('a').exists()).toBe(false)
  })
})
