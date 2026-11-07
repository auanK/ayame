import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import os from 'node:os'
import { createApp } from '../app.js'
import { openDatabase } from '../database.js'
import { createOwner, createSession } from '../auth/authentication.js'

const revisionOf = (content) => crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')

const setupAuthApp = async (vaultsRoot) => {
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'auank', password: 'password123' })
  const session = createSession(db)
  const app = createApp({ db, vaultsRoot })
  const cookie = `ayame_session=${session.rawToken}`
  return { db, app, cookie }
}

test('vault routes fail with 401 UNAUTHORIZED without valid session', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-unauth-root-'))
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

    const resContent = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=README.md',
    })
    assert.equal(resContent.statusCode, 401)
    assert.equal(resContent.headers['cache-control'], 'no-store')
    assert.deepEqual(resContent.json(), { error: 'UNAUTHORIZED' })

    const resPut = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=README.md',
      payload: { content: 'updated', expectedRevision: revisionOf('original') },
    })
    assert.equal(resPut.statusCode, 401)
    assert.equal(resPut.headers['cache-control'], 'no-store')
    assert.deepEqual(resPut.json(), { error: 'UNAUTHORIZED' })

    const resPutInvalidSession = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=README.md',
      headers: { cookie: 'ayame_session=invalid-token' },
      payload: { content: 'updated', expectedRevision: revisionOf('original') },
    })
    assert.equal(resPutInvalidSession.statusCode, 401)
    assert.equal(resPutInvalidSession.headers['cache-control'], 'no-store')
    assert.deepEqual(resPutInvalidSession.json(), { error: 'UNAUTHORIZED' })

    const resPostFolder = await app.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      payload: { parentPath: '', name: 'Projects' },
    })
    assert.equal(resPostFolder.statusCode, 401)
    assert.equal(resPostFolder.headers['cache-control'], 'no-store')
    assert.deepEqual(resPostFolder.json(), { error: 'UNAUTHORIZED' })

    const resPostNote = await app.inject({
      method: 'POST',
      url: '/vaults/personal/notes',
      payload: { parentPath: '', name: 'Roadmap.md' },
    })
    assert.equal(resPostNote.statusCode, 401)
    assert.equal(resPostNote.headers['cache-control'], 'no-store')
    assert.deepEqual(resPostNote.json(), { error: 'UNAUTHORIZED' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults returns empty list initially when authenticated', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-empty-root-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-disc-route-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-post-reg-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-inv-name-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-inv-dir-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-dup-route-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-route-del-'))
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
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-live-rescan-'))
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

