import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import Database from 'better-sqlite3'
import { createApp } from './app.js'
import { openDatabase, getSession } from './database.js'
import { createSession, destroySession, hashToken } from './auth/authentication.js'

test('createApp throws TypeError when database is missing or undefined', () => {
  assert.throws(
    () => createApp(),
    (err) => {
      assert.ok(err instanceof TypeError)
      assert.equal(err.message, 'Database is required')
      return true
    }
  )

  assert.throws(
    () => createApp({ db: undefined }),
    (err) => {
      assert.ok(err instanceof TypeError)
      assert.equal(err.message, 'Database is required')
      return true
    }
  )
})

test('createApp throws TypeError when vaultsRoot is missing or undefined', () => {
  const db = openDatabase(':memory:')
  try {
    assert.throws(
      () => createApp({ db }),
      (err) => {
        assert.ok(err instanceof TypeError)
        assert.equal(err.message, 'vaultsRoot is required')
        return true
      }
    )

    assert.throws(
      () => createApp({ db, vaultsRoot: undefined }),
      (err) => {
        assert.ok(err instanceof TypeError)
        assert.equal(err.message, 'vaultsRoot is required')
        return true
      }
    )
  } finally {
    db.close()
  }
})

const defaultTestVaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-app-test-vaults-'))
const createTestApp = ({ db, vaultsRoot = defaultTestVaultsRoot, secure } = {}) => {
  return createApp({ db, vaultsRoot, secure })
}

test('serves Ayame only for GET /', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())
  assert.equal(app.server.listening, false)
  const response = await app.inject({ method: 'GET', url: '/' })
  assert.equal(response.statusCode, 200)
  assert.equal(response.headers['content-type'], 'text/plain; charset=utf-8')
  assert.equal(response.body, 'Ayame')

  for (const [method, url] of [
    ['GET', '/missing'],
    ['POST', '/'],
    ['HEAD', '/'],
  ]) {
    const response = await app.inject({ method, url })
    assert.equal(response.statusCode, 404)
  }
})

test('explicitly public routes remain accessible without session cookie', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  const rootRes = await app.inject({ method: 'GET', url: '/' })
  assert.equal(rootRes.statusCode, 200)

  const statusRes = await app.inject({ method: 'GET', url: '/auth/status' })
  assert.equal(statusRes.statusCode, 200)

  const ownerRes = await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'invalid', password: '' },
  })
  assert.equal(ownerRes.statusCode, 400)

  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'invalid', password: '' },
  })
  assert.equal(loginRes.statusCode, 401)
})

test('GET /auth/status returns initial, unauthenticated, and authenticated states', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  // Fresh installation
  const res1 = await app.inject({ method: 'GET', url: '/auth/status' })
  assert.equal(res1.statusCode, 200)
  assert.deepEqual(res1.json(), { initialized: false, authenticated: false })

  // First owner created
  const ownerRes = await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })
  assert.equal(ownerRes.statusCode, 201)

  // Initialized, but no session
  const res2 = await app.inject({ method: 'GET', url: '/auth/status' })
  assert.equal(res2.statusCode, 200)
  assert.deepEqual(res2.json(), { initialized: true, authenticated: false })

  // Log in
  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  assert.equal(loginRes.statusCode, 204)
  const cookie = loginRes.headers['set-cookie']
  assert.ok(cookie)

  // Initialized and authenticated
  const res3 = await app.inject({
    method: 'GET',
    url: '/auth/status',
    headers: { cookie },
  })
  assert.equal(res3.statusCode, 200)
  assert.deepEqual(res3.json(), { initialized: true, authenticated: true })
})

test('POST /auth/owner validates username and password and enforces singleton', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  // Invalid username
  for (const invalidUser of ['', ' auank ', 'AuanK', '.auan', 'auan@host']) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/owner',
      payload: { username: invalidUser, password: 'valid-password' },
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json(), { error: 'INVALID_USERNAME' })
  }

  // Invalid password
  for (const invalidPass of ['', 'a'.repeat(1025), null]) {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/owner',
      payload: { username: 'auank', password: invalidPass },
    })
    assert.equal(res.statusCode, 400)
    assert.deepEqual(res.json(), { error: 'INVALID_PASSWORD' })
  }

  // First owner creation succeeds
  const res = await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })
  assert.equal(res.statusCode, 201)

  // Second owner creation fails with 409
  const resDuplicate = await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'second', password: 'password456' },
  })
  assert.equal(resDuplicate.statusCode, 409)
  assert.deepEqual(resDuplicate.json(), { error: 'OWNER_ALREADY_EXISTS' })
})

