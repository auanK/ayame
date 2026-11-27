export const muralNoteCacheKey = Symbol('Ayame mural note cache')

const MAX_NOTES = 32
const MAX_AGE_MS = 30_000

export function createMuralNoteCache() {
  const notes = new Map()

  return {
    get(id) {
      const entry = notes.get(id)
      if (!entry) return null
      notes.delete(id)
      notes.set(id, entry)
      return { note: entry.note, fresh: Date.now() - entry.checkedAt < MAX_AGE_MS }
    },
    put(note) {
      notes.delete(note.id)
      notes.set(note.id, { note, checkedAt: Date.now() })
      if (notes.size > MAX_NOTES) notes.delete(notes.keys().next().value)
    },
    updatePosition(id, position) {
      const entry = notes.get(id)
      if (entry) entry.note = { ...entry.note, position }
    },
    invalidate(id) {
      notes.delete(id)
    },
    clear() {
      notes.clear()
    },
  }
}
