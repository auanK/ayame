import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { createApp } from '../app.js'
import { openDatabase, closeDatabase } from '../database.js'
import { createOwner, createSession } from '../auth/authentication.js'
import { prepareVaultsRoot, resolveExistingVaultPath } from './filesystem.js'

const revisionOf = (content) => crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')

const databaseSnapshot = (db) => Object.fromEntries(
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all()
    .map(({ name }) => [name, db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all()])
)

test('backend manual smoke sequence (sections 22, 26, 53 & 54)', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-smoke-'))
  const defaultVaultsRoot = path.join(tempDir, 'data', 'vaults')

  // 1. Ensure default root does not exist initially
  assert.equal(fs.existsSync(defaultVaultsRoot), false)

  // 2. Default startup prepares and creates data/vaults
  const canonicalRoot = prepareVaultsRoot(defaultVaultsRoot, { createIfMissing: true })
  assert.ok(fs.existsSync(defaultVaultsRoot))
  assert.ok(fs.statSync(defaultVaultsRoot).isDirectory())
  assert.equal(canonicalRoot, fs.realpathSync.native(defaultVaultsRoot))

  // 3. Test explicit configuration: existing vs missing
  const explicitValidDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-explicit-valid-'))
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
  const cookie = `ayame_session=${session.rawToken}`

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

test('read-only vault browser smoke flow (section 8)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-smoke-browser-'))
  const vaultsRoot = path.join(tempDir, 'vaults')

  // Setup fixture tree
  const personalDir = path.join(vaultsRoot, 'personal')
  const writingDir = path.join(vaultsRoot, 'writing')
  fs.mkdirSync(path.join(personalDir, 'projects'), { recursive: true })
  fs.mkdirSync(path.join(personalDir, 'empty'), { recursive: true })
  fs.mkdirSync(path.join(writingDir, 'drafts'), { recursive: true })

  fs.writeFileSync(path.join(personalDir, 'README.md'), '# Personal README')
  fs.writeFileSync(path.join(personalDir, 'projects', 'project-a.md'), '# Project A')
  fs.writeFileSync(path.join(personalDir, 'projects', 'project-b.md'), '# Project B')
  fs.writeFileSync(path.join(writingDir, 'drafts', 'chapter-01.md'), '# Chapter 1')

  const initialReadmeContent = fs.readFileSync(path.join(personalDir, 'README.md'), 'utf8')
  const initialProjectAContent = fs.readFileSync(path.join(personalDir, 'projects', 'project-a.md'), 'utf8')

  // 1. Initialise application with prepared temporary directory
  const canonicalVaultsRoot = prepareVaultsRoot(vaultsRoot, { createIfMissing: false })
  const db = openDatabase(':memory:')

  // 2. Authenticate owner
  await createOwner(db, { username: 'auank', password: 'password123' })
  const session = createSession(db)
  const app = createApp({ db, vaultsRoot: canonicalVaultsRoot })
  const cookie = `ayame_session=${session.rawToken}`

  try {
    // 3. Discover personal and writing
    const resDiscovery = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(resDiscovery.statusCode, 200)
    const vaults = resDiscovery.json().vaults
    assert.deepEqual(
      vaults.map((v) => v.directory),
      ['personal', 'writing']
    )

    // 4. Navigate personal root
    const resPersonalRoot = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries',
      headers: { cookie },
    })
    assert.equal(resPersonalRoot.statusCode, 200)
    const rootBody = resPersonalRoot.json()
    assert.equal(rootBody.directory, 'personal')
    assert.equal(rootBody.path, '')
    assert.deepEqual(rootBody.entries, [
      { name: 'empty', path: 'empty', type: 'directory' },
      { name: 'projects', path: 'projects', type: 'directory' },
      { name: 'README.md', path: 'README.md', type: 'file' },
    ])

    // 5. Open projects
    const resProjects = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=projects',
      headers: { cookie },
    })
    assert.equal(resProjects.statusCode, 200)
    const projectsBody = resProjects.json()
    assert.equal(projectsBody.directory, 'personal')
    assert.equal(projectsBody.path, 'projects')

    // 6. Obtain existing files in projects
    assert.deepEqual(projectsBody.entries, [
      { name: 'project-a.md', path: 'projects/project-a.md', type: 'file' },
      { name: 'project-b.md', path: 'projects/project-b.md', type: 'file' },
    ])

    // 7. Return to root
    const resBackToRoot = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=',
      headers: { cookie },
    })
    assert.equal(resBackToRoot.statusCode, 200)
    assert.equal(resBackToRoot.json().path, '')

    // 8. Confirm empty is empty
    const resEmpty = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=empty',
      headers: { cookie },
    })
    assert.equal(resEmpty.statusCode, 200)
    assert.deepEqual(resEmpty.json().entries, [])

    // 9. Externally create projects/new.md
    fs.writeFileSync(path.join(personalDir, 'projects', 'new.md'), '# New Note')

    // 10. Refresh / query projects again
    const resProjectsUpdated = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=projects',
      headers: { cookie },
    })
    assert.equal(resProjectsUpdated.statusCode, 200)

    // 11. Confirm new file appears without restart
    assert.deepEqual(resProjectsUpdated.json().entries, [
      { name: 'new.md', path: 'projects/new.md', type: 'file' },
      { name: 'project-a.md', path: 'projects/project-a.md', type: 'file' },
      { name: 'project-b.md', path: 'projects/project-b.md', type: 'file' },
    ])

    // 12. Externally remove empty directory
    fs.rmSync(path.join(personalDir, 'empty'), { recursive: true, force: true })

    // 13. Confirm expected error (404 VAULT_PATH_NOT_FOUND) when accessing it
    const resEmptyDeleted = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=empty',
      headers: { cookie },
    })
    assert.equal(resEmptyDeleted.statusCode, 404)
    assert.deepEqual(resEmptyDeleted.json(), { error: 'VAULT_PATH_NOT_FOUND' })

    // 14. Validate traversal attempt fails closed
    const resTraversal = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries?path=..%2Fwriting',
      headers: { cookie },
    })
    assert.equal(resTraversal.statusCode, 400)
    assert.deepEqual(resTraversal.json(), { error: 'INVALID_VAULT_PATH' })

    // 15. Confirm files and contents remain completely unchanged
    assert.equal(fs.readFileSync(path.join(personalDir, 'README.md'), 'utf8'), initialReadmeContent)
    assert.equal(fs.readFileSync(path.join(personalDir, 'projects', 'project-a.md'), 'utf8'), initialProjectAContent)
  } finally {
    await app.close()
    closeDatabase(db)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('read-only markdown viewer smoke sequence (section 25)', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-smoke-markdown-'))
  const vaultsRoot = path.join(tempDir, 'vaults')

  // Setup fixtures:
  // vaults/personal/
  //   README.md
  //   projects/
  //     roadmap.md
  //     notes.markdown
  //   empty.md
  //   image.png
  //   large.md
  const personalDir = path.join(vaultsRoot, 'personal')
  const projectsDir = path.join(personalDir, 'projects')
  const outsideDir = path.join(tempDir, 'outside')
  fs.mkdirSync(projectsDir, { recursive: true })
  fs.mkdirSync(outsideDir)

  const readmeContent = '# Personal Knowledge Hub\n\nWelcome to Ayame.\n'
  const roadmapContent = '## Q1 Roadmap\n- [ ] Viewer\n- [ ] Search\n'
  const notesContent = '# Brainstorming Notes\n\nSome ideas.\n'
  const imageBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const largeBytes = Buffer.alloc(2 * 1024 * 1024 + 1, 0x61) // 2 MiB + 1 byte

  fs.writeFileSync(path.join(personalDir, 'README.md'), readmeContent, 'utf8')
  fs.writeFileSync(path.join(projectsDir, 'roadmap.md'), roadmapContent, 'utf8')
  fs.writeFileSync(path.join(projectsDir, 'notes.markdown'), notesContent, 'utf8')
  fs.writeFileSync(path.join(personalDir, 'empty.md'), '', 'utf8')
  fs.writeFileSync(path.join(personalDir, 'image.png'), imageBytes)
  fs.writeFileSync(path.join(personalDir, 'large.md'), largeBytes)
  fs.writeFileSync(path.join(personalDir, 'race.md'), 'authorized race note')
  fs.writeFileSync(path.join(outsideDir, 'private.md'), 'private sentinel')

  // 1. Initialise backend
  const canonicalRoot = prepareVaultsRoot(vaultsRoot, { createIfMissing: false })
  const db = openDatabase(':memory:')

  // 2. Authenticate owner
  await createOwner(db, { username: 'auank', password: 'password123' })
  const session = createSession(db)
  const app = createApp({ db, vaultsRoot: canonicalRoot })
  const cookie = `ayame_session=${session.rawToken}`

  try {
    // 3. Discover personal
    const resDiscovery = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(resDiscovery.statusCode, 200)
    assert.deepEqual(
      resDiscovery.json().vaults.map((v) => v.directory),
      ['personal']
    )

    // 4. List root entries
    const resListRoot = await app.inject({
      method: 'GET',
      url: '/vaults/personal/entries',
      headers: { cookie },
    })
    assert.equal(resListRoot.statusCode, 200)
    const rootEntries = resListRoot.json().entries
    assert.ok(rootEntries.some((e) => e.name === 'README.md' && e.type === 'file'))
    assert.ok(rootEntries.some((e) => e.name === 'projects' && e.type === 'directory'))

    // 5. Read README.md
    const resReadme = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=README.md',
      headers: { cookie },
    })
    assert.equal(resReadme.statusCode, 200)
    assert.equal(resReadme.headers['cache-control'], 'no-store')
    assert.deepEqual(resReadme.json(), {
      directory: 'personal',
      path: 'README.md',
      content: readmeContent,
      revision: revisionOf(readmeContent),
    })

    // 6. Read projects/roadmap.md
    const resRoadmap = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=projects%2Froadmap.md',
      headers: { cookie },
    })
    assert.equal(resRoadmap.statusCode, 200)
    assert.deepEqual(resRoadmap.json(), {
      directory: 'personal',
      path: 'projects/roadmap.md',
      content: roadmapContent,
      revision: revisionOf(roadmapContent),
    })

    // 7. Read projects/notes.markdown
    const resNotes = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=projects%2Fnotes.markdown',
      headers: { cookie },
    })
    assert.equal(resNotes.statusCode, 200)
    assert.deepEqual(resNotes.json(), {
      directory: 'personal',
      path: 'projects/notes.markdown',
      content: notesContent,
      revision: revisionOf(notesContent),
    })

    // 8. Read empty.md
    const resEmpty = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=empty.md',
      headers: { cookie },
    })
    assert.equal(resEmpty.statusCode, 200)
    assert.deepEqual(resEmpty.json(), {
      directory: 'personal',
      path: 'empty.md',
      content: '',
      revision: revisionOf(''),
    })

    // 9. Rejection of image.png (415 UNSUPPORTED_FILE_TYPE)
    const resImage = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=image.png',
      headers: { cookie },
    })
    assert.equal(resImage.statusCode, 415)
    assert.deepEqual(resImage.json(), { error: 'UNSUPPORTED_FILE_TYPE' })

    // 10. Rejection of large.md above limit (413 VAULT_FILE_TOO_LARGE)
    const resLarge = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=large.md',
      headers: { cookie },
    })
    assert.equal(resLarge.statusCode, 413)
    assert.deepEqual(resLarge.json(), { error: 'VAULT_FILE_TOO_LARGE' })

    // 11. External modification of projects/roadmap.md
    const updatedRoadmapContent = '## Q1 Roadmap Updated!\n- [x] Viewer Complete\n'
    fs.writeFileSync(path.join(projectsDir, 'roadmap.md'), updatedRoadmapContent, 'utf8')

    // 12. Read again showing updated content without restart
    const resUpdatedRoadmap = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=projects%2Froadmap.md',
      headers: { cookie },
    })
    assert.equal(resUpdatedRoadmap.statusCode, 200)
    assert.equal(resUpdatedRoadmap.json().content, updatedRoadmapContent)

    // Deterministically replace a validated entry immediately before open.
    const racePath = path.join(personalDir, 'race.md')
    const authorizedRacePath = path.join(personalDir, 'race-authorized.md')
    const privatePath = path.join(outsideDir, 'private.md')
    const originalOpen = fs.openSync
    t.mock.method(fs, 'openSync', (target, ...args) => {
      if (path.resolve(String(target)) === racePath) {
        fs.renameSync(racePath, authorizedRacePath)
        fs.copyFileSync(privatePath, racePath)
      }
      return originalOpen(target, ...args)
    })

    const resRaced = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=race.md',
      headers: { cookie },
    })
    assert.equal(resRaced.statusCode, 400)
    assert.deepEqual(resRaced.json(), { error: 'INVALID_VAULT_PATH' })
    assert.equal(resRaced.body.includes('private sentinel'), false)
    assert.equal(fs.readFileSync(privatePath, 'utf8'), 'private sentinel')
    fs.unlinkSync(racePath)
    fs.renameSync(authorizedRacePath, racePath)

    // 13. External removal of empty.md
    fs.unlinkSync(path.join(personalDir, 'empty.md'))

    // 14. Reading deleted file returns 404
    const resDeleted = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=empty.md',
      headers: { cookie },
    })
    assert.equal(resDeleted.statusCode, 404)
    assert.deepEqual(resDeleted.json(), { error: 'VAULT_PATH_NOT_FOUND' })

    // 15. Traversal attempt rejected with 400
    const resTraversal = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=..%2F..%2Foutside.md',
      headers: { cookie },
    })
    assert.equal(resTraversal.statusCode, 400)
    assert.deepEqual(resTraversal.json(), { error: 'INVALID_VAULT_PATH' })

    // 16. Confirmation that other files were not modified
    assert.equal(fs.readFileSync(path.join(personalDir, 'README.md'), 'utf8'), readmeContent)
    assert.equal(fs.readFileSync(path.join(projectsDir, 'notes.markdown'), 'utf8'), notesContent)
    assert.deepEqual(fs.readFileSync(path.join(personalDir, 'image.png')), imageBytes)
    assert.deepEqual(fs.readFileSync(path.join(personalDir, 'large.md')), largeBytes)
  } finally {
    await app.close()
    closeDatabase(db)
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('conflict-aware Markdown save smoke flow preserves files, reports uncertainty, and survives restart', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-editor-smoke-'))
  const vaultsRoot = path.join(tempDir, 'vaults')
  const dbPath = path.join(tempDir, 'ayame.sqlite')
  const personalDir = path.join(vaultsRoot, 'personal')
  const projectsDir = path.join(personalDir, 'projects')
  fs.mkdirSync(projectsDir, { recursive: true })
  const note = path.join(personalDir, 'note.md')
  fs.writeFileSync(note, '# Original\r\n')
  fs.writeFileSync(path.join(personalDir, 'empty.md'), '')
  fs.writeFileSync(path.join(projectsDir, 'roadmap.md'), '# Roadmap')

  const canonicalRoot = prepareVaultsRoot(vaultsRoot, { createIfMissing: false })
  let db = openDatabase(dbPath)
  await createOwner(db, { username: 'auank', password: 'password123' })
  const session = createSession(db)
  let app = createApp({ db, vaultsRoot: canonicalRoot })
  const cookie = `ayame_session=${session.rawToken}`
  const originalDatabase = databaseSnapshot(db)

  try {
    const initial = await app.inject({ method: 'GET', url: '/vaults/personal/content?path=note.md', headers: { cookie } })
    assert.equal(initial.statusCode, 200)
    assert.equal(initial.json().revision, revisionOf('# Original\r\n'))

    const updatedContent = '# Edited 🌸\r\nSecond line\n'
    const saved = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: updatedContent, expectedRevision: initial.json().revision },
    })
    assert.equal(saved.statusCode, 200)
    assert.equal(saved.json().revision, revisionOf(updatedContent))
    assert.equal(fs.readFileSync(note, 'utf8'), updatedContent)
    const reopened = await app.inject({ method: 'GET', url: '/vaults/personal/content?path=note.md', headers: { cookie } })
    assert.deepEqual(reopened.json(), {
      directory: 'personal', path: 'note.md', content: updatedContent, revision: revisionOf(updatedContent),
    })

    fs.writeFileSync(note, '# External version')
    const externalRevision = revisionOf('# External version')
    const conflict = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: 'local draft preserved by frontend', expectedRevision: saved.json().revision },
    })
    assert.equal(conflict.statusCode, 409)
    assert.deepEqual(conflict.json(), { error: 'VAULT_FILE_CONFLICT' })
    assert.equal(fs.readFileSync(note, 'utf8'), '# External version')

    const originalWrite = fs.writeSync
    let partialWrite = false
    t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
      if (partialWrite) {
        const error = new Error('injected temporary write failure')
        error.code = 'EIO'
        throw error
      }
      partialWrite = true
      return originalWrite(fd, buffer, offset, Math.min(2, length), position)
    })
    const interrupted = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: 'interrupted local draft', expectedRevision: externalRevision },
    })
    assert.equal(interrupted.statusCode, 500)
    assert.deepEqual(interrupted.json(), { error: 'VAULT_SAVE_FAILED' })
    assert.equal(fs.readFileSync(note, 'utf8'), '# External version')
    assert.equal(fs.readdirSync(personalDir).some((name) => name.endsWith('.tmp')), false)
    t.mock.restoreAll()

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
        const error = new Error('injected post-replacement confirmation failure')
        error.code = 'EIO'
        throw error
      }
      return originalRead(...args)
    })
    const uncertainContent = '# Committed, confirmation lost'
    const uncertain = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=note.md',
      headers: { cookie },
      payload: { content: uncertainContent, expectedRevision: externalRevision },
    })
    assert.equal(uncertain.statusCode, 500)
    assert.deepEqual(uncertain.json(), { error: 'VAULT_SAVE_RESULT_UNKNOWN' })
    assert.equal(fs.readFileSync(note, 'utf8'), uncertainContent)
    t.mock.restoreAll()

    assert.deepEqual(databaseSnapshot(db), originalDatabase)
    await app.close()
    db = openDatabase(dbPath)
    app = createApp({ db, vaultsRoot: canonicalRoot })
    const afterRestart = await app.inject({ method: 'GET', url: '/vaults/personal/content?path=note.md', headers: { cookie } })
    assert.equal(afterRestart.statusCode, 200)
    assert.equal(afterRestart.json().content, uncertainContent)
    assert.equal(afterRestart.json().revision, revisionOf(uncertainContent))
    assert.deepEqual(databaseSnapshot(db), originalDatabase)
  } finally {
    await app.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('Obsidian-style Markdown workspace smoke flow (section 10)', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-smoke-workspace-'))
  const vaultsRoot = path.join(tempDir, 'vaults')
  const personalDir = path.join(vaultsRoot, 'personal')
  fs.mkdirSync(personalDir, { recursive: true })

  const canonicalRoot = prepareVaultsRoot(vaultsRoot, { createIfMissing: false })
  const dbPath = path.join(tempDir, 'ayame.sqlite')
  const db = openDatabase(dbPath)
  const app = createApp({ db, vaultsRoot: canonicalRoot })

  try {
    // 1. Create owner via HTTP
    const setupRes = await app.inject({
      method: 'POST',
      url: '/auth/owner',
      payload: { username: 'auank', password: 'password123' },
    })
    assert.equal(setupRes.statusCode, 201)

    // 2. Login via HTTP
    const loginRes = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'auank', password: 'password123' },
    })
    assert.equal(loginRes.statusCode, 204)
    const setCookieHeader = loginRes.headers['set-cookie']
    const cookie = Array.isArray(setCookieHeader) ? setCookieHeader[0].split(';')[0] : setCookieHeader.split(';')[0]

    const baselineDatabase = databaseSnapshot(db)

    // 3. List vaults
    const vaultsRes = await app.inject({
      method: 'GET',
      url: '/vaults',
      headers: { cookie },
    })
    assert.equal(vaultsRes.statusCode, 200)
    assert.equal(vaultsRes.json().vaults.length, 1)
    assert.equal(vaultsRes.json().vaults[0].directory, 'personal')

    // 4. Create folder 'Projects'
    const folderRes = await app.inject({
      method: 'POST',
      url: '/vaults/personal/folders',
      headers: { cookie },
      payload: { parentPath: '', name: 'Projects' },
    })
    assert.equal(folderRes.statusCode, 201)
    assert.equal(folderRes.headers['cache-control'], 'no-store')
    assert.deepEqual(folderRes.json(), {
      directory: 'personal',
      path: 'Projects',
      name: 'Projects',
    })

    // 5. Create note 'Projects/Roadmap.md'
    const roadmapCreateRes = await app.inject({
      method: 'POST',
      url: '/vaults/personal/notes',
      headers: { cookie },
      payload: { parentPath: 'Projects', name: 'Roadmap' },
    })
    assert.equal(roadmapCreateRes.statusCode, 201)
    assert.equal(roadmapCreateRes.headers['cache-control'], 'no-store')
    const emptyRevision = revisionOf('')
    assert.deepEqual(roadmapCreateRes.json(), {
      directory: 'personal',
      path: 'Projects/Roadmap.md',
      revision: emptyRevision,
    })

    // 6. Save content with [[Architecture]] link and Markdown formatting
    const roadmapContent = '# Roadmap\n\nSee [[Architecture]] for **core** system design.\n'
    const saveRes = await app.inject({
      method: 'PUT',
      url: '/vaults/personal/content?path=Projects%2FRoadmap.md',
      headers: { cookie },
      payload: {
        content: roadmapContent,
        expectedRevision: emptyRevision,
      },
    })
    assert.equal(saveRes.statusCode, 200)
    assert.equal(saveRes.json().revision, revisionOf(roadmapContent))

    // 7. Create note 'Projects/Architecture.md'
    const archCreateRes = await app.inject({
      method: 'POST',
      url: '/vaults/personal/notes',
      headers: { cookie },
      payload: { parentPath: 'Projects', name: 'Architecture.md' },
    })
    assert.equal(archCreateRes.statusCode, 201)
    assert.deepEqual(archCreateRes.json(), {
      directory: 'personal',
      path: 'Projects/Architecture.md',
      revision: emptyRevision,
    })

    // 8. Read both notes
    const readRoadmap = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=Projects%2FRoadmap.md',
      headers: { cookie },
    })
    assert.equal(readRoadmap.statusCode, 200)
    assert.equal(readRoadmap.json().content, roadmapContent)

    const readArch = await app.inject({
      method: 'GET',
      url: '/vaults/personal/content?path=Projects%2FArchitecture.md',
      headers: { cookie },
    })
    assert.equal(readArch.statusCode, 200)
    assert.equal(readArch.json().content, '')

    // 9. Verify real disk persistence and absence of temporary files
    const projectsDiskPath = path.join(personalDir, 'Projects')
    assert.equal(fs.readFileSync(path.join(projectsDiskPath, 'Roadmap.md'), 'utf8'), roadmapContent)
    assert.equal(fs.readFileSync(path.join(projectsDiskPath, 'Architecture.md'), 'utf8'), '')
    assert.deepEqual(
      fs.readdirSync(projectsDiskPath).sort(),
      ['Architecture.md', 'Roadmap.md']
    )
    assert.equal(
      fs.readdirSync(projectsDiskPath).some((entry) => entry.endsWith('.tmp')),
      false
    )

    // 10. Verify SQLite tables/counts are completely unchanged by folder & file operations
    assert.deepEqual(databaseSnapshot(db), baselineDatabase)
  } finally {
    await app.close()
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
