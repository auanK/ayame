import crypto from 'node:crypto'
import argon2 from 'argon2'
import {
  getOwner,
  insertOwner,
  updateOwnerPassword,
  getSession,
  insertSession,
  deleteSession,
  deleteOtherSessions,
} from '../database.js'

const USERNAME_REGEX = /^[a-z0-9][a-z0-9._-]{0,31}$/
const SESSION_TOKEN_REGEX = /^[0-9a-f]{64}$/
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000
const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000

export const validUsername = (username) => {
  return typeof username === 'string' && USERNAME_REGEX.test(username)
}

export const validPassword = (password) => {
  return typeof password === 'string' && password.length > 0 && password.length <= 1024
}

export const hashPassword = async (password) => {
  return argon2.hash(password, { type: argon2.argon2id })
}

export const verifyPassword = async (passwordHash, password) => {
  try {
    return await argon2.verify(passwordHash, password)
  } catch {
    return false
  }
}

export const hashToken = (token) => {
  return crypto.createHash('sha256').update(token).digest('hex')
}

export const generateSessionToken = () => {
  return crypto.randomBytes(32).toString('hex')
}

export const createOwner = async (
  database,
  { username, password },
  { hashPasswordFn = hashPassword } = {}
) => {
  if (!validUsername(username)) {
    const err = new Error('Invalid username')
    err.code = 'INVALID_USERNAME'
    throw err
  }
  if (!validPassword(password)) {
    const err = new Error('Invalid password')
    err.code = 'INVALID_PASSWORD'
    throw err
  }

  if (getOwner(database)) {
    const conflictErr = new Error('Owner already exists')
    conflictErr.code = 'OWNER_ALREADY_EXISTS'
    throw conflictErr
  }

  const passwordHash = await hashPasswordFn(password)
  try {
    insertOwner(database, username, passwordHash)
  } catch (err) {
    if (err.code?.startsWith('SQLITE_CONSTRAINT')) {
      const conflictErr = new Error('Owner already exists')
      conflictErr.code = 'OWNER_ALREADY_EXISTS'
      throw conflictErr
    }
    throw err
  }
}

export const authenticateUser = async (
  database,
  { username, password },
  { verifyPasswordFn = verifyPassword } = {}
) => {
  if (!validUsername(username) || !validPassword(password)) {
    return null
  }

  const owner = getOwner(database)
  if (!owner) {
    return null
  }

  const passwordValid = await verifyPasswordFn(owner.password_hash, password)
  const usernameValid = owner.username === username
  if (!usernameValid || !passwordValid) {
    return null
  }

  return owner
}

export const createSession = (database, { now = Date.now(), rememberMe = false } = {}) => {
  const rawToken = generateSessionToken()
  const tokenHash = hashToken(rawToken)
  const ttl = rememberMe ? THIRTY_DAYS_MS : SEVEN_DAYS_MS
  const expiresAt = now + ttl

  insertSession(database, tokenHash, expiresAt)
  return { rawToken, expiresAt }
}

export const validateSession = (database, rawToken, { now = Date.now() } = {}) => {
  if (typeof rawToken !== 'string' || !SESSION_TOKEN_REGEX.test(rawToken)) {
    return null
  }

  const tokenHash = hashToken(rawToken)
  const session = getSession(database, tokenHash)
  if (!session || session.expires_at <= now) {
    return null
  }

  return session
}

export const destroySession = (database, rawToken) => {
  if (typeof rawToken === 'string' && SESSION_TOKEN_REGEX.test(rawToken)) {
    deleteSession(database, hashToken(rawToken))
  }
}

export const changeOwnerPassword = async (
  database,
  { currentPassword, newPassword, keepSessionToken },
  { verifyPasswordFn = verifyPassword, hashPasswordFn = hashPassword } = {}
) => {
  if (!validPassword(newPassword)) {
    const err = new Error('Invalid password')
    err.code = 'INVALID_PASSWORD'
    throw err
  }

  const owner = getOwner(database)
  if (!owner || !validPassword(currentPassword)) {
    const err = new Error('Invalid current password')
    err.code = 'INVALID_CURRENT_PASSWORD'
    throw err
  }

  const passwordValid = await verifyPasswordFn(owner.password_hash, currentPassword)
  if (!passwordValid) {
    const err = new Error('Invalid current password')
    err.code = 'INVALID_CURRENT_PASSWORD'
    throw err
  }

  const newHash = await hashPasswordFn(newPassword)
  const applyUpdate = database.transaction(() => {
    updateOwnerPassword(database, newHash)
    if (typeof keepSessionToken === 'string' && SESSION_TOKEN_REGEX.test(keepSessionToken)) {
      deleteOtherSessions(database, hashToken(keepSessionToken))
    }
  })
  applyUpdate()
}

export const revokeOtherSessions = (database, currentRawToken) => {
  if (typeof currentRawToken !== 'string' || !SESSION_TOKEN_REGEX.test(currentRawToken)) {
    return { revoked: 0 }
  }
  const revoked = deleteOtherSessions(database, hashToken(currentRawToken))
  return { revoked }
}
