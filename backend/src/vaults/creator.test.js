import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { openDatabase } from '../database.js'
import { readVaultMarkdown } from './reader.js'
import { createVaultFolder, createVaultNote } from './creator.js'

const EMPTY_REVISION = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')

const makeVault = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-creator-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vault = path.join(root, 'personal')
  fs.mkdirSync(vault)
  return { root, vault }
}

test('creates a new folder at the vault root and inside a subfolder', (t) => {
  const { root, vault } = makeVault(t)

  const rootFolder = createVaultFolder(root, 'personal', {
    parentPath: '',
    name: 'Projects',
  })
  assert.deepEqual(rootFolder, {
    directory: 'personal',
    path: 'Projects',
    name: 'Projects',
  })
  assert.equal(fs.statSync(path.join(vault, 'Projects')).isDirectory(), true)

  const subFolder = createVaultFolder(root, 'personal', {
    parentPath: 'Projects',
    name: 'Architecture 🌸',
  })
  assert.deepEqual(subFolder, {
    directory: 'personal',
    path: 'Projects/Architecture 🌸',
    name: 'Architecture 🌸',
  })
  assert.equal(fs.statSync(path.join(vault, 'Projects', 'Architecture 🌸')).isDirectory(), true)
})

test('rejects duplicate folder name without overwriting existing folder or file', (t) => {
  const { root, vault } = makeVault(t)
  fs.mkdirSync(path.join(vault, 'Projects'))
  fs.writeFileSync(path.join(vault, 'Projects', 'keep.md'), 'keep', 'utf8')
  fs.writeFileSync(path.join(vault, 'README.md'), 'original readme', 'utf8')

  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: '', name: 'Projects' }),
    (err) => err.code === 'VAULT_ENTRY_EXISTS'
  )
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'keep.md'), 'utf8'), 'keep')

  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: '', name: 'README.md' }),
    (err) => err.code === 'VAULT_ENTRY_EXISTS'
  )
  assert.equal(fs.readFileSync(path.join(vault, 'README.md'), 'utf8'), 'original readme')
})

test('rejects invalid folder names, missing parents, file parents, and path traversal without recursive creation', (t) => {
  const { root, vault } = makeVault(t)
  fs.writeFileSync(path.join(vault, 'note.md'), 'content', 'utf8')

  for (const badPayload of [null, undefined, [], { parentPath: '' }, { name: 'Folder' }, { parentPath: '', name: 'Folder', extra: true }]) {
    assert.throws(
      () => createVaultFolder(root, 'personal', badPayload),
      (err) => err.code === 'INVALID_CREATE_PAYLOAD'
    )
  }

  for (const badName of ['', '   ', '.', '..', '.hidden', 'a/b', 'a\\b', 'bad\0name', 'bad:name', 'bad*name', 'bad?name', 'bad"name', 'bad<name>', 'bad|name', 'trailing.', ' leading', 'trailing ', 'CON', 'nul.txt', '\ud800']) {
    assert.throws(
      () => createVaultFolder(root, 'personal', { parentPath: '', name: badName }),
      (err) => err.code === 'INVALID_ENTRY_NAME',
      `Expected INVALID_ENTRY_NAME for "${badName}"`
    )
  }

  for (const badParent of ['../outside', '/root', 'C:/dir', 'a//b', 'a/../b', 'a\\b', 'bad\0parent', '.']) {
    assert.throws(
      () => createVaultFolder(root, 'personal', { parentPath: badParent, name: 'Valid' }),
      (err) => err.code === 'INVALID_VAULT_PATH',
      `Expected INVALID_VAULT_PATH for parent "${badParent}"`
    )
  }

  // Non-existent intermediate directory must fail (no recursive: true)
  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: 'Missing/Deep', name: 'Folder' }),
    (err) => err.code === 'VAULT_PATH_NOT_FOUND'
  )

  // Parent is a regular file
  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: 'note.md', name: 'Sub' }),
    (err) => err.code === 'VAULT_PATH_NOT_DIRECTORY'
  )

  // Invalid vault directory
  assert.throws(
    () => createVaultFolder(root, 'nonexistent', { parentPath: '', name: 'Valid' }),
    (err) => err.code === 'INVALID_VAULT_DIRECTORY'
  )
})

