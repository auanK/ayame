import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from './app.js'
import { closeDatabase, getOwner, getSession, openDatabase } from './database.js'
import {
  authenticateUser,
  createOwner,
  createSession,
  hashToken,
  validateSession,
} from './auth/authentication.js'
import { listRegisteredVaults, registerVault } from './vaults/registry.js'
import { prepareVaultsRoot } from './vaults/filesystem.js'
import { resolveDatabasePath, resolveVaultsRootConfig } from './runtime-config.js'

test('ayame installation persists owner, password hash, session, and vault metadata across restarts while preserving filesystem and unrelated files', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-persistence-test-'))
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }))

  const dataDirectory = path.join(tempDirectory, 'data')
  fs.mkdirSync(dataDirectory, { recursive: true })

  // Unrelated file in dataDirectory must remain untouched
  const unrelatedFile = path.join(dataDirectory, 'unrelated-notes.db')
  const unrelatedBytes = Buffer.from('external-unrelated-bytes')
  fs.writeFileSync(unrelatedFile, unrelatedBytes)

  // 1. Resolve default database and vaults root paths
  const ayamePath = resolveDatabasePath({ dataDirectory })
  assert.equal(ayamePath, path.join(dataDirectory, 'ayame.sqlite'))

  const vaultsConfig = resolveVaultsRootConfig({
    defaultPath: path.join(dataDirectory, 'vaults'),
  })
  const vaultsRoot = prepareVaultsRoot(vaultsConfig.path, {
    createIfMissing: vaultsConfig.createIfMissing,
  })
  assert.equal(fs.existsSync(vaultsRoot), true)

  // Prepare two vault directories: one to register, one left unregistered
  const personalDir = path.join(vaultsRoot, 'personal')
  const archiveDir = path.join(vaultsRoot, 'archive')
  fs.mkdirSync(path.join(personalDir, 'projects'), { recursive: true })
  fs.mkdirSync(archiveDir, { recursive: true })
  const notePath = path.join(personalDir, 'projects', 'roadmap.md')
  const noteContent = '# Ayame Roadmap\n'
  fs.writeFileSync(notePath, noteContent)

  const password = 'ayame-owner-password'

  // Phase 1: Initialize database, create owner, session, and register vault metadata
  const firstDb = openDatabase(ayamePath)
  await createOwner(firstDb, { username: 'owner', password })
  const session = createSession(firstDb)
  const registeredVault = registerVault(
    firstDb,
    vaultsRoot,
    { name: 'Personal Notes', directory: 'personal' },
    { idFn: () => 'personal-vault' }
  )
  const originalOwner = getOwner(firstDb)
  assert.ok(originalOwner.password_hash.startsWith('$argon2id$'))
  const originalSession = getSession(firstDb, hashToken(session.rawToken))
  const originalVaults = listRegisteredVaults(firstDb)
  closeDatabase(firstDb)

  // Phase 2: Reopen database and start application
  const secondPath = resolveDatabasePath({ dataDirectory })
  assert.equal(secondPath, ayamePath)
  assert.equal(fs.existsSync(ayamePath), true)

  const db = openDatabase(secondPath)
  const app = createApp({ db, vaultsRoot })
  const cookie = `ayame_session=${session.rawToken}`

  try {
    // Verify persisted records
    assert.deepEqual(getOwner(db), originalOwner)
    assert.deepEqual(await authenticateUser(db, { username: 'owner', password }), originalOwner)
    assert.deepEqual(getSession(db, hashToken(session.rawToken)), originalSession)
    assert.deepEqual(validateSession(db, session.rawToken), originalSession)
    assert.deepEqual(listRegisteredVaults(db), originalVaults)
    assert.deepEqual(registeredVault, originalVaults[0])

    // Authenticate with ayame_session
    const statusRes = await app.inject({
      method: 'GET',
      url: '/auth/status',
      headers: { cookie },
    })
    assert.equal(statusRes.statusCode, 200)
    assert.deepEqual(statusRes.json(), { initialized: true, authenticated: true })

    // Unrelated cookie is rejected with 401
    const unauthOther = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie: `other_cookie=${session.rawToken}` },
    })
    assert.equal(unauthOther.statusCode, 401)
    assert.deepEqual(unauthOther.json(), { error: 'UNAUTHORIZED' })

    // List vaults: includes both unregistered discovered vault and registered vault
    const listRes = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(listRes.statusCode, 200)
    assert.deepEqual(listRes.json(), {
      vaults: [
        { id: null, name: 'archive', directory: 'archive', registered: false },
        { id: 'personal-vault', name: 'Personal Notes', directory: 'personal', registered: true },
      ],
    })

    // Navigate entries in root and subdirectory
    const rootEntriesRes = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries',
      headers: { cookie },
    })
    assert.equal(rootEntriesRes.statusCode, 200)
    assert.deepEqual(rootEntriesRes.json(), {
      directory: 'personal',
      path: '',
      entries: [{ name: 'projects', path: 'projects', type: 'directory' }],
    })

    const subEntriesRes = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=projects',
      headers: { cookie },
    })
    assert.equal(subEntriesRes.statusCode, 200)
    assert.deepEqual(subEntriesRes.json(), {
      directory: 'personal',
      path: 'projects',
      entries: [{ name: 'roadmap.md', path: 'projects/roadmap.md', type: 'file' }],
    })

    // Delete custom metadata while preserving physical directory
    const delRes = await app.inject({
      method: 'DELETE',
      url: '/vaults/personal-vault',
      headers: { cookie },
    })
    assert.equal(delRes.statusCode, 204)

    const listAfterDelete = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(listAfterDelete.statusCode, 200)
    assert.deepEqual(listAfterDelete.json(), {
      vaults: [
        { id: null, name: 'archive', directory: 'archive', registered: false },
        { id: null, name: 'personal', directory: 'personal', registered: false },
      ],
    })
  } finally {
    await app.close()
  }

  // Filesystem and unrelated files in dataDirectory remain untouched
  assert.equal(fs.readFileSync(notePath, 'utf8'), noteContent)
  assert.deepEqual(fs.readFileSync(unrelatedFile), unrelatedBytes)
  assert.equal(fs.existsSync(ayamePath), true)
})