test('GET /vaults/:directory/entries requires authentication', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-route-unauth-'))
  const db = openDatabase(':memory:')
  const app = createApp({ db, vaultsRoot })

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries',
    })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'UNAUTHORIZED' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults/:directory/entries returns 200 for valid root without database registration', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-route-root-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal', 'projects'), { recursive: true })
  fs.writeFileSync(path.join(vaultsRoot, 'personal', 'README.md'), 'readme')
  const { db, app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const dbRowsBefore = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    assert.equal(dbRowsBefore, 0)

    const res = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries',
      headers: { cookie },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      directory: 'personal',
      path: '',
      entries: [
        { name: 'projects', path: 'projects', type: 'directory' },
        { name: 'README.md', path: 'README.md', type: 'file' },
      ],
    })

    const dbRowsAfter = db.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    assert.equal(dbRowsAfter, 0)
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults/:directory/entries returns 200 for valid subdirectory and encodes query path', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-route-subdir-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal', 'projects', 'ayame'), { recursive: true })
  fs.writeFileSync(path.join(vaultsRoot, 'personal', 'projects', 'spec.md'), 'spec')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=projects',
      headers: { cookie },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      directory: 'personal',
      path: 'projects',
      entries: [
        { name: 'ayame', path: 'projects/ayame', type: 'directory' },
        { name: 'spec.md', path: 'projects/spec.md', type: 'file' },
      ],
    })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults/:directory/entries handles directory with spaces and unicode', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-route-spaces-'))
  const vaultDirName = 'Minhas Notas 🌸'
  fs.mkdirSync(path.join(vaultsRoot, vaultDirName, 'Sub Pasta'), { recursive: true })
  fs.writeFileSync(path.join(vaultsRoot, vaultDirName, 'Livro 📖.txt'), 'capitulo')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const res = await app.inject({
      method: 'GET',
      url: `/vaults/${encodeURIComponent(vaultDirName)}/entries`,
      headers: { cookie },
    })
    assert.equal(res.statusCode, 200)
    assert.deepEqual(res.json(), {
      directory: vaultDirName,
      path: '',
      entries: [
        { name: 'Sub Pasta', path: 'Sub Pasta', type: 'directory' },
        { name: 'Livro 📖.txt', path: 'Livro 📖.txt', type: 'file' },
      ],
    })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults/:directory/entries returns error codes and never leaks server absolute paths', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-route-err-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))
  fs.writeFileSync(path.join(vaultsRoot, 'personal', 'note.txt'), 'hello')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    // 400 INVALID_VAULT_DIRECTORY
    const resInvDir = await app.inject({
      method: 'GET',
      url: '/vaults/nonexistent/entries',
      headers: { cookie },
    })
    assert.equal(resInvDir.statusCode, 400)
    assert.deepEqual(resInvDir.json(), { error: 'INVALID_VAULT_DIRECTORY' })

    // 400 INVALID_VAULT_PATH (traversal)
    const resInvPath = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=..%2Foutside',
      headers: { cookie },
    })
    assert.equal(resInvPath.statusCode, 400)
    assert.deepEqual(resInvPath.json(), { error: 'INVALID_VAULT_PATH' })

    // 404 VAULT_PATH_NOT_FOUND
    const resNotFound = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=missing-folder',
      headers: { cookie },
    })
    assert.equal(resNotFound.statusCode, 404)
    assert.deepEqual(resNotFound.json(), { error: 'VAULT_PATH_NOT_FOUND' })

    // 400 VAULT_PATH_NOT_DIRECTORY
    const resNotDir = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=note.txt',
      headers: { cookie },
    })
    assert.equal(resNotDir.statusCode, 400)
    assert.deepEqual(resNotDir.json(), { error: 'VAULT_PATH_NOT_DIRECTORY' })

    // Confirm no response contains absolute root path
    for (const res of [resInvDir, resInvPath, resNotFound, resNotDir]) {
      const text = res.body
      assert.equal(text.includes(vaultsRoot), false)
    }
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults/:directory/content returns 200, raw content and Cache-Control: no-store', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-route-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(path.join(vaultDir, 'docs'), { recursive: true })

  const rawNote = '# My Project\r\n\r\nRaw line endings and unicode: 🌸.\n'
  fs.writeFileSync(path.join(vaultDir, 'docs', 'readme.markdown'), rawNote, 'utf8')
  fs.writeFileSync(path.join(vaultDir, 'empty.md'), '', 'utf8')

  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    // 1. Read note in subfolder with .markdown extension
    const res = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=docs%2Freadme.markdown',
      headers: { cookie },
    })

    assert.equal(res.statusCode, 200)
    assert.equal(res.headers['cache-control'], 'no-store')
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8')
    assert.deepEqual(res.json(), {
      directory: 'personal',
      path: 'docs/readme.markdown',
      content: rawNote,
      revision: revisionOf(rawNote),
    })

    // 2. Read empty file at root
    const emptyRes = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=empty.md',
      headers: { cookie },
    })

    assert.equal(emptyRes.statusCode, 200)
    assert.equal(emptyRes.headers['cache-control'], 'no-store')
    assert.deepEqual(emptyRes.json(), {
      directory: 'personal',
      path: 'empty.md',
      content: '',
      revision: revisionOf(''),
    })

    // 3. Confirm files are never modified by reading
    assert.equal(fs.readFileSync(path.join(vaultDir, 'docs', 'readme.markdown'), 'utf8'), rawNote)
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('PUT /vaults/:directory/content saves with no-store and GET returns the new revision', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-put-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(vaultDir)
  const note = path.join(vaultDir, 'note.md')
  fs.writeFileSync(note, 'before')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const savedContent = '# Updated\r\n🌸\n'
    const put = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: savedContent, expectedRevision: revisionOf('before') },
    })
    assert.equal(put.statusCode, 200)
    assert.equal(put.headers['cache-control'], 'no-store')
    assert.deepEqual(put.json(), {
      directory: 'personal',
      path: 'note.md',
      revision: revisionOf(savedContent),
    })
    assert.equal(fs.readFileSync(note, 'utf8'), savedContent)

    const get = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
    })
    assert.equal(get.statusCode, 200)
    assert.deepEqual(get.json(), {
      directory: 'personal',
      path: 'note.md',
      content: savedContent,
      revision: revisionOf(savedContent),
    })

    const conflict = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: 'must not replace', expectedRevision: revisionOf('before') },
    })
    assert.equal(conflict.statusCode, 409)
    assert.equal(conflict.headers['cache-control'], 'no-store')
    assert.deepEqual(conflict.json(), { error: 'VAULT_FILE_CONFLICT' })
    assert.equal(fs.readFileSync(note, 'utf8'), savedContent)
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('PUT maps locked, invalid, unsupported and oversized saves without leaking paths', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-put-errors-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(vaultDir)
  fs.writeFileSync(path.join(vaultDir, 'note.md'), 'original')
  fs.writeFileSync(path.join(vaultDir, '.note.md.ayame.lock'), 'held')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const cases = [
      ['note.md', { content: 'next', expectedRevision: revisionOf('original') }, 423, 'VAULT_FILE_LOCKED'],
      ['note.md', { content: 1, expectedRevision: revisionOf('original') }, 400, 'INVALID_MARKDOWN_PAYLOAD'],
      ['image.png', { content: 'next', expectedRevision: revisionOf('original') }, 415, 'UNSUPPORTED_FILE_TYPE'],
      ['note.md', { content: 'x'.repeat(2 * 1024 * 1024 + 1), expectedRevision: revisionOf('original') }, 413, 'VAULT_FILE_TOO_LARGE'],
    ]
    for (const [filePath, payload, status, code] of cases) {
      const response = await app.inject({
        method: 'PUT',
        url: `/vaults/personal/content?path=${encodeURIComponent(filePath)}`,
        headers: { cookie },
        payload,
      })
      assert.equal(response.statusCode, status)
      assert.equal(response.headers['cache-control'], 'no-store')
      assert.deepEqual(response.json(), { error: code })
      assert.equal(response.body.includes(vaultsRoot), false)
    }
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('PUT body limit allows JSON overhead but rejects oversized JSON before filesystem access', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-put-body-limit-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(vaultDir)
  const note = path.join(vaultDir, 'note.md')
  fs.writeFileSync(note, 'original')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: '\0'.repeat(2 * 1024 * 1024 + 200), expectedRevision: revisionOf('original') },
    })
    assert.equal(response.statusCode, 413)
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.deepEqual(response.json(), { error: 'VAULT_FILE_TOO_LARGE' })
    assert.equal(fs.readFileSync(note, 'utf8'), 'original')
    assert.equal(fs.existsSync(path.join(vaultDir, '.note.md.ayame.lock')), false)
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('PUT reports uncertain post-replacement errors with a distinct code and no-store', async (t) => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-put-unknown-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(vaultDir)
  const note = path.join(vaultDir, 'note.md')
  fs.writeFileSync(note, 'original')
  const { app, cookie } = await setupAuthApp(vaultsRoot)
  t.after(async () => {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  })

  const originalRename = fs.renameSync
  const originalRead = fs.readSync
  let renamed = false
  t.mock.method(fs, 'renameSync', (...args) => {
    const result = originalRename(...args)
    renamed = true
    return result
  })
  t.mock.method(fs, 'readSync', (...args) => {
    if (renamed) {
      const error = new Error('injected readback failure')
      error.code = 'EIO'
      throw error
    }
    return originalRead(...args)
  })

  const response = await app.inject({
    method: 'PUT',
    url: '/vaults/personal/content?path=note.md',
    headers: { cookie },
    payload: { content: 'committed', expectedRevision: revisionOf('original') },
  })
  assert.equal(response.statusCode, 500)
  assert.equal(response.headers['cache-control'], 'no-store')
  assert.deepEqual(response.json(), { error: 'VAULT_SAVE_RESULT_UNKNOWN' })
  assert.equal(fs.readFileSync(note, 'utf8'), 'committed')
})

