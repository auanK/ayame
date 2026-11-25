import { describe, expect, it } from 'vitest'
import {
  resolveLink,
  parseWikilink,
  classifyLinkDestination,
  findHeadingOffset,
  findBlockOffset,
  extractHeadings,
  extractBlocks,
  extractNoteReferences,
  resolvePendingLinkCreationTarget,
  formatInternalLink,
} from './links.js'

const knownFiles = [
  'README.md',
  'Nota.md',
  'Projects/Roadmap.md',
  'Projects/Design.md',
  'Projects/Spec.markdown',
  'Projects/Sub/Deep.md',
  'Archive/Design.md',
  'Notas Pessoais/Arquitetura 🌸.md',
]

describe('Markdown & Wikilink resolution (links.js)', () => {
  it('resolves simple wikilinks with and without .md extension', () => {
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Nota]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Nota.md',
    })

    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Nota.md]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Nota.md',
    })

    // Unique match in subfolder when not in current directory
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Roadmap]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
    })

    // Supports .markdown extension
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Spec]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Spec.markdown',
    })
  })

  it('resolves wikilinks with explicit vault-root paths', () => {
    expect(resolveLink({
      sourcePath: 'Projects/Sub/Deep.md',
      linkTarget: '[[Projects/Roadmap]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
    })

    expect(resolveLink({
      sourcePath: 'Projects/Sub/Deep.md',
      linkTarget: '[[Projects/Roadmap.md]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
    })
  })

  it('resolves wikilinks with display aliases', () => {
    const parsed = parseWikilink('[[Projects/Roadmap|Roadmap do projeto]]')
    expect(parsed).toEqual({
      target: 'Projects/Roadmap',
      alias: 'Roadmap do projeto',
      anchor: null,
      displayText: 'Roadmap do projeto',
    })

    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Projects/Roadmap|Roadmap do projeto]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
    })
  })

  it('resolves relative Markdown links from the current note directory', () => {
    expect(resolveLink({
      sourcePath: 'Projects/Roadmap.md',
      linkTarget: './Design.md',
      knownFiles,
      kind: 'markdown',
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Design.md',
    })

    expect(resolveLink({
      sourcePath: 'Projects/Sub/Deep.md',
      linkTarget: '../Design.md',
      knownFiles,
      kind: 'markdown',
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Design.md',
    })

    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: 'Projects/Design.md',
      knownFiles,
      kind: 'markdown',
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Design.md',
    })
  })

  it('supports Unicode, spaces, and percent-encoded paths', () => {
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Notas Pessoais/Arquitetura 🌸]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Notas Pessoais/Arquitetura 🌸.md',
    })

    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: 'Notas%20Pessoais/Arquitetura%20%F0%9F%8C%B8.md',
      knownFiles,
      kind: 'markdown',
    })).toEqual({
      type: 'resolved',
      path: 'Notas Pessoais/Arquitetura 🌸.md',
    })
  })

  it('resolves links with heading anchors including same-note anchors', () => {
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Roadmap#Objetivos]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
      anchor: 'Objetivos',
    })

    expect(resolveLink({
      sourcePath: 'Projects/Design.md',
      linkTarget: 'Roadmap.md#Objetivos',
      knownFiles,
      kind: 'markdown',
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
      anchor: 'Objetivos',
    })

    expect(resolveLink({
      sourcePath: 'Projects/Roadmap.md',
      linkTarget: '[[#Introdução]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
      anchor: 'Introdução',
    })
  })

  it('returns missing when target note does not exist', () => {
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Inexistente]]',
      knownFiles,
    })).toEqual({
      type: 'missing',
    })

    expect(resolveLink({
      sourcePath: 'Projects/Roadmap.md',
      linkTarget: './NaoExiste.md',
      knownFiles,
      kind: 'markdown',
    })).toEqual({
      type: 'missing',
    })
  })

  it('prefers local directory match for bare wikilinks and reports ambiguous when multiple non-local candidates exist', () => {
    // From Projects/Roadmap.md, [[Design]] matches Projects/Design.md locally even though Archive/Design.md also exists
    expect(resolveLink({
      sourcePath: 'Projects/Roadmap.md',
      linkTarget: '[[Design]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Design.md',
    })

    // From README.md (root), [[Design]] has two candidates in subfolders and neither is at root
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Design]]',
      knownFiles,
    })).toEqual({
      type: 'ambiguous',
      candidates: ['Archive/Design.md', 'Projects/Design.md'],
    })
  })

  it('rejects directory escape attempts, absolute server paths, and unsupported file extensions as invalid', () => {
    for (const invalidTarget of [
      '../outside.md',
      '../../secret.md',
      '/etc/passwd',
      'C:/Windows/win.ini',
      'Projects\\Roadmap.md',
      '[[../escape]]',
      '[[/absolute/note.md]]',
      '[[file.txt]]',
      './image.png',
      'javascript:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'vbscript:msgbox(1)',
      'https://example.com/remote.md',
      '%E0%A4%A',
      '',
      '   ',
    ]) {
      expect(resolveLink({
        sourcePath: 'README.md',
        linkTarget: invalidTarget,
        knownFiles,
      })).toEqual({ type: 'invalid' })
    }
  })

  it('classifies external HTTP/HTTPS links vs internal vs malicious links', () => {
    expect(classifyLinkDestination('https://example.com/docs')).toEqual({
      type: 'external',
      href: 'https://example.com/docs',
    })
    expect(classifyLinkDestination('http://example.com')).toEqual({
      type: 'external',
      href: 'http://example.com',
    })
    expect(classifyLinkDestination('javascript:alert(1)')).toEqual({
      type: 'invalid',
    })
    expect(classifyLinkDestination('./Roadmap.md')).toEqual({
      type: 'internal',
      target: './Roadmap.md',
    })
  })

  it('locates heading offset in Markdown document for anchor navigation', () => {
    const doc = '# Título Principal\n\nTexto.\n\n## Objetivos\n\n- Meta 1\n\n### Introdução Geral\n'
    expect(findHeadingOffset(doc, 'Objetivos')).toEqual({
      line: 5,
      from: doc.indexOf('## Objetivos'),
    })
    expect(findHeadingOffset(doc, 'introducao-geral')).toEqual({
      line: 9,
      from: doc.indexOf('### Introdução Geral'),
    })
    expect(findHeadingOffset(doc, 'Inexistente')).toBeNull()
  })

  it('resolves block references [[Nota#^identificador]] and locates block offsets in Markdown', () => {
    const parsed = parseWikilink('[[Roadmap#^meta-principal|Meta Principal]]')
    expect(parsed).toMatchObject({
      target: 'Roadmap',
      alias: 'Meta Principal',
      anchor: '^meta-principal',
      blockId: 'meta-principal',
    })

    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Roadmap#^meta-principal]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
      anchor: '^meta-principal',
      blockId: 'meta-principal',
    })

    expect(resolveLink({
      sourcePath: 'Projects/Roadmap.md',
      linkTarget: '[[#^meta-principal]]',
      knownFiles,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
      anchor: '^meta-principal',
      blockId: 'meta-principal',
    })

    const doc = [
      '# Roadmap',
      '',
      'Esta é a definição fundamental do universo. ^def-universo',
      '',
      '- Item importante ^item-1',
    ].join('\n')

    const blocks = extractBlocks(doc)
    expect(blocks.map((b) => b.id)).toEqual(['def-universo', 'item-1'])

    const hit = findBlockOffset(doc, '^def-universo')
    expect(hit).toMatchObject({
      id: 'def-universo',
      line: 3,
      from: doc.indexOf('Esta é a definição'),
    })
  })

  it('resolves links via frontmatter aliases and distinguishes incomplete index (unverified) from missing', () => {
    const aliasesByFile = {
      'Projects/Roadmap.md': ['Plano Diretor', 'Cronograma 2026'],
    }

    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[Plano Diretor]]',
      knownFiles,
      aliasesByFile,
    })).toEqual({
      type: 'resolved',
      path: 'Projects/Roadmap.md',
    })

    // When index is not complete yet, an unknown target is marked 'unverified', NOT 'missing'
    expect(resolveLink({
      sourcePath: 'README.md',
      linkTarget: '[[AindaNaoIndexada]]',
      knownFiles: ['README.md'],
      indexComplete: false,
    })).toEqual({
      type: 'unverified',
    })
  })

  it('calculates safe target creation path when opening a pending link', () => {
    // Bare wikilink defaults to vault root or configured newNoteFolder
    expect(resolvePendingLinkCreationTarget({
      linkTarget: '[[Cosmologia]]',
      sourcePath: 'Projects/Roadmap.md',
    })).toEqual({
      parentPath: '',
      name: 'Cosmologia.md',
      path: 'Cosmologia.md',
      anchor: null,
    })

    // Bare wikilink with same-folder setting
    expect(resolvePendingLinkCreationTarget({
      linkTarget: '[[Leis Universais#Origem]]',
      sourcePath: 'Projects/Roadmap.md',
      newNoteLocation: 'current',
    })).toEqual({
      parentPath: 'Projects',
      name: 'Leis Universais.md',
      path: 'Projects/Leis Universais.md',
      anchor: 'Origem',
    })

    // Explicit nested path in wikilink
    expect(resolvePendingLinkCreationTarget({
      linkTarget: '[[Conhecimento/Filosofia/Ontologia|Ontologia]]',
      sourcePath: 'README.md',
    })).toEqual({
      parentPath: 'Conhecimento/Filosofia',
      name: 'Ontologia.md',
      path: 'Conhecimento/Filosofia/Ontologia.md',
      anchor: null,
    })

    // Relative Markdown link
    expect(resolvePendingLinkCreationTarget({
      linkTarget: '../NovaPasta/Teoria.md',
      sourcePath: 'Projects/Sub/Deep.md',
      kind: 'markdown',
    })).toEqual({
      parentPath: 'Projects/NovaPasta',
      name: 'Teoria.md',
      path: 'Projects/NovaPasta/Teoria.md',
      anchor: null,
    })
  })

  it('formats internal links according to Obsidian link format settings (shortest, relative, absolute, wikilink vs markdown)', () => {
    expect(formatInternalLink({
      sourcePath: 'README.md',
      targetPath: 'Projects/Roadmap.md',
      allFiles: knownFiles,
      format: 'shortest',
      useWikilinks: true,
    })).toBe('[[Roadmap]]')

    // Design.md exists in both Projects/ and Archive/, so shortest must disambiguate with path
    expect(formatInternalLink({
      sourcePath: 'README.md',
      targetPath: 'Projects/Design.md',
      allFiles: knownFiles,
      format: 'shortest',
      useWikilinks: true,
    })).toBe('[[Projects/Design]]')

    expect(formatInternalLink({
      sourcePath: 'Projects/Sub/Deep.md',
      targetPath: 'Projects/Roadmap.md',
      allFiles: knownFiles,
      format: 'relative',
      useWikilinks: false,
      alias: 'Plano',
    })).toBe('[Plano](../Roadmap.md)')

    expect(formatInternalLink({
      sourcePath: 'Projects/Roadmap.md',
      targetPath: 'Notas Pessoais/Arquitetura 🌸.md',
      allFiles: knownFiles,
      format: 'absolute',
      useWikilinks: false,
    })).toBe('[Arquitetura 🌸](Notas%20Pessoais/Arquitetura%20%F0%9F%8C%B8.md)')
  })

  it('extracts all outgoing references from both Properties and Markdown body while ignoring code blocks and comments', () => {
    const md = [
      '---',
      'title: Cosmologia',
      'related:',
      '  - "[[Física]]"',
      '  - "[[Leis Universais|Leis]]"',
      'parent: "[[Conhecimento/Índice]]"',
      '---',
      '# Cosmologia',
      '',
      'Veja [[Teoria da Informação#Entropia]] e [Roadmap](Projects/Roadmap.md).',
      'Embed: ![[Diagrama#^bloco-1]].',
      '%% Comentário ignorado [[LinkIgnorado]] %%',
      '`[[CodigoInlineIgnorado]]`',
      '```md',
      '[[BlocoDeCodigoIgnorado]]',
      '```',
    ].join('\n')

    const refs = extractNoteReferences(md, 'Cosmologia.md')
    expect(refs.map((r) => ({ target: r.target, location: r.location, isEmbed: r.isEmbed }))).toEqual([
      { target: 'Física', location: 'property', isEmbed: false },
      { target: 'Leis Universais', location: 'property', isEmbed: false },
      { target: 'Conhecimento/Índice', location: 'property', isEmbed: false },
      { target: 'Teoria da Informação', location: 'body', isEmbed: false },
      { target: 'Projects/Roadmap.md', location: 'body', isEmbed: false },
      { target: 'Diagrama', location: 'body', isEmbed: true },
    ])

    const headings = extractHeadings(md)
    expect(headings).toEqual([{ level: 1, text: 'Cosmologia', line: 8, from: md.indexOf('# Cosmologia') }])
  })
})
