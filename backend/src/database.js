import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'
import { MURAL_COLORS, MURAL_MAX_IMAGE_WIDTH, MURAL_MIN_IMAGE_WIDTH } from '../../shared/mural.js'

const OWNER_COLS = ['id', 'username', 'password_hash']
const SESSION_COLS = ['token_hash', 'expires_at']
const V1_VAULT_COLS = ['id', 'name', 'directory']
const V2_VAULT_COLS = [
  'id',
  'name',
  'directory',
  'position',
  'category',
  'tags_json',
  'description',
  'accent_color',
  'pinned',
  'cover_mime',
  'cover_blob',
  'cover_updated_at',
]
const MURAL_V3_COLS = [
  'id', 'title', 'body', 'color', 'pinned', 'archived', 'position', 'revision', 'updated_at',
]
const MURAL_V4_COLS = [...MURAL_V3_COLS, 'kind']
const MURAL_V5_COLS = [...MURAL_V4_COLS, 'image_width']
const MURAL_COLS = [...MURAL_V5_COLS, 'trashed_at']
const MURAL_IMAGE_COLS = ['card_id', 'version', 'mime', 'original', 'thumbnail']

const initializeMuralImages = (db) => {
  db.exec(`
    CREATE TABLE mural_image (
      card_id TEXT NOT NULL PRIMARY KEY REFERENCES mural_note(id) ON DELETE CASCADE,
      version TEXT NOT NULL,
      mime TEXT NOT NULL,
      original BLOB NOT NULL,
      thumbnail BLOB NOT NULL
    );
  `)
  db.pragma('user_version = 6')
}

const initializeMural = (db) => {
  db.exec(`
    CREATE TABLE mural_note (
      id TEXT NOT NULL PRIMARY KEY,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      color TEXT NOT NULL CHECK (color IN (${MURAL_COLORS.map((color) => `'${color}'`).join(', ')})),
      pinned INTEGER NOT NULL CHECK (pinned IN (0, 1)),
      archived INTEGER NOT NULL CHECK (archived IN (0, 1)),
      position INTEGER NOT NULL UNIQUE,
      revision INTEGER NOT NULL CHECK (revision > 0),
      updated_at INTEGER NOT NULL,
      kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'image')),
      image_width INTEGER CHECK (image_width IS NULL OR (image_width BETWEEN ${MURAL_MIN_IMAGE_WIDTH} AND ${MURAL_MAX_IMAGE_WIDTH})),
      trashed_at INTEGER
    );
    CREATE INDEX mural_note_listing ON mural_note(archived, pinned DESC, position DESC);
  `)
  initializeMuralImages(db)
}

const hasExactColumns = (db, table, expected) => {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name)
  return cols.length === expected.length && expected.every((col) => cols.includes(col))
}

const failCorruption = (db, message = 'Database corrupted') => {
  db.close()
  throw new Error(message)
}

