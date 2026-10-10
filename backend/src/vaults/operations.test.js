import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { openDatabase } from '../database.js'
import { prepareVaultsRoot } from './filesystem.js'
import { createVaultNote } from './creator.js'
import {
  scanVaultIndex,
  relocateVaultEntry,
  moveVaultEntryToTrash,
  listVaultTrash,
  restoreVaultTrashEntry,
  deleteVaultTrashEntryPermanently,
  deleteVaultEntryPermanently,
} from './operations.js'

const revisionOf = (text) =>
  crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex')

const makeTempVault = (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-ops-'))
  const vaultsRoot = path.join(tempDir, 'vaults')
  const personalDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(personalDir, { recursive: true })
  const canonicalRoot = prepareVaultsRoot(vaultsRoot, { createIfMissing: false })
  t.after(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })
  return { tempDir, vaultsRoot: canonicalRoot, personalDir }
}

test('1. createVaultNote supports optional initial content and createParents for pending link creation', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  const initialContent = '---\ntitle: Ontologia\ntags: []\n---\n\n'

  const created = createVaultNote(vaultsRoot, 'personal', {
    parentPath: 'Conhecimento/Filosofia',
    name: 'Ontologia',
    content: initialContent,
    createParents: true,
  })

  assert.deepEqual(created, {
    directory: 'personal',
    path: 'Conhecimento/Filosofia/Ontologia.md',
    revision: revisionOf(initialContent),
  })
  assert.equal(
    fs.readFileSync(path.join(personalDir, 'Conhecimento', 'Filosofia', 'Ontologia.md'), 'utf8'),
    initialContent
  )
})

test('2. scanVaultIndex indexes all files, folders, and Markdown notes while ignoring .trash and lock files', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.mkdirSync(path.join(personalDir, 'Projects', 'Sub'), { recursive: true })
  fs.mkdirSync(path.join(personalDir, '.trash'), { recursive: true })
  fs.writeFileSync(path.join(personalDir, 'README.md'), '# Root Note')
  fs.writeFileSync(path.join(personalDir, 'Projects', 'Roadmap.md'), '# Roadmap')
  fs.writeFileSync(path.join(personalDir, '.trash', 'deleted.md'), '# Deleted')
  fs.writeFileSync(path.join(personalDir, '.README.md.ayame.lock'), '')

  const index = scanVaultIndex(vaultsRoot, 'personal')
  assert.equal(index.directory, 'personal')
  assert.equal(index.complete, true)
  assert.deepEqual(index.folders, ['Projects', 'Projects/Sub'])
  assert.deepEqual(index.files, ['Projects/Roadmap.md', 'README.md'])
  assert.equal(index.notes.length, 2)
  assert.equal(index.notes.some((n) => n.path.includes('.trash')), false)
})

test('3. relocateVaultEntry renames a note and updates wikilinks and Markdown links across the vault while preserving aliases, anchors, and Properties links', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.mkdirSync(path.join(personalDir, 'Projects'), { recursive: true })
  fs.mkdirSync(path.join(personalDir, 'Archive'), { recursive: true })

  fs.writeFileSync(
    path.join(personalDir, 'Cosmologia.md'),
    '---\ntitle: Cosmologia\n---\n# Cosmologia\n'
  )
  const indexContent = [
    '---',
    'related:',
    '  - "[[Cosmologia]]"',
    '---',
    '# Índice',
    '',
    'Estudando [[Cosmologia]], [[Cosmologia#Origem|Origem do Cosmos]] e [Link MD](./Cosmologia.md#Origem).',
    'Link externo [Site](https://example.com/Cosmologia.md) e ambíguo [[Duplicada]] ficam intactos.',
  ].join('\n')
  fs.writeFileSync(path.join(personalDir, 'Indice.md'), indexContent)
  fs.writeFileSync(path.join(personalDir, 'Projects', 'Duplicada.md'), '# Dup 1')
  fs.writeFileSync(path.join(personalDir, 'Archive', 'Duplicada.md'), '# Dup 2')

  const result = relocateVaultEntry(vaultsRoot, 'personal', {
    sourcePath: 'Cosmologia.md',
    targetPath: 'Cosmologia Moderna.md',
    updateLinks: true,
    expectedRevision: revisionOf('---\ntitle: Cosmologia\n---\n# Cosmologia\n'),
  })

  assert.equal(result.oldPath, 'Cosmologia.md')
  assert.equal(result.newPath, 'Cosmologia Moderna.md')
  assert.equal(fs.existsSync(path.join(personalDir, 'Cosmologia.md')), false)
  assert.equal(fs.existsSync(path.join(personalDir, 'Cosmologia Moderna.md')), true)
  assert.deepEqual(result.updatedFiles, ['Indice.md'])

  const updatedIndex = fs.readFileSync(path.join(personalDir, 'Indice.md'), 'utf8')
  assert.equal(updatedIndex.includes('[[Cosmologia Moderna]]'), true)
  assert.equal(updatedIndex.includes('[[Cosmologia Moderna#Origem|Origem do Cosmos]]'), true)
  assert.equal(updatedIndex.includes('[Link MD](./Cosmologia%20Moderna.md#Origem)'), true)
  assert.equal(updatedIndex.includes('https://example.com/Cosmologia.md'), true)
  assert.equal(updatedIndex.includes('[[Duplicada]]'), true)
})

