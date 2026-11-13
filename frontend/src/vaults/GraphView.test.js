import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { buildVaultIndex } from './vaultIndex.js'
import { buildGraphModel } from './graphModel.js'

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
})
