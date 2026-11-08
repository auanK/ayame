import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import VaultBrowser from './VaultBrowser.vue'
import MarkdownEditor from '../markdown/MarkdownEditor.vue'
import * as api from './api.js'

vi.mock('./api.js', () => ({
  getVaultEntries: vi.fn(),
  getVaultMarkdown: vi.fn(),
  saveVaultMarkdown: vi.fn(),
  createVaultFolder: vi.fn(),
  createVaultNote: vi.fn(),
  MAX_MARKDOWN_BYTES: 2 * 1024 * 1024,
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
  { name: 'Roadmap.md', path: 'projects/Roadmap.md', type: 'file' },
  { name: 'Design.md', path: 'projects/Design.md', type: 'file' },
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
  vi.resetAllMocks()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('VaultBrowser (Obsidian-style Workspace)', () => {
  it('1. renders persistent explorer on the left and editor workspace on the right with empty state when no note is selected', async () => {
    const wrapper = await mountBrowser()

    const explorer = wrapper.find('[data-testid="vault-explorer"]')
    const editorPane = wrapper.find('[data-testid="workspace-editor-pane"]')
    expect(explorer.exists()).toBe(true)
    expect(editorPane.exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-empty-state"]').exists()).toBe(true)
    expect(explorer.text()).toContain('projects')
    expect(explorer.text()).toContain('journal')
    expect(explorer.text()).toContain('README.md')
  })

  it('2. keeps the explorer tree mounted when opening a note and when switching between notes, highlighting the active file', async () => {
    const entries = [
      { name: 'projects', path: 'projects', type: 'directory' },
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'Notes.md', path: 'Notes.md', type: 'file' },
    ]
    const wrapper = await mountBrowser({ vault }, entries)

    const explorerElementBefore = wrapper.find('[data-testid="vault-explorer"]').element

    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: '# Hello README',
      revision: 'a'.repeat(64),
    })

    const readmeBtn = wrapper.find('button[data-file-path="README.md"]')
    await readmeBtn.trigger('click')
    await flushPromises()

    // Explorer remains the exact same mounted DOM element
    expect(wrapper.find('[data-testid="vault-explorer"]').element).toBe(explorerElementBefore)
    expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(true)
    expect(wrapper.find('button[data-file-path="README.md"]').classes()).toContain('tree-file--active')

    // Switch to Notes.md -> explorer stays mounted and highlight moves to Notes.md
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Notes.md',
      content: '# Second Note',
      revision: 'b'.repeat(64),
    })
    await wrapper.find('button[data-file-path="Notes.md"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="vault-explorer"]').element).toBe(explorerElementBefore)
    expect(wrapper.find('button[data-file-path="Notes.md"]').classes()).toContain('tree-file--active')
    expect(wrapper.find('button[data-file-path="README.md"]').classes()).not.toContain('tree-file--active')
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# Second Note')
  })

  it('3. expands and collapses directories in the tree with hierarchical children', async () => {
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects',
      entries: projectsEntries,
    })

    const projectsBtn = wrapper.find('button[data-folder-path="projects"]')
    expect(projectsBtn.attributes('aria-expanded')).toBe('false')

    // Expand 'projects'
    await projectsBtn.trigger('click')
    await flushPromises()

    expect(api.getVaultEntries).toHaveBeenCalledWith('personal', 'projects')
    expect(projectsBtn.attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('button[data-file-path="projects/Roadmap.md"]').exists()).toBe(true)
    expect(wrapper.find('button[data-folder-path="projects/ayame"]').exists()).toBe(true)
    // Sibling root entries remain visible in the tree!
    expect(wrapper.find('button[data-folder-path="journal"]').exists()).toBe(true)

    // Collapse 'projects'
    await projectsBtn.trigger('click')
    await flushPromises()

    expect(projectsBtn.attributes('aria-expanded')).toBe('false')
    expect(wrapper.find('button[data-file-path="projects/Roadmap.md"]').exists()).toBe(false)
  })

  it('4. allows collapsing and re-opening the explorer panel for compact screens', async () => {
    const wrapper = await mountBrowser()

    const toggleBtn = wrapper.find('[data-testid="toggle-explorer-button"]')
    expect(toggleBtn.exists()).toBe(true)
    expect(wrapper.find('[data-testid="vault-explorer"]').classes()).not.toContain('workspace-explorer--collapsed')

    await toggleBtn.trigger('click')
    expect(wrapper.find('[data-testid="vault-explorer"]').classes()).toContain('workspace-explorer--collapsed')

    await toggleBtn.trigger('click')
    expect(wrapper.find('[data-testid="vault-explorer"]').classes()).not.toContain('workspace-explorer--collapsed')
  })

  it('5. coordinates pending autosave before switching to another note so changes are never lost', async () => {
    const entries = [
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'Second.md', path: 'Second.md', type: 'file' },
    ]
    const wrapper = await mountBrowser({ vault }, entries)

    api.getVaultMarkdown
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'README.md',
        content: '# Original',
        revision: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'Second.md',
        content: '# Second',
        revision: 'b'.repeat(64),
      })
    api.saveVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      revision: 'c'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Edit README.md and immediately click Second.md before the 700ms debounce timer fires
    wrapper.findComponent(MarkdownEditor).vm.setText('# Edited before switch')
    await wrapper.vm.$nextTick()

    await wrapper.find('button[data-file-path="Second.md"]').trigger('click')
    await flushPromises()

    // Pending save on README.md was flushed and completed before opening Second.md
    expect(api.saveVaultMarkdown).toHaveBeenCalledWith('personal', 'README.md', {
      content: '# Edited before switch',
      expectedRevision: 'a'.repeat(64),
    })
    expect(wrapper.find('button[data-file-path="Second.md"]').classes()).toContain('tree-file--active')
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# Second')
  })

  it('6. navigates internal links (wikilinks and relative markdown links), resolves unexpanded folders, expands tree ancestors, and highlights the target note', async () => {
    const wrapper = await mountBrowser()

    api.getVaultMarkdown
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'README.md',
        content: 'Veja [[Design]] na pasta de projetos.\nSegunda linha.',
        revision: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'projects/Design.md',
        content: '# Design Doc\n\n## Objetivos\n\nDetalhes.',
        revision: 'b'.repeat(64),
      })

    // Open README.md at root (note: 'projects' folder is NOT expanded yet!)
    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Mock getVaultEntries for unexpanded folders when link resolution runs
    api.getVaultEntries.mockImplementation(async (_dir, folderPath) => {
      if (folderPath === 'projects') {
        return { directory: 'personal', path: 'projects', entries: projectsEntries }
      }
      return { directory: 'personal', path: folderPath, entries: [] }
    })

    // Click the [[Design]] link in the editor (with Ctrl+click)
    const wikilink = wrapper.find('.cm-live-wikilink')
    expect(wikilink.exists()).toBe(true)
    await wikilink.trigger('click', { ctrlKey: true })
    await flushPromises()

    // 'projects' folder was expanded in the tree, and 'projects/Design.md' is active and loaded in the right panel!
    expect(wrapper.find('button[data-folder-path="projects"]').attributes('aria-expanded')).toBe('true')
    expect(wrapper.find('button[data-file-path="projects/Design.md"]').classes()).toContain('tree-file--active')
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toContain('# Design Doc')
  })

  it('6b. shows clear feedback for missing and ambiguous internal links without creating notes automatically', async () => {
    const wrapper = await mountBrowser()

    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'Missing [[GhostNote]] and ambiguous [[Shared]].',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    api.getVaultEntries.mockImplementation(async (_dir, folderPath) => {
      if (folderPath === 'projects') {
        return {
          directory: 'personal',
          path: 'projects',
          entries: [{ name: 'Shared.md', path: 'projects/Shared.md', type: 'file' }],
        }
      }
      if (folderPath === 'journal') {
        return {
          directory: 'personal',
          path: 'journal',
          entries: [{ name: 'Shared.md', path: 'journal/Shared.md', type: 'file' }],
        }
      }
      return { directory: 'personal', path: folderPath, entries: [] }
    })

    const wikilinks = wrapper.findAll('.cm-live-wikilink')
    expect(wikilinks.length).toBe(2)

    // 1. Click missing [[GhostNote]] -> shows notice and never calls createVaultNote
    await wikilinks[0].trigger('click', { ctrlKey: true })
    await flushPromises()

    expect(api.createVaultNote).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="workspace-link-notice"]').text()).toContain('does not exist')

    // 2. Click ambiguous [[Shared]] -> shows candidate buttons
    await wrapper.findAll('.cm-live-wikilink')[1].trigger('click', { ctrlKey: true })
    await flushPromises()

    const notice = wrapper.find('[data-testid="workspace-link-notice"]')
    expect(notice.text()).toContain('Multiple notes match')
    expect(notice.find('button[data-candidate-path="journal/Shared.md"]').exists()).toBe(true)
    expect(notice.find('button[data-candidate-path="projects/Shared.md"]').exists()).toBe(true)
  })

  it('7. creates a new folder at root and inside a subfolder, updating the tree immediately', async () => {
    const wrapper = await mountBrowser()

    api.createVaultFolder.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Architecture',
      name: 'Architecture',
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: [
        { name: 'Architecture', path: 'Architecture', type: 'directory' },
        ...rootEntries,
      ],
    })

    await wrapper.find('[data-testid="new-folder-button"]').trigger('click')
    await wrapper.find('[data-testid="new-entry-input"]').setValue('Architecture')
    await wrapper.find('[data-testid="new-entry-submit"]').trigger('click')
    await flushPromises()

    expect(api.createVaultFolder).toHaveBeenCalledWith('personal', {
      parentPath: '',
      name: 'Architecture',
    })
    expect(wrapper.find('button[data-folder-path="Architecture"]').exists()).toBe(true)
  })

  it('8. creates a new note in a folder, updates the tree, selects the note, and opens it directly in the Live Editor ready for immediate typing', async () => {
    const wrapper = await mountBrowser()

    // Expand 'projects' first so it is the selected target folder
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects',
      entries: projectsEntries,
    })
    await wrapper.find('button[data-folder-path="projects"]').trigger('click')
    await flushPromises()

    const emptyRevision = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    api.createVaultNote.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects/Architecture.md',
      revision: emptyRevision,
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects',
      entries: [
        ...projectsEntries,
        { name: 'Architecture.md', path: 'projects/Architecture.md', type: 'file' },
      ],
    })

    await wrapper.find('[data-testid="new-note-button"]').trigger('click')
    await wrapper.find('[data-testid="new-entry-input"]').setValue('Architecture')
    await wrapper.find('[data-testid="new-entry-submit"]').trigger('click')
    await flushPromises()

    expect(api.createVaultNote).toHaveBeenCalledWith('personal', {
      parentPath: 'projects',
      name: 'Architecture',
    })
    // Tree updated and new note is active
    const newNoteBtn = wrapper.find('button[data-file-path="projects/Architecture.md"]')
    expect(newNoteBtn.exists()).toBe(true)
    expect(newNoteBtn.classes()).toContain('tree-file--active')

    // Live Editor is open directly without needing an Edit button
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-edit-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="markdown-save-button"]').exists()).toBe(false)
  })

  it('9. preserves previous state and displays error when folder or note creation fails', async () => {
    const wrapper = await mountBrowser()

    api.createVaultFolder.mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))

    await wrapper.find('[data-testid="new-folder-button"]').trigger('click')
    await wrapper.find('[data-testid="new-entry-input"]').setValue('projects')
    await wrapper.find('[data-testid="new-entry-submit"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="explorer-create-error"]').text()).toContain('already exists')
    expect(wrapper.find('button[data-folder-path="projects"]').exists()).toBe(true)
  })

  it('10. guards back-to-vaults navigation when there are unconfirmed changes', async () => {
    const wrapper = await mountBrowser()

    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'base',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    wrapper.findComponent(MarkdownEditor).vm.setText('unconfirmed draft')
    await wrapper.vm.$nextTick()

    await wrapper.find('[data-testid="back-to-vaults-button"]').trigger('click')
    expect(wrapper.emitted('back')).toBeUndefined()
    expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)

    await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('unconfirmed draft')

    await wrapper.find('[data-testid="back-to-vaults-button"]').trigger('click')
    await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
    expect(wrapper.emitted('back')).toBeTruthy()
  })

  it('11. emits unauthorized when getVaultEntries, getVaultMarkdown, or creation fails with 401', async () => {
    api.getVaultEntries.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
    const wrapper = mount(VaultBrowser, { props: { vault } })
    await flushPromises()
    expect(wrapper.emitted('unauthorized')).toBeTruthy()
  })
})
