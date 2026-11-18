import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

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

  const hasExpectedTables =
    userTables.length === 3 &&
    userTables[0] === 'owner' &&
    userTables[1] === 'session' &&
    userTables[2] === 'vault'

  const isFresh = userTables.length === 0 && userVersion === 0
  const isV1Schema = userVersion === 1 && hasExpectedTables
  const isV2Schema = userVersion === 2 && hasExpectedTables

  if (!isFresh && !isV1Schema && !isV2Schema) {
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
      db.pragma('user_version = 2')
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

    const migrateV1ToV2 = db.transaction(() => {
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
      db.pragma('user_version = 2')
    })
    try {
      migrateV1ToV2()
    } catch (err) {
      db.close()
      throw err
    }
  } else if (isV2Schema) {
    validateOwnerSessionInvariants()
    if (
      !hasExactColumns(db, 'owner', OWNER_COLS) ||
      !hasExactColumns(db, 'session', SESSION_COLS) ||
      !hasExactColumns(db, 'vault', V2_VAULT_COLS)
    ) {
      failCorruption(db, 'Database corrupted: unexpected vault schema')
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
