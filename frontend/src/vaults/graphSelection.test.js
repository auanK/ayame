import { describe, expect, it } from 'vitest'
import { buildVaultIndex, updateNoteInVaultIndex } from './vaultIndex.js'
import { buildGraphModel } from './graphModel.js'
import {
  DEFAULT_GRAPH_FILTERS,
  createDefaultGraphFilters,
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

    it('adds case-unified tag nodes only for visible notes in Global Graph', () => {
      const index = makeVaultIndex([
        { path: 'Alpha.md', content: '#Magia [[Direct]]' },
        { path: 'Direct.md', content: '#magia' },
        { path: 'HiddenBySearch.md', content: '#MAGIA #Secreta' },
      ])
      const base = buildGraphModel(index)

      const globalWithTags = applyGraphFilters(
        base,
        { ...createDefaultGraphFilters(), showTags: true },
        index
      )
      const magiaNodes = globalWithTags.nodes.filter((n) => n.id === 'tag:magia')
      expect(magiaNodes).toHaveLength(1)
      expect(magiaNodes[0].degree).toBe(3)
      expect(globalWithTags.nodes.some((n) => n.id === 'tag:secreta')).toBe(true)

      // When search excludes HiddenBySearch, #Secreta is omitted and tag:magia degree drops cleanly
      const filteredWithTags = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'Alpha Direct', showTags: true },
      })
      const emptyFiltered = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'Alpha', showTags: true },
      })
      expect(filteredWithTags.nodes).toEqual([])
      expect(emptyFiltered.nodes.map((n) => n.id)).toEqual(['note:Alpha.md', 'tag:magia'])
      expect(emptyFiltered.nodes.find((n) => n.id === 'tag:magia').degree).toBe(1)
      expect(emptyFiltered.nodes.some((n) => n.id === 'tag:secreta')).toBe(false)
    })

    it('projects only the global graph without local-mode semantics or residual local metadata', () => {
      let index = makeVaultIndex([
        { path: 'Heroi.md', content: '[[Historia]] #protagonista' },
        { path: 'Historia.md', content: '[[Falta]] #lore' },
        { path: 'Isolada.md', content: '' },
      ])
      let base = buildGraphModel(index)
      const baseSnapshot = structuredClone(base)

      // Legacy local arguments (mode/centerPath/depth/direction) must never scope down the global graph
      const projected = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        mode: 'local',
        centerPath: 'Heroi.md',
        depth: 1,
        direction: 'incoming',
        filters: createDefaultGraphFilters(),
      })
      expect(projected.nodes.map((n) => n.path)).toEqual(['Heroi.md', 'Historia.md', 'Isolada.md'])
      expect(projected.edges).toEqual([{ source: 'note:Heroi.md', target: 'note:Historia.md' }])
      expect(projected.centerId).toBeUndefined()
      expect(projected.centerPath).toBeUndefined()
      expect(projected.centerMissing).toBeUndefined()
      expect(projected.filtersRemovedOthers).toBeUndefined()
      expect(projected.nodes.every((n) => n.depth === undefined && n.originalDegree === undefined)).toBe(
        true
      )

      // Orphans disabled hides isolated note uniformly even if another stray property is attached
      const noOrphans = projectGraphView({
        baseGraph: { ...base, centerId: 'note:Isolada.md', direction: 'incoming' },
        vaultIndex: index,
        filters: {
          ...createDefaultGraphFilters(),
          showOrphans: false,
          existingFilesOnly: false,
        },
      })
      expect(noOrphans.nodes.map((n) => n.path)).toEqual(['Falta.md', 'Heroi.md', 'Historia.md'])

      // Global search keeps strict exclusion when nothing matches
      const globalEmptyOnNoMatch = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        filters: { ...createDefaultGraphFilters(), searchQuery: 'NaoExiste' },
      })
      expect(globalEmptyOnNoMatch.nodes).toEqual([])
      expect(globalEmptyOnNoMatch.filteredOut).toBe(true)
      expect(globalEmptyOnNoMatch.reason).toBe('filtered-empty')

      // Live index update removes tag & resolves link when Falta.md is saved
      index = updateNoteInVaultIndex(index, {
        path: 'Falta.md',
        content: 'Criada agora',
      })
      base = buildGraphModel(index)
      const afterCreate = projectGraphView({
        baseGraph: base,
        vaultIndex: index,
        filters: { ...createDefaultGraphFilters(), existingFilesOnly: false },
      })
      expect(afterCreate.nodes.some((n) => n.type === 'unresolved')).toBe(false)
      expect(afterCreate.nodes.find((n) => n.path === 'Falta.md').type).toBe('note')

      // Immutability check
      expect(buildGraphModel(makeVaultIndex([
        { path: 'Heroi.md', content: '[[Historia]] #protagonista' },
        { path: 'Historia.md', content: '[[Falta]] #lore' },
        { path: 'Isolada.md', content: '' },
      ]))).toEqual(baseSnapshot)
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
