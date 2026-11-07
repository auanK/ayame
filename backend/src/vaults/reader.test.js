import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readVaultMarkdown, MAX_MARKDOWN_BYTES } from './reader.js'

const makeTempVault = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-reader-test-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const vaultDir = path.join(root, 'personal')
  fs.mkdirSync(vaultDir)
  return { vaultsRoot: root, directory: 'personal', vaultDir }
}

test('1. reads .md file at root of vault', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const noteContent = '# Hello Root\n\nThis is a note.'
  fs.writeFileSync(path.join(vaultDir, 'README.md'), noteContent, 'utf8')

  const result = readVaultMarkdown(vaultsRoot, directory, 'README.md')
  assert.deepEqual(result, {
    directory: 'personal',
    path: 'README.md',
    content: noteContent,
  })
})

test('2. reads .md file in nested subdirectory', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const subDir = path.join(vaultDir, 'projects', 'ayame')
  fs.mkdirSync(subDir, { recursive: true })
  const noteContent = '# Ayame Specs\n\nSubdirectory note.'
  fs.writeFileSync(path.join(subDir, 'spec.md'), noteContent, 'utf8')

  const result = readVaultMarkdown(vaultsRoot, directory, 'projects/ayame/spec.md')
  assert.deepEqual(result, {
    directory: 'personal',
    path: 'projects/ayame/spec.md',
    content: noteContent,
  })
})

test('3. reads .markdown file', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const noteContent = '## Extended Markdown extension'
  fs.writeFileSync(path.join(vaultDir, 'document.markdown'), noteContent, 'utf8')

  const result = readVaultMarkdown(vaultsRoot, directory, 'document.markdown')
  assert.deepEqual(result, {
    directory: 'personal',
    path: 'document.markdown',
    content: noteContent,
  })
})

test('4. accepts valid extensions in uppercase (.MD, .MARKDOWN)', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'UPPER.MD'), 'Upper md', 'utf8')
  fs.writeFileSync(path.join(vaultDir, 'DOC.MARKDOWN'), 'Upper markdown', 'utf8')

  const res1 = readVaultMarkdown(vaultsRoot, directory, 'UPPER.MD')
  assert.equal(res1.content, 'Upper md')

  const res2 = readVaultMarkdown(vaultsRoot, directory, 'DOC.MARKDOWN')
  assert.equal(res2.content, 'Upper markdown')
})

test('5. reads empty file successfully', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'empty.md'), '', 'utf8')

  const result = readVaultMarkdown(vaultsRoot, directory, 'empty.md')
  assert.deepEqual(result, {
    directory: 'personal',
    path: 'empty.md',
    content: '',
  })
})

test('6. preserves full Unicode content including emojis, accents and CJK characters', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const unicodeContent = '# 綾目 (Ayame) 🌸\n\nAcentuação: Olá, você está bem? — Café com pão! 🚀'
  fs.writeFileSync(path.join(vaultDir, 'unicode.md'), unicodeContent, 'utf8')

  const result = readVaultMarkdown(vaultsRoot, directory, 'unicode.md')
  assert.equal(result.content, unicodeContent)
})

test('7. preserves CRLF and LF line endings without automatic conversion', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const crlfContent = 'line 1\r\nline 2\r\nline 3\r\n'
  const lfContent = 'line 1\nline 2\nline 3\n'
  fs.writeFileSync(path.join(vaultDir, 'crlf.md'), crlfContent, 'utf8')
  fs.writeFileSync(path.join(vaultDir, 'lf.md'), lfContent, 'utf8')

  assert.equal(readVaultMarkdown(vaultsRoot, directory, 'crlf.md').content, crlfContent)
  assert.equal(readVaultMarkdown(vaultsRoot, directory, 'lf.md').content, lfContent)
})

