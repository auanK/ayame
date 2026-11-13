import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import * as vaultApi from './api.js'
import VaultBrowser from './VaultBrowser.vue'

vi.mock('./api.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    getVaultEntries: vi.fn(),
    getVaultMarkdown: vi.fn(),
    saveVaultMarkdown: vi.fn(),
    getVaultIndex: vi.fn(),
    getVaultTrash: vi.fn(async () => ({ items: [] })),
  }
})

const VAULT_A = {
  id: 'vault-a',
  name: 'Story Vault',
  directory: 'C:/vaults/story',
}

const VAULT_B = {
  id: 'vault-b',
  name: 'Second Vault',
  directory: 'C:/vaults/other',
}

const storyRawIndex = () => ({
  directory: VAULT_A.directory,
  complete: true,
  failures: [],
  folders: ['Personagens'],
  files: ['Historia.md', 'Personagens/Heroi.md', 'Final.md'],
  notes: [
    {
      path: 'Historia.md',
      content: '---\nchapter: 1\n---\n# Historia\nVeja [[Personagens/Heroi]].\n',
      mtimeMs: 1000,
    },
    {
      path: 'Personagens/Heroi.md',
      content: '# Heroi\nParte de [[Historia]].\n',
      mtimeMs: 1000,
    },
    {
      path: 'Final.md',
      content: '# Final\nSem links.\n',
      mtimeMs: 1000,
    },
  ],
})

