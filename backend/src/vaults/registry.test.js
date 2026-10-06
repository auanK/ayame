import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { openDatabase, closeDatabase } from '../database.js'
import {
  validVaultName,
  registerVault,
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-reg-test-'))
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
    })
  } finally {
    closeDatabase(db)
    fs.rmSync(vaultsRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('registerVault rejects invalid name with INVALID_VAULT_NAME', () => {
  const db = openDatabase(':memory:')
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-invalid-name-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-missing-dir-'))

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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-reg-case-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-dup-test-'))
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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-dup-conn-reg-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-list-order-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-unreg-regress-'))
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