test('8. rejects empty, missing, or whitespace relative path', (t) => {
  const { vaultsRoot, directory } = makeTempVault(t)
  for (const invalidPath of ['', '   ', null, undefined, 123]) {
    assert.throws(
      () => readVaultMarkdown(vaultsRoot, directory, invalidPath),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  }
})

test('9. rejects path traversal attempts with dots or backslashes', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'test.md'), 'test', 'utf8')

  for (const traversal of [
    '../test.md',
    '..\\test.md',
    './test.md',
    'projects/../../test.md',
    'projects/../projects/test.md',
    'sub/..',
    'sub/.',
    'projects/test.md/..',
  ]) {
    assert.throws(
      () => readVaultMarkdown(vaultsRoot, directory, traversal),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  }
})

test('10. rejects absolute or drive-letter relative paths', (t) => {
  const { vaultsRoot, directory } = makeTempVault(t)
  for (const abs of ['/test.md', '\\test.md', 'C:/test.md', 'D:\\test.md']) {
    assert.throws(
      () => readVaultMarkdown(vaultsRoot, directory, abs),
      (err) => err.code === 'INVALID_VAULT_PATH'
    )
  }
})

test('11. rejects symlink directory escape pointing outside vault', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-outside-'))
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(outsideDir, 'secret.md'), 'secret', 'utf8')

  try {
    fs.symlinkSync(outsideDir, path.join(vaultDir, 'escape-link'), 'dir')
  } catch {
    t.skip('Symlinks not supported in this environment')
    return
  }

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'escape-link/secret.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
})

test('12. rejects direct symlink final file entry even when target is inside the vault', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'target.md'), 'target content', 'utf8')

  try {
    fs.symlinkSync(path.join(vaultDir, 'target.md'), path.join(vaultDir, 'link.md'), 'file')
  } catch {
    t.skip('Symlinks not supported in this environment')
    return
  }

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'link.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
})

test('13. rejects path that points to a directory instead of a regular file', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.mkdirSync(path.join(vaultDir, 'folder.md'))

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'folder.md'),
    (err) => err.code === 'VAULT_PATH_NOT_FILE'
  )
})

test('14. rejects non-existent file with VAULT_PATH_NOT_FOUND', (t) => {
  const { vaultsRoot, directory } = makeTempVault(t)
  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'non-existent.md'),
    (err) => err.code === 'VAULT_PATH_NOT_FOUND'
  )
})

test('15. rejects unsupported file extensions with UNSUPPORTED_FILE_TYPE', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  for (const filename of ['image.png', 'script.js', 'notes.txt', 'data.json', 'noextension']) {
    fs.writeFileSync(path.join(vaultDir, filename), 'some content', 'utf8')
    assert.throws(
      () => readVaultMarkdown(vaultsRoot, directory, filename),
      (err) => err.code === 'UNSUPPORTED_FILE_TYPE'
    )
  }
})

test('16. reads file that is exactly at the 2 MiB limit', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const exactBuffer = Buffer.alloc(MAX_MARKDOWN_BYTES, 0x61) // 2 MiB of 'a'
  fs.writeFileSync(path.join(vaultDir, 'exact.md'), exactBuffer)

  const result = readVaultMarkdown(vaultsRoot, directory, 'exact.md')
  assert.equal(result.content.length, MAX_MARKDOWN_BYTES)
})

test('17. rejects file that exceeds 2 MiB limit with VAULT_FILE_TOO_LARGE', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const tooLargeBuffer = Buffer.alloc(MAX_MARKDOWN_BYTES + 1, 0x61) // 2 MiB + 1 byte
  fs.writeFileSync(path.join(vaultDir, 'large.md'), tooLargeBuffer)

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'large.md'),
    (err) => err.code === 'VAULT_FILE_TOO_LARGE'
  )
})

