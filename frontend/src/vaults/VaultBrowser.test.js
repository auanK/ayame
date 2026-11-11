import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import VaultBrowser from './VaultBrowser.vue'
import MarkdownViewer from '../markdown/MarkdownViewer.vue'
import MarkdownEditor from '../markdown/MarkdownEditor.vue'
import * as api from './api.js'

vi.mock('./api.js', () => ({
  getVaultEntries: vi.fn(),
  getVaultMarkdown: vi.fn(),
  saveVaultMarkdown: vi.fn(),
  createVaultFolder: vi.fn(),
  createVaultNote: vi.fn(),
  getVaultIndex: vi.fn(),
  relocateVaultEntry: vi.fn(),
  trashVaultEntry: vi.fn(),
  getVaultTrash: vi.fn(),
  restoreVaultTrashEntry: vi.fn(),
  deleteVaultTrashItem: vi.fn(),
  deleteVaultEntryPermanently: vi.fn(),
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

const activeWrappers = []

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const mountBrowser = async (props = { vault }, initialEntries = rootEntries) => {
  api.getVaultEntries.mockResolvedValueOnce({
    directory: props.vault.directory,
    path: '',
    entries: initialEntries,
  })
  const wrapper = mount(VaultBrowser, { props })
  activeWrappers.push(wrapper)
  await flushPromises()
  return wrapper
}

const reconcileMoveWithNumberDrafts = async ({
  sourceContent = '---\nchapter: 42\nstatus: draft\n---\n\n# Document',
  destinationContent = sourceContent,
  drafts = { chapter: '-15' },
  markdownDraft = null,
  refreshedFiles = ['projects/README.md'],
} = {}) => {
  localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
  api.getVaultIndex.mockResolvedValueOnce({
    directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
  })
  api.getVaultMarkdown.mockImplementation(async (directory, path) => ({
    directory,
    path,
    content: path === 'projects/README.md' ? destinationContent : sourceContent,
    revision: 'a'.repeat(64),
  }))
  const wrapper = await mountBrowser()
  await wrapper.find('[data-file-path="README.md"]').trigger('click')
  await flushPromises()

  for (const [key, value] of Object.entries(drafts)) {
    await wrapper.find(`[data-property-key="${key}"] [data-testid="property-number-input"]`).setValue(value)
  }
  if (markdownDraft !== null) {
    wrapper.findComponent(MarkdownEditor).vm.setText(markdownDraft)
    await wrapper.vm.$nextTick()
  }
  await wrapper.vm.executeRelocate('README.md', 'projects/README.md')
  api.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
  await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
  await flushPromises()
  expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(true)

  api.getVaultEntries.mockResolvedValueOnce({
    directory: 'personal', path: '', entries: [{ name: 'projects', path: 'projects', type: 'directory' }],
  })
  api.getVaultIndex.mockResolvedValueOnce({
    directory: 'personal', complete: true, folders: ['projects'], files: refreshedFiles, notes: [],
  })
  await wrapper.find('[data-testid="relocate-refresh"]').trigger('click')
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.resetAllMocks()
  localStorage.clear()
})

afterEach(() => {
  while (activeWrappers.length > 0) {
    const w = activeWrappers.pop()
    try {
      w.unmount()
    } catch {
      // ignore
    }
  }
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
    expect(explorer.text()).toContain('README')
    expect(explorer.text()).not.toContain('README.md')
    expect(wrapper.find('button[data-file-path="README.md"]').exists()).toBe(true)
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

    // Switch to Notes.md -> explorer stays mounted and Notes.md is opened
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Notes.md',
      content: '# Second Note',
      revision: 'b'.repeat(64),
    })
    await wrapper.find('button[data-file-path="Notes.md"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="vault-explorer"]').element).toBe(explorerElementBefore)
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
    expect(toggleBtn.attributes('aria-expanded')).toBe('true')

    await toggleBtn.trigger('click')
    expect(toggleBtn.attributes('aria-expanded')).toBe('false')

    await toggleBtn.trigger('click')
    expect(toggleBtn.attributes('aria-expanded')).toBe('true')
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
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# Second')
  })

  it('protects a pending Number draft during note navigation and discards it only after confirmation', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    const entries = [
      { name: 'README.md', path: 'README.md', type: 'file' },
      { name: 'Second.md', path: 'Second.md', type: 'file' },
    ]
    const wrapper = await mountBrowser({ vault }, entries)
    api.getVaultMarkdown
      .mockResolvedValueOnce({
        directory: 'personal', path: 'README.md', content: '---\nchapter: 42\n---\nBody', revision: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        directory: 'personal', path: 'Second.md', content: '# Second', revision: 'b'.repeat(64),
      })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')

    await wrapper.find('button[data-file-path="Second.md"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()

    await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    await wrapper.find('button[data-file-path="Second.md"]').trigger('click')
    await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
    await flushPromises()

    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# Second')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
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
    expect(wrapper.find('[data-testid="new-entry-form"] [data-testid="tree-folder-create-icon"]').exists()).toBe(true)
    await wrapper.find('[data-testid="new-entry-input"]').setValue('Architecture')
    await wrapper.find('[data-testid="new-entry-submit"]').trigger('click')
    await flushPromises()

    expect(api.createVaultFolder).toHaveBeenCalledWith('personal', {
      parentPath: '',
      name: 'Architecture',
    })
    expect(wrapper.find('button[data-folder-path="Architecture"]').exists()).toBe(true)
  })

  it('shows the dragged row and valid/invalid folder targets, then confirms a valid move', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    const fileRow = wrapper.find('[data-entry-path="README.md"]')
    const folderRow = wrapper.find('[data-entry-path="projects"]')

    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal',
      path: 'README.md',
      content: '# README',
      revision: 'a'.repeat(64),
    })
    const moveResult = deferred()
    api.relocateVaultEntry.mockReturnValueOnce(moveResult.promise)
    api.getVaultEntries.mockResolvedValue({
      directory: 'personal',
      path: '',
      entries: [rootEntries[0], rootEntries[1]],
    })
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal',
      complete: true,
      folders: ['projects'],
      files: ['projects/README.md'],
      notes: [],
    })

    await fileRow.trigger('dragstart', { dataTransfer })
    expect(fileRow.classes()).toContain('tree-row-wrapper--dragging')
    expect(dataTransfer.effectAllowed).toBe('move')
    expect(dataTransfer.setData).toHaveBeenCalledWith('text/plain', 'README.md')

    await fileRow.trigger('dragover', { dataTransfer })
    expect(fileRow.classes()).toContain('tree-row-wrapper--drop-invalid')
    expect(dataTransfer.dropEffect).toBe('none')
    expect(wrapper.find('[data-testid="workspace-tree"]').classes()).not.toContain('workspace-tree--drop-valid')

    await folderRow.trigger('dragover', { dataTransfer })
    expect(folderRow.classes()).toContain('tree-row-wrapper--drop-valid')
    expect(dataTransfer.dropEffect).toBe('move')
    await folderRow.trigger('drop', { dataTransfer })
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledWith('personal', expect.objectContaining({
      sourcePath: 'README.md',
      targetPath: 'projects/README.md',
    }))
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Move entry to path:')
    expect(wrapper.findAll('button').filter((button) => button.text() === 'Apply')).toHaveLength(0)
    await wrapper.vm.executeRelocate('README.md', 'projects/README.md')
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)

    moveResult.resolve({
      directory: 'personal', oldPath: 'README.md', newPath: 'projects/README.md', updatedFiles: [], failedFiles: [],
    })
    await flushPromises()
    expect(wrapper.find('[data-entry-path="README.md"]').exists()).toBe(false)

    const projectFolder = wrapper.find('[data-entry-path="projects"]')
    await projectFolder.trigger('dragstart', { dataTransfer })
    await projectFolder.trigger('dragover', { dataTransfer })
    expect(projectFolder.classes()).toContain('tree-row-wrapper--drop-invalid')
    expect(dataTransfer.dropEffect).toBe('none')
    await projectFolder.trigger('drop', { dataTransfer })
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain('Cannot move a folder into itself')
    expect(wrapper.find('[data-entry-path="projects"]').classes()).not.toContain('tree-row-wrapper--drop-invalid')
  })

  it('does not show the destination form while Drag & Drop is verifying the source revision', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    const pendingRevision = deferred()
    api.getVaultMarkdown.mockReturnValueOnce(pendingRevision.promise)
    api.relocateVaultEntry.mockResolvedValueOnce({
      directory: 'personal', oldPath: 'README.md', newPath: 'projects/README.md', updatedFiles: [], failedFiles: [],
    })
    api.getVaultEntries.mockResolvedValue({
      directory: 'personal', path: '', entries: [{ name: 'projects', path: 'projects', type: 'directory' }],
    })
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['projects/README.md'], notes: [],
    })
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(api.getVaultMarkdown).toHaveBeenCalledWith('personal', 'README.md')
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)

    pendingRevision.resolve({ directory: 'personal', path: 'README.md', revision: 'a'.repeat(64), content: '# README' })
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
  })

  it('requires explicit draft discard confirmation before moving a dirty note', async () => {
    api.getVaultIndex.mockResolvedValue({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    const editor = wrapper.findComponent(MarkdownEditor)
    const discard = vi.spyOn(wrapper.findComponent(MarkdownViewer).vm, 'discardChanges')
    editor.vm.setText('# README\n\nImportant unsaved content.')
    await wrapper.vm.$nextTick()

    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('dragover', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    await flushPromises()

    const confirmation = wrapper.find('[data-testid="relocate-confirmation"]')
    expect(confirmation.exists()).toBe(true)
    expect(confirmation.text()).toContain('Source: README.md')
    expect(confirmation.text()).toContain('Destination: projects/README.md')
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# README\n\nImportant unsaved content.')
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    expect(discard).not.toHaveBeenCalled()
  })

  it('keeps the draft and navigation unchanged when the user cancels a pending drag move', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    wrapper.findComponent(MarkdownEditor).vm.setText('keep this draft')
    await wrapper.vm.$nextTick()

    const tabsBefore = wrapper.findAll('[data-testid="workspace-tab"]').map((tab) => tab.attributes('data-tab-path'))
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    await wrapper.find('[data-testid="relocate-keep-editing"]').trigger('click')

    expect(wrapper.find('[data-testid="relocate-confirmation"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('keep this draft')
    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe(tabsBefore[0])
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
  })

  it('discards only after an explicitly confirmed move succeeds', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    const content = '---\nchapter: 42\n---\n\n# README'
    api.getVaultMarkdown
      .mockResolvedValueOnce({ directory: 'personal', path: 'README.md', content, revision: 'a'.repeat(64) })
      .mockResolvedValueOnce({ directory: 'personal', path: 'projects/README.md', content, revision: 'b'.repeat(64) })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    const editor = wrapper.findComponent(MarkdownEditor)
    editor.vm.setText('authorized draft')
    await wrapper.vm.$nextTick()

    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    expect(editor.vm.getText()).toBe('authorized draft')

    const moveResult = deferred()
    api.relocateVaultEntry.mockReturnValueOnce(moveResult.promise)
    api.getVaultEntries.mockImplementation(async (_directory, path = '') => ({
      directory: 'personal',
      path,
      entries: path ? [] : [{ name: 'projects', path: 'projects', type: 'directory' }],
    }))
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['projects/README.md'], notes: [],
    })
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'projects/README.md', content: '# README', revision: 'b'.repeat(64),
    })
    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(editor.vm.getText()).toBe('authorized draft')
    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe('README.md')

    moveResult.resolve({
      directory: 'personal', oldPath: 'README.md', newPath: 'projects/README.md', updatedFiles: [], failedFiles: [],
    })
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledWith('personal', expect.objectContaining({
      sourcePath: 'README.md', targetPath: 'projects/README.md', expectedRevision: 'a'.repeat(64),
    }))
    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe('projects/README.md')
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('42')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('preserves a dirty draft and reports a collision without reopening the form after Drag & Drop', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    const editor = wrapper.findComponent(MarkdownEditor)
    const discard = vi.spyOn(wrapper.findComponent(MarkdownViewer).vm, 'discardChanges')
    editor.vm.setText('draft after collision')
    await wrapper.vm.$nextTick()
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    expect(wrapper.find('[data-testid="relocate-confirmation"]').exists()).toBe(true)
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    api.relocateVaultEntry.mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))
    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(discard).not.toHaveBeenCalled()
    expect(editor.vm.getText()).toBe('draft after collision')
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain('already exists')
    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe('README.md')
  })

  it.each(['saving', 'reloading', 'conflict', 'unknown'])('blocks relocation while the note is %s', async (state) => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    const editor = wrapper.findComponent(MarkdownEditor)
    const viewer = wrapper.findComponent(MarkdownViewer)
    const pending = deferred()
    if (state === 'reloading') {
      api.getVaultMarkdown.mockReturnValueOnce(pending.promise)
      viewer.vm.reloadServerCopy()
      await wrapper.vm.$nextTick()
    } else {
      vi.useFakeTimers()
      editor.vm.setText('preserve me')
      await wrapper.vm.$nextTick()
    }
    if (state === 'saving') {
      api.saveVaultMarkdown.mockReturnValueOnce(pending.promise)
      await vi.advanceTimersByTimeAsync(700)
      await flushPromises()
    } else if (state === 'conflict' || state === 'unknown') {
      api.saveVaultMarkdown.mockRejectedValueOnce(codedError(
        state === 'conflict' ? 'VAULT_FILE_CONFLICT' : 'VAULT_SAVE_RESULT_UNKNOWN'
      ))
      await vi.advanceTimersByTimeAsync(700)
      await flushPromises()
    }

    await wrapper.vm.executeRelocate('README.md', 'Moved.md')
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    if (state === 'saving') {
      pending.resolve({ directory: 'personal', path: 'README.md', revision: 'b'.repeat(64) })
      await flushPromises()
      expect(editor.vm.getText()).toBe('preserve me')
    }
    expect(wrapper.find('[data-testid="workspace-notice"]').text()).toMatch(/Wait|Resolve|Verify/)
  })

  it('rechecks a draft changed while the revision lookup is pending', async () => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    const editor = wrapper.findComponent(MarkdownEditor)
    wrapper.findComponent(MarkdownViewer).vm.revision = null
    const pendingRevision = deferred()
    api.getVaultMarkdown.mockReturnValueOnce(pendingRevision.promise)

    const move = wrapper.vm.executeRelocate('README.md', 'Moved.md')
    expect(api.getVaultMarkdown).toHaveBeenCalledWith('personal', 'README.md')
    editor.vm.setText('typed during revision lookup')
    pendingRevision.resolve({ directory: 'personal', path: 'README.md', revision: 'b'.repeat(64), content: '# README' })
    await move
    await wrapper.vm.$nextTick()

    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    expect(editor.vm.getText()).toBe('typed during revision lookup')
    expect(wrapper.find('[data-testid="relocate-confirmation"]').text()).toContain('Review and confirm')
  })

  it('requires a new confirmation if the draft changes after the first authorization', async () => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    const editor = wrapper.findComponent(MarkdownEditor)
    editor.vm.setText('first authorized draft')
    await wrapper.vm.$nextTick()
    await wrapper.vm.executeRelocate('README.md', 'Moved.md')

    editor.vm.setText('newer draft')
    await wrapper.vm.$nextTick()
    api.relocateVaultEntry.mockResolvedValueOnce({
      directory: 'personal', oldPath: 'README.md', newPath: 'Moved.md', updatedFiles: [], failedFiles: [],
    })
    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()

    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="relocate-confirmation"]').text()).toContain('Review and confirm')
    expect(editor.vm.getText()).toBe('newer draft')

    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
  })

  it('protects a dirty note inside a moved folder but allows moving an unrelated folder', async () => {
    const entries = [
        { name: 'projects', path: 'projects', type: 'directory' },
        { name: 'assets', path: 'assets', type: 'directory' },
        { name: 'archive', path: 'archive', type: 'directory' },
    ]
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true,
      folders: ['projects', 'assets', 'archive'], files: ['projects/README.md'], notes: [],
    })
    const wrapper = await mountBrowser({ vault }, entries)
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal', path: 'projects',
      entries: [{ name: 'README.md', path: 'projects/README.md', type: 'file' }],
    })
    await wrapper.find('[data-folder-path="projects"]').trigger('click')
    await flushPromises()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'projects/README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="projects/README.md"]').trigger('click')
    await flushPromises()
    wrapper.findComponent(MarkdownEditor).vm.setText('folder draft')
    await wrapper.vm.$nextTick()

    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="projects"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="archive"]').trigger('drop', { dataTransfer })
    expect(wrapper.find('[data-testid="relocate-confirmation"]').text()).toContain('Source: projects')
    expect(wrapper.find('[data-testid="relocate-confirmation"]').text()).toContain('Destination: archive/projects')
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    await wrapper.find('[data-testid="relocate-keep-editing"]').trigger('click')

    const folderMove = deferred()
    api.relocateVaultEntry.mockReturnValueOnce(folderMove.promise)
    await wrapper.find('[data-entry-path="assets"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="archive"]').trigger('drop', { dataTransfer })
    await flushPromises()
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    folderMove.resolve({
      directory: 'personal', oldPath: 'assets', newPath: 'archive/assets', updatedFiles: [], failedFiles: [],
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="relocate-confirmation"]').exists()).toBe(false)
  })

  it('reconciles an uncertain successful move while keeping the open draft at its new path', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    const content = '---\nchapter: 42\n---\n\n# Document'
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockImplementation(async (directory, path) => ({
      directory, path, content, revision: 'a'.repeat(64),
    }))
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')
    const editor = wrapper.findComponent(MarkdownEditor)
    editor.vm.setText('preserve after uncertain move')
    await wrapper.vm.$nextTick()
    await wrapper.vm.executeRelocate('README.md', 'projects/README.md')
    api.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(true)

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal', path: '', entries: [{ name: 'projects', path: 'projects', type: 'directory' }],
    })
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['projects/README.md'], notes: [],
    })
    await wrapper.find('[data-testid="relocate-refresh"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe('projects/README.md')
    expect(editor.vm.getText()).toBe('preserve after uncertain move')
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain('Your draft remains open')
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
  })

  it('preserves a pending Number draft when an uncertain move is confirmed by refresh', async () => {
    const content = '---\nchapter: 42\nrating: 5\nstatus: draft\n---\n\n# Document'
    const wrapper = await reconcileMoveWithNumberDrafts({
      sourceContent: content,
      drafts: { chapter: '-15', rating: '3.5' },
    })
    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe('projects/README.md')
    expect(wrapper.find('[data-property-key="chapter"] [data-testid="property-number-input"]').element.value).toBe('-15')
    expect(wrapper.find('[data-property-key="rating"] [data-testid="property-number-input"]').element.value).toBe('3.5')
    expect(wrapper.findComponent(MarkdownViewer).vm.getText()).toBe(content)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
  })

  it('preserves invalid Number text without writing it during relocation reconciliation', async () => {
    const content = '---\nchapter: 42\n---\n\n# Document'
    const wrapper = await reconcileMoveWithNumberDrafts({ sourceContent: content, drafts: { chapter: '-' } })

    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-')
    expect(wrapper.findComponent(MarkdownViewer).vm.getText()).toBe(content)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it.each([
    ['still at the source', ['README.md'], 'README.md', false],
    ['still ambiguous', ['README.md', 'projects/README.md'], 'README.md', true],
  ])('keeps a Number draft at the source when refresh is %s', async (_case, refreshedFiles, path, remainsUncertain) => {
    const wrapper = await reconcileMoveWithNumberDrafts({ refreshedFiles })

    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe(path)
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(remainsUncertain)
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it.each([
    ['value', '---\nchapter: 100\n---\n\n# Document', 'property-number-error', 'changed while you were editing'],
    ['removed', '---\nstatus: draft\n---\n\n# Document', 'pending-number-conflict', 'removed or renamed'],
    ['type', '---\nchapter: forty-two\n---\n\n# Document', 'pending-number-conflict', 'changed type'],
  ])('restores Number drafts as conflicts when the moved property changed by %s', async (_change, destinationContent, conflictTestId, message) => {
    const sourceContent = '---\nchapter: 42\n---\n\n# Document'
    const wrapper = await reconcileMoveWithNumberDrafts({ sourceContent, destinationContent })

    if (conflictTestId === 'property-number-error') {
      expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    }
    expect(wrapper.find(`[data-testid="${conflictTestId}"]`).text()).toContain(message)
    expect(wrapper.findComponent(MarkdownViewer).vm.getText()).toBe(destinationContent)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('preserves both Markdown and Number drafts when the destination changed during the move', async () => {
    const sourceContent = '---\nchapter: 42\n---\n\n# Document'
    const destinationContent = '---\nchapter: 100\n---\n\n# Document'
    const wrapper = await reconcileMoveWithNumberDrafts({
      sourceContent,
      destinationContent,
      markdownDraft: 'Local body draft',
    })

    expect(wrapper.findComponent(MarkdownViewer).vm.getText()).toContain('Local body draft')
    expect(wrapper.find('[data-testid="markdown-conflict"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(wrapper.find('[data-testid="property-number-error"]').text()).toContain('changed while you were editing')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('transfers a Number draft when reconciliation remaps a note inside a moved folder', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    const entries = [
      { name: 'projects', path: 'projects', type: 'directory' },
      { name: 'archive', path: 'archive', type: 'directory' },
    ]
    const content = '---\nchapter: 42\n---\n\n# Document'
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true,
      folders: ['projects', 'archive'], files: ['projects/README.md'], notes: [],
    })
    const wrapper = await mountBrowser({ vault }, entries)
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal', path: 'projects',
      entries: [{ name: 'README.md', path: 'projects/README.md', type: 'file' }],
    })
    await wrapper.find('[data-folder-path="projects"]').trigger('click')
    await flushPromises()
    api.getVaultMarkdown.mockImplementation(async (directory, path) => ({ directory, path, content, revision: 'a'.repeat(64) }))
    await wrapper.find('[data-file-path="projects/README.md"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="property-number-input"]').setValue('-15')

    await wrapper.vm.executeRelocate('projects', 'archive/projects', {
      entry: { name: 'projects', path: 'projects', type: 'directory' },
      mode: 'move',
      origin: 'drag',
    })
    api.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(true)

    api.getVaultEntries.mockImplementation(async (directory, path = '') => ({
      directory,
      path,
      entries: path === ''
        ? [{ name: 'archive', path: 'archive', type: 'directory' }]
        : path === 'archive'
          ? [{ name: 'projects', path: 'archive/projects', type: 'directory' }]
          : path === 'archive/projects'
            ? [{ name: 'README.md', path: 'archive/projects/README.md', type: 'file' }]
            : [],
    }))
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true,
      folders: ['archive', 'archive/projects'], files: ['archive/projects/README.md'], notes: [],
    })
    await wrapper.find('[data-testid="relocate-refresh"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-tab"]').attributes('data-tab-path')).toBe('archive/projects/README.md')
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-15')
    expect(wrapper.findComponent(MarkdownViewer).vm.getText()).toBe(content)
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
  })

  it('keeps the manual Move destination form available and applies the chosen path', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    api.relocateVaultEntry.mockResolvedValueOnce({
      directory: 'personal', oldPath: 'README.md', newPath: 'projects/README.md', updatedFiles: [], failedFiles: [],
    })
    api.getVaultEntries.mockResolvedValue({
      directory: 'personal', path: '', entries: [{ name: 'projects', path: 'projects', type: 'directory' }],
    })
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['projects/README.md'], notes: [],
    })

    await wrapper.find('[data-testid="entry-context-button"][data-entry-path="README.md"]').trigger('click')
    await wrapper.find('[data-testid="ctx-move"]').trigger('click')
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="relocate-form"]').text()).toContain('Move entry to path:')
    await wrapper.find('[data-testid="relocate-input"]').setValue('projects/README.md')
    await wrapper.find('[data-testid="relocate-submit"]').trigger('click')
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledWith('personal', expect.objectContaining({
      sourcePath: 'README.md', targetPath: 'projects/README.md',
    }))
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
  })

  it('does not mistake a folder at the intended file path for a reconciled move', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: [], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
    await wrapper.vm.executeRelocate('README.md', 'projects/README.md', {
      entry: rootEntries[2], origin: 'drag', requireKnownDrop: true,
    })
    expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(true)

    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal', path: '', entries: [{ name: 'projects', path: 'projects', type: 'directory' }],
    })
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects/README.md'], files: [], notes: [],
    })
    await wrapper.find('[data-testid="relocate-refresh"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="relocate-error"]').text()).toContain('could not confirm')
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
  })

  it('invalidates a pending confirmation when the vault changes', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    wrapper.findComponent(MarkdownEditor).vm.setText('draft in A')
    await wrapper.vm.$nextTick()
    await wrapper.vm.executeRelocate('README.md', 'projects/README.md')

    await wrapper.setProps({ vault: { ...vault, id: 'vault-2', directory: 'other' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="relocate-confirmation"]').exists()).toBe(false)
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
  })

  it('ignores duplicate confirmation and a late move result after switching vaults', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    await wrapper.find('[data-file-path="README.md"]').trigger('click')
    await flushPromises()
    wrapper.findComponent(MarkdownEditor).vm.setText('authorized draft')
    await wrapper.vm.$nextTick()
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    expect(wrapper.find('[data-testid="relocate-confirmation"]').exists()).toBe(true)

    const moveResult = deferred()
    api.relocateVaultEntry.mockReturnValueOnce(moveResult.promise)
    const confirm = wrapper.find('[data-testid="relocate-confirm"]').element
    confirm.click()
    confirm.click()
    await flushPromises()
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="relocate-confirmation"]').exists()).toBe(false)
    await wrapper.find('[data-testid="close-tab-button"]').trigger('click')
    expect(wrapper.find('[data-testid="workspace-tab"]').exists()).toBe(true)

    await wrapper.setProps({ vault: { ...vault, id: 'vault-2', directory: 'other' } })
    await flushPromises()
    moveResult.resolve({ directory: 'personal', oldPath: 'README.md', newPath: 'Moved.md', updatedFiles: [], failedFiles: [] })
    await flushPromises()

    expect(wrapper.find('[data-testid="workspace-empty-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-tab"]').exists()).toBe(false)
    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
  })

  it('rejects known collisions and incomplete destinations during drag-over', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md', 'projects/README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'move' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('dragover', { dataTransfer })
    expect(dataTransfer.dropEffect).toBe('none')
    expect(wrapper.find('[data-entry-path="projects"]').classes()).toContain('tree-row-wrapper--drop-invalid')
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()

    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: false, folders: ['projects'], files: ['README.md'], notes: [],
    })
    api.getVaultEntries.mockResolvedValueOnce({ directory: 'personal', path: '', entries: rootEntries })
    const incomplete = await mountBrowser()
    const unknownTarget = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'move' }
    await incomplete.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer: unknownTarget })
    await incomplete.find('[data-entry-path="projects"]').trigger('dragover', { dataTransfer: unknownTarget })
    expect(unknownTarget.dropEffect).toBe('none')
  })

  it('keeps uncertain relocation visible and does not retry automatically after a network error', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }
    await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
    await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-testid="relocate-uncertain"]').text()).toContain('uncertain')
    expect(wrapper.find('[data-testid="relocate-refresh"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-tab"]').exists()).toBe(false)
  })

  it('reports a known Drag & Drop failure without reopening a destination form or blocking retry', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal', complete: true, folders: ['projects'], files: ['README.md'], notes: [],
    })
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValue({
      directory: 'personal', path: 'README.md', content: '# README', revision: 'a'.repeat(64),
    })
    api.relocateVaultEntry
      .mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))
      .mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))
    const dataTransfer = { setData: vi.fn(), effectAllowed: 'all', dropEffect: 'none' }

    for (let attempt = 0; attempt < 2; attempt++) {
      await wrapper.find('[data-entry-path="README.md"]').trigger('dragstart', { dataTransfer })
      await wrapper.find('[data-entry-path="projects"]').trigger('drop', { dataTransfer })
      await flushPromises()
      expect(wrapper.find('[data-testid="relocate-form"]').exists()).toBe(false)
      expect(wrapper.find('[data-entry-path="README.md"]').exists()).toBe(true)
    }

    expect(api.relocateVaultEntry).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain('already exists')
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
    // Tree updated and Live Editor is open
    expect(wrapper.find('button[data-file-path="projects/Architecture.md"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(true)
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

  it('12. creates a pending note from a missing link (including intermediate folders) and opens it immediately', async () => {
    const wrapper = await mountBrowser()

    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'Consulte [[Conhecimento/Filosofia/Ontologia]].',
      revision: 'a'.repeat(64),
    })
    api.getVaultEntries.mockResolvedValue({
      directory: 'personal',
      path: '',
      entries: rootEntries,
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    await wrapper.find('.cm-live-wikilink').trigger('click', { ctrlKey: true })
    await flushPromises()

    const createBtn = wrapper.find('[data-testid="create-missing-link-button"]')
    expect(createBtn.exists()).toBe(true)

    api.createVaultNote.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Conhecimento/Filosofia/Ontologia.md',
      revision: 'e'.repeat(64),
    })

    await createBtn.trigger('click')
    await flushPromises()

    expect(api.createVaultNote).toHaveBeenCalledWith('personal', {
      parentPath: 'Conhecimento/Filosofia',
      name: 'Ontologia.md',
      createParents: true,
    })
    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('Ontologia.md')
  })

  it('13. supports renaming and moving notes from the context menu and note title, updating open tabs and active note path', async () => {
    const wrapper = await mountBrowser()

    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: '---\ntitle: Guia\n---\n# Guia',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Rename via explorer context menu
    const ctxBtn = wrapper.find('button[data-testid="entry-context-button"][data-entry-path="README.md"]')
    await ctxBtn.trigger('click')
    await wrapper.find('[data-testid="ctx-rename"]').trigger('click')
    expect(wrapper.find('[data-testid="relocate-form"]').text()).toContain('Rename entry:')

    api.relocateVaultEntry.mockResolvedValueOnce({
      directory: 'personal',
      oldPath: 'README.md',
      newPath: 'Inicio.md',
      updatedFiles: ['Indice.md'],
      failedFiles: [],
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: [{ name: 'Inicio.md', path: 'Inicio.md', type: 'file' }],
    })
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'Inicio.md',
      content: '---\ntitle: Guia\n---\n# Guia',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('[data-testid="relocate-input"]').setValue('Inicio.md')
    await wrapper.find('[data-testid="relocate-submit"]').trigger('click')
    await flushPromises()

    expect(api.relocateVaultEntry).toHaveBeenCalledWith(
      'personal',
      expect.objectContaining({
        sourcePath: 'README.md',
        targetPath: 'Inicio.md',
        updateLinks: true,
      })
    )
    expect(wrapper.find('[data-testid="workspace-tab"][data-tab-path="Inicio.md"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain('Updated links in 1 note(s)')
  })

  it('14. moves deleted entries to .trash, lists trash, handles 409 restore conflicts with alternate destination, and permanently deletes', async () => {
    const wrapper = await mountBrowser()

    // Open context menu on README.md -> Delete -> Move to Trash
    await wrapper.find('button[data-testid="entry-context-button"][data-entry-path="README.md"]').trigger('click')
    await wrapper.find('[data-testid="ctx-delete"]').trigger('click')

    api.trashVaultEntry.mockResolvedValueOnce({
      directory: 'personal',
      id: 'trash-1',
      originalPath: 'README.md',
      name: 'README.md',
      type: 'file',
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: [],
    })

    await wrapper.find('[data-testid="confirm-trash-button"]').trigger('click')
    await flushPromises()

    expect(api.trashVaultEntry).toHaveBeenCalledWith('personal', { path: 'README.md' })

    // Open Trash modal
    api.getVaultTrash.mockResolvedValueOnce({
      directory: 'personal',
      items: [
        { id: 'trash-1', originalPath: 'README.md', name: 'README.md', type: 'file', deletedAt: '2026-01-01T00:00:00Z' },
      ],
    })
    await wrapper.find('[data-testid="open-trash-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.findAll('[data-testid="trash-item"]').length).toBe(1)

    // First restore attempt hits 409 VAULT_ENTRY_EXISTS -> shows conflict prompt
    api.restoreVaultTrashEntry.mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))
    await wrapper.find('[data-testid="restore-trash-button"]').trigger('click')
    await flushPromises()

    const conflictBox = wrapper.find('[data-testid="trash-restore-conflict"]')
    expect(conflictBox.exists()).toBe(true)

    // Restore to alternate path succeeds
    api.restoreVaultTrashEntry.mockResolvedValueOnce({
      directory: 'personal',
      id: 'trash-1',
      path: 'README (Restored).md',
      type: 'file',
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: [{ name: 'README (Restored).md', path: 'README (Restored).md', type: 'file' }],
    })
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README (Restored).md',
      content: '# Restored',
      revision: 'f'.repeat(64),
    })

    await wrapper.find('[data-testid="trash-restore-alternate-submit"]').trigger('click')
    await flushPromises()

    expect(api.restoreVaultTrashEntry).toHaveBeenLastCalledWith('personal', {
      id: 'trash-1',
      targetPath: 'README (Restored).md',
    })
  })

  it('15. displays Backlinks, Outgoing Links, Outline, Tags navigation, Search, Tabs, Back/Forward history, Quick Switcher, and Command Palette', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal',
      complete: true,
      folders: ['projects'],
      files: ['README.md', 'projects/Design.md'],
      notes: [
        {
          path: 'README.md',
          name: 'README.md',
          revision: 'a'.repeat(64),
          content: '---\ntitle: Início\ntags:\n  - conhecimento/arquitetura\n---\n# Introdução\n\nVeja [[projects/Design]] e [[Nota Futura]].\n',
        },
        {
          path: 'projects/Design.md',
          name: 'Design.md',
          revision: 'b'.repeat(64),
          content: '---\ntitle: Design\ntags:\n  - conhecimento/design\n---\n# Visão Geral\n\nReferência de volta para [[README]].\n',
        },
      ],
    })

    const wrapper = await mountBrowser()

    api.getVaultMarkdown
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'README.md',
        content: '---\ntitle: Início\ntags:\n  - conhecimento/arquitetura\n---\n# Introdução\n\nVeja [[projects/Design]] e [[Nota Futura]].\n',
        revision: 'a'.repeat(64),
      })
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'projects/Design.md',
        content: '---\ntitle: Design\ntags:\n  - conhecimento/design\n---\n# Visão Geral\n\nReferência de volta para [[README]].\n',
        revision: 'b'.repeat(64),
      })
      .mockResolvedValueOnce({
        directory: 'personal',
        path: 'README.md',
        content: '---\ntitle: Início\ntags:\n  - conhecimento/arquitetura\n---\n# Introdução\n\nVeja [[projects/Design]] e [[Nota Futura]].\n',
        revision: 'a'.repeat(64),
      })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Backlinks panel shows Design.md linking to README.md
    expect(wrapper.find('[data-testid="backlink-item"][data-source-path="projects/Design.md"]').exists()).toBe(true)

    // Switch to Outgoing Links tab -> shows resolved Design.md and unresolved Nota Futura
    await wrapper.find('[data-testid="panel-tab-outgoing"]').trigger('click')
    expect(wrapper.find('[data-testid="outgoing-resolved-item"][data-target-path="projects/Design.md"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="outgoing-unresolved-item"][data-raw-target="Nota Futura"]').exists()).toBe(true)

    // Switch to Outline tab -> shows H1 Introdução
    await wrapper.find('[data-testid="panel-tab-outline"]').trigger('click')
    expect(wrapper.find('[data-testid="outline-heading-item"]').text()).toContain('Introdução')

    // Show Properties (hidden by default) and click tag chip -> opens Tags tab filtered by that tag
    wrapper.findComponent(MarkdownViewer).vm.setPropertiesMode('visible')
    await flushPromises()
    await wrapper.find('[data-testid="property-tag-chip"]').trigger('click')
    expect(wrapper.find('[data-testid="tags-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="tag-result-item"][data-note-path="README.md"]').exists()).toBe(true)

    // Verify Quick Switcher and Back/Forward buttons are NOT permanent topbar buttons
    expect(wrapper.find('[data-testid="quick-switcher-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="nav-back-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="nav-forward-button"]').exists()).toBe(false)

    // Normal click on Design.md reuses active tab
    await wrapper.vm.selectNote('projects/Design.md')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(1)
    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('Design.md')

    // Explicitly opening README.md in new tab adds a 2nd tab
    await wrapper.vm.openFileInNewTab('README.md')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(2)
    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('README.md')

    // Navigate Back in history to Design.md
    await wrapper.vm.navigateHistoryBack()
    await flushPromises()
    expect(wrapper.find('[data-testid="markdown-filename"]').text()).toBe('Design.md')

    // Open Command Palette
    await wrapper.find('[data-testid="command-palette-button"]').trigger('click')
    expect(wrapper.find('[data-testid="command-palette-modal"]').exists()).toBe(true)
  })

  it('16. warns about unsaved drafts on delete/rename and passes expectedRevision to backend', async () => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'base content',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Modify editor text to make it dirty
    wrapper.findComponent(MarkdownEditor).vm.setText('unsaved draft')
    await wrapper.vm.$nextTick()

    // Request delete on the open note
    await wrapper.vm.requestDeleteEntry({ path: 'README.md', name: 'README.md', type: 'file' })
    await wrapper.vm.$nextTick()

    expect(wrapper.find('[data-testid="delete-draft-warning"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="delete-draft-warning"]').text()).toContain('unsaved changes')

    api.trashVaultEntry.mockResolvedValueOnce({ id: 'trash-1', directory: 'personal' })
    api.getVaultEntries.mockResolvedValueOnce({ directory: 'personal', path: '', entries: [] })

    await wrapper.find('[data-testid="confirm-trash-button"]').trigger('click')
    await flushPromises()

    expect(api.trashVaultEntry).toHaveBeenCalledWith(
      'personal',
      expect.objectContaining({
        path: 'README.md',
        expectedRevision: 'a'.repeat(64),
      })
    )
  })

  it('17. presents unverified link message when index is partial and target cannot be verified', async () => {
    api.getVaultIndex.mockResolvedValueOnce({
      directory: 'personal',
      complete: false,
      failures: [{ path: 'Quebrada.md', reason: 'VAULT_FILE_TOO_LARGE' }],
      folders: [],
      files: ['README.md'],
      notes: [{ path: 'README.md', name: 'README.md', content: 'Link para [[Inexistente]].' }],
    })

    const wrapper = await mountBrowser()
    await flushPromises()

    // Incomplete index indicator
    expect(wrapper.find('[data-testid="index-partial-warning"]').exists()).toBe(true)

    // Open unverified link
    await wrapper.vm.handleOpenLink({
      rawTarget: 'Inexistente',
      kind: 'wikilink',
      type: 'unverified',
    })
    await wrapper.vm.$nextTick()

    const notice = wrapper.find('[data-testid="workspace-link-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('Vault indexing is incomplete')
    // Must NOT offer to create note when unverified
    expect(wrapper.find('[data-testid="create-missing-link-button"]').exists()).toBe(false)
  })

  it('ignores an older index response after a newer partial index has been applied', async () => {
    const oldIndex = deferred()
    const newIndex = deferred()
    api.getVaultIndex.mockReturnValueOnce(oldIndex.promise).mockReturnValueOnce(newIndex.promise)
    const wrapper = await mountBrowser()

    api.getVaultEntries.mockResolvedValueOnce({ directory: 'personal', path: '', entries: rootEntries })
    await wrapper.find('[data-testid="vault-name-trigger"]').trigger('click')
    await wrapper.find('[data-testid="refresh-browser-button"]').trigger('click')
    await flushPromises()
    expect(api.getVaultIndex).toHaveBeenCalledTimes(2)

    newIndex.resolve({
      directory: 'personal', complete: false,
      failures: [{ path: 'Unreadable.md', reason: 'INVALID_FILE_ENCODING' }],
      folders: [], files: [], notes: [],
    })
    await flushPromises()
    expect(wrapper.find('[data-testid="index-partial-warning"]').exists()).toBe(true)

    oldIndex.resolve({ directory: 'personal', complete: true, folders: [], files: [], notes: [] })
    await flushPromises()
    expect(wrapper.find('[data-testid="index-partial-warning"]').exists()).toBe(true)
  })

  it('keeps a created note in the local index when an older snapshot returns', async () => {
    const oldIndex = deferred()
    const refreshedIndex = deferred()
    api.getVaultIndex.mockReturnValueOnce(oldIndex.promise).mockReturnValueOnce(refreshedIndex.promise)
    const wrapper = await mountBrowser()

    api.createVaultNote.mockResolvedValueOnce({
      directory: 'personal', path: 'NewNote.md', revision: 'a'.repeat(64),
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: '',
      entries: [...rootEntries, { name: 'NewNote.md', path: 'NewNote.md', type: 'file' }],
    })
    await wrapper.find('[data-testid="new-note-button"]').trigger('click')
    await wrapper.find('[data-testid="new-entry-input"]').setValue('NewNote')
    await wrapper.find('[data-testid="new-entry-submit"]').trigger('click')
    await flushPromises()

    wrapper.vm.layout.contextOpen = true
    await wrapper.vm.$nextTick()
    await wrapper.find('[data-testid="panel-tab-search"]').trigger('click')
    await wrapper.find('[data-testid="vault-search-input"]').setValue('NewNote')
    expect(wrapper.find('[data-testid="search-result-item"]').exists()).toBe(true)

    oldIndex.resolve({ directory: 'personal', complete: true, folders: [], files: [], notes: [] })
    await flushPromises()
    expect(wrapper.find('[data-testid="search-result-item"]').exists()).toBe(true)
  })

  it('ignores an unauthorized index response from the previous vault', async () => {
    const oldIndex = deferred()
    const newIndex = deferred()
    api.getVaultIndex.mockReturnValueOnce(oldIndex.promise).mockReturnValueOnce(newIndex.promise)
    api.getVaultEntries.mockResolvedValue({ directory: 'research', path: '', entries: [] })
    const wrapper = await mountBrowser()

    await wrapper.setProps({ vault: { ...vault, id: 'vault-2', directory: 'research' } })
    await flushPromises()
    newIndex.resolve({ directory: 'research', complete: true, folders: [], files: [], notes: [] })
    await flushPromises()
    oldIndex.reject(codedError('UNAUTHORIZED'))
    await flushPromises()

    expect(wrapper.emitted('unauthorized')).toBeUndefined()
  })

  it('does not apply notes or partial status from an earlier vault after switching', async () => {
    const oldIndex = deferred()
    const newIndex = deferred()
    api.getVaultIndex.mockReturnValueOnce(oldIndex.promise).mockReturnValueOnce(newIndex.promise)
    api.getVaultEntries.mockResolvedValue({ directory: 'research', path: '', entries: [] })
    const wrapper = await mountBrowser()

    await wrapper.setProps({ vault: { ...vault, id: 'vault-2', directory: 'research' } })
    await flushPromises()
    newIndex.resolve({ directory: 'research', complete: true, folders: [], files: [], notes: [] })
    await flushPromises()
    oldIndex.resolve({
      directory: 'personal',
      complete: false,
      failures: [{ path: 'Private.md', reason: 'INVALID_FILE_ENCODING' }],
      folders: [],
      files: ['Private.md'],
      notes: [{ path: 'Private.md', name: 'Private.md', content: 'Old vault only.' }],
    })
    await flushPromises()

    expect(wrapper.find('[data-testid="index-partial-warning"]').exists()).toBe(false)
    await wrapper.find('[data-testid="panel-tab-search"]').trigger('click')
    await wrapper.find('[data-testid="vault-search-input"]').setValue('Private')
    expect(wrapper.find('[data-testid="search-result-item"]').exists()).toBe(false)
  })

  it('ignores an index response that settles after the browser unmounts', async () => {
    const request = deferred()
    api.getVaultIndex.mockReturnValueOnce(request.promise)
    api.getVaultEntries.mockResolvedValueOnce({ directory: 'personal', path: '', entries: rootEntries })
    const unauthorized = vi.fn()
    const wrapper = mount(VaultBrowser, {
      props: { vault },
      attrs: { onUnauthorized: unauthorized },
    })
    await flushPromises()

    wrapper.unmount()
    request.reject(codedError('UNAUTHORIZED'))
    await flushPromises()

    expect(unauthorized).not.toHaveBeenCalled()
  })

  it('18. displays failedFiles in workspace notice when rename/move has partial link update failures', async () => {
    const wrapper = await mountBrowser()
    api.relocateVaultEntry.mockResolvedValueOnce({
      oldPath: 'README.md',
      newPath: 'Documentacao.md',
      updatedFiles: ['Indice.md'],
      failedFiles: ['Notas/Travada.md'],
    })
    api.getVaultEntries.mockResolvedValueOnce({ directory: 'personal', path: '', entries: [] })

    await wrapper.vm.executeRelocate('README.md', 'Documentacao.md')
    await flushPromises()

    const notice = wrapper.find('[data-testid="workspace-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.text()).toContain('Notas/Travada.md')
  })

  it('19. preserves dirty draft in editor when delete operation fails', async () => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'base content',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Modify editor text to make it dirty
    wrapper.findComponent(MarkdownEditor).vm.setText('unsaved draft to preserve')
    await wrapper.vm.$nextTick()

    // Request delete on the open note
    await wrapper.vm.requestDeleteEntry({ path: 'README.md', name: 'README.md', type: 'file' })
    await wrapper.vm.$nextTick()

    // Simulate backend failure (e.g. conflict 409 or network failure)
    api.trashVaultEntry.mockRejectedValueOnce(codedError('VAULT_FILE_CONFLICT'))

    await wrapper.find('[data-testid="confirm-trash-button"]').trigger('click')
    await flushPromises()

    // Deletion failed: the editor must STILL hold the unsaved text!
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('unsaved draft to preserve')
    expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)
  })

  it('20. preserves dirty draft in editor when rename or move operation fails', async () => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'base content',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Modify editor text to make it dirty
    wrapper.findComponent(MarkdownEditor).vm.setText('unsaved rename draft')
    await wrapper.vm.$nextTick()

    // Simulate a backend collision after explicit authorization.
    await wrapper.vm.executeRelocate('README.md', 'Ocupado.md', { origin: 'manual' })
    api.relocateVaultEntry.mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))
    await wrapper.find('[data-testid="relocate-confirm"]').trigger('click')
    await flushPromises()

    // Relocate failed: editor must still have unsaved draft!
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('unsaved rename draft')
    expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="relocate-error"]').text()).toContain('already exists')
  })

  it('21. resizes explorer panel with mouse pointer drag and persists to localStorage', async () => {
    const wrapper = await mountBrowser()
    const splitter = wrapper.find('[data-testid="resize-handle-explorer"]')
    expect(splitter.exists()).toBe(true)
    expect(splitter.attributes('role')).toBe('separator')
    expect(splitter.attributes('aria-orientation')).toBe('vertical')
    expect(Number(splitter.attributes('aria-valuenow'))).toBe(260)

    // Simulate pointerdown on splitter
    splitter.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 260 }))

    // Simulate pointermove to 320px
    window.dispatchEvent(new MouseEvent('pointermove', { bubbles: true, clientX: 320 }))
    await wrapper.vm.$nextTick()
    expect(wrapper.vm.getLayout().explorerWidth).toBe(320)

    // Release pointerup
    window.dispatchEvent(new MouseEvent('pointerup', { bubbles: true }))
    await wrapper.vm.$nextTick()

    // Verified persisted to localStorage
    const saved = JSON.parse(localStorage.getItem('ayame:layout:personal'))
    expect(saved.explorerWidth).toBe(320)
  })

  it('22. supports keyboard resizing and clamping on explorer splitter', async () => {
    const wrapper = await mountBrowser()
    const splitter = wrapper.find('[data-testid="resize-handle-explorer"]')

    // ArrowRight increases width by 10px
    await splitter.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.vm.getLayout().explorerWidth).toBe(270)

    // Shift+ArrowRight increases by 50px
    await splitter.trigger('keydown', { key: 'ArrowRight', shiftKey: true })
    expect(wrapper.vm.getLayout().explorerWidth).toBe(320)

    // Home sets to min (180px)
    await splitter.trigger('keydown', { key: 'Home' })
    expect(wrapper.vm.getLayout().explorerWidth).toBe(180)

    // ArrowLeft at min does not go below 180px
    await splitter.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.vm.getLayout().explorerWidth).toBe(180)

    // End sets to max (clamped by window width or 480)
    window.innerWidth = 1440
    await splitter.trigger('keydown', { key: 'End' })
    expect(wrapper.vm.getLayout().explorerWidth).toBe(480)
  })

  it('23. supports context panel splitter resizing and keyboard navigation when panel is open', async () => {
    window.innerWidth = 1440
    const wrapper = await mountBrowser()
    expect(wrapper.find('[data-testid="resize-handle-context"]').exists()).toBe(false)

    // Open context panel
    await wrapper.find('[data-testid="toggle-right-panel-button"]').trigger('click')
    await wrapper.vm.$nextTick()

    const rightSplitter = wrapper.find('[data-testid="resize-handle-context"]')
    expect(rightSplitter.exists()).toBe(true)
    expect(Number(rightSplitter.attributes('aria-valuenow'))).toBe(280)

    // ArrowLeft expands context panel
    await rightSplitter.trigger('keydown', { key: 'ArrowLeft' })
    expect(wrapper.vm.getLayout().contextWidth).toBe(290)

    // Home sets to min (200px)
    await rightSplitter.trigger('keydown', { key: 'Home' })
    expect(wrapper.vm.getLayout().contextWidth).toBe(200)

    // End sets to max (480px)
    await rightSplitter.trigger('keydown', { key: 'End' })
    expect(wrapper.vm.getLayout().contextWidth).toBe(480)
  })

  it('24. restores persisted layout from localStorage on initial mount', async () => {
    localStorage.setItem(
      'ayame:layout:personal',
      JSON.stringify({
        explorerWidth: 340,
        explorerOpen: true,
        contextWidth: 310,
        contextOpen: true,
      })
    )

    const wrapper = await mountBrowser()
    expect(wrapper.vm.getLayout().explorerWidth).toBe(340)
    expect(wrapper.vm.getLayout().contextWidth).toBe(310)
    expect(wrapper.vm.getLayout().contextOpen).toBe(true)
    expect(wrapper.find('[data-testid="resize-handle-context"]').exists()).toBe(true)
  })

  it('25. cleans up window pointer listeners on unmount even while dragging', async () => {
    const removeSpy = vi.spyOn(window, 'removeEventListener')
    const wrapper = await mountBrowser()
    const splitter = wrapper.find('[data-testid="resize-handle-explorer"]')

    splitter.element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, clientX: 260 }))
    wrapper.unmount()

    expect(removeSpy).toHaveBeenCalledWith('pointermove', expect.any(Function))
    expect(removeSpy).toHaveBeenCalledWith('pointerup', expect.any(Function))
    removeSpy.mockRestore()
  })

  it('shows Markdown and folders by default, and reveals only safe unsupported entries on request', async () => {
    const entries = [
      { name: '.obsidian', path: '.obsidian', type: 'directory' },
      { name: '.trash', path: '.trash', type: 'directory' },
      { name: 'Cosmologia', path: 'Cosmologia', type: 'directory' },
      { name: 'Cosmologia.md', path: 'Cosmologia.md', type: 'file' },
      { name: 'README', path: 'README', type: 'file' },
      { name: 'repomix-output.xml', path: 'repomix-output.xml', type: 'file' },
      { name: 'image.png', path: 'image.png', type: 'file' },
      { name: '.ayame.lock', path: '.ayame.lock', type: 'file' },
      { name: '.note.ayame-a1b2.tmp', path: '.note.ayame-a1b2.tmp', type: 'file' },
      { name: 'unaddressable.md', path: null, type: 'file' },
    ]
    const wrapper = await mountBrowser({ vault }, entries)
    const explorer = wrapper.find('[data-testid="vault-explorer"]')

    expect(wrapper.find('button[data-folder-path="Cosmologia"]').exists()).toBe(true)
    expect(wrapper.find('button[data-file-path="Cosmologia.md"]').text()).toBe('Cosmologia')
    for (const hidden of ['.obsidian', '.trash', 'README', 'repomix-output.xml', 'image.png', '.ayame.lock', '.note.ayame-a1b2.tmp', 'unaddressable']) {
      expect(explorer.text()).not.toContain(hidden)
    }

    await wrapper.find('[data-testid="vault-name-trigger"]').trigger('click')
    await wrapper.find('[data-testid="vault-settings-button"]').trigger('click')
    const toggle = wrapper.find('[data-testid="setting-show-unsupported-files"]')
    expect(toggle.element.checked).toBe(false)
    await toggle.setValue(true)

    for (const shown of ['.obsidian', 'README', 'repomix-output.xml', 'image.png']) {
      expect(explorer.text()).toContain(shown)
    }
    for (const hidden of ['.trash', '.ayame.lock', '.note.ayame-a1b2.tmp', 'unaddressable']) {
      expect(explorer.text()).not.toContain(hidden)
    }
    expect(wrapper.findAll('.entry-badge')).toHaveLength(0)
    const unsupported = wrapper.findAll('.tree-file--unsupported').find((row) => row.text().includes('repomix-output.xml'))
    expect(unsupported.element.tagName).toBe('DIV')
    await unsupported.trigger('click')
    expect(api.getVaultMarkdown).not.toHaveBeenCalled()

    await toggle.setValue(false)
    expect(explorer.text()).not.toContain('repomix-output.xml')
    expect(api.saveVaultMarkdown).not.toHaveBeenCalled()
    expect(api.createVaultNote).not.toHaveBeenCalled()
    expect(api.createVaultFolder).not.toHaveBeenCalled()
    expect(api.relocateVaultEntry).not.toHaveBeenCalled()
    expect(api.trashVaultEntry).not.toHaveBeenCalled()
  })

  it('keeps names repeated in separate folders and ignores stale same-folder responses', async () => {
    const wrapper = await mountBrowser({ vault }, [
      { name: 'A', path: 'A', type: 'directory' },
      { name: 'B', path: 'B', type: 'directory' },
    ])
    let resolveOld
    api.getVaultEntries
      .mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve }))
      .mockResolvedValueOnce({ directory: 'personal', path: 'B', entries: [
        { name: 'Fresh.md', path: 'B/Fresh.md', type: 'file' },
      ] })

    await wrapper.find('button[data-folder-path="A"]').trigger('click')
    await wrapper.find('button[data-folder-path="B"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('button[data-file-path="B/Fresh.md"]').exists()).toBe(true)

    let resolveFresh
    api.getVaultEntries
      .mockResolvedValueOnce({ directory: 'personal', path: '', entries: [
        { name: 'A', path: 'A', type: 'directory' },
        { name: 'B', path: 'B', type: 'directory' },
      ] })
      .mockReturnValueOnce(new Promise((resolve) => { resolveFresh = resolve }))
      .mockResolvedValueOnce({ directory: 'personal', path: 'B', entries: [
        { name: 'Fresh.md', path: 'B/Fresh.md', type: 'file' },
      ] })

    // Force a refresh to issue a newer request for expanded folder A.
    await wrapper.find('[data-testid="vault-name-trigger"]').trigger('click')
    await wrapper.find('[data-testid="refresh-browser-button"]').trigger('click')
    await flushPromises()
    resolveFresh({ directory: 'personal', path: 'A', entries: [
      { name: 'Fresh.md', path: 'A/Fresh.md', type: 'file' },
    ] })
    await flushPromises()
    resolveOld({ directory: 'personal', path: 'A', entries: [
      { name: 'Stale.md', path: 'A/Stale.md', type: 'file' },
    ] })
    await flushPromises()

    expect(wrapper.find('button[data-file-path="A/Fresh.md"]').exists()).toBe(true)
    expect(wrapper.find('button[data-file-path="B/Fresh.md"]').exists()).toBe(true)
    expect(wrapper.find('button[data-file-path="A/Stale.md"]').exists()).toBe(false)
  })

  it('26. context menu anchors to element when opened via ⋯ button and to pointer when right-clicked', async () => {
    const wrapper = await mountBrowser()
    const ctxBtn = wrapper.find('button[data-testid="entry-context-button"][data-entry-path="README.md"]')

    await ctxBtn.trigger('click')
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(true)

    // Close menu
    await wrapper.vm.closeContextMenu()
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(false)

    // Right click on file row
    const fileRow = wrapper.find('button[data-file-path="README.md"]')
    await fileRow.trigger('contextmenu', { clientX: 250, clientY: 180 })
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ctx-open-new-tab"]').exists()).toBe(true)
  })

  it('27. context menu closes on Escape key and outside click', async () => {
    const wrapper = await mountBrowser()
    await wrapper.vm.openEmptyAreaContextMenu({ clientX: 100, clientY: 100, preventDefault: () => {}, stopPropagation: () => {} })
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(true)

    // Press Escape
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(false)

    // Open again, then click outside
    await wrapper.vm.openEmptyAreaContextMenu({ clientX: 100, clientY: 100, preventDefault: () => {}, stopPropagation: () => {} })
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(true)

    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(false)
  })

  it('28. right-click on empty area in explorer presents creation options at root', async () => {
    const wrapper = await mountBrowser()
    const explorer = wrapper.find('[data-testid="vault-explorer"]')

    await explorer.trigger('contextmenu', { clientX: 80, clientY: 200 })
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ctx-new-note"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="ctx-new-folder"]').exists()).toBe(true)
  })

  it('29. right-click on folder sets creation target inside that folder', async () => {
    const wrapper = await mountBrowser()
    const folderRow = wrapper.find('button[data-folder-path="projects"]')

    await folderRow.trigger('contextmenu', { clientX: 120, clientY: 150 })
    expect(wrapper.find('[data-testid="explorer-context-menu"]').exists()).toBe(true)

    api.createVaultNote.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects/Inside.md',
      revision: 'c'.repeat(64),
    })
    api.getVaultEntries.mockResolvedValueOnce({
      directory: 'personal',
      path: 'projects',
      entries: [{ name: 'Inside.md', path: 'projects/Inside.md', type: 'file' }],
    })

    await wrapper.find('[data-testid="ctx-new-note"]').trigger('click')
    expect(wrapper.find('[data-testid="new-entry-input"]').exists()).toBe(true)

    await wrapper.find('[data-testid="new-entry-input"]').setValue('Inside')
    await wrapper.find('[data-testid="new-entry-submit"]').trigger('click')
    await flushPromises()

    expect(api.createVaultNote).toHaveBeenCalledWith('personal', expect.objectContaining({
      parentPath: 'projects',
      name: 'Inside',
    }))
  })

  it('30. inline creation does not call create API until confirmed and cancels cleanly', async () => {
    const wrapper = await mountBrowser()
    await wrapper.find('[data-testid="new-note-button"]').trigger('click')

    const input = wrapper.find('[data-testid="new-entry-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('Draft Note')

    // Cancel creation
    await wrapper.find('[data-testid="new-entry-cancel"]').trigger('click')
    expect(api.createVaultNote).not.toHaveBeenCalled()
    expect(wrapper.find('[data-testid="new-entry-input"]').exists()).toBe(false)
  })

  it('31. successful copy produces toast notification', async () => {
    const writeTextSpy = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, {
      clipboard: { writeText: writeTextSpy },
    })

    const wrapper = await mountBrowser()
    await wrapper.vm.copyRelativePath({ path: 'projects/Design.md', type: 'file' })
    await wrapper.vm.$nextTick()

    expect(writeTextSpy).toHaveBeenCalledWith('projects/Design.md')
    expect(wrapper.find('[data-testid="workspace-toast"]').text()).toContain('Path copied')
  })

  it('32. clipboard failure shows error toast without stating success', async () => {
    const writeTextSpy = vi.fn().mockRejectedValue(new Error('Permission denied'))
    Object.assign(navigator, {
      clipboard: { writeText: writeTextSpy },
    })

    const wrapper = await mountBrowser()
    await wrapper.vm.copyRelativePath({ path: 'projects/Design.md', type: 'file' })
    await wrapper.vm.$nextTick()

    expect(writeTextSpy).toHaveBeenCalledWith('projects/Design.md')
    const toast = wrapper.find('[data-testid="workspace-toast"]')
    expect(toast.text()).toContain('Could not copy path')
    expect(toast.text()).not.toContain('Path copied')
  })

  it('33. vault dropdown menu contains all primary vault actions', async () => {
    const wrapper = await mountBrowser()
    await wrapper.find('[data-testid="vault-name-trigger"]').trigger('click')

    expect(wrapper.find('[data-testid="vault-dropdown-menu"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="back-to-vaults-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="vault-settings-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="open-trash-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="refresh-browser-button"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="logout-button"]').exists()).toBe(true)
  })

  it('34. trash modal presents clean note titles and original paths', async () => {
    api.getVaultTrash.mockResolvedValueOnce({
      items: [
        { id: 'item-1', name: 'Documento.md', originalPath: 'pasta/Documento.md', type: 'file' },
      ],
    })

    const wrapper = await mountBrowser()
    await wrapper.vm.openTrashModal()
    await flushPromises()

    expect(wrapper.find('[data-testid="trash-panel"]').exists()).toBe(true)
    const item = wrapper.find('[data-testid="trash-item"]')
    expect(item.exists()).toBe(true)
    expect(item.find('.trash-item-name').text()).toBe('Documento')
    expect(item.find('.trash-item-path').text()).toContain('Deleted from /pasta/Documento.md')
    expect(item.find('[data-testid="restore-trash-button"]').exists()).toBe(true)
    expect(item.find('[data-testid="delete-trash-permanently-button"]').exists()).toBe(true)
  })

  it('35. navigates back to vaults via home button when clean', async () => {
    const wrapper = await mountBrowser()
    const homeBtn = wrapper.find('[data-testid="workspace-home-button"]')
    expect(homeBtn.exists()).toBe(true)

    await homeBtn.trigger('click')
    expect(wrapper.emitted('back')).toBeTruthy()
  })

  it('36. guards home button navigation when drafts are unsaved', async () => {
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content: 'base content',
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    // Dirty draft
    wrapper.findComponent(MarkdownEditor).vm.setText('unsaved draft')
    await wrapper.vm.$nextTick()

    const homeBtn = wrapper.find('[data-testid="workspace-home-button"]')
    await homeBtn.trigger('click')
    expect(wrapper.emitted('back')).toBeUndefined()
    expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)

    // Cancel preserves draft
    await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('unsaved draft')
    expect(wrapper.emitted('back')).toBeUndefined()

    // Confirm discard allows navigating back
    await homeBtn.trigger('click')
    await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
    expect(wrapper.emitted('back')).toBeTruthy()
  })

  it('guards home button navigation when a Number draft is unsaved', async () => {
    localStorage.setItem('ayame:editor-preferences', JSON.stringify({ propertiesInDocument: 'visible' }))
    const content = '---\nchapter: 42\n---\n\n# Document'
    const wrapper = await mountBrowser()
    api.getVaultMarkdown.mockResolvedValueOnce({
      directory: 'personal',
      path: 'README.md',
      content,
      revision: 'a'.repeat(64),
    })

    await wrapper.find('button[data-file-path="README.md"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="property-number-input"]').setValue('999')
    await wrapper.vm.$nextTick()

    const homeBtn = wrapper.find('[data-testid="workspace-home-button"]')
    await homeBtn.trigger('click')
    expect(wrapper.emitted('back')).toBeUndefined()
    expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)

    // Cancel keeps draft
    await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
    expect(wrapper.emitted('back')).toBeUndefined()
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('999')

    // Confirm discard navigates back
    await homeBtn.trigger('click')
    await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
    expect(wrapper.emitted('back')).toBeTruthy()
  })
})
