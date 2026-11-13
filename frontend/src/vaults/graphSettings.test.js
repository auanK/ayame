import { describe, it, expect, beforeEach, vi } from 'vitest'
import { forceSimulation, forceLink, forceManyBody, forceCenter, forceX, forceY } from 'd3-force'
import {
  GRAPH_SETTINGS_VERSION,
  GRAPH_DISPLAY_LIMITS,
  GRAPH_FORCE_LIMITS,
  createDefaultGraphSettings,
  getGraphSettingsStorageKey,
  normalizeGraphSettings,
  loadGraphSettings,
  saveGraphSettings,
  updateGraphViewSettings,
  addColorGroup,
  updateColorGroup,
  removeColorGroup,
  moveColorGroup,
  resetGraphViewSettings,
  resetGraphGroups,
  evaluateGraphGroups,
  resolveLabelOpacity,
  computeArrowGeometry,
  applySimulationForces,
} from './graphSettings.js'

const sampleNodes = [
  { id: 'note:Projects/Alpha.md', type: 'note', path: 'Projects/Alpha.md', label: 'Alpha', degree: 3 },
  { id: 'note:Projects/Sub/Beta.md', type: 'note', path: 'Projects/Sub/Beta.md', label: 'Beta', degree: 1 },
  { id: 'note:Notes/Reading.md', type: 'note', path: 'Notes/Reading.md', label: 'Reading', degree: 2 },
  { id: 'note:Daily/PlainTagMention.md', type: 'note', path: 'Daily/PlainTagMention.md', label: '#project note' },
  { id: 'tag:#project', type: 'tag', path: null, label: '#project', degree: 1 },
  { id: 'unresolved:future.md', type: 'unresolved', path: 'Future.md', label: 'Future', degree: 1 },
]

const sampleTagsByFile = {
  'Projects/Alpha.md': ['project/active'],
  'Projects/Sub/Beta.md': ['project'],
  'Notes/Reading.md': ['book', 'literature'],
  'Daily/PlainTagMention.md': [],
}

