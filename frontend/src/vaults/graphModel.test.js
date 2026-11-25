import { describe, expect, it } from 'vitest'
import { buildVaultIndex, updateNoteInVaultIndex } from './vaultIndex.js'
import { buildGraphModel } from './graphModel.js'

const makeRawIndex = (overrides = {}) => ({
  directory: 'campanha',
  complete: true,
  failures: [],
  folders: [],
  files: [],
  notes: [],
  ...overrides,
})

describe('graphModel — Stage 1 Global Graph data model', () => {
  it('returns an empty serializable graph for a vault with no notes', () => {
    const index = buildVaultIndex(makeRawIndex({ files: ['capa.png'] }))
    const graph = buildGraphModel(index)

    expect(graph).toEqual({
      nodes: [],
      edges: [],
      complete: true,
      failures: [],
    })
    expect(JSON.parse(JSON.stringify(graph))).toEqual(graph)
  })

  it('includes an isolated orphan note with degree 0', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        files: ['Solta.md'],
        notes: [{ path: 'Solta.md', name: 'Solta.md', content: '# Nota solta\n\nSem links.' }],
      })
    )

    expect(buildGraphModel(index)).toEqual({
      nodes: [
        {
          id: 'note:Solta.md',
          path: 'Solta.md',
          label: 'Solta',
          type: 'note',
          degree: 0,
        },
      ],
      edges: [],
      complete: true,
      failures: [],
    })
  })

  it('connects two notes with a directed edge derived from outgoing links', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        files: ['Historia.md', 'Heroi.md'],
        notes: [
          { path: 'Historia.md', name: 'Historia.md', content: 'Protagonista: [[Heroi]].' },
          { path: 'Heroi.md', name: 'Heroi.md', content: 'Personagem principal.' },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.nodes).toEqual([
      { id: 'note:Heroi.md', path: 'Heroi.md', label: 'Heroi', type: 'note', degree: 1 },
      { id: 'note:Historia.md', path: 'Historia.md', label: 'Historia', type: 'note', degree: 1 },
    ])
    expect(graph.edges).toEqual([
      { source: 'note:Historia.md', target: 'note:Heroi.md' },
    ])
  })

  it('connects multiple notes while keeping isolated notes and preserving direction for bidirectional links', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        files: ['A.md', 'B.md', 'C.md', 'Orfa.md'],
        notes: [
          { path: 'A.md', name: 'A.md', content: 'Vai para [[B]] e [[C]].' },
          { path: 'B.md', name: 'B.md', content: 'Volta para [[A]].' },
          { path: 'C.md', name: 'C.md', content: 'Nota final.' },
          { path: 'Orfa.md', name: 'Orfa.md', content: 'Sem conexões.' },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.nodes.map((n) => ({ id: n.id, degree: n.degree }))).toEqual([
      { id: 'note:A.md', degree: 3 },
      { id: 'note:B.md', degree: 2 },
      { id: 'note:C.md', degree: 1 },
      { id: 'note:Orfa.md', degree: 0 },
    ])
    expect(graph.edges).toEqual([
      { source: 'note:A.md', target: 'note:B.md' },
      { source: 'note:A.md', target: 'note:C.md' },
      { source: 'note:B.md', target: 'note:A.md' },
    ])
  })

  it('deduplicates repeated links from the same source to the same target, including heading and block links', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        files: ['Indice.md', 'Cosmologia.md'],
        notes: [
          {
            path: 'Indice.md',
            name: 'Indice.md',
            content: [
              '# Índice',
              'Veja [[Cosmologia]], [[Cosmologia|Cosmos]],',
              '[[Cosmologia#Origem]], [[Cosmologia#^bloco-1]] e [leia](Cosmologia.md#Origem).',
              'Auto-link [[#Índice]] e [[Indice]].',
            ].join('\n'),
          },
          {
            path: 'Cosmologia.md',
            name: 'Cosmologia.md',
            content: '# Origem\n\nTexto ^bloco-1\n',
          },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.edges).toEqual([
      { source: 'note:Indice.md', target: 'note:Cosmologia.md' },
    ])
    expect(graph.nodes.find((n) => n.id === 'note:Indice.md')?.degree).toBe(1)
    expect(graph.nodes.find((n) => n.id === 'note:Cosmologia.md')?.degree).toBe(1)
  })

  it('resolves YAML property links and frontmatter aliases into edges via the vault index', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        folders: ['Lore'],
        files: ['Indice.md', 'Lore/Cosmologia.md'],
        notes: [
          {
            path: 'Indice.md',
            name: 'Indice.md',
            content: '---\nrelated:\n  - "[[Universo]]"\n---\nCorpo sem links.',
          },
          {
            path: 'Lore/Cosmologia.md',
            name: 'Cosmologia.md',
            content: '---\naliases:\n  - Universo\n---\n# Universo',
          },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.edges).toEqual([
      { source: 'note:Indice.md', target: 'note:Lore/Cosmologia.md' },
    ])
  })

  it('distinguishes notes with the same filename in different folders by vault-relative path', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        folders: ['Personagens', 'Historia'],
        files: ['Personagens/Heroi.md', 'Historia/Heroi.md', 'Cronica.md'],
        notes: [
          { path: 'Personagens/Heroi.md', name: 'Heroi.md', content: 'Ficha.' },
          { path: 'Historia/Heroi.md', name: 'Heroi.md', content: 'Arco.' },
          { path: 'Cronica.md', name: 'Cronica.md', content: 'Veja [[Personagens/Heroi]].' },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.nodes.map((n) => ({ id: n.id, path: n.path, label: n.label }))).toEqual([
      { id: 'note:Cronica.md', path: 'Cronica.md', label: 'Cronica' },
      { id: 'note:Historia/Heroi.md', path: 'Historia/Heroi.md', label: 'Heroi' },
      { id: 'note:Personagens/Heroi.md', path: 'Personagens/Heroi.md', label: 'Heroi' },
    ])
    expect(graph.edges).toEqual([
      { source: 'note:Cronica.md', target: 'note:Personagens/Heroi.md' },
    ])
  })

  it('does not create nodes or edges for ambiguous, pending, external, invalid, or unlinked mentions', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        folders: ['Personagens', 'Historia'],
        files: ['Personagens/Heroi.md', 'Historia/Heroi.md', 'Nota.md', 'Anexo.txt'],
        notes: [
          { path: 'Personagens/Heroi.md', name: 'Heroi.md', content: 'Personagem.' },
          { path: 'Historia/Heroi.md', name: 'Heroi.md', content: 'Lenda.' },
          {
            path: 'Nota.md',
            name: 'Nota.md',
            content: [
              'Ambíguo: [[Heroi]].',
              'Pendente: [[Nota Futura]].',
              'Externo: [Site](https://example.com/Heroi.md).',
              'Inválido: [Escape](../secret.md) [JS](javascript:alert(1)) [[Anexo.txt]].',
              'Menção não vinculada: Personagens/Heroi e Lenda.',
            ].join('\n'),
          },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.nodes.map((n) => n.path)).toEqual([
      'Historia/Heroi.md',
      'Nota.md',
      'Personagens/Heroi.md',
    ])
    expect(graph.edges).toEqual([])
  })

  it('builds partial graph with complete: false and accessible failures when vault index is incomplete', () => {
    const index = buildVaultIndex(
      makeRawIndex({
        complete: true,
        failures: [{ path: 'Corrompida.md', reason: 'INVALID_FILE_ENCODING' }],
        files: ['A.md', 'B.md', 'Corrompida.md'],
        notes: [
          { path: 'A.md', name: 'A.md', content: 'Link [[B]] e [[Desconhecida]].' },
          { path: 'B.md', name: 'B.md', content: 'Ok.' },
        ],
      })
    )

    const graph = buildGraphModel(index)
    expect(graph.complete).toBe(false)
    expect(graph.failures).toEqual([{ path: 'Corrompida.md', reason: 'INVALID_FILE_ENCODING' }])
    expect(graph.nodes.some((n) => n.path === 'A.md')).toBe(true)
    expect(graph.nodes.some((n) => n.path === 'B.md')).toBe(true)
    expect(graph.nodes.some((n) => n.path === 'Desconhecida.md')).toBe(false)
    expect(graph.edges).toEqual([{ source: 'note:A.md', target: 'note:B.md' }])
  })

  it('updates nodes and edges when notes add links, remove links, or are removed on index rebuild', () => {
    const initial = buildVaultIndex(
      makeRawIndex({
        files: ['A.md', 'B.md', 'C.md'],
        notes: [
          { path: 'A.md', name: 'A.md', content: 'Inicial.' },
          { path: 'B.md', name: 'B.md', content: 'Destino B.' },
          { path: 'C.md', name: 'C.md', content: 'Destino C.' },
        ],
      })
    )
    expect(buildGraphModel(initial).edges).toEqual([])

    const addedLink = updateNoteInVaultIndex(initial, {
      path: 'A.md',
      name: 'A.md',
      content: 'Agora liga [[B]] e [[C]].',
      revision: '1'.repeat(64),
    })
    expect(buildGraphModel(addedLink).edges).toEqual([
      { source: 'note:A.md', target: 'note:B.md' },
      { source: 'note:A.md', target: 'note:C.md' },
    ])

    const removedLink = updateNoteInVaultIndex(addedLink, {
      path: 'A.md',
      name: 'A.md',
      content: 'Agora liga apenas [[C]].',
      revision: '2'.repeat(64),
    })
    expect(buildGraphModel(removedLink).edges).toEqual([
      { source: 'note:A.md', target: 'note:C.md' },
    ])

    const afterDelete = buildVaultIndex(
      makeRawIndex({
        files: ['A.md', 'B.md'],
        notes: [
          { path: 'A.md', name: 'A.md', content: 'Agora liga apenas [[C]].' },
          { path: 'B.md', name: 'B.md', content: 'Destino B.' },
        ],
      })
    )
    const graphAfterDelete = buildGraphModel(afterDelete)
    expect(graphAfterDelete.nodes.map((n) => n.path)).toEqual(['A.md', 'B.md'])
    expect(graphAfterDelete.edges).toEqual([])
  })

  it('is deterministic regardless of input note order and never mutates the vault index', () => {
    const notes = [
      { path: 'Z.md', name: 'Z.md', content: '[[A]] [[M]]' },
      { path: 'A.md', name: 'A.md', content: '[[Z]]' },
      { path: 'M.md', name: 'M.md', content: 'Texto' },
    ]
    const index1 = buildVaultIndex(makeRawIndex({ files: ['Z.md', 'A.md', 'M.md'], notes }))
    const index2 = buildVaultIndex(makeRawIndex({ files: ['M.md', 'Z.md', 'A.md'], notes: [...notes].reverse() }))

    const snapshotBefore = JSON.stringify(index1)
    const graph1 = buildGraphModel(index1)
    const graph2 = buildGraphModel(index2)

    expect(graph1).toEqual(graph2)
    expect(JSON.stringify(index1)).toBe(snapshotBefore)
  })
})