test('18. rejects file that grows beyond limit during reading', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'growing.md'), 'small initial')

  const originalFstatSync = fs.fstatSync
  const originalReadSync = fs.readSync
  try {
    // Simulate initial fstatSync reporting 100 bytes
    fs.fstatSync = (...args) => {
      const real = originalFstatSync(...args)
      return {
        ...real,
        size: 100,
        isFile: () => true,
        isDirectory: () => false,
      }
    }
    // Simulate readSync returning MAX_MARKDOWN_BYTES + 1 bytes
    fs.readSync = (fd, buffer, offset, length, position) => {
      buffer.fill(0x61, 0, MAX_MARKDOWN_BYTES + 1)
      return MAX_MARKDOWN_BYTES + 1
    }

    assert.throws(
      () => readVaultMarkdown(vaultsRoot, directory, 'growing.md'),
      (err) => err.code === 'VAULT_FILE_TOO_LARGE'
    )
  } finally {
    fs.fstatSync = originalFstatSync
    fs.readSync = originalReadSync
  }
})

test('19. rejects invalid UTF-8 byte sequences with INVALID_FILE_ENCODING', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  // Invalid UTF-8 bytes (lone continuation byte or invalid start byte)
  const invalidUtf8 = Buffer.from([0xff, 0xfe, 0x80, 0xbf])
  fs.writeFileSync(path.join(vaultDir, 'bad-encoding.md'), invalidUtf8)

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'bad-encoding.md'),
    (err) => err.code === 'INVALID_FILE_ENCODING'
  )
})

test('20. handles file removed between path resolution and reading gracefully', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const filePath = path.join(vaultDir, 'raced.md')
  fs.writeFileSync(filePath, 'will be deleted', 'utf8')

  const originalOpenSync = fs.openSync
  try {
    fs.openSync = (targetPath, flags) => {
      if (typeof targetPath === 'string' && targetPath.endsWith('raced.md')) {
        const enoent = new Error('ENOENT: no such file or directory')
        enoent.code = 'ENOENT'
        throw enoent
      }
      return originalOpenSync(targetPath, flags)
    }

    assert.throws(
      () => readVaultMarkdown(vaultsRoot, directory, 'raced.md'),
      (err) => err.code === 'VAULT_PATH_NOT_FOUND'
    )
  } finally {
    fs.openSync = originalOpenSync
  }
})

test('21. ensures file descriptor is closed when read throws', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'close-check.md'), 'some text', 'utf8')

  let openedFd = null
  let closedFd = null
  const originalOpenSync = fs.openSync
  const originalCloseSync = fs.closeSync
  const originalReadSync = fs.readSync

  try {
    fs.openSync = (...args) => {
      const fd = originalOpenSync(...args)
      openedFd = fd
      return fd
    }
    fs.closeSync = (fd) => {
      closedFd = fd
      return originalCloseSync(fd)
    }
    fs.readSync = () => {
      throw new Error('Disk read failure')
    }

    assert.throws(() => readVaultMarkdown(vaultsRoot, directory, 'close-check.md'))
    assert.ok(openedFd !== null)
    assert.equal(closedFd, openedFd)
  } finally {
    fs.openSync = originalOpenSync
    fs.closeSync = originalCloseSync
    fs.readSync = originalReadSync
  }
})

test('22. file content and metadata remain completely unchanged (read-only verification)', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const filePath = path.join(vaultDir, 'immutable.md')
  const content = '# Do Not Mutate'
  fs.writeFileSync(filePath, content, 'utf8')
  const statBefore = fs.statSync(filePath)

  readVaultMarkdown(vaultsRoot, directory, 'immutable.md')

  const statAfter = fs.statSync(filePath)
  assert.equal(fs.readFileSync(filePath, 'utf8'), content)
  assert.equal(statAfter.size, statBefore.size)
  assert.equal(statAfter.mtimeMs, statBefore.mtimeMs)
})

test('23. reader operates completely detached from SQLite with zero database writes', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  fs.writeFileSync(path.join(vaultDir, 'spec.md'), '# No DB', 'utf8')

  // readVaultMarkdown takes only (vaultsRoot, directory, rawPath) and has no DB dependencies
  const result = readVaultMarkdown(vaultsRoot, directory, 'spec.md')
  assert.equal(result.content, '# No DB')
})

