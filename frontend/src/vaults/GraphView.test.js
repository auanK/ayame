import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { buildVaultIndex } from './vaultIndex.js'
import { buildGraphModel } from './graphModel.js'
import { createDefaultGraphFilters, projectGraphView } from './graphSelection.js'

const simulationRecords = vi.hoisted(() => [])

vi.mock('d3-force', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    forceSimulation: vi.fn((...args) => {
      const sim = actual.forceSimulation(...args)
      vi.spyOn(sim, 'stop')
      vi.spyOn(sim, 'alpha')
      vi.spyOn(sim, 'alphaTarget')
      vi.spyOn(sim, 'restart')
      simulationRecords.push(sim)
      return sim
    }),
  }
})

import GraphView from './GraphView.vue'

const sampleIndex = () =>
  buildVaultIndex({
    directory: 'C:/vaults/story',
    complete: true,
    failures: [],
    files: ['Historia.md', 'Personagens/Heroi.md', 'Lore/Heroi.md', 'Isolada.md'],
    notes: [
      {
        path: 'Historia.md',
        content: 'O [[Personagens/Heroi]] enfrenta o destino em [[Lore/Heroi]].',
        mtimeMs: 1000,
      },
      {
        path: 'Personagens/Heroi.md',
        content: 'Ligado a [[Historia]].',
        mtimeMs: 1000,
      },
      {
        path: 'Lore/Heroi.md',
        content: 'Registro antigo sem ligações.',
        mtimeMs: 1000,
      },
      {
        path: 'Isolada.md',
        content: 'Sem conexões.',
        mtimeMs: 1000,
      },
    ],
  })

const pointerEvent = (type, { clientX = 0, clientY = 0, button = 0, pointerId = 1 } = {}) => {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    button,
    clientX,
    clientY,
  })
  Object.defineProperty(event, 'pointerId', { value: pointerId })
  return event
}