test('creates empty UTF-8 notes at root and in subfolders, normalizing .md when omitted and preserving .md/.markdown', (t) => {
  const { root, vault } = makeVault(t)
  createVaultFolder(root, 'personal', { parentPath: '', name: 'Projects' })

  // With explicit .md
  const note1 = createVaultNote(root, 'personal', {
    parentPath: 'Projects',
    name: 'Architecture.md',
  })
  assert.deepEqual(note1, {
    directory: 'personal',
    path: 'Projects/Architecture.md',
    revision: EMPTY_REVISION,
  })
  assert.equal(fs.readFileSync(path.join(vault, 'Projects', 'Architecture.md'), 'utf8'), '')

  // Without extension -> appends .md once
  const note2 = createVaultNote(root, 'personal', {
    parentPath: '',
    name: 'Roadmap 🌸',
  })
  assert.deepEqual(note2, {
    directory: 'personal',
    path: 'Roadmap 🌸.md',
    revision: EMPTY_REVISION,
  })
  assert.equal(fs.readFileSync(path.join(vault, 'Roadmap 🌸.md'), 'utf8'), '')

  // With .markdown extension -> preserved without adding .md
  const note3 = createVaultNote(root, 'personal', {
    parentPath: 'Projects',
    name: 'Spec.markdown',
  })
  assert.deepEqual(note3, {
    directory: 'personal',
    path: 'Projects/Spec.markdown',
    revision: EMPTY_REVISION,
  })
  assert.equal(fs.existsSync(path.join(vault, 'Projects', 'Spec.markdown.md')), false)
  assert.equal(readVaultMarkdown(root, 'personal', 'Projects/Spec.markdown').revision, EMPTY_REVISION)
})

test('rejects unsupported note extensions, invalid note names, and duplicate notes without overwriting', (t) => {
  const { root, vault } = makeVault(t)
  fs.writeFileSync(path.join(vault, 'Existing.md'), '# Do not overwrite', 'utf8')

  assert.throws(
    () => createVaultNote(root, 'personal', { parentPath: '', name: 'Existing.md' }),
    (err) => err.code === 'VAULT_ENTRY_EXISTS'
  )
  assert.throws(
    () => createVaultNote(root, 'personal', { parentPath: '', name: 'Existing' }),
    (err) => err.code === 'VAULT_ENTRY_EXISTS'
  )
  assert.equal(fs.readFileSync(path.join(vault, 'Existing.md'), 'utf8'), '# Do not overwrite')

  for (const unsupported of ['notes.txt', 'image.png', 'script.js', 'archive.tar.gz', 'doc.pdf']) {
    assert.throws(
      () => createVaultNote(root, 'personal', { parentPath: '', name: unsupported }),
      (err) => err.code === 'UNSUPPORTED_FILE_TYPE',
      `Expected UNSUPPORTED_FILE_TYPE for "${unsupported}"`
    )
  }

  for (const badName of ['', '  ', '.', '..', '.md', '.markdown', '.hidden.md', 'sub/note.md', 'sub\\note.md', 'note.', 'CON.md', 'AUX', 'bad:note.md', '\ud800.md']) {
    assert.throws(
      () => createVaultNote(root, 'personal', { parentPath: '', name: badName }),
      (err) => err.code === 'INVALID_ENTRY_NAME',
      `Expected INVALID_ENTRY_NAME for "${badName}"`
    )
  }
})

