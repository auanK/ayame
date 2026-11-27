import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import sharp from 'sharp'
import { MURAL_PREVIEW_LENGTH } from '../../../shared/mural.js'
import { createApp } from '../app.js'
import { createOwner, createSession } from '../auth/authentication.js'
import { openDatabase } from '../database.js'

const base = '/vaults/mural/cards'
const id = (number) => number.toString(16).padStart(32, '0')
const noteFields = { title: '', body: 'A plain text note\nwith a line break.', color: 'neutral', pinned: false, archived: false }

test('grouped pagination keeps regular notes visible and note deletion checks revisions', async (t) => {
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'mural-user', password: 'password123' })
  const headers = { cookie: `ayame_session=${createSession(db).rawToken}` }
  const app = createApp({ db, vaultsRoot: os.tmpdir() })
  t.after(() => app.close())

  for (let number = 1; number <= 18; number++) {
    const created = await app.inject({
      method: 'PUT', url: `${base}/${id(number)}`, headers,
      payload: { ...noteFields, pinned: number !== 1, expectedRevision: null },
    })
    assert.equal(created.statusCode, 200)
  }

  const page = (await app.inject({ url: `${base}?groups=true`, headers })).json()
  assert.equal(page.pinned.cards.length, 16)
  assert.deepEqual(page.notes.cards.map((card) => card.id), [id(1)])
  const second = (await app.inject({ url: `${base}?pinned=true&after=${page.pinned.next}`, headers })).json()
  assert.deepEqual(second.cards.map((card) => card.id), [id(2)])
  const remove = (revision) => app.inject({ method: 'DELETE', url: `${base}/${id(1)}?revision=${revision}`, headers })
  assert.equal((await remove(2)).statusCode, 409)
  assert.equal((await remove(1)).statusCode, 200)
  assert.equal((await app.inject({ url: `${base}/${id(1)}`, headers })).statusCode, 404)
})

test('quick notes persist independently from vaults and reject stale revisions', async (t) => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-mural-test-'))
  const dbPath = path.join(folder, 'notes.sqlite')
  let db = openDatabase(dbPath)
  await createOwner(db, { username: 'mural-user', password: 'password123' })
  const session = createSession(db)
  const headers = { cookie: `ayame_session=${session.rawToken}` }
  let app = createApp({ db, vaultsRoot: folder })
  t.after(async () => {
    await app.close()
    fs.unlinkSync(dbPath)
    fs.rmdirSync(folder)
  })

  const url = `${base}/${id(1)}`
  const save = (payload) => app.inject({ method: 'PUT', url, headers, payload })
  assert.equal((await app.inject({ url: base })).statusCode, 401)
  assert.equal((await app.inject({ url, headers })).statusCode, 404)
  assert.equal((await save({ ...noteFields, body: '', expectedRevision: null })).statusCode, 400)
  assert.equal((await save({ ...noteFields, color: '#fff', expectedRevision: null })).statusCode, 400)

  const body = noteFields.body.repeat(16)
  const initial = { ...noteFields, title: '  Quick capture  ', body, expectedRevision: null }
  const created = await save(initial)
  assert.equal(created.statusCode, 200)
  assert.equal(created.headers['cache-control'], 'no-store')
  assert.equal(created.json().note.title, 'Quick capture')
  assert.equal(created.json().note.revision, 1)
  assert.deepEqual((await save(initial)).json(), created.json())

  const list = await app.inject({ url: base, headers })
  assert.equal(list.json().cards[0].preview, body.slice(0, MURAL_PREVIEW_LENGTH))
  assert.equal(Object.hasOwn(list.json().cards[0], 'body'), false)
  const update = await save({ ...noteFields, body, pinned: true, color: 'fern', expectedRevision: 1 })
  assert.equal(update.json().note.revision, 2)
  const stale = await save({ ...noteFields, body: 'Stale draft', expectedRevision: 1 })
  assert.equal(stale.statusCode, 409)
  assert.equal(stale.json().note.body, body)

  await app.close()
  db = openDatabase(dbPath)
  app = createApp({ db, vaultsRoot: folder })
  const reloaded = (await app.inject({ url, headers })).json().note
  assert.equal(reloaded.body, body)
  assert.equal(reloaded.color, 'fern')
  assert.equal(reloaded.pinned, true)
})

