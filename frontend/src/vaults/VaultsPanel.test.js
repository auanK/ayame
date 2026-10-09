import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import VaultsPanel from './VaultsPanel.vue'
import * as api from './api.js'

vi.mock('./api.js', () => ({
  getVaults: vi.fn(),
  registerVault: vi.fn(),
  unregisterVault: vi.fn(),
}))

const detected = { id: null, name: 'personal', directory: 'Personal Dir', registered: false }
const customized = { id: 'vault-1', name: 'Personal Notes', directory: 'personal', registered: true }

const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const codedError = (code) => Object.assign(new Error(code), { code })

const mountPanel = async (vaults = []) => {
  api.getVaults.mockResolvedValue({ vaults })
  const wrapper = mount(VaultsPanel)
  await flushPromises()
  return wrapper
}

const customize = async (wrapper, name = 'personal') => {
  const row = wrapper.findAll('[data-testid="vault-row"]').find((item) => item.text().includes(name))
  await row.findAll('button').find((button) => button.text() === 'Customize').trigger('click')
  return row
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getVaults.mockResolvedValue({ vaults: [] })
  api.registerVault.mockResolvedValue({ vault: customized })
  api.unregisterVault.mockResolvedValue({ ok: true })
})

describe('VaultsPanel', () => {
  it('loads on mount and exposes an accessible loading state', () => {
    api.getVaults.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(VaultsPanel)
    expect(wrapper.text()).toContain('Loading vaults...')
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true)
    expect(api.getVaults).toHaveBeenCalledTimes(1)
  })

  it('shows an explicit empty state and lets the user refresh', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.text()).toContain('No vaults found.')
    expect(wrapper.text()).toContain("Add a folder to Ayame's configured vaults directory, then refresh.")
    expect(wrapper.find('form').exists()).toBe(false)

    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(api.getVaults).toHaveBeenCalledTimes(2)
  })

  it('shows a retryable initial error', async () => {
    api.getVaults.mockRejectedValueOnce(codedError('FAILED_TO_FETCH_VAULTS'))
    const wrapper = mount(VaultsPanel)
    await flushPromises()
    expect(wrapper.text()).toContain('Could not load vaults. Try again.')

    api.getVaults.mockResolvedValueOnce({ vaults: [detected] })
    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('personal')
  })

  it('renders detected and customized vaults with only their valid actions', async () => {
    const wrapper = await mountPanel([detected, { ...customized, serverLocation: '/private/server/path' }])
    const rows = wrapper.findAll('[data-testid="vault-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('personal')
    expect(rows[0].text()).toContain('Personal Dir/')
    expect(rows[0].text()).toContain('Detected')
    expect(rows[0].text()).toContain('Customize')
    expect(rows[0].text()).not.toContain('Reset')
    expect(rows[1].text()).toContain('Personal Notes')
    expect(rows[1].text()).toContain('personal/')
    expect(rows[1].text()).toContain('Customized')
    expect(rows[1].text()).toContain('Reset')
    expect(rows[1].findAll('button').map((button) => button.text())).not.toContain('Customize')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('/private/server/path')
  })

  it('renders complete 100-character unbroken customized and detected names', async () => {
    const customizedName = 'a'.repeat(100)
    const detectedDirectory = 'b'.repeat(100)
    const wrapper = await mountPanel([
      { ...customized, name: customizedName },
      { id: null, name: detectedDirectory, directory: detectedDirectory, registered: false },
    ])
    const rows = wrapper.findAll('[data-testid="vault-row"]')

    expect(rows[0].find('h3').text()).toBe(customizedName)
    expect(rows[1].find('h3').text()).toBe(detectedDirectory)
    expect(rows[1].find('.vault-directory').text()).toBe(`${detectedDirectory}/`)
  })

  it('uses an inline editor with a prefilled name and read-only directory, and Cancel does not mutate', async () => {
    const wrapper = await mountPanel([detected])
    await customize(wrapper)
    const editor = wrapper.find('[data-testid="vault-editor"]')
    expect(editor.find('h3').text()).toBe('Customize vault')
    expect(editor.find('label[for="vault-name"]').text()).toBe('Display name')
    expect(editor.find('input#vault-name').element.value).toBe('personal')
    expect(editor.text()).toContain('Personal Dir/')
    expect(editor.find('input[name="directory"]').exists()).toBe(false)

    await editor.findAll('button').find((button) => button.text() === 'Cancel').trigger('click')
    expect(wrapper.find('[data-testid="vault-editor"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('personal')
    expect(api.registerVault).not.toHaveBeenCalled()
  })

  it('saves the exact original directory and reloads server state before showing customization', async () => {
    const post = deferred()
    const reload = deferred()
    api.registerVault.mockReturnValue(post.promise)
    api.getVaults.mockResolvedValueOnce({ vaults: [detected] }).mockReturnValueOnce(reload.promise)
    const wrapper = mount(VaultsPanel)
    await flushPromises()
    const row = await customize(wrapper)
    await row.find('input#vault-name').setValue('Personal Notes')
    await row.find('form').trigger('submit')

    expect(api.registerVault).toHaveBeenCalledWith({ name: 'Personal Notes', directory: 'Personal Dir' })
    post.resolve({ vault: customized })
    await flushPromises()
    expect(api.getVaults).toHaveBeenCalledTimes(2)
    expect(wrapper.find('[data-testid="vault-editor"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Customized')

    reload.resolve({ vaults: [customized] })
    await flushPromises()
    expect(wrapper.text()).toContain('Customized')
    expect(wrapper.text()).toContain('Personal Notes')
  })

  it('resets customization, reloads server truth, and keeps the physical vault row', async () => {
    const wrapper = await mountPanel([customized])
    api.getVaults.mockResolvedValueOnce({ vaults: [detected] })
    await wrapper.findAll('button').find((button) => button.text() === 'Reset').trigger('click')
    await flushPromises()
    expect(api.unregisterVault).toHaveBeenCalledWith('vault-1')
    expect(wrapper.text()).toContain('personal')
    expect(wrapper.text()).toContain('Detected')
    expect(wrapper.findAll('[data-testid="vault-row"]')).toHaveLength(1)
  })

  it('refreshes and renders external filesystem changes', async () => {
    const wrapper = await mountPanel([detected])
    api.getVaults.mockResolvedValueOnce({ vaults: [detected, { ...detected, name: 'work', directory: 'work' }] })
    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(api.getVaults).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('work/')
  })

  it('closes an editor when refresh confirms its detected folder disappeared', async () => {
    const wrapper = await mountPanel([detected])
    await customize(wrapper)
    api.getVaults.mockResolvedValueOnce({ vaults: [] })
    await wrapper.find('[data-testid="refresh-vaults-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-testid="vault-editor"]').exists()).toBe(false)
    expect(wrapper.text()).toContain('No vaults found.')
  })

  it('preserves the last confirmed list when refresh fails', async () => {
    const wrapper = await mountPanel([detected])
    api.getVaults.mockRejectedValueOnce(codedError('FAILED_TO_FETCH_VAULTS'))
    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('personal')
    expect(wrapper.text()).toContain('Could not refresh vaults. Try again.')
  })

  it('emits unauthorized when a manual refresh discovers an expired session', async () => {
    const wrapper = await mountPanel([detected])
    api.getVaults.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
    await wrapper.find('[data-testid="refresh-vaults-button"]').trigger('click')
    await flushPromises()
    expect(wrapper.emitted('unauthorized')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Could not refresh vaults')
  })

  it('emits unauthorized for a 401 during initial load', async () => {
    api.getVaults.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
    const wrapper = mount(VaultsPanel)
    await flushPromises()
    expect(wrapper.emitted('unauthorized')).toHaveLength(1)
    expect(wrapper.text()).not.toContain('Could not load vaults')
  })

  it('emits unauthorized for a 401 during save or reset', async () => {
    const saveWrapper = await mountPanel([detected])
    api.registerVault.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
    const saveRow = await customize(saveWrapper)
    await saveRow.find('form').trigger('submit')
    await flushPromises()
    expect(saveWrapper.emitted('unauthorized')).toHaveLength(1)

    const resetWrapper = await mountPanel([customized])
    api.unregisterVault.mockRejectedValueOnce(codedError('UNAUTHORIZED'))
    await resetWrapper.findAll('button').find((button) => button.text() === 'Reset').trigger('click')
    await flushPromises()
    expect(resetWrapper.emitted('unauthorized')).toHaveLength(1)
  })

  it('recovers a registration conflict by refreshing server state', async () => {
    const wrapper = await mountPanel([detected])
    api.registerVault.mockRejectedValueOnce(codedError('VAULT_ALREADY_REGISTERED'))
    api.getVaults.mockResolvedValueOnce({ vaults: [customized] })
    const row = await customize(wrapper)
    await row.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Customized')
    expect(wrapper.text()).toContain('Personal Notes')
    expect(wrapper.text()).toContain('This vault was customized elsewhere. The list has been refreshed.')
    expect(wrapper.find('[data-testid="vault-editor"]').exists()).toBe(false)
  })

  it('handles a disappeared folder by refreshing and showing current server state', async () => {
    const wrapper = await mountPanel([detected])
    api.registerVault.mockRejectedValueOnce(codedError('INVALID_VAULT_DIRECTORY'))
    api.getVaults.mockResolvedValueOnce({ vaults: [] })
    const row = await customize(wrapper)
    await row.find('form').trigger('submit')
    await flushPromises()
    expect(api.getVaults).toHaveBeenCalledTimes(2)
    expect(wrapper.text()).toContain('This vault folder is no longer available. Refresh and try again.')
    expect(wrapper.text()).toContain('No vaults found.')
  })

  it('keeps the editor and entered name after invalid-name validation', async () => {
    const wrapper = await mountPanel([detected])
    api.registerVault.mockRejectedValueOnce(codedError('INVALID_VAULT_NAME'))
    const row = await customize(wrapper)
    await row.find('input#vault-name').setValue('')
    await row.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="vault-editor"]').exists()).toBe(true)
    expect(wrapper.find('input#vault-name').element.value).toBe('')
    expect(wrapper.text()).toContain('Enter a valid display name and try again.')
  })

  it('reports a successful mutation separately from a failed list refresh and blocks stale actions', async () => {
    const wrapper = await mountPanel([detected])
    api.registerVault.mockResolvedValueOnce({ vault: customized })
    api.getVaults.mockRejectedValueOnce(codedError('FAILED_TO_FETCH_VAULTS'))
    const row = await customize(wrapper)
    await row.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.text()).toContain('Customization was saved, but the list could not be refreshed. Refresh to see the latest state.')
    expect(wrapper.find('[data-testid="vault-row"] button').exists()).toBe(false)

    api.getVaults.mockResolvedValueOnce({ vaults: [customized] })
    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Customized')
  })

  it('reports a successful reset separately from a failed list refresh and blocks stale actions', async () => {
    const wrapper = await mountPanel([customized])
    api.getVaults.mockRejectedValueOnce(codedError('FAILED_TO_FETCH_VAULTS'))
    await wrapper.findAll('button').find((button) => button.text() === 'Reset').trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('Customization was reset, but the list could not be refreshed. Refresh to see the latest state.')
    expect(wrapper.find('[data-testid="vault-row"] button').exists()).toBe(false)
    expect(wrapper.find('[data-testid="vault-row"]').exists()).toBe(true)
  })

  it('keeps the editor open after an unclassified registration failure', async () => {
    const wrapper = await mountPanel([detected])
    api.registerVault.mockRejectedValueOnce(codedError('FAILED_TO_REGISTER_VAULT'))
    const row = await customize(wrapper)
    await row.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[data-testid="vault-editor"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Could not customize this vault. Try again.')
  })

  it('prevents duplicate saves and keeps the editor target fixed while saving', async () => {
    const save = deferred()
    api.registerVault.mockReturnValue(save.promise)
    const wrapper = await mountPanel([detected, { ...detected, name: 'work', directory: 'work' }])
    const row = await customize(wrapper)
    const submit = row.find('form')
    await submit.trigger('submit')
    await submit.trigger('submit')
    await wrapper.findAll('button').find((button) => button.text() === 'Customize' && button.element.disabled).trigger('click')
    expect(api.registerVault).toHaveBeenCalledTimes(1)
    expect(row.findAll('button').find((button) => button.text() === 'Cancel').attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[data-testid="vault-editor"]')).toHaveLength(1)
    save.resolve({ vault: customized })
    await flushPromises()
  })

  it('prevents duplicate resets and conflicting refreshes while an operation is pending', async () => {
    const reset = deferred()
    api.unregisterVault.mockReturnValue(reset.promise)
    const wrapper = await mountPanel([customized])
    const resetButton = wrapper.findAll('button').find((button) => button.text() === 'Reset')
    await resetButton.trigger('click')
    await resetButton.trigger('click')
    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    expect(api.unregisterVault).toHaveBeenCalledTimes(1)
    expect(api.getVaults).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('button').find((button) => button.text() === 'Refresh').attributes('disabled')).toBeDefined()
    reset.resolve({ ok: true })
    await flushPromises()
  })

  it('prevents duplicate refresh requests', async () => {
    const refresh = deferred()
    const wrapper = await mountPanel([detected])
    api.getVaults.mockReturnValueOnce(refresh.promise)
    const button = wrapper.find('[data-testid="refresh-vaults-button"]')
    await button.trigger('click')
    await button.trigger('click')
    expect(wrapper.text()).toContain('Refreshing vaults...')
    expect(button.attributes('disabled')).toBeDefined()
    expect(api.getVaults).toHaveBeenCalledTimes(2)
    refresh.resolve({ vaults: [detected] })
    await flushPromises()
  })

  it('ignores a late 401 response after the panel unmounts', async () => {
    const load = deferred()
    api.getVaults.mockReturnValue(load.promise)
    const wrapper = mount(VaultsPanel)
    wrapper.unmount()
    load.reject(codedError('UNAUTHORIZED'))
    await flushPromises()
    expect(wrapper.emitted('unauthorized')).toBeUndefined()
  })

  it('does not start a mutation while a newer authoritative refresh is pending', async () => {
    const refresh = deferred()
    const wrapper = await mountPanel([detected])
    api.getVaults.mockReturnValueOnce(refresh.promise)
    await wrapper.findAll('button').find((button) => button.text() === 'Refresh').trigger('click')
    await wrapper.findAll('button').find((button) => button.text() === 'Customize').trigger('click')
    expect(api.registerVault).not.toHaveBeenCalled()
    refresh.resolve({ vaults: [customized] })
    await flushPromises()
    expect(wrapper.text()).toContain('Customized')
  })
})
