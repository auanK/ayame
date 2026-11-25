import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getAuthStatus,
  createOwner,
  login,
  logout,
  getAccount,
  changePassword,
  logoutOtherSessions,
} from './api.js'

describe('auth API', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  describe('getAuthStatus', () => {
    it('requests /auth/status with GET and returns json payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ initialized: false, authenticated: false }),
      })

      const status = await getAuthStatus()

      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/status', {
        method: 'GET',
        credentials: 'same-origin',
      })
      expect(status).toEqual({ initialized: false, authenticated: false })
    })

    it('throws error when status request fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })

      await expect(getAuthStatus()).rejects.toThrow('FAILED_TO_FETCH_STATUS')
    })

    it('rejects when payload is empty object', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({}),
      })

      await expect(getAuthStatus()).rejects.toThrow('INVALID_AUTH_STATUS')
    })

    it('rejects when initialized is not a boolean', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ initialized: 'yes', authenticated: false }),
      })

      await expect(getAuthStatus()).rejects.toThrow('INVALID_AUTH_STATUS')
    })

    it('rejects when authenticated is true but initialized is false', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ initialized: false, authenticated: true }),
      })

      await expect(getAuthStatus()).rejects.toThrow('INVALID_AUTH_STATUS')
    })
  })

  describe('createOwner', () => {
    it('requests /auth/owner with POST and credentials payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
      })

      const res = await createOwner({ username: 'auank', password: 'password123' })

      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/owner', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auank', password: 'password123' }),
      })
      expect(res).toEqual({ ok: true })
    })

    it('throws with code when username is invalid', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({ error: 'INVALID_USERNAME' }),
      })

      await expect(createOwner({ username: 'bad name', password: 'password123' })).rejects.toMatchObject({
        code: 'INVALID_USERNAME',
      })
    })

    it('throws with code when owner already exists', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 409,
        json: async () => ({ error: 'OWNER_ALREADY_EXISTS' }),
      })

      await expect(createOwner({ username: 'auank', password: 'password123' })).rejects.toMatchObject({
        code: 'OWNER_ALREADY_EXISTS',
      })
    })
  })

  describe('login', () => {
    it('requests /auth/login with POST and credentials payload', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      })

      const res = await login({ username: 'auank', password: 'password123' })

      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auank', password: 'password123' }),
      })
      expect(res).toEqual({ ok: true })
    })

    it('throws with UNAUTHORIZED on 401', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: 'UNAUTHORIZED' }),
      })

      await expect(login({ username: 'auank', password: 'wrong' })).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    })

    it('sends rememberMe: true when requested and maps 429 to TOO_MANY_ATTEMPTS', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 204,
      })

      await login({ username: 'auank', password: 'password123', rememberMe: true })
      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/login', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auank', password: 'password123', rememberMe: true }),
      })

      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 429,
        json: async () => ({ error: 'TOO_MANY_ATTEMPTS' }),
      })

      await expect(login({ username: 'auank', password: 'wrong' })).rejects.toMatchObject({
        code: 'TOO_MANY_ATTEMPTS',
      })
    })
  })

  describe('logout', () => {
    it('requests /auth/logout with POST and same-origin credentials', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 204,
      })

      const res = await logout()

      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/logout', {
        method: 'POST',
        credentials: 'same-origin',
      })
      expect(res).toEqual({ ok: true })
    })

    it('throws error when logout fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
      })

      await expect(logout()).rejects.toThrow('FAILED_TO_LOGOUT')
    })

    it('throws with UNAUTHORIZED code on 401 response', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
      })

      await expect(logout()).rejects.toMatchObject({
        code: 'UNAUTHORIZED',
      })
    })
  })

  describe('account security endpoints', () => {
    it('fetches account info and maps unauthorized', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ username: 'auank', activeSessions: 2 }),
      })

      await expect(getAccount()).resolves.toEqual({ username: 'auank', activeSessions: 2 })
      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/account', {
        method: 'GET',
        credentials: 'same-origin',
      })

      globalThis.fetch.mockResolvedValueOnce({ ok: false, status: 401 })
      await expect(getAccount()).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    })

    it('changes password and maps validation/auth codes', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({ ok: true, status: 204 })
      await expect(changePassword({ currentPassword: 'old', newPassword: 'new-password' })).resolves.toEqual({ ok: true })
      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/password', {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword: 'old', newPassword: 'new-password' }),
      })

      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: async () => ({ error: 'INVALID_CURRENT_PASSWORD' }),
      })
      await expect(changePassword({ currentPassword: 'bad', newPassword: 'new' })).rejects.toMatchObject({
        code: 'INVALID_CURRENT_PASSWORD',
      })

      globalThis.fetch.mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: async () => ({ error: 'INVALID_PASSWORD' }),
      })
      await expect(changePassword({ currentPassword: 'old', newPassword: '' })).rejects.toMatchObject({
        code: 'INVALID_PASSWORD',
      })
    })

    it('revokes other sessions', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({ revoked: 3 }),
      })

      await expect(logoutOtherSessions()).resolves.toEqual({ revoked: 3 })
      expect(globalThis.fetch).toHaveBeenCalledWith('/auth/logout-others', {
        method: 'POST',
        credentials: 'same-origin',
      })
    })
  })
})