const otherRawIndex = () => ({
  directory: VAULT_B.directory,
  complete: true,
  failures: [],
  folders: [],
  files: ['Outro.md'],
  notes: [
    {
      path: 'Outro.md',
      content: '# Outro\nIsolado.\n',
      mtimeMs: 1500,
    },
  ],
})

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('VaultBrowser global graph integration', () => {
  let originalResizeObserver
  let originalGetContext
  let originalGetBoundingClientRect
  let originalRAF
  let originalCAF

  let activeWrappers = []

  const mountBrowser = (props) => {
    const wrapper = mount(VaultBrowser, {
      props,
      attachTo: document.body,
    })
    activeWrappers.push(wrapper)
    return wrapper
  }

  beforeEach(() => {
    activeWrappers = []
    vi.clearAllMocks()
    localStorage.clear()
    localStorage.setItem(
      'ayame:editor-preferences',
      JSON.stringify({ propertiesInDocument: 'visible' })
    )
    window.history.replaceState({}, '', '/')

    originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class MockResizeObserver {
      observe = vi.fn()
      disconnect = vi.fn()
      unobserve = vi.fn()
    }

    originalGetContext = HTMLCanvasElement.prototype.getContext
    HTMLCanvasElement.prototype.getContext = vi.fn(() => ({
      setTransform: vi.fn(),
      clearRect: vi.fn(),
      beginPath: vi.fn(),
      moveTo: vi.fn(),
      lineTo: vi.fn(),
      stroke: vi.fn(),
      arc: vi.fn(),
      fill: vi.fn(),
      fillText: vi.fn(),
    }))

    originalGetBoundingClientRect = Element.prototype.getBoundingClientRect
    Element.prototype.getBoundingClientRect = vi.fn(() => ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 800,
      bottom: 600,
      width: 800,
      height: 600,
      toJSON: () => ({}),
    }))

    originalRAF = globalThis.requestAnimationFrame
    originalCAF = globalThis.cancelAnimationFrame
    globalThis.requestAnimationFrame = vi.fn(() => 1)
    globalThis.cancelAnimationFrame = vi.fn()

    vaultApi.getVaultEntries.mockImplementation(async (dir, relPath = '') => {
      if (dir === VAULT_A.directory) {
        if (relPath === '') {
          return {
            directory: dir,
            path: '',
            entries: [
              { name: 'Personagens', path: 'Personagens', type: 'directory' },
              { name: 'Historia.md', path: 'Historia.md', type: 'file' },
              { name: 'Final.md', path: 'Final.md', type: 'file' },
            ],
          }
        }
        if (relPath === 'Personagens') {
          return {
            directory: dir,
            path: 'Personagens',
            entries: [{ name: 'Heroi.md', path: 'Personagens/Heroi.md', type: 'file' }],
          }
        }
      }
      if (dir === VAULT_B.directory) {
        return {
          directory: dir,
          path: '',
          entries: [{ name: 'Outro.md', path: 'Outro.md', type: 'file' }],
        }
      }
      return { directory: dir, path: relPath, entries: [] }
    })

    vaultApi.getVaultMarkdown.mockImplementation(async (dir, path) => {
      const idx = dir === VAULT_A.directory ? storyRawIndex() : otherRawIndex()
      const found = idx.notes.find((n) => n.path === path)
      if (!found) {
        const err = new Error('Not found')
        err.code = 'NOT_FOUND'
        throw err
      }
      return {
        directory: dir,
        path: found.path,
        name: found.path.split('/').pop(),
        content: found.content,
        mtimeMs: found.mtimeMs,
        writable: true,
      }
    })

    vaultApi.getVaultIndex.mockImplementation(async (dir) =>
      dir === VAULT_A.directory ? storyRawIndex() : otherRawIndex()
    )

    vaultApi.saveVaultMarkdown.mockImplementation(async (dir, path, content) => ({
      directory: dir,
      path,
      content,
      mtimeMs: Date.now(),
    }))
  })

  afterEach(() => {
    for (const w of activeWrappers) {
      w.unmount()
    }
    activeWrappers = []
    globalThis.ResizeObserver = originalResizeObserver
    HTMLCanvasElement.prototype.getContext = originalGetContext
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
    vi.restoreAllMocks()
  })

  it('opens Graph tab via topbar and command palette without duplicates, switches between note tabs, and closes safely', async () => {
    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Initially no tabs or graph view
    expect(wrapper.find('[data-testid="workspace-graph-tab"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-view"]').exists()).toBe(false)

    // Open a note first so coexistence with note tabs is verified
    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-testid="workspace-tab"]')).toHaveLength(1)

    // Open Graph via topbar button
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.findAll('[data-testid="workspace-graph-tab"]')).toHaveLength(1)
    expect(wrapper.findAll('[data-testid="workspace-tab"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="graph-view"]').isVisible()).toBe(true)

    // Trigger topbar Graph button again: focuses same tab without duplicate
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    expect(wrapper.findAll('[data-testid="workspace-graph-tab"]')).toHaveLength(1)

    // Switch back to note tab
    await wrapper.find('[data-testid="workspace-tab"][data-tab-path="Historia.md"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="graph-view"]').isVisible()).toBe(false)

    // Reopen Graph via Command Palette command "Open graph view"
    await wrapper.find('[data-testid="command-palette-button"]').trigger('click')
    await nextTick()
    const commandBtn = wrapper
      .findAll('[data-testid="command-palette-modal"] button.panel-list-item')
      .find((btn) => btn.text().includes('Open graph view'))
    expect(commandBtn).toBeTruthy()
    await commandBtn.trigger('click')
    await nextTick()

    expect(wrapper.findAll('[data-testid="workspace-graph-tab"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="graph-view"]').isVisible()).toBe(true)

    // Close Graph tab without closing note tab
    await wrapper.find('[data-testid="close-graph-tab-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="workspace-graph-tab"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-testid="workspace-tab"]')).toHaveLength(1)

    wrapper.unmount()
  })

  it('opens notes clicked in graph, enforces draft protection, and preserves unsaved note drafts across tab switches', async () => {
    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()

    // Create an unsaved invalid Number draft that blocks immediate autosave flush
    const numInput = wrapper.find('[data-testid="property-number-input"]')
    expect(numInput.exists()).toBe(true)
    await numInput.setValue('abc')
    await nextTick()

    // Switching to Graph tab preserves MarkdownViewer mount and the unsaved draft
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-view"]').isVisible()).toBe(true)
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('abc')

    // Returning to the same note tab keeps the draft intact without navigation guard
    await wrapper.find('[data-testid="workspace-tab"][data-tab-path="Historia.md"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('abc')

    // Go back to Graph and try opening a different note from the graph locator
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()

    const locator = wrapper.find('[data-testid="graph-node-locator"]')
    await locator.trigger('focus')
    await locator.setValue('Heroi')
    await locator.trigger('keydown', { key: 'Enter' })
    await flushPromises()

    // Navigation guard triggers and offers Keep editing / Discard changes
    expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)
    await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('abc')

    // Trying again and choosing Discard changes navigates to the target note
    await locator.trigger('focus')
    await locator.setValue('Heroi')
    await locator.trigger('keydown', { key: 'Enter' })
    await flushPromises()
    await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="graph-view"]').isVisible()).toBe(false)
    expect(wrapper.find('[data-testid="workspace-tab"][data-tab-path="Personagens/Heroi.md"]').exists()).toBe(true)

    wrapper.unmount()
  })

  it('updates graph nodes and edges automatically after confirmed note saves and isolates across vault switches', async () => {
    const staleIndex = deferred()
    vaultApi.getVaultIndex.mockImplementationOnce(() => staleIndex.promise)

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Open Graph while vault index is still loading
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-loading-state"]').text()).toContain('Loading graph...')

    // Switch to VAULT_B before VAULT_A index resolves
    await wrapper.setProps({ vault: VAULT_B })
    await flushPromises()

    // Prior Graph tab is reset cleanly for VAULT_B and stale VAULT_A response is ignored
    expect(wrapper.find('[data-testid="workspace-graph-tab"]').exists()).toBe(false)
    staleIndex.resolve(storyRawIndex())
    await flushPromises()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    const canvasOther = wrapper.find('[data-testid="graph-canvas"]')
    expect(canvasOther.attributes('aria-label')).toBe(
      'Global graph with 1 notes and 0 connections'
    )

    // Switch back to VAULT_A with initial index error, then retry successfully
    vaultApi.getVaultIndex.mockRejectedValueOnce(new Error('Network down'))
    await wrapper.setProps({ vault: VAULT_A })
    await flushPromises()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-error-state"]').text()).toContain(
      'Unable to load graph data.'
    )

    vaultApi.getVaultIndex.mockResolvedValueOnce(storyRawIndex())
    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 3 notes and 2 connections'
    )

    // Opening a nested note from Graph expands its parent folder and focuses it in the explorer
    wrapper
      .findComponent({ name: 'GraphView' })
      .vm.$emit('open-note', 'Personagens/Heroi.md')
    await flushPromises()
    expect(wrapper.find('[data-file-path="Personagens/Heroi.md"]').exists()).toBe(true)

    // Switch to Graph, open Final.md via GraphView emit, and save a new connection [[Historia]]
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    wrapper
      .findComponent({ name: 'GraphView' })
      .vm.$emit('open-note', 'Final.md')
    await flushPromises()

    // Trigger save via MarkdownViewer content-saved event contract on edit or ctrl+s
    const viewer = wrapper.findComponent({ name: 'MarkdownViewer' })
    viewer.vm.$emit('content-saved', {
      path: 'Final.md',
      content: '# Final\nAgora conecta com [[Historia]].\n',
      mtimeMs: 2500,
    })
    await nextTick()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 3 notes and 3 connections'
    )

    wrapper.unmount()
  })
})