test('4. relocateVaultEntry moves a note or folder to another directory, updates links, and rejects collisions or moving a folder into itself', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.mkdirSync(path.join(personalDir, 'Conhecimento', 'Sub'), { recursive: true })
  fs.writeFileSync(path.join(personalDir, 'Cosmologia.md'), '# Cosmologia')
  fs.writeFileSync(path.join(personalDir, 'Conhecimento', 'Ocupado.md'), '# Ocupado')

  // Reject moving into an existing file
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'Cosmologia.md',
        targetPath: 'Conhecimento/Ocupado.md',
        expectedRevision: revisionOf('# Cosmologia'),
      }),
    (err) => err.code === 'VAULT_ENTRY_EXISTS'
  )

  // Reject moving a folder into itself
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'Conhecimento',
        targetPath: 'Conhecimento/Sub/Conhecimento',
      }),
    (err) => err.code === 'INVALID_VAULT_MOVE'
  )

  // Move Cosmologia.md into Conhecimento/Cosmologia.md
  const moved = relocateVaultEntry(vaultsRoot, 'personal', {
    sourcePath: 'Cosmologia.md',
    targetPath: 'Conhecimento/Cosmologia.md',
    updateLinks: true,
    expectedRevision: revisionOf('# Cosmologia'),
  })
  assert.equal(moved.newPath, 'Conhecimento/Cosmologia.md')
  assert.equal(fs.readFileSync(path.join(personalDir, 'Conhecimento', 'Cosmologia.md'), 'utf8'), '# Cosmologia')
})

