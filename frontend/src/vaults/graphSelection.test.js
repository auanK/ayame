import { describe, expect, it } from 'vitest'
import { buildVaultIndex, updateNoteInVaultIndex } from './vaultIndex.js'
import { buildGraphModel } from './graphModel.js'
import {
  DEFAULT_GRAPH_FILTERS,
  createDefaultGraphFilters,
  deriveLocalGraph,
  parseGraphSearchQuery,
  applyGraphFilters,
  projectGraphView,
} from './graphSelection.js'

const makeVaultIndex = (notes, { complete = true, failures = [] } = {}) =>
  buildVaultIndex({
    directory: 'D:/Vault',
    complete,
    failures,
    folders: [],
    files: notes.map((n) => n.path),
    notes,
  })

describe('graphSelection', () => {
  describe('deriveLocalGraph', () => {
    it('expands neighborhoods accurately from depth 1 to 5', () => {
      // Chain: N0 -> N1 -> N2 -> N3 -> N4 -> N5 -> N6
      const index = makeVaultIndex([
        { path: 'N0.md', content: '[[N1]]' },
        { path: 'N1.md', content: '[[N2]]' },
        { path: 'N2.md', content: '[[N3]]' },
        { path: 'N3.md', content: '[[N4]]' },
        { path: 'N4.md', content: '[[N5]]' },
        { path: 'N5.md', content: '[[N6]]' },
        { path: 'N6.md', content: '' },
      ])
      const base = buildGraphModel(index)

      expect(deriveLocalGraph(base, { centerPath: 'N0.md', depth: 1 }).nodes.map((n) => n.path)).toEqual([
        'N0.md',
        'N1.md',
      ])
      expect(deriveLocalGraph(base, { centerPath: 'N0.md', depth: 2 }).nodes.map((n) => n.path)).toEqual([
        'N0.md',
        'N1.md',
        'N2.md',
      ])
      expect(deriveLocalGraph(base, { centerPath: 'N0.md', depth: 5 }).nodes.map((n) => n.path)).toEqual([
        'N0.md',
        'N1.md',
        'N2.md',
        'N3.md',
        'N4.md',
        'N5.md',
      ])
    })

    it('clamps out-of-range depth values to [1, 5]', () => {
      const index = makeVaultIndex([
        { path: 'N0.md', content: '[[N1]]' },
        { path: 'N1.md', content: '[[N2]]' },
        { path: 'N2.md', content: '[[N3]]' },
        { path: 'N3.md', content: '[[N4]]' },
        { path: 'N4.md', content: '[[N5]]' },
        { path: 'N5.md', content: '[[N6]]' },
        { path: 'N6.md', content: '' },
      ])
      const base = buildGraphModel(index)

      const low = deriveLocalGraph(base, { centerPath: 'N0.md', depth: 0 })
      expect(low.depth).toBe(1)
      expect(low.nodes.map((n) => n.path)).toEqual(['N0.md', 'N1.md'])

      const high = deriveLocalGraph(base, { centerPath: 'N0.md', depth: 9 })
      expect(high.depth).toBe(5)
      expect(high.nodes.map((n) => n.path)).not.toContain('N6.md')
    })

    it('respects outgoing, incoming, and both direction policies including mutual links', () => {
      const index = makeVaultIndex([
        { path: 'Center.md', content: '[[Out1]]' },
        { path: 'Out1.md', content: '[[Center]] [[Out2]]' }, // mutual link with Center!
        { path: 'Out2.md', content: '' },
        { path: 'In1.md', content: '[[Center]]' },
        { path: 'In2.md', content: '[[In1]]' },
      ])
      const base = buildGraphModel(index)

      const out1 = deriveLocalGraph(base, { centerPath: 'Center.md', depth: 1, direction: 'outgoing' })
      expect(out1.nodes.map((n) => n.path)).toEqual(['Center.md', 'Out1.md'])
      // Out1 -> Center is incoming into Center, so excluded under depth-1 outgoing policy
      expect(out1.edges).toEqual([{ source: 'note:Center.md', target: 'note:Out1.md' }])

      const in1 = deriveLocalGraph(base, { centerPath: 'Center.md', depth: 1, direction: 'incoming' })
      expect(in1.nodes.map((n) => n.path)).toEqual(['Center.md', 'In1.md', 'Out1.md'])
      // Center -> Out1 is outgoing from Center, so excluded under depth-1 incoming policy
      expect(in1.edges).toEqual([
        { source: 'note:In1.md', target: 'note:Center.md' },
        { source: 'note:Out1.md', target: 'note:Center.md' },
      ])

      const both1 = deriveLocalGraph(base, { centerPath: 'Center.md', depth: 1, direction: 'both' })
      expect(both1.nodes.map((n) => n.path)).toEqual(['Center.md', 'In1.md', 'Out1.md'])
      expect(both1.edges).toEqual([
        { source: 'note:Center.md', target: 'note:Out1.md' },
        { source: 'note:In1.md', target: 'note:Center.md' },
        { source: 'note:Out1.md', target: 'note:Center.md' },
      ])
    })

    it('includes existing edges between same-depth neighbors in both mode without inventing artificial ones', () => {
      const index = makeVaultIndex([
        { path: 'Center.md', content: '[[A]] [[B]] [[C]]' },
        { path: 'A.md', content: '[[B]]' },
        { path: 'B.md', content: '' },
        { path: 'C.md', content: '' },
      ])
      const base = buildGraphModel(index)

      const local = deriveLocalGraph(base, { centerPath: 'Center.md', depth: 1, direction: 'both' })
      expect(local.nodes.map((n) => n.path)).toEqual(['A.md', 'B.md', 'C.md', 'Center.md'])
      expect(local.edges).toEqual([
        { source: 'note:A.md', target: 'note:B.md' },
        { source: 'note:Center.md', target: 'note:A.md' },
        { source: 'note:Center.md', target: 'note:B.md' },
        { source: 'note:Center.md', target: 'note:C.md' },
      ])
    })

    it('handles cycles and self-links safely without infinite loops or duplicates', () => {
      const index = makeVaultIndex([
        { path: 'A.md', content: '[[A]] [[B]]' },
        { path: 'B.md', content: '[[C]]' },
        { path: 'C.md', content: '[[A]]' },
      ])
      const base = buildGraphModel(index)

      const local = deriveLocalGraph(base, { centerPath: 'A.md', depth: 5, direction: 'outgoing' })
      expect(local.nodes.map((n) => n.path)).toEqual(['A.md', 'B.md', 'C.md'])
      expect(local.edges).toEqual([
        { source: 'note:A.md', target: 'note:B.md' },
        { source: 'note:B.md', target: 'note:C.md' },
        { source: 'note:C.md', target: 'note:A.md' },
      ])

      const withSyntheticSelfLoop = {
        ...base,
        edges: [{ source: 'note:A.md', target: 'note:A.md' }, ...base.edges],
      }
      const localSelf = deriveLocalGraph(withSyntheticSelfLoop, {
        centerPath: 'A.md',
        depth: 1,
        direction: 'outgoing',
      })
      expect(localSelf.nodes.map((n) => n.path)).toEqual(['A.md', 'B.md'])
      expect(localSelf.edges).toEqual([
        { source: 'note:A.md', target: 'note:A.md' },
        { source: 'note:A.md', target: 'note:B.md' },
      ])
    })

    it('returns isolated single node when center exists with no connections', () => {
      const index = makeVaultIndex([
        { path: 'Solo.md', content: 'Just text' },
        { path: 'Other.md', content: '[[Third]]' },
        { path: 'Third.md', content: '' },
      ])
      const base = buildGraphModel(index)

      const local = deriveLocalGraph(base, { centerPath: 'Solo.md', depth: 2 })
      expect(local.nodes.map((n) => n.path)).toEqual(['Solo.md'])
      expect(local.edges).toEqual([])
      expect(local.centerMissing).toBe(false)
    })

    it('handles missing or empty centerPath without falling back to another note', () => {
      const index = makeVaultIndex([
        { path: 'A.md', content: '[[B]]' },
        { path: 'B.md', content: '' },
      ])
      const base = buildGraphModel(index)

      const noCenter = deriveLocalGraph(base, { centerPath: null })
      expect(noCenter.nodes).toEqual([])
      expect(noCenter.reason).toBe('no-center')
      expect(noCenter.centerMissing).toBe(false)

      const missingCenter = deriveLocalGraph(base, { centerPath: 'Ghost.md' })
      expect(missingCenter.nodes).toEqual([])
      expect(missingCenter.centerMissing).toBe(true)
      expect(missingCenter.reason).toBe('center-missing')
    })

    it('does not mutate the base global graph and produces deterministic results', () => {
      const index = makeVaultIndex([
        { path: 'A.md', content: '[[B]] [[C]]' },
        { path: 'B.md', content: '[[C]]' },
        { path: 'C.md', content: '' },
      ])
      const base = buildGraphModel(index)
      const snapshot = structuredClone(base)

      const first = deriveLocalGraph(base, { centerPath: 'A.md', depth: 1 })
      const second = deriveLocalGraph(base, { centerPath: 'A.md', depth: 1 })

      expect(base).toEqual(snapshot)
      expect(first).toEqual(second)
      expect(first.nodes[0]).not.toBe(base.nodes[0])
    })
  })

  describe('parseGraphSearchQuery', () => {
    it('accepts empty or whitespace-only queries as empty valid filter', () => {
      expect(parseGraphSearchQuery('')).toMatchObject({ valid: true, isEmpty: true, terms: [] })
      expect(parseGraphSearchQuery('   \t ')).toMatchObject({ valid: true, isEmpty: true, terms: [] })
    })

    it('parses plain text, file:, path:, tag:, and quoted values', () => {
      const parsed = parseGraphSearchQuery('heroi file:Capa path:"Pasta Principal/Sub" tag:#lore/reino')
      expect(parsed.valid).toBe(true)
      expect(parsed.isEmpty).toBe(false)
      expect(parsed.terms).toEqual([
        { kind: 'text', value: 'heroi' },
        { kind: 'file', value: 'capa' },
        { kind: 'path', value: 'pasta principal/sub' },
        { kind: 'tag', value: 'lore/reino' },
      ])
    })

    it('explicitly rejects unsupported or incomplete search operators instead of misinterpreting them', () => {
      expect(parseGraphSearchQuery('line:algo').valid).toBe(false)
      expect(parseGraphSearchQuery('file:').valid).toBe(false)
      expect(parseGraphSearchQuery('tag:#').valid).toBe(false)
      expect(parseGraphSearchQuery('-tag:rascunho').valid).toBe(false)
      expect(parseGraphSearchQuery('Historia OR Heroi').valid).toBe(false)
      expect(parseGraphSearchQuery('/^Heroi/').valid).toBe(false)
      expect(parseGraphSearchQuery('path:"unclosed').valid).toBe(false)
    })
  })

  describe('applyGraphFilters & projectGraphView', () => {
    it('filters notes by Search files subset (plain, file:, path:, tag: with hierarchy)', () => {
      const index = makeVaultIndex([
        { path: 'Historia.md', content: '#lore/reino [[Personagens/Heroi]]' },
        { path: 'Personagens/Heroi.md', content: '#Protagonista' },
        { path: 'Personagens/Vilao.md', content: '#antagonista #lore' },
      ])
      const base = buildGraphModel(index)

      expect(
        applyGraphFilters(base, { ...DEFAULT_GRAPH_FILTERS, searchQuery: 'file:heroi' }, index).nodes.map(
          (n) => n.path
        )
      ).toEqual(['Personagens/Heroi.md'])

      expect(
        applyGraphFilters(base, { ...DEFAULT_GRAPH_FILTERS, searchQuery: 'path:Personagens/' }, index).nodes.map(
          (n) => n.path
        )
      ).toEqual(['Personagens/Heroi.md', 'Personagens/Vilao.md'])

      // Hierarchical tag match: tag:lore matches #lore and #lore/reino
      expect(
        applyGraphFilters(base, { ...DEFAULT_GRAPH_FILTERS, searchQuery: 'tag:lore' }, index).nodes.map(
          (n) => n.path
        )
      ).toEqual(['Historia.md', 'Personagens/Vilao.md'])

      // AND combination
      expect(
        applyGraphFilters(
          base,
          { ...DEFAULT_GRAPH_FILTERS, searchQuery: 'path:Personagens/ tag:lore' },
          index
        ).nodes.map((n) => n.path)
      ).toEqual(['Personagens/Vilao.md'])
    })

    it('surfaces invalid query state without misinterpreting unsupported operators as filename text', () => {
      const index = makeVaultIndex([
        { path: 'line foo.md', content: '' },
        { path: 'Normal.md', content: '' },
      ])
      const base = buildGraphModel(index)

      const res = applyGraphFilters(base, { ...DEFAULT_GRAPH_FILTERS, searchQuery: 'line:foo' }, index)
      expect(res.queryValid).toBe(false)
      expect(res.queryError).toBeTruthy()
    })

    it('evaluates Orphans against original note-to-note topology before search and independent of unresolved/tag links', () => {
      const index = makeVaultIndex([
        { path: 'A.md', content: '[[B]]' },
        { path: 'B.md', content: '' },
        { path: 'OrphanWithGhostAndTag.md', content: '#solo [[MissingNote]]' },
      ])
      const base = buildGraphModel(index)

      // Orphans hidden -> OrphanWithGhostAndTag hidden even when showTags/unresolved enabled
      const hiddenOrphans = applyGraphFilters(
        base,
        {
          searchQuery: '',
          showOrphans: false,
          existingFilesOnly: false,
          showTags: true,
        },
        index
      )
      expect(hiddenOrphans.nodes.map((n) => n.id)).toEqual(['note:A.md', 'note:B.md'])

      // Connected note B keeps surviving when search hides A (originalDegree === 1 > 0)
      const searchBWithoutOrphans = applyGraphFilters(
        base,
        {
          searchQuery: 'B',
          showOrphans: false,
          existingFilesOnly: true,
          showTags: false,
        },
        index
      )
      expect(searchBWithoutOrphans.nodes.map((n) => n.path)).toEqual(['B.md'])
    })

    it('exposes unresolved nodes only when existingFilesOnly is false and ignores ambiguous, unverified, and external links', () => {
      const index = makeVaultIndex([
        {
          path: 'A.md',
          content: [
            '[[Falta]]',
            '[[Falta#Secao]]',
            '[[Dup]]',
            '[[https://example.com]]',
            '[Site](https://example.org)',
          ].join('\n'),
        },
        { path: 'Sub1/B.md', content: '[[Falta]] [Rel](./Alvo.md)' },
        { path: 'Sub2/C.md', content: '[Rel](./Alvo.md)' },
        { path: 'One/Dup.md', content: '' },
        { path: 'Two/Dup.md', content: '' },
      ])
      const base = buildGraphModel(index)

      const onlyExisting = applyGraphFilters(
        base,
        { ...createDefaultGraphFilters(), existingFilesOnly: true },
        index
      )
      expect(onlyExisting.nodes.some((n) => n.type === 'unresolved')).toBe(false)

      const withUnresolved = applyGraphFilters(
        base,
        { ...createDefaultGraphFilters(), existingFilesOnly: false },
        index
      )
      const unresolvedNodes = withUnresolved.nodes.filter((n) => n.type === 'unresolved')
      // 'Falta' deduplicated across anchor and two notes; ./Alvo.md in Sub1 and Sub2 kept distinct!
      // 'Dup' is ambiguous -> NOT unresolved; external links -> NOT unresolved
      expect(unresolvedNodes.map((n) => n.label).sort()).toEqual(['Alvo', 'Alvo', 'Falta'])
      const faltaNode = unresolvedNodes.find((n) => n.label === 'Falta')
      expect(faltaNode.sourcePaths).toEqual(['A.md', 'Sub1/B.md'])
      expect(withUnresolved.edges.filter((e) => e.target === faltaNode.id)).toEqual([
        { source: 'note:A.md', target: faltaNode.id, type: 'unresolved' },
        { source: 'note:Sub1/B.md', target: faltaNode.id, type: 'unresolved' },
      ])

      // Incomplete index keeps unverified references instead of treating them as confirmed unresolved missing notes
      const partialIndex = makeVaultIndex([{ path: 'Only.md', content: '[[Wait]]' }], {
        complete: false,
        failures: [{ path: 'Other.md', code: 'READ_ERROR' }],
      })
      const partialBase = buildGraphModel(partialIndex)
      const partialResult = applyGraphFilters(
        partialBase,
        { ...createDefaultGraphFilters(), existingFilesOnly: false },
        partialIndex
      )
      expect(partialResult.nodes.filter((n) => n.type === 'unresolved')).toEqual([])
    })

    it('respects local hop depth and direction for unresolved targets', () => {
      const index = makeVaultIndex([
        { path: 'Center.md', content: '[[B]] [[MissingA]]' },
        { path: 'B.md', content: '[[MissingB]]' },
      ])
      const base = buildGraphModel(index)

      const depth1Both = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Center.md',
        depth: 1,
        direction: 'both',
        filters: { ...createDefaultGraphFilters(), existingFilesOnly: false },
      })
      expect(depth1Both.nodes.filter((n) => n.type === 'unresolved').map((n) => n.label)).toEqual([
        'MissingA',
      ])

      const depth2Both = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Center.md',
        depth: 2,
        direction: 'both',
        filters: { ...createDefaultGraphFilters(), existingFilesOnly: false },
      })
      expect(depth2Both.nodes.filter((n) => n.type === 'unresolved').map((n) => n.label)).toEqual([
        'MissingA',
        'MissingB',
      ])

      const depth1Incoming = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Center.md',
        depth: 1,
        direction: 'incoming',
        filters: { ...createDefaultGraphFilters(), existingFilesOnly: false },
      })
      expect(depth1Incoming.nodes.filter((n) => n.type === 'unresolved')).toEqual([])
    })

    it('adds case-unified tag nodes only for visible notes and prevents tag bridges in Local Graph', () => {
      const index = makeVaultIndex([
        { path: 'Center.md', content: '#Magia [[Direct]]' },
        { path: 'Direct.md', content: '#magia' },
        { path: 'UnrelatedSameTag.md', content: '#MAGIA #Secreta' },
      ])
      const base = buildGraphModel(index)

      // Global with tags: one unified tag:magia node plus tag:secreta
      const globalWithTags = applyGraphFilters(
        base,
        { ...createDefaultGraphFilters(), showTags: true },
        index
      )
      const magiaNodes = globalWithTags.nodes.filter((n) => n.id === 'tag:magia')
      expect(magiaNodes).toHaveLength(1)
      expect(magiaNodes[0].degree).toBe(3)

      // Local depth 1 on Center with tags: does NOT bridge to UnrelatedSameTag.md or include #Secreta
      const localWithTags = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Center.md',
        depth: 1,
        direction: 'both',
        filters: { ...createDefaultGraphFilters(), showTags: true },
      })
      expect(localWithTags.nodes.map((n) => n.id)).toEqual([
        'note:Center.md',
        'note:Direct.md',
        'tag:magia',
      ])
    })

    it('reports empty or single-center filter outcomes cleanly in Local Graph and stays live after vault index updates', () => {
      let index = makeVaultIndex([
        { path: 'Heroi.md', content: '[[Historia]] #protagonista' },
        { path: 'Historia.md', content: '[[Falta]] #lore' },
      ])
      let base = buildGraphModel(index)

      const onlyCenterLeft = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Heroi.md',
        depth: 1,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'Heroi' },
      })
      expect(onlyCenterLeft.nodes.map((n) => n.path)).toEqual(['Heroi.md'])
      expect(onlyCenterLeft.filtersRemovedOthers).toBe(true)
      expect(onlyCenterLeft.centerPath).toBe('Heroi.md')

      // Corrected Stage 2 contract: Local Graph preserves the existing center node
      // when Search files matches no other nodes, while marking filtersRemovedOthers.
      const onlyCenterOnNoMatch = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Heroi.md',
        depth: 1,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'NaoExiste' },
      })
      expect(onlyCenterOnNoMatch.nodes.map((n) => n.path)).toEqual(['Heroi.md'])
      expect(onlyCenterOnNoMatch.edges).toEqual([])
      expect(onlyCenterOnNoMatch.filteredOut).toBe(false)
      expect(onlyCenterOnNoMatch.filtersRemovedOthers).toBe(true)
      expect(onlyCenterOnNoMatch.centerPath).toBe('Heroi.md')

      // Global Graph keeps strict search exclusion when nothing matches.
      const globalEmptyOnNoMatch = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'global',
        filters: { ...createDefaultGraphFilters(), searchQuery: 'NaoExiste' },
      })
      expect(globalEmptyOnNoMatch.nodes).toEqual([])
      expect(globalEmptyOnNoMatch.filteredOut).toBe(true)

      // Live index update removes tag & resolves link when Falta.md is saved
      index = updateNoteInVaultIndex(index, {
        path: 'Falta.md',
        content: 'Criada agora',
      })
      base = buildGraphModel(index)
      const afterCreate = applyGraphFilters(
        base,
        { ...createDefaultGraphFilters(), existingFilesOnly: false },
        index
      )
      expect(afterCreate.nodes.some((n) => n.type === 'unresolved')).toBe(false)
      expect(afterCreate.nodes.find((n) => n.path === 'Falta.md').type).toBe('note')
    })

    it('preserves isolated local center when Orphans is disabled while hiding it in Global Graph', () => {
      const index = makeVaultIndex([{ path: 'Solo.md', content: 'Isolated note' }])
      const base = buildGraphModel(index)

      const localSolo = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Solo.md',
        depth: 1,
        filters: { ...createDefaultGraphFilters(), showOrphans: false },
      })
      expect(localSolo.nodes.map((n) => n.path)).toEqual(['Solo.md'])
      expect(localSolo.edges).toEqual([])
      expect(localSolo.centerId).toBe('note:Solo.md')
      expect(localSolo.centerMissing).toBe(false)
      expect(localSolo.filteredOut).toBe(false)
      expect(localSolo.filtersRemovedOthers).toBe(false)

      const globalSolo = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'global',
        filters: { ...createDefaultGraphFilters(), showOrphans: false },
      })
      expect(globalSolo.nodes).toEqual([])
      expect(globalSolo.filteredOut).toBe(true)
    })

    it('preserves local center when Search matches only a neighbor or combined filters apply, without inventing missing centers or mutating inputs', () => {
      const index = makeVaultIndex([
        { path: 'Center.md', content: '[[Neighbor]] [[Other]]' },
        { path: 'Neighbor.md', content: '' },
        { path: 'Other.md', content: '' },
        { path: 'Isolada.md', content: '' },
      ])
      const base = buildGraphModel(index)
      const baseSnapshot = structuredClone(base)

      // Search matches only Neighbor -> Center, Neighbor, and real Center->Neighbor edge remain
      const neighborMatch = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Center.md',
        depth: 1,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'Neighbor', showOrphans: false },
      })
      expect(neighborMatch.nodes.map((n) => n.path)).toEqual(['Center.md', 'Neighbor.md'])
      expect(neighborMatch.edges).toEqual([{ source: 'note:Center.md', target: 'note:Neighbor.md' }])
      expect(neighborMatch.centerId).toBe('note:Center.md')
      expect(neighborMatch.centerMissing).toBe(false)
      expect(neighborMatch.filteredOut).toBe(false)
      expect(neighborMatch.filtersRemovedOthers).toBe(false)

      // Global keeps strict exclusion for Center and Isolada
      const globalMatch = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'global',
        filters: { ...createDefaultGraphFilters(), searchQuery: 'Neighbor', showOrphans: false },
      })
      expect(globalMatch.nodes.map((n) => n.path)).toEqual(['Neighbor.md'])

      // Isolated center under combined Search no-match + Orphans false still preserves Solo center only
      const isolatedCombo = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Isolada.md',
        depth: 1,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'NoSuchNote', showOrphans: false },
      })
      expect(isolatedCombo.nodes.map((n) => n.path)).toEqual(['Isolada.md'])
      expect(isolatedCombo.edges).toEqual([])
      expect(isolatedCombo.filteredOut).toBe(false)

      // Missing center note is never invented under filters
      const missingCenter = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'MissingCenter.md',
        filters: { ...createDefaultGraphFilters(), searchQuery: 'MissingCenter', showOrphans: false },
      })
      expect(missingCenter.nodes).toEqual([])
      expect(missingCenter.centerMissing).toBe(true)
      expect(missingCenter.reason).toBe('center-missing')

      // Immutability check on input base graph and scoped intermediate graph
      const scoped = deriveLocalGraph(base, { centerPath: 'Center.md', depth: 1 })
      const scopedSnapshot = structuredClone(scoped)
      applyGraphFilters(scoped, { searchQuery: 'Neighbor', showOrphans: false }, index)
      expect(base).toEqual(baseSnapshot)
      expect(scoped).toEqual(scopedSnapshot)
    })

    it('distinguishes unresolved targets with different extensions or folders while deduplicating equivalent references stably', () => {
      const notesOrderA = [
        {
          path: 'A.md',
          content: '[[Future]] [[Future.md]] [[Future#Secao]] [[Future.markdown]] [[Projetos/Future]]',
        },
        {
          path: 'Sub/B.md',
          content: '[[Future]] [[Arquivo/Future]] [[OneDupOrAmb]]',
        },
        { path: 'Dir1/OneDupOrAmb.md', content: '' },
        { path: 'Dir2/OneDupOrAmb.md', content: '' },
      ]
      const indexA = makeVaultIndex(notesOrderA)
      const indexB = makeVaultIndex([...notesOrderA].reverse())

      const resA = applyGraphFilters(
        buildGraphModel(indexA),
        { ...createDefaultGraphFilters(), existingFilesOnly: false },
        indexA
      )
      const resB = applyGraphFilters(
        buildGraphModel(indexB),
        { ...createDefaultGraphFilters(), existingFilesOnly: false },
        indexB
      )

      const unresolvedA = resA.nodes.filter((n) => n.type === 'unresolved')
      // Expected distinct unresolved targets:
      // 1. Future.md (shared by [[Future]], [[Future.md]], [[Future#Secao]], and Sub/B [[Future]])
      // 2. Future.markdown (distinct extension!)
      // 3. Projetos/Future.md (distinct folder)
      // 4. Arquivo/Future.md (distinct folder)
      // OneDupOrAmb is ambiguous -> excluded!
      expect(unresolvedA.map((n) => ({ id: n.id, path: n.path, label: n.label }))).toEqual([
        { id: 'unresolved:arquivo/future.md', path: 'Arquivo/Future.md', label: 'Future' },
        { id: 'unresolved:future.markdown', path: 'Future.markdown', label: 'Future' },
        { id: 'unresolved:future.md', path: 'Future.md', label: 'Future' },
        { id: 'unresolved:projetos/future.md', path: 'Projetos/Future.md', label: 'Future' },
      ])

      const futureMdNode = unresolvedA.find((n) => n.id === 'unresolved:future.md')
      expect(futureMdNode.sourcePaths).toEqual(['A.md', 'Sub/B.md'])
      expect(resA.edges.filter((e) => e.target === futureMdNode.id)).toEqual([
        { source: 'note:A.md', target: 'unresolved:future.md', type: 'unresolved' },
        { source: 'note:Sub/B.md', target: 'unresolved:future.md', type: 'unresolved' },
      ])

      // Stability independent of input note order
      expect(resA).toEqual(resB)

      // Existing files only hides all unresolved nodes
      const hidden = applyGraphFilters(
        buildGraphModel(indexA),
        { ...createDefaultGraphFilters(), existingFilesOnly: true },
        indexA
      )
      expect(hidden.nodes.some((n) => n.type === 'unresolved')).toBe(false)
    })
  })
})
