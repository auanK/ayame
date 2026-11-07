import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVaultRoot, resolveExistingVaultPath } from './filesystem.js'
import { readVaultMarkdown } from './reader.js'

const EMPTY_REVISION = crypto.createHash('sha256').update(Buffer.alloc(0)).digest('hex')
const SUPPORTED_NOTE_EXTENSIONS = new Set(['.md', '.markdown'])
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i
const FORBIDDEN_NAME_CHARS = /[\x00-\x1f\x7f/\\:<>?"|*]/

const fail = (code, message) => {
  const err = new Error(message)
  err.code = code
  throw err
}

const fileIdentity = (stat) => {
  if (stat.dev === 0n || stat.ino === 0n) {
    fail('INVALID_VAULT_PATH', 'Cannot verify file identity on this filesystem')
  }
  return `${stat.dev}:${stat.ino}`
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const sameSnapshot = (expected, actual) =>
  expected.length === actual.length &&
  expected.every((stat, index) => fileIdentity(stat) === fileIdentity(actual[index]))

const validatePayload = (payload) => {
  if (
    !payload ||
    typeof payload !== 'object' ||
    Array.isArray(payload) ||
    Object.keys(payload).length !== 2 ||
    typeof payload.parentPath !== 'string' ||
    typeof payload.name !== 'string'
  ) {
    fail('INVALID_CREATE_PAYLOAD', 'Invalid creation payload')
  }
  return {
    parentPath: payload.parentPath,
    name: payload.name,
  }
}

const validateParentPath = (parentPath) => {
  if (parentPath === '') {
    return ''
  }

  if (
    parentPath.includes('\0') ||
    parentPath.includes('\\') ||
    parentPath.startsWith('/') ||
    /^[a-zA-Z]:/.test(parentPath)
  ) {
    fail('INVALID_VAULT_PATH', 'Invalid parent path format')
  }

  const segments = parentPath.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    fail('INVALID_VAULT_PATH', 'Invalid parent path segments')
  }

  return parentPath
}

const isValidUtf8String = (value) => {
  try {
    const bytes = Buffer.from(value, 'utf8')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes) === value
  } catch {
    return false
  }
}

const validateBaseEntryName = (name) => {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.trim() !== name ||
    name === '.' ||
    name === '..' ||
    name.startsWith('.') ||
    /[. ]$/.test(name) ||
    FORBIDDEN_NAME_CHARS.test(name) ||
    RESERVED_DEVICE_NAME.test(name) ||
    !isValidUtf8String(name) ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    fail('INVALID_ENTRY_NAME', 'Invalid entry name')
  }
}

const validateFolderName = (name) => {
  validateBaseEntryName(name)
  return name
}

const validateAndNormalizeNoteName = (name) => {
  validateBaseEntryName(name)

  const ext = path.posix.extname(name).toLowerCase()
  let finalName = name
  if (ext === '') {
    finalName = `${name}.md`
  } else if (!SUPPORTED_NOTE_EXTENSIONS.has(ext)) {
    fail('UNSUPPORTED_FILE_TYPE', 'Only .md and .markdown notes can be created')
  }

  const stem = finalName.slice(0, finalName.length - path.posix.extname(finalName).length)
  if (
    stem.length === 0 ||
    stem.trim() !== stem ||
    /[. ]$/.test(stem) ||
    RESERVED_DEVICE_NAME.test(stem) ||
    Buffer.byteLength(finalName, 'utf8') > 255
  ) {
    fail('INVALID_ENTRY_NAME', 'Invalid note name')
  }

  return finalName
}

const snapshotParentChain = (vaultRoot, parentPath) => {
  const targets = [vaultRoot]
  if (parentPath !== '') {
    for (const seg of parentPath.split('/')) {
      targets.push(path.join(targets[targets.length - 1], seg))
    }
  }

  return targets.map((target) => {
    let stat
    try {
      stat = fs.lstatSync(target, { bigint: true })
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        fail('VAULT_PATH_NOT_FOUND', 'Parent directory not found')
      }
      throw err
    }

    if (stat.isSymbolicLink()) {
      fail('INVALID_VAULT_PATH', 'Symbolic links are not permitted in vault paths')
    }
    if (!stat.isDirectory()) {
      fail('VAULT_PATH_NOT_DIRECTORY', 'Parent path is not a directory')
    }
    fileIdentity(stat)
    return stat
  })
}

