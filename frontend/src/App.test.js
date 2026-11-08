import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import App from './App.vue'
import MarkdownEditor from './markdown/MarkdownEditor.vue'
import { AUTOSAVE_DELAY_MS } from './markdown/MarkdownViewer.vue'
import * as api from './auth/api.js'
import * as vaultApi from './vaults/api.js'

vi.mock('./auth/api.js', () => ({
  getAuthStatus: vi.fn(),
  createOwner: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

vi.mock('./vaults/api.js', () => ({
  getVaults: vi.fn(),
  registerVault: vi.fn(),
  unregisterVault: vi.fn(),
  getVaultEntries: vi.fn(),
  getVaultMarkdown: vi.fn(),
  saveVaultMarkdown: vi.fn(),
  createVaultFolder: vi.fn(),
  createVaultNote: vi.fn(),
  MAX_MARKDOWN_BYTES: 2 * 1024 * 1024,
}))

describe('App authentication flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
    vaultApi.getVaults.mockResolvedValue({ vaults: [] })
    vaultApi.getVaultEntries.mockResolvedValue({ directory: 'personal', path: '', entries: [] })
    vaultApi.getVaultMarkdown.mockResolvedValue({ directory: 'personal-dir', path: 'README.md', content: '# Welcome', revision: 'a'.repeat(64) })
  })

  describe('Bootstrap & status resolution', () => {
    it('shows loading state before status resolves', () => {
      api.getAuthStatus.mockReturnValue(new Promise(() => {}))

      const wrapper = mount(App)

      expect(wrapper.find('h1').text()).toBe('ayame')
      expect(wrapper.text()).toContain('A place to think.')
      expect(wrapper.text()).toContain('Loading Ayame...')
      expect(wrapper.find('form').exists()).toBe(false)
    })

    it('renders setup screen when installation is not initialized', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="setup-form"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Create your Ayame space')
      expect(wrapper.text()).toContain('Create the owner account for this Ayame installation.')
      expect(wrapper.find('label[for="setup-username"]').text()).toBe('Username')
      expect(wrapper.find('label[for="setup-password"]').text()).toBe('Password')
    })

    it('renders login screen when initialized but unauthenticated', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: false })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Sign in')
      expect(wrapper.find('h1').text()).toBe('ayame')
      expect(wrapper.find('label[for="login-username"]').text()).toBe('Username')
      expect(wrapper.find('label[for="login-password"]').text()).toBe('Password')
      expect(wrapper.find('button[type="submit"]').text()).toBe('Sign In')
    })

    it('renders authenticated shell when initialized and authenticated', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Vaults')
      expect(wrapper.text()).toContain('No vaults found.')
      expect(wrapper.find('button[data-testid="logout-button"]').exists()).toBe(true)
      expect(wrapper.find('h1').text()).toBe('ayame')
      expect(wrapper.text()).toContain('A place to think.')
      expect(vaultApi.getVaults).toHaveBeenCalledTimes(1)
    })

    it('returns to login when the vault API reports an expired session without rechecking auth status', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockRejectedValueOnce(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(false)
      expect(api.getAuthStatus).toHaveBeenCalledTimes(1)
    })

    it('keeps Logout available during vault loading and ignores its late result after logout', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })
      let resolveVaults
      vaultApi.getVaults.mockReturnValue(new Promise((resolve) => { resolveVaults = resolve }))

      const wrapper = mount(App)
      await flushPromises()
      const logoutButton = wrapper.find('button[data-testid="logout-button"]')
      expect(logoutButton.attributes('disabled')).toBeUndefined()

      await logoutButton.trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)

      resolveVaults({ vaults: [{ id: null, name: 'personal', directory: 'personal', registered: false }] })
      await flushPromises()
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(false)
    })

    it('clears workspace errors when a later vault request reports an expired session', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockRejectedValue(new Error('temporary network issue'))
      vaultApi.getVaults.mockResolvedValueOnce({ vaults: [] })
        .mockRejectedValueOnce(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))

      const wrapper = mount(App)
      await flushPromises()
      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[role="alert"]').text()).toContain('Ayame could not reach the server.')

      await wrapper.find('[data-testid="refresh-vaults-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
      expect(api.getAuthStatus).toHaveBeenCalledTimes(1)
    })

    it('renders retryable error when status request fails and retries on action', async () => {
      api.getAuthStatus.mockRejectedValueOnce(new Error('Network error'))

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="error-state"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Ayame could not reach the server.')

      api.getAuthStatus.mockResolvedValueOnce({ initialized: true, authenticated: false })
      await wrapper.find('button[data-testid="retry-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
    })
  })

  it('sets the HTML document title to Ayame', () => {
    const html = readFileSync('index.html', 'utf8')
    expect(html).toMatch(/<title>Ayame<\/title>/)
  })

  describe('Setup flow', () => {
    it('submits username and password and transitions to login preserving username', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })
      api.createOwner.mockResolvedValue({ ok: true })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('strong-password-123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(api.createOwner).toHaveBeenCalledWith({
        username: 'auank',
        password: 'strong-password-123',
      })
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('input[name="username"]').element.value).toBe('auank')
      expect(wrapper.find('input[name="password"]').element.value).toBe('')
    })

    it('renders clear message on INVALID_USERNAME', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })
      const error = new Error('INVALID_USERNAME')
      error.code = 'INVALID_USERNAME'
      api.createOwner.mockRejectedValue(error)

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('Invalid User')
      await wrapper.find('input[name="password"]').setValue('password123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('[role="alert"]').text()).toContain(
        'Use up to 32 lowercase letters, numbers, dots, underscores, or hyphens.'
      )
    })

    it('renders clear message on INVALID_PASSWORD', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })
      const error = new Error('INVALID_PASSWORD')
      error.code = 'INVALID_PASSWORD'
      api.createOwner.mockRejectedValue(error)

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(wrapper.find('[role="alert"]').text()).toContain(
        'Enter a password between 1 and 1024 characters.'
      )
    })

    it('refreshes status on OWNER_ALREADY_EXISTS transitioning to login', async () => {
      api.getAuthStatus
        .mockResolvedValueOnce({ initialized: false, authenticated: false })
        .mockResolvedValueOnce({ initialized: true, authenticated: false })

      const error = new Error('OWNER_ALREADY_EXISTS')
      error.code = 'OWNER_ALREADY_EXISTS'
      api.createOwner.mockRejectedValue(error)

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('password123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(api.getAuthStatus).toHaveBeenCalledTimes(2)
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
    })

    it('disables submit button and prevents duplicate submissions while pending', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })
      let resolveOwner
      api.createOwner.mockReturnValue(new Promise((res) => { resolveOwner = res }))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('password123')

      const submitButton = wrapper.find('button[type="submit"]')
      expect(submitButton.attributes('disabled')).toBeUndefined()

      await wrapper.find('form').trigger('submit')
      expect(submitButton.attributes('disabled')).toBeDefined()

      // Second submit attempt while pending
      await wrapper.find('form').trigger('submit')
      expect(api.createOwner).toHaveBeenCalledTimes(1)

      resolveOwner({ ok: true })
      await flushPromises()
    })
  })

  describe('Login flow', () => {
    it('submits login credentials and transitions to authenticated shell', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: false })
      api.login.mockResolvedValue({ ok: true })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('password123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(api.login).toHaveBeenCalledWith({
        username: 'auank',
        password: 'password123',
      })
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)
      expect(wrapper.find('form').exists()).toBe(false)
    })

    it('renders generic failure message on 401 UNAUTHORIZED without distinguishing field', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: false })
      const error = new Error('UNAUTHORIZED')
      error.code = 'UNAUTHORIZED'
      api.login.mockRejectedValue(error)

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('wrongpass')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      const alert = wrapper.find('[role="alert"]')
      expect(alert.text()).toBe('Invalid username or password.')
    })

    it('disables submit button and prevents duplicate login submissions while pending', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: false })
      let resolveLogin
      api.login.mockReturnValue(new Promise((res) => { resolveLogin = res }))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('password123')

      const submitButton = wrapper.find('button[type="submit"]')
      expect(submitButton.attributes('disabled')).toBeUndefined()

      await wrapper.find('form').trigger('submit')
      expect(submitButton.attributes('disabled')).toBeDefined()

      await wrapper.find('form').trigger('submit')
      expect(api.login).toHaveBeenCalledTimes(1)

      resolveLogin({ ok: true })
      await flushPromises()
    })
  })

  describe('Logout flow', () => {
    it('successful logout transitions to login screen', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)

      await wrapper.find('button[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(api.logout).toHaveBeenCalledTimes(1)
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
    })

    it('failed logout leaves user authenticated and shows error message', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockRejectedValue(new Error('Logout network error'))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('button[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)
      expect(wrapper.find('[role="alert"]').text()).toContain('Ayame could not reach the server.')
    })

    it('transitions to login screen when logout returns 401 unauthorized (session already ended)', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      const error = new Error('UNAUTHORIZED')
      error.code = 'UNAUTHORIZED'
      api.logout.mockRejectedValue(error)

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)

      await wrapper.find('button[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(false)
      expect(wrapper.find('[role="alert"]').exists()).toBe(false)
    })

    it('asks before logout when a draft is dirty and preserves it when the user keeps editing', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [{ id: null, name: 'personal', directory: 'personal-dir', registered: false }] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir', path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
      })
      vaultApi.getVaultMarkdown.mockResolvedValue({
        directory: 'personal-dir', path: 'README.md', content: 'base', revision: 'a'.repeat(64),
      })

      const wrapper = mount(App)
      await flushPromises()
      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()
      await wrapper.find('[data-testid="open-file-button"]').trigger('click')
      await flushPromises()
      wrapper.findComponent(MarkdownEditor).vm.setText('local draft')
      await wrapper.vm.$nextTick()

      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      expect(api.logout).not.toHaveBeenCalled()
      expect(wrapper.find('[data-testid="logout-keep-editing"]').exists()).toBe(true)
      await wrapper.find('[data-testid="logout-keep-editing"]').trigger('click')
      expect(wrapper.findComponent(MarkdownEditor).vm.getText()).toBe('local draft')

      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await wrapper.find('[data-testid="logout-discard-changes"]').trigger('click')
      await flushPromises()
      expect(api.logout).toHaveBeenCalledTimes(1)
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.text()).not.toContain('local draft')
    })

    it('clears a dirty draft immediately when an edit request reports an expired session', async () => {
      vi.useFakeTimers()
      try {
        api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
        vaultApi.getVaults.mockResolvedValue({ vaults: [{ id: null, name: 'personal', directory: 'personal-dir', registered: false }] })
        vaultApi.getVaultEntries.mockResolvedValue({
          directory: 'personal-dir', path: '', entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
        })
        vaultApi.getVaultMarkdown.mockResolvedValue({
          directory: 'personal-dir', path: 'README.md', content: 'base', revision: 'a'.repeat(64),
        })
        vaultApi.saveVaultMarkdown.mockRejectedValueOnce(Object.assign(new Error('expired'), { code: 'UNAUTHORIZED' }))

        const wrapper = mount(App)
        await flushPromises()
        await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
        await flushPromises()
        await wrapper.find('[data-testid="open-file-button"]').trigger('click')
        await flushPromises()
        wrapper.findComponent(MarkdownEditor).vm.setText('protected draft')
        await wrapper.vm.$nextTick()
        vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
        await flushPromises()

        expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
        expect(wrapper.find('[data-testid="markdown-editor"]').exists()).toBe(false)
        expect(wrapper.text()).not.toContain('protected draft')
      } finally {
        vi.useRealTimers()
      }
    })
  })

  describe('Storage invariant', () => {
    it('never writes authentication credentials or session tokens to web storage', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })
      api.createOwner.mockResolvedValue({ ok: true })
      api.login.mockResolvedValue({ ok: true })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('input[name="username"]').setValue('auank')
      await wrapper.find('input[name="password"]').setValue('password123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      await wrapper.find('input[name="password"]').setValue('password123')
      await wrapper.find('form').trigger('submit')
      await flushPromises()

      expect(localStorage.length).toBe(0)
      expect(sessionStorage.length).toBe(0)
    })
  })

  describe('Vault browsing integration', () => {
    const detectedVault = { id: null, name: 'personal', directory: 'personal-dir', registered: false }
    const customizedVault = { id: 'v1', name: 'Personal Notes', directory: 'personal', registered: true }

    it('opens detected vault and displays its browser', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [{ name: 'file.txt', path: 'file.txt', type: 'file' }],
      })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="vaults-panel"]').exists()).toBe(true)
      const openBtn = wrapper.find('[data-testid="open-vault-button"]')
      expect(openBtn.exists()).toBe(true)
      await openBtn.trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vaults-panel"]').exists()).toBe(false)
      expect(vaultApi.getVaultEntries).toHaveBeenCalledWith('personal-dir', '')
    })

    it('opens customized vault using its physical directory', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [customizedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal',
        path: '',
        entries: [],
      })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)
      expect(vaultApi.getVaultEntries).toHaveBeenCalledWith('personal', '')
    })

    it('returns to vault list from browser while preserving authenticated state', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [],
      })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)

      await wrapper.find('[data-testid="back-to-vaults-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="vaults-panel"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)
    })

    it('logout while browser is active returns to login', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(true)

      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
    })

    it('401 inside browser returns to login', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockRejectedValue(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="vault-browser"]').exists()).toBe(false)
    })

    it('late response from browser does not restore authenticated view after logout', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })

      let resolveEntries
      vaultApi.getVaultEntries.mockReturnValue(new Promise((res) => { resolveEntries = res }))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)

      resolveEntries({ directory: 'personal-dir', path: '', entries: [] })
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(false)
    })

    it('opens vault and markdown note, displaying rendered content', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
      })
      vaultApi.getVaultMarkdown.mockResolvedValue({
        directory: 'personal-dir',
        path: 'README.md',
        content: '# Note in App',
      })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="open-file-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Note in App')
    })

    it('returns from viewer back to vault list', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
      })
      vaultApi.getVaultMarkdown.mockResolvedValue({
        directory: 'personal-dir',
        path: 'README.md',
        content: '# Content',
      })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="open-file-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="back-to-vaults-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="vaults-panel"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(false)
    })

    it('logout while markdown viewer is active returns to login', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
      })

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="open-file-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)

      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(false)
    })

    it('blocks logout while the Markdown viewer is loading the server copy', async () => {
      vi.useFakeTimers()
      try {
        api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
        api.logout.mockResolvedValue({ ok: true })
        vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
        vaultApi.getVaultEntries.mockResolvedValue({
          directory: 'personal-dir', path: '',
          entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
        })
        let resolveReload
        vaultApi.getVaultMarkdown
          .mockResolvedValueOnce({ directory: 'personal-dir', path: 'README.md', content: 'base', revision: 'a'.repeat(64) })
          .mockReturnValueOnce(new Promise((resolve) => { resolveReload = resolve }))
        vaultApi.saveVaultMarkdown.mockRejectedValueOnce(Object.assign(new Error('conflict'), { code: 'VAULT_FILE_CONFLICT' }))

        const wrapper = mount(App)
        await flushPromises()
        await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
        await flushPromises()
        await wrapper.find('[data-testid="open-file-button"]').trigger('click')
        await flushPromises()
        wrapper.findComponent(MarkdownEditor).vm.setText('draft')
        await wrapper.vm.$nextTick()
        vi.advanceTimersByTime(AUTOSAVE_DELAY_MS)
        await flushPromises()
        await wrapper.find('[data-testid="markdown-reload-server"]').trigger('click')
        await wrapper.find('[data-testid="markdown-confirm-reload"]').trigger('click')

        expect(wrapper.find('[data-testid="logout-button"]').attributes('disabled')).toBeDefined()
        await wrapper.find('[data-testid="logout-button"]').trigger('click')
        expect(api.logout).not.toHaveBeenCalled()
        expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(true)

        resolveReload({ directory: 'personal-dir', path: 'README.md', content: 'remote', revision: 'b'.repeat(64) })
        await flushPromises()
      } finally {
        vi.useRealTimers()
      }
    })

    it('401 from viewer returns to login screen', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
      })
      vaultApi.getVaultMarkdown.mockRejectedValue(Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' }))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="open-file-button"]').trigger('click')
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="markdown-viewer"]').exists()).toBe(false)
    })

    it('late response from markdown viewer does not restore authenticated view after logout', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })
      api.logout.mockResolvedValue({ ok: true })
      vaultApi.getVaults.mockResolvedValue({ vaults: [detectedVault] })
      vaultApi.getVaultEntries.mockResolvedValue({
        directory: 'personal-dir',
        path: '',
        entries: [{ name: 'README.md', path: 'README.md', type: 'file' }],
      })

      let resolveMarkdown
      vaultApi.getVaultMarkdown.mockReturnValue(new Promise((res) => { resolveMarkdown = res }))

      const wrapper = mount(App)
      await flushPromises()

      await wrapper.find('[data-testid="open-vault-button"]').trigger('click')
      await flushPromises()

      await wrapper.find('[data-testid="open-file-button"]').trigger('click')

      await wrapper.find('[data-testid="logout-button"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)

      resolveMarkdown({ directory: 'personal-dir', path: 'README.md', content: '# Late content' })
      await flushPromises()

      expect(wrapper.find('[data-testid="login-form"]').exists()).toBe(true)
      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(false)
    })
  })
})
