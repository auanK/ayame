import assert from 'node:assert/strict'
import test from 'node:test'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MAX_MARKDOWN_BYTES, readVaultMarkdown } from './reader.js'
import { saveVaultMarkdown } from './writer.js'

const revisionOf = (content) => crypto.createHash('sha256').update(Buffer.from(content, 'utf8')).digest('hex')

const makeNote = (t, content = 'original') => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-writer-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vault = path.join(root, 'personal')
  fs.mkdirSync(vault)
  const note = path.join(vault, 'note.md')
  fs.writeFileSync(note, content, 'utf8')
  return { root, vault, note }
}

const save = (root, content, expectedRevision, relativePath = 'note.md') =>
  saveVaultMarkdown(root, 'personal', relativePath, { content, expectedRevision })

test('saves existing Markdown and returns the revision of the written bytes', (t) => {
  const { root, note, vault } = makeNote(t, 'before')
  const content = '# Saved\r\nAcentuação 🌸\n'
  const result = save(root, content, revisionOf('before'))

  assert.deepEqual(result, {
    directory: 'personal',
    path: 'note.md',
    revision: revisionOf(content),
  })
  assert.equal(fs.readFileSync(note, 'utf8'), content)
  assert.equal(readVaultMarkdown(root, 'personal', 'note.md').revision, result.revision)
  assert.equal(fs.existsSync(path.join(vault, '.note.md.ayame.lock')), false)
})

test('saves empty content and allows exactly the UTF-8 byte limit', (t) => {
  const { root, note } = makeNote(t, 'initial')
  const empty = save(root, '', revisionOf('initial'))
  assert.equal(fs.readFileSync(note, 'utf8'), '')
  assert.equal(empty.revision, revisionOf(''))

  const content = 'x'.repeat(MAX_MARKDOWN_BYTES)
  const exact = save(root, content, empty.revision)
  assert.equal(fs.statSync(note).size, MAX_MARKDOWN_BYTES)
  assert.equal(exact.revision, revisionOf(content))
})

test('rejects stale revisions without modifying the external version', (t) => {
  const { root, note } = makeNote(t, 'version A')
  fs.writeFileSync(note, 'version B')

  assert.throws(
    () => save(root, 'version C', revisionOf('version A')),
    (err) => err.code === 'VAULT_FILE_CONFLICT'
  )
  assert.equal(fs.readFileSync(note, 'utf8'), 'version B')
})

test('rejects invalid payload, revision, path, unsupported type, and oversized UTF-8 before writing', (t) => {
  const { root, note } = makeNote(t)
  for (const payload of [undefined, null, [], { content: 1, expectedRevision: revisionOf('original') }, { content: 'x' }, { content: 'x', expectedRevision: 'bad' }]) {
    assert.throws(() => saveVaultMarkdown(root, 'personal', 'note.md', payload))
  }
  assert.throws(() => save(root, 'x', revisionOf('original'), '../note.md'), (err) => err.code === 'INVALID_VAULT_PATH')
  assert.throws(() => save(root, 'x', revisionOf('original'), 'image.png'), (err) => err.code === 'UNSUPPORTED_FILE_TYPE')
  assert.throws(() => save(root, '🌸'.repeat(MAX_MARKDOWN_BYTES), revisionOf('original')), (err) => err.code === 'VAULT_FILE_TOO_LARGE')
  assert.throws(() => save(root, '\ud800', revisionOf('original')), (err) => err.code === 'INVALID_MARKDOWN_CONTENT')
  assert.throws(() => save(root, 'x', revisionOf('original'), 'missing.md'), (err) => err.code === 'VAULT_PATH_NOT_FOUND')
  assert.throws(() => saveVaultMarkdown(root, 'missing', 'note.md', { content: 'x', expectedRevision: revisionOf('original') }), (err) => err.code === 'INVALID_VAULT_DIRECTORY')
  const invalidEncoding = path.join(path.dirname(note), 'invalid-encoding.md')
  const invalidBytes = Buffer.from([0xff, 0xfe])
  fs.writeFileSync(invalidEncoding, invalidBytes)
  assert.throws(
    () => save(root, 'valid replacement', revisionOf(invalidBytes), 'invalid-encoding.md'),
    (err) => err.code === 'INVALID_FILE_ENCODING'
  )
  assert.deepEqual(fs.readFileSync(invalidEncoding), invalidBytes)
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
})

test('two saves based on one revision allow only one commit', async (t) => {
  const { root, note } = makeNote(t)
  const expectedRevision = revisionOf('original')
  const results = await Promise.allSettled([
    Promise.resolve().then(() => save(root, 'first', expectedRevision)),
    Promise.resolve().then(() => save(root, 'second', expectedRevision)),
  ])

  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1)
  assert.equal(results.filter((item) => item.status === 'rejected' && item.reason.code === 'VAULT_FILE_CONFLICT').length, 1)
  assert.ok(['first', 'second'].includes(fs.readFileSync(note, 'utf8')))
})

