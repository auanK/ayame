import { expect, it, vi } from 'vitest'
import { createNoteCache } from './noteCache.js'

const document = (directory, path, content = 'text') => ({ directory, path, content, revision: content })

it('shares an in-flight read per vault and path and keeps the most recently opened notes', async () => {
  const fetchNote = vi.fn(async (directory, path) => document(directory, path))
  const cache = createNoteCache(fetchNote, { maxNotes: 2 })
  const first = cache.read('Vault', 'A.md')
  expect(cache.read('Vault', 'A.md')).toBe(first)
  await first
  await cache.read('Other', 'A.md')
  expect(cache.get('Vault', 'A.md')).toEqual(document('Vault', 'A.md'))
  await cache.read('Vault', 'B.md')
  expect(cache.get('Other', 'A.md')).toBeNull()
  expect(cache.get('Vault', 'A.md')).toEqual(document('Vault', 'A.md'))
  expect(fetchNote).toHaveBeenCalledTimes(3)
})

it.each(['saved', 'moved', 'logout'])('discards a response superseded by %s', async (event) => {
  let finish
  const cache = createNoteCache(() => new Promise((resolve) => { finish = resolve }))
  const read = cache.read('Vault', 'Folder/A.md')
  await Promise.resolve()
  if (event === 'saved') cache.put('Vault', 'Folder/A.md', document('Vault', 'Folder/A.md', 'saved'))
  if (event === 'moved') cache.invalidate('Vault', 'Folder')
  if (event === 'logout') cache.clear()
  finish(document('Vault', 'Folder/A.md', 'previous'))
  await expect(read).rejects.toMatchObject({ code: 'NOTE_READ_SUPERSEDED' })
  expect(cache.get('Vault', 'Folder/A.md')?.content ?? null).toBe(event === 'saved' ? 'saved' : null)
})