describe('graphSettings — defaults, validation & persistence', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('produces versioned default global graph settings without legacy local schema', () => {
    const defaults = createDefaultGraphSettings()
    expect(defaults.version).toBe(GRAPH_SETTINGS_VERSION)
    expect(defaults.groups).toEqual([])
    expect(defaults.local).toBeUndefined()
    expect(defaults.global.filters).toEqual({
      searchQuery: '',
      showTags: false,
      existingFilesOnly: true,
      showOrphans: true,
    })
    expect(defaults.global.display).toEqual({
      arrows: false,
      textFadeThreshold: 0.48,
      nodeSize: 1,
      linkThickness: 1,
    })
    expect(defaults.global.forces).toEqual({
      centerForce: 0.055,
      repelForce: 165,
      linkForce: 0.55,
      linkDistance: 60,
    })
  })

  it('derives stable storage key per vault directory', () => {
    expect(getGraphSettingsStorageKey('work/my-vault')).toBe('ayame:graph-settings:work/my-vault')
    expect(getGraphSettingsStorageKey('')).toBeNull()
    expect(getGraphSettingsStorageKey(null)).toBeNull()
  })

  it('persists and restores complete global settings per vault and safely drops legacy local preferences fail-closed', () => {
    let settings = createDefaultGraphSettings()
    settings = addColorGroup(settings, { id: 'g1', query: 'path:Projects', color: '#e06c75' })
    settings = updateGraphViewSettings(settings, {
      display: { arrows: true, nodeSize: 1.8, textFadeThreshold: 0.9, linkThickness: 1.6 },
      forces: { centerForce: 0.25, repelForce: 300, linkForce: 0.8, linkDistance: 120 },
      filters: { showTags: true, showOrphans: false },
    })

    const saved = saveGraphSettings('vault-a', settings)
    expect(saved.ok).toBe(true)

    const loaded = loadGraphSettings('vault-a')
    expect(loaded.error).toBeNull()
    expect(loaded.settings.groups).toEqual([{ id: 'g1', query: 'path:Projects', color: '#e06c75' }])
    expect(loaded.settings.global.display.arrows).toBe(true)
    expect(loaded.settings.global.display.nodeSize).toBe(1.8)
    expect(loaded.settings.global.forces.repelForce).toBe(300)
    expect(loaded.settings.local).toBeUndefined()

    // Legacy vault data with persisted "local" block loads valid global/groups cleanly and strips legacy local data
    localStorage.setItem(
      'ayame:graph-settings:vault-legacy',
      JSON.stringify({
        version: 1,
        groups: [{ id: 'lg-1', query: 'tag:#keep', color: '#98c379' }],
        global: {
          filters: { searchQuery: 'Keep', showTags: true, existingFilesOnly: false, showOrphans: false },
          display: { arrows: true, textFadeThreshold: 0.8, nodeSize: 1.4, linkThickness: 1.2 },
          forces: { centerForce: 0.1, repelForce: 210, linkForce: 0.6, linkDistance: 80 },
        },
        local: {
          depth: 4,
          direction: 'outgoing',
          display: { arrows: false, nodeSize: 0.6 },
        },
      })
    )
    const migrated = loadGraphSettings('vault-legacy')
    expect(migrated.error).toBeNull()
    expect(migrated.settings.local).toBeUndefined()
    expect(migrated.settings.groups).toEqual([{ id: 'lg-1', query: 'tag:#keep', color: '#98c379' }])
    expect(migrated.settings.global.filters.searchQuery).toBe('Keep')
    expect(migrated.settings.global.display.nodeSize).toBe(1.4)
  })

  it('isolates settings strictly between different vaults', () => {
    const a = addColorGroup(createDefaultGraphSettings(), { id: 'a1', query: 'tag:#work', color: '#98c379' })
    saveGraphSettings('vault-a', updateGraphViewSettings(a, { display: { arrows: true } }))

    const b = loadGraphSettings('vault-b')
    expect(b.settings.groups).toEqual([])
    expect(b.settings.global.display.arrows).toBe(false)
  })

  it('falls back safely on corrupt JSON and unsupported version without throwing', () => {
    localStorage.setItem('ayame:graph-settings:corrupt', '{not valid json')
    expect(loadGraphSettings('corrupt').settings).toEqual(createDefaultGraphSettings())

    localStorage.setItem(
      'ayame:graph-settings:future-version',
      JSON.stringify({ version: 99, global: { display: { arrows: true } } })
    )
    expect(loadGraphSettings('future-version').settings).toEqual(createDefaultGraphSettings())
  })

  it('sanitizes NaN, Infinity, out-of-range numbers, invalid colors, corrupt legacy local fields, and unknown properties', () => {
    const normalized = normalizeGraphSettings({
      version: GRAPH_SETTINGS_VERSION,
      maliciousExtra: 'drop-me',
      groups: [
        { id: 'ok', query: 'tag:#a', color: '#ABCDEF', extra: 123 },
        { id: 'bad-color', query: 'path:Docs', color: 'javascript:alert(1)' },
        'not-an-object',
      ],
      global: {
        injected: true,
        filters: {
          showTags: 1,
          searchQuery: 12345,
          extraFilter: true,
        },
        display: {
          arrows: 'yes',
          textFadeThreshold: Number.NaN,
          nodeSize: 999,
          linkThickness: -5,
          unknownDisplay: 42,
        },
        forces: {
          centerForce: Number.POSITIVE_INFINITY,
          repelForce: -50,
          linkForce: 5,
          linkDistance: 10,
        },
      },
      local: 'corrupted-legacy-local-payload',
    })

    expect(normalized.maliciousExtra).toBeUndefined()
    expect(normalized.local).toBeUndefined()
    expect(normalized.global.injected).toBeUndefined()
    expect(normalized.global.filters.showTags).toBe(false)
    expect(normalized.global.filters.searchQuery).toBe('')
    expect(normalized.global.filters.extraFilter).toBeUndefined()
    expect(normalized.groups).toHaveLength(2)
    expect(normalized.groups[0]).toEqual({ id: 'ok', query: 'tag:#a', color: '#abcdef' })
    expect(normalized.groups[1].color).toMatch(/^#[0-9a-f]{6}$/)
    expect(normalized.global.display).toEqual({
      arrows: false,
      textFadeThreshold: 0.48,
      nodeSize: GRAPH_DISPLAY_LIMITS.nodeSize.max,
      linkThickness: GRAPH_DISPLAY_LIMITS.linkThickness.min,
    })
    expect(normalized.global.forces).toEqual({
      centerForce: GRAPH_FORCE_LIMITS.centerForce.default,
      repelForce: GRAPH_FORCE_LIMITS.repelForce.min,
      linkForce: GRAPH_FORCE_LIMITS.linkForce.max,
      linkDistance: GRAPH_FORCE_LIMITS.linkDistance.min,
    })
  })

  it('handles storage write failures gracefully and signals non-persisted error', () => {
    const failingStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    const result = saveGraphSettings('vault-a', createDefaultGraphSettings(), failingStorage)
    expect(result.ok).toBe(false)
    expect(result.error).toBeTruthy()
    expect(result.settings).toEqual(createDefaultGraphSettings())
  })

  it('restores default global settings while preserving shared groups unless explicitly requested', () => {
    let settings = addColorGroup(createDefaultGraphSettings(), { id: 'g1', query: 'Alpha', color: '#e5c07b' })
    settings = updateGraphViewSettings(settings, {
      display: { arrows: true, nodeSize: 2 },
      forces: { repelForce: 320 },
      filters: { showOrphans: false },
    })

    const resetGlobal = resetGraphViewSettings(settings)
    expect(resetGlobal.global).toEqual(createDefaultGraphSettings().global)
    expect(resetGlobal.groups).toHaveLength(1)

    const clearedGroups = resetGraphGroups(resetGlobal)
    expect(clearedGroups.groups).toEqual([])
  })
})