test('GET /vaults/:directory/content maps error conditions to expected HTTP status codes with Cache-Control: no-store', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-err-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(path.join(vaultDir, 'subfolder'), { recursive: true })

  // Fixtures:
  // - directory
  fs.mkdirSync(path.join(vaultDir, 'folder.md'))
  // - unsupported file type
  fs.writeFileSync(path.join(vaultDir, 'image.png'), 'png bytes')
  // - too large (2 MiB + 1 byte)
  fs.writeFileSync(path.join(vaultDir, 'huge.md'), Buffer.alloc(2 * 1024 * 1024 + 1, 0x61))
  // - invalid utf-8
  fs.writeFileSync(path.join(vaultDir, 'bad-encoding.md'), Buffer.from([0xff, 0xfe]))

  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const cases = [
      {
        url: '/vaults/unknown-vault/content?path=note.md',
        expectedStatus: 400,
        expectedError: 'INVALID_VAULT_DIRECTORY',
      },
      {
        url: '/vaults/personal/content?path=..%2Foutside.md',
        expectedStatus: 400,
        expectedError: 'INVALID_VAULT_PATH',
      },
      {
        url: '/vaults/personal/content?path=',
        expectedStatus: 400,
        expectedError: 'INVALID_VAULT_PATH',
      },
      {
        url: '/vaults/personal/content',
        expectedStatus: 400,
        expectedError: 'INVALID_VAULT_PATH',
      },
      {
        url: '/vaults/personal/content?path=folder.md',
        expectedStatus: 400,
        expectedError: 'VAULT_PATH_NOT_FILE',
      },
      {
        url: '/vaults/personal/content?path=missing.md',
        expectedStatus: 404,
        expectedError: 'VAULT_PATH_NOT_FOUND',
      },
      {
        url: '/vaults/personal/content?path=image.png',
        expectedStatus: 415,
        expectedError: 'UNSUPPORTED_FILE_TYPE',
      },
      {
        url: '/vaults/personal/content?path=huge.md',
        expectedStatus: 413,
        expectedError: 'VAULT_FILE_TOO_LARGE',
      },
      {
        url: '/vaults/personal/content?path=bad-encoding.md',
        expectedStatus: 422,
        expectedError: 'INVALID_FILE_ENCODING',
      },
    ]

    for (const testCase of cases) {
      const res = await app.inject({
        method: 'GET',
        url: testCase.url,
        headers: { cookie },
      })

      assert.equal(res.statusCode, testCase.expectedStatus, `Failed for ${testCase.url}: expected status ${testCase.expectedStatus}, got ${res.statusCode}`)
      assert.equal(res.headers['cache-control'], 'no-store')
      assert.deepEqual(res.json(), { error: testCase.expectedError })
      // Confirm absolute path is never leaked in body
      assert.equal(res.body.includes(vaultsRoot), false)
    }
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('GET /vaults/:directory/content keeps no-store after an unexpected filesystem read failure', async (t) => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-content-io-error-'))
  const vaultDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(vaultDir)
  fs.writeFileSync(path.join(vaultDir, 'note.md'), 'note content')
  const { app, cookie } = await setupAuthApp(vaultsRoot)
  t.after(async () => {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  })

  t.mock.method(fs, 'readSync', () => {
    const err = new Error('injected filesystem read failure')
    err.code = 'EIO'
    throw err
  })

  const res = await app.inject({
    method: 'GET',
    url: '/vaults/personal/content?path=note.md',
    headers: { cookie },
  })
  assert.equal(res.statusCode, 500)
  assert.equal(res.headers['cache-control'], 'no-store')
})

