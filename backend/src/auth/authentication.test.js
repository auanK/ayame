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
} from '../database.js'
import {
  validUsername,
  validPassword,
  hashPassword,
  verifyPassword,
  hashToken,
  createOwner,
  authenticateUser,
  createSession,
  validateSession,
  destroySession,
} from './authentication.js'

test('validUsername enforces username contract', () => {
  assert.equal(validUsername('auank'), true)
  assert.equal(validUsername('auan.k'), true)
  assert.equal(validUsername('auan_k'), true)
  assert.equal(validUsername('auan-k'), true)
  assert.equal(validUsername('user2'), true)

  assert.equal(validUsername(''), false)
  assert.equal(validUsername(' auank '), false)
  assert.equal(validUsername('AuanK'), false)
  assert.equal(validUsername('.auan'), false)
  assert.equal(validUsername('auan@host'), false)
  assert.equal(validUsername('a'.repeat(33)), false)
  assert.equal(validUsername(null), false)
  assert.equal(validUsername(undefined), false)
  assert.equal(validUsername(123), false)
})

test('validPassword enforces password contract', () => {
  assert.equal(validPassword('password123'), true)
  assert.equal(validPassword('a'.repeat(1024)), true)

  assert.equal(validPassword(''), false)
  assert.equal(validPassword('a'.repeat(1025)), false)
  assert.equal(validPassword(null), false)
  assert.equal(validPassword(undefined), false)
  assert.equal(validPassword(12345), false)
})

test('hashPassword hashes with Argon2id and verifyPassword checks password', async () => {
  const password = 'my-secret-password'
  const hash = await hashPassword(password)

  assert.ok(hash.startsWith('$argon2id$'))
  assert.equal(await verifyPassword(hash, password), true)
  assert.equal(await verifyPassword(hash, 'wrong-password'), false)
})

test('database enforces singleton owner and stores Argon2id hash', async (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const rawPassword = 'plain-password-123'
  await createOwner(db, { username: 'auank', password: rawPassword })

  const owner = getOwner(db)
  assert.ok(owner)
  assert.equal(owner.id, 1)
  assert.equal(owner.username, 'auank')
  assert.ok(owner.password_hash.startsWith('$argon2id$'))
  assert.notEqual(owner.password_hash, rawPassword)

  // Plaintext password absent from persisted storage
  const row = db.prepare('SELECT * FROM owner WHERE id = 1').get()
  assert.equal(row.password_hash.includes(rawPassword), false)

  // Singleton owner invariant: second insert must fail
  await assert.rejects(
    async () => {
      await createOwner(db, { username: 'second', password: 'password456' })
    },
    (err) => {
      assert.equal(err.code, 'OWNER_ALREADY_EXISTS')
      return true
    }
  )

  // Direct SQLite insert with id != 1 must violate CHECK constraint
  assert.throws(
    () => {
      db.prepare('INSERT INTO owner (id, username, password_hash) VALUES (2, ?, ?)').run(
        'other',
        'hash'
      )
    },
    /CHECK constraint failed/
  )
})

test('createOwner avoids password hashing when owner already exists', async (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  let hasherInvocations = 0
  const customHasher = async (password) => {
    hasherInvocations++
    return hashPassword(password)
  }

  // First owner creation uses injected hasher
  await createOwner(
    db,
    { username: 'auank', password: 'plain-password-123' },
    { hashPasswordFn: customHasher }
  )
  assert.equal(hasherInvocations, 1)

  // Second owner creation must reject immediately without calling hasher
  await assert.rejects(
    async () => {
      await createOwner(
        db,
        { username: 'second', password: 'password456' },
        {
          hashPasswordFn: () => {
            throw new Error('Password hasher must not be called when owner exists')
          },
        }
      )
    },
    (err) => {
      assert.equal(err.code, 'OWNER_ALREADY_EXISTS')
      return true
    }
  )
})

test('concurrent owner creation allows only one winner', async (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const results = await Promise.allSettled([
    createOwner(db, { username: 'first', password: 'password1' }),
    createOwner(db, { username: 'second', password: 'password2' }),
  ])

  const fulfilled = results.filter((r) => r.status === 'fulfilled')
  const rejected = results.filter((r) => r.status === 'rejected')

  assert.equal(fulfilled.length, 1)
  assert.equal(rejected.length, 1)
  assert.equal(rejected[0].reason.code, 'OWNER_ALREADY_EXISTS')

  const count = db.prepare('SELECT COUNT(*) AS count FROM owner').get().count
  assert.equal(count, 1)
})

