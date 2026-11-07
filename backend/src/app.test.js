import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createApp } from './app.js'
import { openDatabase, getSession } from './database.js'
import { createSession, hashToken } from './auth/authentication.js'

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

const defaultTestVaultsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-app-test-vaults-'))
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
    headers: { cookie: 'ayame_session=not-a-valid-token' },
  })
  assert.equal(resMalformed.statusCode, 401)
  assert.deepEqual(resMalformed.json(), { error: 'UNAUTHORIZED' })

  // Unknown session token
  const resUnknown = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=${'a'.repeat(64)}` },
  })
  assert.equal(resUnknown.statusCode, 401)
  assert.deepEqual(resUnknown.json(), { error: 'UNAUTHORIZED' })

  // Expired session token
  const expiredSession = createSession(db, { now: 1000 })
  db.prepare('UPDATE session SET expires_at = ? WHERE token_hash = ?').run(
    Date.now() - 1000,
    hashToken(expiredSession.rawToken)
  )
  const resExpired = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=${expiredSession.rawToken}` },
  })
  assert.equal(resExpired.statusCode, 401)
  assert.deepEqual(resExpired.json(), { error: 'UNAUTHORIZED' })

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

test('unrelated cookies are ignored and never authenticate even when holding a valid session token', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())
  app.get('/private-test', async () => ({ secret: true }))

  const validTokenInDb = createSession(db)

  for (const cookieHeader of [
    `other_cookie=${validTokenInDb.rawToken}`,
    `unrelated_session=${validTokenInDb.rawToken}`,
    `other_cookie=value; unrelated_session=${validTokenInDb.rawToken}`,
  ]) {
    const res = await app.inject({
      method: 'GET',
      url: '/private-test',
      headers: { cookie: cookieHeader },
    })
    assert.equal(res.statusCode, 401)
    assert.deepEqual(res.json(), { error: 'UNAUTHORIZED' })
  }
})

test('ayame_session authenticates alongside unrelated cookies and fails closed when ayame_session is invalid', async (t) => {
  const db = openDatabase(':memory:')
  const app = createTestApp({ db })
  t.after(() => app.close())
  app.get('/private-test', async () => ({ secret: true }))

  const ayameSession = createSession(db)
  const otherStoredSession = createSession(db)

  // 1. ayame_session alone authenticates normally
  const ayameOnly = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=${ayameSession.rawToken}` },
  })
  assert.equal(ayameOnly.statusCode, 200)

  // 2. ayame_session with other cookies authenticates using ayame_session
  const combinedCookies = `other_cookie=abc; ayame_session=${ayameSession.rawToken}; unrelated_session=${otherStoredSession.rawToken}`
  const withOtherCookies = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: combinedCookies },
  })
  assert.equal(withOtherCookies.statusCode, 200)

  // 3. Invalid ayame_session with other cookies fails closed
  const invalidAyameCookie = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=invalid; unrelated_session=${otherStoredSession.rawToken}` },
  })
  assert.equal(invalidAyameCookie.statusCode, 401)

  // 4. Logout revokes only the session associated with ayame_session
  const logout = await app.inject({
    method: 'POST',
    url: '/auth/logout',
    headers: { cookie: combinedCookies },
  })
  assert.equal(logout.statusCode, 204)

  const ayameAfterLogout = await app.inject({
    method: 'GET',
    url: '/private-test',
    headers: { cookie: `ayame_session=${ayameSession.rawToken}` },
  })
  assert.equal(ayameAfterLogout.statusCode, 401)
  assert.ok(getSession(db, hashToken(otherStoredSession.rawToken)))
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

  // Session 1 is now revoked
  const afterLogout1 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: cookie1 } })
  assert.equal(afterLogout1.json().authenticated, false)

  // Session 2 remains valid
  const afterLogout2 = await app.inject({ method: 'GET', url: '/auth/status', headers: { cookie: cookie2 } })
  assert.equal(afterLogout2.json().authenticated, true)
})

test('restart preserves owner and session', async (t) => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-restart-'))
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