test('POST /vaults/:directory/folders and POST /vaults/:directory/notes create entries, preserve across restarts, and do not mutate SQLite', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-create-routes-'))
  const dbPath = path.join(vaultsRoot, 'test-ayame.sqlite')
  fs.mkdirSync(path.join(vaultsRoot, 'personal'))

  const db1 = openDatabase(dbPath)
  await createOwner(db1, { username: 'auank', password: 'password123' })
  const session = createSession(db1)
  const app1 = createApp({ db: db1, vaultsRoot })
  const cookie = `ayame_session=${session.rawToken}`

  let app1Closed = false
  try {
    const folderRoot = await app1.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      headers: { cookie },
      payload: { parentPath: '', name: 'Projects' },
    })
    assert.equal(folderRoot.statusCode, 201)
    assert.equal(folderRoot.headers['cache-control'], 'no-store')
    assert.deepEqual(folderRoot.json(), {
      directory: 'personal',
      path: 'Projects',
      name: 'Projects',
    })

    const folderSub = await app1.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      headers: { cookie },
      payload: { parentPath: 'Projects', name: 'Architecture' },
    })
    assert.equal(folderSub.statusCode, 201)
    assert.equal(folderSub.headers['cache-control'], 'no-store')
    assert.deepEqual(folderSub.json(), {
      directory: 'personal',
      path: 'Projects/Architecture',
      name: 'Architecture',
    })

    const noteSub = await app1.inject({
      method: 'POST',
      url: '/vaults/personal/notes',
      headers: { cookie },
      payload: { parentPath: 'Projects/Architecture', name: 'Decision' },
    })
    assert.equal(noteSub.statusCode, 201)
    assert.equal(noteSub.headers['cache-control'], 'no-store')
    assert.deepEqual(noteSub.json(), {
      directory: 'personal',
      path: 'Projects/Architecture/Decision.md',
      revision: revisionOf(''),
    })

    const vaultRows = db1.prepare('SELECT COUNT(*) AS count FROM vault').get().count
    assert.equal(vaultRows, 0)

    // Restart backend and verify physical entries and immediate editability
    await app1.close()
    app1Closed = true
    const db2 = openDatabase(dbPath)
    const app2 = createApp({ db: db2, vaultsRoot })
    try {
      const entriesRes = await app2.inject({
        method: 'GET',
        url: '/vaults/personal/entries?path=Projects%2FArchitecture',
        headers: { cookie },
      })
      assert.equal(entriesRes.statusCode, 200)
      assert.deepEqual(entriesRes.json(), {
        directory: 'personal',
        path: 'Projects/Architecture',
        entries: [{ name: 'Decision.md', path: 'Projects/Architecture/Decision.md', type: 'file' }],
      })

      const saveRes = await app2.inject({
        method: 'PUT',
        url: '/vaults/personal/content?path=Projects%2FArchitecture%2FDecision.md',
        headers: { cookie },
        payload: { content: '# ADR 1\n', expectedRevision: revisionOf('') },
      })
      assert.equal(saveRes.statusCode, 200)
      assert.equal(saveRes.json().revision, revisionOf('# ADR 1\n'))
    } finally {
      await app2.close()
    }
  } finally {
    if (!app1Closed) await app1.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})

