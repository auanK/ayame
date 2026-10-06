import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createApp } from '../app.js'
import { openDatabase } from '../database.js'
import { createOwner, createSession } from '../auth/authentication.js'

const setupAuthApp = async (vaultsRoot) => {
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'auank', password: 'password123' })
  const session = createSession(db)
  const app = createApp({ db, vaultsRoot })
  const cookie = `nia_session=${session.rawToken}`
  return { db, app, cookie }
}

test('vault routes fail with 401 UNAUTHORIZED without valid session', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-unauth-root-'))
  const db = openDatabase(':memory:')
  const app = createApp({ db, vaultsRoot })

  try {
    const resGet = await app.inject({
      method: 'GET',
      url: '/vaults',
    })
    assert.equal(resGet.statusCode, 401)
    assert.deepEqual(resGet.json(), { error: 'UNAUTHORIZED' })

    const resPost = await app.inject({
      method: 'POST',
      url: '/vaults',
      payload: { name: 'Personal', directory: 'personal' },
    })
    assert.equal(resPost.statusCode, 401)
    assert.deepEqual(resPost.json(), { error: 'UNAUTHORIZED' })

    const resDelete = await app.inject({
      method: 'DELETE',
      url: '/vaults/1234',
    })
    assert.equal(resDelete.statusCode, 401)
    assert.deepEqual(resDelete.json(), { error: 'UNAUTHORIZED' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults returns empty list initially when authenticated', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-empty-root-'))
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), { vaults: [] })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults returns discovered unregistered vaults without mutating database', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-disc-route-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))
  fs.mkdirSync(path.join(vaultsRoot, 'work'))
  const { db, app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const countBefore = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    assert.equal(countBefore, 0)

    const res = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      vaults: [
        {
          id: null,
          name: 'personal',
          directory: 'personal',
          registered: false,
        },
        {
          id: null,
          name: 'work',
          directory: 'work',
          registered: false,
        },
      ],
    })

    const countAfter = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    assert.equal(countAfter, 0)
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('POST /vaults creates vault and returns 201 with registered public shape', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-post-reg-'))
  fs.mkdirSync(path.join(vaultsRoot, 'my-vault'))
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'My Vault', directory: 'my-vault' },
    })
    assert.equal(res.statusCode, 201)
    const body = res.json()
    assert.ok(body.vault)
    assert.ok(typeof body.vault.id === 'string' && body.vault.id.length > 0)
    assert.equal(body.vault.name, 'My Vault')
    assert.equal(body.vault.directory, 'my-vault')
    assert.equal(body.vault.registered, true)

    // GET /vaults should now list it as registered
    const listRes = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(listRes.statusCode, 200)
    assert.deepEqual(listRes.json(), { vaults: [body.vault] })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('POST /vaults rejects invalid name with 400 INVALID_VAULT_NAME', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-inv-name-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: '  trimmed  ', directory: 'personal' },
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json(), { error: 'INVALID_VAULT_NAME' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('POST /vaults rejects invalid directory with 400 INVALID_VAULT_DIRECTORY', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-inv-dir-'))
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    // Non-existent directory
    const resMissing = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Personal', directory: 'missing' },
    })
    assert.equal(resMissing.statusCode, 400)
    assert.deepEqual(resMissing.json(), { error: 'INVALID_VAULT_DIRECTORY' })

    // Traversal
    const resTraversal = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Personal', directory: '../outside' },
    })
    assert.equal(resTraversal.statusCode, 400)
    assert.deepEqual(resTraversal.json(), { error: 'INVALID_VAULT_DIRECTORY' })

    // Case mismatch alias rejection
    fs.mkdirSync(path.join(vaultsRoot, 'Personal'))
    const resCaseMismatch = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Personal', directory: 'personal' },
    })
    assert.equal(resCaseMismatch.statusCode, 400)
    assert.deepEqual(resCaseMismatch.json(), { error: 'INVALID_VAULT_DIRECTORY' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('POST /vaults rejects duplicate directory with 409 VAULT_ALREADY_REGISTERED', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-dup-route-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res1 = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'First', directory: 'personal' },
    })
    assert.equal(res1.statusCode, 201)

    const res2 = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Second', directory: 'personal' },
    })
    assert.equal(res2.statusCode, 409)
    assert.deepEqual(res2.json(), { error: 'VAULT_ALREADY_REGISTERED' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('DELETE /vaults/:id unregisters metadata and falls back to detected vault', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-route-del-'))
  const personalDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(personalDir)
  const sentinelFile = path.join(personalDir, 'sentinel.txt')
  fs.writeFileSync(sentinelFile, 'sentinel contents')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const regRes = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Personal Notes', directory: 'personal' },
    })
    const vaultId = regRes.json().vault.id

    const delRes = await app.inject({
      method: 'DELETE',
      url: `/vaults/${vaultId}`,
      headers: { cookie },
    })
    assert.equal(delRes.statusCode, 204)

    // Re-check list: physical directory still exists, so it's now detected
    const listRes = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.deepEqual(listRes.json(), {
      vaults: [
        {
          id: null,
          name: 'personal',
          directory: 'personal',
          registered: false,
        },
      ],
    })

    // Sentinel file remains
    assert.equal(fs.readFileSync(sentinelFile, 'utf8'), 'sentinel contents')

    // Idempotent retry
    const retryRes = await app.inject({
      method: 'DELETE',
      url: `/vaults/${vaultId}`,
      headers: { cookie },
    })
    assert.equal(retryRes.statusCode, 204)

    // Arbitrary absent ID
    const absentRes = await app.inject({
      method: 'DELETE',
      url: '/vaults/non-existent-id',
      headers: { cookie },
    })
    assert.equal(absentRes.statusCode, 204)
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('live rescan: external creation and deletion reflected on subsequent GET /vaults', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-live-rescan-'))
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res1 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.deepEqual(res1.json(), { vaults: [] })

    // Create external folder
    fs.mkdirSync(path.join(vaultsRoot, 'external-vault'))

    const res2 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.deepEqual(res2.json(), {
      vaults: [
        {
          id: null,
          name: 'external-vault',
          directory: 'external-vault',
          registered: false,
        },
      ],
    })

    // Remove external folder
    fs.rmSync(path.join(vaultsRoot, 'external-vault'), { recursive: true, force: true })

    const res3 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.deepEqual(res3.json(), { vaults: [] })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})
