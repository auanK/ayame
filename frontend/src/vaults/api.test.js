import { afterEach, describe, expect, it, vi } from 'vitest'
import { getVaults, registerVault, unregisterVault, getVaultEntries, getVaultMarkdown } from './api.js'

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

  describe('getVaultEntries', () => {
    it('uses GET, same-origin credentials, encodes directory and query path, and validates entries', async () => {
      const validBody = {
        directory: 'personal space',
        path: 'projects/ayame',
        entries: [
          { name: 'notes', path: 'projects/ayame/notes', type: 'directory' },
          { name: 'README.md', path: 'projects/ayame/README.md', type: 'file' },
          { name: 'odd-file', path: null, type: 'file' },
        ],
      }
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, validBody))

      const result = await getVaultEntries('personal space', 'projects/ayame')
      expect(result).toEqual(validBody)
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/vaults/personal%20space/entries?path=projects%2Fayame',
        {
          method: 'GET',
          credentials: 'same-origin',
        }
      )
    })

    it('omits query string when path is empty or omitted', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, {
        directory: 'personal',
        path: '',
        entries: [],
      }))

      await getVaultEntries('personal')
      expect(globalThis.fetch).toHaveBeenCalledWith('/vaults/personal/entries', {
        method: 'GET',
        credentials: 'same-origin',
      })
    })

    it.each([
      ['non-object response', null],
      ['missing entries array', { directory: 'd', path: '' }],
      ['non-string directory', { directory: 123, path: '', entries: [] }],
      ['empty directory', { directory: '', path: '', entries: [] }],
      ['non-string path', { directory: 'd', path: 123, entries: [] }],
      ['invalid entry type', { directory: 'd', path: '', entries: [{ name: 'a', path: 'a', type: 'symlink' }] }],
      ['empty entry name', { directory: 'd', path: '', entries: [{ name: '', path: 'a', type: 'file' }] }],
      ['invalid entry path type', { directory: 'd', path: '', entries: [{ name: 'a', path: 123, type: 'file' }] }],
    ])('rejects %s', async (_desc, body) => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, body))
      await expectCode(getVaultEntries('personal'), 'INVALID_VAULT_RESPONSE')
    })

    it('rejects invalid JSON', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, null, true))
      await expectCode(getVaultEntries('personal'), 'INVALID_VAULT_RESPONSE')
    })

    it('maps known 400 and 404 error codes from server', async () => {
      for (const [status, code] of [
        [400, 'INVALID_VAULT_DIRECTORY'],
        [400, 'INVALID_VAULT_PATH'],
        [404, 'VAULT_PATH_NOT_FOUND'],
        [400, 'VAULT_PATH_NOT_DIRECTORY'],
      ]) {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(response(status, { error: code }))
        await expectCode(getVaultEntries('personal'), code)
      }
    })

    it('maps 401 to UNAUTHORIZED, network errors to FAILED_TO_FETCH_ENTRIES', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(401, { error: 'UNAUTHORIZED' }))
      await expectCode(getVaultEntries('personal'), 'UNAUTHORIZED')

      globalThis.fetch.mockResolvedValueOnce(response(500, {}))
      await expectCode(getVaultEntries('personal'), 'FAILED_TO_FETCH_ENTRIES')

      globalThis.fetch.mockRejectedValueOnce(new TypeError('network fail'))
      await expectCode(getVaultEntries('personal'), 'FAILED_TO_FETCH_ENTRIES')
    })
  })

  describe('getVaultMarkdown', () => {
    it('uses GET, same-origin credentials, and encodes directory and path query params', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, {
        directory: 'personal notes',
        path: 'projects/spec 01.md',
        content: '# Spec Content\n',
      }))

      const result = await getVaultMarkdown('personal notes', 'projects/spec 01.md')
      expect(result).toEqual({
        directory: 'personal notes',
        path: 'projects/spec 01.md',
        content: '# Spec Content\n',
      })
      expect(globalThis.fetch).toHaveBeenCalledWith(
        '/vaults/personal%20notes/content?path=projects%2Fspec%2001.md',
        {
          method: 'GET',
          credentials: 'same-origin',
        }
      )
    })

    it('accepts empty file content', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, {
        directory: 'personal',
        path: 'empty.md',
        content: '',
      }))

      await expect(getVaultMarkdown('personal', 'empty.md')).resolves.toEqual({
        directory: 'personal',
        path: 'empty.md',
        content: '',
      })
    })

    it.each([
      ['non-object response', null],
      ['non-string content', { directory: 'personal', path: 'doc.md', content: 123 }],
      ['missing content', { directory: 'personal', path: 'doc.md' }],
      ['mismatched directory in response', { directory: 'other', path: 'doc.md', content: 'text' }],
      ['mismatched path in response', { directory: 'personal', path: 'other.md', content: 'text' }],
      ['invalid json', null, true],
    ])('rejects %s with INVALID_VAULT_RESPONSE', async (_desc, body, rejectsJson) => {
      globalThis.fetch = vi.fn().mockResolvedValue(response(200, body, rejectsJson))
      await expectCode(getVaultMarkdown('personal', 'doc.md'), 'INVALID_VAULT_RESPONSE')
    })

    it('maps known server error codes', async () => {
      const errorCases = [
        [400, 'INVALID_VAULT_DIRECTORY'],
        [400, 'INVALID_VAULT_PATH'],
        [400, 'VAULT_PATH_NOT_FILE'],
        [404, 'VAULT_PATH_NOT_FOUND'],
        [413, 'VAULT_FILE_TOO_LARGE'],
        [415, 'UNSUPPORTED_FILE_TYPE'],
        [422, 'INVALID_FILE_ENCODING'],
      ]

      for (const [status, code] of errorCases) {
        globalThis.fetch = vi.fn().mockResolvedValueOnce(response(status, { error: code }))
        await expectCode(getVaultMarkdown('personal', 'doc.md'), code)
      }
    })

    it('maps 401 to UNAUTHORIZED and network failure to FAILED_TO_FETCH_MARKDOWN', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(401, { error: 'UNAUTHORIZED' }))
      await expectCode(getVaultMarkdown('personal', 'doc.md'), 'UNAUTHORIZED')

      globalThis.fetch = vi.fn().mockRejectedValueOnce(new TypeError('network fail'))
      await expectCode(getVaultMarkdown('personal', 'doc.md'), 'FAILED_TO_FETCH_MARKDOWN')

      globalThis.fetch = vi.fn().mockResolvedValueOnce(response(500, {}))
      await expectCode(getVaultMarkdown('personal', 'doc.md'), 'FAILED_TO_FETCH_MARKDOWN')
    })
  })
})
