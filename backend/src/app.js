import Fastify from 'fastify'
import fastifyCookie from '@fastify/cookie'
import { getOwner, closeDatabase } from './database.js'
import {
  validUsername,
  validPassword,
  createOwner,
  authenticateUser,
  createSession,
  validateSession,
  destroySession,
} from './auth/authentication.js'
import { registerVaultRoutes } from './vaults/routes.js'

const selectSessionCookie = (cookies = {}) =>
  Object.hasOwn(cookies, 'ayame_session') ? cookies.ayame_session : cookies.nia_session

export const createApp = ({
  db,
  vaultsRoot,
  secure = process.env.NODE_ENV === 'production',
} = {}) => {
  if (!db) {
    throw new TypeError('Database is required')
  }
  if (!vaultsRoot) {
    throw new TypeError('vaultsRoot is required')
  }

  const app = Fastify({ exposeHeadRoutes: false })

  app.addHook('onClose', () => {
    closeDatabase(db)
  })

  app.register(fastifyCookie)

  app.addHook('onRequest', async (req, reply) => {
    if (!req.routeOptions?.url) {
      return
    }

    const token = selectSessionCookie(req.cookies)
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
    const { username, password } = req.body || {}

    const owner = await authenticateUser(db, { username, password })
    if (!owner) {
      return reply.code(401).send({ error: 'UNAUTHORIZED' })
    }

    const session = createSession(db)
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
    reply.clearCookie('nia_session', { path: '/' })
    return reply.code(204).send()
  })

  registerVaultRoutes(app, db, vaultsRoot)

  return app
}
