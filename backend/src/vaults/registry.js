import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVaultRoot } from './filesystem.js'
import { discoverVaultDirectories, mergeVaults, collectVaultStats } from './discovery.js'
import { detectImageMime } from './images.js'

export const MAX_VAULT_COVER_BYTES = 2 * 1024 * 1024

const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i
const FORBIDDEN_DIR_CHARS = /[\x00-\x1f\x7f/\\:<>?"|*]/
const TAG_REGEX = /^[\p{L}\p{N}_\-/]{1,40}$/u
const COLOR_REGEX = /^#[0-9a-fA-F]{6}$/

const fail = (code, message) => {
  const err = new Error(message)
  err.code = code
  throw err
}

export const validVaultName = (name) => {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && name === name.trim()
}

const normalizeCategory = (category) => {
  if (category === undefined) return undefined
  if (typeof category !== 'string' || /[\x00-\x1f\x7f]/.test(category)) {
    fail('INVALID_VAULT_CATEGORY', 'Invalid vault category')
  }
  const trimmed = category.trim()
  if (trimmed.length > 60) {
    fail('INVALID_VAULT_CATEGORY', 'Category exceeds 60 characters')
  }
  return trimmed
}

const normalizeDescription = (description) => {
  if (description === undefined) return undefined
  if (typeof description !== 'string' || description.includes('\0')) {
    fail('INVALID_VAULT_DESCRIPTION', 'Invalid vault description')
  }
  const trimmed = description.trim()
  if (trimmed.length > 280) {
    fail('INVALID_VAULT_DESCRIPTION', 'Description exceeds 280 characters')
  }
  return trimmed
}

const normalizeTags = (tags) => {
  if (tags === undefined) return undefined
  if (!Array.isArray(tags) || tags.length > 24) {
    fail('INVALID_VAULT_TAGS', 'Invalid vault tags')
  }
  const seen = new Set()
  const normalized = []
  for (const rawTag of tags) {
    if (typeof rawTag !== 'string') {
      fail('INVALID_VAULT_TAGS', 'Invalid vault tag')
    }
    const stripped = rawTag.trim().replace(/^#+/, '')
    if (!TAG_REGEX.test(stripped)) {
      fail('INVALID_VAULT_TAGS', 'Invalid vault tag format')
    }
    const lower = stripped.toLowerCase()
    if (!seen.has(lower)) {
      seen.add(lower)
      normalized.push(stripped)
    }
  }
  return normalized
}

const normalizeAccentColor = (accentColor) => {
  if (accentColor === undefined) return undefined
  if (typeof accentColor !== 'string') {
    fail('INVALID_VAULT_COLOR', 'Invalid vault color')
  }
  const trimmed = accentColor.trim()
  if (trimmed !== '' && !COLOR_REGEX.test(trimmed)) {
    fail('INVALID_VAULT_COLOR', 'Color must be a 6-digit hex code')
  }
  return trimmed.toLowerCase()
}

const normalizePinned = (pinned) => {
  if (pinned === undefined) return undefined
  if (typeof pinned !== 'boolean') {
    fail('INVALID_VAULT_PAYLOAD', 'Invalid pinned flag')
  }
  return pinned
}

const validateDirectoryCandidate = (directory) => {
  if (
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.trim() !== directory ||
    directory === '.' ||
    directory === '..' ||
    directory.startsWith('.') ||
    /[. ]$/.test(directory) ||
    FORBIDDEN_DIR_CHARS.test(directory) ||
    RESERVED_DEVICE_NAME.test(directory) ||
    Buffer.byteLength(directory, 'utf8') > 100
  ) {
    fail('INVALID_VAULT_DIRECTORY', 'Invalid vault directory name')
  }
  return directory
}

const deriveDirectoryFromName = (name) => {
  let cleaned = name
    .replace(/[\x00-\x1f\x7f/\\:<>?"|*]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()

  if (!cleaned || cleaned === '.' || cleaned === '..' || RESERVED_DEVICE_NAME.test(cleaned)) {
    cleaned = 'vault'
  }

  while (Buffer.byteLength(cleaned, 'utf8') > 100) {
    cleaned = cleaned.slice(0, -1).trim().replace(/[. ]+$/, '')
  }

  return cleaned || 'vault'
}

const parseTagsJson = (raw) => {
  try {
    const parsed = JSON.parse(raw || '[]')
    return Array.isArray(parsed) ? parsed.filter((t) => typeof t === 'string') : []
  } catch {
    return []
  }
}

const SELECT_META_COLS = `
  id,
  name,
  directory,
  position,
  category,
  tags_json,
  description,
  accent_color,
  pinned,
  (cover_mime IS NOT NULL AND cover_blob IS NOT NULL) AS has_cover,
  cover_updated_at
`

const mapDbRowToRecord = (row) => ({
  id: row.id,
  name: row.name,
  directory: row.directory,
  registered: true,
  position: typeof row.position === 'number' ? row.position : null,
  category: typeof row.category === 'string' ? row.category : '',
  tags: parseTagsJson(row.tags_json),
  description: typeof row.description === 'string' ? row.description : '',
  accentColor: typeof row.accent_color === 'string' ? row.accent_color : '',
  pinned: Boolean(row.pinned),
  hasCover: Boolean(row.has_cover),
  coverUpdatedAt: typeof row.cover_updated_at === 'number' ? row.cover_updated_at : null,
})

const getRegisteredRowByDirectory = (database, directory) => {
  const row = database.prepare(`SELECT ${SELECT_META_COLS} FROM vault WHERE directory = ?`).get(directory)
  return row ? mapDbRowToRecord(row) : null
}

const toPublicVault = (vaultsRoot, record) => ({
  ...record,
  ...collectVaultStats(vaultsRoot, record.directory),
})

export const registerVault = (
  database,
  vaultsRoot,
  { name, directory, category, tags, description, accentColor, pinned } = {},
  { idFn = crypto.randomUUID, resolveRootFn = resolveVaultRoot } = {}
) => {
  if (!validVaultName(name)) {
    fail('INVALID_VAULT_NAME', 'Invalid vault name')
  }

  const normalizedCategory = normalizeCategory(category) ?? ''
  const normalizedTags = normalizeTags(tags) ?? []
  const normalizedDescription = normalizeDescription(description) ?? ''
  const normalizedColor = normalizeAccentColor(accentColor) ?? ''
  const normalizedPinned = normalizePinned(pinned) ?? false

  // Ensures physical direct-child directory exists and is valid
  resolveRootFn(vaultsRoot, directory)

  const id = idFn()

  try {
    database
      .prepare(`
        INSERT INTO vault (id, name, directory, category, tags_json, description, accent_color, pinned)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        name,
        directory,
        normalizedCategory,
        JSON.stringify(normalizedTags),
        normalizedDescription,
        normalizedColor,
        normalizedPinned ? 1 : 0
      )
  } catch (dbErr) {
    if (dbErr.code === 'SQLITE_CONSTRAINT_UNIQUE' || dbErr.message?.includes('UNIQUE constraint failed')) {
      fail('VAULT_ALREADY_REGISTERED', 'Vault already registered')
    }
    throw dbErr
  }

  return getRegisteredRowByDirectory(database, directory)
}

export const createVault = (
  database,
  vaultsRoot,
  rawPayload = {},
  { idFn = crypto.randomUUID } = {}
) => {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    fail('INVALID_VAULT_PAYLOAD', 'Invalid vault creation payload')
  }

  const {
    name,
    directory: rawDirectory,
    category,
    tags,
    description,
    accentColor,
    pinned,
    createWelcomeNote = false,
  } = rawPayload

  if (!validVaultName(name)) {
    fail('INVALID_VAULT_NAME', 'Invalid vault name')
  }
  if (typeof createWelcomeNote !== 'boolean') {
    fail('INVALID_VAULT_PAYLOAD', 'Invalid createWelcomeNote flag')
  }

  const directory = rawDirectory !== undefined && rawDirectory !== ''
    ? validateDirectoryCandidate(rawDirectory)
    : validateDirectoryCandidate(deriveDirectoryFromName(name))

  const normalizedCategory = normalizeCategory(category) ?? ''
  const normalizedTags = normalizeTags(tags) ?? []
  const normalizedDescription = normalizeDescription(description) ?? ''
  const normalizedColor = normalizeAccentColor(accentColor) ?? ''
  const normalizedPinned = normalizePinned(pinned) ?? false

  let canonicalRoot
  try {
    canonicalRoot = fs.realpathSync.native(vaultsRoot)
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      fail('INVALID_VAULT_ROOT', 'Vault root is not a directory')
    }
  } catch (err) {
    if (err.code === 'INVALID_VAULT_ROOT') throw err
    fail('INVALID_VAULT_ROOT', 'Invalid vault root')
  }

  const existingEntries = fs.readdirSync(canonicalRoot, { withFileTypes: true })
  if (existingEntries.some((entry) => entry.name.toLowerCase() === directory.toLowerCase())) {
    fail('VAULT_ALREADY_EXISTS', 'A vault folder with that directory name already exists')
  }

  const existingRow = database.prepare('SELECT id FROM vault WHERE LOWER(directory) = LOWER(?)').get(directory)
  if (existingRow) {
    fail('VAULT_ALREADY_EXISTS', 'A vault with that directory is already registered')
  }

  const targetDir = path.join(canonicalRoot, directory)
  try {
    fs.mkdirSync(targetDir, { recursive: false })
  } catch (err) {
    if (err.code === 'EEXIST') {
      fail('VAULT_ALREADY_EXISTS', 'A vault folder with that directory name already exists')
    }
    fail('VAULT_CREATE_FAILED', 'Could not create vault folder')
  }

  try {
    if (createWelcomeNote) {
      const welcomePath = path.join(targetDir, 'Welcome.md')
      const welcomeContent = `# ${name}\n\nWelcome to your **${name}** vault in Ayame.\n`
      const fd = fs.openSync(welcomePath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o666)
      try {
        fs.writeFileSync(fd, welcomeContent, 'utf8')
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
    }

    const id = idFn()
    database
      .prepare(`
        INSERT INTO vault (id, name, directory, category, tags_json, description, accent_color, pinned)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        name,
        directory,
        normalizedCategory,
        JSON.stringify(normalizedTags),
        normalizedDescription,
        normalizedColor,
        normalizedPinned ? 1 : 0
      )

    const record = getRegisteredRowByDirectory(database, directory)
    return toPublicVault(vaultsRoot, record)
  } catch (err) {
    try {
      fs.rmSync(targetDir, { recursive: true, force: true })
    } catch {}
    throw err
  }
}

const ALLOWED_PATCH_KEYS = new Set(['name', 'category', 'tags', 'description', 'accentColor', 'pinned'])

export const updateVaultMetadata = (
  database,
  vaultsRoot,
  directory,
  patch = {},
  { idFn = crypto.randomUUID } = {}
) => {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    fail('INVALID_VAULT_PAYLOAD', 'Invalid vault update payload')
  }

  for (const key of Object.keys(patch)) {
    if (!ALLOWED_PATCH_KEYS.has(key)) {
      fail('INVALID_VAULT_PAYLOAD', `Unknown vault metadata field: ${key}`)
    }
  }

  resolveVaultRoot(vaultsRoot, directory)

  const nextName = patch.name !== undefined ? (validVaultName(patch.name) ? patch.name : fail('INVALID_VAULT_NAME', 'Invalid vault name')) : undefined
  const nextCategory = normalizeCategory(patch.category)
  const nextTags = normalizeTags(patch.tags)
  const nextDescription = normalizeDescription(patch.description)
  const nextColor = normalizeAccentColor(patch.accentColor)
  const nextPinned = normalizePinned(patch.pinned)

  const tx = database.transaction(() => {
    const existing = getRegisteredRowByDirectory(database, directory)
    if (!existing) {
      const id = idFn()
      database
        .prepare(`
          INSERT INTO vault (id, name, directory, category, tags_json, description, accent_color, pinned)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `)
        .run(
          id,
          nextName ?? directory,
          directory,
          nextCategory ?? '',
          JSON.stringify(nextTags ?? []),
          nextDescription ?? '',
          nextColor ?? '',
          (nextPinned ?? false) ? 1 : 0
        )
    } else {
      database
        .prepare(`
          UPDATE vault
          SET name = ?,
              category = ?,
              tags_json = ?,
              description = ?,
              accent_color = ?,
              pinned = ?
          WHERE directory = ?
        `)
        .run(
          nextName ?? existing.name,
          nextCategory ?? existing.category,
          JSON.stringify(nextTags ?? existing.tags),
          nextDescription ?? existing.description,
          nextColor ?? existing.accentColor,
          (nextPinned ?? existing.pinned) ? 1 : 0,
          directory
        )
    }
    return getRegisteredRowByDirectory(database, directory)
  })

  return toPublicVault(vaultsRoot, tx())
}

export const reorderVaults = (
  database,
  vaultsRoot,
  directories,
  { idFn = crypto.randomUUID } = {}
) => {
  if (!Array.isArray(directories) || directories.length === 0) {
    fail('INVALID_VAULT_ORDER', 'Vault order must be a non-empty array of directories')
  }

  const seen = new Set()
  for (const dir of directories) {
    if (typeof dir !== 'string' || dir.length === 0 || seen.has(dir)) {
      fail('INVALID_VAULT_ORDER', 'Vault order contains invalid or duplicate directory entries')
    }
    seen.add(dir)
    resolveVaultRoot(vaultsRoot, dir)
  }

  const tx = database.transaction(() => {
    const existingRows = database
      .prepare(`SELECT id, directory, position FROM vault ORDER BY COALESCE(position, 2147483647) ASC, name COLLATE NOCASE ASC`)
      .all()
    const existingByDir = new Map(existingRows.map((r) => [r.directory, r]))

    directories.forEach((dir, index) => {
      if (existingByDir.has(dir)) {
        database.prepare('UPDATE vault SET position = ? WHERE directory = ?').run(index, dir)
      } else {
        database
          .prepare('INSERT INTO vault (id, name, directory, position) VALUES (?, ?, ?, ?)')
          .run(idFn(), dir, dir, index)
      }
    })

    let nextPos = directories.length
    for (const row of existingRows) {
      if (!seen.has(row.directory)) {
        database.prepare('UPDATE vault SET position = ? WHERE directory = ?').run(nextPos++, row.directory)
      }
    }
  })

  tx()
  return listVaults(database, vaultsRoot)
}

export const setVaultCover = (
  database,
  vaultsRoot,
  directory,
  buffer,
  { idFn = crypto.randomUUID } = {}
) => {
  resolveVaultRoot(vaultsRoot, directory)

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('UNSUPPORTED_IMAGE_TYPE', 'Cover image must be a non-empty PNG, JPEG, WebP, or GIF image')
  }
  if (buffer.length > MAX_VAULT_COVER_BYTES) {
    fail('VAULT_COVER_TOO_LARGE', 'Cover image exceeds 2 MiB limit')
  }
  const mime = detectImageMime(buffer)
  if (!mime) {
    fail('UNSUPPORTED_IMAGE_TYPE', 'Unsupported cover image type')
  }

  const updatedAt = Date.now()
  const tx = database.transaction(() => {
    const existing = getRegisteredRowByDirectory(database, directory)
    if (!existing) {
      database
        .prepare(`
          INSERT INTO vault (id, name, directory, cover_mime, cover_blob, cover_updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
        `)
        .run(idFn(), directory, directory, mime, buffer, updatedAt)
    } else {
      database
        .prepare('UPDATE vault SET cover_mime = ?, cover_blob = ?, cover_updated_at = ? WHERE directory = ?')
        .run(mime, buffer, updatedAt, directory)
    }
    return getRegisteredRowByDirectory(database, directory)
  })

  return toPublicVault(vaultsRoot, tx())
}

export const getVaultCover = (database, vaultsRoot, directory) => {
  resolveVaultRoot(vaultsRoot, directory)
  const row = database
    .prepare('SELECT cover_mime, cover_blob, cover_updated_at FROM vault WHERE directory = ?')
    .get(directory)

  if (!row || !Buffer.isBuffer(row.cover_blob) || !row.cover_mime) {
    fail('VAULT_COVER_NOT_FOUND', 'Vault cover not found')
  }
  const verifiedMime = detectImageMime(row.cover_blob)
  if (!verifiedMime || verifiedMime !== row.cover_mime) {
    fail('UNSUPPORTED_IMAGE_TYPE', 'Stored cover image is invalid')
  }

  return {
    mimeType: verifiedMime,
    buffer: row.cover_blob,
    updatedAt: row.cover_updated_at,
  }
}

export const clearVaultCover = (database, vaultsRoot, directory) => {
  resolveVaultRoot(vaultsRoot, directory)
  database
    .prepare('UPDATE vault SET cover_mime = NULL, cover_blob = NULL, cover_updated_at = NULL WHERE directory = ?')
    .run(directory)

  const record = getRegisteredRowByDirectory(database, directory)
  if (record) {
    return toPublicVault(vaultsRoot, record)
  }
  return {
    id: null,
    name: directory,
    directory,
    registered: false,
    position: null,
    category: '',
    tags: [],
    description: '',
    accentColor: '',
    pinned: false,
    hasCover: false,
    coverUpdatedAt: null,
    ...collectVaultStats(vaultsRoot, directory),
  }
}

export const listRegisteredVaults = (database) => {
  const rows = database
    .prepare(`SELECT ${SELECT_META_COLS} FROM vault ORDER BY COALESCE(position, 2147483647) ASC, name COLLATE NOCASE ASC, directory ASC`)
    .all()
  return rows.map(mapDbRowToRecord)
}

export const listVaults = (database, vaultsRoot) => {
  const discovered = discoverVaultDirectories(vaultsRoot)
  const registered = listRegisteredVaults(database)
  const statsByDir = new Map()
  for (const dir of discovered) {
    statsByDir.set(dir, collectVaultStats(vaultsRoot, dir))
  }
  return mergeVaults(discovered, registered, statsByDir)
}

export const unregisterVault = (database, id) => {
  database.prepare('DELETE FROM vault WHERE id = ?').run(id)
}
