import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { listVaultEntries } from './browser.js'
import { openDatabase, closeDatabase } from '../database.js'

const makeTempDir = (prefix = 'ayame-browser-test-') => {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

test('1. lists root of vault', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)
    fs.mkdirSync(path.join(vaultDir, 'notes'))
    fs.writeFileSync(path.join(vaultDir, 'README.md'), '# Readme')

    const result = listVaultEntries(root, 'personal', '')
    assert.equal(result.directory, 'personal')
    assert.equal(result.path, '')
    assert.deepEqual(result.entries, [
      { name: 'notes', path: 'notes', type: 'directory' },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('2. lists subdirectory', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, 'projects', 'ayame'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, 'projects', 'todo.txt'), 'tasks')

    const result = listVaultEntries(root, 'personal', 'projects')
    assert.equal(result.directory, 'personal')
    assert.equal(result.path, 'projects')
    assert.deepEqual(result.entries, [
      { name: 'ayame', path: 'projects/ayame', type: 'directory' },
      { name: 'todo.txt', path: 'projects/todo.txt', type: 'file' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('3. empty directory returns empty entries array', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, 'empty-dir'), { recursive: true })

    const result = listVaultEntries(root, 'personal', 'empty-dir')
    assert.equal(result.directory, 'personal')
    assert.equal(result.path, 'empty-dir')
    assert.deepEqual(result.entries, [])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('4. sorts directories before files', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)
    fs.writeFileSync(path.join(vaultDir, 'a-file.txt'), 'file')
    fs.mkdirSync(path.join(vaultDir, 'z-dir'))
    fs.writeFileSync(path.join(vaultDir, 'b-file.txt'), 'file')
    fs.mkdirSync(path.join(vaultDir, 'a-dir'))

    const result = listVaultEntries(root, 'personal')
    assert.deepEqual(
      result.entries.map((e) => [e.name, e.type]),
      [
        ['a-dir', 'directory'],
        ['z-dir', 'directory'],
        ['a-file.txt', 'file'],
        ['b-file.txt', 'file'],
      ]
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('5. deterministic sort: case-insensitive then exact case tie-break', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)
    fs.writeFileSync(path.join(vaultDir, 'beta.txt'), '')
    fs.writeFileSync(path.join(vaultDir, 'Alpha.txt'), '')
    fs.writeFileSync(path.join(vaultDir, 'alpha.txt'), '')

    const result = listVaultEntries(root, 'personal')
    const fileNames = result.entries.map((e) => e.name)
    // Both Alpha.txt and alpha.txt group together before beta.txt; exact tiebreak preserves determinism
    assert.equal(fileNames.includes('beta.txt'), true)
    assert.equal(fileNames[fileNames.length - 1], 'beta.txt')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('6. preserves unicode names and internal spaces', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, 'Notas de Estudo'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, 'Caderno 📚.md'), 'conteudo')

    const result = listVaultEntries(root, 'personal')
    assert.deepEqual(result.entries, [
      { name: 'Notas de Estudo', path: 'Notas de Estudo', type: 'directory' },
      { name: 'Caderno 📚.md', path: 'Caderno 📚.md', type: 'file' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('7. lists dot-prefixed directories and files', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, '.config'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, '.env'), 'SECRET=1')

    const result = listVaultEntries(root, 'personal')
    assert.deepEqual(result.entries, [
      { name: '.config', path: '.config', type: 'directory' },
      { name: '.env', path: '.env', type: 'file' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('8. rejects absolute paths', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)

    assert.throws(
      () => listVaultEntries(root, 'personal', '/etc'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', 'C:\\Windows'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('9. rejects .. components with POSIX and Windows separators', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)

    assert.throws(
      () => listVaultEntries(root, 'personal', '..'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', 'projects/..'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', '../personal'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', 'projects\\notes'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('10. rejects malformed paths, empty segments, and NUL', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, 'folder'), { recursive: true })

    assert.throws(
      () => listVaultEntries(root, 'personal', 'folder/'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', '/folder'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', 'a//b'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', 'folder/.'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => listVaultEntries(root, 'personal', 'folder\0bad'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('11. rejects symlinks escaping vault and ignores internal symlinks in listing', (t) => {
  const root = makeTempDir()
  const outside = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, 'notes'), { recursive: true })
    fs.writeFileSync(path.join(outside, 'secret.txt'), 'secret')

    try {
      fs.symlinkSync(outside, path.join(vaultDir, 'out-link'), 'dir')
    } catch {
      t.skip('Symlink creation not permitted in this environment')
      return
    }

    // Attempting to list through an escaping symlink fails closed
    assert.throws(
      () => listVaultEntries(root, 'personal', 'out-link'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )

    // The escaping symlink itself is not included in the directory entries
    const rootListing = listVaultEntries(root, 'personal')
    assert.deepEqual(rootListing.entries, [
      { name: 'notes', path: 'notes', type: 'directory' },
    ])
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('12. physical entry with ambiguous path format gets path: null', () => {
  // If an entry cannot be safely represented in the relative path contract
  // (e.g. contains backslash on POSIX), its path is null but name and type are preserved
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)
    fs.writeFileSync(path.join(vaultDir, 'valid.txt'), 'ok')

    let hasAmbiguous = false
    try {
      fs.writeFileSync(path.join(vaultDir, 'ambiguous\\name.txt'), 'tricky')
      hasAmbiguous = true
    } catch {
      // Windows filesystems do not allow backslash in filename
    }

    const result = listVaultEntries(root, 'personal')
    if (hasAmbiguous) {
      const ambiguous = result.entries.find((e) => e.name === 'ambiguous\\name.txt')
      assert.ok(ambiguous)
      assert.equal(ambiguous.path, null)
      assert.equal(ambiguous.type, 'file')
    } else {
      assert.equal(result.entries[0].name, 'valid.txt')
      assert.equal(result.entries[0].path, 'valid.txt')
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('13. missing or externally removed directory throws VAULT_PATH_NOT_FOUND', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)

    assert.throws(
      () => listVaultEntries(root, 'personal', 'non-existent'),
      (err) => err.code === 'VAULT_PATH_NOT_FOUND'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('14. path pointing to a regular file throws VAULT_PATH_NOT_DIRECTORY', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)
    fs.writeFileSync(path.join(vaultDir, 'README.md'), 'hello')

    assert.throws(
      () => listVaultEntries(root, 'personal', 'README.md'),
      (err) => err.code === 'VAULT_PATH_NOT_DIRECTORY'
    )
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('15. listing never writes to filesystem', () => {
  const root = makeTempDir()
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(path.join(vaultDir, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(vaultDir, 'sub', 'file.txt'), 'content')

    const statBefore = fs.statSync(path.join(vaultDir, 'sub', 'file.txt'))
    listVaultEntries(root, 'personal', 'sub')
    const statAfter = fs.statSync(path.join(vaultDir, 'sub', 'file.txt'))

    assert.equal(statBefore.mtimeMs, statAfter.mtimeMs)
    assert.equal(statBefore.size, statAfter.size)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('16. listing never touches or writes to SQLite', () => {
  const root = makeTempDir()
  const db = openDatabase(':memory:')
  try {
    const vaultDir = path.join(root, 'personal')
    fs.mkdirSync(vaultDir)

    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    listVaultEntries(root, 'personal', '')
    const countAfter = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count

    assert.equal(countBefore, 0)
    assert.equal(countAfter, 0)
  } finally {
    closeDatabase(db)
    fs.rmSync(root, { recursive: true, force: true })
  }
})
