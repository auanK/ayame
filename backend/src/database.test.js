import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import Database from 'better-sqlite3'
import {
  openDatabase,
  closeDatabase,
  getOwner,
  getSession,
  insertOwner,
  insertSession,
} from './database.js'

test('fresh DB initializes schema version 1 with owner, session, and vault', () => {
  const db = openDatabase(':memory:')
  try {
    const version = db.pragma('user_version', { simple: true })
    assert.equal(version, 1)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .sort()

    assert.deepEqual(tables, ['owner', 'session', 'vault'])
  } finally {
    closeDatabase(db)
  }
})

test('user_version 0 with existing owner and session tables is rejected without mutation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-unsupported-v0-'))
  const dbPath = path.join(tempDir, 'unsupported-v0.sqlite')

  try {
    const expiresAt = Date.now() + 1000000
    const rawDb = new Database(dbPath)
    rawDb.pragma('journal_mode = DELETE')
    rawDb.exec(`
      CREATE TABLE owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO owner (id, username, password_hash) VALUES (1, 'auank', 'hash-1234');
      INSERT INTO session (token_hash, expires_at) VALUES ('tok-hash-1', ${expiresAt});
    `)
    rawDb.pragma('user_version = 0')
    rawDb.close()

    assert.throws(
      () => {
        const unexpectedDb = openDatabase(dbPath)
        closeDatabase(unexpectedDb)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    const inspectDb = new Database(dbPath)
    try {
      const version = inspectDb.pragma('user_version', { simple: true })
      const journalMode = inspectDb.pragma('journal_mode', { simple: true })
      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
        .sort()
      const owners = inspectDb.prepare('SELECT id, username, password_hash FROM owner').all()
      const sessions = inspectDb.prepare('SELECT token_hash, expires_at FROM session').all()

      assert.equal(version, 0)
      assert.equal(String(journalMode).toLowerCase(), 'delete')
      assert.deepEqual(tables, ['owner', 'session'])
      assert.deepEqual(owners, [{ id: 1, username: 'auank', password_hash: 'hash-1234' }])
      assert.deepEqual(sessions, [{ token_hash: 'tok-hash-1', expires_at: expiresAt }])
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('version 1 schema reopens and preserves owner, session, and vault rows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-v1-reopen-'))
  const dbPath = path.join(tempDir, 'v1.sqlite')

  try {
    const expiresAt = Date.now() + 1000000
    const db1 = openDatabase(dbPath)
    assert.equal(db1.pragma('user_version', { simple: true }), 1)
    insertOwner(db1, 'auank', 'hash-1234')
    insertSession(db1, 'tok-hash-1', expiresAt)
    db1.prepare('INSERT INTO vault (id, name, directory) VALUES (?, ?, ?)').run('v-1', 'Notes', 'notes')
    closeDatabase(db1)

    const db2 = openDatabase(dbPath)
    try {
      assert.equal(db2.pragma('user_version', { simple: true }), 1)
      const tables = db2
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
        .sort()
      assert.deepEqual(tables, ['owner', 'session', 'vault'])
      assert.deepEqual(getOwner(db2), { id: 1, username: 'auank', password_hash: 'hash-1234' })
      assert.deepEqual(getSession(db2, 'tok-hash-1'), { token_hash: 'tok-hash-1', expires_at: expiresAt })
      assert.deepEqual(
        db2.prepare('SELECT id, name, directory FROM vault').all(),
        [{ id: 'v-1', name: 'Notes', directory: 'notes' }]
      )
    } finally {
      closeDatabase(db2)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('version 1 with missing vault fails closed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-v1-missing-vault-'))
  const dbPath = path.join(tempDir, 'missing-vault.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      CREATE TABLE owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `)
    rawDb.pragma('user_version = 1')
    rawDb.close()

    assert.throws(
      () => {
        const unexpectedDb = openDatabase(dbPath)
        closeDatabase(unexpectedDb)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('unknown future user_version fails closed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-future-version-'))
  const dbPath = path.join(tempDir, 'future.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
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
        root_path TEXT NOT NULL UNIQUE
      );
    `)
    rawDb.pragma('user_version = 2')
    rawDb.close()

    assert.throws(
      () => {
        const unexpectedDb = openDatabase(dbPath)
        closeDatabase(unexpectedDb)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('schema mixed with unexpected table is rejected without mutation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-mixed-tables-'))
  const dbPath = path.join(tempDir, 'mixed.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      CREATE TABLE owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE unrelated_table (
        id INTEGER PRIMARY KEY,
        note TEXT
      );
    `)
    rawDb.pragma('user_version = 0')
    rawDb.close()

    assert.throws(
      () => {
        const unexpectedDb = openDatabase(dbPath)
        closeDatabase(unexpectedDb)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('failed/rejected schema inspection does not create vault table', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-corrupt-no-create-'))
  const dbPath = path.join(tempDir, 'corrupt.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
    `)
    rawDb.pragma('user_version = 0')
    rawDb.close()

    assert.throws(
      () => {
        const unexpectedDb = openDatabase(dbPath)
        closeDatabase(unexpectedDb)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    const inspectDb = new Database(dbPath)
    try {
      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
      assert.equal(tables.includes('vault'), false)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('fresh initialization rolls back all schema changes when initialization fails', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-fresh-rollback-'))
  const dbPath = path.join(tempDir, 'fresh-fail.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec('CREATE VIEW session AS SELECT 1;')
    rawDb.pragma('user_version = 0')
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath)
    )

    const inspectDb = new Database(dbPath)
    try {
      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)

      const views = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'view'")
        .all()
        .map((r) => r.name)

      const version = inspectDb.pragma('user_version', { simple: true })

      assert.equal(tables.includes('owner'), false)
      assert.equal(tables.includes('vault'), false)
      assert.deepEqual(views, ['session'])
      assert.equal(version, 0)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('discarded root_path vault schema is rejected without mutation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-discarded-root-path-'))
  const dbPath = path.join(tempDir, 'discarded.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
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
        root_path TEXT NOT NULL UNIQUE
      );
    `)
    rawDb.pragma('user_version = 1')
    rawDb.close()

    assert.throws(
      () => {
        const unexpectedDb = openDatabase(dbPath)
        closeDatabase(unexpectedDb)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    const inspectDb = new Database(dbPath)
    try {
      const cols = inspectDb
        .prepare('PRAGMA table_info(vault)')
        .all()
        .map((c) => c.name)

      assert.equal(cols.includes('root_path'), true)
      assert.equal(cols.includes('directory'), false)
      assert.equal(inspectDb.pragma('user_version', { simple: true }), 1)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
