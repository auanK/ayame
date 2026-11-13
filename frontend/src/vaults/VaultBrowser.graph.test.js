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

  it('opens Local Graph in right panel, follows active note safely across blocked navigation, and handles 200px reveal resize', async () => {
    const richIndex = () => ({
      directory: VAULT_A.directory,
      complete: true,
      failures: [],
      folders: ['Personagens'],
      files: ['Historia.md', 'Personagens/Heroi.md', 'Vilao.md', 'Final.md'],
      notes: [
        {
          path: 'Historia.md',
          content: '---\nchapter: 1\n---\n# Historia\nVeja [[Personagens/Heroi]].\n',
          mtimeMs: 1000,
        },
        {
          path: 'Personagens/Heroi.md',
          content: '# Heroi\nParte de [[Historia]] e enfrenta [[Vilao]].\n',
          mtimeMs: 1000,
        },
        {
          path: 'Vilao.md',
          content: '# Vilao\nLigado ao [[Final]].\n',
          mtimeMs: 1000,
        },
        {
          path: 'Final.md',
          content: '# Final\nSem links.\n',
          mtimeMs: 1000,
        },
      ],
    })
    vaultApi.getVaultIndex.mockResolvedValue(richIndex())
    vaultApi.getVaultMarkdown.mockImplementation(async (dir, path) => {
      const found = richIndex().notes.find((n) => n.path === path)
      if (!found) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })
      return {
        directory: dir,
        path: found.path,
        name: found.path.split('/').pop(),
        content: found.content,
        revision: 'a'.repeat(64),
        mtimeMs: found.mtimeMs,
        writable: true,
      }
    })

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Ensure right panel starts collapsed or collapse it, then open Local Graph via Command Palette
    if (wrapper.find('[data-testid="workspace-right-panel"]').exists() &&
        !wrapper.find('[data-testid="workspace-right-panel"]').classes().includes('workspace-right-panel--collapsed')) {
      await wrapper.find('[data-testid="toggle-right-panel-button"]').trigger('click')
      await nextTick()
    }

    await wrapper.find('[data-testid="command-palette-button"]').trigger('click')
    await nextTick()
    const localCmd = wrapper
      .findAll('[data-testid="command-palette-modal"] button.panel-list-item')
      .find((btn) => btn.text().includes('Open local graph'))
    expect(localCmd).toBeTruthy()
    await localCmd.trigger('click')
    await nextTick()

    const localGraph = wrapper.find('[data-testid="local-graph-view"]')
    expect(localGraph.exists()).toBe(true)
    expect(
      wrapper.find('[data-testid="workspace-right-panel"]').classes()
    ).not.toContain('workspace-right-panel--collapsed')
    expect(localGraph.find('[data-testid="graph-no-center-state"]').exists()).toBe(true)

    // Narrow right panel down to 200px via splitter Home key without crashing or losing panel
    const splitter = wrapper.find('[data-testid="resize-handle-context"]')
    await splitter.trigger('keydown', { key: 'Home' })
    await nextTick()
    expect(wrapper.find('[data-testid="workspace-right-panel"]').attributes('style')).toContain(
      'width: 200px'
    )

    // Opening Historia.md centers Local Graph on Historia + Heroi (depth 1)
    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    expect(localGraph.find('[data-testid="local-graph-center"]').text()).toContain('Historia')
    expect(localGraph.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Local graph with 2 nodes and 2 connections'
    )

    // Block navigation via invalid Number draft and try opening Personagens/Heroi.md from Local Graph
    await wrapper.find('[data-testid="property-number-input"]').setValue('abc')
    await nextTick()

    wrapper
      .findComponent({ name: 'GraphView' }) // Local graph is only GraphView mounted right now
      .vm.$emit('open-note', 'Personagens/Heroi.md')
    await flushPromises()

    // Navigation is blocked, so Local Graph MUST keep Historia.md as center!
    expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)
    expect(localGraph.find('[data-testid="local-graph-center"]').text()).toContain('Historia')

    await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
    await flushPromises()
    expect(localGraph.find('[data-testid="local-graph-center"]').text()).toContain('Heroi')

    wrapper.unmount()
  })

  it('keeps Global and Local filters/depth/simulations isolated, updates on live saves, and resets on vault switch', async () => {
    const richIndex = () => ({
      directory: VAULT_A.directory,
      complete: true,
      failures: [],
      folders: ['Personagens'],
      files: ['Historia.md', 'Personagens/Heroi.md', 'Final.md', 'Orphan.md'],
      notes: [
        {
          path: 'Historia.md',
          content: '#Historia #lore\nVeja [[Personagens/Heroi]] e [[Falta]].\n',
          mtimeMs: 1000,
        },
        {
          path: 'Personagens/Heroi.md',
          content: '# Heroi\nConecta em [[Final]].\n',
          mtimeMs: 1000,
        },
        {
          path: 'Final.md',
          content: '# Final\nSem links.\n',
          mtimeMs: 1000,
        },
        {
          path: 'Orphan.md',
          content: '# Orphan\nSem links.\n',
          mtimeMs: 1000,
        },
      ],
    })
    vaultApi.getVaultIndex.mockResolvedValue(richIndex())
    vaultApi.getVaultMarkdown.mockImplementation(async (dir, path) => {
      const idx = dir === VAULT_A.directory ? richIndex() : otherRawIndex()
      const found = idx.notes.find((n) => n.path === path)
      if (!found) throw Object.assign(new Error('Not found'), { code: 'NOT_FOUND' })
      return {
        directory: dir,
        path: found.path,
        name: found.path.split('/').pop(),
        content: found.content,
        revision: 'a'.repeat(64),
        mtimeMs: found.mtimeMs,
        writable: true,
      }
    })

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Open Historia.md, Global Graph tab, AND Local Graph right panel tab
    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()

    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    await wrapper.find('[data-testid="panel-tab-local-graph"]').trigger('click')
    await nextTick()

    const globalView = wrapper.find('[data-testid="graph-view"]')
    const localView = wrapper.find('[data-testid="local-graph-view"]')
    expect(globalView.exists()).toBe(true)
    expect(localView.exists()).toBe(true)
    expect(simulationRecords).toHaveLength(2)
    const globalSim = simulationRecords[0]
    const localSim = simulationRecords[1]
    const globalRestartBefore = globalSim.restart.mock.calls.length
    const localRestartBefore = localSim.restart.mock.calls.length

    // Change Local depth to 2 and enable Local Tags & Unresolved -> Global Graph MUST NOT change or restart
    await localView.find('[data-testid="graph-local-depth"]').setValue('2')
    await nextTick()
    await localView.find('[data-testid="graph-filters-toggle"]').trigger('click')
    await nextTick()
    await localView.find('[data-testid="graph-filter-tags"]').setValue(true)
    await nextTick()
    await localView.find('[data-testid="graph-filter-existing-only"]').setValue(false)
    await nextTick()

    // Local now includes Historia, Heroi, Final (depth 2), tag:Historia, tag:lore, unresolved Falta
    const localAria = localView.find('[data-testid="graph-canvas"]').attributes('aria-label')
    expect(localAria).toBe('Local graph with 6 nodes and 5 connections')
    expect(localView.findAll('[data-testid="graph-locator-item"]')).toHaveLength(0)

    // Global remains strictly default-filtered (4 notes, 2 connections) and simulation did not restart!
    expect(globalView.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 4 notes and 2 connections'
    )
    expect(globalSim.restart.mock.calls.length).toBe(globalRestartBefore)
    expect(localSim.restart.mock.calls.length).toBeGreaterThan(localRestartBefore)

    // Live note save updates tags & connections immediately in filtered Local view
    wrapper.findComponent({ name: 'MarkdownViewer' }).vm.$emit('content-saved', {
      path: 'Historia.md',
      content: '#Historia #lore #novo\nVeja [[Personagens/Heroi]] e [[Falta]].\n',
      mtimeMs: 2500,
    })
    await nextTick()
    expect(localView.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Local graph with 7 nodes and 6 connections'
    )

    // Filter Global Graph independently (hide orphans) -> Local Graph keeps its own filters
    await globalView.find('[data-testid="graph-filters-toggle"]').trigger('click')
    await nextTick()
    await globalView.find('[data-testid="graph-filter-orphans"]').setValue(false)
    await nextTick()
    expect(globalView.find('[data-testid="graph-canvas"]').attributes('aria-label')).toBe(
      'Global graph with 3 notes and 2 connections'
    )

    // Switching vault resets graph filters & local settings cleanly and stops simulations cleanly
    await wrapper.setProps({ vault: VAULT_B })
    await flushPromises()
    expect(localView.find('[data-testid="graph-no-center-state"]').exists()).toBe(true)
    expect(globalSim.stop).toHaveBeenCalled()
    expect(localSim.stop).toHaveBeenCalled()

    wrapper.unmount()
  })

  it('persists shared groups and independent Global/Local display & forces per vault, isolates vaults cleanly, and handles storage failures without breaking active graphs', async () => {
    // Pre-populate VAULT_B with distinct persisted settings to prove vault switch neither leaks A nor overwrites B
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
          display: { arrows: true, textFadeThreshold: 0.3, nodeSize: 1.4, linkThickness: 1.1 },
          forces: { centerForce: 0.1, repelForce: 140, linkForce: 0.5, linkDistance: 50 },
        },
      })
    )

    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    await wrapper.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    await wrapper.find('[data-testid="panel-tab-local-graph"]').trigger('click')
    await nextTick()

    const globalView = wrapper.find('[data-testid="graph-view"]')
    const localView = wrapper.find('[data-testid="local-graph-view"]')
    const globalSim = simulationRecords[0]
    const localSim = simulationRecords[1]

    // Open settings in Global, add & configure two groups, then change Global Display and Forces
    await globalView.find('[data-testid="graph-filters-toggle"]').trigger('click')
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

    // Global & Local share Groups, while Forces/Display stay view-specific
    const localGraphVm = wrapper.findAllComponents({ name: 'GraphView' }).find((c) => c.props('mode') === 'local')
    const globalGraphVm = wrapper.findAllComponents({ name: 'GraphView' }).find((c) => c.props('mode') === 'global')
    expect(globalGraphVm.props('groupColors')['note:Personagens/Heroi.md']).toBe('#e06c75')
    expect(localGraphVm.props('groupColors')['note:Personagens/Heroi.md']).toBe('#e06c75')
    expect(globalGraphVm.props('display').arrows).toBe(true)
    expect(localGraphVm.props('display').arrows).toBe(false)
    expect(globalSim.force('charge').strength()()).toBeCloseTo(-310, 5)
    expect(localSim.force('charge').strength()()).toBeCloseTo(-165, 5)
    expect(simulationRecords).toHaveLength(2)

    // Modify Local display & depth independently and ensure narrow 200px sidebar width works with controls open
    await localView.find('[data-testid="graph-local-depth"]').setValue('2')
    await localView.find('[data-testid="graph-filters-toggle"]').trigger('click')
    await localView.find('[data-testid="graph-section-display"]').trigger('click')
    await localView.find('[data-testid="graph-display-text-fade"]').setValue('1.25')
    await nextTick()
    expect(localGraphVm.props('display').textFadeThreshold).toBeCloseTo(1.25, 3)
    expect(globalGraphVm.props('display').textFadeThreshold).toBeCloseTo(0.48, 3)

    // Unmount and remount VAULT_A -> persisted groups, global display/forces, and local display/depth survive reload
    wrapper.unmount()
    const reloaded = mountBrowser({ vault: VAULT_A })
    await flushPromises()
    await reloaded.find('[data-file-path="Historia.md"]').trigger('click')
    await flushPromises()
    await reloaded.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()
    await reloaded.find('[data-testid="panel-tab-local-graph"]').trigger('click')
    await nextTick()

    const reloadedGlobal = reloaded.findAllComponents({ name: 'GraphView' }).find((c) => c.props('mode') === 'global')
    const reloadedLocal = reloaded.findAllComponents({ name: 'GraphView' }).find((c) => c.props('mode') === 'local')
    expect(reloadedGlobal.props('groups')).toEqual([
      { id: 'group-1', query: 'path:Personagens', color: '#e06c75' },
    ])
    expect(reloadedGlobal.props('display').arrows).toBe(true)
    expect(reloadedGlobal.props('display').nodeSize).toBeCloseTo(1.9, 3)
    expect(reloadedGlobal.props('forces').repelForce).toBe(310)
    expect(reloadedLocal.props('localDepth')).toBe(2)
    expect(reloadedLocal.props('display').textFadeThreshold).toBeCloseTo(1.25, 3)

    // Switch to VAULT_B -> restores VAULT_B's stored settings without overwriting VAULT_A or VAULT_B
    const vaultASnapshotBefore = localStorage.getItem(`ayame:graph-settings:${VAULT_A.directory}`)
    await reloaded.setProps({ vault: VAULT_B })
    await flushPromises()
    await reloaded.find('[data-testid="open-graph-button"]').trigger('click')
    await nextTick()

    const vaultBGlobal = reloaded.findAllComponents({ name: 'GraphView' }).find((c) => c.props('mode') === 'global')
    const vaultBLocal = reloaded.findAllComponents({ name: 'GraphView' }).find((c) => c.props('mode') === 'local')
    expect(vaultBGlobal.props('groups')).toEqual([{ id: 'vb-1', query: 'Extra', color: '#56b6c2' }])
    expect(vaultBGlobal.props('display').nodeSize).toBeCloseTo(0.8, 3)
    expect(vaultBLocal.props('localDepth')).toBe(4)
    expect(vaultBLocal.props('localDirection')).toBe('incoming')
    expect(localStorage.getItem(`ayame:graph-settings:${VAULT_A.directory}`)).toBe(vaultASnapshotBefore)

    // Restore default settings in VAULT_B Global -> resets Global while preserving groups and Local settings
    await reloaded.find('[data-testid="graph-view"] [data-testid="graph-filters-toggle"]').trigger('click')
    await reloaded.find('[data-testid="graph-view"] [data-testid="graph-restore-defaults"]').trigger('click')
    await nextTick()
    expect(vaultBGlobal.props('display').nodeSize).toBe(1)
    expect(vaultBGlobal.props('groups')).toHaveLength(1)
    expect(vaultBLocal.props('localDepth')).toBe(4)

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

  it('promotes Graph and Local Graph to primary workspace navigation, protects dirty drafts, and scrolls offscreen contextual tabs horizontally at 200px/300px widths', async () => {
    const wrapper = mountBrowser({ vault: VAULT_A })
    await flushPromises()

    // Mock right-panel tab strip at 200px width where first tabs fit and later tabs (e.g. Local Graph) sit off-screen
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
    configureTabRect('panel-tab-search', 290, 340)
    configureTabRect('panel-tab-local-graph', 345, 430)

    // Primary Graph navigation exists with single open-graph-button (+ SVG icon) and open-local-graph-button before Commands/Panel
    const graphNav = wrapper.find('[data-testid="workspace-graph-nav"]')
    expect(graphNav.exists()).toBe(true)
    expect(wrapper.findAll('[data-testid="open-graph-button"]')).toHaveLength(1)

    const globalBtn = graphNav.find('[data-testid="open-graph-button"]')
    const localBtn = graphNav.find('[data-testid="open-local-graph-button"]')
    expect(globalBtn.exists()).toBe(true)
    expect(globalBtn.text()).toContain('Graph')
    expect(globalBtn.find('svg').exists()).toBe(true)
    expect(localBtn.exists()).toBe(true)
    expect(localBtn.text()).toContain('Local Graph')

    // Graph nav stays before Commands and Panel in DOM order even with no notes open, collapsed explorer, and collapsed right panel
    const commandsBtn = wrapper.find('[data-testid="command-palette-button"]')
    expect(
      Boolean(graphNav.element.compareDocumentPosition(commandsBtn.element) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true)

    await wrapper.find('[data-testid="toggle-explorer-button"]').trigger('click')
    await nextTick()
    expect(globalBtn.isVisible()).toBe(true)
    expect(localBtn.isVisible()).toBe(true)

    // Clicking Graph with no open note opens Global Graph cleanly and marks active state
    await globalBtn.trigger('click')
    await nextTick()
    expect(wrapper.find('[data-testid="graph-view"]').exists()).toBe(true)
    expect(globalBtn.classes()).toContain('workspace-nav-graph--active')

    // Open a note with unsaved dirty changes, then use primary Graph & Local Graph buttons:
    // editor stays mounted and unsaved edits are preserved!
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

    // Right panel is collapsed initially -> clicking primary Local Graph expands panel, selects tab, and scrolls it horizontally into view!
    expect(wrapper.find('[data-testid="workspace-right-panel"]').classes()).toContain(
      'workspace-right-panel--collapsed'
    )
    await localBtn.trigger('click')
    await nextTick()
    await nextTick()

    expect(wrapper.find('[data-testid="workspace-right-panel"]').classes()).not.toContain(
      'workspace-right-panel--collapsed'
    )
    expect(wrapper.find('[data-testid="panel-tab-local-graph"]').classes()).toContain(
      'right-panel-tab--active'
    )
    expect(localBtn.classes()).toContain('workspace-nav-graph--active')
    expect(scrollSpies.get('panel-tab-local-graph')).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })

    // Selecting an already-visible tab (Backlinks inside 200px or 300px) does NOT call needless scrollIntoView
    scrollSpies.get('panel-tab-backlinks').mockClear()
    await wrapper.find('[data-testid="panel-tab-backlinks"]').trigger('click')
    await nextTick()
    expect(scrollSpies.get('panel-tab-backlinks')).not.toHaveBeenCalled()

    // Resize to 300px width: Local Graph (345..430) is still past 300px right edge and scrolls into view via keyboard navigation
    navEl.getBoundingClientRect = vi.fn(() => ({ left: 0, right: 300, width: 300, top: 0, bottom: 32, height: 32 }))
    scrollSpies.get('panel-tab-local-graph').mockClear()
    await wrapper.find('[data-testid="panel-tab-backlinks"]').trigger('keydown', { key: 'End' })
    await nextTick()
    await nextTick()
    expect(wrapper.find('[data-testid="panel-tab-local-graph"]').classes()).toContain(
      'right-panel-tab--active'
    )
    expect(scrollSpies.get('panel-tab-local-graph')).toHaveBeenCalledWith({
      block: 'nearest',
      inline: 'nearest',
    })

    // ArrowLeft moves cleanly to Search
    await wrapper.find('[data-testid="panel-tab-local-graph"]').trigger('keydown', { key: 'ArrowLeft' })
    await nextTick()
    expect(wrapper.find('[data-testid="panel-tab-search"]').classes()).toContain('right-panel-tab--active')

    wrapper.unmount()
  })
})
