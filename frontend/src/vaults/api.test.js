import { afterEach, describe, expect, it, vi } from 'vitest'
import { getVaults, registerVault, unregisterVault } from './api.js'

const originalFetch = globalThis.fetch
const detected = { id: null, name: 'personal', directory: 'Personal Dir', registered: false }
const customized = { id: 'vault-1', name: 'Personal Notes', directory: 'personal', registered: true }

const response = (status, body, rejectsJson = false) => ({
  status,
  json: rejectsJson ? vi.fn().mockRejectedValue(new SyntaxError()) : vi.fn().mockResolvedValue(body),
})

const expectCode = async (promise, code) => {
  await expect(promise).rejects.toMatchObject({ code })
}

afterEach(() => {
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('vault API', () => {
  describe('getVaults', () => {
    it('uses GET, same-origin credentials, and validates mixed results while dropping unknown fields', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, {
        vaults: [detected, { ...customized, serverLocation: '/private/server/path' }],
        extra: 'ignored',
      }))

      await expect(getVaults()).resolves.toEqual({
        vaults: [detected, customized],
      })
      expect(globalThis.fetch).toHaveBeenCalledWith('/vaults', {
        method: 'GET',
        credentials: 'same-origin',
      })
    })

    it('accepts an empty authoritative list', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, { vaults: [] }))
      await expect(getVaults()).resolves.toEqual({ vaults: [] })
    })

    it.each([
      ['non-object response', null],
      ['missing list', {}],
      ['non-array list', { vaults: {} }],
      ['invalid entry', { vaults: ['personal'] }],
      ['empty name', { vaults: [{ ...detected, name: '' }] }],
      ['empty directory', { vaults: [{ ...detected, directory: '' }] }],
      ['invalid registered flag', { vaults: [{ ...detected, registered: 0 }] }],
      ['missing registered ID', { vaults: [{ ...customized, id: '' }] }],
      ['null registered ID', { vaults: [{ ...customized, id: null }] }],
      ['detected string ID', { vaults: [{ ...detected, id: 'unexpected' }] }],
    ])('rejects %s', async (_description, body) => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, body))
      await expectCode(getVaults(), 'INVALID_VAULT_RESPONSE')
    })

    it('rejects invalid JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, null, true))
      await expectCode(getVaults(), 'INVALID_VAULT_RESPONSE')
    })

    it('distinguishes unauthorized, failed, unexpected status, and network errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(401, {}))
      await expectCode(getVaults(), 'UNAUTHORIZED')

      globalThis.fetch.mockResolvedValueOnce(response(500, {}))
      await expectCode(getVaults(), 'FAILED_TO_FETCH_VAULTS')

      globalThis.fetch.mockResolvedValueOnce(response(201, { vaults: [] }))
      await expectCode(getVaults(), 'FAILED_TO_FETCH_VAULTS')

      globalThis.fetch.mockRejectedValueOnce(new TypeError('offline'))
      await expectCode(getVaults(), 'FAILED_TO_FETCH_VAULTS')
    })
  })

  describe('registerVault', () => {
    it('sends only the display name and original directory and validates the registered result', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(201, {
        vault: { ...customized, ignored: true },
      }))

      await expect(registerVault({ name: ' Personal Notes ', directory: 'Personal Dir' }))
        .resolves.toEqual({ vault: customized })
      expect(globalThis.fetch).toHaveBeenCalledWith('/vaults', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: ' Personal Notes ', directory: 'Personal Dir' }),
      })
    })

    it.each([
      ['missing result', {}],
      ['detected result', { vault: detected }],
      ['malformed result', { vault: { ...customized, directory: '' } }],
    ])('rejects %s', async (_description, body) => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(201, body))
      await expectCode(registerVault({ name: 'Notes', directory: 'personal' }), 'INVALID_VAULT_RESPONSE')
    })

    it('requires exactly 201 and maps only known status/code pairs', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(200, { vault: customized }))
      await expectCode(registerVault({ name: 'Notes', directory: 'personal' }), 'FAILED_TO_REGISTER_VAULT')

      for (const [status, error, expected] of [
        [400, 'INVALID_VAULT_NAME', 'INVALID_VAULT_NAME'],
        [400, 'INVALID_VAULT_DIRECTORY', 'INVALID_VAULT_DIRECTORY'],
        [409, 'VAULT_ALREADY_REGISTERED', 'VAULT_ALREADY_REGISTERED'],
        [401, 'anything', 'UNAUTHORIZED'],
        [409, 'INVALID_VAULT_NAME', 'FAILED_TO_REGISTER_VAULT'],
        [422, 'INVALID_VAULT_NAME', 'FAILED_TO_REGISTER_VAULT'],
      ]) {
        globalThis.fetch.mockResolvedValueOnce(response(status, { error }))
        await expectCode(registerVault({ name: 'Notes', directory: 'personal' }), expected)
      }
    })

    it('maps malformed and unknown failures to the generic operation error', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(400, null, true))
      await expectCode(registerVault({ name: 'Notes', directory: 'personal' }), 'FAILED_TO_REGISTER_VAULT')

      globalThis.fetch.mockRejectedValueOnce(new TypeError('offline'))
      await expectCode(registerVault({ name: 'Notes', directory: 'personal' }), 'FAILED_TO_REGISTER_VAULT')
    })
  })

  describe('unregisterVault', () => {
    it('uses DELETE, encodes the ID, and requires exactly 204', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(204))

      await expect(unregisterVault('id /?')).resolves.toEqual({ ok: true })
      expect(globalThis.fetch).toHaveBeenCalledWith('/vaults/id%20%2F%3F', {
        method: 'DELETE',
        credentials: 'same-origin',
      })

      globalThis.fetch.mockResolvedValueOnce(response(200))
      await expectCode(unregisterVault('vault-1'), 'FAILED_TO_UNREGISTER_VAULT')
    })

    it('distinguishes unauthorized and network errors', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(401))
      await expectCode(unregisterVault('vault-1'), 'UNAUTHORIZED')

      globalThis.fetch.mockRejectedValueOnce(new TypeError('offline'))
      await expectCode(unregisterVault('vault-1'), 'FAILED_TO_UNREGISTER_VAULT')
    })
  })
})
