import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import VaultsPanel from './VaultsPanel.vue'
import * as api from './api.js'

vi.mock('./api.js', async (importOriginal) => ({
  getVaults: vi.fn(),
  registerVault: vi.fn(),
  createVault: vi.fn(),
  updateVault: vi.fn(),
  reorderVaults: vi.fn(),
  uploadVaultCover: vi.fn(),
  deleteVaultCover: vi.fn(),
  getVaultCoverUrl: (await importOriginal()).getVaultCoverUrl,
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
  return wrapper.find('[data-testid="vault-editor-modal"]')
}

beforeEach(() => {
  vi.clearAllMocks()
  api.getVaults.mockResolvedValue({ vaults: [] })
  api.registerVault.mockResolvedValue({ vault: customized })
  api.createVault.mockResolvedValue({ vault: customized })
  api.updateVault.mockResolvedValue({ vault: customized })
  api.reorderVaults.mockResolvedValue({ vaults: [customized] })
  api.uploadVaultCover.mockResolvedValue({ vault: { ...customized, hasCover: true, coverUpdatedAt: 100 } })
  api.deleteVaultCover.mockResolvedValue({ vault: { ...customized, hasCover: false, coverUpdatedAt: null } })
  api.unregisterVault.mockResolvedValue({ ok: true })
})

describe('VaultsPanel', () => {
  it('loads on mount and exposes an accessible loading state', () => {
    api.getVaults.mockReturnValue(new Promise(() => {}))
    const wrapper = mount(VaultsPanel)
    expect(wrapper.text()).toContain('Your vaults')
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
    expect(rows[0].text()).not.toContain('Detected')
    expect(rows[0].text()).toContain('Open')
    expect(rows[0].text()).toContain('Customize')
    expect(rows[0].text()).not.toContain('Reset')
    expect(rows[1].text()).toContain('Personal Notes')
    expect(rows[1].text()).toContain('personal/')
    expect(rows[1].text()).not.toContain('Customized')
    expect(rows[1].text()).toContain('Open')
    expect(rows[1].text()).toContain('Reset')
    expect(rows[1].findAll('button').map((button) => button.text())).not.toContain('Customize')
    expect(wrapper.find('a').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('/private/server/path')
  })

  it('opens the vault when clicking the card directly and keeps action buttons isolated', async () => {
    const wrapper = await mountPanel([detected, customized])
    const rows = wrapper.findAll('[data-testid="vault-row"]')

    // Clicking anywhere on the card opens the vault immediately
    await rows[0].trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(1)
    expect(wrapper.emitted('open')[0]).toEqual([detected])

    // Clicking Open button also works without double-emitting
    const customizedOpenButton = rows[1].find('[data-testid="open-vault-button"]')
    expect(customizedOpenButton.exists()).toBe(true)
    await customizedOpenButton.trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(2)
    expect(wrapper.emitted('open')[1]).toEqual([customized])

    // Clicking Edit does not open the vault, and opens a centered floating modal instead
    await rows[1].find('[data-testid="edit-vault-button"]').trigger('click')
    expect(wrapper.emitted('open')).toHaveLength(2)
    expect(wrapper.find('[data-testid="vault-editor-modal"]').exists()).toBe(true)
    expect(rows[1].find('[data-testid="vault-editor"]').exists()).toBe(false)
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
    expect(wrapper.find('[data-testid="edit-vault-button"]').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('Customized')

    reload.resolve({ vaults: [customized] })
    await flushPromises()
    expect(wrapper.find('[data-testid="edit-vault-button"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Reset')
    expect(wrapper.text()).toContain('Personal Notes')
    expect(wrapper.text()).not.toContain('Customized')
  })

  it('resets customization, reloads server truth, and keeps the physical vault row', async () => {
    const wrapper = await mountPanel([customized])
    api.getVaults.mockResolvedValueOnce({ vaults: [detected] })
    await wrapper.findAll('button').find((button) => button.text() === 'Reset').trigger('click')
    await flushPromises()
    expect(api.unregisterVault).toHaveBeenCalledWith('vault-1')
    expect(wrapper.text()).toContain('personal')
    expect(wrapper.text()).toContain('Customize')
    expect(wrapper.text()).not.toContain('Detected')
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
    expect(wrapper.find('[data-testid="edit-vault-button"]').exists()).toBe(true)
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
    expect(wrapper.find('[data-testid="edit-vault-button"]').exists()).toBe(true)
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
    expect(wrapper.find('[data-testid="edit-vault-button"]').exists()).toBe(true)
  })

  it('reorders vault cards purely via drag-and-drop without arrow buttons or grip icons', async () => {
    const v1 = { ...customized, id: '1', name: 'Alpha', directory: 'alpha', position: 0 }
    const v2 = { ...customized, id: '2', name: 'Beta', directory: 'beta', position: 1 }
    const wrapper = await mountPanel([v1, v2])

    expect(wrapper.find('[data-testid="move-vault-earlier"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="move-vault-later"]').exists()).toBe(false)
    expect(wrapper.find('.vault-drag-grip').exists()).toBe(false)

    api.reorderVaults.mockResolvedValueOnce({ vaults: [v2, v1] })
    const rows = wrapper.findAll('[data-testid="vault-row"]')
    await rows[1].trigger('dragstart')
    await rows[0].trigger('dragover')
    await rows[0].trigger('drop')
    await flushPromises()

    expect(api.reorderVaults).toHaveBeenCalledWith(['beta', 'alpha'])
    expect(wrapper.findAll('[data-testid="vault-row"] h3').map((el) => el.text())).toEqual(['Beta', 'Alpha'])
  })

  it('filters cards by search query, category pills, and clickable tags, and reassigns category via drag in Categories view', async () => {
    const v1 = { ...customized, id: '1', name: 'Isekai Lore', directory: 'isekai', category: 'Worldbuilding', tags: ['rpg', 'lore'], pinned: true, noteCount: 12 }
    const v2 = { ...customized, id: '2', name: 'Study Notes', directory: 'study', category: 'School', tags: ['math'], pinned: false, noteCount: 5 }
    const wrapper = await mountPanel([v1, v2])

    // Filter by category pill
    await wrapper.find('[data-testid="category-filter-Worldbuilding"]').trigger('click')
    expect(wrapper.findAll('[data-testid="vault-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="vault-row"] h3').text()).toBe('Isekai Lore')

    await wrapper.find('[data-testid="category-filter-all"]').trigger('click')
    expect(wrapper.findAll('[data-testid="vault-row"]')).toHaveLength(2)

    // Filter by tag chip
    await wrapper.find('[data-testid="tag-filter-math"]').trigger('click')
    expect(wrapper.findAll('[data-testid="vault-row"]')).toHaveLength(1)
    expect(wrapper.find('[data-testid="vault-row"] h3').text()).toBe('Study Notes')
    await wrapper.find('[data-testid="clear-tag-filter"]').trigger('click')

    // Search query
    await wrapper.find('[data-testid="vaults-search-input"]').setValue('#rpg')
    expect(wrapper.findAll('[data-testid="vault-row"]')).toHaveLength(1)
    await wrapper.find('[data-testid="vaults-search-input"]').setValue('')

    // Categories view drag-and-drop reassignment
    await wrapper.find('[data-testid="view-mode-categories"]').trigger('click')
    const studyRow = wrapper.find('[data-testid="vault-row"][data-vault-directory="study"]')
    const worldZone = wrapper.find('[data-testid="category-drop-zone"][data-category-key="Worldbuilding"]')
    api.getVaults.mockResolvedValueOnce({ vaults: [v1, { ...v2, category: 'Worldbuilding' }] })

    await studyRow.trigger('dragstart')
    await worldZone.trigger('dragover')
    await worldZone.trigger('drop')
    await flushPromises()

    expect(api.updateVault).toHaveBeenCalledWith('study', { category: 'Worldbuilding' })
  })

  it('creates new vaults, edits existing customized vaults, pins cards, and manages cover photos', async () => {
    const existing = {
      ...customized,
      id: 'v1',
      name: 'Isekai',
      directory: 'Isekai',
      category: 'Fiction',
      tags: ['lore'],
      description: 'Original',
      accentColor: '#a99aca',
      pinned: false,
      hasCover: false,
    }
    const wrapper = await mountPanel([existing])

    // Create vault drawer
    await wrapper.find('[data-testid="new-vault-button"]').trigger('click')
    const createForm = wrapper.find('[data-testid="create-vault-form"]')
    expect(createForm.exists()).toBe(true)
    await createForm.find('#create-vault-name').setValue('New Lab')
    await createForm.find('#create-vault-category').setValue('Work')
    await createForm.find('#create-vault-tag-input').setValue('research')
    await createForm.find('#create-vault-tag-input').trigger('keydown.enter')
    api.getVaults.mockResolvedValueOnce({ vaults: [existing] })
    await createForm.trigger('submit')
    await flushPromises()

    expect(api.createVault).toHaveBeenCalledWith(expect.objectContaining({
      name: 'New Lab',
      category: 'Work',
      tags: ['research'],
      createWelcomeNote: true,
    }))

    // Pin toggle
    api.getVaults.mockResolvedValueOnce({ vaults: [{ ...existing, pinned: true }] })
    await wrapper.find('[data-testid="pin-vault-button"]').trigger('click')
    await flushPromises()
    expect(api.updateVault).toHaveBeenCalledWith('Isekai', { pinned: true })

    // Upload cover via file drop onto card
    const fakeFile = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10])], 'cover.png', { type: 'image/png' })
    const withCover = { ...existing, hasCover: true, coverUpdatedAt: 999 }
    api.getVaults.mockResolvedValueOnce({ vaults: [withCover] })
    await wrapper.find('[data-testid="vault-row"]').trigger('drop', {
      dataTransfer: { files: [fakeFile] },
    })
    await flushPromises()
    expect(api.uploadVaultCover).toHaveBeenCalledWith('Isekai', fakeFile)
    const cover = wrapper.get('[data-testid="vault-cover-image"]')
    expect(cover.attributes()).toMatchObject({
      src: '/vaults/Isekai/cover?v=999&variant=thumbnail',
      loading: 'lazy',
      decoding: 'async',
    })

    // Edit customized vault and remove cover
    await wrapper.find('[data-testid="edit-vault-button"]').trigger('click')
    const editor = wrapper.find('[data-testid="vault-editor"]')
    expect(editor.exists()).toBe(true)
    expect(editor.get('.vault-cover-thumb').attributes('src')).toBe('/vaults/Isekai/cover?v=999')
    api.getVaults.mockResolvedValueOnce({ vaults: [existing] })
    await editor.find('[data-testid="remove-cover-button"]').trigger('click')
    await flushPromises()
    expect(api.deleteVaultCover).toHaveBeenCalledWith('Isekai')

    await editor.find('#vault-name').setValue('Isekai Updated')
    await editor.find('#edit-vault-category').setValue('Fantasy')
    api.getVaults.mockResolvedValueOnce({ vaults: [{ ...existing, name: 'Isekai Updated', category: 'Fantasy' }] })
    await editor.trigger('submit')
    await flushPromises()
    expect(api.updateVault).toHaveBeenCalledWith('Isekai', expect.objectContaining({
      name: 'Isekai Updated',
      category: 'Fantasy',
    }))
  })

  it('creates custom category buckets in Categories view, drops uncategorized vaults into them, and prioritizes pinned vaults in sorted modes', async () => {
    const v1 = { ...customized, id: '1', name: 'Zebra', directory: 'zebra', category: '', pinned: true, noteCount: 3 }
    const v2 = { ...customized, id: '2', name: 'Alpha', directory: 'alpha', category: '', pinned: false, noteCount: 10 }
    const wrapper = await mountPanel([v1, v2])

    // In Name (A-Z) sort mode, pinned vault Zebra stays ahead of unpinned Alpha
    await wrapper.find('[data-testid="vaults-sort-select"]').setValue('name')
    expect(wrapper.findAll('[data-testid="vault-row"] h3').map((el) => el.text().trim())).toEqual(['Zebra', 'Alpha'])

    // Clickable heading opens vault
    await wrapper.find('[data-testid="vault-row"] h3').trigger('click')
    expect(wrapper.emitted('open')?.[0]?.[0]?.directory).toBe('zebra')

    // Switch to Categories view, create custom bucket, and drop uncategorized vault into it
    await wrapper.find('[data-testid="view-mode-categories"]').trigger('click')
    await wrapper.find('[data-testid="add-category-bucket-input"]').setValue('Archives')
    await wrapper.find('[data-testid="add-category-bucket-form"]').trigger('submit')

    const archivesZone = wrapper.find('[data-testid="category-drop-zone"][data-category-key="Archives"]')
    expect(archivesZone.exists()).toBe(true)

    const alphaRow = wrapper.find('[data-testid="vault-row"][data-vault-directory="alpha"]')
    api.getVaults.mockResolvedValueOnce({ vaults: [v1, { ...v2, category: 'Archives' }] })
    await alphaRow.trigger('dragstart')
    await archivesZone.trigger('dragover')
    await archivesZone.trigger('drop')
    await flushPromises()

    expect(api.updateVault).toHaveBeenCalledWith('alpha', { category: 'Archives' })
  })

  it('supports smooth Keep-style pointer drag-and-drop on Vault cards and across category zones', async () => {
    const v1 = { ...customized, id: '1', name: 'Alpha', directory: 'alpha', category: 'Work', position: 0 }
    const v2 = { ...customized, id: '2', name: 'Beta', directory: 'beta', category: 'Personal', position: 1 }
    api.getVaults.mockResolvedValue({ vaults: [v1, v2] })
    const wrapper = mount(VaultsPanel, { attachTo: document.body })
    await flushPromises()

    const alphaCard = wrapper.get('[data-vault-directory="alpha"]').element
    const betaCard = wrapper.get('[data-vault-directory="beta"]').element
    const mockRect = (left, top, width = 280, height = 160) => ({
      left, right: left + width, top, bottom: top + height, width, height, x: left, y: top, toJSON() {},
    })
    vi.spyOn(alphaCard, 'getBoundingClientRect').mockReturnValue(mockRect(0, 0))
    vi.spyOn(betaCard, 'getBoundingClientRect').mockReturnValue(mockRect(300, 0))

    const dispatchPointer = (target, type, init) => {
      const ev = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(ev, { pointerId: 1, button: 0, isPrimary: true, pointerType: 'mouse', ...init })
      target.dispatchEvent(ev)
    }
    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    // Interactive buttons inside a card must never initiate pointer drag
    const openBtn = alphaCard.querySelector('[data-testid="open-vault-button"]')
    dispatchPointer(openBtn, 'pointerdown', { clientX: 20, clientY: 140 })
    dispatchPointer(window, 'pointermove', { clientX: 350, clientY: 140 })
    await nextFrame()
    expect(wrapper.find('.vault-card--pointer-dragging').exists()).toBe(false)
    dispatchPointer(window, 'pointerup', { clientX: 350, clientY: 140 })

    // Drag Alpha card by its body -> lifts real card with locked size & renders placeholder
    dispatchPointer(alphaCard, 'pointerdown', { clientX: 100, clientY: 80 })
    dispatchPointer(window, 'pointermove', { clientX: 440, clientY: 80 })
    await nextFrame()
    await flushPromises()

    const lifted = wrapper.get('[data-vault-directory="alpha"]')
    expect(lifted.classes()).toContain('vault-card--pointer-dragging')
    expect(lifted.attributes('style')).toContain('width: 280px')
    expect(lifted.attributes('style')).toContain('height: 160px')
    expect(wrapper.find('[data-testid="vault-placeholder"]').exists()).toBe(true)

    // Escape cancels cleanly without saving
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.vault-card--pointer-dragging').exists()).toBe(false)
    expect(wrapper.find('[data-testid="vault-placeholder"]').exists()).toBe(false)
    expect(api.reorderVaults).not.toHaveBeenCalled()

    // Drag Alpha past Beta and drop -> optimistically reorders and calls reorderVaults
    api.reorderVaults.mockResolvedValueOnce({ vaults: [v2, v1] })
    dispatchPointer(alphaCard, 'pointerdown', { clientX: 100, clientY: 80 })
    dispatchPointer(window, 'pointermove', { clientX: 440, clientY: 80 })
    await nextFrame()
    await flushPromises()
    dispatchPointer(window, 'pointerup', { clientX: 440, clientY: 80 })
    // Synthesized click right after drop must not open the card
    const clickEv = new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 })
    alphaCard.dispatchEvent(clickEv)
    await flushPromises()

    expect(api.reorderVaults).toHaveBeenCalledWith(['beta', 'alpha'])
    expect(wrapper.emitted('open')).toBeUndefined()
    expect(wrapper.findAll('[data-testid="vault-row"] h3').map((el) => el.text())).toEqual(['Beta', 'Alpha'])

    // Pointer drag in Categories view reassigns vault category smoothly
    await wrapper.find('[data-testid="view-mode-categories"]').trigger('click')
    await flushPromises()

    const workZone = wrapper.get('[data-category-key="Work"]').element
    const personalZone = wrapper.get('[data-category-key="Personal"]').element
    const alphaCatCard = wrapper.get('[data-vault-directory="alpha"]').element
    const betaCatCard = wrapper.get('[data-vault-directory="beta"]').element

    vi.spyOn(personalZone, 'getBoundingClientRect').mockReturnValue(mockRect(0, 0, 800, 220))
    vi.spyOn(workZone, 'getBoundingClientRect').mockReturnValue(mockRect(0, 250, 800, 220))
    vi.spyOn(betaCatCard, 'getBoundingClientRect').mockReturnValue(mockRect(20, 40, 280, 160))
    vi.spyOn(alphaCatCard, 'getBoundingClientRect').mockReturnValue(mockRect(20, 290, 280, 160))

    api.reorderVaults.mockResolvedValueOnce({ vaults: [v2, { ...v1, category: 'Personal' }] })
    dispatchPointer(alphaCatCard, 'pointerdown', { clientX: 100, clientY: 360 })
    dispatchPointer(window, 'pointermove', { clientX: 350, clientY: 110 })
    await nextFrame()
    await flushPromises()
    expect(wrapper.get('[data-category-key="Personal"]').classes()).toContain('vault-category-section--drop')

    dispatchPointer(window, 'pointerup', { clientX: 350, clientY: 110 })
    await flushPromises()
    expect(api.updateVault).toHaveBeenCalledWith('alpha', { category: 'Personal' })

    wrapper.unmount()
  })
})
