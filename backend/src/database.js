import Database from 'better-sqlite3'
import fs from 'node:fs'
import path from 'node:path'

const failCorruption = (db, message = 'Database corrupted') => {
  db.close()
  throw new Error(message)
}

export const openDatabase = (dbPath = 'data/nia.sqlite') => {
  const isMemory = dbPath === ':memory:'
  if (!isMemory) {
    const dir = path.dirname(path.resolve(dbPath))
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true })
    }
  }

  const db = new Database(dbPath)

  const userTables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((r) => r.name)
    .sort()

  const isFresh = userTables.length === 0
  const isValidNiaSchema =
    userTables.length === 2 && userTables[0] === 'owner' && userTables[1] === 'session'

  if (!isFresh && !isValidNiaSchema) {
    failCorruption(db, 'Database corrupted: unexpected schema')
  }

  if (isFresh) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `)
  } else {
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

export const getSession = (database, tokenHash) => {
  return database.prepare('SELECT token_hash, expires_at FROM session WHERE token_hash = ?').get(tokenHash)
}

export const insertSession = (database, tokenHash, expiresAt) => {
  database.prepare('INSERT INTO session (token_hash, expires_at) VALUES (?, ?)').run(tokenHash, expiresAt)
}

export const deleteSession = (database, tokenHash) => {
  database.prepare('DELETE FROM session WHERE token_hash = ?').run(tokenHash)
}

export const closeDatabase = (database) => {
  try {
    database.pragma('wal_checkpoint(TRUNCATE)')
  } catch {}
  database.close()
}