describe('graphSettings — color group matching & priority', () => {
  it('supports plain text, path:, file:, and hierarchical tag: queries without false text tag matches', () => {
    const groups = [
      { id: 'g-text', query: 'Reading', color: '#98c379' },
      { id: 'g-path', query: 'path:Projects/Sub', color: '#e5c07b' },
      { id: 'g-tag-parent', query: 'tag:#project', color: '#e06c75' },
    ]
    const result = evaluateGraphGroups(groups, sampleNodes, sampleTagsByFile)

    expect(result.errorsByGroupId).toEqual({})
    // Sub/Beta matches path:Projects/Sub before tag:#project
    expect(result.colorsByNodeId['note:Projects/Sub/Beta.md']).toBe('#e5c07b')
    // Projects/Alpha has tag #project/active which matches hierarchical parent tag:#project
    expect(result.colorsByNodeId['note:Projects/Alpha.md']).toBe('#e06c75')
    // Notes/Reading matches text Reading
    expect(result.colorsByNodeId['note:Notes/Reading.md']).toBe('#98c379')
    // Daily/PlainTagMention only has text, not actual tag
    expect(result.colorsByNodeId['note:Daily/PlainTagMention.md']).toBeUndefined()
  })

  it('applies first matching valid group in priority order and reflects reordering immediately', () => {
    let settings = createDefaultGraphSettings()
    settings = addColorGroup(settings, { id: 'first', query: 'path:Projects', color: '#e06c75' })
    settings = addColorGroup(settings, { id: 'second', query: 'file:Alpha', color: '#7c9cff' })

    let evaluated = evaluateGraphGroups(settings.groups, sampleNodes, sampleTagsByFile)
    expect(evaluated.colorsByNodeId['note:Projects/Alpha.md']).toBe('#e06c75')

    settings = moveColorGroup(settings, 'second', -1)
    evaluated = evaluateGraphGroups(settings.groups, sampleNodes, sampleTagsByFile)
    expect(evaluated.colorsByNodeId['note:Projects/Alpha.md']).toBe('#7c9cff')

    settings = removeColorGroup(settings, 'second')
    evaluated = evaluateGraphGroups(settings.groups, sampleNodes, sampleTagsByFile)
    expect(evaluated.colorsByNodeId['note:Projects/Alpha.md']).toBe('#e06c75')

    settings = updateColorGroup(settings, 'first', { color: '#56b6c2' })
    evaluated = evaluateGraphGroups(settings.groups, sampleNodes, sampleTagsByFile)
    expect(evaluated.colorsByNodeId['note:Projects/Alpha.md']).toBe('#56b6c2')
  })

  it('ignores empty queries and isolates syntax errors per group without breaking valid rules', () => {
    const groups = [
      { id: 'empty', query: '   ', color: '#111111' },
      { id: 'invalid', query: 'path:', color: '#222222' },
      { id: 'valid', query: 'file:Alpha', color: '#333333' },
    ]
    const evaluated = evaluateGraphGroups(groups, sampleNodes, sampleTagsByFile)
    expect(evaluated.errorsByGroupId.empty).toBeUndefined()
    expect(evaluated.errorsByGroupId.invalid).toBeTruthy()
    expect(evaluated.errorsByGroupId.valid).toBeUndefined()
    expect(evaluated.colorsByNodeId['note:Projects/Alpha.md']).toBe('#333333')
    expect(evaluated.colorsByNodeId['note:Notes/Reading.md']).toBeUndefined()
  })

  it('never alters tag or unresolved nodes and evaluates identically on global and local subsets without mutating input', () => {
    const groups = [{ id: 'all-projects', query: 'tag:#project', color: '#c678dd' }]
    const beforeSnapshot = JSON.stringify(sampleNodes)

    const globalResult = evaluateGraphGroups(groups, sampleNodes, sampleTagsByFile)
    const localSubset = [sampleNodes[0], sampleNodes[4], sampleNodes[5]]
    const localResult = evaluateGraphGroups(groups, localSubset, sampleTagsByFile)

    expect(globalResult.colorsByNodeId['tag:#project']).toBeUndefined()
    expect(globalResult.colorsByNodeId['unresolved:future.md']).toBeUndefined()
    expect(localResult.colorsByNodeId['note:Projects/Alpha.md']).toBe(
      globalResult.colorsByNodeId['note:Projects/Alpha.md']
    )
    expect(JSON.stringify(sampleNodes)).toBe(beforeSnapshot)
  })
})