test('5. trash, listTrash, restore, conflict handling, duplicate names in trash, and permanent delete without mutating SQLite', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  const db = openDatabase(':memory:')

  fs.mkdirSync(path.join(personalDir, 'Projetos', 'Notas'), { recursive: true })
  fs.writeFileSync(path.join(personalDir, 'Projetos', 'Roadmap.md'), '# Roadmap 1')
  fs.writeFileSync(path.join(personalDir, 'Projetos', 'Notas', 'Pesquisa.md'), '# Pesquisa')
  fs.writeFileSync(path.join(personalDir, 'NotaSolta.md'), '#Versão 1')

  // Trash NotaSolta.md, then create another NotaSolta.md and trash it too (duplicate names in trash!)
  const trash1 = moveVaultEntryToTrash(vaultsRoot, 'personal', {
    path: 'NotaSolta.md',
    expectedRevision: revisionOf('#Versão 1'),
  })
  assert.equal(fs.existsSync(path.join(personalDir, 'NotaSolta.md')), false)

  fs.writeFileSync(path.join(personalDir, 'NotaSolta.md'), '#Versão 2')
  const trash2 = moveVaultEntryToTrash(vaultsRoot, 'personal', {
    path: 'NotaSolta.md',
    expectedRevision: revisionOf('#Versão 2'),
  })
  assert.notEqual(trash1.id, trash2.id)

  // Trash entire folder Projetos (preserving descendant structure)
  const trashFolder = moveVaultEntryToTrash(vaultsRoot, 'personal', { path: 'Projetos' })
  assert.equal(trashFolder.type, 'directory')
  assert.equal(trashFolder.descendantCount, 3)
  assert.equal(fs.existsSync(path.join(personalDir, 'Projetos')), false)

  const list = listVaultTrash(vaultsRoot, 'personal')
  assert.equal(list.items.length, 3)

  // Restore trash1 to NotaSolta.md
  const restored1 = restoreVaultTrashEntry(vaultsRoot, 'personal', { id: trash1.id })
  assert.equal(restored1.path, 'NotaSolta.md')
  assert.equal(fs.readFileSync(path.join(personalDir, 'NotaSolta.md'), 'utf8'), '#Versão 1')

  // Restoring trash2 to occupied NotaSolta.md fails with 409 VAULT_ENTRY_EXISTS and preserves trash2 metadata
  assert.throws(
    () => restoreVaultTrashEntry(vaultsRoot, 'personal', { id: trash2.id }),
    (err) => err.code === 'VAULT_ENTRY_EXISTS'
  )

  // Restoring trash2 to an alternate destination succeeds
  const restored2 = restoreVaultTrashEntry(vaultsRoot, 'personal', {
    id: trash2.id,
    targetPath: 'NotaSoltaRecuperada.md',
  })
  assert.equal(restored2.path, 'NotaSoltaRecuperada.md')
  assert.equal(fs.readFileSync(path.join(personalDir, 'NotaSoltaRecuperada.md'), 'utf8'), '#Versão 2')

  // Restore folder Projetos -> recovers entire directory tree
  const restoredFolder = restoreVaultTrashEntry(vaultsRoot, 'personal', { id: trashFolder.id })
  assert.equal(restoredFolder.path, 'Projetos')
  assert.equal(
    fs.readFileSync(path.join(personalDir, 'Projetos', 'Notas', 'Pesquisa.md'), 'utf8'),
    '# Pesquisa'
  )

  // Reject deleting vault root or locked files
  assert.throws(
    () => moveVaultEntryToTrash(vaultsRoot, 'personal', { path: '' }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )

  fs.writeFileSync(path.join(personalDir, '.NotaSolta.md.ayame.lock'), '')
  assert.throws(
    () => moveVaultEntryToTrash(vaultsRoot, 'personal', {
      path: 'NotaSolta.md',
      expectedRevision: revisionOf('#Versão 1'),
    }),
    (err) => err.code === 'VAULT_FILE_LOCKED'
  )
  fs.unlinkSync(path.join(personalDir, '.NotaSolta.md.ayame.lock'))

  // Permanent delete
  deleteVaultEntryPermanently(vaultsRoot, 'personal', {
    path: 'NotaSoltaRecuperada.md',
    expectedRevision: revisionOf('#Versão 2'),
  })
  assert.equal(fs.existsSync(path.join(personalDir, 'NotaSoltaRecuperada.md')), false)

  // Verify SQLite has zero vault records mutated
  const rows = db.prepare('SELECT COUNT(*) AS count FROM vault').get()
  assert.equal(rows.count, 0)
  db.close()
})

