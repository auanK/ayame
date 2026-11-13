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
})