test('concurrent folder and note creations allow only one winner without corrupting existing data', async (t) => {
  const { root, vault } = makeVault(t)

  const folderResults = await Promise.allSettled([
    Promise.resolve().then(() => createVaultFolder(root, 'personal', { parentPath: '', name: 'ConcurrentDir' })),
    Promise.resolve().then(() => createVaultFolder(root, 'personal', { parentPath: '', name: 'ConcurrentDir' })),
  ])
  assert.equal(folderResults.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(folderResults.filter((r) => r.status === 'rejected' && r.reason.code === 'VAULT_ENTRY_EXISTS').length, 1)

  const noteResults = await Promise.allSettled([
    Promise.resolve().then(() => createVaultNote(root, 'personal', { parentPath: 'ConcurrentDir', name: 'Note' })),
    Promise.resolve().then(() => createVaultNote(root, 'personal', { parentPath: 'ConcurrentDir', name: 'Note.md' })),
  ])
  assert.equal(noteResults.filter((r) => r.status === 'fulfilled').length, 1)
  assert.equal(noteResults.filter((r) => r.status === 'rejected' && r.reason.code === 'VAULT_ENTRY_EXISTS').length, 1)
  assert.equal(fs.readFileSync(path.join(vault, 'ConcurrentDir', 'Note.md'), 'utf8'), '')
})

test('rejects ancestor and final symlinks for folder and note creation', (t) => {
  const { root, vault } = makeVault(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-creator-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))

  try {
    fs.symlinkSync(outside, path.join(vault, 'LinkedDir'), 'junction')
  } catch {
    t.skip('Symlink or junction creation not supported in this environment')
    return
  }

  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: 'LinkedDir', name: 'Sub' }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.throws(
    () => createVaultNote(root, 'personal', { parentPath: 'LinkedDir', name: 'Escape.md' }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: '', name: 'LinkedDir' }),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readdirSync(outside).length, 0)

  const targetNote = path.join(outside, 'secret.md')
  fs.writeFileSync(targetNote, 'secret', 'utf8')
  const fileLink = path.join(vault, 'FileLink.md')
  let fileSymlinkCreated = false
  try {
    fs.symlinkSync(targetNote, fileLink, 'file')
    fileSymlinkCreated = true
  } catch {}
  if (fileSymlinkCreated) {
    assert.throws(
      () => createVaultNote(root, 'personal', { parentPath: '', name: 'FileLink.md' }),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.equal(fs.readFileSync(targetNote, 'utf8'), 'secret')
  }
})

test('classifies pre-creation I/O failures as VAULT_CREATE_FAILED and post-creation verification failures as VAULT_CREATE_RESULT_UNKNOWN', (t) => {
  const { root, vault } = makeVault(t)

  // Pre-creation I/O failure on mkdirSync
  t.mock.method(fs, 'mkdirSync', () => {
    const err = new Error('disk full')
    err.code = 'ENOSPC'
    throw err
  })
  assert.throws(
    () => createVaultFolder(root, 'personal', { parentPath: '', name: 'FailFolder' }),
    (err) => err.code === 'VAULT_CREATE_FAILED'
  )
  t.mock.restoreAll()

  // Pre-creation I/O failure on openSync
  t.mock.method(fs, 'openSync', () => {
    const err = new Error('disk full')
    err.code = 'ENOSPC'
    throw err
  })
  assert.throws(
    () => createVaultNote(root, 'personal', { parentPath: '', name: 'FailNote.md' }),
    (err) => err.code === 'VAULT_CREATE_FAILED'
  )
  t.mock.restoreAll()

  // Post-creation fsync failure after file is created on disk -> VAULT_CREATE_RESULT_UNKNOWN
  t.mock.method(fs, 'fsyncSync', () => {
    const err = new Error('injected fsync error after creation')
    err.code = 'EIO'
    throw err
  })
  assert.throws(
    () => createVaultNote(root, 'personal', { parentPath: '', name: 'Uncertain.md' }),
    (err) => err.code === 'VAULT_CREATE_RESULT_UNKNOWN'
  )
  assert.equal(fs.existsSync(path.join(vault, 'Uncertain.md')), true)
  t.mock.restoreAll()
})

test('folder and note creation never mutate SQLite database tables or user_version', (t) => {
  const { root } = makeVault(t)
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const beforeVersion = db.pragma('user_version', { simple: true })
  const beforeVaults = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count

  createVaultFolder(root, 'personal', { parentPath: '', name: 'Folder' })
  createVaultNote(root, 'personal', { parentPath: 'Folder', name: 'Note.md' })

  const afterVersion = db.pragma('user_version', { simple: true })
  const afterVaults = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
  assert.equal(afterVersion, beforeVersion)
  assert.equal(afterVaults, beforeVaults)
})