test('mural ordering, archive, restore, and cursor pagination keep their boundaries', async (t) => {
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'mural-user', password: 'password123' })
  const headers = { cookie: `ayame_session=${createSession(db).rawToken}` }
  const app = createApp({ db, vaultsRoot: os.tmpdir() })
  t.after(() => app.close())
  const put = (suffix, payload) => app.inject({ method: 'PUT', url: `${base}/${suffix}`, headers, payload })
  const list = async (query = '') => (await app.inject({ url: `${base}${query}`, headers })).json()
  for (let number = 1; number <= 18; number++) {
    const created = await put(id(number), { ...noteFields, pinned: number === 1, expectedRevision: null })
    assert.equal(created.statusCode, 200)
  }

  const page = await list()
  const rest = await list(`?after=${encodeURIComponent(page.next)}`)
  assert.equal(page.cards.length, 16)
  assert.equal(rest.cards.length, 2)
  assert.equal(rest.next, null)
  assert.equal(new Set([...page.cards, ...rest.cards].map((card) => card.id)).size, 18)
  assert.deepEqual(page.cards.slice(0, 3).map(({ id: cardId }) => cardId), [id(1), id(18), id(17)])

  const command = { direction: 'up', expectedPosition: 17 }
  const moved = await put(`${id(17)}/position`, command)
  assert.equal(moved.json().moved, true)
  assert.equal((await put(`${id(17)}/position`, command)).statusCode, 409)
  assert.deepEqual((await list()).cards.slice(0, 3).map(({ id: cardId }) => cardId), [id(1), id(17), id(18)])

  assert.equal((await put(id(17), { ...noteFields, archived: true, expectedRevision: 1 })).statusCode, 200)
  assert.equal((await list()).cards.some((card) => card.id === id(17)), false)
  assert.deepEqual((await list('?archived=true')).cards.map(({ id: cardId }) => cardId), [id(17)])
  assert.equal((await put(id(17), { ...noteFields, expectedRevision: 2 })).statusCode, 200)
  assert.equal((await list()).cards[1].id, id(17))
  assert.equal((await list('?archived=true')).cards.length, 0)
})

