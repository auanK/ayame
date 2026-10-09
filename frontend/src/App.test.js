import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { readFileSync } from 'node:fs'
import App from './App.vue'
import * as api from './auth/api.js'

vi.mock('./auth/api.js', () => ({
  getAuthStatus: vi.fn(),
  createOwner: vi.fn(),
  login: vi.fn(),
  logout: vi.fn(),
}))

describe('App authentication flow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    sessionStorage.clear()
  })

  describe('Bootstrap & status resolution', () => {
    it('shows loading state before status resolves', () => {
      api.getAuthStatus.mockReturnValue(new Promise(() => {}))

      const wrapper = mount(App)

      expect(wrapper.find('h1').text()).toBe('ayame')
      expect(wrapper.text()).toContain('A place to think.')
      expect(wrapper.text()).toContain('Loading Ayame...')
      expect(wrapper.text()).not.toContain('Nia')
      expect(wrapper.find('form').exists()).toBe(false)
    })

    it('renders setup screen when installation is not initialized', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: false, authenticated: false })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="setup-form"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Create your Ayame space')
      expect(wrapper.text()).toContain('Create the owner account for this Ayame installation.')
      expect(wrapper.text()).not.toContain('Nia')
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
      expect(wrapper.text()).not.toContain('Nia')
      expect(wrapper.find('label[for="login-username"]').text()).toBe('Username')
      expect(wrapper.find('label[for="login-password"]').text()).toBe('Password')
      expect(wrapper.find('button[type="submit"]').text()).toBe('Sign In')
    })

    it('renders authenticated shell when initialized and authenticated', async () => {
      api.getAuthStatus.mockResolvedValue({ initialized: true, authenticated: true })

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="authenticated-shell"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Your workspace is ready')
      expect(wrapper.find('button[data-testid="logout-button"]').exists()).toBe(true)
      expect(wrapper.find('h1').text()).toBe('ayame')
      expect(wrapper.text()).toContain('A place to think.')
      expect(wrapper.text()).not.toContain('Nia')
    })

    it('renders retryable error when status request fails and retries on action', async () => {
      api.getAuthStatus.mockRejectedValueOnce(new Error('Network error'))

      const wrapper = mount(App)
      await flushPromises()

      expect(wrapper.find('[data-testid="error-state"]').exists()).toBe(true)
      expect(wrapper.text()).toContain('Ayame could not reach the server.')
      expect(wrapper.text()).not.toContain('Nia')

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
})