test('a repeated request with an old revision conflicts after the first commit', (t) => {
  const { root, note } = makeNote(t)
  const first = save(root, 'committed', revisionOf('original'))
  assert.throws(
    () => save(root, 'committed', revisionOf('original')),
    (err) => err.code === 'VAULT_FILE_CONFLICT'
  )
  assert.equal(fs.readFileSync(note, 'utf8'), 'committed')
  assert.equal(first.revision, revisionOf('committed'))
})

test('same-file contention during a save fails closed with one commit', (t) => {
  const { root, note } = makeNote(t)
  const originalWrite = fs.writeSync
  let contended = false
  t.mock.method(fs, 'writeSync', (...args) => {
    if (!contended) {
      contended = true
      assert.throws(
        () => save(root, 'second writer', revisionOf('original')),
        (err) => err.code === 'VAULT_FILE_LOCKED'
      )
    }
    return originalWrite(...args)
  })

  assert.equal(save(root, 'first writer', revisionOf('original')).revision, revisionOf('first writer'))
  assert.equal(fs.readFileSync(note, 'utf8'), 'first writer')
})

test('saves on different files do not share one global lock', (t) => {
  const { root, vault } = makeNote(t)
  const secondPath = path.join(vault, 'second.md')
  fs.writeFileSync(secondPath, 'other')
  const originalWrite = fs.writeSync
  let nestedSaveStarted = false
  let secondResult
  t.mock.method(fs, 'writeSync', (...args) => {
    if (!nestedSaveStarted) {
      nestedSaveStarted = true
      secondResult = save(root, 'two', revisionOf('other'), 'second.md')
    }
    return originalWrite(...args)
  })

  assert.equal(save(root, 'one', revisionOf('original')).revision, revisionOf('one'))
  assert.equal(secondResult.revision, revisionOf('two'))
  assert.equal(fs.readFileSync(secondPath, 'utf8'), 'two')
})

test('saves existing .markdown files without changing their exact line endings', (t) => {
  const { root, vault } = makeNote(t)
  const note = path.join(vault, 'legacy.MARKDOWN')
  fs.writeFileSync(note, 'one\r\ntwo\n')
  const result = save(root, 'one\r\nupdated\n', revisionOf('one\r\ntwo\n'), 'legacy.MARKDOWN')
  assert.equal(fs.readFileSync(note, 'utf8'), 'one\r\nupdated\n')
  assert.equal(result.revision, revisionOf('one\r\nupdated\n'))
})

test('an existing lock fails closed and is not removed', (t) => {
  const { root, vault, note } = makeNote(t)
  const lockPath = path.join(vault, '.note.md.ayame.lock')
  fs.writeFileSync(lockPath, 'held by another operation')

  assert.throws(() => save(root, 'next', revisionOf('original')), (err) => err.code === 'VAULT_FILE_LOCKED')
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
  assert.equal(fs.readFileSync(lockPath, 'utf8'), 'held by another operation')
})

test('partial temporary write failure preserves the original and removes its temporary file', (t) => {
  const { root, note, vault } = makeNote(t)
  const originalWrite = fs.writeSync
  let wrotePart = false
  t.mock.method(fs, 'writeSync', (fd, buffer, offset, length, position) => {
    if (!wrotePart) {
      wrotePart = true
      return originalWrite(fd, buffer, offset, Math.min(2, length), position)
    }
    const err = new Error('injected partial write failure')
    err.code = 'EIO'
    throw err
  })

  assert.throws(() => save(root, 'new content', revisionOf('original')), (err) => err.code === 'VAULT_SAVE_FAILED')
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
  assert.equal(fs.readdirSync(vault).some((name) => name.endsWith('.tmp')), false)
})

test('temporary-file creation failure preserves the original and releases its lock', (t) => {
  const { root, note, vault } = makeNote(t)
  const originalOpen = fs.openSync
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (String(target).includes('.ayame-') && String(target).endsWith('.tmp')) {
      const err = new Error('injected temporary creation failure')
      err.code = 'ENOSPC'
      throw err
    }
    return originalOpen(target, ...args)
  })

  assert.throws(() => save(root, 'new content', revisionOf('original')), (err) => err.code === 'VAULT_SAVE_FAILED')
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
  assert.equal(fs.existsSync(path.join(vault, '.note.md.ayame.lock')), false)
  assert.equal(fs.readdirSync(vault).some((name) => name.endsWith('.tmp')), false)
})

