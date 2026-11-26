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

it('reuses a recent document and revalidates once after expiry or on an explicit refresh', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
  const fetchNote = vi.fn(async (directory, path) => document(directory, path, String(Date.now())))
  const cache = createNoteCache(fetchNote, { maxAgeMs: 500 })
  try {
    const first = await cache.read('Vault', 'A.md')
    now.mockReturnValue(1_499)
    expect(await cache.read('Vault', 'A.md')).toBe(first)
    expect(fetchNote).toHaveBeenCalledTimes(1)

    now.mockReturnValue(1_500)
    const revalidation = cache.read('Vault', 'A.md')
    expect(cache.get('Vault', 'A.md')).toBe(first)
    expect(cache.read('Vault', 'A.md')).toBe(revalidation)
    expect((await revalidation).content).toBe('1500')
    expect(fetchNote).toHaveBeenCalledTimes(2)

    now.mockReturnValue(1_501)
    expect((await cache.read('Vault', 'A.md', { fresh: true })).content).toBe('1501')
    expect(fetchNote).toHaveBeenCalledTimes(3)
  } finally {
    now.mockRestore()
  }
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