test('sessions: token randomness, SHA-256 storage, and raw token absence from SQLite', (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const now = 1000000
  const session1 = createSession(db, { now })
  const session2 = createSession(db, { now })

  assert.equal(session1.rawToken.length, 64)
  assert.equal(session2.rawToken.length, 64)
  assert.notEqual(session1.rawToken, session2.rawToken)

  const token1Hash = hashToken(session1.rawToken)
  const storedRow = getSession(db, token1Hash)
  assert.ok(storedRow)
  assert.equal(storedRow.token_hash, token1Hash)
  assert.equal(storedRow.expires_at, now + 7 * 24 * 60 * 60 * 1000)

  // Raw token is absent from SQLite storage
  const allRows = db.prepare('SELECT * FROM session').all()
  for (const r of allRows) {
    assert.notEqual(r.token_hash, session1.rawToken)
    assert.notEqual(r.token_hash, session2.rawToken)
  }
})

test('session expiration: fixed 7-day, exact boundary, no refresh on read', (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const now = 1000000
  const sevenDays = 7 * 24 * 60 * 60 * 1000
  const expiresAt = now + sevenDays

  const session = createSession(db, { now })
  assert.equal(session.expiresAt, expiresAt)

  // 1ms before expiry -> valid
  assert.ok(validateSession(db, session.rawToken, { now: expiresAt - 1 }))

  // Exact boundary -> expired
  assert.equal(validateSession(db, session.rawToken, { now: expiresAt }), null)

  // After boundary -> expired
  assert.equal(validateSession(db, session.rawToken, { now: expiresAt + 1 }), null)

  // Unknown or malformed session -> null
  assert.equal(validateSession(db, '0'.repeat(64), { now: now + 1000 }), null)
  assert.equal(validateSession(db, 'not-a-hex-token', { now: now + 1000 }), null)
  assert.equal(validateSession(db, '', { now: now + 1000 }), null)
  assert.equal(validateSession(db, null, { now: now + 1000 }), null)

  // Private read does not refresh expiration
  validateSession(db, session.rawToken, { now: now + 10000 })
  const stored = getSession(db, hashToken(session.rawToken))
  assert.equal(stored.expires_at, expiresAt)
})

test('two independent sessions and logout revokes only current session', (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  const session1 = createSession(db)
  const session2 = createSession(db)

  assert.ok(validateSession(db, session1.rawToken))
  assert.ok(validateSession(db, session2.rawToken))

  destroySession(db, session1.rawToken)

  assert.equal(validateSession(db, session1.rawToken), null)
  assert.ok(validateSession(db, session2.rawToken))
})

