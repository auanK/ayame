export const noteCacheKey = Symbol('Ayame note cache')

const keyFor = (directory, path) => JSON.stringify([directory, path])

export function createNoteCache(fetchNote, { maxNotes = 32, maxBytes = 8 * 1024 * 1024, maxAgeMs = 30_000 } = {}) {
  const notes = new Map()
  const reads = new Map()
  let bytes = 0

  function remove(key) {
    const entry = notes.get(key)
    if (!entry) return
    bytes -= entry.note.content.length * 2
    notes.delete(key)
  }

  function store(key, note, checkedAt = Date.now()) {
    remove(key)
    if (typeof note.content !== 'string' || !note.revision) return
    const size = note.content.length * 2
    if (size > maxBytes || maxNotes < 1) return
    notes.set(key, { note, checkedAt })
    bytes += size
    while (notes.size > maxNotes || bytes > maxBytes) {
      remove(notes.keys().next().value)
    }
  }

  function get(directory, path) {
    const key = keyFor(directory, path)
    const entry = notes.get(key)
    if (!entry) return null
    notes.delete(key)
    notes.set(key, entry)
    return entry.note
  }

  function put(directory, path, { content, revision }, { checkedAt } = {}) {
    const key = keyFor(directory, path)
    reads.delete(key)
    store(key, { directory, path, content, revision }, checkedAt)
  }

  function read(directory, path, { fresh = false } = {}) {
    const key = keyFor(directory, path)
    const pending = reads.get(key)
    if (pending && !fresh) return pending.promise
    const cached = notes.get(key)
    if (!fresh && cached && Date.now() - cached.checkedAt < maxAgeMs) {
      return Promise.resolve(get(directory, path))
    }

    const request = { directory, path }
    const checkCurrent = () => {
      if (reads.get(key) === request) return
      throw Object.assign(new Error('Note read was superseded'), { code: 'NOTE_READ_SUPERSEDED' })
    }

    request.promise = Promise.resolve()
      .then(() => {
        checkCurrent()
        return fetchNote(directory, path)
      })
      .then((note) => {
        checkCurrent()
        if (note?.directory === directory && note.path === path) store(key, note)
        return note
      }, (error) => {
        checkCurrent()
        if (error?.code === 'VAULT_PATH_NOT_FOUND') remove(key)
        throw error
      })
      .finally(() => {
        if (reads.get(key) === request) reads.delete(key)
      })
    reads.set(key, request)
    return request.promise
  }

  function invalidate(directory, path = '') {
    const matches = (note) => note.directory === directory &&
      (!path || note.path === path || note.path.startsWith(`${path}/`))
    for (const [key, { note }] of notes) {
      if (matches(note)) remove(key)
    }
    for (const [key, note] of reads) {
      if (matches(note)) reads.delete(key)
    }
  }

  function clear() {
    notes.clear()
    reads.clear()
    bytes = 0
  }

  return { get, put, read, invalidate, clear }
}