describe('GraphView.vue', () => {
  let resizeObservers
  let originalResizeObserver
  let originalGetContext
  let originalGetBoundingClientRect
  let originalRAF
  let originalCAF
  let rafQueue
  let nextRafId

  beforeEach(() => {
    simulationRecords.length = 0
    resizeObservers = []
    rafQueue = new Map()
    nextRafId = 1

    originalResizeObserver = globalThis.ResizeObserver
    globalThis.ResizeObserver = class MockResizeObserver {
      constructor(callback) {
        this.callback = callback
        this.observe = vi.fn()
        this.disconnect = vi.fn()
        this.unobserve = vi.fn()
        resizeObservers.push(this)
      }
      trigger() {
        this.callback([])
      }
    }

    originalGetContext = HTMLCanvasElement.prototype.getContext
    const ctxByCanvas = new WeakMap()
    HTMLCanvasElement.prototype.getContext = vi.fn(function getMockContext() {
      let ctx = ctxByCanvas.get(this)
      if (!ctx) {
        const recorded = {
          arcs: [],
          texts: [],
          strokes: [],
          fills: [],
          moves: [],
          lines: [],
        }
        let currentPath = []
        ctx = {
          _recorded: recorded,
          fillStyle: '',
          strokeStyle: '',
          lineWidth: 1,
          font: '',
          textAlign: 'left',
          textBaseline: 'alphabetic',
          setTransform: vi.fn(),
          clearRect: vi.fn(),
          setLineDash: vi.fn(),
          beginPath: vi.fn(() => {
            currentPath = []
          }),
          closePath: vi.fn(() => {
            currentPath.push({ op: 'close' })
          }),
          moveTo: vi.fn((x, y) => {
            recorded.moves.push({ x, y })
            currentPath.push({ op: 'move', x, y })
          }),
          lineTo: vi.fn((x, y) => {
            recorded.lines.push({ x, y })
            currentPath.push({ op: 'line', x, y })
          }),
          stroke: vi.fn(() => {
            recorded.strokes.push({
              strokeStyle: ctx.strokeStyle,
              lineWidth: ctx.lineWidth,
              path: [...currentPath],
            })
          }),
          arc: vi.fn((x, y, r) => {
            recorded.arcs.push({ x, y, r })
            currentPath.push({ op: 'arc', x, y, r })
          }),
          fill: vi.fn(() => {
            recorded.fills.push({
              fillStyle: ctx.fillStyle,
              path: [...currentPath],
            })
          }),
          fillText: vi.fn((text, x, y) => {
            recorded.texts.push({ text, x, y, fillStyle: ctx.fillStyle })
          }),
        }
        ctxByCanvas.set(this, ctx)
      }
      return ctx
    })

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
    globalThis.requestAnimationFrame = vi.fn((cb) => {
      const id = nextRafId++
      rafQueue.set(id, cb)
      return id
    })
    globalThis.cancelAnimationFrame = vi.fn((id) => {
      rafQueue.delete(id)
    })
  })

  afterEach(() => {
    globalThis.ResizeObserver = originalResizeObserver
    HTMLCanvasElement.prototype.getContext = originalGetContext
    Element.prototype.getBoundingClientRect = originalGetBoundingClientRect
    globalThis.requestAnimationFrame = originalRAF
    globalThis.cancelAnimationFrame = originalCAF
    vi.restoreAllMocks()
  })

  it('distinguishes loading, empty, error with retry, and incomplete states', async () => {
    const emptyGraph = buildGraphModel({
      directory: 'C:/vaults/story',
      complete: true,
      failures: [],
      files: [],
      notesByPath: {},
      outgoingByFile: {},
    })

    const wrapper = mount(GraphView, {
      props: {
        graph: emptyGraph,
        vaultDirectory: 'C:/vaults/story',
        loading: true,
        error: false,
      },
    })

    expect(wrapper.find('[data-testid="graph-loading-state"]').text()).toContain('Loading graph...')
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(false)

    await wrapper.setProps({ loading: false, error: true })
    expect(wrapper.find('[data-testid="graph-error-state"]').text()).toContain(
      'Unable to load graph data.'
    )
    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)

    await wrapper.setProps({ error: false })
    expect(wrapper.find('[data-testid="graph-empty-state"]').text()).toContain(
      'No notes in this vault.'
    )

    const incompleteEmptyGraph = buildGraphModel({
      directory: 'C:/vaults/story',
      complete: false,
      failures: [{ path: 'Broken.md', message: 'Permission denied' }],
      files: [],
      notesByPath: {},
      outgoingByFile: {},
    })
    await wrapper.setProps({ graph: incompleteEmptyGraph })
    expect(wrapper.find('[data-testid="graph-incomplete-state"]').text()).toContain(
      'Graph data is incomplete.'
    )

    const partialGraph = buildGraphModel({
      directory: 'C:/vaults/story',
      complete: false,
      failures: [{ path: 'Broken.md', message: 'Permission denied' }],
      files: ['Historia.md'],
      notesByPath: { 'Historia.md': { path: 'Historia.md', title: 'Historia', content: '' } },
      outgoingByFile: { 'Historia.md': [] },
    })
    await wrapper.setProps({ graph: partialGraph })
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-incomplete-notice"]').text()).toContain(
      'Graph data is incomplete.'
    )

    wrapper.unmount()
  })

  it('locates notes via keyboard locator, disambiguates duplicate names, and emits open-note', async () => {
    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const locator = wrapper.find('[data-testid="graph-node-locator"]')
    await locator.trigger('focus')
    await locator.setValue('Heroi')
    await nextTick()

    const items = wrapper.findAll('[data-testid="graph-locator-item"]')
    expect(items.length).toBe(2)
    expect(items.map((el) => el.attributes('data-note-path')).sort()).toEqual([
      'Lore/Heroi.md',
      'Personagens/Heroi.md',
    ])
    expect(items[0].text()).toContain('Lore/Heroi.md')

    await locator.trigger('keydown', { key: 'ArrowDown' })
    expect(wrapper.find('[data-testid="graph-hover-caption"]').text()).toBe(
      'Personagens/Heroi.md'
    )

    await locator.trigger('keydown', { key: 'Enter' })
    expect(wrapper.emitted('open-note')).toEqual([['Personagens/Heroi.md']])

    await locator.trigger('focus')
    await locator.setValue('Isolada')
    await locator.trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-testid="graph-locator-results"]').exists()).toBe(false)

    wrapper.unmount()
  })

  it('opens a clicked node, treats a drag past threshold as drag (not open), and supports pan & cursor zoom', async () => {
    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    expect(simulationRecords).toHaveLength(1)
    const sim = simulationRecords[0]
    sim.tick(4)
    const targetNode = sim.nodes().find((n) => n.path === 'Personagens/Heroi.md')
    expect(targetNode).toBeTruthy()

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    const startX = 400 + targetNode.x
    const startY = 300 + targetNode.y

    // Hover displays full path caption
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: startX, clientY: startY }))
    await nextTick()
    expect(wrapper.find('[data-testid="graph-hover-caption"]').text()).toBe(
      'Personagens/Heroi.md'
    )

    // Simple click without moving past threshold emits open-note
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: startX, clientY: startY }))
    canvasEl.dispatchEvent(
      pointerEvent('pointerup', { clientX: startX + 1, clientY: startY + 1 })
    )
    expect(wrapper.emitted('open-note')).toEqual([['Personagens/Heroi.md']])

    // Dragging a node past 4px threshold restarts simulation and does NOT emit open-note
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: startX, clientY: startY }))
    canvasEl.dispatchEvent(
      pointerEvent('pointermove', { clientX: startX + 35, clientY: startY + 20 })
    )
    expect(sim.alphaTarget).toHaveBeenCalledWith(0.28)
    canvasEl.dispatchEvent(
      pointerEvent('pointerup', { clientX: startX + 35, clientY: startY + 20 })
    )
    expect(sim.alphaTarget).toHaveBeenCalledWith(0)
    expect(wrapper.emitted('open-note')).toHaveLength(1)
    expect(targetNode.fx).toBeNull()
    expect(targetNode.fy).toBeNull()

    // Empty-region pan moves node's screen hit position by pan delta
    const emptyX = 20
    const emptyY = 20
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: emptyX, clientY: emptyY }))
    canvasEl.dispatchEvent(
      pointerEvent('pointermove', { clientX: emptyX + 90, clientY: emptyY - 40 })
    )
    canvasEl.dispatchEvent(
      pointerEvent('pointerup', { clientX: emptyX + 90, clientY: emptyY - 40 })
    )

    const pannedX = 400 + targetNode.x + 90
    const pannedY = 300 + targetNode.y - 40
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pannedX, clientY: pannedY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: pannedX, clientY: pannedY }))
    expect(wrapper.emitted('open-note')).toHaveLength(2)

    // Wheel zoom centered on node keeps the node directly under the cursor
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', {
        bubbles: true,
        cancelable: true,
        clientX: pannedX,
        clientY: pannedY,
        deltaY: -120,
      })
    )
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pannedX, clientY: pannedY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: pannedX, clientY: pannedY }))
    expect(wrapper.emitted('open-note')).toHaveLength(3)

    wrapper.unmount()
  })

  it('does not rebuild simulation on resize or identical topology, resets on vault switch, and cleans up on unmount', async () => {
    const removeWindowListener = vi.spyOn(window, 'removeEventListener')
    const removeDocListener = vi.spyOn(document, 'removeEventListener')

    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    expect(simulationRecords).toHaveLength(1)
    const sim1 = simulationRecords[0]
    sim1.restart.mockClear()

    // Resize updates canvas without restarting simulation
    resizeObservers[0].trigger()
    await nextTick()
    expect(simulationRecords).toHaveLength(1)
    expect(sim1.restart).not.toHaveBeenCalled()

    // Non-structural graph object copy does not restart physics
    const clonedSameStructure = {
      ...graph,
      nodes: graph.nodes.map((n) => ({ ...n })),
      edges: graph.edges.map((e) => ({ ...e })),
    }
    await wrapper.setProps({ graph: clonedSameStructure })
    expect(simulationRecords).toHaveLength(1)
    expect(sim1.restart).not.toHaveBeenCalled()

    // Adding a connected note preserves existing node positions without recreating the simulation
    sim1.tick(3)
    const historiaBefore = sim1.nodes().find((n) => n.path === 'Historia.md')
    const savedX = historiaBefore.x
    const savedY = historiaBefore.y
    const expandedIndex = buildVaultIndex({
      directory: 'C:/vaults/story',
      complete: true,
      failures: [],
      files: ['Historia.md', 'Personagens/Heroi.md', 'Lore/Heroi.md', 'Isolada.md', 'Final.md'],
      notes: [
        {
          path: 'Historia.md',
          content: 'O [[Personagens/Heroi]] enfrenta o destino em [[Lore/Heroi]] e [[Final]].',
          mtimeMs: 1200,
        },
        { path: 'Personagens/Heroi.md', content: 'Ligado a [[Historia]].', mtimeMs: 1000 },
        { path: 'Lore/Heroi.md', content: 'Registro antigo sem ligações.', mtimeMs: 1000 },
        { path: 'Isolada.md', content: 'Sem conexões.', mtimeMs: 1000 },
        { path: 'Final.md', content: 'Epílogo.', mtimeMs: 1200 },
      ],
    })
    await wrapper.setProps({ graph: buildGraphModel(expandedIndex) })
    expect(simulationRecords).toHaveLength(1)
    const historiaAfter = sim1.nodes().find((n) => n.path === 'Historia.md')
    expect(historiaAfter.x).toBe(savedX)
    expect(historiaAfter.y).toBe(savedY)
    expect(sim1.restart).toHaveBeenCalledTimes(1)

    // Vault switch stops old simulation and initializes an isolated one
    const secondGraph = buildGraphModel(
      buildVaultIndex({
        directory: 'C:/vaults/other',
        complete: true,
        failures: [],
        files: ['Another.md'],
        notes: [{ path: 'Another.md', content: '# Other', mtimeMs: 2000 }],
      })
    )
    await wrapper.setProps({
      graph: secondGraph,
      vaultDirectory: 'C:/vaults/other',
    })
    expect(sim1.stop).toHaveBeenCalledTimes(1)
    expect(simulationRecords).toHaveLength(2)
    const sim2 = simulationRecords[1]

    // Ensure a pending animation frame exists when unmounting
    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    canvasEl.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    expect(globalThis.requestAnimationFrame).toHaveBeenCalled()

    wrapper.unmount()

    expect(sim2.stop).toHaveBeenCalledTimes(1)
    expect(globalThis.cancelAnimationFrame).toHaveBeenCalled()
    expect(resizeObservers[0].disconnect).toHaveBeenCalledTimes(1)
    expect(removeWindowListener).toHaveBeenCalledWith('resize', expect.any(Function))
    expect(removeDocListener).toHaveBeenCalledWith('pointerdown', expect.any(Function))
  })

  it('keeps the canvas interactive and exposes an accessible retry notice when refresh fails with existing nodes', async () => {
    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
        loading: false,
        error: false,
      },
    })

    expect(simulationRecords).toHaveLength(1)
    const sim = simulationRecords[0]
    sim.tick(4)
    const targetNode = sim.nodes().find((n) => n.path === 'Personagens/Heroi.md')
    expect(targetNode).toBeTruthy()

    // Refresh fails while graph already has nodes: canvas stays mounted and error notice appears
    await wrapper.setProps({ error: true })
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-error-state"]').exists()).toBe(false)

    const notice = wrapper.find('[data-testid="graph-refresh-error-notice"]')
    expect(notice.exists()).toBe(true)
    expect(notice.attributes('role')).toBe('alert')

    // Graph interactions (e.g. clicking a node on canvas) stay active despite refresh error
    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    const clickX = 400 + targetNode.x
    const clickY = 300 + targetNode.y
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: clickX, clientY: clickY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: clickX, clientY: clickY }))
    expect(wrapper.emitted('open-note')).toEqual([['Personagens/Heroi.md']])

    // Clicking Try again emits retry; while retry is loading, notice remains and extra clicks do not re-emit
    await notice.find('[data-testid="graph-retry-button"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)

    await wrapper.setProps({ loading: true, error: true })
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(true)
    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(1)

    // Repeated failure keeps notice and allows trying again
    await wrapper.setProps({ loading: false, error: true })
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(true)
    await wrapper.find('[data-testid="graph-retry-button"]').trigger('click')
    expect(wrapper.emitted('retry')).toHaveLength(2)

    // Successful retry clears notice and preserves canvas & simulation
    await wrapper.setProps({ loading: false, error: false })
    expect(wrapper.find('[data-testid="graph-refresh-error-notice"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    expect(simulationRecords).toHaveLength(1)

    wrapper.unmount()
  })

  it('supports local graph mode controls, distinct empty states, and preserved center identification under restrictive filters', async () => {
    const index = buildVaultIndex({
      directory: 'C:/vaults/story',
      complete: true,
      failures: [],
      files: ['Heroi.md', 'Historia.md', 'Isolada.md'],
      notes: [
        { path: 'Heroi.md', content: 'Ligado a [[Historia]].', mtimeMs: 1000 },
        { path: 'Historia.md', content: '#lore', mtimeMs: 1000 },
        { path: 'Isolada.md', content: 'Sozinha.', mtimeMs: 1000 },
      ],
    })
    const baseGraph = buildGraphModel(index)

    // 1. No center note selected -> clear empty prompt
    const noCenterGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'local',
      centerPath: null,
    })
    const wrapper = mount(GraphView, {
      props: {
        mode: 'local',
        centerPath: null,
        graph: noCenterGraph,
        vaultDirectory: 'C:/vaults/story',
        filters: createDefaultGraphFilters(),
        localDepth: 1,
        localDirection: 'both',
      },
    })
    expect(wrapper.find('[data-testid="local-graph-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-no-center-state"]').exists()).toBe(true)

    // 2. Active center note with missing index entry -> distinct center-missing state
    const missingCenterGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'local',
      centerPath: 'NaoIndexada.md',
    })
    await wrapper.setProps({
      centerPath: 'NaoIndexada.md',
      graph: missingCenterGraph,
    })
    expect(wrapper.find('[data-testid="graph-center-missing-state"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="local-graph-center"]').text()).toContain('NaoIndexada')

    // 3. Valid center note with only-center remaining after search -> shows canvas + notice + center badge
    const onlyCenterGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'local',
      centerPath: 'Heroi.md',
      depth: 1,
      direction: 'both',
      filters: { ...createDefaultGraphFilters(), searchQuery: 'Heroi' },
    })
    await wrapper.setProps({
      centerPath: 'Heroi.md',
      graph: onlyCenterGraph,
      filters: { ...createDefaultGraphFilters(), searchQuery: 'Heroi' },
    })
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-filter-notice"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="local-graph-center"]').text()).toContain('Heroi')

    // 4. Depth & direction controls emit expected updates
    await wrapper.find('[data-testid="graph-local-depth"]').setValue('3')
    expect(wrapper.emitted('update:local-depth')).toEqual([[3]])

    await wrapper.find('[data-testid="graph-direction-outgoing"]').trigger('click')
    expect(wrapper.emitted('update:local-direction')).toEqual([['outgoing']])

    // 5. Local Graph preserves center note on no-match search with filter notice,
    // while Global Graph enters filtered-empty state with Clear filters button
    const localNoMatchGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'local',
      centerPath: 'Heroi.md',
      filters: { ...createDefaultGraphFilters(), searchQuery: 'ZZZ' },
    })
    await wrapper.setProps({
      graph: localNoMatchGraph,
      filters: { ...createDefaultGraphFilters(), searchQuery: 'ZZZ' },
    })
    expect(wrapper.find('[data-testid="graph-canvas"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-filter-notice"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="local-graph-center"]').text()).toContain('Heroi')

    const globalEmptyGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'global',
      filters: { ...createDefaultGraphFilters(), searchQuery: 'ZZZ' },
    })
    await wrapper.setProps({
      mode: 'global',
      centerPath: null,
      graph: globalEmptyGraph,
      filters: { ...createDefaultGraphFilters(), searchQuery: 'ZZZ' },
    })
    expect(wrapper.find('[data-testid="graph-filtered-empty-state"]').exists()).toBe(true)

    await wrapper.find('[data-testid="graph-clear-filters-button"]').trigger('click')
    const emittedFilters = wrapper.emitted('update:filters')
    expect(emittedFilters[emittedFilters.length - 1][0]).toEqual(createDefaultGraphFilters())

    wrapper.unmount()
  })

  it('prevents opening notes on tag or unresolved node clicks, shows origin metadata on hover, and displays search syntax errors', async () => {
    const index = buildVaultIndex({
      directory: 'C:/vaults/story',
      complete: true,
      failures: [],
      files: ['Nota.md'],
      notes: [
        { path: 'Nota.md', content: '#magia [[Falta.md]] [[Falta.markdown]]', mtimeMs: 1000 },
      ],
    })
    const baseGraph = buildGraphModel(index)
    const graphWithAllTypes = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'global',
      filters: {
        searchQuery: 'line:invalid',
        showTags: true,
        existingFilesOnly: false,
        showOrphans: true,
      },
    })

    const wrapper = mount(GraphView, {
      props: {
        graph: graphWithAllTypes,
        vaultDirectory: 'C:/vaults/story',
        filters: {
          searchQuery: 'line:invalid',
          showTags: true,
          existingFilesOnly: false,
          showOrphans: true,
        },
      },
    })

    // Toggle filters panel open & check inline query error
    await wrapper.find('[data-testid="graph-filters-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="graph-filters-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="graph-filter-search-error"]').exists()).toBe(true)

    // Toggle controls emit structured filter updates
    await wrapper.find('[data-testid="graph-filter-tags"]').setValue(false)
    const tagUpdates = wrapper.emitted('update:filters')
    expect(tagUpdates[tagUpdates.length - 1][0].showTags).toBe(false)

    // Locator search should safely exclude non-note nodes with null paths
    const locator = wrapper.find('[data-testid="graph-node-locator"]')
    await locator.setValue('a')
    const locatorItems = wrapper.findAll('[data-testid="graph-locator-item"]')
    expect(locatorItems.map((el) => el.attributes('data-note-path'))).toEqual(['Nota.md'])

    const sim = simulationRecords[0]
    sim.tick(4)
    const unresolvedNodes = sim.nodes().filter((n) => n.type === 'unresolved')
    const tagNode = sim.nodes().find((n) => n.type === 'tag')
    expect(unresolvedNodes.map((n) => n.path).sort()).toEqual(['Falta.markdown', 'Falta.md'])
    expect(tagNode).toBeTruthy()

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element

    // Hover & click each unresolved node -> shows normalized destination + origin caption, does NOT emit open-note
    const unresolvedMd = unresolvedNodes.find((n) => n.path === 'Falta.md')
    const uX = 400 + unresolvedMd.x
    const uY = 300 + unresolvedMd.y
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: uX, clientY: uY }))
    await nextTick()
    const uCaption = wrapper.find('[data-testid="graph-hover-caption"]')
    expect(uCaption.exists()).toBe(true)
    expect(uCaption.text()).toContain('Falta.md')
    expect(uCaption.text()).toContain('Nota.md')

    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: uX, clientY: uY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: uX, clientY: uY }))
    expect(wrapper.emitted('open-note')).toBeUndefined()

    const unresolvedMarkdown = unresolvedNodes.find((n) => n.path === 'Falta.markdown')
    const u2X = 400 + unresolvedMarkdown.x
    const u2Y = 300 + unresolvedMarkdown.y
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: u2X, clientY: u2Y }))
    await nextTick()
    expect(wrapper.find('[data-testid="graph-hover-caption"]').text()).toContain('Falta.markdown')

    // Hover & click tag node -> shows #magia caption, does NOT emit open-note
    const tX = 400 + tagNode.x
    const tY = 300 + tagNode.y
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: tX, clientY: tY }))
    await nextTick()
    expect(wrapper.find('[data-testid="graph-hover-caption"]').text()).toContain('#magia')

    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: tX, clientY: tY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: tX, clientY: tY }))
    expect(wrapper.emitted('open-note')).toBeUndefined()

    wrapper.unmount()
  })

  it('applies Display controls (arrows, nodeSize, linkThickness, textFadeThreshold) and Group colors without restarting D3 simulation', async () => {
    const flushFrame = (canvasEl) => {
      const ctx = canvasEl.getContext('2d')
      ctx._recorded.arcs.length = 0
      ctx._recorded.texts.length = 0
      ctx._recorded.strokes.length = 0
      ctx._recorded.fills.length = 0
      ctx._recorded.moves.length = 0
      ctx._recorded.lines.length = 0
      const callbacks = [...rafQueue.values()]
      rafQueue.clear()
      callbacks.forEach((cb) => cb())
      return {
        arcs: [...ctx._recorded.arcs],
        texts: [...ctx._recorded.texts],
        strokes: [...ctx._recorded.strokes],
        fills: [...ctx._recorded.fills],
        moves: [...ctx._recorded.moves],
        lines: [...ctx._recorded.lines],
      }
    }

    const index = buildVaultIndex({
      directory: 'C:/vaults/story',
      complete: true,
      failures: [],
      files: ['A.md', 'B.md', 'C.md'],
      notes: [
        { path: 'A.md', content: '#focus [[B]] [[C]] [[Missing]]', mtimeMs: 1000 },
        { path: 'B.md', content: '[[A]]', mtimeMs: 1000 },
        { path: 'C.md', content: 'Dest.', mtimeMs: 1000 },
      ],
    })
    const base = buildGraphModel(index)
    const graph = projectGraphView({
      baseGraph: base,
      vaultIndex: index,
      mode: 'global',
      filters: { ...createDefaultGraphFilters(), showTags: true, existingFilesOnly: false },
    })

    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
        groupColors: { 'note:A.md': '#e06c75', 'tag:#focus': '#111111' },
        display: { arrows: false, textFadeThreshold: 0.48, nodeSize: 1, linkThickness: 1 },
      },
    })

    expect(simulationRecords).toHaveLength(1)
    const sim = simulationRecords[0]
    const nA = sim.nodes().find((n) => n.id === 'note:A.md')
    const nB = sim.nodes().find((n) => n.id === 'note:B.md')
    const nC = sim.nodes().find((n) => n.id === 'note:C.md')
    nA.x = 0
    nA.y = 0
    nB.x = 120
    nB.y = 0
    nC.x = 0
    nC.y = 120
    const tagNode = sim.nodes().find((n) => n.type === 'tag')
    const unresolvedNode = sim.nodes().find((n) => n.type === 'unresolved')
    tagNode.x = -120
    tagNode.y = 0
    unresolvedNode.x = 0
    unresolvedNode.y = -120

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    const initialDraw = flushFrame(canvasEl)

    // Group color fills A.md (#e06c75), while tag node keeps #6ec49f semantic color (ignores groupColors on tags)
    expect(initialDraw.fills.some((f) => f.fillStyle === '#e06c75')).toBe(true)
    expect(initialDraw.fills.some((f) => f.fillStyle === '#6ec49f')).toBe(true)
    expect(initialDraw.fills.some((f) => f.fillStyle === '#111111')).toBe(false)

    // At scale 1 and threshold 0.48, labels render; no arrowhead polygon triangles yet
    expect(initialDraw.texts.length).toBeGreaterThan(0)
    const triangleFillsBefore = initialDraw.fills.filter((f) => f.path.some((p) => p.op === 'close'))
    expect(triangleFillsBefore).toHaveLength(0)

    // Baseline click at 15px offset from C misses at nodeSize=1 (radius ~5.2, hit ~10.2)
    const smallHitMissX = 400 + nC.x + 15
    const smallHitMissY = 300 + nC.y
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: smallHitMissX, clientY: smallHitMissY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: smallHitMissX, clientY: smallHitMissY }))
    expect(wrapper.emitted('open-note')).toBeUndefined()

    await wrapper.setProps({
      display: { arrows: true, textFadeThreshold: 1.5, nodeSize: 2.5, linkThickness: 2.4 },
    })
    await nextTick()

    // Display updates NEVER recreate forceSimulation and NEVER shift node positions
    expect(simulationRecords).toHaveLength(1)
    expect(nA.x).toBe(0)
    expect(nB.x).toBe(120)

    const updatedDraw = flushFrame(canvasEl)
    // Threshold 1.5 > current scale 1 -> labels hidden when not focused
    expect(updatedDraw.texts).toHaveLength(0)

    // Node radii scaled noticeably larger
    const maxRadiusBefore = Math.max(...initialDraw.arcs.map((a) => a.r))
    const maxRadiusAfter = Math.max(...updatedDraw.arcs.map((a) => a.r))
    expect(maxRadiusAfter).toBeGreaterThan(maxRadiusBefore * 1.8)

    // Link widths scaled cleanly
    const maxStrokeAfter = Math.max(...updatedDraw.strokes.map((s) => s.lineWidth))
    expect(maxStrokeAfter).toBeGreaterThan(2)

    // Arrows drawn for real note edges (A->B, B->A, A->C => 3 arrows), NEVER for tag or unresolved edges
    const triangleFillsAfter = updatedDraw.fills.filter((f) => f.path.some((p) => p.op === 'close'))
    expect(triangleFillsAfter).toHaveLength(3)
    expect(
      triangleFillsAfter.every((f) => f.path.every((p) => (p.x === undefined || Number.isFinite(p.x)) && (p.y === undefined || Number.isFinite(p.y))))
    ).toBe(true)

    // Enlarged node C is now clickable at offset 15px from center
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: smallHitMissX, clientY: smallHitMissY }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: smallHitMissX, clientY: smallHitMissY }))
    expect(wrapper.emitted('open-note')?.[0]).toEqual(['C.md'])

    // Coincident nodes with arrows enabled produce finite draw calls and do not throw
    nB.x = 0
    nB.y = 0
    const zeroDistDraw = flushFrame(canvasEl)
    expect(zeroDistDraw.strokes.length).toBeGreaterThan(0)

    wrapper.unmount()
  })

  it('updates live D3 forces without recreating simulation and affects physical layout predictably', async () => {
    const index = sampleIndex()
    const base = buildGraphModel(index)
    const graph = projectGraphView({ baseGraph: base, vaultIndex: index, mode: 'global' })

    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
        forces: { centerForce: 0.055, repelForce: 165, linkForce: 0.55, linkDistance: 60 },
      },
    })

    expect(simulationRecords).toHaveLength(1)
    const sim = simulationRecords[0]
    sim.stop()
    const nodeA = sim.nodes().find((n) => n.id === 'note:Historia.md')
    nodeA.x = 42
    nodeA.y = -18

    // Zoom & pan before force adjustment to verify viewport is preserved
    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    canvasEl.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, clientX: 400, clientY: 300 }))

    const restartsBefore = sim.restart.mock.calls.length
    await wrapper.setProps({
      forces: { centerForce: 0.45, repelForce: 340, linkForce: 0.9, linkDistance: 150 },
    })
    await nextTick()

    expect(simulationRecords).toHaveLength(1)
    expect(nodeA.x).toBe(42)
    expect(nodeA.y).toBe(-18)
    expect(sim.force('x').strength()()).toBeCloseTo(0.45, 5)
    expect(sim.force('y').strength()()).toBeCloseTo(0.45, 5)
    expect(sim.force('charge').strength()()).toBeCloseTo(-340, 5)
    expect(sim.force('link').strength()()).toBeCloseTo(0.9, 5)
    expect(sim.force('link').distance()()).toBeCloseTo(150, 5)
    expect(sim.restart.mock.calls.length).toBeGreaterThan(restartsBefore)

    // Physical sanity: connected distance grows when linkDistance increases over fixed simulation ticks
    const heroNode = sim.nodes().find((n) => n.id === 'note:Personagens/Heroi.md')
    nodeA.x = 0
    nodeA.y = 0
    nodeA.vx = 0
    nodeA.vy = 0
    heroNode.x = 50
    heroNode.y = 0
    heroNode.vx = 0
    heroNode.vy = 0
    sim.stop()

    await wrapper.setProps({
      forces: { centerForce: 0.02, repelForce: 120, linkForce: 0.9, linkDistance: 40 },
    })
    await nextTick()
    sim.stop()
    sim.tick(40)
    const closeDistance = Math.hypot(heroNode.x - nodeA.x, heroNode.y - nodeA.y)

    await wrapper.setProps({
      forces: { centerForce: 0.02, repelForce: 120, linkForce: 0.9, linkDistance: 180 },
    })
    await nextTick()
    sim.stop()
    sim.tick(40)
    const farDistance = Math.hypot(heroNode.x - nodeA.x, heroNode.y - nodeA.y)
    expect(farDistance).toBeGreaterThan(closeDistance)

    wrapper.unmount()
  })

  it('exposes Groups, Display, Forces, and Restore default settings controls and emits clean updates', async () => {
    const index = sampleIndex()
    const base = buildGraphModel(index)
    const graph = projectGraphView({ baseGraph: base, vaultIndex: index, mode: 'global' })

    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
        groups: [{ id: 'g1', query: 'path:', color: '#e06c75' }],
        groupErrors: { g1: 'Operator "path:" requires a value.' },
      },
    })

    await wrapper.find('[data-testid="graph-filters-toggle"]').trigger('click')
    expect(wrapper.find('[data-testid="graph-filters-panel"]').exists()).toBe(true)

    // Expand Groups section -> displays existing group query, error, add/move/remove buttons
    await wrapper.find('[data-testid="graph-section-groups"]').trigger('click')
    expect(wrapper.find('[data-testid="graph-group-error-g1"]').text()).toContain('path:')
    await wrapper.find('[data-testid="graph-group-add"]').trigger('click')
    expect(wrapper.emitted('update:groups')?.[0]?.[0]).toHaveLength(2)

    await wrapper.find('[data-testid="graph-group-query-g1"]').setValue('tag:#lore')
    const queryUpdate = wrapper.emitted('update:groups').at(-1)[0]
    expect(queryUpdate[0].query).toBe('tag:#lore')

    await wrapper.find('[data-testid="graph-group-color-g1"]').setValue('#98c379')
    expect(wrapper.emitted('update:groups').at(-1)[0][0].color).toBe('#98c379')

    await wrapper.find('[data-testid="graph-group-remove-g1"]').trigger('click')
    expect(wrapper.emitted('update:groups').at(-1)[0]).toEqual([])

    // Expand Display section & toggle Arrows
    await wrapper.find('[data-testid="graph-section-display"]').trigger('click')
    await wrapper.find('[data-testid="graph-display-arrows"]').setValue(true)
    expect(wrapper.emitted('update:display').at(-1)[0].arrows).toBe(true)

    // Expand Forces section & adjust Repel force
    await wrapper.find('[data-testid="graph-section-forces"]').trigger('click')
    await wrapper.find('[data-testid="graph-force-repel"]').setValue('280')
    expect(wrapper.emitted('update:forces').at(-1)[0].repelForce).toBe(280)

    // Restore default settings emits clean action
    await wrapper.find('[data-testid="graph-restore-defaults"]').trigger('click')
    expect(wrapper.emitted('restore-defaults')).toHaveLength(1)

    wrapper.unmount()
  })

  it('preserves initial drag contact offset without jumping, ignores foreign pointers, and cleans up on cancel/blur', async () => {
    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const sim = simulationRecords[0]
    sim.stop()
    const targetNode = sim.nodes().find((n) => n.path === 'Personagens/Heroi.md')
    targetNode.x = 100
    targetNode.y = 50
    targetNode.vx = 0
    targetNode.vy = 0

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    // Canvas center is (400, 300), scale 1 -> node center at (500, 350).
    // Press 6px right & 4px down from node center (edge hit within hitRadius ~10.6px).
    const pressX = 506
    const pressY = 354

    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pressX, clientY: pressY, pointerId: 1 }))
    // Pressing node perimeter MUST NOT jump node.x/y or immediately lock fx/fy to cursor center!
    expect(targetNode.x).toBe(100)
    expect(targetNode.y).toBe(50)
    expect(targetNode.fx).toBeFalsy()
    expect(targetNode.fy).toBeFalsy()

    // Foreign pointer events MUST NOT hijack or terminate the active gesture
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 20, clientY: 20, pointerId: 2 }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: 20, clientY: 20, pointerId: 2 }))
    expect(targetNode.x).toBe(100)
    expect(wrapper.emitted('open-note')).toBeUndefined()

    // First drag move past 4px threshold preserves initial (x - wx = -6, y - wy = -4) contact offset!
    canvasEl.dispatchEvent(
      pointerEvent('pointermove', { clientX: pressX + 20, clientY: pressY + 10, pointerId: 1 })
    )
    expect(targetNode.fx).toBeCloseTo(120, 5)
    expect(targetNode.fy).toBeCloseTo(60, 5)

    // Interruption via window blur releases fx/fy and stops alphaTarget heating without emitting open-note
    window.dispatchEvent(new Event('blur'))
    expect(targetNode.fx).toBeNull()
    expect(targetNode.fy).toBeNull()
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
    expect(wrapper.emitted('open-note')).toBeUndefined()

    // pointercancel also cleans up active drag safely without opening the note (grabbing node at its updated 120,60 position)
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pressX + 20, clientY: pressY + 10, pointerId: 3 }))
    canvasEl.dispatchEvent(
      pointerEvent('pointermove', { clientX: pressX + 35, clientY: pressY + 10, pointerId: 3 })
    )
    expect(targetNode.fx).toBeCloseTo(135, 5)
    canvasEl.dispatchEvent(
      pointerEvent('pointercancel', { clientX: pressX + 35, clientY: pressY + 10, pointerId: 3 })
    )
    expect(targetNode.fx).toBeNull()
    expect(targetNode.fy).toBeNull()
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
    expect(wrapper.emitted('open-note')).toBeUndefined()

    wrapper.unmount()
  })

  it('smoothly interpolates wheel zoom with single rAF loop, keeps cursor point anchored, clamps bounds, and cancels on vault switch/unmount/reduced-motion', async () => {
    const stepNextRaf = (canvasEl, timestamp) => {
      const entries = [...rafQueue.entries()]
      expect(entries.length).toBeLessThanOrEqual(1)
      if (entries.length === 0) return null
      const [id, cb] = entries[0]
      rafQueue.delete(id)
      const ctx = canvasEl.getContext('2d')
      ctx._recorded.arcs.length = 0
      cb(timestamp)
      return { arcs: [...ctx._recorded.arcs] }
    }

    const index = sampleIndex()
    const graph = buildGraphModel(index)
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const sim = simulationRecords[0]
    sim.stop()
    const nHeroi = sim.nodes().find((n) => n.id === 'note:Personagens/Heroi.md')
    const nIsolada = sim.nodes().find((n) => n.id === 'note:Isolada.md')
    nHeroi.x = 40
    nHeroi.y = 20
    nIsolada.x = -60
    nIsolada.y = 20

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    // Flush initial mount frame so rAF queue is clear
    stepNextRaf(canvasEl, 1000)

    const anchorSx = 400 + nHeroi.x // 440
    const anchorSy = 300 + nHeroi.y // 320

    // Two rapid consecutive wheel events share one target and queue at most ONE rAF loop
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: anchorSx, clientY: anchorSy, deltaY: -120 })
    )
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: anchorSx, clientY: anchorSy, deltaY: -120 })
    )
    expect(rafQueue.size).toBe(1)

    // Frame 1 advances progressively (intermediate scale, NOT jumped straight to final)
    const frame1 = stepNextRaf(canvasEl, 1016)
    const measureScale = (frame) => {
      const sorted = [...frame.arcs].sort((a, b) => a.x - b.x)
      const left = sorted[0]
      const right = sorted[sorted.length - 1]
      return Math.hypot(right.x - left.x, right.y - left.y)
    }

    // Check anchored node stays right at (anchorSx, anchorSy) during animation AND scale grows progressively
    const findArcNear = (frame, x, y) =>
      frame.arcs.reduce((best, cur) =>
        !best || Math.hypot(cur.x - x, cur.y - y) < Math.hypot(best.x - x, best.y - y) ? cur : best
      , null)

    const anchoredFrame1 = findArcNear(frame1, anchorSx, anchorSy)
    expect(Math.hypot(anchoredFrame1.x - anchorSx, anchoredFrame1.y - anchorSy)).toBeLessThan(0.5)

    // Advance controlled frames (~16ms each) -> progresses smoothly, converges, then stops scheduling rAF!
    let prevWidth = measureScale(frame1)
    let latestFrame = frame1
    let safety = 0
    while (rafQueue.size > 0 && safety < 80) {
      safety += 1
      latestFrame = stepNextRaf(canvasEl, 1016 + safety * 16)
      const anchored = findArcNear(latestFrame, anchorSx, anchorSy)
      expect(Math.hypot(anchored.x - anchorSx, anchored.y - anchorSy)).toBeLessThan(0.5)
    }
    expect(safety).toBeGreaterThan(2)
    expect(safety).toBeLessThan(80)
    expect(rafQueue.size).toBe(0)
    expect(measureScale(latestFrame)).toBeGreaterThan(prevWidth)

    // Bounds clamping: huge zoom-in does not overshoot MAX_SCALE=6 or produce NaN
    for (let i = 0; i < 30; i += 1) {
      canvasEl.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: anchorSx, clientY: anchorSy, deltaY: -240 })
      )
    }
    expect(rafQueue.size).toBe(1)
    let clampedSteps = 0
    while (rafQueue.size > 0 && clampedSteps < 100) {
      clampedSteps += 1
      latestFrame = stepNextRaf(canvasEl, 3000 + clampedSteps * 16)
    }
    const maxSpan = measureScale(latestFrame)
    expect(Number.isFinite(maxSpan)).toBe(true)
    // World x separation between Isolada (-60) and Heroi (40) = 100 -> clamped at MAX_SCALE=6 => <= 600px (with other nodes inside)
    expect(maxSpan).toBeLessThanOrEqual(600.1)

    // Vault switch cancels pending zoom animation immediately; flushing the new vault's single initial draw leaves zero animation loops
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: anchorSx, clientY: anchorSy, deltaY: 120 })
    )
    expect(rafQueue.size).toBe(1)
    const cancelCallsBeforeSwitch = globalThis.cancelAnimationFrame.mock.calls.length
    await wrapper.setProps({ vaultDirectory: 'C:/vaults/other' })
    await nextTick()
    expect(globalThis.cancelAnimationFrame.mock.calls.length).toBeGreaterThan(cancelCallsBeforeSwitch)
    stepNextRaf(canvasEl, 4000)
    expect(rafQueue.size).toBe(0)

    // prefers-reduced-motion: reduce applies zoom immediately without queuing a multi-frame animation loop
    const origMatchMedia = window.matchMedia
    window.matchMedia = vi.fn().mockImplementation((query) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }))
    try {
      canvasEl.dispatchEvent(
        new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -120 })
      )
      // At most 1 draw rAF queued, and running it once leaves queue empty (zero iterative loop!)
      const reduceFrame = stepNextRaf(canvasEl, 5000)
      expect(reduceFrame).not.toBeNull()
      expect(rafQueue.size).toBe(0)
    } finally {
      window.matchMedia = origMatchMedia
    }

    // Unmount cancels any active wheel zoom loop immediately
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -120 })
    )
    expect(rafQueue.size).toBe(1)
    wrapper.unmount()
    expect(rafQueue.size).toBe(0)
  })

  it('updates and commits fast node drag immediately without waiting for a tick, keeps moving-node offset stable, and cleans up on hide/unmount', async () => {
    const stepNextRaf = (canvasEl, timestamp) => {
      const entries = [...rafQueue.entries()]
      expect(entries.length).toBeLessThanOrEqual(1)
      if (entries.length === 0) return null
      const [id, cb] = entries[0]
      rafQueue.delete(id)
      const ctx = canvasEl.getContext('2d')
      ctx._recorded.arcs.length = 0
      cb(timestamp)
      return [...ctx._recorded.arcs]
    }
    const closestArc = (arcs, x, y) =>
      arcs.reduce((best, cur) =>
        !best || Math.hypot(cur.x - x, cur.y - y) < Math.hypot(best.x - x, best.y - y) ? cur : best
      , null)

    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const sim = simulationRecords[0]
    sim.stop()
    const targetNode = sim.nodes().find((n) => n.path === 'Personagens/Heroi.md')
    const nHistoria = sim.nodes().find((n) => n.path === 'Historia.md')
    const nLore = sim.nodes().find((n) => n.path === 'Lore/Heroi.md')
    const nIsolada = sim.nodes().find((n) => n.path === 'Isolada.md')
    targetNode.x = 100
    targetNode.y = 50
    targetNode.vx = 0
    targetNode.vy = 0
    nHistoria.x = -200
    nHistoria.y = -150
    nLore.x = -200
    nLore.y = 150
    nIsolada.x = 250
    nIsolada.y = -150

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    stepNextRaf(canvasEl, 1000)

    // A2: Sub-threshold click (< 4px) emits open-note and leaves node position and fx/fy untouched
    const pressX = 506
    const pressY = 354
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pressX, clientY: pressY, pointerId: 1 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: pressX + 2, clientY: pressY + 1, pointerId: 1 }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: pressX + 2, clientY: pressY + 1, pointerId: 1 }))
    expect(targetNode.x).toBe(100)
    expect(targetNode.y).toBe(50)
    expect(targetNode.fx).toBeNull()
    expect(targetNode.fy).toBeNull()
    expect(wrapper.emitted('open-note')).toEqual([['Personagens/Heroi.md']])
    const postClickArcs = stepNextRaf(canvasEl, 1010)
    const unmovedArc = closestArc(postClickArcs, 500, 350)
    expect(unmovedArc.x).toBeCloseTo(500, 5)
    expect(unmovedArc.y).toBeCloseTo(350, 5)

    // A1: Fast drag + pointerup without ANY D3 sim.tick() renders displacement immediately and retains it after release
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pressX, clientY: pressY, pointerId: 2 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: pressX + 45, clientY: pressY - 25, pointerId: 2 }))

    const midDragArcs = stepNextRaf(canvasEl, 1026)
    const movedMidArc = closestArc(midDragArcs, 545, 325)
    expect(movedMidArc.x).toBeCloseTo(545, 5)
    expect(movedMidArc.y).toBeCloseTo(325, 5)

    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: pressX + 45, clientY: pressY - 25, pointerId: 2 }))
    expect(targetNode.fx).toBeNull()
    expect(targetNode.fy).toBeNull()
    expect(targetNode.x).toBeCloseTo(145, 5)
    expect(targetNode.y).toBeCloseTo(25, 5)
    expect(targetNode.vx).toBe(0)
    expect(targetNode.vy).toBe(0)
    expect(wrapper.emitted('open-note')).toHaveLength(1)

    const postReleaseArcs = stepNextRaf(canvasEl, 1042)
    const retainedArc = closestArc(postReleaseArcs, 545, 325)
    expect(retainedArc.x).toBeCloseTo(545, 5)
    expect(retainedArc.y).toBeCloseTo(325, 5)

    // A3: Moving-node drag clears residual velocity, preserves contact offset without jump across ticks, and keeps final drop
    targetNode.x = 60
    targetNode.y = -20
    targetNode.vx = 12
    targetNode.vy = -8
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: 464, clientY: 283, pointerId: 3 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 488, clientY: 295, pointerId: 3 }))
    expect(targetNode.x).toBeCloseTo(84, 5)
    expect(targetNode.y).toBeCloseTo(-8, 5)
    expect(targetNode.fx).toBeCloseTo(84, 5)
    expect(targetNode.fy).toBeCloseTo(-8, 5)
    expect(targetNode.vx).toBe(0)
    expect(targetNode.vy).toBe(0)

    sim.tick(1)
    expect(targetNode.x).toBeCloseTo(84, 5)
    expect(targetNode.y).toBeCloseTo(-8, 5)

    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 504, clientY: 285, pointerId: 3 }))
    sim.tick(1)
    expect(targetNode.x).toBeCloseTo(100, 5)
    expect(targetNode.y).toBeCloseTo(-18, 5)

    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 514, clientY: 275, pointerId: 3 }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: 514, clientY: 275, pointerId: 3 }))
    expect(targetNode.fx).toBeNull()
    expect(targetNode.fy).toBeNull()
    expect(targetNode.x).toBeCloseTo(110, 5)
    expect(targetNode.y).toBeCloseTo(-28, 5)

    // A4: document visibilitychange (hidden) and unmount release pinned drag cleanly
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: 510, clientY: 272, pointerId: 4 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 530, clientY: 272, pointerId: 4 }))
    expect(targetNode.fx).toBeCloseTo(130, 5)

    const origVisDesc = Object.getOwnPropertyDescriptor(document, 'visibilityState')
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
    try {
      document.dispatchEvent(new Event('visibilitychange'))
      expect(targetNode.fx).toBeNull()
      expect(targetNode.fy).toBeNull()
      expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
    } finally {
      if (origVisDesc) {
        Object.defineProperty(document, 'visibilityState', origVisDesc)
      } else {
        delete document.visibilityState
      }
    }

    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: 530, clientY: 272, pointerId: 5 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 550, clientY: 272, pointerId: 5 }))
    expect(targetNode.fx).toBeCloseTo(150, 5)
    wrapper.unmount()
    for (const node of sim.nodes()) {
      expect(node.fx).toBeNull()
      expect(node.fy).toBeNull()
    }
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
  })

  it('interrupts active wheel zoom animation immediately on node pointerdown, keeps cursor offset exact, and still resumes normal wheel zoom later', () => {
    const stepNextRaf = (canvasEl, timestamp) => {
      const entries = [...rafQueue.entries()]
      expect(entries.length).toBeLessThanOrEqual(1)
      if (entries.length === 0) return null
      const [id, cb] = entries[0]
      rafQueue.delete(id)
      const ctx = canvasEl.getContext('2d')
      ctx._recorded.arcs.length = 0
      cb(timestamp)
      return [...ctx._recorded.arcs]
    }
    const closestArc = (arcs, x, y) =>
      arcs.reduce((best, cur) =>
        !best || Math.hypot(cur.x - x, cur.y - y) < Math.hypot(best.x - x, best.y - y) ? cur : best
      , null)
    const horizontalSpan = (arcs) => {
      const sorted = [...arcs].sort((a, b) => a.x - b.x)
      return Math.hypot(sorted[sorted.length - 1].x - sorted[0].x, sorted[sorted.length - 1].y - sorted[0].y)
    }

    const graph = buildGraphModel(sampleIndex())
    const wrapper = mount(GraphView, {
      props: {
        graph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const sim = simulationRecords[0]
    sim.stop()
    const nHeroi = sim.nodes().find((n) => n.id === 'note:Personagens/Heroi.md')
    const nIsolada = sim.nodes().find((n) => n.id === 'note:Isolada.md')
    const nHistoria = sim.nodes().find((n) => n.id === 'note:Historia.md')
    const nLore = sim.nodes().find((n) => n.id === 'note:Lore/Heroi.md')
    nHeroi.x = 40
    nHeroi.y = 20
    nIsolada.x = -60
    nIsolada.y = 20
    nHistoria.x = 0
    nHistoria.y = -40
    nLore.x = 0
    nLore.y = 80

    const canvasEl = wrapper.find('[data-testid="graph-canvas"]').element
    stepNextRaf(canvasEl, 1000)

    // Start smooth zoom-in animation and advance one partial frame (animation still active in rafQueue)
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 440, clientY: 320, deltaY: -240 })
    )
    expect(rafQueue.size).toBe(1)
    const frame1 = stepNextRaf(canvasEl, 1016)
    const spanAtInterrupt = horizontalSpan(frame1)
    expect(spanAtInterrupt).toBeGreaterThan(100)
    expect(rafQueue.size).toBe(1)

    // Grab nHeroi mid-zoom with (+3, +2) perimeter offset
    const heroiAtInterrupt = closestArc(frame1, 440, 320)
    const isoladaAtInterrupt = closestArc(frame1, 300, 320)
    const pressX = heroiAtInterrupt.x + 3
    const pressY = heroiAtInterrupt.y + 2

    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: pressX, clientY: pressY, pointerId: 7 }))
    // Any pending draw after pointerdown must NOT continue zooming or leave camera rAF loop queued
    const frameAfterDown = stepNextRaf(canvasEl, 1032)
    expect(rafQueue.size).toBe(0)
    if (frameAfterDown) {
      expect(horizontalSpan(frameAfterDown)).toBeCloseTo(spanAtInterrupt, 5)
    }

    // Drag across later timestamps: background node and scale stay frozen while nHeroi tracks exact (+40, -20)
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: pressX + 40, clientY: pressY - 20, pointerId: 7 }))
    const dragFrame = stepNextRaf(canvasEl, 1048)
    expect(rafQueue.size).toBe(0)

    const isoladaAfterDrag = closestArc(dragFrame, isoladaAtInterrupt.x, isoladaAtInterrupt.y)
    expect(isoladaAfterDrag.x).toBeCloseTo(isoladaAtInterrupt.x, 5)
    expect(isoladaAfterDrag.y).toBeCloseTo(isoladaAtInterrupt.y, 5)

    const heroiAfterDrag = closestArc(dragFrame, heroiAtInterrupt.x + 40, heroiAtInterrupt.y - 20)
    expect(heroiAfterDrag.x).toBeCloseTo(heroiAtInterrupt.x + 40, 4)
    expect(heroiAfterDrag.y).toBeCloseTo(heroiAtInterrupt.y - 20, 4)

    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: pressX + 40, clientY: pressY - 20, pointerId: 7 }))
    expect(nHeroi.fx).toBeNull()
    expect(nHeroi.fy).toBeNull()
    const finalFrame = stepNextRaf(canvasEl, 1064)
    const heroiFinal = closestArc(finalFrame, heroiAtInterrupt.x + 40, heroiAtInterrupt.y - 20)
    expect(heroiFinal.x).toBeCloseTo(heroiAtInterrupt.x + 40, 4)
    expect(heroiFinal.y).toBeCloseTo(heroiAtInterrupt.y - 20, 4)

    // Subsequent wheel zoom still works smoothly after interrupted drag
    canvasEl.dispatchEvent(
      new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: 400, clientY: 300, deltaY: -120 })
    )
    expect(rafQueue.size).toBe(1)
    const zoomResume1 = stepNextRaf(canvasEl, 2000)
    expect(zoomResume1).not.toBeNull()
    expect(rafQueue.size).toBe(1)

    wrapper.unmount()
    expect(rafQueue.size).toBe(0)
  })

  it('cools simulation back to rest and clears drag state when a dragged node is removed by structural/filter update before pointerup/pointercancel', async () => {
    const flushRaf = (timestamp = 1000) => {
      let guard = 0
      while (rafQueue.size > 0 && guard < 20) {
        guard += 1
        const [id, cb] = rafQueue.entries().next().value
        rafQueue.delete(id)
        cb(timestamp + guard * 16)
      }
    }

    const index = sampleIndex()
    const baseGraph = buildGraphModel(index)
    const initialGraph = projectGraphView({ baseGraph, vaultIndex: index, mode: 'global' })

    const wrapper = mount(GraphView, {
      props: {
        graph: initialGraph,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const sim = simulationRecords[0]
    sim.stop()
    const nHeroi = sim.nodes().find((n) => n.path === 'Personagens/Heroi.md')
    const nHistoria = sim.nodes().find((n) => n.path === 'Historia.md')
    const nLore = sim.nodes().find((n) => n.path === 'Lore/Heroi.md')
    const nIsolada = sim.nodes().find((n) => n.path === 'Isolada.md')
    nHeroi.x = 100
    nHeroi.y = 40
    nHistoria.x = -80
    nHistoria.y = -40
    nLore.x = 0
    nLore.y = 120
    nIsolada.x = -120
    nIsolada.y = 80
    flushRaf(1000)

    const canvas = wrapper.find('[data-testid="graph-canvas"]')
    const canvasEl = canvas.element

    // 1-3: Start dragging Isolada.md (orphan) and confirm simulation entered heated drag mode
    const isoladaSx = 400 + nIsolada.x
    const isoladaSy = 300 + nIsolada.y
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: isoladaSx, clientY: isoladaSy, pointerId: 1 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: isoladaSx + 24, clientY: isoladaSy + 12, pointerId: 1 }))
    await nextTick()
    expect(sim.alphaTarget()).toBeCloseTo(0.28, 5)
    expect(canvas.classes()).toContain('graph-canvas--grabbing')

    // 4: Structural filter update (showOrphans: false) removes Isolada.md while keeping 3 connected nodes
    const filtersNoOrphans = {
      ...createDefaultGraphFilters(),
      showOrphans: false,
    }
    const filteredGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'global',
      filters: filtersNoOrphans,
    })
    expect(filteredGraph.nodes.some((n) => n.path === 'Isolada.md')).toBe(false)
    expect(filteredGraph.nodes.length).toBeGreaterThanOrEqual(2)

    await wrapper.setProps({
      graph: filteredGraph,
      filters: filtersNoOrphans,
    })
    await nextTick()

    // Removal itself cancels the active drag immediately even before pointerup arrives
    expect(sim.alphaTarget()).toBe(0)
    expect(canvas.classes()).not.toContain('graph-canvas--grabbing')

    // Delayed pointermove from old pointerId before pointerup must not throw or corrupt surviving nodes
    const historiaBeforeX = sim.nodes().find((n) => n.path === 'Historia.md').x
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: isoladaSx + 48, clientY: isoladaSy + 20, pointerId: 1 }))

    // 5-6: Delayed pointerup (+ duplicate pointerup) arrives after dragged node disappeared
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: isoladaSx + 48, clientY: isoladaSy + 20, pointerId: 1 }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: isoladaSx + 48, clientY: isoladaSy + 20, pointerId: 1 }))
    await nextTick()

    expect(sim.alphaTarget()).toBe(0)
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
    expect(canvas.classes()).not.toContain('graph-canvas--grabbing')
    expect(wrapper.emitted('open-note')).toBeUndefined()
    for (const node of sim.nodes()) {
      expect(node.fx).toBeNull()
      expect(node.fy).toBeNull()
    }
    expect(sim.nodes().find((n) => n.path === 'Historia.md').x).toBe(historiaBeforeX)

    // 7: Advancing D3 simulation lets alpha decay cleanly below alphaMin back to rest without residual frames
    sim.tick(350)
    expect(sim.alpha()).toBeLessThan(sim.alphaMin())
    flushRaf(2000)
    expect(rafQueue.size).toBe(0)

    // Can start and finish a brand-new drag on a remaining node after structural interruption
    const survivingHistoria = sim.nodes().find((n) => n.path === 'Historia.md')
    survivingHistoria.x = -60
    survivingHistoria.y = -30
    const histSx = 400 + survivingHistoria.x
    const histSy = 300 + survivingHistoria.y
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: histSx, clientY: histSy, pointerId: 2 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: histSx + 30, clientY: histSy - 15, pointerId: 2 }))
    expect(sim.alphaTarget()).toBeCloseTo(0.28, 5)
    expect(survivingHistoria.x).toBeCloseTo(-30, 5)
    expect(survivingHistoria.y).toBeCloseTo(-45, 5)

    // Removal of this dragged node via search filter followed by pointercancel must also cool down cleanly
    const searchFilters = { ...createDefaultGraphFilters(), searchQuery: 'Heroi' }
    const heroiOnlyGraph = projectGraphView({
      baseGraph,
      vaultIndex: index,
      mode: 'global',
      filters: searchFilters,
    })
    expect(heroiOnlyGraph.nodes.some((n) => n.path === 'Historia.md')).toBe(false)
    expect(heroiOnlyGraph.nodes.length).toBeGreaterThanOrEqual(2)

    await wrapper.setProps({ graph: heroiOnlyGraph, filters: searchFilters })
    await nextTick()
    canvasEl.dispatchEvent(pointerEvent('pointercancel', { clientX: histSx + 30, clientY: histSy - 15, pointerId: 2 }))
    canvasEl.dispatchEvent(pointerEvent('pointercancel', { clientX: histSx + 30, clientY: histSy - 15, pointerId: 2 }))
    await nextTick()

    expect(sim.alphaTarget()).toBe(0)
    expect(sim.alphaTarget).toHaveBeenLastCalledWith(0)
    for (const node of sim.nodes()) {
      expect(node.fx).toBeNull()
      expect(node.fy).toBeNull()
    }
    sim.tick(350)
    expect(sim.alpha()).toBeLessThan(sim.alphaMin())
    flushRaf(3000)
    expect(rafQueue.size).toBe(0)

    wrapper.unmount()
  })

  it('ignores stale pointer events cleanly when switching vaults mid-drag without leaking alphaTarget or affecting new graph nodes', async () => {
    const indexA = sampleIndex()
    const graphA = projectGraphView({ baseGraph: buildGraphModel(indexA), vaultIndex: indexA, mode: 'global' })

    const indexB = buildVaultIndex({
      directory: 'C:/vaults/other',
      complete: true,
      failures: [],
      files: ['Alpha.md', 'Beta.md'],
      notes: [
        { path: 'Alpha.md', content: 'Links [[Beta]].', mtimeMs: 2000 },
        { path: 'Beta.md', content: 'Leaf.', mtimeMs: 2000 },
      ],
    })
    const graphB = projectGraphView({ baseGraph: buildGraphModel(indexB), vaultIndex: indexB, mode: 'global' })

    const wrapper = mount(GraphView, {
      props: {
        graph: graphA,
        vaultDirectory: 'C:/vaults/story',
      },
    })

    const simA = simulationRecords[0]
    simA.stop()
    const nHeroiA = simA.nodes().find((n) => n.path === 'Personagens/Heroi.md')
    nHeroiA.x = 20
    nHeroiA.y = 10

    const canvas = wrapper.find('[data-testid="graph-canvas"]')
    const canvasEl = canvas.element

    // Start active drag on Vault A
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: 420, clientY: 310, pointerId: 11 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 450, clientY: 330, pointerId: 11 }))
    await nextTick()
    expect(simA.alphaTarget()).toBeCloseTo(0.28, 5)
    expect(canvas.classes()).toContain('graph-canvas--grabbing')

    // Switch to Vault B while pointer is still down
    await wrapper.setProps({
      graph: graphB,
      vaultDirectory: 'C:/vaults/other',
    })
    await nextTick()

    expect(simA.alphaTarget()).toBe(0)
    expect(simA.stop).toHaveBeenCalled()
    expect(canvas.classes()).not.toContain('graph-canvas--grabbing')

    const simB = simulationRecords[1]
    expect(simB).toBeDefined()
    simB.stop()
    const alphaB = simB.nodes().find((n) => n.path === 'Alpha.md')
    alphaB.x = 50
    alphaB.y = 30
    const alphaBeforeX = alphaB.x
    const alphaBeforeY = alphaB.y

    // Stale pointer events from pointerId=11 (right over Alpha.md coords) must NOT drag or open Alpha.md
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 450, clientY: 330, pointerId: 11 }))
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: 450, clientY: 330, pointerId: 11 }))
    await nextTick()

    expect(simB.alphaTarget()).toBe(0)
    expect(alphaB.x).toBe(alphaBeforeX)
    expect(alphaB.y).toBe(alphaBeforeY)
    expect(alphaB.fx).toBeNull()
    expect(alphaB.fy).toBeNull()
    expect(wrapper.emitted('open-note')).toBeUndefined()

    // New interaction with fresh pointerId on Vault B works normally
    canvasEl.dispatchEvent(pointerEvent('pointerdown', { clientX: 450, clientY: 330, pointerId: 12 }))
    canvasEl.dispatchEvent(pointerEvent('pointermove', { clientX: 480, clientY: 345, pointerId: 12 }))
    expect(simB.alphaTarget()).toBeCloseTo(0.28, 5)
    expect(alphaB.x).toBeCloseTo(80, 5)
    expect(alphaB.y).toBeCloseTo(45, 5)
    canvasEl.dispatchEvent(pointerEvent('pointerup', { clientX: 480, clientY: 345, pointerId: 12 }))
    expect(simB.alphaTarget()).toBe(0)
    expect(alphaB.fx).toBeNull()
    expect(alphaB.fy).toBeNull()

    wrapper.unmount()
  })
})
