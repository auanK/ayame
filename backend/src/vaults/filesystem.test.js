import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  prepareVaultsRoot,
  resolveVaultRoot,
  resolveExistingVaultPath,
  findExactDirectoryEntry,
} from './filesystem.js'

test('prepareVaultsRoot: 1. missing default root can be created when createIfMissing = true', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-1-'))
  const missingRoot = path.join(tempDir, 'data', 'vaults')

  try {
    const prepared = prepareVaultsRoot(missingRoot, { createIfMissing: true })
    assert.ok(fs.existsSync(missingRoot))
    assert.ok(fs.statSync(missingRoot).isDirectory())
    assert.equal(prepared, fs.realpathSync.native(missingRoot))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 2. nested parents are created when needed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-2-'))
  const deeplyNested = path.join(tempDir, 'level1', 'level2', 'vaults')

  try {
    const prepared = prepareVaultsRoot(deeplyNested, { createIfMissing: true })
    assert.ok(fs.existsSync(deeplyNested))
    assert.equal(prepared, fs.realpathSync.native(deeplyNested))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 3. returned root is canonical absolute directory', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-3-'))

  try {
    const prepared = prepareVaultsRoot(tempDir, { createIfMissing: false })
    assert.ok(path.isAbsolute(prepared))
    assert.equal(prepared, fs.realpathSync.native(tempDir))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 4. existing normal directory is accepted', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-4-'))
  const normalDir = path.join(tempDir, 'vaults')
  fs.mkdirSync(normalDir)

  try {
    const prepared = prepareVaultsRoot(normalDir, { createIfMissing: false })
    assert.equal(prepared, fs.realpathSync.native(normalDir))
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 5. missing explicit root with create disabled fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-5-'))
  const missingRoot = path.join(tempDir, 'not-there')

  try {
    assert.throws(
      () => prepareVaultsRoot(missingRoot, { createIfMissing: false }),
      (err) => err.code === 'INVALID_VAULT_ROOT'
    )
    assert.equal(fs.existsSync(missingRoot), false)
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 6. regular file fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-6-'))
  const regularFile = path.join(tempDir, 'file.txt')
  fs.writeFileSync(regularFile, 'not a dir')

  try {
    assert.throws(
      () => prepareVaultsRoot(regularFile, { createIfMissing: false }),
      (err) => err.code === 'INVALID_VAULT_ROOT'
    )
    assert.throws(
      () => prepareVaultsRoot(regularFile, { createIfMissing: true }),
      (err) => err.code === 'INVALID_VAULT_ROOT'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 7. NUL-containing input fails', () => {
  assert.throws(
    () => prepareVaultsRoot('/some/path\0', { createIfMissing: true }),
    (err) => err.code === 'INVALID_VAULT_ROOT'
  )
  assert.throws(
    () => prepareVaultsRoot(null, { createIfMissing: true }),
    (err) => err.code === 'INVALID_VAULT_ROOT'
  )
  assert.throws(
    () => prepareVaultsRoot('', { createIfMissing: true }),
    (err) => err.code === 'INVALID_VAULT_ROOT'
  )
})

test('prepareVaultsRoot: 8. filesystem root fails', () => {
  const root = path.parse(process.cwd()).root // '/' on POSIX, 'C:\' on Windows
  assert.throws(
    () => prepareVaultsRoot(root, { createIfMissing: false }),
    (err) => err.code === 'INVALID_VAULT_ROOT'
  )
})

test('prepareVaultsRoot: 9. root symlink fails where symlink creation is supported', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-9-'))
  const targetDir = path.join(tempDir, 'target')
  const symlinkPath = path.join(tempDir, 'symlink-root')
  fs.mkdirSync(targetDir)

  try {
    fs.symlinkSync(targetDir, symlinkPath, 'dir')
  } catch {
    t.skip('Symlink creation not permitted in this environment')
    fs.rmSync(tempDir, { recursive: true, force: true })
    return
  }

  try {
    assert.throws(
      () => prepareVaultsRoot(symlinkPath, { createIfMissing: false }),
      (err) => err.code === 'INVALID_VAULT_ROOT'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('prepareVaultsRoot: 10. preparation never writes anything outside the requested root hierarchy', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-prep-10-'))
  const sentinelFile = path.join(tempDir, 'sentinel.txt')
  fs.writeFileSync(sentinelFile, 'untouched')
  const targetRoot = path.join(tempDir, 'sub', 'vaults')

  try {
    prepareVaultsRoot(targetRoot, { createIfMissing: true })
    assert.equal(fs.readFileSync(sentinelFile, 'utf8'), 'untouched')
    const siblings = fs.readdirSync(tempDir)
    assert.deepEqual(siblings.sort(), ['sentinel.txt', 'sub'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveVaultRoot validates direct child directory', () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-root-'))
  const canonicalRoot = fs.realpathSync.native(vaultsRoot)
  try {
    const personalDir = path.join(vaultsRoot, 'personal')
    fs.mkdirSync(personalDir)
    const canonicalPersonal = fs.realpathSync.native(personalDir)

    // Valid child
    assert.equal(resolveVaultRoot(vaultsRoot, 'personal'), canonicalPersonal)

    // Missing directory
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'missing'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )

    // Regular file (not a directory)
    fs.writeFileSync(path.join(vaultsRoot, 'readme.txt'), 'hi')
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'readme.txt'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )

    // Traversal or nested path
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, '../outside'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'personal/sub'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'personal\\sub'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )

    // NUL byte
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'personal\0'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )

    // Empty or non-string
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, ''),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, null),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
  } finally {
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('resolveVaultRoot rejects symlink vault roots', (t) => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-symlink-root-'))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-outside-'))
  try {
    const symlinkPath = path.join(vaultsRoot, 'linked')
    try {
      fs.symlinkSync(outsideDir, symlinkPath, 'dir')
    } catch {
      t.skip('Symlink creation not permitted in this environment')
      return
    }

    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'linked'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
  } finally {
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('resolveVaultRoot requires exact physical directory name and rejects case mismatched alias on case-insensitive filesystems', () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-case-'))
  try {
    const physicalName = 'Personal'
    fs.mkdirSync(path.join(vaultsRoot, physicalName))

    // Exact name must resolve cleanly
    const canonical = resolveVaultRoot(vaultsRoot, 'Personal')
    assert.equal(canonical, fs.realpathSync.native(path.join(vaultsRoot, 'Personal')))

    // Mismatched case ('personal') must be rejected with INVALID_VAULT_DIRECTORY
    assert.throws(
      () => resolveVaultRoot(vaultsRoot, 'personal'),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
  } finally {
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('case-distinct sibling directories can coexist where filesystem supports them', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-case-siblings-'))
  try {
    try {
      fs.mkdirSync(path.join(tempDir, 'Foo'))
      fs.mkdirSync(path.join(tempDir, 'foo'))
    } catch {
      // Host filesystem is case-insensitive (e.g. Windows/macOS default)
      return
    }

    const resolvedUpper = resolveVaultRoot(tempDir, 'Foo')
    const resolvedLower = resolveVaultRoot(tempDir, 'foo')
    assert.notEqual(resolvedUpper, resolvedLower)
    assert.equal(path.basename(resolvedUpper), 'Foo')
    assert.equal(path.basename(resolvedLower), 'foo')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('findExactDirectoryEntry matches only exact string equality and requires directory without symlink', () => {
  const fakeEntries = [
    { name: 'Personal', isDirectory: () => true, isSymbolicLink: () => false },
    { name: 'symlink-dir', isDirectory: () => true, isSymbolicLink: () => true },
    { name: 'file.txt', isDirectory: () => false, isSymbolicLink: () => false },
  ]

  assert.equal(findExactDirectoryEntry(fakeEntries, 'Personal')?.name, 'Personal')
  assert.equal(findExactDirectoryEntry(fakeEntries, 'personal'), null)
  assert.equal(findExactDirectoryEntry(fakeEntries, 'symlink-dir'), null)
  assert.equal(findExactDirectoryEntry(fakeEntries, 'file.txt'), null)
  assert.equal(findExactDirectoryEntry(fakeEntries, 'non-existent'), null)
  assert.equal(findExactDirectoryEntry(null, 'Personal'), null)
  assert.equal(findExactDirectoryEntry([], 123), null)
})

test('resolveExistingVaultPath resolves valid existing files and nested directories', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-valid-'))
  const canonicalRoot = fs.realpathSync.native(tempDir)
  try {
    const noteFile = path.join(tempDir, 'note.md')
    fs.writeFileSync(noteFile, '# Note')
    const subDir = path.join(tempDir, 'notes')
    fs.mkdirSync(subDir)
    const nestedNote = path.join(subDir, 'foo.md')
    fs.writeFileSync(nestedNote, '# Foo')

    const res1 = resolveExistingVaultPath(canonicalRoot, 'note.md')
    assert.equal(res1.absolutePath, fs.realpathSync.native(noteFile))
    assert.equal(res1.type, 'file')

    const res2 = resolveExistingVaultPath(canonicalRoot, 'notes/foo.md')
    assert.equal(res2.absolutePath, fs.realpathSync.native(nestedNote))
    assert.equal(res2.type, 'file')

    const res3 = resolveExistingVaultPath(canonicalRoot, 'notes')
    assert.equal(res3.absolutePath, fs.realpathSync.native(subDir))
    assert.equal(res3.type, 'directory')
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveExistingVaultPath rejects invalid paths and cross-platform traversal fail-closed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-fs-invalid-'))
  const canonicalRoot = fs.realpathSync.native(tempDir)
  try {
    // Missing target -> VAULT_PATH_NOT_FOUND
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, 'missing.md'),
      (err) => err.code === 'VAULT_PATH_NOT_FOUND'
    )

    // Absolute POSIX path
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, '/etc/passwd'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )

    // Absolute Windows-style path
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, 'C:\\Windows\\system32'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, '\\Windows\\system32'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )

    // Traversal: .. with POSIX and Windows separators
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, '..'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, '../outside'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, '..\\outside'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, 'notes/../../outside'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, 'notes\\..\\..\\outside'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )

    // NUL byte
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, 'note.md\0'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )

    // Empty or non-string
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, ''),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalRoot, null),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('resolveExistingVaultPath prevents sibling-prefix containment trick', () => {
  const baseTemp = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-sibling-base-'))
  const vaultDir = path.join(baseTemp, 'personal')
  const siblingDir = path.join(baseTemp, 'personal2')
  fs.mkdirSync(vaultDir)
  fs.mkdirSync(siblingDir)
  fs.writeFileSync(path.join(siblingDir, 'secret.txt'), 'secret')

  const canonicalVault = fs.realpathSync.native(vaultDir)
  try {
    assert.throws(
      () => resolveExistingVaultPath(canonicalVault, '../personal2/secret.txt'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(canonicalVault, '..\\personal2\\secret.txt'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    fs.rmSync(baseTemp, { recursive: true, force: true })
  }
})

test('resolveExistingVaultPath prevents descendant symlink escape', (t) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-desc-vault-'))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-desc-outside-'))
  fs.writeFileSync(path.join(outsideDir, 'outside-secret.txt'), 'secret')

  const symlinkPath = path.join(vaultDir, 'escape')
  try {
    fs.symlinkSync(outsideDir, symlinkPath, 'dir')
  } catch {
    t.skip('Symlink creation not permitted in this environment')
    fs.rmSync(vaultDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
    return
  }

  const canonicalVault = fs.realpathSync.native(vaultDir)
  try {
    assert.throws(
      () => resolveExistingVaultPath(canonicalVault, 'escape/outside-secret.txt'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('resolveExistingVaultPath allows internal-contained symlink', (t) => {
  const vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-internal-symlink-'))
  const canonicalVault = fs.realpathSync.native(vaultDir)
  const notesDir = path.join(vaultDir, 'notes')
  fs.mkdirSync(notesDir)
  const targetFile = path.join(notesDir, 'foo.md')
  fs.writeFileSync(targetFile, '# Contained')

  const linkPath = path.join(vaultDir, 'current')
  try {
    fs.symlinkSync(notesDir, linkPath, 'dir')
  } catch {
    t.skip('Symlink creation not permitted in this environment')
    fs.rmSync(vaultDir, { recursive: true, force: true })
    return
  }

  try {
    const res = resolveExistingVaultPath(canonicalVault, 'current/foo.md')
    assert.equal(res.absolutePath, fs.realpathSync.native(targetFile))
    assert.equal(res.type, 'file')
  } finally {
    fs.rmSync(vaultDir, { recursive: true, force: true })
  }
})
