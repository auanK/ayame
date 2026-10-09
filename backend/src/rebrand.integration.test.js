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
import { resolveDatabasePath } from './runtime-config.js'

test('legacy installation selection preserves owner, password, session, and vault metadata', async (t) => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-legacy-install-'))
  t.after(() => fs.rmSync(tempDirectory, { recursive: true, force: true }))

  const dataDirectory = path.join(tempDirectory, 'data')
  const vaultsRoot = path.join(dataDirectory, 'vaults')
  const personalVault = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(personalVault, { recursive: true })
  const legacyPath = path.join(dataDirectory, 'nia.sqlite')
  const password = 'legacy-owner-password'
  const firstInstallDb = openDatabase(legacyPath)
  await createOwner(firstInstallDb, { username: 'owner', password })
  const session = createSession(firstInstallDb)
  const vault = registerVault(
    firstInstallDb,
    vaultsRoot,
    { name: 'Personal Notes', directory: 'personal' },
    { idFn: () => 'personal-vault' }
  )
  const originalOwner = getOwner(firstInstallDb)
  const originalSession = getSession(firstInstallDb, hashToken(session.rawToken))
  const originalVaults = listRegisteredVaults(firstInstallDb)
  closeDatabase(firstInstallDb)

  const selectedPath = resolveDatabasePath({ dataDirectory })
  assert.equal(selectedPath, legacyPath)
  assert.equal(fs.existsSync(legacyPath), true)
  assert.equal(fs.existsSync(path.join(dataDirectory, 'ayame.sqlite')), false)

  const db = openDatabase(selectedPath)
  const app = createApp({ db, vaultsRoot })
  try {
    assert.deepEqual(getOwner(db), originalOwner)
    assert.deepEqual(await authenticateUser(db, { username: 'owner', password }), originalOwner)
    assert.deepEqual(getSession(db, hashToken(session.rawToken)), originalSession)
    assert.deepEqual(validateSession(db, session.rawToken), originalSession)
    assert.deepEqual(listRegisteredVaults(db), originalVaults)
    assert.deepEqual(vault, originalVaults[0])

    const status = await app.inject({
      method: 'GET',
      url: '/auth/status',
      headers: { cookie: `nia_session=${session.rawToken}` },
    })
    assert.deepEqual(status.json(), { initialized: true, authenticated: true })

    const vaultResponse = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie: `nia_session=${session.rawToken}` },
    })
    assert.deepEqual(vaultResponse.json(), {
      vaults: [{ ...vault, registered: true }],
    })

    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'owner', password },
    })
    assert.equal(login.statusCode, 204)
    assert.match(login.headers['set-cookie'], /^ayame_session=/)
    assert.doesNotMatch(login.headers['set-cookie'], /nia_session=/)
  } finally {
    await app.close()
  }

  assert.equal(fs.existsSync(legacyPath), true)
  assert.equal(fs.existsSync(path.join(dataDirectory, 'ayame.sqlite')), false)
})