test('mural images use private thumbnails and support standalone cards and removable backgrounds', async (t) => {
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'mural-user', password: 'password123' })
  const headers = { cookie: `ayame_session=${createSession(db).rawToken}` }
  const app = createApp({ db, vaultsRoot: os.tmpdir() })
  t.after(() => app.close())
  const png = await sharp({ create: { width: 1280, height: 960, channels: 3, background: '#765080' } }).png().toBuffer()
  const jpg = await sharp({ create: { width: 700, height: 900, channels: 3, background: '#a15a35' } }).jpeg().toBuffer()
  const image = `${base}/${id(1)}/image`
  const upload = (url, payload) => app.inject({ method: 'PUT', url, headers: { ...headers, 'content-type': 'application/octet-stream' }, payload })

  const anonymous = await app.inject({ method: 'PUT', url: `${image}?create=image`, headers: { 'content-type': 'application/octet-stream' }, payload: png })
  assert.equal(anonymous.statusCode, 401)
  const invalid = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  assert.equal((await upload(`${image}?create=image`, invalid)).statusCode, 415)
  assert.equal((await app.inject({ url: `${base}/${id(1)}`, headers })).statusCode, 404)

  const created = await upload(`${image}?create=image`, png)
  assert.equal(created.statusCode, 200)
  const { note } = created.json()
  assert.equal(note.kind, 'image')
  assert.equal(note.body, '')
  assert.equal(note.revision, 1)
  assert.match(note.imageVersion, /^[a-f0-9]{64}$/)
  assert.deepEqual((await upload(`${image}?create=image`, png)).json(), created.json())
  assert.equal((await upload(`${image}?create=image`, jpg)).statusCode, 409)
  const versioned = `${image}?v=${note.imageVersion}`
  assert.equal((await app.inject({ url: versioned })).statusCode, 401)

  const thumbnail = await app.inject({ url: versioned, headers })
  assert.equal(thumbnail.statusCode, 200)
  assert.equal(thumbnail.headers['content-type'], 'image/webp')
  assert.equal(thumbnail.headers['cache-control'], 'private, max-age=300, immutable')
  assert.equal(thumbnail.headers.vary, 'Cookie')
  assert.ok(thumbnail.rawPayload.length < png.length)
  const { width, height } = await sharp(thumbnail.rawPayload).metadata()
  assert.deepEqual([width, height], [640, 480])
  const conditional = await app.inject({ url: versioned, headers: { ...headers, 'if-none-match': thumbnail.headers.etag } })
  assert.equal(conditional.statusCode, 304)
  const original = await app.inject({ url: `${versioned}&variant=original`, headers })
  assert.equal(original.headers['content-type'], 'image/png')
  assert.deepEqual(original.rawPayload, png)
  assert.equal((await app.inject({ method: 'DELETE', url: `${image}?revision=1`, headers })).statusCode, 400)

  const text = `${base}/${id(2)}`
  const textImage = `${text}/image`
  const textNote = await app.inject({ method: 'PUT', url: text, headers, payload: { ...noteFields, expectedRevision: null } })
  assert.equal(textNote.json().note.kind, 'note')
  const background = await upload(`${textImage}?revision=1`, png)
  assert.equal(background.json().note.body, noteFields.body)
  assert.equal(background.json().note.revision, 2)
  assert.equal((await upload(`${textImage}?revision=1`, jpg)).statusCode, 409)
  const replaced = (await upload(`${textImage}?revision=2`, jpg)).json().note
  assert.notEqual(replaced.imageVersion, note.imageVersion)
  assert.equal(replaced.revision, 3)
  const stale = await app.inject({ url: `${textImage}?v=${note.imageVersion}`, headers })
  assert.equal(stale.headers['cache-control'], 'private, no-cache')
  const cards = (await app.inject({ url: base, headers })).json().cards
  assert.deepEqual(cards.map(({ kind, imageVersion }) => ({ kind, imageVersion })), [
    { kind: 'note', imageVersion: replaced.imageVersion }, { kind: 'image', imageVersion: note.imageVersion },
  ])
  const removed = (await app.inject({ method: 'DELETE', url: `${textImage}?revision=3`, headers })).json().note
  assert.equal(removed.imageVersion, null)
  assert.equal(removed.body, noteFields.body)
  assert.equal((await app.inject({ url: textImage, headers })).statusCode, 404)
})

test('dragging a card places it before or after a target and adopts its pinned group', async (t) => {
  const db = openDatabase(':memory:')
  await createOwner(db, { username: 'mural-user', password: 'password123' })
  const headers = { cookie: `ayame_session=${createSession(db).rawToken}` }
  const app = createApp({ db, vaultsRoot: os.tmpdir() })
  t.after(() => app.close())
  const put = (suffix, payload) => app.inject({ method: 'PUT', url: `${base}/${suffix}`, headers, payload })
  const list = async () => (await app.inject({ url: base, headers })).json().cards
  for (let number = 1; number <= 6; number++) {
    assert.equal((await put(id(number), { ...noteFields, pinned: number <= 2, expectedRevision: null })).statusCode, 200)
  }
  const move = (source, target, placement, expectedPosition, expectedTargetPosition) =>
    put(`${id(source)}/position`, { targetId: id(target), placement, expectedPosition, expectedTargetPosition })
  const before = await move(3, 1, 'before', 3, 1)
  assert.equal(before.statusCode, 200)
  assert.equal(before.json().note.pinned, true)
  assert.equal(before.json().note.revision, 2)
  assert.deepEqual((await list()).map((card) => card.id), [2, 3, 1, 6, 5, 4].map(id))
  assert.equal((await move(1, 2, 'before', 1, 2)).statusCode, 409)
  assert.equal((await move(1, 2, 'before', 1, 3)).statusCode, 200)
  assert.deepEqual((await list()).map((card) => card.id), [1, 2, 3, 6, 5, 4].map(id))

  const after = await move(1, 6, 'after', 3, 6)
  assert.equal(after.json().note.pinned, false)
  assert.equal(after.json().note.revision, 2)
  const ordered = await list()
  assert.deepEqual(ordered.map((card) => card.id), [2, 3, 6, 1, 5, 4].map(id))
  assert.equal(new Set(ordered.map((card) => card.position)).size, 6)
})
