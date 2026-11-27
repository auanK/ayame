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
  updateOwnerPassword,
  countActiveSessions,
  deleteOtherSessions,
  pruneExpiredSessions,
} from './database.js'

test('fresh DB initializes schema version 6 with vaults, mural notes, and images', () => {
  const db = openDatabase(':memory:')
  try {
    const version = db.pragma('user_version', { simple: true })
    assert.equal(version, 6)

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
      .all()
      .map((r) => r.name)
      .sort()

    assert.deepEqual(tables, ['mural_image', 'mural_note', 'owner', 'session', 'vault'])

    const vaultCols = db.prepare('PRAGMA table_info(vault)').all().map((c) => c.name)
    assert.deepEqual(vaultCols, [
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
    ])
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

test('version 1 schema migrates cleanly to version 6 and preserves owner, session, and vault rows', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-v1-to-v2-'))
  const dbPath = path.join(tempDir, 'v1.sqlite')

  try {
    const expiresAt = Date.now() + 1000000
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
        directory TEXT NOT NULL UNIQUE
      );
    `)
    rawDb.pragma('user_version = 1')
    rawDb.prepare('INSERT INTO owner (id, username, password_hash) VALUES (1, ?, ?)').run('auank', 'hash-1234')
    rawDb.prepare('INSERT INTO session (token_hash, expires_at) VALUES (?, ?)').run('tok-hash-1', expiresAt)
    rawDb.prepare('INSERT INTO vault (id, name, directory) VALUES (?, ?, ?)').run('v-1', 'Notes', 'notes')
    rawDb.close()

    const db2 = openDatabase(dbPath)
    try {
      assert.equal(db2.pragma('user_version', { simple: true }), 6)
      const tables = db2
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
        .sort()
      assert.deepEqual(tables, ['mural_image', 'mural_note', 'owner', 'session', 'vault'])
      assert.deepEqual(getOwner(db2), { id: 1, username: 'auank', password_hash: 'hash-1234' })
      assert.deepEqual(getSession(db2, 'tok-hash-1'), { token_hash: 'tok-hash-1', expires_at: expiresAt })
      assert.deepEqual(
        db2.prepare('SELECT id, name, directory, position, category, tags_json, description, accent_color, pinned, cover_mime, cover_blob, cover_updated_at FROM vault').all(),
        [{
          id: 'v-1',
          name: 'Notes',
          directory: 'notes',
          position: null,
          category: '',
          tags_json: '[]',
          description: '',
          accent_color: '',
          pinned: 0,
          cover_mime: null,
          cover_blob: null,
          cover_updated_at: null,
        }]
      )
    } finally {
      closeDatabase(db2)
    }

    const db3 = openDatabase(dbPath)
    try {
      assert.equal(db3.pragma('user_version', { simple: true }), 6)
      assert.deepEqual(
        db3.prepare('SELECT id, name, directory FROM vault').all(),
        [{ id: 'v-1', name: 'Notes', directory: 'notes' }]
      )
    } finally {
      closeDatabase(db3)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('version 2 schema migrates to version 6 and preserves owner, session, and vault metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-v2-reopen-'))
  const dbPath = path.join(tempDir, 'v2.sqlite')

  try {
    const expiresAt = Date.now() + 1000000
    const db1 = openDatabase(dbPath)
    db1.exec('DROP TABLE mural_image; DROP TABLE mural_note')
    db1.pragma('user_version = 2')
    assert.equal(db1.pragma('user_version', { simple: true }), 2)
    insertOwner(db1, 'auank', 'hash-1234')
    insertSession(db1, 'tok-hash-1', expiresAt)
    db1.prepare(`
      INSERT INTO vault (id, name, directory, position, category, tags_json, description, accent_color, pinned)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('v-1', 'Notes', 'notes', 0, 'Personal', '["knowledge"]', 'My notes', '#a99aca', 1)
    closeDatabase(db1)

    const db2 = openDatabase(dbPath)
    try {
      assert.equal(db2.pragma('user_version', { simple: true }), 6)
      assert.equal(db2.prepare('SELECT count(*) AS count FROM mural_note').get().count, 0)
      assert.deepEqual(getOwner(db2), { id: 1, username: 'auank', password_hash: 'hash-1234' })
      assert.deepEqual(
        db2.prepare('SELECT id, name, directory, position, category, tags_json, description, accent_color, pinned FROM vault').all(),
        [{
          id: 'v-1',
          name: 'Notes',
          directory: 'notes',
          position: 0,
          category: 'Personal',
          tags_json: '["knowledge"]',
          description: 'My notes',
          accent_color: '#a99aca',
          pinned: 1,
        }]
      )
    } finally {
      closeDatabase(db2)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('database helpers update owner password, count active sessions, delete others, and prune expired', () => {
  const db = openDatabase(':memory:')
  try {
    insertOwner(db, 'auank', 'old-hash')
    updateOwnerPassword(db, 'new-hash')
    assert.equal(getOwner(db).password_hash, 'new-hash')

    const now = 100_000
    insertSession(db, 'active-1', now + 5000)
    insertSession(db, 'active-2', now + 9000)
    insertSession(db, 'expired-1', now - 10)
    insertSession(db, 'expired-boundary', now)

    assert.equal(countActiveSessions(db, now), 2)
    assert.equal(pruneExpiredSessions(db, now), 2)
    assert.equal(countActiveSessions(db, now), 2)

    assert.equal(deleteOtherSessions(db, 'active-1'), 1)
    assert.ok(getSession(db, 'active-1'))
    assert.equal(getSession(db, 'active-2'), undefined)
  } finally {
    closeDatabase(db)
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

test('version 3 mural notes are preserved by the image migration', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-mural-v3-'))
  const filename = path.join(directory, 'ayame.sqlite')
  t.after(() => {
    fs.unlinkSync(filename)
    fs.rmdirSync(directory)
  })
  const db = openDatabase(filename)
  try {
    db.exec(`
      DROP TABLE mural_image;
      ALTER TABLE mural_note DROP COLUMN trashed_at;
      ALTER TABLE mural_note DROP COLUMN image_width;
      ALTER TABLE mural_note DROP COLUMN kind;
      INSERT INTO mural_note (id, title, body, color, pinned, archived, position, revision, updated_at)
      VALUES ('sample', 'Existing note', 'Text to keep', 'fern', 1, 0, 7, 3, 109);
      PRAGMA user_version = 3;
    `)
  } finally {
    closeDatabase(db)
  }
  const migrated = openDatabase(filename)
  try {
    assert.equal(migrated.pragma('user_version', { simple: true }), 6)
    assert.deepEqual(migrated.prepare('SELECT body, color, kind, image_width, trashed_at, pinned, position, revision FROM mural_note').get(), {
      body: 'Text to keep', color: 'fern', kind: 'note', image_width: null, trashed_at: null, pinned: 1, position: 7, revision: 3,
    })
    assert.equal(migrated.prepare('SELECT count(*) AS count FROM mural_image').get().count, 0)
  } finally {
    closeDatabase(migrated)
  }
})

test('version 4 mural notes and images migrate cleanly to version 6 with null image_width and trashed_at', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-mural-v4-'))
  const filename = path.join(directory, 'ayame.sqlite')
  t.after(() => {
    fs.unlinkSync(filename)
    fs.rmdirSync(directory)
  })
  const db = openDatabase(filename)
  try {
    db.exec(`
      ALTER TABLE mural_note DROP COLUMN trashed_at;
      ALTER TABLE mural_note DROP COLUMN image_width;
      INSERT INTO mural_note (id, title, body, color, pinned, archived, position, revision, updated_at, kind)
      VALUES ('img-1', 'Cover', '', 'neutral', 0, 0, 1, 1, 200, 'image');
      INSERT INTO mural_image (card_id, version, mime, original, thumbnail)
      VALUES ('img-1', 'v1', 'image/png', X'89504E47', X'52494646');
      PRAGMA user_version = 4;
    `)
  } finally {
    closeDatabase(db)
  }
  const migrated = openDatabase(filename)
  try {
    assert.equal(migrated.pragma('user_version', { simple: true }), 6)
    assert.deepEqual(migrated.prepare('SELECT id, kind, image_width, trashed_at FROM mural_note').get(), {
      id: 'img-1', kind: 'image', image_width: null, trashed_at: null,
    })
    assert.equal(migrated.prepare('SELECT count(*) AS count FROM mural_image').get().count, 1)
  } finally {
    closeDatabase(migrated)
  }
})

test('version 5 mural notes migrate cleanly to version 6 with null trashed_at', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-mural-v5-'))
  const filename = path.join(directory, 'ayame.sqlite')
  t.after(() => {
    fs.unlinkSync(filename)
    fs.rmdirSync(directory)
  })
  const db = openDatabase(filename)
  try {
    db.exec(`
      ALTER TABLE mural_note DROP COLUMN trashed_at;
      INSERT INTO mural_note (id, title, body, color, pinned, archived, position, revision, updated_at, kind, image_width)
      VALUES ('note-5', 'Keep', 'Body', 'ochre', 0, 0, 1, 1, 250, 'note', NULL);
      PRAGMA user_version = 5;
    `)
  } finally {
    closeDatabase(db)
  }
  const migrated = openDatabase(filename)
  try {
    assert.equal(migrated.pragma('user_version', { simple: true }), 6)
    assert.deepEqual(migrated.prepare('SELECT id, trashed_at FROM mural_note').get(), {
      id: 'note-5', trashed_at: null,
    })
  } finally {
    closeDatabase(migrated)
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
    rawDb.pragma('user_version = 7')
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

test('user_version 2 with invalid vault schema fails closed without mutation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-v2-invalid-vault-'))
  const dbPath = path.join(tempDir, 'v2-invalid.sqlite')

  try {
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

    const inspectDb = new Database(dbPath)
    try {
      assert.equal(String(inspectDb.pragma('journal_mode', { simple: true })).toLowerCase(), 'delete')
      assert.equal(inspectDb.pragma('user_version', { simple: true }), 2)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})