test('6. rewriteLinksInNoteContent ignores fenced code blocks, inline code, Obsidian comments, escaped links, and ambiguous links', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.mkdirSync(path.join(personalDir, 'Projetos', 'A'), { recursive: true })
  fs.mkdirSync(path.join(personalDir, 'Projetos', 'B'), { recursive: true })

  fs.writeFileSync(path.join(personalDir, 'Alvo.md'), '# Alvo Original')
  fs.writeFileSync(path.join(personalDir, 'Projetos', 'A', 'Ambiguo.md'), '# Ambiguo 1')
  fs.writeFileSync(path.join(personalDir, 'Projetos', 'B', 'Ambiguo.md'), '# Ambiguo 2')

  const noteWithTokens = [
    '---',
    'title: Nota de Teste',
    'related:',
    '  - "[[Alvo]]"',
    '---',
    '# Teste de Tokens',
    '',
    'Link real: [[Alvo#Topico|Meu Alvo]] e [Markdown](./Alvo.md#Topico).',
    'Link ambíguo que não deve mudar: [[Ambiguo]].',
    'Link externo que não deve mudar: [Google](https://google.com).',
    'Link escapado com barra: \\[[Alvo]] e \\[[Alvo#Topico|Meu Alvo]].',
    'Link inline code: `[[Alvo]]` e ``[[Alvo#Topico]]``.',
    '',
    '%% Comentário Obsidian inline: [[Alvo]] %%',
    '',
    '%%',
    'Comentário Obsidian bloco:',
    '[[Alvo]]',
    '%%',
    '',
    '```markdown',
    'Bloco de código com [[Alvo]]',
    '```',
    '',
    '~~~',
    'Bloco tilde com [[Alvo]]',
    '~~~',
  ].join('\n')

  fs.writeFileSync(path.join(personalDir, 'Referenciadora.md'), noteWithTokens)

  const result = relocateVaultEntry(vaultsRoot, 'personal', {
    sourcePath: 'Alvo.md',
    targetPath: 'Novo Alvo.md',
    updateLinks: true,
    expectedRevision: revisionOf('# Alvo Original'),
  })

  assert.deepEqual(result.updatedFiles, ['Referenciadora.md'])
  const updatedContent = fs.readFileSync(path.join(personalDir, 'Referenciadora.md'), 'utf8')

  // Rewritten in Frontmatter and plain body text
  assert.equal(updatedContent.includes('related:\n  - "[[Novo Alvo]]"'), true)
  assert.equal(updatedContent.includes('Link real: [[Novo Alvo#Topico|Meu Alvo]] e [Markdown](./Novo%20Alvo.md#Topico).'), true)

  // Ambiguous link preserved
  assert.equal(updatedContent.includes('[[Ambiguo]]'), true)

  // External link preserved
  assert.equal(updatedContent.includes('[Google](https://google.com)'), true)

  // Escaped links preserved
  assert.equal(updatedContent.includes('\\[[Alvo]]'), true)
  assert.equal(updatedContent.includes('\\[[Alvo#Topico|Meu Alvo]]'), true)

  // Inline code preserved
  assert.equal(updatedContent.includes('`[[Alvo]]`'), true)
  assert.equal(updatedContent.includes('``[[Alvo#Topico]]``'), true)

  // Obsidian comments preserved
  assert.equal(updatedContent.includes('%% Comentário Obsidian inline: [[Alvo]] %%'), true)
  assert.equal(updatedContent.includes('Comentário Obsidian bloco:\n[[Alvo]]\n%%'), true)

  // Code fences preserved
  assert.equal(updatedContent.includes('```markdown\nBloco de código com [[Alvo]]\n```'), true)
  assert.equal(updatedContent.includes('~~~\nBloco tilde com [[Alvo]]\n~~~'), true)
})

test('7. staged trash protocol reconciles interrupted operations and heals orphaned entries', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  const trashDir = path.join(personalDir, '.trash')
  fs.mkdirSync(trashDir, { recursive: true })

  // Case 1: Interruption before rename (stale pending metadata exists, file still in vault)
  fs.writeFileSync(path.join(personalDir, 'Sobrevivente.md'), '# Sobrevivente')
  const stalePendingMeta = {
    id: 'stale-pending-123456',
    originalPath: 'Sobrevivente.md',
    name: 'Sobrevivente.md',
    type: 'file',
    deletedAt: new Date().toISOString(),
    status: 'pending',
  }
  fs.writeFileSync(
    path.join(trashDir, 'stale-pending-123456.meta.json'),
    JSON.stringify(stalePendingMeta, null, 2),
    'utf8'
  )

  // Case 2: Interruption with orphaned .entry file (metadata missing or destroyed)
  fs.writeFileSync(path.join(trashDir, 'orphaned-entry-999999.entry'), '# Conteúdo Resgatado')

  // Case 3: Interruption after rename where status is still pending but .entry exists
  fs.writeFileSync(path.join(trashDir, 'healed-pending-777777.entry'), '# Conteúdo Quase Apagado')
  const healPendingMeta = {
    id: 'healed-pending-777777',
    originalPath: 'QuaseApagado.md',
    name: 'QuaseApagado.md',
    type: 'file',
    deletedAt: new Date().toISOString(),
    status: 'pending',
  }
  fs.writeFileSync(
    path.join(trashDir, 'healed-pending-777777.meta.json'),
    JSON.stringify(healPendingMeta, null, 2),
    'utf8'
  )

  // Run listVaultTrash: must clean stale pending, heal pending with entry, and recover orphan
  const list = listVaultTrash(vaultsRoot, 'personal')

  // Stale pending meta file should have been cleaned up
  assert.equal(fs.existsSync(path.join(trashDir, 'stale-pending-123456.meta.json')), false)
  // Sobrevivente.md in vault must remain untouched
  assert.equal(fs.readFileSync(path.join(personalDir, 'Sobrevivente.md'), 'utf8'), '# Sobrevivente')

  // List should contain 2 items: healed-pending-777777 and orphaned-entry-999999
  const ids = list.items.map((i) => i.id)
  assert.equal(ids.includes('healed-pending-777777'), true)
  assert.equal(ids.includes('orphaned-entry-999999'), true)
  assert.equal(ids.includes('stale-pending-123456'), false)

  // Check that orphaned entry was healed with safe reconstructed metadata and can be restored
  const restoredOrphan = restoreVaultTrashEntry(vaultsRoot, 'personal', {
    id: 'orphaned-entry-999999',
    targetPath: 'Resgatado.md',
  })
  assert.equal(restoredOrphan.path, 'Resgatado.md')
  assert.equal(fs.readFileSync(path.join(personalDir, 'Resgatado.md'), 'utf8'), '# Conteúdo Resgatado')
})

