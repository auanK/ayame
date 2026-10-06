import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createApp } from '../app.js'
import { openDatabase, closeDatabase } from '../database.js'
import { createOwner, createSession } from '../auth/authentication.js'
import { prepareVaultsRoot, resolveExistingVaultPath } from './filesystem.js'

test('backend manual smoke sequence (sections 22, 26, 53 & 54)', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-smoke-'))
  const defaultVaultsRoot = path.join(tempDir, 'data', 'vaults')

  // 1. Ensure default root does not exist initially
  assert.equal(fs.existsSync(defaultVaultsRoot), false)

  // 2. Default startup prepares and creates data/vaults
  const canonicalRoot = prepareVaultsRoot(defaultVaultsRoot, { createIfMissing: true })
  assert.ok(fs.existsSync(defaultVaultsRoot))
  assert.ok(fs.statSync(defaultVaultsRoot).isDirectory())
  assert.equal(canonicalRoot, fs.realpathSync.native(defaultVaultsRoot))

  // 3. Test explicit configuration: existing vs missing
  const explicitValidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-explicit-valid-'))
  const explicitPrepared = prepareVaultsRoot(explicitValidDir, { createIfMissing: false })
  assert.equal(explicitPrepared, fs.realpathSync.native(explicitValidDir))
  fs.rmSync(explicitValidDir, { recursive: true, force: true })

  assert.throws(
    () => prepareVaultsRoot(path.join(tempDir, 'missing-mount'), { createIfMissing: false }),
    (err) => err.code === 'INVALID_VAULT_ROOT'
  )

  // 4. Start backend with the prepared root
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'auank', password: 'password123' })
  const session = createSession(db)
  const app = createApp({ db, vaultsRoot: canonicalRoot })
  const cookie = `nia_session=${session.rawToken}`

  try {
    // 5. Initial GET /vaults returns empty list
    const res1 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(res1.statusCode, 200)
    assert.deepEqual(res1.json(), { vaults: [] })

    // Zero DB writes during discovery
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vault').get().count, 0)

    // 6. Externally create alpha
    const alphaDir = path.join(canonicalRoot, 'alpha')
    fs.mkdirSync(alphaDir)

    // 7. GET /vaults returns detected alpha without restart
    const res2 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(res2.statusCode, 200)
    assert.deepEqual(res2.json(), {
      vaults: [
        { id: null, name: 'alpha', directory: 'alpha', registered: false },
      ],
    })

    // 8. Confirm DB row count remains zero
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM vault').get().count, 0)

    // 8b. Reject case-mismatched alias (ALPHA != alpha)
    const mismatchRes = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Alpha Mismatch', directory: 'ALPHA' },
    })
    assert.equal(mismatchRes.statusCode, 400)
    assert.deepEqual(mismatchRes.json(), { error: 'INVALID_VAULT_DIRECTORY' })

    // 9. POST metadata for alpha
    const regRes = await app.inject({
      method: 'POST',
      url: '/vaults',
      headers: { cookie },
      payload: { name: 'Personal', directory: 'alpha' },
    })
    assert.equal(regRes.statusCode, 201)
    const personalId = regRes.json().vault.id
    assert.ok(personalId)

    // Database stores only exact physical directory spelling
    assert.equal(db.prepare('SELECT directory FROM vault WHERE id = ?').get(personalId).directory, 'alpha')

    // 10. GET shows registered alpha
    const res3 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.deepEqual(res3.json(), {
      vaults: [
        { id: personalId, name: 'Personal', directory: 'alpha', registered: true },
      ],
    })

    // 11. DELETE metadata
    const delRes = await app.inject({
      method: 'DELETE',
      url: `/vaults/${personalId}`,
      headers: { cookie },
    })
    assert.equal(delRes.statusCode, 204)

    // 12. GET shows detected alpha again
    const res4 = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.deepEqual(res4.json(), {
      vaults: [
        { id: null, name: 'alpha', directory: 'alpha', registered: false },
      ],
    })

    // 13. Confirm filesystem contents remain untouched
    assert.ok(fs.existsSync(alphaDir))
    assert.ok(fs.statSync(alphaDir).isDirectory())

    // 14. Safe filesystem boundary checks
    const notesDir = path.join(alphaDir, 'notes')
    fs.mkdirSync(notesDir)
    fs.writeFileSync(path.join(notesDir, 'foo.md'), 'notes foo')
    const resolvedNote = resolveExistingVaultPath(alphaDir, 'notes/foo.md')
    assert.equal(resolvedNote.type, 'file')

    // Cross-platform separator traversal
    assert.throws(
      () => resolveExistingVaultPath(alphaDir, 'notes/../../outside'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
    assert.throws(
      () => resolveExistingVaultPath(alphaDir, 'notes\\..\\..\\outside'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )

    // Escape attempt from inside alpha
    const outsideDir = path.join(tempDir, 'outside')
    fs.mkdirSync(outsideDir)
    fs.writeFileSync(path.join(outsideDir, 'secret.txt'), 'secret')

    try {
      fs.symlinkSync(outsideDir, path.join(alphaDir, 'link-out'), 'dir')
    } catch {
      t.skip('Symlink creation not permitted in this environment')
      return
    }

    assert.throws(
      () => resolveExistingVaultPath(alphaDir, 'link-out/secret.txt'),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  } finally {
    await app.close()
    closeDatabase(db)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