const resolveValidatedParent = (vaultsRoot, directory, rawParentPath) => {
  const parentPath = validateParentPath(rawParentPath)
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const initialSnapshot = snapshotParentChain(vaultRoot, parentPath)

  let parentDir = vaultRoot
  if (parentPath !== '') {
    const resolved = resolveExistingVaultPath(vaultRoot, parentPath)
    if (resolved.type !== 'directory') {
      fail('VAULT_PATH_NOT_DIRECTORY', 'Parent path is not a directory')
    }
    parentDir = resolved.absolutePath
  }

  const secondSnapshot = snapshotParentChain(vaultRoot, parentPath)
  if (!sameSnapshot(initialSnapshot, secondSnapshot)) {
    fail('INVALID_VAULT_PATH', 'Parent directory changed during validation')
  }

  const canonicalParent = fs.realpathSync.native(parentDir)
  if (!isWithin(vaultRoot, canonicalParent)) {
    fail('INVALID_VAULT_PATH', 'Parent directory is outside the vault')
  }

  return {
    vaultRoot,
    parentPath,
    parentDir: canonicalParent,
    snapshot: secondSnapshot,
  }
}

const verifyParentUnchanged = (parent) => {
  const current = snapshotParentChain(parent.vaultRoot, parent.parentPath)
  if (!sameSnapshot(parent.snapshot, current)) {
    fail('INVALID_VAULT_PATH', 'Parent directory changed during operation')
  }
  const canonicalParent = fs.realpathSync.native(parent.parentDir)
  if (!isWithin(parent.vaultRoot, canonicalParent)) {
    fail('INVALID_VAULT_PATH', 'Parent directory is outside the vault')
  }
}

const ensureTargetAbsent = (vaultRoot, targetAbsolutePath) => {
  if (!isWithin(vaultRoot, targetAbsolutePath)) {
    fail('INVALID_VAULT_PATH', 'Target path escapes the vault')
  }

  let stat
  try {
    stat = fs.lstatSync(targetAbsolutePath, { bigint: true })
  } catch (err) {
    if (err.code === 'ENOENT') {
      return
    }
    throw err
  }

  if (stat.isSymbolicLink()) {
    fail('INVALID_VAULT_PATH', 'Target path cannot be a symbolic link')
  }
  fail('VAULT_ENTRY_EXISTS', 'An entry with this name already exists')
}

const syncDirectory = (dirPath) => {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

const normalizeCreateError = (err) => {
  if ([
    'INVALID_VAULT_DIRECTORY',
    'INVALID_VAULT_PATH',
    'INVALID_CREATE_PAYLOAD',
    'INVALID_ENTRY_NAME',
    'VAULT_PATH_NOT_FOUND',
    'VAULT_PATH_NOT_DIRECTORY',
    'VAULT_ENTRY_EXISTS',
    'UNSUPPORTED_FILE_TYPE',
    'VAULT_CREATE_FAILED',
    'VAULT_CREATE_RESULT_UNKNOWN',
  ].includes(err.code)) {
    return err
  }
  return Object.assign(new Error('Could not create vault entry'), { code: 'VAULT_CREATE_FAILED' })
}

export const createVaultFolder = (vaultsRoot, directory, rawPayload) => {
  try {
    const { parentPath: rawParentPath, name: rawName } = validatePayload(rawPayload)
    const name = validateFolderName(rawName)
    const parent = resolveValidatedParent(vaultsRoot, directory, rawParentPath)
    const targetAbsolutePath = path.join(parent.parentDir, name)
    const relativePath = parent.parentPath === '' ? name : `${parent.parentPath}/${name}`

    ensureTargetAbsent(parent.vaultRoot, targetAbsolutePath)
    verifyParentUnchanged(parent)

    try {
      fs.mkdirSync(targetAbsolutePath, { recursive: false })
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.lstatSync(targetAbsolutePath, { bigint: true })
          if (stat.isSymbolicLink()) {
            fail('INVALID_VAULT_PATH', 'Target path cannot be a symbolic link')
          }
        } catch (statErr) {
          if (statErr.code === 'INVALID_VAULT_PATH') throw statErr
        }
        fail('VAULT_ENTRY_EXISTS', 'Folder already exists')
      }
      if (err.code === 'ENOENT') {
        fail('VAULT_PATH_NOT_FOUND', 'Parent directory not found')
      }
      if (err.code === 'ENOTDIR') {
        fail('VAULT_PATH_NOT_DIRECTORY', 'Parent path is not a directory')
      }
      if (err.code === 'EINVAL' || err.code === 'ENAMETOOLONG') {
        fail('INVALID_ENTRY_NAME', 'Invalid folder name')
      }
      fail('VAULT_CREATE_FAILED', 'Could not create folder')
    }

    verifyParentUnchanged(parent)
    const createdStat = fs.lstatSync(targetAbsolutePath, { bigint: true })
    if (createdStat.isSymbolicLink() || !createdStat.isDirectory()) {
      fail('INVALID_VAULT_PATH', 'Created entry is not a valid directory')
    }
    const canonicalCreated = fs.realpathSync.native(targetAbsolutePath)
    if (!isWithin(parent.vaultRoot, canonicalCreated)) {
      fail('INVALID_VAULT_PATH', 'Created directory is outside the vault')
    }

    syncDirectory(parent.parentDir)

    return {
      directory,
      path: relativePath,
      name,
    }
  } catch (err) {
    throw normalizeCreateError(err)
  }
}

