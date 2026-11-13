import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import * as vaultApi from './api.js'
import MarkdownEditor from '../markdown/MarkdownEditor.vue'
import VaultBrowser from './VaultBrowser.vue'

const simulationRecords = vi.hoisted(() => [])

vi.mock('d3-force', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    forceSimulation: vi.fn((...args) => {
      const sim = actual.forceSimulation(...args)
      vi.spyOn(sim, 'stop')
      vi.spyOn(sim, 'restart')
      simulationRecords.push(sim)
      return sim
    }),
  }
})

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
    simulationRecords.length = 0
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
      setLineDash: vi.fn(),
      beginPath: vi.fn(),
      closePath: vi.fn(),
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
        revision: found.revision || 'a'.repeat(64),
        mtimeMs: found.mtimeMs,
        writable: true,
      }
    })

    vaultApi.getVaultIndex.mockImplementation(async (dir) =>
      dir === VAULT_A.directory ? storyRawIndex() : otherRawIndex()
    )

    let saveSeq = 1
    vaultApi.saveVaultMarkdown.mockImplementation(async (dir, path, payload) => ({
      directory: dir,
      path,
      content: typeof payload === 'string' ? payload : payload?.content,
      revision: (saveSeq++).toString(16).padStart(64, '0'),
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

  const extendedStoryRawIndex = () => ({
    directory: VAULT_A.directory,
    complete: true,
    failures: [],
    folders: ['Personagens'],
    files: ['Historia.md', 'Personagens/Heroi.md', 'Final.md', 'Apendice.md'],
    notes: [
      {
        path: 'Historia.md',
        content: '---\nchapter: 1\n---\n# Historia\nVeja [[Personagens/Heroi]].\n',
        revision: 'old-h-rev',
        mtimeMs: 1000,
      },
      {
        path: 'Personagens/Heroi.md',
        content: '# Heroi\nParte de [[Historia]].\n',
        revision: 'old-heroi-rev',
        mtimeMs: 1000,
      },
      {
        path: 'Final.md',
        content: '# Final\nSem links.\n',
        revision: 'old-f-rev',
        mtimeMs: 1000,
      },
      {
        path: 'Apendice.md',
        content: '# Apendice\nNotas extras.\n',
        revision: 'old-a-rev',
        mtimeMs: 1000,
      },
    ],
  })

  const editAndSaveActiveNote = async (wrapper, nextText) => {
    const editor = wrapper.findComponent(MarkdownEditor)
    editor.vm.setText(nextText)
    await nextTick()
    const viewer = wrapper.findComponent({ name: 'MarkdownViewer' })
    await viewer.vm.flushPendingSave()
    await flushPromises()
  }

  it('preserves confirmed note save and finishes full index loading when initial getVaultIndex resolves late with pre-save data', async () => {
    const staleInitialFetch = deferred()
    vaultApi.getVaultIndex.mockImplementationOnce(() => staleInitialFetch.promise)

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Save Historia.md while initial getVaultIndex() is still pending: drop [[Personagens/Heroi]] and link [[Final]] + [[Apendice]]
    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    await editAndSaveActiveNote(
      wrapper,
      '---\nchapter: 1\n---\n# Historia\nConectado a [[Final]] e [[Apendice]].\n'
    )

    // Open Graph before initial load completes: loading is still active until full index finishes
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    expect(wrapper.findComponent({ name: 'GraphView' }).props('loading')).toBe(true)

    // Stale pre-save snapshot resolves later: Historia must keep its confirmed links AND Apendice.md/Heroi.md must be recovered
    staleInitialFetch.resolve(extendedStoryRawIndex())
    await flushPromises()

    expect(wrapper.findComponent({ name: 'GraphView' }).props('loading')).toBe(false)
    expect(wrapper.find('[data-testid="graph-loading-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-incomplete-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 4 notes and 3 connections'
    )

    // Verify graph locator actually contains recovered Apendice.md and Personagens/Heroi.md
    const locator = wrapper.find('[data-testid="graph-node-locator"]')
    await locator.trigger('focus')
    await locator.setValue('Apendice')
    await nextTick()
    expect(
      wrapper.find('[data-testid="graph-locator-item"][data-note-path="Apendice.md"]').exists()
    ).toBe(true)

    // Verify confirmed save content was NOT overwritten in Graph links (Final.md connects from Historia)
    wrapper
      .findComponent({ name: 'GraphView' })
      .vm.$emit('open-note', 'Historia.md')
    await flushPromises()
    expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toContain('[[Final]]')

    wrapper.unmount()
  })

  it('preserves multiple successive saves during pending index loading and recovers remaining vault notes', async () => {
    const pendingFetch = deferred()
    vaultApi.getVaultIndex.mockImplementationOnce(() => pendingFetch.promise)

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // First save during pending load
    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    await editAndSaveActiveNote(wrapper, '# Historia\nLigado ao [[Apendice]].\n')

    // Second consecutive save during pending load
    await wrapper.find('[data-file-path="Final.md"]').trigger('click')
    await flushPromises()
    await editAndSaveActiveNote(wrapper, '# Final\nLigado a [[Personagens/Heroi]].\n')

    // Pre-save index resolves late: both Historia -> Apendice and Final -> Heroi survive alongside Heroi -> Historia
    pendingFetch.resolve(extendedStoryRawIndex())
    await flushPromises()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 4 notes and 3 connections'
    )

    wrapper.unmount()
  })

  it('ignores late errors from a previous vault after switching vaults', async () => {
    const vaultAFetch = deferred()
    vaultApi.getVaultIndex.mockImplementationOnce(() => vaultAFetch.promise)

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    await wrapper.setProps({ vault: VAULT_B })
    await flushPromises()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 1 notes and 0 connections'
    )

    vaultAFetch.reject(new Error('Vault A index timeout'))
    await flushPromises()

    expect(wrapper.find('[data-testid="graph-error-state"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 1 notes and 0 connections'
    )

    wrapper.unmount()
  })

  it('exposes refresh failure while keeping previous graph nodes, ignores redundant retries, preserves indexError across local saves, and clears on recovery', async () => {
    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 3 notes and 2 connections'
    )

    // Trigger refresh failure via Command Palette ("Refresh vault")
    vaultApi.getVaultIndex.mockRejectedValueOnce(new Error('Refresh failed'))
    await wrapper.find('[data-testid="command-palette-button"]').trigger('click')
    await nextTick()
    const refreshCmd = wrapper
      .findAll('[data-testid="command-palette-modal"] button.panel-list-item')
      .find((btn) => btn.text().includes('Refresh vault'))
    expect(refreshCmd).toBeTruthy()
    await refreshCmd.trigger('click')
    await flushPromises()

    // Previous graph nodes and canvas remain intact while refresh error notice appears
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 3 notes and 2 connections'
    )
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(true)

    // Local note save must NOT clear indexError from failed full index refresh
    wrapper
      .findComponent({ name: 'GraphView' })
      .vm.$emit('open-note', 'Final.md')
    await flushPromises()
    await editAndSaveActiveNote(wrapper, '# Final\nAgora conecta com [[Historia]].\n')

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 3 notes and 3 connections'
    )
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(true)

    // Retry once while pending: notice stays visible and repeated click does not fire duplicate request
    const retryDeferred = deferred()
    vaultApi.getVaultIndex.mockImplementationOnce(() => retryDeferred.promise)
    const callsBeforeRetry = vaultApi.getVaultIndex.mock.calls.length

    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    await nextTick()
    expect(vaultApi.getVaultIndex).toHaveBeenCalledTimes(callsBeforeRetry + 1)
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(true)

    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    await nextTick()
    expect(vaultApi.getVaultIndex).toHaveBeenCalledTimes(callsBeforeRetry + 1)

    // If retry fails again, notice remains visible and retryable
    retryDeferred.reject(new Error('Still offline'))
    await flushPromises()
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(true)

    // Subsequent retry succeeds: clears error notice and loads updated vault graph
    const recoveredIndex = extendedStoryRawIndex()
    recoveredIndex.notes = recoveredIndex.notes.map((n) =>
      n.path === 'Final.md'
        ? { ...n, content: '# Final\nAgora conecta com [[Historia]].\n', revision: 'f'.repeat(64) }
        : n
    )
    vaultApi.getVaultIndex.mockResolvedValueOnce(recoveredIndex)
    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    await flushPromises()

    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 4 notes and 3 connections'
    )

    wrapper.unmount()
  })

  it('persists shared groups and global filters/display/forces per vault, isolates vaults cleanly, drops legacy local settings fail-closed, and handles storage failures', async () => {
    // Pre-populate VAULT_B with distinct persisted settings (including legacy "local" block) to verify fail-closed migration
    localStorage.setItem(
      `ayame:graph-settings:${VAULT_B.directory}`,
      JSON.stringify({
        version: 1,
        groups: [{ id: 'vb-1', query: 'Extra', color: '#56b6c2' }],
        global: {
          filters: { searchQuery: '', showTags: true, existingFilesOnly: true, showOrphans: true },
          display: { arrows: false, textFadeThreshold: 0.9, nodeSize: 0.8, linkThickness: 1.5 },
          forces: { centerForce: 0.2, repelForce: 220, linkForce: 0.7, linkDistance: 95 },
        },
        local: {
          depth: 4,
          direction: 'incoming',
          filters: { searchQuery: '', showTags: false, existingFilesOnly: true, showOrphans: false },
        },
      })
    )

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()

    const globalView = wrapper.find('[data-testid="graph-view"]')
    const globalSim = simulationRecords[0]

    // Open settings in Global, add a group, adjust Display, Forces, and Filters
    await globalView.find('[data-testid="graph-filters-toggle"]').trigger('click')
    await globalView.find('[data-testid="graph-filter-orphans"]').setValue(false)
    await globalView.find('[data-testid="graph-section-groups"]').trigger('click')
    await globalView.find('[data-testid="graph-group-add"]').trigger('click')
    await nextTick()

    const addedQueryInput = globalView.find('[data-testid="graph-group-query-group-1"]')
    const addedColorInput = globalView.find('[data-testid="graph-group-color-group-1"]')
    await addedQueryInput.setValue('path:Personagens')
    await addedColorInput.setValue('#e06c75')
    await nextTick()

    await globalView.find('[data-testid="graph-section-display"]').trigger('click')
    await globalView.find('[data-testid="graph-display-arrows"]').setValue(true)
    await globalView.find('[data-testid="graph-display-node-size"]').setValue('1.9')
    await globalView.find('[data-testid="graph-section-forces"]').trigger('click')
    await globalView.find('[data-testid="graph-force-repel"]').setValue('310')
    await nextTick()

    const globalGraphVm = wrapper.findComponent({ name: 'GraphView' })
    expect(globalGraphVm.props('groupColors')['note:Personagens/Heroi.md']).toBe('#e06c75')
    expect(globalGraphVm.props('display').arrows).toBe(true)
    expect(globalSim.force('charge').strength()()).toBeCloseTo(-310, 5)
    expect(simulationRecords).toHaveLength(1)

    // Unmount and remount VAULT_A -> persisted groups, global display/forces, and filters survive reload cleanly
    wrapper.unmount()
    const reloaded = mountBrowser({ vault: VAULT_A })
    await flushPromises()
    await reloaded.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    await reloaded.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()

    const reloadedGlobal = reloaded.findComponent({ name: 'GraphView' })
    expect(reloadedGlobal.props('groups')).toEqual([
      { id: 'group-1', query: 'path:Personagens', color: '#e06c75' },
    ])
    expect(reloadedGlobal.props('filters').showOrphans).toBe(false)
    expect(reloadedGlobal.props('display').arrows).toBe(true)
    expect(reloadedGlobal.props('display').nodeSize).toBeCloseTo(1.9, 3)
    expect(reloadedGlobal.props('forces').repelForce).toBe(310)

    // Switch to VAULT_B -> restores VAULT_B's global & group settings while dropping legacy local block fail-closed
    const vaultASnapshotBefore = localStorage.getItem(`ayame:graph-settings:${VAULT_A.directory}`)
    await reloaded.setProps({ vault: VAULT_B })
    await flushPromises()
    await reloaded.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()

    const vaultBGlobal = reloaded.findComponent({ name: 'GraphView' })
    expect(vaultBGlobal.props('groups')).toEqual([{ id: 'vb-1', query: 'Extra', color: '#56b6c2' }])
    expect(vaultBGlobal.props('display').nodeSize).toBeCloseTo(0.8, 3)
    expect(localStorage.getItem(`ayame:graph-settings:${VAULT_A.directory}`)).toBe(vaultASnapshotBefore)
    expect(JSON.parse(vaultASnapshotBefore).local).toBeUndefined()

    // Restore default settings in VAULT_B Global -> resets Global display/filters/forces while preserving groups
    await reloaded.find('[data-testid="graph-view"] [data-testid="graph-filters-toggle"]').trigger('click')
    await reloaded.find('[data-testid="graph-view"] [data-testid="graph-restore-defaults"]').trigger('click')
    await nextTick()
    expect(vaultBGlobal.props('display').nodeSize).toBe(1)
    expect(vaultBGlobal.props('groups')).toHaveLength(1)
    expect(JSON.parse(localStorage.getItem(`ayame:graph-settings:${VAULT_B.directory}`)).local).toBeUndefined()

    // Live note save still updates global graph view cleanly without restarting simulation unnecessarily
    reloaded.findComponent({ name: 'MarkdownViewer' }).vm.$emit('content-saved', {
      path: 'Alpha.md',
      content: '#updated\nLink para [[Beta]].\n',
      mtimeMs: 3000,
    })
    await nextTick()
    expect(vaultBGlobal.find('[data-testid="graph-canvas"]').attributes('aria-label')).toContain('notes')

    // Storage failure degrades gracefully in memory and surfaces discreet warning without claiming persisted
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    await reloaded.find('[data-testid="graph-view"] [data-testid="graph-section-display"]').trigger('click')
    await reloaded.find('[data-testid="graph-view"] [data-testid="graph-display-arrows"]').setValue(true)
    await nextTick()
    expect(vaultBGlobal.props('display').arrows).toBe(true)
    expect(reloaded.find('[data-testid="graph-view"] [data-testid="graph-storage-warning"]').exists()).toBe(true)
    setItemSpy.mockRestore()

    reloaded.unmount()
  })

  it('removes Local Graph from topbar, command palette, and contextual panel while keeping Global Graph navigation and 5-tab right panel scrolling intact', async () => {
    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Mock right-panel tab strip at 200px width where early tabs fit and later tab (Search) sits off-screen
    const navEl = wrapper.find('.right-panel-tabs').element
    navEl.getBoundingClientRect = vi.fn(() => ({ left: 0, right: 200, width: 200, top: 0, bottom: 32, height: 32 }))

    const scrollSpies = new Map()
    const configureTabRect = (testId, left, right) => {
      const btn = wrapper.find(`[data-testid="${testId}"]`).element
      btn.getBoundingClientRect = vi.fn(() => ({
        left,
        right,
        width: right - left,
        top: 0,
        bottom: 32,
        height: 32,
      }))
      const spy = vi.fn()
      btn.scrollIntoView = spy
      scrollSpies.set(testId, spy)
      return btn
    }

    configureTabRect('panel-tab-backlinks', 8, 90)
    configureTabRect('panel-tab-outgoing', 94, 175)
    configureTabRect('panel-tab-outline', 180, 235)
    configureTabRect('panel-tab-tags', 240, 285)
    configureTabRect('panel-tab-search', 290, 345)

    // Primary Graph navigation exists with ONLY open-graph-button (+ SVG icon) before Commands/Panel, and zero Local Graph affordances
    const graphNav = wrapper.find('[data-testid="workspace-graph-nav"]')
    expect(graphNav.exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="open-graph-button"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="open-local-graph-button"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="panel-tab-local-graph"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="local-graph-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="local-graph-view"]').exists()).toBe(false)
    expect(wrapper.findAll('.right-panel-tab')).toHaveLength(5)

    // Command palette exposes Open graph view and does NOT expose Open local graph
    await wrapper.find('[data-testid="command-palette-button"]').trigger('click')
    await nextTick()
    const cmdLabels = wrapper
      .findAll('[data-testid="command-palette-modal"] button.panel-list-item')
      .map((btn) => btn.text())
    expect(cmdLabels.some((t) => t.includes('Open graph view'))).toBe(true)
    expect(cmdLabels.some((t) => t.toLowerCase().includes('local graph'))).toBe(false)
    await wrapper.find('[data-testid="command-palette-modal"]').trigger('keydown', { key: 'Escape' })
    await nextTick()

    const globalBtn = graphNav.find('[data-testid="open-graph-button"]')
    expect(globalBtn.text()).toContain('Graph')
    expect(globalBtn.find('svg').exists()).toBe(true)

    // Graph nav stays before Commands and Panel in DOM order even with no notes open, collapsed explorer, and collapsed right panel
    const commandsBtn = wrapper.find('[data-testid="command-palette-button"]')
    expect(
      Boolean(graphNav.element.compareDocumentPosition(commandsBtn.element) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)

    await wrapper.find('[data-testid="toggle-explorer-button"]').trigger('click')
    await nextTick()
    expect(globalBtn.isVisible()).toBe(true)

    // Clicking Graph with no open note opens Global Graph cleanly and marks active state
    await globalBtn.trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-view"]').exists()).toBe(true)
    expect(globalBtn.classes()).toContain('workspace-nav-graph--active')

    // Open a note with unsaved dirty changes -> Global Graph keeps editor mounted and unsaved draft intact
    await wrapper.find('[data-testid="toggle-explorer-button"]').trigger('click')
    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    const viewer = wrapper.findComponent({ name: 'MarkdownViewer' })
    const viewerElementBefore = viewer.element
    viewer.vm.$emit('state', { dirty: true, saving: false, saveState: 'idle' })
    await nextTick()

    await globalBtn.trigger('click')
    await nextTick()
    expect(wrapper.findComponent({ name: 'MarkdownViewer' }).element).toBe(viewerElementBefore)

    // Open contextual panel and test 200px/300px horizontal tab visibility across the 5 tabs
    await wrapper.find('[data-testid="toggle-right-panel-button"]').trigger('click')
    await nextTick()
    await nextTick()

    // Selecting already-visible Backlinks tab inside 200px does NOT trigger needless scrollIntoView
    scrollSpies.get('panel-tab-backlinks').mockClear()
    await wrapper.find('[data-testid="panel-tab-backlinks"]').trigger('click')
    await nextTick()
    expect(scrollSpies.get('panel-tab-backlinks')).not.toHaveBeenCalled()

    // Resize to 300px width: End jumps to Search (290..345), which sits past 300px right edge and scrolls into view
    navEl.getBoundingClientRect = vi.fn(() => ({ left: 0, right: 300, width: 300, top: 0, bottom: 32, height: 32 }))
    scrollSpies.get('panel-tab-search').mockClear()
    await wrapper.find('[data-testid="panel-tab-backlinks"]').trigger('keydown', { key: 'End' })
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="panel-tab-search"]').classes()).toContain('right-panel-tab--active')
    expect(scrollSpies.get('panel-tab-search')).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })

    // ArrowLeft moves cleanly to Tags
    await wrapper.find('[data-testid="panel-tab-search"]').trigger('keydown', { key: 'ArrowLeft' })
    await nextTick()
    expect(wrapper.find('[data-testid="panel-tab-tags"]').classes()).toContain('right-panel-tab--active')

    wrapper.unmount()
  })

  it('re-scrolls the active contextual panel tab into view after narrowing the panel without losing drafts or disturbing Graph View, while skipping redundant scrolls on widening', async () => {
    const origInnerWidth = window.innerWidth
    Object.defineProperty(window, 'innerWidth', { value: 1400, configurable: true, writable: true })

    try {
      const wrapper = mountBrowser({ vault: VAULT_A })
      await flushPromises()

      // Open note with unsaved dirty changes so we verify resize never disturbs editor state
      await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
      await flushPromises()
      const viewer = wrapper.findComponent({ name: 'MarkdownViewer' })
      const viewerElementBefore = viewer.element
      viewer.vm.$emit('state', { dirty: true, saving: false, saveState: 'idle' })
      await nextTick()

      let navWidth = 400
      const navEl = wrapper.find('.right-panel-tabs').element
      navEl.getBoundingClientRect = vi.fn(() => ({
        left: 0,
        right: navWidth,
        width: navWidth,
        top: 0,
        bottom: 32,
        height: 32,
      }))

      const scrollSpies = new Map()
      const configureTabRect = (testId, left, right) => {
        const btn = wrapper.find(`[data-testid="${testId}"]`).element
        btn.getBoundingClientRect = vi.fn(() => ({
          left,
          right,
          width: right - left,
          top: 0,
          bottom: 32,
          height: 32,
        }))
        const spy = vi.fn()
        btn.scrollIntoView = spy
        scrollSpies.set(testId, spy)
        return btn
      }

      configureTabRect('panel-tab-backlinks', 8, 90)
      configureTabRect('panel-tab-outgoing', 94, 175)
      configureTabRect('panel-tab-outline', 180, 235)
      configureTabRect('panel-tab-tags', 240, 290)
      // Fits inside 400px & 380px, overflows right edge when panel narrows to 200px
      configureTabRect('panel-tab-search', 300, 365)

      // Open right panel + Search tab at wide width (400px via splitter drag)
      await wrapper.find('[data-testid="toggle-right-panel-button"]').trigger('click')
      await wrapper.find('[data-testid="panel-tab-search"]').trigger('click')
      await nextTick()
      await nextTick()

      const splitter = wrapper.find('[data-testid="resize-handle-context"]')
      expect(splitter.exists()).toBe(true)
      const makePointerEvent = (type, clientX, pointerId = 1) => {
        const ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX })
        Object.defineProperty(ev, 'pointerId', { value: pointerId })
        return ev
      }

      splitter.element.dispatchEvent(makePointerEvent('pointerdown', 900, 1))
      window.dispatchEvent(makePointerEvent('pointermove', 780, 1)) // 280 + 120 = 400
      window.dispatchEvent(makePointerEvent('pointerup', 780, 1))
      await nextTick()
      await nextTick()
      expect(splitter.attributes('aria-valuenow')).toBe('400')

      scrollSpies.get('panel-tab-search').mockClear()

      // B1: Shrink right panel from 400px -> 200px so Search tab overflows right edge
      navWidth = 200
      splitter.element.dispatchEvent(makePointerEvent('pointerdown', 780, 2))
      window.dispatchEvent(makePointerEvent('pointermove', 980, 2)) // 400 - 200 = 200
      window.dispatchEvent(makePointerEvent('pointerup', 980, 2))
      await nextTick()
      await nextTick()

      expect(splitter.attributes('aria-valuenow')).toBe('200')
      expect(scrollSpies.get('panel-tab-search')).toHaveBeenCalledWith({
        block: 'nearest',
        inline: 'nearest',
      })
      expect(wrapper.findComponent({ name: 'MarkdownViewer' }).element).toBe(viewerElementBefore)

      // B2: Widen panel back from 200px -> 380px where active tab already fits cleanly: skip redundant scrollIntoView
      navWidth = 380
      scrollSpies.get('panel-tab-search').mockClear()
      splitter.element.dispatchEvent(makePointerEvent('pointerdown', 980, 3))
      window.dispatchEvent(makePointerEvent('pointermove', 800, 3)) // 200 + 180 = 380
      window.dispatchEvent(makePointerEvent('pointerup', 800, 3))
      await nextTick()
      await nextTick()

      expect(splitter.attributes('aria-valuenow')).toBe('380')
      expect(scrollSpies.get('panel-tab-search')).not.toHaveBeenCalled()

      // B3: Keyboard navigation between contextual tabs keeps working cleanly after resize
      await wrapper.find('[data-testid="panel-tab-search"]').trigger('keydown', { key: 'Home' })
      await nextTick()
      expect(wrapper.find('[data-testid="panel-tab-backlinks"]').classes()).toContain('right-panel-tab--active')
      await wrapper.find('[data-testid="panel-tab-backlinks"]').trigger('keydown', { key: 'End' })
      await nextTick()
      await nextTick()
      expect(wrapper.find('[data-testid="panel-tab-search"]').classes()).toContain('right-panel-tab--active')

      wrapper.unmount()
    } finally {
      Object.defineProperty(window, 'innerWidth', { value: origInnerWidth, configurable: true, writable: true })
    }
  })
})