test('concurrent owner creation via HTTP allows only one winner', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  const [res1, res2] = await Promise.all([
    app.inject({
      method: 'POST',
      url: '/auth/owner',
      payload: { username: 'userone', password: 'password123' },
    }),
    app.inject({
      method: 'POST',
      url: '/auth/owner',
      payload: { username: 'usertwo', password: 'password123' },
    }),
  ])

  const statuses = [res1.statusCode, res2.statusCode].sort()
  assert.deepEqual(statuses, [201, 409])
})

test('POST /auth/login fails generically for all invalid attempts', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  // Login before owner exists
  const resNoOwner = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  assert.equal(resNoOwner.statusCode, 401)
  assert.deepEqual(resNoOwner.json(), { error: 'UNAUTHORIZED' })
  assert.equal(resNoOwner.headers['set-cookie'], undefined)

  // Create owner
  await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })

  // Wrong username
  const resWrongUser = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'wronguser', password: 'password123' },
  })
  assert.equal(resWrongUser.statusCode, 401)
  assert.deepEqual(resWrongUser.json(), { error: 'UNAUTHORIZED' })
  assert.equal(resWrongUser.headers['set-cookie'], undefined)

  // Wrong password
  const resWrongPass = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'wrongpassword' },
  })
  assert.equal(resWrongPass.statusCode, 401)
  assert.deepEqual(resWrongPass.json(), { error: 'UNAUTHORIZED' })
  assert.equal(resWrongPass.headers['set-cookie'], undefined)

  // Malformed credentials
  const resMalformed = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'invalid user space', password: '' },
  })
  assert.equal(resMalformed.statusCode, 401)
  assert.deepEqual(resMalformed.json(), { error: 'UNAUTHORIZED' })
  assert.equal(resMalformed.headers['set-cookie'], undefined)
})

test('POST /auth/login sets cookie with required flags and Secure when configured', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db, secure: true })
  t.after(() => app.close())

  await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })

  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  assert.equal(res.statusCode, 204)
  const cookie = res.headers['set-cookie']
  assert.ok(cookie)
  assert.match(cookie, /^ayame_session=[0-9a-f]{64};/)
  assert.doesNotMatch(cookie, /nia_session=/)
  assert.match(cookie, /HttpOnly/i)
  assert.match(cookie, /SameSite=Strict/i)
  assert.match(cookie, /Path=\//)
  assert.match(cookie, /Secure/i)
  assert.match(cookie, /Expires=/i)

  const token = cookie.match(/^ayame_session=([0-9a-f]{64});/)[1]
  const sessionRow = getSession(db, hashToken(token))
  assert.ok(sessionRow)
  const expiresHeader = cookie.match(/Expires=([^;]+)/i)[1]
  const cookieExpiresTime = new Date(expiresHeader).getTime()
  assert.ok(Math.abs(cookieExpiresTime - sessionRow.expires_at) < 1000)
})

test('POST /auth/login omits Secure when configured for a non-secure deployment', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db, secure: false })
  t.after(() => app.close())
  await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })
  const login = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  assert.equal(login.statusCode, 204)
  assert.doesNotMatch(login.headers['set-cookie'], /; Secure(?:;|$)/i)
})