export const openDatabase = (dbPath = 'data/ayame.sqlite') => {
  const isMemory = dbPath === ':memory:'
  if (!isMemory) {
    const dir = path.dirname(path.resolve(dbPath))
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  const db = new Database(dbPath)

  const userVersion = db.pragma('user_version', { simple: true })

  const userTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort()

  const tableNames = userTables.join(',')
  const hasLegacyTables = userTables.length === 3 && tableNames === 'owner,session,vault'
  const isFresh = userTables.length === 0 && userVersion === 0
  const isV1Schema = userVersion === 1 && hasLegacyTables
  const isV2Schema = userVersion === 2 && hasLegacyTables
  const isV3Schema = userVersion === 3 && userTables.length === 4 && tableNames === 'mural_note,owner,session,vault'
  const isV4Schema = userVersion === 4 && userTables.length === 5 && tableNames === 'mural_image,mural_note,owner,session,vault'
  const isV5Schema = userVersion === 5 && userTables.length === 5 && tableNames === 'mural_image,mural_note,owner,session,vault'
  const isV6Schema = userVersion === 6 && userTables.length === 5 && tableNames === 'mural_image,mural_note,owner,session,vault'

  if (!isFresh && !isV1Schema && !isV2Schema && !isV3Schema && !isV4Schema && !isV5Schema && !isV6Schema) {
    failCorruption(db, 'Database corrupted: unexpected schema')
  }

  const validateOwnerSessionInvariants = () => {
    const ownerCount = db.prepare('SELECT COUNT(*) AS count FROM owner').get().count
    const sessionCount = db.prepare('SELECT COUNT(*) AS count FROM session').get().count

    if (ownerCount === 0 && sessionCount > 0) {
      failCorruption(db, 'Database corrupted: sessions exist without owner')
    }

    if (ownerCount > 1) {
      failCorruption(db, 'Database corrupted: more than one owner exists')
    }

    if (ownerCount === 1) {
      const owner = db.prepare('SELECT id FROM owner LIMIT 1').get()
      if (owner.id !== 1) {
        failCorruption(db, 'Database corrupted: owner id must be 1')
      }
    }
  }

  if (isFresh) {
    const initialize = db.transaction(() => {
      db.exec(`
        CREATE TABLE owner (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          username TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL
        );

        CREATE TABLE session (
          token_hash TEXT PRIMARY KEY,
          expires_at INTEGER NOT NULL
        );

        CREATE TABLE vault (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          directory TEXT NOT NULL UNIQUE,
          position INTEGER,
          category TEXT NOT NULL DEFAULT '',
          tags_json TEXT NOT NULL DEFAULT '[]',
          description TEXT NOT NULL DEFAULT '',
          accent_color TEXT NOT NULL DEFAULT '',
          pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1)),
          cover_mime TEXT,
          cover_blob BLOB,
          cover_updated_at INTEGER
        );
      `)
      initializeMural(db)
    })
    try {
      initialize()
    } catch (err) {
      db.close()
      throw err
    }
  } else if (isV1Schema) {
    validateOwnerSessionInvariants()
    if (
      !hasExactColumns(db, 'owner', OWNER_COLS) ||
      !hasExactColumns(db, 'session', SESSION_COLS) ||
      !hasExactColumns(db, 'vault', V1_VAULT_COLS)
    ) {
      failCorruption(db, 'Database corrupted: unexpected vault schema')
    }

    const migrateV1 = db.transaction(() => {
      db.exec(`
        ALTER TABLE vault ADD COLUMN position INTEGER;
        ALTER TABLE vault ADD COLUMN category TEXT NOT NULL DEFAULT '';
        ALTER TABLE vault ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
        ALTER TABLE vault ADD COLUMN description TEXT NOT NULL DEFAULT '';
        ALTER TABLE vault ADD COLUMN accent_color TEXT NOT NULL DEFAULT '';
        ALTER TABLE vault ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0 CHECK (pinned IN (0, 1));
        ALTER TABLE vault ADD COLUMN cover_mime TEXT;
        ALTER TABLE vault ADD COLUMN cover_blob BLOB;
        ALTER TABLE vault ADD COLUMN cover_updated_at INTEGER;
      `)
      initializeMural(db)
    })
    try {
      migrateV1.immediate()
    } catch (err) {
      db.close()
      throw err
    }
  } else {
    validateOwnerSessionInvariants()
    if (
      !hasExactColumns(db, 'owner', OWNER_COLS) ||
      !hasExactColumns(db, 'session', SESSION_COLS) ||
      !hasExactColumns(db, 'vault', V2_VAULT_COLS) ||
      (isV3Schema && !hasExactColumns(db, 'mural_note', MURAL_V3_COLS)) ||
      (isV4Schema && (!hasExactColumns(db, 'mural_note', MURAL_V4_COLS) || !hasExactColumns(db, 'mural_image', MURAL_IMAGE_COLS))) ||
      (isV5Schema && (!hasExactColumns(db, 'mural_note', MURAL_V5_COLS) || !hasExactColumns(db, 'mural_image', MURAL_IMAGE_COLS))) ||
      (isV6Schema && (!hasExactColumns(db, 'mural_note', MURAL_COLS) || !hasExactColumns(db, 'mural_image', MURAL_IMAGE_COLS)))
    ) {
      failCorruption(db, 'Database corrupted: unexpected vault schema')
    }
    if (isV2Schema || isV3Schema || isV4Schema || isV5Schema) {
      try {
        db.transaction(() => {
          if (isV2Schema) {
            initializeMural(db)
          } else if (isV3Schema) {
            db.exec(`
              ALTER TABLE mural_note ADD COLUMN kind TEXT NOT NULL DEFAULT 'note' CHECK (kind IN ('note', 'image'));
              ALTER TABLE mural_note ADD COLUMN image_width INTEGER CHECK (image_width IS NULL OR (image_width BETWEEN ${MURAL_MIN_IMAGE_WIDTH} AND ${MURAL_MAX_IMAGE_WIDTH}));
              ALTER TABLE mural_note ADD COLUMN trashed_at INTEGER;
            `)
            initializeMuralImages(db)
          } else if (isV4Schema) {
            db.exec(`
              ALTER TABLE mural_note ADD COLUMN image_width INTEGER CHECK (image_width IS NULL OR (image_width BETWEEN ${MURAL_MIN_IMAGE_WIDTH} AND ${MURAL_MAX_IMAGE_WIDTH}));
              ALTER TABLE mural_note ADD COLUMN trashed_at INTEGER;
            `)
            db.pragma('user_version = 6')
          } else {
            db.exec('ALTER TABLE mural_note ADD COLUMN trashed_at INTEGER;')
            db.pragma('user_version = 6')
          }
        }).immediate()
      } catch (err) {
        db.close()
        throw err
      }
    }
  }

  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')

  return db
}

export const getOwner = (database) => {
  return database.prepare('SELECT id, username, password_hash FROM owner WHERE id = 1').get()
}

export const insertOwner = (database, username, passwordHash) => {
  database.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)').run(
    username,
    passwordHash
  )
}

export const updateOwnerPassword = (database, passwordHash) => {
  database.prepare('UPDATE owner SET password_hash = ? WHERE id = 1').run(passwordHash)
}

export const getSession = (database, tokenHash) => {
  return database.prepare('SELECT token_hash, expires_at FROM session WHERE token_hash = ?').get(tokenHash)
}

export const insertSession = (database, tokenHash, expiresAt) => {
  database.prepare('INSERT INTO session (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, expiresAt)
}

export const deleteSession = (database, tokenHash) => {
  database.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash)
}

export const countActiveSessions = (database, now = Date.now()) => {
  return database.prepare('SELECT COUNT(*) AS count FROM session WHERE expires_at > ?').get(now).count
}

export const deleteOtherSessions = (database, keepTokenHash) => {
  return database.prepare('DELETE FROM session WHERE token_hash != ?').run(keepTokenHash).changes
}

export const pruneExpiredSessions = (database, now = Date.now()) => {
  return database.prepare('DELETE FROM session WHERE expires_at <= ?').run(now).changes
}

export const closeDatabase = (database) => {
  try {
    database.pragma('wal_checkpoint(TRUNCATE)')
  } catch {}
  database.close()
}