test('POST /vaults/:directory/folders and /notes map validation, conflict, and type errors with Cache-Control: no-store', async () => {
  const vaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-create-errors-'))
  fs.mkdirSync(path.join(vaultsRoot, 'personal', 'Projects'), { recursive: true })
  fs.writeFileSync(path.join(vaultsRoot, 'personal', 'Projects', 'Existing.md'), 'keep')
  const { app, cookie } = await setupAuthApp(vaultsRoot)

  try {
    const folderConflict = await app.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      headers: { cookie },
      payload: { parentPath: '', name: 'Projects' },
    })
    assert.equal(folderConflict.statusCode, 409)
    assert.equal(folderConflict.headers['cache-control'], 'no-store')
    assert.deepEqual(folderConflict.json(), { error: 'VAULT_ENTRY_EXISTS' })

    const folderInvalidName = await app.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      headers: { cookie },
      payload: { parentPath: '', name: '../escape' },
    })
    assert.equal(folderInvalidName.statusCode, 400)
    assert.equal(folderInvalidName.headers['cache-control'], 'no-store')
    assert.deepEqual(folderInvalidName.json(), { error: 'INVALID_ENTRY_NAME' })

    const folderMissingParent = await app.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      headers: { cookie },
      payload: { parentPath: 'Missing', name: 'Sub' },
    })
    assert.equal(folderMissingParent.statusCode, 404)
    assert.equal(folderMissingParent.headers['cache-control'], 'no-store')
    assert.deepEqual(folderMissingParent.json(), { error: 'VAULT_PATH_NOT_FOUND' })

    const noteConflict = await app.inject({
      method: 'POST',
      url: '/vaults/personal/notes',
      headers: { cookie },
      payload: { parentPath: 'Projects', name: 'Existing' },
    })
    assert.equal(noteConflict.statusCode, 409)
    assert.equal(noteConflict.headers['cache-control'], 'no-store')
    assert.deepEqual(noteConflict.json(), { error: 'VAULT_ENTRY_EXISTS' })

    const noteUnsupported = await app.inject({
      method: 'POST',
      url: '/vaults/personal/notes',
      headers: { cookie },
      payload: { parentPath: 'Projects', name: 'script.js' },
    })
    assert.equal(noteUnsupported.statusCode, 415)
    assert.equal(noteUnsupported.headers['cache-control'], 'no-store')
    assert.deepEqual(noteUnsupported.json(), { error: 'UNSUPPORTED_FILE_TYPE' })
  } finally {
    await app.close()
    fs.rmSync(vaultsRoot, { recursive: true, force: true })
  }
})
