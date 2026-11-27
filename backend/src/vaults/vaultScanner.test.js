import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { createVaultScanner } from './vaultScanner.js'

test('shares in-progress scans and starts a new snapshot after invalidation', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-scanner-'))
  const directory = path.join(root, 'notes')
  fs.mkdirSync(directory)
  const file = path.join(directory, 'A.md')
  const renamed = path.join(directory, 'B.md')
  fs.writeFileSync(file, 'Original')
  const scanner = createVaultScanner(root)
  t.after(async () => {
    await scanner.close()
    fs.rmSync(file, { force: true })
    fs.rmSync(renamed, { force: true })
    fs.rmdirSync(directory)
    fs.rmdirSync(root)
  })

  const first = scanner.scan('notes')
  assert.equal(scanner.scan('notes'), first)
  scanner.invalidate()
  const second = scanner.scan('notes')
  assert.notEqual(second, first)
  const original = (await first).notes[0]
  assert.equal(Object.hasOwn(original, 'content'), false)
  assert.equal(original.metadata.title, 'A')
  assert.deepEqual((await second).notes[0], original)
  assert.equal((await scanner.search('notes', 'Original'))[0].path, 'A.md')

  fs.writeFileSync(file, 'Different')
  assert.notEqual((await scanner.scan('notes')).notes[0].revision, original.revision)
  assert.deepEqual(await scanner.search('notes', 'Original'), [])
  assert.equal((await scanner.search('notes', 'Different'))[0].path, 'A.md')
  fs.renameSync(file, renamed)
  assert.deepEqual((await scanner.scan('notes')).files, ['B.md'])
  assert.deepEqual((await scanner.search('notes', 'Different')).map(({ path }) => path), ['B.md'])
  const { stats } = await scanner.scan()
  assert.equal(stats.get('notes').noteCount, 1)
})
