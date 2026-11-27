import { createHash } from 'node:crypto'
import { MURAL_COLORS, MURAL_MAX_BODY_LENGTH, MURAL_MAX_IMAGE_BYTES, MURAL_MAX_TITLE_LENGTH, MURAL_PREVIEW_LENGTH } from '../../../shared/mural.js'
import { detectImageMime } from '../vaults/images.js'
import { resizeImageThumbnail } from '../vaults/coverThumbnails.js'

const ROOT = '/vaults/mural/cards'
const PAGE_SIZE = 16
const MAX_ANIMATED_PREVIEW_BYTES = 256 * 1024
const NO_STORE = { config: { noStore: true, affectsVault: false } }
const IMAGE_ROUTE = `${ROOT}/:id/image`
const IMAGE_JOIN = 'FROM mural_note LEFT JOIN mural_image ON mural_image.card_id = mural_note.id'
const NOTE_FIELDS = 'id, title, body, color, pinned, archived, position, revision, updated_at AS updatedAt, kind, version AS imageVersion'
const validId = (id) => typeof id === 'string' && /^[a-f0-9]{32}$/.test(id)
const positiveInteger = (value) => Number.isSafeInteger(value) && value > 0
const publicNote = (row) => ({ ...row, pinned: Boolean(row.pinned), archived: Boolean(row.archived) })
const invalid = (reply) => reply.code(400).send({ error: 'INVALID_MURAL_NOTE' })
const missing = (reply) => reply.code(404).send({ error: 'MURAL_NOTE_NOT_FOUND' })
const parseRevision = (value) => typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : null
const makePage = (rows) => {
  const last = rows[PAGE_SIZE - 1]
  return {
    cards: rows.slice(0, PAGE_SIZE).map(publicNote),
    next: rows.length > PAGE_SIZE ? `${last.pinned}:${last.position}` : null,
  }
}