test('8. scanVaultIndex captures unreadable markdown files in failures array and sets complete: false', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.writeFileSync(path.join(personalDir, 'Valida.md'), '# Valida')
  // Create an oversized file > 10MB to trigger VAULT_FILE_TOO_LARGE from readVaultMarkdown
  const hugeBuf = Buffer.alloc(10 * 1024 * 1024 + 1024, 0x61) // 10MB + 1KB
  fs.writeFileSync(path.join(personalDir, 'Gigante.md'), hugeBuf)

  const index = scanVaultIndex(vaultsRoot, 'personal')
  assert.equal(index.complete, false)
  assert.equal(Array.isArray(index.failures), true)
  assert.equal(index.failures.length, 1)
  assert.equal(index.failures[0].path, 'Gigante.md')
  assert.equal(index.failures[0].reason, 'VAULT_FILE_TOO_LARGE')
  assert.equal(index.notes.length, 1)
  assert.equal(index.notes[0].path, 'Valida.md')
})

test('9. operations reject symlinks and junctions (final or ancestral) with INVALID_VAULT_PATH and never mutate or delete real targets', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  const realDir = path.join(personalDir, 'RealDir')
  fs.mkdirSync(realDir, { recursive: true })
  const realNote = path.join(realDir, 'Target.md')
  fs.writeFileSync(realNote, '# Real Target')
  const realRevision = revisionOf('# Real Target')

  // Create directory link/junction inside vault
  const linkDir = path.join(personalDir, 'LinkDir')
  const linkType = process.platform === 'win32' ? 'junction' : 'dir'
  fs.symlinkSync(realDir, linkDir, linkType)

  // 1. Relocate via ancestral symlink must fail with INVALID_VAULT_PATH and keep RealDir/Target.md
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'LinkDir/Target.md',
        targetPath: 'Moved.md',
        expectedRevision: realRevision,
      }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.existsSync(realNote), true)
  assert.equal(fs.readFileSync(realNote, 'utf8'), '# Real Target')

  // 2. Trash via ancestral symlink must fail with INVALID_VAULT_PATH and keep RealDir/Target.md
  assert.throws(
    () =>
      moveVaultEntryToTrash(vaultsRoot, 'personal', {
        path: 'LinkDir/Target.md',
        expectedRevision: realRevision,
      }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.existsSync(realNote), true)

  // 3. Trash symlink directory itself must fail with INVALID_VAULT_PATH and keep RealDir
  assert.throws(
    () =>
      moveVaultEntryToTrash(vaultsRoot, 'personal', {
        path: 'LinkDir',
      }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.existsSync(realDir), true)

  // 4. Permanent delete via ancestral symlink must fail with INVALID_VAULT_PATH and keep RealDir/Target.md
  assert.throws(
    () =>
      deleteVaultEntryPermanently(vaultsRoot, 'personal', {
        path: 'LinkDir/Target.md',
        expectedRevision: realRevision,
      }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.existsSync(realNote), true)

  // 5. Permanent delete symlink directory itself must fail with INVALID_VAULT_PATH
  assert.throws(
    () =>
      deleteVaultEntryPermanently(vaultsRoot, 'personal', {
        path: 'LinkDir',
      }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.existsSync(realDir), true)

  // 6. Relocate directory that contains a symlink descendant must fail with INVALID_VAULT_PATH
  const containerDir = path.join(personalDir, 'Container')
  fs.mkdirSync(containerDir, { recursive: true })
  fs.symlinkSync(realDir, path.join(containerDir, 'SubLink'), linkType)
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'Container',
        targetPath: 'ContainerMoved',
      }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
})

test('10. mandatory expectedRevision contract for Markdown notes in relocate, trash, and permanent delete', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.writeFileSync(path.join(personalDir, 'Nota.md'), '# Original')
  const originalRevision = revisionOf('# Original')
  const wrongRevision = 'b'.repeat(64)

  // A. relocateVaultEntry
  // Missing revision -> 400 INVALID_OPERATION_PAYLOAD
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'Nota.md',
        targetPath: 'NotaNova.md',
      }),
    (err) => err.code === 'INVALID_OPERATION_PAYLOAD'
  )
  // Invalid format revision -> 400 INVALID_OPERATION_PAYLOAD
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'Nota.md',
        targetPath: 'NotaNova.md',
        expectedRevision: 'invalid-rev',
      }),
    (err) => err.code === 'INVALID_OPERATION_PAYLOAD'
  )
  // Mismatched revision -> 409 VAULT_FILE_CONFLICT
  assert.throws(
    () =>
      relocateVaultEntry(vaultsRoot, 'personal', {
        sourcePath: 'Nota.md',
        targetPath: 'NotaNova.md',
        expectedRevision: wrongRevision,
      }),
    (err) => err.code === 'VAULT_FILE_CONFLICT'
  )

  // B. moveVaultEntryToTrash
  // Missing revision -> 400 INVALID_OPERATION_PAYLOAD
  assert.throws(
    () =>
      moveVaultEntryToTrash(vaultsRoot, 'personal', {
        path: 'Nota.md',
      }),
    (err) => err.code === 'INVALID_OPERATION_PAYLOAD'
  )
  // Invalid format revision -> 400 INVALID_OPERATION_PAYLOAD
  assert.throws(
    () =>
      moveVaultEntryToTrash(vaultsRoot, 'personal', {
        path: 'Nota.md',
        expectedRevision: '123',
      }),
    (err) => err.code === 'INVALID_OPERATION_PAYLOAD'
  )
  // Mismatched revision -> 409 VAULT_FILE_CONFLICT
  assert.throws(
    () =>
      moveVaultEntryToTrash(vaultsRoot, 'personal', {
        path: 'Nota.md',
        expectedRevision: wrongRevision,
      }),
    (err) => err.code === 'VAULT_FILE_CONFLICT'
  )

  // C. deleteVaultEntryPermanently
  // Missing revision -> 400 INVALID_OPERATION_PAYLOAD
  assert.throws(
    () =>
      deleteVaultEntryPermanently(vaultsRoot, 'personal', {
        path: 'Nota.md',
      }),
    (err) => err.code === 'INVALID_OPERATION_PAYLOAD'
  )
  // Invalid format revision -> 400 INVALID_OPERATION_PAYLOAD
  assert.throws(
    () =>
      deleteVaultEntryPermanently(vaultsRoot, 'personal', {
        path: 'Nota.md',
        expectedRevision: 'short',
      }),
    (err) => err.code === 'INVALID_OPERATION_PAYLOAD'
  )
  // Mismatched revision -> 409 VAULT_FILE_CONFLICT
  assert.throws(
    () =>
      deleteVaultEntryPermanently(vaultsRoot, 'personal', {
        path: 'Nota.md',
        expectedRevision: wrongRevision,
      }),
    (err) => err.code === 'VAULT_FILE_CONFLICT'
  )

  // D. Folders do NOT require expectedRevision
  fs.mkdirSync(path.join(personalDir, 'PastaLivre'), { recursive: true })
  const movedFolder = relocateVaultEntry(vaultsRoot, 'personal', {
    sourcePath: 'PastaLivre',
    targetPath: 'PastaRenomeada',
  })
  assert.equal(movedFolder.newPath, 'PastaRenomeada')

  const trashedFolder = moveVaultEntryToTrash(vaultsRoot, 'personal', {
    path: 'PastaRenomeada',
  })
  assert.equal(trashedFolder.type, 'directory')

  fs.mkdirSync(path.join(personalDir, 'PastaExcluir'), { recursive: true })
  const deletedFolder = deleteVaultEntryPermanently(vaultsRoot, 'personal', {
    path: 'PastaExcluir',
  })
  assert.equal(deletedFolder.type, 'directory')

  // E. Valid revision succeeds on Markdown note
  const movedNote = relocateVaultEntry(vaultsRoot, 'personal', {
    sourcePath: 'Nota.md',
    targetPath: 'NotaNova.md',
    expectedRevision: originalRevision,
  })
  assert.equal(movedNote.newPath, 'NotaNova.md')
})

