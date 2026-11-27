import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MuralPanel from './MuralPanel.vue'
import * as api from './api.js'

vi.mock('./api.js', async (importOriginal) => ({
  getMuralImageUrl: (await importOriginal()).getMuralImageUrl,
  listMuralCards: vi.fn(),
  readMuralNote: vi.fn(),
  writeMuralNote: vi.fn(),
  deleteMuralNote: vi.fn(),
  moveMuralNote: vi.fn(),
  uploadMuralImage: vi.fn(),
  removeMuralImage: vi.fn(),
}))

const click = (wrapper, label) => wrapper.findAll('button').find((button) => button.text() === label).trigger('click')
const id = 'a'.repeat(32)
const initial = { id, title: 'Ideas', body: 'First text', pinned: false, archived: false, color: 'neutral', position: 1, revision: 1 }
const board = (cards = []) => ({
  pinned: { cards: cards.filter((card) => card.pinned), next: null },
  notes: { cards: cards.filter((card) => !card.pinned), next: null },
})
const selectImage = async (wrapper, file) => {
  Object.defineProperty(wrapper.element, 'files', { value: [file], configurable: true })
  await wrapper.trigger('change')
  await flushPromises()
}

describe('MuralPanel', () => {
  let wrapper

  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    api.listMuralCards.mockResolvedValue(board())
  })

  afterEach(() => {
    wrapper?.unmount()
    vi.useRealTimers()
  })

  it('shows a newly saved note alongside a full pinned page without waiting for a new list', async () => {
    const pinned = Array.from({ length: 16 }, (_, index) => ({
      ...initial, id: `pin-${index}`, pinned: true, position: 17 - index,
    }))
    api.listMuralCards.mockResolvedValue({
      pinned: { cards: pinned, next: '1:2' }, notes: { cards: [initial], next: null },
    })
    api.writeMuralNote.mockImplementationOnce(async (noteId, fields) => ({
      note: { ...fields, id: noteId, position: 18, revision: 1 },
    }))
    wrapper = mount(MuralPanel)
    await flushPromises()
    expect(wrapper.findAll('[data-card-id]')).toHaveLength(17)
    await click(wrapper, 'New note')
    await wrapper.get('[data-testid="mural-note-body"]').setValue('Visible immediately')
    await click(wrapper, 'Done')
    await flushPromises()
    expect(wrapper.get('section[aria-label="Notes"] [data-card-id]').text()).toContain('Visible immediately')
    expect(api.listMuralCards).toHaveBeenCalledTimes(1)
  })

  it('deletes a saved note after confirmation and removes it from the board', async () => {
    api.listMuralCards.mockResolvedValue(board([initial]))
    api.readMuralNote.mockResolvedValue({ note: initial })
    api.deleteMuralNote.mockResolvedValue({ deleted: true })
    wrapper = mount(MuralPanel)
    await flushPromises()
    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()
    await click(wrapper, 'Delete note')
    expect(api.deleteMuralNote).not.toHaveBeenCalled()
    await click(wrapper, 'Cancel')
    expect(wrapper.find(`[data-card-id="${id}"]`).exists()).toBe(true)
    await click(wrapper, 'Delete note')
    await click(wrapper, 'Confirm deletion')
    await flushPromises()
    expect(api.deleteMuralNote).toHaveBeenCalledWith(id, initial.revision)
    expect(wrapper.find(`[data-card-id="${id}"]`).exists()).toBe(false)
  })

  it('creates no empty note and saves text and color while serializing edits in flight', async () => {
    let finishSave
    api.writeMuralNote.mockImplementationOnce((noteId, payload) => new Promise((resolve) => {
      finishSave = () => resolve({ note: { ...payload, id: noteId, position: 1, revision: 1 } })
    }))
    api.writeMuralNote.mockImplementationOnce(async (noteId, payload) => ({
      note: { ...payload, id: noteId, position: 1, revision: 2 },
    }))
    wrapper = mount(MuralPanel)
    await flushPromises()
    await click(wrapper, 'New note')
    await wrapper.get('[data-testid="mural-note-done"]').trigger('click')
    await flushPromises()
    expect(api.writeMuralNote).not.toHaveBeenCalled()

    await click(wrapper, 'New note')
    const body = wrapper.get('[data-testid="mural-note-body"]')
    await body.setValue('Text\n*Untouched*')
    await wrapper.get('button[data-color="ochre"]').trigger('click')
    await vi.advanceTimersByTimeAsync(650)
    const [noteId, first] = api.writeMuralNote.mock.calls[0]
    expect(first).toMatchObject({ title: '', body: 'Text\n*Untouched*', color: 'ochre', expectedRevision: null })

    await body.setValue('A newer draft')
    await wrapper.get('[data-testid="mural-note-done"]').trigger('click')
    expect(api.writeMuralNote).toHaveBeenCalledTimes(1)
    finishSave()
    await flushPromises()
    expect(api.writeMuralNote).toHaveBeenLastCalledWith(noteId, expect.objectContaining({ body: 'A newer draft', expectedRevision: 1 }))
    expect(wrapper.find('[data-testid="mural-note-editor"]').exists()).toBe(false)
  })

  it('keeps the draft on conflict and saves only after the user confirms the latest revision', async () => {
    api.listMuralCards.mockResolvedValue(board([{ ...initial, preview: 'First text' }]))
    api.readMuralNote.mockResolvedValue({ note: initial })
    const remote = { ...initial, body: 'Edited on another device', revision: 2 }
    api.writeMuralNote.mockRejectedValueOnce(Object.assign(new Error('Conflict'), {
      code: 'MURAL_NOTE_CONFLICT', note: remote,
    }))
    api.writeMuralNote.mockResolvedValueOnce({ note: { ...remote, body: 'My draft', revision: 3 } })

    wrapper = mount(MuralPanel)
    await flushPromises()
    expect(api.readMuralNote).not.toHaveBeenCalled()
    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()
    const body = wrapper.get('[data-testid="mural-note-body"]')
    await body.setValue('My draft')
    await vi.advanceTimersByTimeAsync(650)
    expect(body.element.value).toBe('My draft')
    expect(wrapper.get('[role="alert"]').text()).toContain('another session')
    expect(api.writeMuralNote).toHaveBeenCalledTimes(1)

    await click(wrapper, 'Save my version')
    await flushPromises()
    expect(api.writeMuralNote).toHaveBeenLastCalledWith(id, expect.objectContaining({ body: 'My draft', expectedRevision: 2 }))
    expect(wrapper.get(`[data-card-id="${id}"]`).text()).toContain('My draft')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it('retries an image with the same id and uses a lazy thumbnail on the board', async () => {
    api.uploadMuralImage.mockRejectedValueOnce(new Error('Network interrupted'))
    api.uploadMuralImage.mockImplementationOnce(async (cardId) => {
      return { note: { ...initial, id: cardId, title: '', body: '', kind: 'image', imageVersion: 'version1' } }
    })
    wrapper = mount(MuralPanel)
    await flushPromises()
    const file = new File(['upload'], 'decor.png', { type: 'image/png' })
    await selectImage(wrapper.get('input[type="file"]'), file)
    const [cardId] = api.uploadMuralImage.mock.calls[0]
    await click(wrapper, 'Retry upload')
    await flushPromises()

    expect(api.uploadMuralImage).toHaveBeenLastCalledWith(cardId, file)
    const tile = wrapper.get(`[data-card-id="${cardId}"]`)
    expect(tile.classes()).toContain('mural-card--with-image')
    expect(tile.get('img').attributes()).toMatchObject({ loading: 'lazy', src: `/vaults/mural/cards/${cardId}/image?v=version1` })
    const editor = wrapper.get('[data-testid="mural-note-editor"]')
    expect(editor.get('img').attributes('src')).toContain('variant=original')
    expect(editor.find('textarea').exists()).toBe(false)
  })

  it('saves changes before attaching a background, then removes it without losing the text', async () => {
    const file = new File(['upload'], 'background.png', { type: 'image/png' })
    let note = { ...initial, kind: 'note', imageVersion: null }
    api.listMuralCards.mockResolvedValue(board([{ ...note, preview: note.body }]))
    api.readMuralNote.mockResolvedValueOnce({ note })
    api.writeMuralNote.mockImplementationOnce(async (_, { body }) => {
      note = { ...note, body, revision: 2 }
      return { note }
    })
    api.uploadMuralImage.mockImplementationOnce(async () => {
      note = { ...note, imageVersion: 'attached', revision: 3 }
      return { note }
    })
    api.removeMuralImage.mockImplementationOnce(async () => {
      note = { ...note, imageVersion: null, revision: 4 }
      return { note }
    })
    wrapper = mount(MuralPanel)
    await flushPromises()
    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="mural-note-body"]').setValue('Updated draft')
    await selectImage(wrapper.get('[data-testid="mural-note-editor"] input[type="file"]'), file)
    expect(api.writeMuralNote).toHaveBeenCalledTimes(1)
    expect(api.uploadMuralImage).toHaveBeenCalledWith(id, file, 2)
    expect(wrapper.get(`[data-card-id="${id}"]`).classes()).toContain('mural-card--with-image')
    await click(wrapper, 'Remove background')
    await flushPromises()
    expect(api.removeMuralImage).toHaveBeenCalledWith(id, 3)
    expect(wrapper.get('[data-testid="mural-note-body"]').element.value).toBe('Updated draft')
    expect(wrapper.get(`[data-card-id="${id}"]`).find('img').exists()).toBe(false)
  })

  it('reopens the latest saved text from the fresh cache without another read', async () => {
    api.listMuralCards.mockResolvedValue(board([{ ...initial, preview: initial.body }]))
    api.readMuralNote.mockResolvedValueOnce({ note: initial })
    api.writeMuralNote.mockResolvedValueOnce({ note: { ...initial, body: 'Saved text', revision: 2 } })
    wrapper = mount(MuralPanel)
    await flushPromises()
    const card = wrapper.get(`[data-card-id="${id}"]`)
    await card.trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="mural-note-body"]').setValue('Saved text')
    await click(wrapper, 'Done')
    await flushPromises()
    await card.trigger('click')
    expect(wrapper.get('[data-testid="mural-note-body"]').element.value).toBe('Saved text')
    expect(api.readMuralNote).toHaveBeenCalledTimes(1)
  })

  it.each([false, true])('opens expired notes immediately and preserves drafts during revalidation (edited: %s)', async (edited) => {
    const remote = { ...initial, body: 'Edited on another device', revision: 2 }
    let completeRead
    api.listMuralCards.mockResolvedValue(board([{ ...initial, preview: initial.body }]))
    api.readMuralNote.mockResolvedValueOnce({ note: initial }).mockImplementationOnce(() => new Promise((resolve) => {
      completeRead = resolve
    }))
    wrapper = mount(MuralPanel)
    await flushPromises()
    const card = wrapper.get(`[data-card-id="${id}"]`)
    await card.trigger('click')
    await flushPromises()
    await click(wrapper, 'Done')
    vi.setSystemTime(Date.now() + 30_000)

    await card.trigger('click')
    const body = wrapper.get('[data-testid="mural-note-body"]')
    expect(body.element.value).toBe(initial.body)
    expect(api.readMuralNote).toHaveBeenCalledTimes(2)
    if (edited) await body.setValue('Draft on this device')
    completeRead({ note: remote })
    await flushPromises()
    expect(body.element.value).toBe(edited ? 'Draft on this device' : remote.body)
  })

  it('ignores an in-flight revalidation after a newer version is saved', async () => {
    let completeRead
    api.listMuralCards.mockResolvedValue(board([{ ...initial, preview: initial.body }]))
    api.readMuralNote.mockResolvedValueOnce({ note: initial }).mockImplementationOnce(() => new Promise((resolve) => {
      completeRead = resolve
    }))
    api.writeMuralNote.mockResolvedValueOnce({ note: { ...initial, body: 'New version', revision: 2 } })
    wrapper = mount(MuralPanel)
    await flushPromises()
    const card = wrapper.get(`[data-card-id="${id}"]`)
    await card.trigger('click')
    await flushPromises()
    await click(wrapper, 'Done')
    vi.setSystemTime(Date.now() + 30_000)
    await card.trigger('click')
    const [, signal] = api.readMuralNote.mock.calls[1]
    await wrapper.get('[data-testid="mural-note-body"]').setValue('New version')
    await click(wrapper, 'Done')
    await flushPromises()
    expect(signal.aborted).toBe(true)
    completeRead({ note: initial })
    await flushPromises()
    await card.trigger('click')
    expect(wrapper.get('[data-testid="mural-note-body"]').element.value).toBe('New version')
    expect(api.readMuralNote).toHaveBeenCalledTimes(2)
  })

  it('reorders from the keyboard handle and rolls back the display if the save fails', async () => {
    const secondId = 'b'.repeat(32)
    const thirdId = 'c'.repeat(32)
    const third = { ...initial, id: thirdId, title: 'Third', position: 1 }
    const cards = [{ ...initial, position: 3 }, { ...initial, id: secondId, title: 'Second', position: 2 }, third]
    api.listMuralCards.mockResolvedValue(board(cards))
    let finishMove
    api.moveMuralNote.mockImplementationOnce(() => new Promise((resolve) => { finishMove = resolve }))
    api.moveMuralNote.mockRejectedValueOnce(new Error('Offline'))
    wrapper = mount(MuralPanel)
    await flushPromises()
    const order = () => wrapper.findAll('[data-card-id]').map((card) => card.attributes('data-card-id'))
    await wrapper.get(`[data-mural-tile="${thirdId}"] [data-mural-drag-handle]`).trigger('keydown', { key: 'ArrowUp' })
    expect(order()).toEqual([id, thirdId, secondId])
    expect(api.moveMuralNote).toHaveBeenCalledWith(thirdId, {
      targetId: secondId, placement: 'before', expectedPosition: 1, expectedTargetPosition: 2,
    })
    finishMove({ note: { ...third, position: 2 }, moved: true, positions: [{ id: thirdId, position: 2 }, { id: secondId, position: 1 }] })
    await flushPromises()
    expect(order()).toEqual([id, thirdId, secondId])
    expect(api.listMuralCards).toHaveBeenCalledTimes(1)

    await wrapper.get(`[data-mural-tile="${thirdId}"] [data-mural-drag-handle]`).trigger('keydown', { key: 'ArrowDown' })
    await flushPromises()
    expect(order()).toEqual([id, thirdId, secondId])
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not reorder the card')
  })
})