export function registerMuralRoutes(app, db) {
  const cardsQuery = `
    SELECT id, title, substr(body, 1, ${MURAL_PREVIEW_LENGTH}) AS preview, color, pinned, archived, position, kind, version AS imageVersion
    ${IMAGE_JOIN}
  `
  const list = db.prepare(`${cardsQuery}
    WHERE archived = ? AND (pinned, position) < (?, ?)
    ORDER BY pinned DESC, position DESC LIMIT ?
  `)
  const listGroup = db.prepare(`${cardsQuery}
    WHERE archived = ? AND pinned = ? AND position < ?
    ORDER BY position DESC LIMIT ?
  `)
  const read = db.prepare(`SELECT ${NOTE_FIELDS} ${IMAGE_JOIN} WHERE id = ?`)
  const deleteNote = db.prepare('DELETE FROM mural_note WHERE id = ?')
  const removeNote = db.transaction((id, expectedRevision) => {
    const note = read.get(id)
    if (!note) return {}
    if (note.revision !== expectedRevision) return { conflict: publicNote(note) }
    deleteNote.run(id)
    return {}
  })
  const nextPosition = db.prepare('SELECT coalesce(max(position), 0) + 1 AS position FROM mural_note')
  const insert = db.prepare(`
    INSERT INTO mural_note (id, title, body, color, pinned, archived, position, revision, updated_at, kind)
    VALUES (@id, @title, @body, @color, @pinned, @archived, @position, 1, @now, @kind)
  `)
  const update = db.prepare(`
    UPDATE mural_note SET title = @title, body = @body, color = @color, pinned = @pinned,
      archived = @archived, position = @position, revision = revision + 1, updated_at = @now
    WHERE id = @id
  `)
  const applyNote = db.transaction((id, data, expectedRevision) => {
    const existing = read.get(id)
    if (!existing) {
      if (expectedRevision !== null) return null
      insert.run({ id, ...data, position: nextPosition.get().position, now: Date.now(), kind: 'note' })
    } else {
      if (existing.kind === 'image' && data.body) return { invalid: true }
      // A retried save can succeed if the exact change is already present.
      if (Object.entries(data).every(([key, value]) => existing[key] === value)) return { note: publicNote(existing) }
      if (existing.revision !== expectedRevision) return { conflict: publicNote(existing) }
      const regroup = existing.pinned !== data.pinned || existing.archived !== data.archived
      const position = regroup ? nextPosition.get().position : existing.position
      update.run({ id, ...data, position, now: Date.now() })
    }
    return { note: publicNote(read.get(id)) }
  })

  const neighbor = {
    up: db.prepare('SELECT id, position FROM mural_note WHERE archived = 0 AND pinned = ? AND position > ? ORDER BY position ASC LIMIT 1'),
    down: db.prepare('SELECT id, position FROM mural_note WHERE archived = 0 AND pinned = ? AND position < ? ORDER BY position DESC LIMIT 1'),
  }
  const setPosition = db.prepare('UPDATE mural_note SET position = ? WHERE id = ?')
  const positionOf = db.prepare('SELECT id, position, pinned, archived FROM mural_note WHERE id = ?')
  const positionsInGroup = db.prepare('SELECT id, position FROM mural_note WHERE archived = ? AND pinned = ? ORDER BY position DESC')
  const setPinned = db.prepare('UPDATE mural_note SET pinned = ?, revision = revision + 1, updated_at = ? WHERE id = ?')
  const moveNote = db.transaction((id, direction, expectedPosition) => {
    const note = read.get(id)
    if (!note) return null
    if (note.archived || note.position !== expectedPosition) return { conflict: publicNote(note) }
    const target = neighbor[direction].get(note.pinned, note.position)
    if (target) {
      setPosition.run(0, id)
      setPosition.run(note.position, target.id)
      setPosition.run(target.position, id)
    }
    const positions = target ? [{ id, position: target.position }, { id: target.id, position: note.position }] : []
    return { note: publicNote(read.get(id)), moved: Boolean(target), positions }
  })

  const moveRelative = db.transaction((id, targetId, placement, expectedPosition, expectedTargetPosition) => {
    const source = positionOf.get(id)
    if (!source) return null
    const target = positionOf.get(targetId)
    if (!target || source.archived !== target.archived || source.position !== expectedPosition || target.position !== expectedTargetPosition) {
      return { conflict: publicNote(read.get(id)) }
    }

    const group = positionsInGroup.all(target.archived, target.pinned)
    const reordered = group.filter((item) => item.id !== id)
    const targetIndex = reordered.findIndex((item) => item.id === targetId)
    reordered.splice(targetIndex + Number(placement === 'after'), 0, source)
    const slots = reordered.map(({ position }) => position).sort((a, b) => b - a)
    const changes = reordered.flatMap((item, i) => item.position === slots[i] ? [] : [{ id: item.id, position: slots[i] }])

    // Move changed rows out of the positive positions before assigning their new slots.
    for (const { id: changedId, position } of changes) setPosition.run(-position, changedId)
    for (const { id: changedId, position } of changes) setPosition.run(position, changedId)
    if (source.pinned !== target.pinned) setPinned.run(target.pinned, Date.now(), id)

    return { note: publicNote(read.get(id)), moved: changes.length > 0 || source.pinned !== target.pinned, positions: changes }
  })

  app.get(ROOT, NO_STORE, (req, reply) => {
    const { archived = 'false', after, groups, pinned } = req.query
    if (archived !== 'true' && archived !== 'false') return invalid(reply)
    if (groups !== undefined && (groups !== 'true' || pinned !== undefined || after !== undefined)) return invalid(reply)
    if (pinned !== undefined && pinned !== 'true' && pinned !== 'false') return invalid(reply)
    const cursor = typeof after === 'string' ? /^([01]):([1-9][0-9]{0,15})$/.exec(after) : null
    if (after !== undefined && (!cursor || !positiveInteger(Number(cursor[2])))) return invalid(reply)
    const isArchived = Number(archived === 'true')
    const position = Number(cursor?.[2] ?? Number.MAX_SAFE_INTEGER)
    const groupPage = (pin) => makePage(listGroup.all(isArchived, pin, position, PAGE_SIZE + 1))
    if (groups) return reply.send({ pinned: groupPage(1), notes: groupPage(0) })
    if (pinned !== undefined) {
      const pin = Number(pinned === 'true')
      if (cursor && Number(cursor[1]) !== pin) return invalid(reply)
      return reply.send(groupPage(pin))
    }
    return reply.send(makePage(list.all(isArchived, Number(cursor?.[1] ?? 1), position, PAGE_SIZE + 1)))
  })

  app.get(`${ROOT}/:id`, NO_STORE, (req, reply) => {
    if (!validId(req.params.id)) return invalid(reply)
    const row = read.get(req.params.id)
    return row ? reply.send({ note: publicNote(row) }) : missing(reply)
  })

  app.delete(`${ROOT}/:id`, NO_STORE, (req, reply) => {
    const { id } = req.params
    const expectedRevision = parseRevision(req.query.revision)
    if (!validId(id) || !positiveInteger(expectedRevision)) return invalid(reply)
    const { conflict } = removeNote.immediate(id, expectedRevision)
    if (conflict) return reply.code(409).send({ error: 'MURAL_NOTE_CONFLICT', note: conflict })
    return reply.send({ deleted: true })
  })

  app.put(`${ROOT}/:id`, { ...NO_STORE, bodyLimit: 128 * 1024 }, (req, reply) => {
    const { id } = req.params
    const { title, body, color, pinned, archived, expectedRevision } = req.body ?? {}
    if (
      !validId(id) || typeof title !== 'string' || title.length > MURAL_MAX_TITLE_LENGTH ||
      typeof body !== 'string' || body.length > MURAL_MAX_BODY_LENGTH || !MURAL_COLORS.includes(color) ||
      typeof pinned !== 'boolean' || typeof archived !== 'boolean' ||
      (expectedRevision !== null && !positiveInteger(expectedRevision)) ||
      (expectedRevision === null && !title.trim() && !body.trim())
    ) return invalid(reply)

    const result = applyNote.immediate(id, { title: title.trim(), body, color, pinned: Number(pinned), archived: Number(archived) }, expectedRevision)
    if (!result) return missing(reply)
    if (result.invalid) return invalid(reply)
    if (result.conflict) return reply.code(409).send({ error: 'MURAL_NOTE_CONFLICT', note: result.conflict })
    return reply.send(result)
  })

  app.put(`${ROOT}/:id/position`, { ...NO_STORE, bodyLimit: 1024 }, (req, reply) => {
    const { id } = req.params
    const { direction, expectedPosition, targetId, placement, expectedTargetPosition } = req.body ?? {}
    if (!validId(id) || !positiveInteger(expectedPosition)) return invalid(reply)
    let result
    if (direction === undefined) {
      if (!validId(targetId) || id === targetId || !['before', 'after'].includes(placement) || !positiveInteger(expectedTargetPosition)) return invalid(reply)
      result = moveRelative.immediate(id, targetId, placement, expectedPosition, expectedTargetPosition)
    } else {
      if (!['up', 'down'].includes(direction)) return invalid(reply)
      result = moveNote.immediate(id, direction, expectedPosition)
    }
    if (!result) return missing(reply)
    if (result.conflict) return reply.code(409).send({ error: 'MURAL_POSITION_CONFLICT', note: result.conflict })
    return reply.send(result)
  })

  const original = db.prepare('SELECT version, mime, original AS buffer FROM mural_image WHERE card_id = ?')
  const thumbnail = db.prepare("SELECT version, 'image/webp' AS mime, thumbnail AS buffer FROM mural_image WHERE card_id = ?")
  const storeImage = db.prepare(`
    INSERT INTO mural_image (card_id, version, mime, original, thumbnail)
    VALUES (@id, @version, @mime, @original, @thumbnail)
    ON CONFLICT(card_id) DO UPDATE SET version = excluded.version, mime = excluded.mime,
      original = excluded.original, thumbnail = excluded.thumbnail
  `)
  const deleteImage = db.prepare('DELETE FROM mural_image WHERE card_id = ?')
  const recordImageChange = db.prepare('UPDATE mural_note SET revision = revision + 1, updated_at = ? WHERE id = ?')

  const applyImage = db.transaction((id, expectedRevision, create, image) => {
    const note = read.get(id)
    if (!note) {
      if (!create) return null
      insert.run({
        id, title: '', body: '', color: 'neutral', pinned: 0, archived: 0,
        position: nextPosition.get().position, now: Date.now(), kind: 'image',
      })
    } else {
      if (create && note.kind !== 'image') return { conflict: publicNote(note) }
      if (image?.version === note.imageVersion) return { note: publicNote(note) }
      if (!image && note.kind === 'image') return { invalid: true }
      if (!image && !note.imageVersion) return { note: publicNote(note) }
      if (create || expectedRevision !== note.revision) return { conflict: publicNote(note) }
      recordImageChange.run(Date.now(), id)
    }
    if (image) storeImage.run({ id, ...image })
    else deleteImage.run(id)
    return { note: publicNote(read.get(id)) }
  })

  const sendImageResult = (reply, result) => {
    if (!result) return missing(reply)
    if (result.invalid) return invalid(reply)
    if (result.conflict) return reply.code(409).send({ error: 'MURAL_NOTE_CONFLICT', note: result.conflict })
    return reply.send(result)
  }

  app.get(IMAGE_ROUTE, NO_STORE, (req, reply) => {
    const { id } = req.params
    if (!validId(id)) return invalid(reply)
    const showOriginal = req.query.variant === 'original'
    const image = (showOriginal ? original : thumbnail).get(id)
    if (!image) return missing(reply)

    const etag = `"${image.version}-${showOriginal ? 'original' : 'thumbnail'}"`
    reply.header('vary', 'Cookie')
    reply.header('etag', etag)
    reply.header('x-content-type-options', 'nosniff')
    reply.header('content-security-policy', "default-src 'none'")
    reply.header('cache-control', req.query.v === image.version ? 'private, max-age=300, immutable' : 'private, no-cache')
    const headers = req.headers['if-none-match']?.split(',') ?? []
    if (headers.some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === etag)) return reply.code(304).send()
    return reply.type(image.mime).send(image.buffer)
  })

  app.put(IMAGE_ROUTE, { ...NO_STORE, bodyLimit: MURAL_MAX_IMAGE_BYTES }, async (req, reply) => {
    const { id } = req.params
    const { create, revision } = req.query
    const createImageCard = create === 'image'
    const expectedRevision = parseRevision(revision)
    if (!validId(id) || (createImageCard ? revision !== undefined : create !== undefined || !positiveInteger(expectedRevision))) {
      return invalid(reply)
    }
    const mime = detectImageMime(req.body)
    if (!mime) return reply.code(415).send({ error: 'INVALID_MURAL_IMAGE' })
    const version = createHash('sha256').update(req.body).digest('hex')
    const current = read.get(id)
    if (!current && !createImageCard) return missing(reply)
    if (current?.imageVersion === version && (!createImageCard || current.kind === 'image')) {
      return reply.send({ note: publicNote(current) })
    }
    if (current && (createImageCard || expectedRevision !== current.revision)) {
      return sendImageResult(reply, { conflict: publicNote(current) })
    }

    let resized
    try {
      const animated = mime === 'image/gif' || mime === 'image/webp'
      resized = await resizeImageThumbnail(req.body, { height: 480, animated })
      if (animated && resized.length > MAX_ANIMATED_PREVIEW_BYTES) {
        resized = await resizeImageThumbnail(req.body, { height: 480 })
      }
    } catch {
      return reply.code(415).send({ error: 'INVALID_MURAL_IMAGE' })
    }
    return sendImageResult(reply, applyImage.immediate(id, expectedRevision, createImageCard, {
      version, mime, original: req.body, thumbnail: resized,
    }))
  })

  app.delete(IMAGE_ROUTE, NO_STORE, (req, reply) => {
    const expectedRevision = parseRevision(req.query.revision)
    if (!validId(req.params.id) || !positiveInteger(expectedRevision)) return invalid(reply)
    return sendImageResult(reply, applyImage.immediate(req.params.id, expectedRevision, false, null))
  })
}