export const createVaultNote = (vaultsRoot, directory, rawPayload) => {
  let committed = false
  try {
    const { parentPath: rawParentPath, name: rawName } = validatePayload(rawPayload)
    const finalName = validateAndNormalizeNoteName(rawName)
    const parent = resolveValidatedParent(vaultsRoot, directory, rawParentPath)
    const targetAbsolutePath = path.join(parent.parentDir, finalName)
    const relativePath = parent.parentPath === '' ? finalName : `${parent.parentPath}/${finalName}`

    ensureTargetAbsent(parent.vaultRoot, targetAbsolutePath)
    verifyParentUnchanged(parent)

    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
    let fd
    try {
      fd = fs.openSync(targetAbsolutePath, flags, 0o666)
      committed = true
    } catch (err) {
      if (err.code === 'EEXIST') {
        try {
          const stat = fs.lstatSync(targetAbsolutePath, { bigint: true })
          if (stat.isSymbolicLink()) {
            fail('INVALID_VAULT_PATH', 'Target path cannot be a symbolic link')
          }
        } catch (statErr) {
          if (statErr.code === 'INVALID_VAULT_PATH') throw statErr
        }
        fail('VAULT_ENTRY_EXISTS', 'Note already exists')
      }
      if (err.code === 'ELOOP') {
        fail('INVALID_VAULT_PATH', 'Symbolic links are not permitted')
      }
      if (err.code === 'ENOENT') {
        fail('VAULT_PATH_NOT_FOUND', 'Parent directory not found')
      }
      if (err.code === 'ENOTDIR') {
        fail('VAULT_PATH_NOT_DIRECTORY', 'Parent path is not a directory')
      }
      if (err.code === 'EINVAL' || err.code === 'ENAMETOOLONG') {
        fail('INVALID_ENTRY_NAME', 'Invalid note name')
      }
      fail('VAULT_CREATE_FAILED', 'Could not create note')
    }

    let fdClosed = false
    try {
      const openedStat = fs.fstatSync(fd, { bigint: true })
      if (!openedStat.isFile() || openedStat.size !== 0n) {
        fail('VAULT_CREATE_RESULT_UNKNOWN', 'Created file state could not be verified')
      }
      fs.fsyncSync(fd)
      fs.closeSync(fd)
      fdClosed = true

      verifyParentUnchanged(parent)
      syncDirectory(parent.parentDir)

      const verified = readVaultMarkdown(vaultsRoot, directory, relativePath)
      if (verified.content !== '' || verified.revision !== EMPTY_REVISION) {
        fail('VAULT_CREATE_RESULT_UNKNOWN', 'Created note content or revision did not match empty UTF-8')
      }

      return {
        directory,
        path: relativePath,
        revision: verified.revision,
      }
    } finally {
      if (!fdClosed && fd !== undefined) {
        try {
          fs.closeSync(fd)
        } catch {}
      }
    }
  } catch (err) {
    if (committed) {
      throw Object.assign(new Error('Note creation result is uncertain'), { code: 'VAULT_CREATE_RESULT_UNKNOWN' })
    }
    throw normalizeCreateError(err)
  }
}
