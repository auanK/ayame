import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import MuralPanel from './MuralPanel.vue'
import * as api from './api.js'

vi.mock('./api.js', async (importOriginal) => ({
  getMuralImageUrl: (await importOriginal()).getMuralImageUrl,
  listMuralCards: vi.fn(),
  readMuralNote: vi.fn(),
  writeMuralNote: vi.fn(),
  trashMuralNote: vi.fn(),
  restoreMuralNote: vi.fn(),
  deleteMuralNote: vi.fn(),
  emptyMuralTrash: vi.fn(),
  moveMuralNote: vi.fn(),
  resizeMuralCard: vi.fn(),
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

  it('moves deleted notes to trash, supports restoring or permanently deleting from trash, and empties trash', async () => {
    const trashedNote = { ...initial, trashedAt: 1000, revision: 2 }
    api.listMuralCards
      .mockResolvedValueOnce(board([initial]))
      .mockResolvedValueOnce({ cards: [{ ...trashedNote, preview: initial.body }], next: null })
      .mockResolvedValueOnce(board([initial]))
    api.readMuralNote.mockResolvedValue({ note: initial })
    api.trashMuralNote.mockResolvedValue({ note: trashedNote })
    api.restoreMuralNote.mockResolvedValue({ note: { ...initial, trashedAt: null, revision: 3 } })
    api.deleteMuralNote.mockResolvedValue({ deleted: true })
    api.emptyMuralTrash.mockResolvedValue({ deleted: 1 })

    wrapper = mount(MuralPanel)
    await flushPromises()
    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()
    await click(wrapper, 'Move to trash')
    await flushPromises()
    expect(api.trashMuralNote).toHaveBeenCalledWith(id, initial.revision)
    expect(api.deleteMuralNote).not.toHaveBeenCalled()
    expect(wrapper.find(`[data-card-id="${id}"]`).exists()).toBe(false)

    // Open Trash view and restore the note
    await wrapper.get('[data-testid="mural-trash-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.find(`[data-card-id="${id}"]`).exists()).toBe(true)

    api.readMuralNote.mockResolvedValueOnce({ note: trashedNote })
    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()
    await click(wrapper, 'Delete permanently')
    expect(api.deleteMuralNote).not.toHaveBeenCalled()
    await click(wrapper, 'Cancel')
    await click(wrapper, 'Restore')
    await flushPromises()
    expect(api.restoreMuralNote).toHaveBeenCalledWith(id, trashedNote.revision)
    expect(wrapper.find(`[data-card-id="${id}"]`).exists()).toBe(false)

    // Return to active view, verify note is back, then check permanent delete + empty trash
    await wrapper.get('[data-testid="mural-trash-toggle"]').trigger('click')
    await flushPromises()
    expect(wrapper.find(`[data-card-id="${id}"]`).exists()).toBe(true)

    api.listMuralCards.mockResolvedValueOnce({ cards: [{ ...trashedNote, preview: initial.body }], next: null })
    await wrapper.get('[data-testid="mural-trash-toggle"]').trigger('click')
    await flushPromises()
    await click(wrapper, 'Empty trash')
    await click(wrapper, 'Confirm empty trash')
    await flushPromises()
    expect(api.emptyMuralTrash).toHaveBeenCalledTimes(1)
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

  it('reorders via Alt+Arrow keys on cards without an accessibility drag handle and rolls back on failure', async () => {
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
    expect(wrapper.find('.mural-drag-handle').exists()).toBe(false)
    const order = () => wrapper.findAll('[data-card-id]').map((card) => card.attributes('data-card-id'))
    await wrapper.get(`[data-card-id="${thirdId}"]`).trigger('keydown', { key: 'ArrowUp', altKey: true })
    expect(order()).toEqual([id, thirdId, secondId])
    expect(api.moveMuralNote).toHaveBeenCalledWith(thirdId, {
      targetId: secondId, placement: 'before', expectedPosition: 1, expectedTargetPosition: 2,
    })
    finishMove({ note: { ...third, position: 2 }, moved: true, positions: [{ id: thirdId, position: 2 }, { id: secondId, position: 1 }] })
    await flushPromises()
    expect(order()).toEqual([id, thirdId, secondId])
    expect(api.listMuralCards).toHaveBeenCalledTimes(1)

    await wrapper.get(`[data-card-id="${thirdId}"]`).trigger('keydown', { key: 'ArrowDown', altKey: true })
    await flushPromises()
    expect(order()).toEqual([id, thirdId, secondId])
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not reorder the card')
  })

  it('hides image resize controls until clicked in the opened note corner, then resizes and resets cleanly', async () => {
    const imgCard = { ...initial, title: 'Photo', body: '', kind: 'image', imageVersion: 'v1', imageWidth: 320 }
    api.listMuralCards.mockResolvedValue(board([imgCard]))
    api.readMuralNote.mockResolvedValue({ note: imgCard })
    api.resizeMuralCard
      .mockResolvedValueOnce({ note: { ...imgCard, imageWidth: 352 } })
      .mockResolvedValueOnce({ note: { ...imgCard, imageWidth: null } })
      .mockRejectedValueOnce(new Error('Network error'))

    wrapper = mount(MuralPanel)
    await flushPromises()

    const tile = wrapper.get(`[data-mural-tile="${id}"]`)
    expect(tile.classes()).toContain('mural-tile--resized')
    // Resize handle is hidden by default until opened -> Resize clicked
    expect(tile.find('[data-mural-resize-handle]').exists()).toBe(false)

    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()
    await wrapper.get('[data-testid="mural-note-resize"]').trigger('click')
    await flushPromises()

    expect(tile.classes()).toContain('mural-tile--resize-mode')
    const handle = tile.get('[data-mural-resize-handle]')

    await handle.trigger('keydown', { key: 'ArrowRight' })
    expect(api.resizeMuralCard).toHaveBeenNthCalledWith(1, id, 352)
    await flushPromises()
    expect(tile.attributes('style')).toContain('width: 352px')

    await handle.trigger('dblclick')
    expect(api.resizeMuralCard).toHaveBeenNthCalledWith(2, id, null)
    await flushPromises()
    expect(tile.classes()).not.toContain('mural-tile--resized')

    await handle.trigger('keydown', { key: 'ArrowRight' })
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not resize the image')
    expect(tile.classes()).not.toContain('mural-tile--resized')

    // Done exits resize mode and hides the resize handle again
    await wrapper.get('[data-testid="mural-resize-done"]').trigger('click')
    expect(tile.find('[data-mural-resize-handle]').exists()).toBe(false)
  })

  it('supports Keep-style real-card dragging with locked size, placeholder slot, Escape cancel, and serialized queue', async () => {
    const secondId = 'b'.repeat(32)
    const thirdId = 'c'.repeat(32)
    const cards = [
      { ...initial, title: 'First', position: 3 },
      { ...initial, id: secondId, title: 'Second', position: 2 },
      { ...initial, id: thirdId, title: 'Third', position: 1 },
    ]
    api.listMuralCards.mockResolvedValue(board(cards))

    let finishFirstMove
    api.moveMuralNote
      .mockImplementationOnce(() => new Promise((resolve) => {
        finishFirstMove = () => resolve({
          note: { ...cards[0], position: 2 },
          moved: true,
          positions: [{ id, position: 2 }, { id: secondId, position: 3 }],
        })
      }))
      .mockResolvedValueOnce({
        note: { ...cards[0], position: 1 },
        moved: true,
        positions: [{ id, position: 1 }, { id: thirdId, position: 2 }],
      })

    wrapper = mount(MuralPanel, { attachTo: document.body })
    await flushPromises()

    const firstTile = wrapper.get(`[data-mural-tile="${id}"]`).element
    const secondTile = wrapper.get(`[data-mural-tile="${secondId}"]`).element
    const thirdTile = wrapper.get(`[data-mural-tile="${thirdId}"]`).element
    const boardElem = wrapper.get('.mural-board').element
    const canvasElem = wrapper.get('.mural-canvas').element

    vi.spyOn(boardElem, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 800, top: 0, bottom: 200, width: 800, height: 200, x: 0, y: 0, toJSON() {},
    })
    vi.spyOn(canvasElem, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 800, top: 0, bottom: 200, width: 800, height: 200, x: 0, y: 0, toJSON() {},
    })
    vi.spyOn(firstTile, 'getBoundingClientRect').mockReturnValue({
      left: 0, right: 200, top: 0, bottom: 120, width: 200, height: 120, x: 0, y: 0, toJSON() {},
    })
    vi.spyOn(secondTile, 'getBoundingClientRect').mockReturnValue({
      left: 268, right: 468, top: 0, bottom: 120, width: 200, height: 120, x: 268, y: 0, toJSON() {},
    })
    vi.spyOn(thirdTile, 'getBoundingClientRect').mockReturnValue({
      left: 536, right: 736, top: 0, bottom: 120, width: 200, height: 120, x: 536, y: 0, toJSON() {},
    })

    const dispatchPointer = (target, type, init) => {
      const ev = new Event(type, { bubbles: true, cancelable: true })
      Object.assign(ev, { pointerId: 1, button: 0, isPrimary: true, pointerType: 'mouse', ...init })
      target.dispatchEvent(ev)
    }

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

    // Start dragging first card toward second card
    dispatchPointer(firstTile, 'pointerdown', { clientX: 50, clientY: 50 })
    dispatchPointer(window, 'pointermove', { clientX: 350, clientY: 50 })
    await nextFrame()
    await flushPromises()

    const draggingTile = wrapper.get(`[data-mural-tile="${id}"]`)
    expect(draggingTile.classes()).toContain('mural-tile--dragging')
    // Locked pixel size — never expands or shrinks when picked up
    expect(draggingTile.attributes('style')).toContain('width: 200px')
    expect(draggingTile.attributes('style')).toContain('height: 120px')
    expect(wrapper.find('.mural-placeholder').exists()).toBe(true)

    // Escape cancels cleanly without saving
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await flushPromises()
    expect(wrapper.find('.mural-tile--dragging').exists()).toBe(false)
    expect(wrapper.find('.mural-placeholder').exists()).toBe(false)
    expect(api.moveMuralNote).not.toHaveBeenCalled()

    // Drag 1: move First after Second while First is slow to resolve
    dispatchPointer(firstTile, 'pointerdown', { clientX: 50, clientY: 50 })
    dispatchPointer(window, 'pointermove', { clientX: 350, clientY: 50 })
    await nextFrame()
    await flushPromises()
    dispatchPointer(window, 'pointerup', { clientX: 350, clientY: 50 })
    await flushPromises()

    expect(api.moveMuralNote).toHaveBeenCalledTimes(1)
    expect(api.moveMuralNote).toHaveBeenNthCalledWith(1, id, {
      targetId: secondId, placement: 'after', expectedPosition: 3, expectedTargetPosition: 2,
    })

    // Drag 2 immediately while Drag 1 is still in flight (non-blocking queue!)
    vi.spyOn(firstTile, 'getBoundingClientRect').mockReturnValue({
      left: 268, right: 468, top: 0, bottom: 120, width: 200, height: 120, x: 268, y: 0, toJSON() {},
    })
    dispatchPointer(firstTile, 'pointerdown', { clientX: 350, clientY: 50 })
    dispatchPointer(window, 'pointermove', { clientX: 620, clientY: 50 })
    await nextFrame()
    await flushPromises()
    dispatchPointer(window, 'pointerup', { clientX: 620, clientY: 50 })
    await flushPromises()

    // Second request waits for first to settle so expectedPosition uses updated server positions
    expect(api.moveMuralNote).toHaveBeenCalledTimes(1)
    finishFirstMove()
    await flushPromises()

    expect(api.moveMuralNote).toHaveBeenCalledTimes(2)
    expect(api.moveMuralNote).toHaveBeenNthCalledWith(2, id, {
      targetId: thirdId, placement: 'after', expectedPosition: 2, expectedTargetPosition: 1,
    })
  })

  it('opens notes and image cards as color-matched Keep sheets without settings chrome', async () => {
    const coloredNote = { ...initial, color: 'ochre', title: 'Idea', body: 'Keep note' }
    const imageCardId = 'd'.repeat(32)
    const imageCard = { ...initial, id: imageCardId, kind: 'image', title: '', body: '', color: 'lavender', imageVersion: 'imgv1', position: 2 }

    api.listMuralCards.mockResolvedValue(board([
      { ...coloredNote, preview: coloredNote.body },
      imageCard,
    ]))
    api.readMuralNote
      .mockResolvedValueOnce({ note: coloredNote })
      .mockResolvedValueOnce({ note: imageCard })
    api.writeMuralNote.mockResolvedValueOnce({ note: { ...coloredNote, color: 'fern', revision: 2 } })

    wrapper = mount(MuralPanel)
    await flushPromises()

    await wrapper.get(`[data-card-id="${id}"]`).trigger('click')
    await flushPromises()

    const sheet = wrapper.get('[data-testid="mural-note-editor"]')
    expect(sheet.attributes('data-mural-color')).toBe('ochre')
    expect(sheet.attributes('style')).toContain('--mural-accent: var(--ayame-warning)')
    expect(sheet.find('fieldset').exists()).toBe(false)
    expect(sheet.find('legend').exists()).toBe(false)
    expect(sheet.text()).not.toContain('Move up')

    // Picking a new swatch updates the opened sheet color immediately
    await sheet.get('button[data-color="fern"]').trigger('click')
    expect(sheet.attributes('data-mural-color')).toBe('fern')
    expect(sheet.attributes('style')).toContain('--mural-accent: var(--ayame-success-accent)')

    await click(wrapper, 'Done')
    await flushPromises()

    // Standalone image card opens as a clean image viewer with caption input and matching color
    await wrapper.get(`[data-card-id="${imageCardId}"]`).trigger('click')
    await flushPromises()
    const imgSheet = wrapper.get('[data-testid="mural-note-editor"]')
    expect(imgSheet.classes()).toContain('mural-sheet--image-only')
    expect(imgSheet.attributes('data-mural-color')).toBe('lavender')
    expect(imgSheet.get('[data-testid="mural-note-title"]').attributes('placeholder')).toBe('Add a caption…')
    expect(imgSheet.find('[data-testid="mural-note-body"]').exists()).toBe(false)
  })
})
