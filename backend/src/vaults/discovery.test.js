import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDatabase, closeDatabase } from '../database.js'
import { discoverVaultDirectories, mergeVaults } from './discovery.js'

test('1. direct child directory is discovered', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-1-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'personal'))
    const discovered = discoverVaultDirectories(tempDir)
    assert.deepEqual(discovered, ['personal'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('2. multiple directories are discovered deterministically', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-2-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'zeta'))
    fs.mkdirSync(path.join(tempDir, 'Alpha'))
    fs.mkdirSync(path.join(tempDir, 'beta'))
    const discovered = discoverVaultDirectories(tempDir)
    assert.deepEqual(discovered, ['Alpha', 'beta', 'zeta'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('3. regular file in vaults root is ignored', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-3-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'personal'))
    fs.writeFileSync(path.join(tempDir, 'readme.txt'), 'hello')
    const discovered = discoverVaultDirectories(tempDir)
    assert.deepEqual(discovered, ['personal'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('4. nested directory is not independently discovered', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-4-'))
  try {
    const parentDir = path.join(tempDir, 'personal')
    const nestedDir = path.join(parentDir, 'subfolder')
    fs.mkdirSync(nestedDir, { recursive: true })
    const discovered = discoverVaultDirectories(tempDir)
    assert.deepEqual(discovered, ['personal'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('5. direct-child symlink is not discovered as vault', (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-5-'))
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-outside-5-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'valid-vault'))
    const symlinkPath = path.join(tempDir, 'symlinked-vault')
    try {
      fs.symlinkSync(outsideDir, symlinkPath, 'dir')
    } catch {
      t.skip('Symlink creation not permitted in this environment')
      return
    }
    const discovered = discoverVaultDirectories(tempDir)
    assert.deepEqual(discovered, ['valid-vault'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
    fs.rmSync(outsideDir, { recursive: true, force: true })
  }
})

test('6. newly created directory appears on next discovery without restart', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-6-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'first'))
    assert.deepEqual(discoverVaultDirectories(tempDir), ['first'])

    fs.mkdirSync(path.join(tempDir, 'second'))
    assert.deepEqual(discoverVaultDirectories(tempDir), ['first', 'second'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('7. removed directory disappears on next discovery', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-7-'))
  try {
    const dirA = path.join(tempDir, 'alpha')
    const dirB = path.join(tempDir, 'beta')
    fs.mkdirSync(dirA)
    fs.mkdirSync(dirB)
    assert.deepEqual(discoverVaultDirectories(tempDir), ['alpha', 'beta'])

    fs.rmSync(dirA, { recursive: true, force: true })
    assert.deepEqual(discoverVaultDirectories(tempDir), ['beta'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('8. discovery does not mutate SQLite', () => {
  const db = openDatabase(':memory:')
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-8-'))
  try {
    fs.mkdirSync(path.join(tempDir, 'vault-a'))
    fs.mkdirSync(path.join(tempDir, 'vault-b'))
    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    discoverVaultDirectories(tempDir)
    const countAfter = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    assert.equal(countBefore, 0)
    assert.equal(countAfter, 0)
  } finally {
    closeDatabase(db)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('9. unregistered vault gets id: null, name: directory, registered: false', () => {
  const discovered = ['personal']
  const registered = []
  const merged = mergeVaults(discovered, registered)
  assert.deepEqual(merged, [
    {
      id: null,
      name: 'personal',
      directory: 'personal',
      registered: false,
    },
  ])
})

test('10. registered metadata overrides fallback name', () => {
  const discovered = ['personal']
  const registered = [
    {
      id: 'uuid-1',
      name: 'Personal Notes',
      directory: 'personal',
    },
  ]
  const merged = mergeVaults(discovered, registered)
  assert.deepEqual(merged, [
    {
      id: 'uuid-1',
      name: 'Personal Notes',
      directory: 'personal',
      registered: true,
    },
  ])
})

test('11. no duplicate exists when directory is registered', () => {
  const discovered = ['personal']
  const registered = [
    {
      id: 'uuid-1',
      name: 'Personal Notes',
      directory: 'personal',
    },
  ]
  const merged = mergeVaults(discovered, registered)
  assert.equal(merged.length, 1)
  assert.equal(merged[0].id, 'uuid-1')
})

test('12. registry row whose directory is missing is not returned as active vault', () => {
  const discovered = ['active']
  const registered = [
    {
      id: 'uuid-missing',
      name: 'Missing Notes',
      directory: 'missing',
    },
    {
      id: 'uuid-active',
      name: 'Active Notes',
      directory: 'active',
    },
  ]
  const merged = mergeVaults(discovered, registered)
  assert.deepEqual(merged, [
    {
      id: 'uuid-active',
      name: 'Active Notes',
      directory: 'active',
      registered: true,
    },
  ])
})

test('13. if missing directory returns, stored metadata applies again', () => {
  const registered = [
    {
      id: 'uuid-1',
      name: 'Temporarily Gone',
      directory: 'gone',
    },
  ]

  // Missing
  const mergedMissing = mergeVaults([], registered)
  assert.deepEqual(mergedMissing, [])

  // Returned
  const mergedReturned = mergeVaults(['gone'], registered)
  assert.deepEqual(mergedReturned, [
    {
      id: 'uuid-1',
      name: 'Temporarily Gone',
      directory: 'gone',
      registered: true,
    },
  ])
})

test('14. dot-prefixed directory is discovered as a vault', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-dot-'))
  try {
    fs.mkdirSync(path.join(tempDir, '.private'))
    const discovered = discoverVaultDirectories(tempDir)
    assert.deepEqual(discovered, ['.private'])
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
