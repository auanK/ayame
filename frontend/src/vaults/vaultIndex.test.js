import { describe, expect, it } from 'vitest'
import {
  buildVaultIndex,
  updateNoteInVaultIndex,
  getBacklinksForNote,
  getOutgoingLinksForNote,
  getNotesByTag,
  searchVaultNotes,
} from './vaultIndex.js'

describe('vaultIndex — Obsidian vault-wide graph, backlinks, outgoing links, tags, and search', () => {
  const sampleRawIndex = {
    directory: 'personal',
    complete: true,
    folders: ['Conhecimento', 'Conhecimento/Filosofia'],
    files: [
      'Conhecimento/Filosofia/Cosmologia.md',
      'Indice.md',
      'Notas Soltas.md',
    ],
    notes: [
      {
        path: 'Conhecimento/Filosofia/Cosmologia.md',
        name: 'Cosmologia.md',
        revision: 'a'.repeat(64),
        content: [
          '---',
          'title: Estudo do Cosmos',
          'aliases:',
          '  - Universo',
          'tags:',
          '  - conhecimento/filosofia',
          'published: true',
          '---',
          '# Origem',
          '',
          'Conceito fundamental ^bloco-1',
          '',
          'Veja também [[Indice]] e [[Nota Futura]].',
        ].join('\n'),
      },
      {
        path: 'Indice.md',
        name: 'Indice.md',
        revision: 'b'.repeat(64),
        content: [
          '---',
          'title: Índice Geral',
          'related:',
          '  - "[[Universo]]"',
          '---',
          '# Índice',
          '',
          'Referência direta para [[Cosmologia#Origem|Origem do Cosmos]] e bloco [[Cosmologia#^bloco-1]].',
          'Tag inline #conhecimento/fisica aqui.',
        ].join('\n'),
      },
      {
        path: 'Notas Soltas.md',
        name: 'Notas Soltas.md',
        revision: 'c'.repeat(64),
        content: 'Esta nota menciona Estudo do Cosmos no texto sem link explícito.\nLink pendente: [[Nota Futura]].',
      },
    ],
  }

  it('1. builds a complete index with aliases, known properties, headings, blocks, and tags', () => {
    const index = buildVaultIndex(sampleRawIndex)
    expect(index.complete).toBe(true)
    expect(index.aliasesByFile['Conhecimento/Filosofia/Cosmologia.md']).toEqual(['Universo'])
    expect(index.knownPropertyNames).toEqual(['aliases', 'published', 'related', 'tags', 'title'])
    expect(index.knownPropertyTypes.published).toBe('checkbox')
    expect(index.headingsByFile['Conhecimento/Filosofia/Cosmologia.md']).toEqual([
      expect.objectContaining({ level: 1, text: 'Origem' }),
    ])
    expect(index.blocksByFile['Conhecimento/Filosofia/Cosmologia.md']).toEqual([
      expect.objectContaining({ id: 'bloco-1' }),
    ])
  })

  it('2. computes resolved and unresolved outgoing links and backlinks (including aliases and Properties links)', () => {
    const index = buildVaultIndex(sampleRawIndex)

    const outgoingCosmo = getOutgoingLinksForNote(index, 'Conhecimento/Filosofia/Cosmologia.md')
    expect(outgoingCosmo.resolved.map((item) => item.targetPath)).toEqual(['Indice.md'])
    expect(outgoingCosmo.unresolved.map((item) => item.rawTarget)).toEqual(['Nota Futura'])

    const backlinksCosmo = getBacklinksForNote(index, 'Conhecimento/Filosofia/Cosmologia.md')
    // Indice.md links to Cosmologia via alias [[Universo]] in frontmatter and [[Cosmologia#Origem]] + [[Cosmologia#^bloco-1]] in body
    expect(backlinksCosmo.linked.some((b) => b.sourcePath === 'Indice.md' && b.inFrontmatter)).toBe(true)
    expect(backlinksCosmo.linked.some((b) => b.sourcePath === 'Indice.md' && b.heading === 'Origem')).toBe(true)
    // Notas Soltas.md mentions "Estudo do Cosmos" without link
    expect(backlinksCosmo.unlinkedMentions.some((m) => m.sourcePath === 'Notas Soltas.md')).toBe(true)
  })

  it('3. filters notes by hierarchical tag query case-insensitively and updates when a note is edited', () => {
    const index = buildVaultIndex(sampleRawIndex)
    const byParentTag = getNotesByTag(index, '#conhecimento')
    expect(byParentTag.map((n) => n.path)).toEqual([
      'Conhecimento/Filosofia/Cosmologia.md',
      'Indice.md',
    ])

    const bySubTag = getNotesByTag(index, '#conhecimento/filosofia')
    expect(bySubTag.map((n) => n.path)).toEqual(['Conhecimento/Filosofia/Cosmologia.md'])

    // Live update when Nota Futura.md is created or edited
    const updatedIndex = updateNoteInVaultIndex(index, {
      path: 'Nota Futura.md',
      name: 'Nota Futura.md',
      content: '---\ntitle: Nota Futura\n---\nAgora existo!\n',
      revision: 'd'.repeat(64),
    })

    const outgoingAfter = getOutgoingLinksForNote(updatedIndex, 'Conhecimento/Filosofia/Cosmologia.md')
    expect(outgoingAfter.unresolved).toEqual([])
    expect(outgoingAfter.resolved.map((r) => r.targetPath)).toContain('Nota Futura.md')

    const backlinksNewNote = getBacklinksForNote(updatedIndex, 'Nota Futura.md')
    expect(backlinksNewNote.linked.map((b) => b.sourcePath)).toEqual([
      'Conhecimento/Filosofia/Cosmologia.md',
      'Notas Soltas.md',
    ])
  })

  it('4. searches notes by filename, title, alias, tag, and body content', () => {
    const index = buildVaultIndex(sampleRawIndex)
    expect(searchVaultNotes(index, 'Universo')[0].path).toBe('Conhecimento/Filosofia/Cosmologia.md')
    expect(searchVaultNotes(index, 'bloco-1')[0].path).toBe('Conhecimento/Filosofia/Cosmologia.md')
    expect(searchVaultNotes(index, 'Indice')[0].path).toBe('Indice.md')
  })

  it('5. models partial index with failures, sets complete: false, and resolves missing targets as unverified', () => {
    const partialRawIndex = {
      directory: 'personal',
      complete: true, // raw complete flag is true but failures exist
      failures: [{ path: 'Notas/Corrompida.md', reason: 'INVALID_FILE_ENCODING' }],
      folders: [],
      files: ['Indice.md'],
      notes: [
        {
          path: 'Indice.md',
          name: 'Indice.md',
          content: 'Link para [[Nota Desconhecida]].',
        },
      ],
    }

    const index = buildVaultIndex(partialRawIndex)
    expect(index.complete).toBe(false)
    expect(index.failures).toEqual([{ path: 'Notas/Corrompida.md', reason: 'INVALID_FILE_ENCODING' }])

    const outgoing = getOutgoingLinksForNote(index, 'Indice.md')
    expect(outgoing.unresolved).toHaveLength(1)
    expect(outgoing.unresolved[0].status).toBe('unverified')
  })
})
