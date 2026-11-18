import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDatabase, closeDatabase } from '../database.js'
import {
  validVaultName,
  registerVault,
  createVault,
  updateVaultMetadata,
  reorderVaults,
  setVaultCover,
  getVaultCover,
  clearVaultCover,
  listRegisteredVaults,
  listVaults,
  unregisterVault,
} from './registry.js'

test('validVaultName enforces name contract', () => {
  assert.equal(validVaultName('Personal'), true)
  assert.equal(validVaultName('Programming'), true)
  assert.equal(validVaultName('Histórias'), true)
  assert.equal(validVaultName('日本語'), true)
  assert.equal(validVaultName('My Vault'), true)
  assert.equal(validVaultName('a'.repeat(100)), true)

  assert.equal(validVaultName(''), false)
  assert.equal(validVaultName('   '), false)
  assert.equal(validVaultName(' Personal'), false)
  assert.equal(validVaultName('Personal '), false)
  assert.equal(validVaultName('\tPersonal'), false)
  assert.equal(validVaultName('Personal\n'), false)
  assert.equal(validVaultName('a'.repeat(101)), false)
  assert.equal(validVaultName(null), false)
  assert.equal(validVaultName(undefined), false)
  assert.equal(validVaultName(123), false)
  assert.equal(validVaultName({}), false)
})