test('temporary cleanup failure preserves the original and never removes an unowned path', (t) => {
  const { root, note, vault } = makeNote(t)
  const originalUnlink = fs.unlinkSync
  t.mock.method(fs, 'writeSync', () => {
    const err = new Error('injected write failure')
    err.code = 'EIO'
    throw err
  })
  t.mock.method(fs, 'unlinkSync', (target) => {
    if (String(target).endsWith('.tmp')) {
      const err = new Error('injected cleanup failure')
      err.code = 'EIO'
      throw err
    }
    return originalUnlink(target)
  })

  assert.throws(() => save(root, 'new content', revisionOf('original')), (err) => err.code === 'VAULT_SAVE_FAILED')
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
  const temporary = fs.readdirSync(vault).find((name) => name.endsWith('.tmp'))
  assert.ok(temporary)
  fs.rmSync(path.join(vault, temporary), { force: true })
})

test('pre-commit fsync and rename failures preserve the original', (t) => {
  const { root, note } = makeNote(t)
  t.mock.method(fs, 'fsyncSync', () => {
    const err = new Error('injected fsync failure')
    err.code = 'EIO'
    throw err
  })
  assert.throws(() => save(root, 'sync failure', revisionOf('original')), (err) => err.code === 'VAULT_SAVE_FAILED')
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
  t.mock.restoreAll()

  t.mock.method(fs, 'renameSync', () => {
    const err = new Error('injected rename failure')
    err.code = 'EACCES'
    throw err
  })
  assert.throws(() => save(root, 'rename failure', revisionOf('original')), (err) => err.code === 'VAULT_SAVE_FAILED')
  assert.equal(fs.readFileSync(note, 'utf8'), 'original')
})

test('a failure confirming the replacement returns an uncertain result', (t) => {
  const { root, note } = makeNote(t)
  const originalRename = fs.renameSync
  const originalRead = fs.readSync
  let renamed = false
  t.mock.method(fs, 'renameSync', (...args) => {
    const result = originalRename(...args)
    renamed = true
    return result
  })
  t.mock.method(fs, 'readSync', (...args) => {
    if (renamed) {
      const err = new Error('injected readback failure')
      err.code = 'EIO'
      throw err
    }
    return originalRead(...args)
  })

  assert.throws(() => save(root, 'committed content', revisionOf('original')), (err) => err.code === 'VAULT_SAVE_RESULT_UNKNOWN')
  assert.equal(fs.readFileSync(note, 'utf8'), 'committed content')
})

test('preserves the original file permission bits', (t) => {
  const { root, note } = makeNote(t)
  fs.chmodSync(note, 0o640)
  const before = fs.statSync(note).mode & 0o777

  save(root, 'updated', revisionOf('original'))

  assert.equal(fs.statSync(note).mode & 0o777, before)
})

test('rejects an ancestor junction that resolves outside the vault', (t) => {
  const { root, vault } = makeNote(t)
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-writer-outside-'))
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }))
  const outsideNote = path.join(outside, 'secret.md')
  fs.writeFileSync(outsideNote, 'secret')
  try {
    fs.symlinkSync(outside, path.join(vault, 'escape'), 'junction')
  } catch {
    t.skip('Directory junction creation is not supported in this environment')
    return
  }

  assert.throws(
    () => save(root, 'must not escape', revisionOf('secret'), 'escape/secret.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readFileSync(outsideNote, 'utf8'), 'secret')
})

test('rejects a final file symlink when the platform permits creating one', (t) => {
  const { root, vault } = makeNote(t)
  const target = path.join(vault, 'target.md')
  const link = path.join(vault, 'link.md')
  fs.writeFileSync(target, 'target')
  try {
    fs.symlinkSync(target, link, 'file')
  } catch {
    t.skip('File symlink creation is not permitted in this environment')
    return
  }
  assert.throws(
    () => save(root, 'replacement', revisionOf('target'), 'link.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readFileSync(target, 'utf8'), 'target')
})

test('rejects a regular destination replaced during temporary writing', (t) => {
  const { root, note, vault } = makeNote(t)
  const movedOriginal = path.join(vault, 'moved-original.md')
  const originalWrite = fs.writeSync
  let swapped = false
  t.mock.method(fs, 'writeSync', (...args) => {
    if (!swapped) {
      fs.renameSync(note, movedOriginal)
      fs.writeFileSync(note, 'external replacement')
      swapped = true
    }
    return originalWrite(...args)
  })

  assert.throws(
    () => save(root, 'local replacement', revisionOf('original')),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readFileSync(movedOriginal, 'utf8'), 'original')
  assert.equal(fs.readFileSync(note, 'utf8'), 'external replacement')
  assert.equal(fs.readdirSync(vault).some((name) => name.endsWith('.tmp')), false)
})
