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
  fs.writeFileSync(file, 'Original')
  const scanner = createVaultScanner(root)
  t.after(async () => {
    await scanner.close()
    fs.unlinkSync(file)
    fs.rmdirSync(directory)
    fs.rmdirSync(root)
  })

  const first = scanner.scan('notes')
  assert.equal(scanner.scan('notes'), first)
  scanner.invalidate()
  const second = scanner.scan('notes')
  assert.notEqual(second, first)
  assert.equal((await first).notes[0].content, 'Original')
  assert.equal((await second).notes[0].content, 'Original')

  fs.writeFileSync(file, 'External change')
  assert.equal((await scanner.scan('notes')).notes[0].content, 'External change')
  const { stats } = await scanner.scan()
  assert.equal(stats.get('notes').noteCount, 1)
})