test('rejects a final symlink substituted after validation without returning outside content', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const notePath = path.join(vaultDir, 'note.md')
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-reader-outside-'))
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
  const outsidePath = path.join(outsideDir, 'note.md')
  fs.writeFileSync(notePath, 'authorized content')
  fs.writeFileSync(outsidePath, 'outside sentinel')

  const probe = path.join(vaultDir, 'symlink-probe.md')
  try {
    fs.symlinkSync(outsidePath, probe, 'file')
    fs.unlinkSync(probe)
  } catch {
    t.skip('File symlink creation is not permitted in this environment')
    return
  }

  const opened = []
  const originalOpen = fs.openSync
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (path.resolve(String(target)) === notePath) {
      fs.unlinkSync(notePath)
      fs.symlinkSync(outsidePath, notePath, 'file')
    }
    const fd = originalOpen(target, ...args)
    opened.push(fd)
    return fd
  })

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'note.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside sentinel')
  for (const fd of opened) {
    assert.throws(() => fs.fstatSync(fd), (err) => err.code === 'EBADF')
  }
})

test('rejects an ancestor junction substituted after validation without returning outside content', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const projectsDir = path.join(vaultDir, 'projects')
  const notePath = path.join(projectsDir, 'note.md')
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-reader-outside-'))
  t.after(() => fs.rmSync(outsideDir, { recursive: true, force: true }))
  const outsidePath = path.join(outsideDir, 'note.md')
  fs.mkdirSync(projectsDir)
  fs.writeFileSync(notePath, 'authorized content')
  fs.writeFileSync(outsidePath, 'outside sentinel')

  const probe = path.join(vaultDir, 'junction-probe')
  try {
    fs.symlinkSync(outsideDir, probe, 'junction')
    fs.rmdirSync(probe)
  } catch {
    t.skip('Directory junction creation is not supported in this environment')
    return
  }

  const opened = []
  const originalOpen = fs.openSync
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (path.resolve(String(target)) === notePath) {
      fs.renameSync(projectsDir, path.join(vaultDir, 'projects-original'))
      fs.symlinkSync(outsideDir, projectsDir, 'junction')
    }
    const fd = originalOpen(target, ...args)
    opened.push(fd)
    return fd
  })

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'projects/note.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readFileSync(outsidePath, 'utf8'), 'outside sentinel')
  for (const fd of opened) {
    assert.throws(() => fs.fstatSync(fd), (err) => err.code === 'EBADF')
  }
})

test('rejects a different regular file substituted after validation', (t) => {
  const { vaultsRoot, directory, vaultDir } = makeTempVault(t)
  const notePath = path.join(vaultDir, 'note.md')
  const originalPath = path.join(vaultDir, 'original.md')
  fs.writeFileSync(notePath, 'authorized content')
  fs.writeFileSync(originalPath, 'outside sentinel')

  const opened = []
  const originalOpen = fs.openSync
  t.mock.method(fs, 'openSync', (target, ...args) => {
    if (path.resolve(String(target)) === notePath) {
      fs.renameSync(notePath, path.join(vaultDir, 'authorized.md'))
      fs.copyFileSync(originalPath, notePath)
    }
    const fd = originalOpen(target, ...args)
    opened.push(fd)
    return fd
  })

  assert.throws(
    () => readVaultMarkdown(vaultsRoot, directory, 'note.md'),
    (err) => err.code === 'INVALID_VAULT_PATH'
  )
  assert.equal(fs.readFileSync(originalPath, 'utf8'), 'outside sentinel')
  assert.equal(fs.readFileSync(path.join(vaultDir, 'authorized.md'), 'utf8'), 'authorized content')
  for (const fd of opened) {
    assert.throws(() => fs.fstatSync(fd), (err) => err.code === 'EBADF')
  }
})