describe('graphSettings — pure display & force helpers', () => {
  it('computes monotonic label fade opacity as textFadeThreshold changes', () => {
    const lowThreshOpacity = resolveLabelOpacity(0.6, 0.2)
    const defaultThreshOpacity = resolveLabelOpacity(0.6, 0.48)
    const highThreshOpacity = resolveLabelOpacity(0.6, 0.9)

    expect(lowThreshOpacity).toBeGreaterThan(defaultThreshOpacity)
    expect(highThreshOpacity).toBe(0)
  })

  it('computes finite directional arrowheads outside radii, separates bidirectional edges, and guards zero distance', () => {
    const single = computeArrowGeometry({
      sx: 0,
      sy: 0,
      tx: 100,
      ty: 0,
      sourceRadius: 5,
      targetRadius: 8,
      bidirectional: false,
    })
    expect(single).not.toBeNull()
    expect(single.x1).toBeGreaterThan(5)
    expect(single.tipX).toBeLessThan(92)
    expect(Object.values(single).every(Number.isFinite)).toBe(true)

    const forward = computeArrowGeometry({
      sx: 0,
      sy: 0,
      tx: 100,
      ty: 0,
      sourceRadius: 5,
      targetRadius: 5,
      bidirectional: true,
    })
    const reverse = computeArrowGeometry({
      sx: 100,
      sy: 0,
      tx: 0,
      ty: 0,
      sourceRadius: 5,
      targetRadius: 5,
      bidirectional: true,
    })
    expect(forward.tipY).not.toBe(reverse.tipY)

    expect(
      computeArrowGeometry({ sx: 10, sy: 10, tx: 10, ty: 10, sourceRadius: 5, targetRadius: 5 })
    ).toBeNull()
    expect(
      computeArrowGeometry({ sx: 0, sy: 0, tx: 4, ty: 0, sourceRadius: 5, targetRadius: 5 })
    ).toBeNull()
    expect(
      computeArrowGeometry({ sx: Number.NaN, sy: 0, tx: 50, ty: 0, sourceRadius: 5, targetRadius: 5 })
    ).toBeNull()
  })

  it('updates existing D3 simulation forces without recreating simulation', () => {
    const nodes = [{ id: 'a' }, { id: 'b' }]
    const links = [{ source: 'a', target: 'b' }]
    const sim = forceSimulation(nodes)
      .force('link', forceLink(links).id((d) => d.id).distance(60).strength(0.55))
      .force('charge', forceManyBody().strength(-165))
      .force('center', forceCenter(0, 0))
      .force('x', forceX(0).strength(0.055))
      .force('y', forceY(0).strength(0.055))
    sim.stop()

    const restartSpy = vi.spyOn(sim, 'restart')
    applySimulationForces(sim, {
      centerForce: 0.4,
      repelForce: 280,
      linkForce: 0.9,
      linkDistance: 140,
    })

    expect(sim.force('x').strength()()).toBeCloseTo(0.4, 5)
    expect(sim.force('y').strength()()).toBeCloseTo(0.4, 5)
    expect(sim.force('charge').strength()()).toBeCloseTo(-280, 5)
    expect(sim.force('link').strength()()).toBeCloseTo(0.9, 5)
    expect(sim.force('link').distance()()).toBeCloseTo(140, 5)
    expect(restartSpy).toHaveBeenCalledTimes(1)
    sim.stop()
  })
})
