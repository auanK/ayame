import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import {
  MAX_MARKDOWN_BYTES,
  readVaultMarkdown,
  readVaultMarkdownBytes,
  resolveVaultMarkdownPath,
  verifyVaultMarkdownFile,
  verifyVaultMarkdownParent,
  withVaultMarkdownFile,
} from './reader.js'

const fail = (code, message) => {
  const err = new Error(message)
  err.code = code
  throw err
}

const revisionOf = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex')

const validateFileEncoding = (bytes) => {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    fail('INVALID_FILE_ENCODING', 'File content is not valid UTF-8')
  }
}

const identityOf = (stat) => {
  if (stat.dev === 0n || stat.ino === 0n) {
    fail('INVALID_VAULT_PATH', 'Cannot verify file identity on this filesystem')
  }
  return `${stat.dev}:${stat.ino}`
}

const sameParent = (left, right) => {
  const expected = left.snapshot.slice(0, -1)
  const actual = right.snapshot.slice(0, -1)
  return expected.length === actual.length && expected.every((stat, index) => identityOf(stat) === identityOf(actual[index]))
}

const validatePayload = (payload) => {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    typeof payload.content !== 'string' ||
    typeof payload.expectedRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(payload.expectedRevision)
  ) {
    fail('INVALID_MARKDOWN_PAYLOAD', 'Invalid Markdown save payload')
  }

  const size = Buffer.byteLength(payload.content, 'utf8')
  if (size > MAX_MARKDOWN_BYTES) {
    fail('VAULT_FILE_TOO_LARGE', 'Markdown content exceeds the 2 MiB limit')
  }

  const bytes = Buffer.from(payload.content, 'utf8')
  if (new TextDecoder('utf-8', { fatal: true }).decode(bytes) !== payload.content) {
    fail('INVALID_MARKDOWN_CONTENT', 'Markdown content contains an invalid Unicode sequence')
  }
  return { bytes, expectedRevision: payload.expectedRevision }
}

const saveError = () => Object.assign(new Error('Could not save Markdown file'), { code: 'VAULT_SAVE_FAILED' })
const unknownError = () => Object.assign(new Error('Markdown save result is uncertain'), { code: 'VAULT_SAVE_RESULT_UNKNOWN' })

const normalizeSaveError = (err) => {
  if ([
    'INVALID_VAULT_DIRECTORY',
    'INVALID_VAULT_PATH',
    'VAULT_PATH_NOT_FOUND',
    'VAULT_PATH_NOT_FILE',
    'UNSUPPORTED_FILE_TYPE',
    'VAULT_FILE_TOO_LARGE',
    'INVALID_FILE_ENCODING',
    'INVALID_MARKDOWN_CONTENT',
    'INVALID_MARKDOWN_PAYLOAD',
    'VAULT_FILE_CONFLICT',
    'VAULT_FILE_LOCKED',
    'VAULT_SAVE_FAILED',
    'VAULT_SAVE_RESULT_UNKNOWN',
  ].includes(err.code)) {
    return err
  }
  return saveError()
}

const acquireLock = (target) => {
  verifyVaultMarkdownParent(target)
  const lockPath = path.join(path.dirname(target.absolutePath), `.${path.basename(target.absolutePath)}.ayame.lock`)
  let fd
  try {
    fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
  } catch (err) {
    if (err.code === 'EEXIST' || err.code === 'EACCES' || err.code === 'EPERM') {
      fail('VAULT_FILE_LOCKED', 'Markdown file is locked or exclusive access is unavailable')
    }
    throw err
  }

  let lock
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile()) fail('VAULT_FILE_LOCKED', 'Markdown lock could not be verified')
    lock = { path: lockPath, fd, identity: identityOf(stat) }
    const pathStat = fs.lstatSync(lockPath, { bigint: true })
    if (pathStat.isSymbolicLink() || identityOf(pathStat) !== lock.identity) {
      fail('VAULT_FILE_LOCKED', 'Markdown lock changed during acquisition')
    }
    verifyVaultMarkdownParent(target)
    return lock
  } catch (err) {
    try {
      fs.closeSync(fd)
    } catch {}
    if (lock) {
      try {
        const entry = fs.lstatSync(lockPath, { bigint: true })
        if (entry.isFile() && !entry.isSymbolicLink() && identityOf(entry) === lock.identity) {
          fs.unlinkSync(lockPath)
        }
      } catch {}
    }
    throw err
  }
}

const releaseLock = (lock) => {
  let failure
  try {
    const opened = fs.fstatSync(lock.fd, { bigint: true })
    const entry = fs.lstatSync(lock.path, { bigint: true })
    if (!entry.isFile() || entry.isSymbolicLink() || identityOf(opened) !== lock.identity || identityOf(entry) !== lock.identity) {
      fail('VAULT_FILE_LOCKED', 'Markdown lock ownership changed')
    }
    fs.unlinkSync(lock.path)
  } catch (err) {
    failure = err
  }
  try {
    fs.closeSync(lock.fd)
  } catch (err) {
    failure ??= err
  }
  if (failure) throw failure
}