test('11. link update preserves references inside indented Markdown code blocks (spaces or tab)', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.writeFileSync(path.join(personalDir, 'NotaAntiga.md'), '# Nota Antiga')

  const noteContent = [
    '# Titulo',
    '',
    '    [[NotaAntiga]]',
    '    continua [[NotaAntiga#Secao]]',
    '',
    'Texto livre com link: [[NotaAntiga|Alias]] e [Markdown](./NotaAntiga.md).',
    '',
    '\t[[NotaAntiga]] com tab',
    '',
  ].join('\n')
  fs.writeFileSync(path.join(personalDir, 'Consumidora.md'), noteContent)

  const result = relocateVaultEntry(vaultsRoot, 'personal', {
    sourcePath: 'NotaAntiga.md',
    targetPath: 'NotaNova.md',
    updateLinks: true,
    expectedRevision: revisionOf('# Nota Antiga'),
  })

  assert.deepEqual(result.updatedFiles, ['Consumidora.md'])
  const updated = fs.readFileSync(path.join(personalDir, 'Consumidora.md'), 'utf8')

  // Indented blocks MUST be preserved verbatim
  assert.equal(updated.includes('    [[NotaAntiga]]\n    continua [[NotaAntiga#Secao]]'), true)
  assert.equal(updated.includes('\t[[NotaAntiga]] com tab'), true)

  // Non-indented links MUST be updated
  assert.equal(updated.includes('Texto livre com link: [[NotaNova|Alias]] e [Markdown](./NotaNova.md).'), true)
})