test('private-by-default route behavior and fail-closed checks', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  // Register a private route
  app.get('/private-test', async () => ({ secret: 'data' }))

  // Missing session
  const resMissing = await app.inject({ method: 'GET', url: '/private-test' })
  assert.equal(resMissing.statusCode, 401)
  assert.deepEqual(resMissing.json(), { error: 'UNAUTHORIZED' })

  // Malformed session token
  const resMalformed = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: 'nia_session=not-a-valid-token' },
  })
  assert.equal(resMalformed.statusCode, 401)
  assert.deepEqual(resMalformed.json(), { error: 'UNAUTHORIZED' })

  // Unknown session token
  const resUnknown = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `nia_session=${'a'.repeat(64)}` },
  })
  assert.equal(resUnknown.statusCode, 401)
  assert.deepEqual(resUnknown.json(), { error: 'UNAUTHORIZED' })

  // Create owner and login
  await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })
  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  const cookie = loginRes.headers['set-cookie']

  // Valid session accesses private route
  const resValid = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie },
  })
  assert.equal(resValid.statusCode, 200)
  assert.deepEqual(resValid.json(), { secret: 'data' })
})

test('accepts valid legacy cookies and rejects expired, revoked, and malformed ones', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())
  app.get('/private-test', async () => ({ secret: true }))

  const validLegacy = createSession(db)
  const expiredLegacy = createSession(db, { now: Date.now() - 8 * 24 * 60 * 60 * 1000 })
  const revokedLegacy = createSession(db)
  destroySession(db, revokedLegacy.rawToken)

  const validRes = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `nia_session=${validLegacy.rawToken}` },
  })
  assert.equal(validRes.statusCode, 200)

  for (const token of [expiredLegacy.rawToken, revokedLegacy.rawToken, 'malformed']) {
    const response = await app.inject({
      method: 'GET',
      url: '/private-test',
      headers: { cookie: `nia_session=${token}` },
    })
    assert.equal(response.statusCode, 401)
  }
})

test('new cookie takes precedence and invalid new cookie never falls back to a valid legacy cookie', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())
  app.get('/private-test', async () => ({ secret: true }))

  const ayameSession = createSession(db)
  const niaSession = createSession(db)
  const bothCookies = `ayame_session=${ayameSession.rawToken}; nia_session=${niaSession.rawToken}`
  const bothValid = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: bothCookies },
  })
  assert.equal(bothValid.statusCode, 200)

  const invalidNewCookie = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=invalid; nia_session=${niaSession.rawToken}` },
  })
  assert.equal(invalidNewCookie.statusCode, 401)

  const logout = await app.inject({ method: 'POST', url: '/auth/logout', headers: { cookie: bothCookies } })
  assert.equal(logout.statusCode, 204)

  const ayameAfterLogout = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=${ayameSession.rawToken}` },
  })
  assert.equal(ayameAfterLogout.statusCode, 401)
  const niaAfterLogout = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `nia_session=${niaSession.rawToken}` },
  })
  assert.equal(niaAfterLogout.statusCode, 200)
})

test('private access does not refresh expiry', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  app.get('/private-data', async () => ({ ok: true }))

  await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })

  const loginRes = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  const cookie = loginRes.headers['set-cookie']
  const token = cookie.match(/ayame_session=([0-9a-f]{64})/)[1]
  const initialRow = getSession(db, hashToken(token))

  const res = await app.inject({
    method: 'GET',
    url: '/private-data',
    headers: { cookie },
  })
  assert.equal(res.statusCode, 200)

  const afterRow = getSession(db, hashToken(token))
  assert.equal(afterRow.expires_at, initialRow.expires_at)
})

test('malformed unauthenticated private request fails as unauthorized before application handling', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  // POST /auth/logout is private by default
  const res = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { 'content-type': 'application/json' },
    payload: '{ malformed json payload ',
  })

  assert.equal(res.statusCode, 401)
  assert.deepEqual(res.json(), { error: 'UNAUTHORIZED' })
})