test('corruption invariant: sessions without owner fail startup closed and preserve db unchanged', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-corrupt-'))
  const dbPath = path.join(tempDir, 'corrupt.sqlite')

  try {
    // Create corrupted database: session exists without owner
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
      INSERT INTO session (token_hash, expires_at) VALUES ('dummyhash', 9999999999);
    `)
    rawDb.close()

    // openDatabase must fail closed
    assert.throws(
      () => {
        openDatabase(dbPath)
      },
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    // Corrupted database remains on disk unchanged
    assert.ok(fs.existsSync(dbPath))

    const inspectDb = new Database(dbPath)
    try {
      const count = inspectDb.prepare('SELECT COUNT(*) AS count FROM session').get().count
      assert.equal(count, 1)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('corruption invariant: partial schema with session-only fails closed without mutating schema or journal mode', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-corrupt-session-'))
  const dbPath = path.join(tempDir, 'corrupt-session.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.pragma('journal_mode = DELETE')
    rawDb.exec(`
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO session (token_hash, expires_at) VALUES ('dummyhash', 9999999999);
    `)
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath),
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    assert.ok(fs.existsSync(dbPath))

    const inspectDb = new Database(dbPath)
    try {
      const journalMode = inspectDb.pragma('journal_mode', { simple: true })
      assert.equal(journalMode.toLowerCase(), 'delete')

      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
      assert.ok(tables.includes('session'))
      assert.equal(tables.includes('owner'), false)

      const sessionCount = inspectDb.prepare('SELECT COUNT(*) AS count FROM session').get().count
      assert.equal(sessionCount, 1)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('corruption invariant: partial schema with owner-only fails closed without creating session table', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-corrupt-owner-'))
  const dbPath = path.join(tempDir, 'corrupt-owner.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.pragma('journal_mode = DELETE')
    rawDb.exec(`
      CREATE TABLE owner (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        username TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL
      );
      INSERT INTO owner (id, username, password_hash) VALUES (1, 'auank', 'somehash');
    `)
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath),
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    assert.ok(fs.existsSync(dbPath))

    const inspectDb = new Database(dbPath)
    try {
      const journalMode = inspectDb.pragma('journal_mode', { simple: true })
      assert.equal(journalMode.toLowerCase(), 'delete')

      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((r) => r.name)
      assert.ok(tables.includes('owner'))
      assert.equal(tables.includes('session'), false)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('corruption invariant: more than one owner fails closed', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-corrupt-multi-owner-'))
  const dbPath = path.join(tempDir, 'corrupt-multi.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      CREATE TABLE owner (
        id INTEGER,
        username TEXT,
        password_hash TEXT
      );
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO owner (id, username, password_hash) VALUES (1, 'u1', 'p1'), (2, 'u2', 'p2');
    `)
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath),
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('corruption invariant: unrelated existing SQLite database rejected without mutation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-unrelated-db-'))
  const dbPath = path.join(tempDir, 'unrelated.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.pragma('journal_mode = DELETE')
    rawDb.exec(`
      CREATE TABLE unrelated_data (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO unrelated_data (id, value) VALUES (1, 'important_data');
    `)
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath),
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    assert.ok(fs.existsSync(dbPath))

    const inspectDb = new Database(dbPath)
    try {
      const journalMode = inspectDb.pragma('journal_mode', { simple: true })
      assert.equal(journalMode.toLowerCase(), 'delete')

      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)

      assert.deepEqual(tables, ['unrelated_data'])
      const count = inspectDb.prepare('SELECT COUNT(*) AS count FROM unrelated_data').get().count
      assert.equal(count, 1)
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('corruption invariant: Nia schema mixed with unrelated table rejected without mutation', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-mixed-db-'))
  const dbPath = path.join(tempDir, 'mixed.sqlite')

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
      CREATE TABLE unrelated_data (
        id INTEGER PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT INTO owner (id, username, password_hash) VALUES (1, 'auank', 'somehash');
      INSERT INTO unrelated_data (id, value) VALUES (10, 'other');
    `)
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath),
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )

    assert.ok(fs.existsSync(dbPath))

    const inspectDb = new Database(dbPath)
    try {
      const journalMode = inspectDb.pragma('journal_mode', { simple: true })
      assert.equal(journalMode.toLowerCase(), 'delete')

      const tables = inspectDb
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
        .sort()

      assert.deepEqual(tables, ['owner', 'session', 'unrelated_data'])
    } finally {
      inspectDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('corruption invariant: owner with id != 1 rejected', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-wrong-owner-id-'))
  const dbPath = path.join(tempDir, 'wrong-id.sqlite')

  try {
    const rawDb = new Database(dbPath)
    rawDb.exec(`
      CREATE TABLE owner (
        id INTEGER,
        username TEXT,
        password_hash TEXT
      );
      CREATE TABLE session (
        token_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL
      );
      INSERT INTO owner (id, username, password_hash) VALUES (2, 'auank', 'somehash');
    `)
    rawDb.close()

    assert.throws(
      () => openDatabase(dbPath),
      (err) => {
        assert.match(err.message, /Database corrupt/i)
        return true
      }
    )
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('database initialization: existing truly empty SQLite file initializes normally', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-empty-file-'))
  const dbPath = path.join(tempDir, 'empty.sqlite')

  try {
    fs.writeFileSync(dbPath, '')

    const db = openDatabase(dbPath)
    try {
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all()
        .map((r) => r.name)
        .sort()
      assert.deepEqual(tables, ['owner', 'session'])
    } finally {
      closeDatabase(db)
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

test('authenticateUser: wrong username does not structurally bypass password verification for initialized owner', async (t) => {
  const db = openDatabase(':memory:')
  t.after(() => db.close())

  await createOwner(db, { username: 'auank', password: 'correct-password' })

  let verifierCalled = false
  const verified = await authenticateUser(
    db,
    { username: 'otheruser', password: 'correct-password' },
    {
      verifyPasswordFn: async () => {
        verifierCalled = true
        return true
      },
    }
  )

  assert.equal(verified, null)
  assert.equal(verifierCalled, true)
})

test('closeDatabase preserves WAL journal mode persistently without switching to DELETE', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-wal-persist-'))
  const dbPath = path.join(tempDir, 'persist-wal.sqlite')

  try {
    const db = openDatabase(dbPath)
    const activeMode = db.pragma('journal_mode', { simple: true })
    assert.equal(activeMode.toLowerCase(), 'wal')

    closeDatabase(db)

    const directDb = new Database(dbPath)
    try {
      const persistedMode = directDb.pragma('journal_mode', { simple: true })
      assert.equal(persistedMode.toLowerCase(), 'wal')
    } finally {
      directDb.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
})