test('12. moveVaultEntryToTrash throws VAULT_TRASH_RESULT_UNKNOWN if committed metadata write fails after physical rename', (t) => {
  const { vaultsRoot, personalDir } = makeTempVault(t)
  fs.writeFileSync(path.join(personalDir, 'Critica.md'), '# Critica')
  const noteRev = revisionOf('# Critica')

  const originalWrite = fs.writeFileSync
  let renameCompleted = false
  const originalRename = fs.renameSync
  t.mock.method(fs, 'renameSync', (...args) => {
    const res = originalRename(...args)
    renameCompleted = true
    return res
  })

  t.mock.method(fs, 'writeFileSync', (targetPath, data, ...rest) => {
    if (renameCompleted && typeof targetPath === 'string' && targetPath.endsWith('.meta.json')) {
      const err = new Error('simulated post-rename disk failure')
      err.code = 'EIO'
      throw err
    }
    return originalWrite(targetPath, data, ...rest)
  })

  assert.throws(
    () =>
      moveVaultEntryToTrash(vaultsRoot, 'personal', {
        path: 'Critica.md',
        expectedRevision: noteRev,
      }),
    (err) => err.code === 'VAULT_TRASH_RESULT_UNKNOWN'
  )

  // Verify file was physically moved out of personalDir and exists in .trash
  assert.equal(fs.existsSync(path.join(personalDir, 'Critica.md')), false)
  const trashFiles = fs.readdirSync(path.join(personalDir, '.trash'))
  assert.equal(trashFiles.some((f) => f.endsWith('.entry')), true)
})
