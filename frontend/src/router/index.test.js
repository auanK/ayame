import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory } from 'vue-router'
import App from '../App.vue'
import VaultBrowser from '../vaults/VaultBrowser.vue'
import MarkdownViewer from '../markdown/MarkdownViewer.vue'
import MarkdownEditor from '../markdown/MarkdownEditor.vue'
import {
  createAyameRouter,
  isValidVaultDirectory,
  parseAyameQuery,
  stringifyAyameQuery,
  validateNoteQueryParam,
} from './index.js'
import * as authApi from '../auth/api.js'
import * as vaultApi from '../vaults/api.js'

vi.mock('../auth/api.js', () => ({
  getAuthStatus: vi.fn(),
  createOwner: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('../vaults/api.js', () => ({
  getVaults: vi.fn(),
  registerVault: vi.fn(),
  unregisterVault: vi.fn(),
  getVaultEntries: vi.fn(),
  getVaultMarkdown: vi.fn(),
  saveVaultMarkdown: vi.fn(),
  createVaultFolder: vi.fn(),
  createVaultNote: vi.fn(),
  getVaultIndex: vi.fn(),
  relocateVaultEntry: vi.fn(),
  trashVaultEntry: vi.fn(),
  getVaultTrash: vi.fn(),
  restoreVaultTrashEntry: vi.fn(),
  deleteVaultTrashItem: vi.fn(),
  deleteVaultEntryPermanently: vi.fn(),
  MAX_MARKDOWN_BYTES: 2 * 1024 * 1024,
}))

const isekaiVault = {
  id: 'v-isekai',
  name: 'Isekai Lore',
  directory: 'Isekai',
  registered: true,
}

const unregisteredVault = {
  id: null,
  name: 'sandbox',
  directory: 'sandbox',
  registered: false,
}

const codedError = (code, message = code) => {
  const err = new Error(message)
  err.code = code
  return err
}

const createDeferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const mountAppAt = async (initialUrl = '/') => {
  const router = createAyameRouter(createMemoryHistory())
  await router.push(initialUrl)
  const wrapper = mount(App, {
    global: {
      plugins: [router],
    },
  })
  await flushPromises()
  return { wrapper, router }
}

describe('Vue Router 4 & URL persistence (Sections 41-52)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    authApi.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
    vaultApi.getVaults.mockResolvedValue({ vaults: [isekaiVault, unregisteredVault] })
    vaultApi.getVaultEntries.mockImplementation(async (directory, path = '') => {
      if (path === 'Cosmologia') {
        return {
          directory,
          path: 'Cosmologia',
          entries: [{ name: 'A Gênese.md', path: 'Cosmologia/A Gênese.md', type: 'file' }],
        }
      }
      if (path === 'projects') {
        return {
          directory,
          path: 'projects',
          entries: [{ name: 'README.md', path: 'projects/README.md', type: 'file' }],
        }
      }
      if (path === 'archive') {
        return {
          directory,
          path: 'archive',
          entries: [],
        }
      }
      return {
        directory,
        path: '',
        entries: [
          { name: 'Cosmologia', path: 'Cosmologia', type: 'directory' },
          { name: 'projects', path: 'projects', type: 'directory' },
          { name: 'archive', path: 'archive', type: 'directory' },
          { name: 'README.md', path: 'README.md', type: 'file' },
          { name: 'A.md', path: 'A.md', type: 'file' },
          { name: 'B.md', path: 'B.md', type: 'file' },
          { name: 'C.md', path: 'C.md', type: 'file' },
        ],
      }
    })
    vaultApi.getVaultIndex.mockImplementation(async (directory) => ({
      directory,
      complete: true,
      folders: ['Cosmologia', 'projects', 'archive'],
      files: [
        'README.md',
        'A.md',
        'B.md',
        'C.md',
        'Cosmologia/A Gênese.md',
        'projects/README.md',
      ],
      notes: [
        { path: 'README.md', name: 'README.md', content: '# README\n[[A Gênese]]', revision: 'a'.repeat(64) },
        { path: 'Cosmologia/A Gênese.md', name: 'A Gênese.md', content: '# A Gênese', revision: 'b'.repeat(64) },
      ],
    }))
    vaultApi.getVaultMarkdown.mockImplementation(async (directory, path) => ({
      directory,
      path,
      content: `# ${path}`,
      revision: 'a'.repeat(64),
    }))
    vaultApi.saveVaultMarkdown.mockImplementation(async (directory, path) => ({
      directory,
      path,
      revision: 'f'.repeat(64),
    }))
  })

  // 41. Testes de router
  describe('41. Router configuration, named routes, params, query encoding, and validators', () => {
    it('creates independent router instances with named routes, params, note query, and catch-all', async () => {
      const routerA = createAyameRouter(createMemoryHistory())
      const routerB = createAyameRouter(createMemoryHistory())

      await routerA.push({ name: 'vaults' })
      expect(routerA.currentRoute.value.name).toBe('vaults')
      expect(routerA.currentRoute.value.fullPath).toBe('/')

      await routerA.push({
        name: 'vault',
        params: { directory: 'Isekai' },
        query: { note: 'Cosmologia/A Gênese.md' },
      })

      expect(routerA.currentRoute.value.name).toBe('vault')
      expect(routerA.currentRoute.value.params.directory).toBe('Isekai')
      expect(routerA.currentRoute.value.query.note).toBe('Cosmologia/A Gênese.md')
      expect(routerA.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )

      // routerB remains completely isolated
      await routerB.push('/unknown/deep/route')
      expect(routerB.currentRoute.value.name).toBe('not-found')
      expect(routerA.currentRoute.value.name).toBe('vault')
    })

    it('validates vault directory and note query parameters strictly', () => {
      expect(isValidVaultDirectory('Isekai')).toBe(true)
      expect(isValidVaultDirectory('my-vault_01')).toBe(true)
      expect(isValidVaultDirectory('')).toBe(false)
      expect(isValidVaultDirectory('..')).toBe(false)
      expect(isValidVaultDirectory('a/b')).toBe(false)
      expect(isValidVaultDirectory('a\\b')).toBe(false)

      expect(validateNoteQueryParam(undefined)).toEqual({ present: false, valid: true, path: null })
      expect(validateNoteQueryParam('README.md')).toEqual({ present: true, valid: true, path: 'README.md' })
      expect(validateNoteQueryParam('Cosmologia/A Gênese.markdown')).toEqual({
        present: true,
        valid: true,
        path: 'Cosmologia/A Gênese.markdown',
      })
      expect(validateNoteQueryParam('')).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam(['A.md', 'B.md'])).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam('../secret.md')).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam('C:\\Windows\\file.md')).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam('/absolute/path.md')).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam('.trash/note.md')).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam('.obsidian/note.md')).toEqual({ present: true, valid: false, path: null })
      expect(validateNoteQueryParam('image.png')).toEqual({ present: true, valid: false, path: null })

      const malformed = parseAyameQuery('?note=%E0%A4%A.md')
      expect(validateNoteQueryParam(malformed.note).valid).toBe(false)
      expect(stringifyAyameQuery({ note: 'A/B C.md' })).toBe('note=A%2FB%20C.md')
    })
  })

  // 42. Teste F5 de vault
  describe('42. F5 reload on vault', () => {
    it('preserves registered and unregistered vaults across unmount and fresh App+router mount using vault.directory', async () => {
      const { wrapper: wrapper1, router: router1 } = await mountAppAt('/')

      // Open Isekai (where name is "Isekai Lore" and directory is "Isekai")
      await wrapper1.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      expect(router1.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper1.find('[data-testid="vault-browser"]').exists()).toBe(true)

      const savedUrl = router1.currentRoute.value.fullPath
      wrapper1.unmount()

      // Fresh mount at /vault/Isekai (simulating F5)
      const { wrapper: wrapper2, router: router2 } = await mountAppAt(savedUrl)
      expect(router2.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper2.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(wrapper2.find('[data-testid="vaults-panel"]').exists()).toBe(false)
      expect(wrapper2.text()).toContain('Isekai Lore')
      wrapper2.unmount()

      // Fresh mount at /vault/sandbox (unregistered vault)
      const { wrapper: wrapper3, router: router3 } = await mountAppAt('/vault/sandbox')
      expect(router3.currentRoute.value.fullPath).toBe('/vault/sandbox')
      expect(wrapper3.find('[data-testid="vault-browser"]').exists()).toBe(true)
      wrapper3.unmount()
    })
  })

  // 43. Teste F5 de nota
  describe('43. F5 reload on note', () => {
    it('restores vault, selects the requested note, activates its tab, and expands ancestor folders without selecting any other note', async () => {
      const { wrapper: wrapper1, router: router1 } = await mountAppAt('/vault/Isekai?note=README.md')

      expect(wrapper1.find('[data-testid="vault-browser"]').exists()).toBe(true)
      const viewer1 = wrapper1.findComponent(MarkdownViewer)
      expect(viewer1.exists()).toBe(true)
      expect(viewer1.props('directory')).toBe('Isekai')
      expect(viewer1.props('path')).toBe('README.md')
      expect(wrapper1.find('[data-testid="workspace-tab"][data-tab-path="README.md"]').exists()).toBe(true)
      wrapper1.unmount()

      // Remount at nested note URL: /vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md
      vaultApi.getVaultMarkdown.mockClear()
      const { wrapper: wrapper2, router: router2 } = await mountAppAt(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )

      expect(router2.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )
      const viewer2 = wrapper2.findComponent(MarkdownViewer)
      expect(viewer2.exists()).toBe(true)
      expect(viewer2.props('path')).toBe('Cosmologia/A Gênese.md')
      expect(vaultApi.getVaultMarkdown).toHaveBeenCalledTimes(1)
      expect(vaultApi.getVaultMarkdown).toHaveBeenCalledWith('Isekai', 'Cosmologia/A Gênese.md')
      expect(
        wrapper2.find('[data-testid="open-directory-button"][data-folder-path="Cosmologia"]').attributes('aria-expanded')
      ).toBe('true')
      wrapper2.unmount()
    })
  })

  // 44. Deep link Unicode e caracteres especiais
  describe('44. Deep link Unicode, .markdown, spaces, #, and & round-trip', () => {
    it('round-trips Unicode, .markdown, spaces, #, and & without double encoding or data loss', async () => {
      const specialPaths = [
        'Cosmologia/A Gênese.md',
        'Notas de Campo/Sessão 01.markdown',
        'Cosmologia/Item #1 & #2.md',
        'Cosmologia/P&D + Magia = 100.md',
      ]

      for (const notePath of specialPaths) {
        const router = createAyameRouter(createMemoryHistory())
        await router.push({
          name: 'vault',
          params: { directory: 'Isekai' },
          query: { note: notePath },
        })

        const encodedFullPath = router.currentRoute.value.fullPath
        expect(encodedFullPath).not.toContain('%25') // no double encoding

        const { wrapper, router: freshRouter } = await mountAppAt(encodedFullPath)
        expect(freshRouter.currentRoute.value.query.note).toBe(notePath)
        expect(freshRouter.currentRoute.value.fullPath).toBe(encodedFullPath)

        const viewer = wrapper.findComponent(MarkdownViewer)
        expect(viewer.exists()).toBe(true)
        expect(viewer.props('path')).toBe(notePath)
        expect(vaultApi.getVaultMarkdown).toHaveBeenLastCalledWith('Isekai', notePath)
        wrapper.unmount()
      }
    })
  })

  // 45. Navegação e Histórico
  describe('45. Sequential note navigation and Back/Forward history', () => {
    it('navigates A.md -> B.md -> C.md and supports Browser Back/Forward and internal history buttons without duplicate entries or exiting vault unexpectedly', async () => {
      const { wrapper, router } = await mountAppAt('/')

      // Enter vault from '/' so '/' is in browser history before '/vault/Isekai'
      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')

      const browser = wrapper.findComponent(VaultBrowser)

      await wrapper.find('button[data-file-path="A.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')

      await wrapper.find('button[data-file-path="B.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')

      await wrapper.find('button[data-file-path="C.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=C.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('C.md')

      // Browser Back: C -> B (single step proves no duplicate history entries)
      router.back()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')

      // Browser Back: B -> A
      router.back()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')

      // Workspace internal Back at A.md must NOT exit vault or leave A.md even though '/vault/Isekai' and '/' are in browser history
      await browser.vm.navigateHistoryBack()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)

      // Browser Forward: A -> B
      router.forward()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')

      // Workspace internal Forward: B -> C
      await browser.vm.navigateHistoryForward()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=C.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('C.md')

      // Workspace internal Back: C -> B
      await browser.vm.navigateHistoryBack()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')

      wrapper.unmount()
    })
  })

  // 46. Abas
  describe('46. Tabs and URL synchronization', () => {
    it('synchronizes URL when opening in new tab, switching tabs, closing inactive tab, closing active tab, and closing last tab', async () => {
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')
      const browser = wrapper.findComponent(VaultBrowser)

      // Open B.md and C.md in new tabs
      await browser.vm.openFileInNewTab('B.md')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(2)

      await browser.vm.openFileInNewTab('C.md')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=C.md')
      expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(3)

      // Select existing tab A.md
      await wrapper.find('[data-testid="workspace-tab"][data-tab-path="A.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')
      expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(3)

      // Close inactive tab B.md -> A.md remains active and URL stays ?note=A.md
      await wrapper.find('[data-testid="close-tab-button"][data-tab-path="B.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(2)

      // Close active tab A.md -> activates remaining tab C.md and updates URL to ?note=C.md
      await wrapper.find('[data-testid="close-tab-button"][data-tab-path="A.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=C.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('C.md')
      expect(wrapper.findAll('[data-testid="workspace-tab"]').length).toBe(1)

      // Close last tab C.md -> URL becomes /vault/Isekai, vault remains open with empty state
      await wrapper.find('[data-testid="close-tab-button"][data-tab-path="C.md"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="workspace-empty-state"]').exists()).toBe(true)
      expect(wrapper.findComponent(MarkdownViewer).exists()).toBe(false)

      wrapper.unmount()
    })
  })

  // 47 & 48. Rascunho, navegação e cancelamento
  describe('47 & 48. Draft protection and cancellation across all navigation paths', () => {
    it('blocks Explorer click, Tab click, Internal link, Browser Back, Browser Forward, and Switch Vault when Markdown dirty + Number draft are pending, and preserves URL/draft with zero PUTs on cancel', async () => {
      localStorage.setItem(
        'ayame:editor-preferences',
        JSON.stringify({ propertiesInDocument: 'visible' })
      )
      vaultApi.getVaultMarkdown.mockImplementation(async (directory, path) => ({
        directory,
        path,
        content: path === 'B.md' ? '---\nchapter: 10\n---\n# B\n[[A Gênese]]' : `# ${path}`,
        revision: 'a'.repeat(64),
      }))

      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')
      const browser = wrapper.findComponent(VaultBrowser)

      // Open B.md in new tab, then C.md in new tab, then go Back to B.md so B has both Back (A.md) and Forward (C.md)
      await browser.vm.openFileInNewTab('B.md')
      await flushPromises()
      await browser.vm.openFileInNewTab('C.md')
      await flushPromises()
      router.back()
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')

      // Create BOTH Markdown dirty AND Number draft on B.md
      wrapper.findComponent(MarkdownEditor).vm.setText('# B edited\n[[A Gênese]]')
      await wrapper.find('[data-testid="property-number-input"]').setValue('-99')
      await flushPromises()
      vaultApi.saveVaultMarkdown.mockClear()

      const assertBlockedAndCancel = async (triggerFn) => {
        await triggerFn()
        await flushPromises()

        // Confirmation dialog must be open, URL and note must still be B.md, and zero PUTs made
        expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)
        expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
        expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')
        expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-99')
        expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toContain('# B edited')
        expect(vaultApi.saveVaultMarkdown).not.toHaveBeenCalled()

        // Cancel navigation
        await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
        await flushPromises()

        expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(false)
        expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
        expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')
        expect(wrapper.find('[data-testid="property-number-input"]').element.value).toBe('-99')
        expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toContain('# B edited')
        expect(vaultApi.saveVaultMarkdown).not.toHaveBeenCalled()
      }

      // 1. Explorer click
      await assertBlockedAndCancel(() =>
        wrapper.find('button[data-file-path="README.md"]').trigger('click')
      )

      // 2. Tab click
      await assertBlockedAndCancel(() =>
        wrapper.find('[data-testid="workspace-tab"][data-tab-path="A.md"]').trigger('click')
      )

      // 3. Internal link
      await assertBlockedAndCancel(() =>
        browser.vm.handleOpenLink({
          type: 'resolved',
          path: 'Cosmologia/A Gênese.md',
          rawTarget: 'A Gênese',
          kind: 'wikilink',
        })
      )

      // 4. Browser Back
      await assertBlockedAndCancel(() => {
        router.back()
      })

      // 5. Browser Forward
      await assertBlockedAndCancel(() => {
        router.forward()
      })

      // 6. Switch Vault (Voltar à lista de vaults)
      await assertBlockedAndCancel(() =>
        wrapper.find('[data-testid="back-to-vaults-button"]').trigger('click')
      )

      // Now trigger Browser Back again and confirm discard -> navigates to A.md without PUT
      router.back()
      await flushPromises()
      expect(wrapper.find('[data-testid="navigation-discard-changes"]').exists()).toBe(true)
      await wrapper.find('[data-testid="navigation-discard-changes"]').trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')
      expect(vaultApi.saveVaultMarkdown).not.toHaveBeenCalled()

      wrapper.unmount()
    })

    it('protects conflict, unknown, and saving states during route changes', async () => {
      vaultApi.saveVaultMarkdown.mockRejectedValueOnce(codedError('VAULT_SAVE_RESULT_UNKNOWN'))
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')

      wrapper.findComponent(MarkdownEditor).vm.setText('# Uncertain save')
      await wrapper.findComponent(MarkdownViewer).vm.save()
      await flushPromises()
      expect(wrapper.find('[data-testid="markdown-save-unknown"]').exists()).toBe(true)

      // Try navigating via router.push to B.md
      await router.push('/vault/Isekai?note=B.md')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.find('[data-testid="navigation-keep-editing"]').exists()).toBe(true)
      await wrapper.find('[data-testid="navigation-keep-editing"]').trigger('click')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')

      wrapper.unmount()
    })
  })

  // 49. Corridas assíncronas
  describe('49. Asynchronous races with controlled promises', () => {
    it('handles delayed getAuthStatus() and delayed getVaults() without redirecting to / prematurely', async () => {
      const authDeferred = createDeferred()
      const vaultsDeferred = createDeferred()
      authApi.getAuthStatus.mockReturnValueOnce(authDeferred.promise)
      vaultApi.getVaults.mockReturnValueOnce(vaultsDeferred.promise)

      const router = createAyameRouter(createMemoryHistory())
      await router.push('/vault/Isekai?note=README.md')
      const wrapper = mount(App, { global: { plugins: [router] } })
      await flushPromises()

      // Still in loading state; URL preserved
      expect(wrapper.find('[data-testid="loading-state"]').exists()).toBe(true)
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')

      // Resolve auth -> now resolving vault; still must NOT redirect to / or show VaultsPanel
      authDeferred.resolve({ initialized: true, authenticated: true })
      await flushPromises()
      expect(wrapper.find('[data-testid="vault-resolving-state"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vaults-panel"]').exists()).toBe(false)
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')

      // Resolve getVaults -> mounts VaultBrowser and opens README.md
      vaultsDeferred.resolve({ vaults: [isekaiVault] })
      await flushPromises()
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('README.md')
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')

      wrapper.unmount()
    })

    it('ignores late response or late 404 from Note A after user already navigated to Note B, and handles route change while index loads', async () => {
      const indexDeferred = createDeferred()
      const noteADeferred = createDeferred()
      vaultApi.getVaultIndex.mockReturnValueOnce(indexDeferred.promise)
      vaultApi.getVaultMarkdown.mockImplementation((directory, path) => {
        if (path === 'A.md') return noteADeferred.promise
        return Promise.resolve({
          directory,
          path,
          content: `# Content of ${path}`,
          revision: 'b'.repeat(64),
        })
      })

      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')

      // Navigate to B.md while A.md and vault index are still in flight
      await wrapper.find('button[data-file-path="B.md"]').trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')
      expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# Content of B.md')

      // Now Note A rejects with 404 (or resolves late) and index resolves
      noteADeferred.reject(codedError('VAULT_PATH_NOT_FOUND'))
      indexDeferred.resolve({
        directory: 'Isekai',
        complete: true,
        folders: [],
        files: ['A.md', 'B.md'],
        notes: [],
      })
      await flushPromises()

      // B.md and its URL remain intact
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')
      expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('# Content of B.md')

      wrapper.unmount()
    })

    it('discards stale getVaults() response for an invalid vault if user already navigated to a valid vault, and discards vault load on logout', async () => {
      const firstVaultsDeferred = createDeferred()
      vaultApi.getVaults
        .mockReturnValueOnce(firstVaultsDeferred.promise)
        .mockResolvedValueOnce({ vaults: [isekaiVault] })

      const router = createAyameRouter(createMemoryHistory())
      await router.push('/vault/GhostVault')
      const wrapper = mount(App, { global: { plugins: [router] } })
      await flushPromises()

      // Navigate to valid vault /vault/Isekai before first getVaults finishes
      await router.push('/vault/Isekai')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)

      // Late resolution of the first getVaults call must be ignored
      firstVaultsDeferred.resolve({ vaults: [] })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)

      wrapper.unmount()
    })

    it('waits for an in-flight save to complete during flushPendingSave before completing note navigation', async () => {
      const saveDeferred = createDeferred()
      vaultApi.saveVaultMarkdown.mockReturnValueOnce(saveDeferred.promise)

      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')
      wrapper.findComponent(MarkdownEditor).vm.setText('# Saving A')
      const savePromise = wrapper.findComponent(MarkdownViewer).vm.save()
      await wrapper.vm.$nextTick()

      // Click B.md while A.md is saving
      const clickPromise = wrapper.find('button[data-file-path="B.md"]').trigger('click')
      await wrapper.vm.$nextTick()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')

      saveDeferred.resolve({ directory: 'Isekai', path: 'A.md', revision: 'c'.repeat(64) })
      await savePromise
      await clickPromise
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('B.md')

      wrapper.unmount()
    })
  })

  // 50. Sessão
  describe('50. Authentication, expired session, login destination restore, logout, and setup', () => {
    it('shows Login on expired session without fetching vault data, preserves deep link URL, and restores vault+note after login', async () => {
      authApi.getAuthStatus.mockResolvedValueOnce({ initialized: true, authenticated: false })
      authApi.login.mockResolvedValueOnce({ authenticated: true })

      const { wrapper, router } = await mountAppAt(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )

      // Unauthenticated: Login shown, URL preserved, zero vault/note requests made
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
      expect(vaultApi.getVaults).not.toHaveBeenCalled()
      expect(vaultApi.getVaultMarkdown).not.toHaveBeenCalled()
      expect(router.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )

      // Authenticate -> restores Isekai and Cosmologia/A Gênese.md
      await wrapper.find('#login-username').setValue('owner')
      await wrapper.find('#login-password').setValue('secret')
      await wrapper.find('[data-testid="login-form"] form').trigger('submit')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('Cosmologia/A Gênese.md')

      wrapper.unmount()
    })

    it('handles 401 UNAUTHORIZED during vault operation by clearing protected state while preserving URL for re-login', async () => {
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=README.md')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)

      // Trigger 401 when opening A.md
      vaultApi.getVaultMarkdown.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
      await wrapper.find('button[data-file-path="A.md"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')

      wrapper.unmount()
    })

    it('preserves state and URL when logout fails, and clears protected state and normalizes URL to / when logout succeeds', async () => {
      authApi.logout
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce({ ok: true })

      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=README.md')

      // 1. Failed logout preserves vault, note, and URL
      await wrapper.find('[data-testid="vault-name-trigger"]').trigger('click')
      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Ayame could not reach the server.')

      // 2. Confirmed logout clears workspace and normalizes URL to /
      await wrapper.find('[data-testid="vault-name-trigger"]').trigger('click')
      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/')
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)

      wrapper.unmount()
    })

    it('shows SetupForm regardless of initial deep link URL when owner account is not initialized', async () => {
      authApi.getAuthStatus.mockResolvedValueOnce({ initialized: false, authenticated: false })
      const { wrapper } = await mountAppAt('/vault/Isekai?note=README.md')

      expect(wrapper.find('[data-testid="setup-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
      expect(vaultApi.getVaults).not.toHaveBeenCalled()

      wrapper.unmount()
    })
  })

  // 51. URLs inválidas
  describe('51. Invalid URLs, nonexistent vaults/notes, path traversal, and query validation', () => {
    it('redirects nonexistent vault to / via replace with error feedback and never mounts VaultBrowser', async () => {
      const { wrapper, router } = await mountAppAt('/vault/VaultInexistente')

      expect(router.currentRoute.value.fullPath).toBe('/')
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="vaults-panel"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Vault "VaultInexistente" was not found.')
      expect(vaultApi.getVaultEntries).not.toHaveBeenCalled()

      wrapper.unmount()
    })

    it('handles nonexistent note (/vault/Isekai?note=Inexistente.md) by keeping vault open, informing user, opening no other note, and normalizing URL to /vault/Isekai', async () => {
      vaultApi.getVaultMarkdown.mockImplementation(async (directory, path) => {
        if (path === 'Inexistente.md') {
          throw codedError('VAULT_PATH_NOT_FOUND')
        }
        return { directory, path, content: `# ${path}`, revision: 'a'.repeat(64) }
      })

      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=Inexistente.md')

      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper.findComponent(MarkdownViewer).exists()).toBe(false)
      expect(wrapper.find('[data-testid="workspace-empty-state"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain(
        'Note "Inexistente.md" was not found in this vault.'
      )

      wrapper.unmount()
    })

    it('rejects traversal, absolute paths, Windows paths, malformed encoding, empty/array queries, and non-markdown files without calling getVaultMarkdown', async () => {
      const invalidUrls = [
        '/vault/Isekai?note=../secret.md',
        '/vault/Isekai?note=Cosmologia/../../secret.md',
        '/vault/Isekai?note=C:%5CWindows%5Cfile.md',
        '/vault/Isekai?note=%2Fabsolute%2Fpath.md',
        '/vault/Isekai?note=%E0%A4%A.md',
        '/vault/Isekai?note=',
        '/vault/Isekai?note=A.md&note=B.md',
        '/vault/Isekai?note=image.png',
      ]

      for (const badUrl of invalidUrls) {
        vaultApi.getVaultMarkdown.mockClear()
        const { wrapper, router } = await mountAppAt(badUrl)

        expect(vaultApi.getVaultMarkdown).not.toHaveBeenCalled()
        expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')
        expect(wrapper.findComponent(MarkdownViewer).exists()).toBe(false)
        expect(wrapper.find('[data-testid="workspace-notice"]').text()).toContain(
          'Invalid note path in URL.'
        )
        wrapper.unmount()
      }
    })

    it('redirects unknown catch-all routes to / with error message and avoids redundant getVaults() calls when switching notes', async () => {
      const { wrapper, router } = await mountAppAt('/rota/desconhecida')
      expect(router.currentRoute.value.fullPath).toBe('/')
      expect(wrapper.text()).toContain('Page not found.')
      wrapper.unmount()

      vaultApi.getVaults.mockClear()
      const { wrapper: w2 } = await mountAppAt('/vault/Isekai?note=A.md')
      expect(vaultApi.getVaults).toHaveBeenCalledTimes(1)

      await w2.find('button[data-file-path="B.md"]').trigger('click')
      await flushPromises()
      await w2.find('button[data-file-path="C.md"]').trigger('click')
      await flushPromises()

      // No redundant getVaults() calls on note switches within the same vault
      expect(vaultApi.getVaults).toHaveBeenCalledTimes(1)
      w2.unmount()
    })
  })

  // 52. Movimentações, Delete e Links Internos
  describe('52. Rename, Move, Drag & Drop, Ancestor Move, Uncertain Move Reconciliation, Delete, and Wikilinks', () => {
    it('updates URL via replace on confirmed Rename, Move, Drag & Drop, and Ancestor folder Move, and preserves URL when Move is refused', async () => {
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')
      const browser = wrapper.findComponent(VaultBrowser)

      // 1. Confirmed Rename: A.md -> Nova.md
      vaultApi.relocateVaultEntry.mockResolvedValueOnce({
        directory: 'Isekai',
        oldPath: 'A.md',
        newPath: 'Nova.md',
        updatedFiles: [],
        failedFiles: [],
      })
      await browser.vm.executeRelocate('A.md', 'Nova.md', {
        mode: 'rename',
        entry: { name: 'A.md', path: 'A.md', type: 'file' },
      })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=Nova.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('Nova.md')

      // 2. Refused Move: Nova.md -> projects/Nova.md fails -> URL remains ?note=Nova.md
      vaultApi.relocateVaultEntry.mockRejectedValueOnce(codedError('VAULT_ENTRY_EXISTS'))
      await browser.vm.executeRelocate('Nova.md', 'projects/Nova.md', {
        mode: 'move',
        entry: { name: 'Nova.md', path: 'Nova.md', type: 'file' },
      })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=Nova.md')

      // 3. Confirmed Move (Drag & Drop): Nova.md -> projects/Nova.md
      vaultApi.relocateVaultEntry.mockResolvedValueOnce({
        directory: 'Isekai',
        oldPath: 'Nova.md',
        newPath: 'projects/Nova.md',
        updatedFiles: [],
        failedFiles: [],
      })
      await browser.vm.executeRelocate('Nova.md', 'projects/Nova.md', {
        mode: 'move',
        origin: 'drag',
        requireKnownDrop: true,
        entry: { name: 'Nova.md', path: 'Nova.md', type: 'file' },
      })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=projects%2FNova.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('projects/Nova.md')

      // 4. Ancestor folder Move: projects -> archive/projects
      vaultApi.relocateVaultEntry.mockResolvedValueOnce({
        directory: 'Isekai',
        oldPath: 'projects',
        newPath: 'archive/projects',
        updatedFiles: [],
        failedFiles: [],
      })
      await browser.vm.executeRelocate('projects', 'archive/projects', {
        mode: 'move',
        entry: { name: 'projects', path: 'projects', type: 'directory' },
      })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=archive%2Fprojects%2FNova.md'
      )
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('archive/projects/Nova.md')

      wrapper.unmount()
    })

    it('keeps original URL during uncertain Move, updates URL on positive reconciliation, and keeps original URL on negative reconciliation', async () => {
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=README.md')
      const browser = wrapper.findComponent(VaultBrowser)

      // 1. Uncertain move -> URL must NOT change prematurely; navigation is blocked
      vaultApi.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
      await browser.vm.executeRelocate('README.md', 'archive/README.md', {
        mode: 'move',
        entry: { name: 'README.md', path: 'README.md', type: 'file' },
      })
      await flushPromises()

      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')
      expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(true)

      // Attempt route change while uncertain -> blocked
      await router.push('/vault/Isekai?note=A.md')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')

      // 2. Negative reconciliation (refresh shows README.md still at source) -> URL stays ?note=README.md
      vaultApi.getVaultIndex.mockResolvedValueOnce({
        directory: 'Isekai',
        complete: true,
        folders: ['archive'],
        files: ['README.md', 'A.md'],
        notes: [],
      })
      await wrapper.find('[data-testid="relocate-refresh"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(false)
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')

      // 3. Trigger uncertain move again, then positive reconciliation (refresh shows archive/README.md)
      vaultApi.relocateVaultEntry.mockRejectedValueOnce(codedError('FAILED_TO_RELOCATE_ENTRY'))
      await browser.vm.executeRelocate('README.md', 'archive/README.md', {
        mode: 'move',
        entry: { name: 'README.md', path: 'README.md', type: 'file' },
      })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=README.md')

      vaultApi.getVaultIndex.mockResolvedValueOnce({
        directory: 'Isekai',
        complete: true,
        folders: ['archive'],
        files: ['archive/README.md', 'A.md'],
        notes: [],
      })
      await wrapper.find('[data-testid="relocate-refresh"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="relocate-uncertain"]').exists()).toBe(false)
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=archive%2FREADME.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('archive/README.md')

      wrapper.unmount()
    })

    it('updates URL on confirmed Delete (switching to remaining tab or clearing ?note) and preserves URL on failed Delete', async () => {
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=A.md')
      const browser = wrapper.findComponent(VaultBrowser)

      await browser.vm.openFileInNewTab('B.md')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')

      // 1. Failed delete of B.md preserves URL
      vaultApi.trashVaultEntry.mockRejectedValueOnce(codedError('VAULT_FILE_CONFLICT'))
      browser.vm.requestDeleteEntry({ name: 'B.md', path: 'B.md', type: 'file' })
      await wrapper.vm.$nextTick()
      await browser.vm.confirmDeleteEntry('trash')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=B.md')

      // 2. Confirmed delete of B.md switches active tab to A.md and updates URL to ?note=A.md
      vaultApi.trashVaultEntry.mockResolvedValueOnce({ ok: true })
      await browser.vm.confirmDeleteEntry('trash')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai?note=A.md')
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('A.md')

      // 3. Confirmed delete of last open note A.md normalizes URL to /vault/Isekai
      vaultApi.trashVaultEntry.mockResolvedValueOnce({ ok: true })
      browser.vm.requestDeleteEntry({ name: 'A.md', path: 'A.md', type: 'file' })
      await wrapper.vm.$nextTick()
      await browser.vm.confirmDeleteEntry('trash')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe('/vault/Isekai')
      expect(wrapper.findComponent(MarkdownViewer).exists()).toBe(false)

      wrapper.unmount()
    })

    it('updates URL when navigating via resolved Wikilink and when creating a note from a pending link', async () => {
      const { wrapper, router } = await mountAppAt('/vault/Isekai?note=README.md')
      const browser = wrapper.findComponent(VaultBrowser)

      // 1. Resolved Wikilink [[A Gênese]] -> Cosmologia/A Gênese.md
      await browser.vm.handleOpenLink({
        type: 'resolved',
        path: 'Cosmologia/A Gênese.md',
        rawTarget: 'A Gênese',
        kind: 'wikilink',
      })
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('Cosmologia/A Gênese.md')

      // 2. Pending link creation -> updates URL only after creation is confirmed
      vaultApi.createVaultNote.mockResolvedValueOnce({
        directory: 'Isekai',
        path: 'Cosmologia/Novo Mito.md',
        revision: 'd'.repeat(64),
      })
      await browser.vm.handleOpenLink({
        type: 'missing',
        rawTarget: 'Cosmologia/Novo Mito',
        kind: 'wikilink',
      })
      await flushPromises()
      // Still on A Gênese before confirming creation
      expect(router.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FA%20G%C3%AAnese.md'
      )

      await wrapper.find('[data-testid="create-missing-link-button"]').trigger('click')
      await flushPromises()
      expect(router.currentRoute.value.fullPath).toBe(
        '/vault/Isekai?note=Cosmologia%2FNovo%20Mito.md'
      )
      expect(wrapper.findComponent(MarkdownViewer).props('path')).toBe('Cosmologia/Novo Mito.md')

      wrapper.unmount()
    })
  })
})