test('registerVault registers vault and stores metadata', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-reg-test-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))

  try {
    const vault = registerVault(db, vaultsRoot, {
      name: 'Personal Vault',
      directory: 'personal',
    })

    assert.ok(typeof vault.id === 'string' && vault.id.length > 0)
    assert.equal(vault.name, 'Personal Vault')
    assert.equal(vault.directory, 'personal')

    const registered = listRegisteredVaults(db)
    assert.equal(registered.length, 1)
    assert.deepEqual(registered[0], vault)

    const list = listVaults(db, vaultsRoot)
    assert.equal(list.length, 1)
    assert.deepEqual(list[0], {
      id: vault.id,
      name: 'Personal Vault',
      directory: 'personal',
      registered: true,
      position: null,
      category: '',
      tags: [],
      description: '',
      accentColor: '',
      pinned: false,
      hasCover: false,
      coverUpdatedAt: null,
      noteCount: 0,
      lastModifiedAt: null,
    })
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('registerVault rejects invalid name with INVALID_VAULT_NAME', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-invalid-name-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))

  try {
    assert.throws(
      () => registerVault(db, vaultsRoot, { name: '  spaces  ', directory: 'personal' }),
      (err) => err.code === 'INVALID_VAULT_NAME'
    )
    assert.throws(
      () => registerVault(db, vaultsRoot, { name: '', directory: 'personal' }),
      (err) => err.code === 'INVALID_VAULT_NAME'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('registerVault rejects non-existing directory with INVALID_VAULT_DIRECTORY', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-missing-dir-'))

  try {
    assert.throws(
      () => registerVault(db, vaultsRoot, { name: 'Missing', directory: 'missing' }),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('registerVault rejects differently-cased directory alias with INVALID_VAULT_DIRECTORY', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-reg-case-'))
  fs.mkdirSync(path.join(vaultsRoot, 'Personal'))

  try {
    const registered = registerVault(db, vaultsRoot, {
      name: 'Primary',
      directory: 'Personal',
    })
    assert.equal(registered.directory, 'Personal')

    // Mismatched case alias 'personal' must fail with INVALID_VAULT_DIRECTORY, not VAULT_ALREADY_REGISTERED
    assert.throws(
      () => registerVault(db, vaultsRoot, { name: 'Duplicate', directory: 'personal' }),
      (err) => err.code === 'INVALID_VAULT_DIRECTORY'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('registerVault rejects duplicate directory with VAULT_ALREADY_REGISTERED', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-dup-test-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))

  try {
    registerVault(db, vaultsRoot, { name: 'First', directory: 'personal' })

    assert.throws(
      () => registerVault(db, vaultsRoot, { name: 'Second', directory: 'personal' }),
      (err) => err.code === 'VAULT_ALREADY_REGISTERED'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('duplicate registration across independent database connections allows only one winner', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-dup-conn-reg-'))
  const dbPath = path.join(tempDir, 'dup-conn.sqlite')
  const vaultsRoot = path.join(tempDir, 'vaults')
  fs.mkdirSync(vaultsRoot)
  fs.mkdirSync(path.join(vaultsRoot, 'shared'))

  try {
    const initDb = openDatabase(dbPath)
    closeDatabase(initDb)

    const db1 = openDatabase(dbPath)
    const db2 = openDatabase(dbPath)

    try {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => registerVault(db1, vaultsRoot, { name: 'Vault A', directory: 'shared' })),
        Promise.resolve().then(() => registerVault(db2, vaultsRoot, { name: 'Vault B', directory: 'shared' })),
      ])

      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')

      assert.equal(fulfilled.length, 1)
      assert.equal(rejected.length, 1)
      assert.equal(rejected[0].reason?.code, 'VAULT_ALREADY_REGISTERED')

      const vaults = listRegisteredVaults(db1)
      assert.equal(vaults.length, 1)
    } finally {
      closeDatabase(db1)
      closeDatabase(db2)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('listVaults provides deterministic order by name case-insensitively then directory', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-list-order-'))
  fs.mkdirSync(path.join(vaultsRoot, 'dir-z'))
  fs.mkdirSync(path.join(vaultsRoot, 'dir-a'))
  fs.mkdirSync(path.join(vaultsRoot, 'dir-b'))

  try {
    registerVault(db, vaultsRoot, { name: 'zebra', directory: 'dir-z' })
    registerVault(db, vaultsRoot, { name: 'Apple', directory: 'dir-a' })
    registerVault(db, vaultsRoot, { name: 'banana', directory: 'dir-b' })

    const list = listVaults(db, vaultsRoot)
    assert.deepEqual(
      list.map((v) => v.name),
      ['Apple', 'banana', 'zebra']
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('unregister regression: unregistering removes metadata only and falls back to discovered vault', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-unreg-regress-'))
  const personalDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(personalDir)
  const sentinelFile = path.join(personalDir, 'sentinel.txt')
  fs.writeFileSync(sentinelFile, 'important sentinel contents')

  try {
    // 1. Register personal directory with custom name
    const vault = registerVault(db, vaultsRoot, { name: 'Personal Notes', directory: 'personal' })
    const listBefore = listVaults(db, vaultsRoot)
    assert.equal(listBefore.length, 1)
    assert.deepEqual(listBefore[0], {
      id: vault.id,
      name: 'Personal Notes',
      directory: 'personal',
      registered: true,
      position: null,
      category: '',
      tags: [],
      description: '',
      accentColor: '',
      pinned: false,
      hasCover: false,
      coverUpdatedAt: null,
      noteCount: 0,
      lastModifiedAt: null,
    })

    // 2. Unregister vault
    unregisterVault(db, vault.id)

    // 3. Physical directory and sentinel MUST remain untouched
    assert.ok(fs.existsSync(personalDir))
    assert.ok(fs.statSync(personalDir).isDirectory())
    assert.ok(fs.existsSync(sentinelFile))
    assert.equal(fs.readFileSync(sentinelFile, 'utf8'), 'important sentinel contents')

    // 4. Next list STILL contains personal, now unregistered with fallback name and id null
    const listAfter = listVaults(db, vaultsRoot)
    assert.equal(listAfter.length, 1)
    assert.deepEqual(listAfter[0], {
      id: null,
      name: 'personal',
      directory: 'personal',
      registered: false,
      position: null,
      category: '',
      tags: [],
      description: '',
      accentColor: '',
      pinned: false,
      hasCover: false,
      coverUpdatedAt: null,
      noteCount: 0,
      lastModifiedAt: null,
    })

    // 5. Idempotent unregister does not throw or mutate
    unregisterVault(db, vault.id)
    unregisterVault(db, 'non-existent-uuid')
    const listIdempotent = listVaults(db, vaultsRoot)
    assert.equal(listIdempotent.length, 1)
    assert.equal(listIdempotent[0].id, null)
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('createVault creates physical directory, optional Welcome.md, and registers v2 metadata', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-create-vault-'))

  try {
    const created = createVault(db, vaultsRoot, {
      name: 'Estudos RPG',
      category: 'Criatividade',
      tags: ['#mundo', 'campanha', '#Mundo'],
      description: 'Notas de campanha e lore',
      accentColor: '#a99aca',
      pinned: true,
      createWelcomeNote: true,
    })

    assert.equal(created.name, 'Estudos RPG')
    assert.equal(created.directory, 'Estudos RPG')
    assert.equal(created.registered, true)
    assert.equal(created.category, 'Criatividade')
    assert.deepEqual(created.tags, ['mundo', 'campanha'])
    assert.equal(created.description, 'Notas de campanha e lore')
    assert.equal(created.accentColor, '#a99aca')
    assert.equal(created.pinned, true)
    assert.equal(fs.existsSync(path.join(vaultsRoot, 'Estudos RPG', 'Welcome.md')), true)

    const list = listVaults(db, vaultsRoot)
    assert.equal(list[0].noteCount, 1)

    assert.throws(
      () => createVault(db, vaultsRoot, { name: 'Outro', directory: 'Estudos RPG' }),
      (err) => err.code === 'VAULT_ALREADY_EXISTS'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('updateVaultMetadata upserts unregistered vaults and updates partial fields safely', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-patch-vault-'))
  fs.mkdirSync(path.join(vaultsRoot, 'work'))

  try {
    const first = updateVaultMetadata(db, vaultsRoot, 'work', {
      category: 'Trabalho',
      tags: ['projetos', '2026'],
      pinned: true,
    })
    assert.equal(first.registered, true)
    assert.equal(first.name, 'work')
    assert.equal(first.category, 'Trabalho')
    assert.deepEqual(first.tags, ['projetos', '2026'])
    assert.equal(first.pinned, true)

    const second = updateVaultMetadata(db, vaultsRoot, 'work', {
      name: 'Work Hub',
      accentColor: '#8ccff0',
    })
    assert.equal(second.id, first.id)
    assert.equal(second.name, 'Work Hub')
    assert.equal(second.category, 'Trabalho')
    assert.equal(second.accentColor, '#8ccff0')
    assert.equal(second.pinned, true)

    assert.throws(
      () => updateVaultMetadata(db, vaultsRoot, 'work', { accentColor: 'not-a-color' }),
      (err) => err.code === 'INVALID_VAULT_COLOR'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('reorderVaults persists explicit card positions including unregistered vaults', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-reorder-vaults-'))
  fs.mkdirSync(path.join(vaultsRoot, 'alpha'))
  fs.mkdirSync(path.join(vaultsRoot, 'beta'))
  fs.mkdirSync(path.join(vaultsRoot, 'gamma'))

  try {
    const ordered = reorderVaults(db, vaultsRoot, ['gamma', 'alpha', 'beta'])
    assert.deepEqual(ordered.map((v) => v.directory), ['gamma', 'alpha', 'beta'])
    assert.deepEqual(ordered.map((v) => v.position), [0, 1, 2])

    const persisted = listVaults(db, vaultsRoot)
    assert.deepEqual(persisted.map((v) => v.directory), ['gamma', 'alpha', 'beta'])
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('cover photo helpers verify magic bytes, store, retrieve, and clear covers safely', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-cover-vault-'))
  fs.mkdirSync(path.join(vaultsRoot, 'notes'))
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00])

  try {
    assert.throws(
      () => setVaultCover(db, vaultsRoot, 'notes', Buffer.from('<svg></svg>')),
      (err) => err.code === 'UNSUPPORTED_IMAGE_TYPE'
    )

    const updated = setVaultCover(db, vaultsRoot, 'notes', pngHeader)
    assert.equal(updated.hasCover, true)
    assert.ok(typeof updated.coverUpdatedAt === 'number')

    const cover = getVaultCover(db, vaultsRoot, 'notes')
    assert.equal(cover.mimeType, 'image/png')
    assert.deepEqual(cover.buffer, pngHeader)

    const cleared = clearVaultCover(db, vaultsRoot, 'notes')
    assert.equal(cleared.hasCover, false)
    assert.equal(cleared.coverUpdatedAt, null)

    assert.throws(
      () => getVaultCover(db, vaultsRoot, 'notes'),
      (err) => err.code === 'VAULT_COVER_NOT_FOUND'
    )
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