test('POST /auth/logout clears cookie and revokes only current session', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())

  await app.inject({
    method: 'POST',
    url: '/auth/owner',
    payload: { username: 'auank', password: 'password123' },
  })

  // Session 1 (e.g. laptop)
  const loginRes1 = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  const cookie1 = loginRes1.headers['set-cookie']

  // Session 2 (e.g. phone)
  const loginRes2 = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { username: 'auank', password: 'password123' },
  })
  const cookie2 = loginRes2.headers['set-cookie']

  // Both sessions valid
  const status1 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: cookie1 } })
  assert.equal(status1.json().authenticated, true)
  const status2 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: cookie2 } })
  assert.equal(status2.json().authenticated, true)

  // Logout session 1
  const logoutRes = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { cookie: cookie1 },
  })
  assert.equal(logoutRes.statusCode, 204)
  const clearedCookie = logoutRes.headers['set-cookie']
  assert.ok(clearedCookie)
  const clearedCookies = Array.isArray(clearedCookie) ? clearedCookie : [clearedCookie]
  assert.ok(clearedCookies.some((value) => /ayame_session=;/i.test(value)))
  assert.ok(clearedCookies.some((value) => /nia_session=;/i.test(value)))

  // Session 1 is now revoked
  const afterLogout1 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: cookie1 } })
  assert.equal(afterLogout1.json().authenticated, false)

  // Session 2 remains valid
  const afterLogout2 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: cookie2 } })
  assert.equal(afterLogout2.json().authenticated, true)
})

test('restart preserves owner and session', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-restart-'))
  const dbPath = path.join(tempDir, 'persist.sqlite')

  try {
    // Phase 1: create owner and login
    const db1 = openDatabase(dbPath)
    const app1 = createTestApp({ db: db1 })
    await app1.inject({
      method: 'POST',
      url: '/auth/owner',
      payload: { username: 'auank', password: 'password123' },
    })
    const loginRes = await app1.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'auank', password: 'password123' },
    })
    const cookie = loginRes.headers['set-cookie']
    await app1.close()

    // Phase 2: restart app with same database file
    const db2 = openDatabase(dbPath)
    const app2 = createTestApp({ db: db2 })
    try {
      const statusRes = await app2.inject({
        method: 'GET',
        url: '/auth/status',
        headers: { cookie },
      })
      assert.equal(statusRes.statusCode, 200)
      assert.deepEqual(statusRes.json(), { initialized: true, authenticated: true })
    } finally {
      await app2.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})

test('upgrade from legacy auth-only DB preserves active login cookie and initializes empty vault registry', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nia-upgrade-'))
  const dbPath = path.join(tempDir, 'legacy-upgrade.sqlite')
  const vaultDir = path.join(tempDir, 'my-vault')
  fs.mkdirSync(vaultDir)

  try {
    const rawToken = crypto.randomBytes(32).toString('hex')
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex')
    const expiresAt = Date.now() + 7 * 24 * 60 * 60 * 1000

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
      INSERT INTO owner (id, username, password_hash) VALUES (1, 'auank', 'legacy-hash');
      INSERT INTO session (token_hash, expires_at) VALUES ('${tokenHash}', ${expiresAt});
    `)
    rawDb.pragma('user_version = 0')
    rawDb.close()

    const vaultsRoot = path.join(tempDir, 'vaults')
    fs.mkdirSync(vaultsRoot)

    const db = openDatabase(dbPath)
    const app = createApp({ db, vaultsRoot })
    const cookie = `nia_session=${rawToken}`

    try {
      // User remains authenticated with active cookie
      const statusRes = await app.inject({
        method: 'GET',
        url: '/auth/status',
        headers: { cookie },
      })
      assert.equal(statusRes.statusCode, 200)
      assert.deepEqual(statusRes.json(), { initialized: true, authenticated: true })

      // Vault registry initially empty
      const listRes = await app.inject({
        method: 'GET',
        url: '/vaults',
        headers: { cookie },
      })
      assert.equal(listRes.statusCode, 200)
      assert.deepEqual(listRes.json(), { vaults: [] })

      // Create physical directory under vaultsRoot
      fs.mkdirSync(path.join(vaultsRoot, 'my-vault'))

      // Can register vault
      const regRes = await app.inject({
        method: 'POST',
        url: '/vaults',
        headers: { cookie },
        payload: { name: 'Migrated Vault', directory: 'my-vault' },
      })
      assert.equal(regRes.statusCode, 201)
      assert.equal(regRes.json().vault.name, 'Migrated Vault')
      assert.equal(regRes.json().vault.directory, 'my-vault')
      assert.equal(regRes.json().vault.registered, true)
    } finally {
      await app.close()
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true })
  }
})
