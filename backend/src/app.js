import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import {
  getOwner,
  closeDatabase,
  countActiveSessions,
  pruneExpiredSessions,
} from './database.js'
import {
  validUsername,
  validPassword,
  createOwner,
  authenticateUser,
  createSession,
  validateSession,
  destroySession,
  changeOwnerPassword,
  revokeOtherSessions,
} from './auth/authentication.js'
import { registerVaultRoutes } from './vaults/routes.js'

const createLoginRateLimiter = ({ maxAttempts = 10, windowMs = 15 * 60 * 1000 } = {}) => {
  const attemptsByKey = new Map()
  const MAX_TRACKED_KEYS = 1024

  const pruneWindow = (key, now) => {
    const existing = attemptsByKey.get(key)
    if (!existing) return []
    const recent = existing.filter((ts) => ts > now - windowMs)
    if (recent.length === 0) {
      attemptsByKey.delete(key)
      return []
    }
    attemptsByKey.set(key, recent)
    return recent
  }

  return {
    check(key, now = Date.now()) {
      if (!maxAttempts || maxAttempts <= 0) return { allowed: true, retryAfterSeconds: 0 }
      const recent = pruneWindow(key, now)
      if (recent.length >= maxAttempts) {
        const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + windowMs - now) / 1000))
        return { allowed: false, retryAfterSeconds }
      }
      return { allowed: true, retryAfterSeconds: 0 }
    },
    recordFailure(key, now = Date.now()) {
      if (!attemptsByKey.has(key) && attemptsByKey.size >= MAX_TRACKED_KEYS) {
        const oldestKey = attemptsByKey.keys().next().value
        attemptsByKey.delete(oldestKey)
      }
      const recent = pruneWindow(key, now)
      recent.push(now)
      attemptsByKey.set(key, recent)
    },
    clear(key) {
      attemptsByKey.delete(key)
    },
  }
}

export const createApp = ({
  db,
  vaultsRoot,
  secure = process.env.NODE_ENV === 'production',
  loginRateLimit = { maxAttempts: 10, windowMs: 15 * 60 * 1000 },
} = {}) => {
  if (!db) {
    throw new TypeError('Database is required')
  }
  if (!vaultsRoot) {
    throw new TypeError('vaultsRoot is required')
  }

  const app = Fastify({ exposeHeadRoutes: false })
  const limiter = createLoginRateLimiter(loginRateLimit)

  app.setErrorHandler((err, req, reply) => {
    if (
      err.code === 'FST_ERR_CTP_BODY_TOO_LARGE' &&
      req.method === 'PUT' &&
      req.routeOptions?.url === '/vaults/:directory/content'
    ) {
      return reply.code(413).send({ error: 'VAULT_FILE_TOO_LARGE' })
    }
    return reply.send(err)
  })

  app.addHook('onClose', () => {
    closeDatabase(db)
  })

  app.register(fastifyCookie)

  app.addHook('onRequest', async (req, reply) => {
    if (!req.routeOptions?.url) {
      return
    }

    if (req.routeOptions.config?.noStore === true) {
      reply.header('cache-control', 'no-store')
    }

    const token = req.cookies?.ayame_session
    if (token) {
      const session = validateSession(db, token)
      if (session) {
        req.session = session
        req.sessionToken = token
      }
    }

    if (req.routeOptions?.config?.public !== true) {
      if (!req.session) {
        return reply.code(401).send({ error: 'UNAUTHORIZED' })
      }
    }
  })

  app.get('/', { config: { public: true } }, async () => 'Ayame')

  app.get('/auth/status', { config: { public: true } }, async (req, reply) => {
    const owner = getOwner(db)
    return reply.send({
      initialized: Boolean(owner),
      authenticated: Boolean(req.session),
    })
  })

  app.post('/auth/owner', { config: { public: true } }, async (req, reply) => {
    const { username, password } = req.body || {}

    if (!validUsername(username)) {
      return reply.code(400).send({ error: 'INVALID_USERNAME' })
    }

    if (!validPassword(password)) {
      return reply.code(400).send({ error: 'INVALID_PASSWORD' })
    }

    try {
      await createOwner(db, { username, password })
      return reply.code(201).send()
    } catch (err) {
      if (err.code === 'OWNER_ALREADY_EXISTS') {
        return reply.code(409).send({ error: 'OWNER_ALREADY_EXISTS' })
      }
      throw err
    }
  })

  app.post('/auth/login', { config: { public: true } }, async (req, reply) => {
    const key = req.ip || 'local'
    const limitStatus = limiter.check(key)
    if (!limitStatus.allowed) {
      reply.header('retry-after', String(limitStatus.retryAfterSeconds))
      return reply.code(429).send({ error: 'TOO_MANY_ATTEMPTS' })
    }

    const { username, password, rememberMe } = req.body || {}

    const owner = await authenticateUser(db, { username, password })
    if (!owner) {
      limiter.recordFailure(key)
      return reply.code(401).send({ error: 'UNAUTHORIZED' })
    }

    limiter.clear(key)
    pruneExpiredSessions(db)
    const session = createSession(db, { rememberMe: rememberMe === true })
    reply.setCookie('ayame_session', session.rawToken, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure,
      expires: new Date(session.expiresAt),
    })
    return reply.code(204).send()
  })

  app.post('/auth/logout', async (req, reply) => {
    if (req.sessionToken) {
      destroySession(db, req.sessionToken)
    }
    reply.clearCookie('ayame_session', { path: '/' })
    return reply.code(204).send()
  })

  app.get('/auth/account', { config: { noStore: true } }, async (req, reply) => {
    const owner = getOwner(db)
    if (!owner) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' })
    }
    return reply.send({
      username: owner.username,
      activeSessions: countActiveSessions(db),
    })
  })

  app.put('/auth/password', { config: { noStore: true } }, async (req, reply) => {
    const { currentPassword, newPassword } = req.body || {}
    try {
      await changeOwnerPassword(db, {
        currentPassword,
        newPassword,
        keepSessionToken: req.sessionToken,
      })
      return reply.code(204).send()
    } catch (err) {
      if (err.code === 'INVALID_PASSWORD') {
        return reply.code(400).send({ error: 'INVALID_PASSWORD' })
      }
      if (err.code === 'INVALID_CURRENT_PASSWORD') {
        return reply.code(401).send({ error: 'INVALID_CURRENT_PASSWORD' })
      }
      throw err
    }
  })

  app.post('/auth/logout-others', { config: { noStore: true } }, async (req, reply) => {
    const result = revokeOtherSessions(db, req.sessionToken)
    return reply.send(result)
  })

  registerVaultRoutes(app, db, vaultsRoot)

  return app
}