const removeOwnedTemporary = (tempPath, identity) => {
  if (!identity) return
  let stat
  try {
    stat = fs.lstatSync(tempPath, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') return
    throw err
  }
  if (stat.isSymbolicLink() || !stat.isFile() || identityOf(stat) !== identity) {
    fail('VAULT_SAVE_FAILED', 'Temporary file ownership changed')
  }
  fs.unlinkSync(tempPath)
}

const currentFileState = (vaultsRoot, directory, relativePath) =>
  withVaultMarkdownFile(vaultsRoot, directory, relativePath, (file) => ({
    revision: revisionOf(readVaultMarkdownBytes(file)),
    identity: file.identity,
  }))

const syncParentDirectory = (file) => {
  // shortcut: Node cannot fsync directories on Windows, upgrade when a supported directory-sync API is available.
  if (process.platform === 'win32') return
  const fd = fs.openSync(path.dirname(file.absolutePath), fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

const replaceFile = (file, { bytes, expectedRevision }, state) => {
  const currentBytes = readVaultMarkdownBytes(file)
  validateFileEncoding(currentBytes)
  const currentRevision = revisionOf(currentBytes)
  if (currentRevision !== expectedRevision) {
    fail('VAULT_FILE_CONFLICT', 'Markdown file changed since it was loaded')
  }
  if (currentBytes.equals(bytes)) {
    return { directory: file.directory, path: file.path, revision: currentRevision }
  }

  const originalStat = fs.fstatSync(file.fd, { bigint: true })
  const originalMode = Number(originalStat.mode & 0o777n)
  const tempPath = path.join(
    path.dirname(file.absolutePath),
    `.${path.basename(file.absolutePath)}.ayame-${crypto.randomBytes(16).toString('hex')}.tmp`
  )
  let tempFd
  let tempIdentity
  let renamed = false
  let result
  let failure
  const newRevision = revisionOf(bytes)

  try {
    tempFd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    const tempStat = fs.fstatSync(tempFd, { bigint: true })
    if (!tempStat.isFile()) fail('VAULT_SAVE_FAILED', 'Temporary file could not be verified')
    tempIdentity = identityOf(tempStat)

    let offset = 0
    while (offset < bytes.length) {
      const written = fs.writeSync(tempFd, bytes, offset, bytes.length - offset)
      if (written <= 0) fail('VAULT_SAVE_FAILED', 'Temporary file write did not complete')
      offset += written
    }
    fs.fchmodSync(tempFd, originalMode)
    fs.fsyncSync(tempFd)
    fs.closeSync(tempFd)
    tempFd = undefined

    verifyVaultMarkdownFile(file)
    const checkedBytes = readVaultMarkdownBytes(file)
    validateFileEncoding(checkedBytes)
    if (revisionOf(checkedBytes) !== expectedRevision) {
      fail('VAULT_FILE_CONFLICT', 'Markdown file changed before it could be saved')
    }
    verifyVaultMarkdownFile(file)

    const tempPathStat = fs.lstatSync(tempPath, { bigint: true })
    if (tempPathStat.isSymbolicLink() || !tempPathStat.isFile() || identityOf(tempPathStat) !== tempIdentity) {
      fail('INVALID_VAULT_PATH', 'Temporary file changed before commit')
    }
    verifyVaultMarkdownParent(file)

    // Windows may not replace a destination while its handle remains open.
    file.close()
    const destination = currentFileState(state.vaultsRoot, file.directory, file.path)
    if (destination.identity !== file.identity || destination.revision !== expectedRevision) {
      fail('VAULT_FILE_CONFLICT', 'Markdown file changed before it could be saved')
    }
    // shortcut: portable path checks cannot close an external-writer race, upgrade with handle-relative replacement support.
    verifyVaultMarkdownParent(file)

    try {
      fs.renameSync(tempPath, file.absolutePath)
      renamed = true
      state.committed = true
    } catch (renameError) {
      let current
      try {
        current = currentFileState(state.vaultsRoot, file.directory, file.path)
      } catch {
        throw unknownError()
      }
      if (current.revision === newRevision) {
        state.committed = true
      } else if (current.revision === expectedRevision && current.identity === file.identity) {
        throw saveError()
      } else {
        throw unknownError()
      }
    }

    syncParentDirectory(file)
    const saved = readVaultMarkdown(state.vaultsRoot, file.directory, file.path)
    if (saved.revision !== newRevision || saved.content !== new TextDecoder('utf-8', { fatal: true }).decode(bytes)) {
      throw unknownError()
    }
    result = { directory: file.directory, path: file.path, revision: newRevision }
  } catch (err) {
    failure = state.committed ? unknownError() : normalizeSaveError(err)
  }

  if (tempFd !== undefined) {
    try {
      fs.closeSync(tempFd)
    } catch (err) {
      failure ??= saveError()
    }
  }
  if (!renamed) {
    try {
      removeOwnedTemporary(tempPath, tempIdentity)
    } catch (err) {
      failure ??= state.committed ? unknownError() : saveError()
    }
  }
  if (failure) throw failure
  return result
}

export const saveVaultMarkdown = (vaultsRoot, directory, relativePath, payload) => {
  const save = validatePayload(payload)
  let target
  let lock
  try {
    target = resolveVaultMarkdownPath(vaultsRoot, directory, relativePath)
    lock = acquireLock(target)
  } catch (err) {
    throw normalizeSaveError(err)
  }
  const state = { committed: false, vaultsRoot }
  let result
  let failure

  try {
    result = withVaultMarkdownFile(vaultsRoot, directory, relativePath, (file) => {
      if (!sameParent(target, file)) {
        fail('INVALID_VAULT_PATH', 'Vault directory changed after lock acquisition')
      }
      return replaceFile(file, save, state)
    })
  } catch (err) {
    failure = state.committed ? unknownError() : normalizeSaveError(err)
  }

  try {
    releaseLock(lock)
  } catch (err) {
    failure = state.committed ? unknownError() : failure ?? saveError()
  }

  if (failure) throw failure
  return result
}
