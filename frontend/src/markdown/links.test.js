import { describe, expect, it } from 'vitest'
import {
  resolveLink,
  parseWikilink,
  classifyLinkDestination,
  findHeadingOffset,
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
})
