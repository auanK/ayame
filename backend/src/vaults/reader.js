import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { resolveVaultRoot, resolveExistingVaultPath } from './filesystem.js'

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024 // 2 MiB (inclusive)

const SUPPORTED_EXTENSIONS = new Set(['.md', '.markdown'])

const failVault = (code, message) => {
  const err = new Error(message)
  err.code = code
  throw err
}

/**
 * Validates the relative path against formatting, traversal, and supported extensions.
 */
const validateMarkdownRelativePath = (relativePath) => {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.trim() === '') {
    failVault('INVALID_VAULT_PATH', 'Path must be a non-empty string')
  }

  if (
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    failVault('INVALID_VAULT_PATH', 'Invalid vault path format or separator')
  }

  const segments = relativePath.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    failVault('INVALID_VAULT_PATH', 'Invalid path segments: empty or dot segments not permitted')
  }

  const ext = path.posix.extname(relativePath).toLowerCase()
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    failVault('UNSUPPORTED_FILE_TYPE', `Unsupported file type: only .md and .markdown are supported (received ${ext || 'none'})`)
  }

  return relativePath
}

const fileIdentity = (stat) => {
  if (stat.dev === 0n || stat.ino === 0n) {
    failVault('INVALID_VAULT_PATH', 'Cannot verify file identity on this filesystem')
  }
  return `${stat.dev}:${stat.ino}`
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const snapshotVaultPath = (vaultRoot, relativePath) => {
  const paths = [vaultRoot]
  for (const segment of relativePath.split('/')) {
    paths.push(path.join(paths[paths.length - 1], segment))
  }

  const stats = paths.map((target, index) => {
    let stat
    try {
      stat = fs.lstatSync(target, { bigint: true })
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        failVault('VAULT_PATH_NOT_FOUND', 'Vault path not found')
      }
      throw err
    }

    if (stat.isSymbolicLink()) {
      failVault('INVALID_VAULT_PATH', 'Symbolic links are not permitted in Markdown paths')
    }
    if (index < paths.length - 1 && !stat.isDirectory()) {
      failVault('VAULT_PATH_NOT_FOUND', 'Vault path not found')
    }
    if (index === paths.length - 1 && !stat.isFile()) {
      failVault('VAULT_PATH_NOT_FILE', 'Vault path is not a regular file')
    }

    fileIdentity(stat)
    return stat
  })

  return stats
}

const sameSnapshot = (expected, actual) =>
  expected.length === actual.length &&
  expected.every((stat, index) => fileIdentity(stat) === fileIdentity(actual[index]))

const snapshotVaultParent = (vaultRoot, relativePath) => {
  const paths = [vaultRoot]
  for (const segment of relativePath.split('/').slice(0, -1)) {
    paths.push(path.join(paths[paths.length - 1], segment))
  }
  return paths.map((target) => {
    let stat
    try {
      stat = fs.lstatSync(target, { bigint: true })
    } catch (err) {
      if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
        failVault('INVALID_VAULT_PATH', 'Vault directory changed during the operation')
      }
      throw err
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      failVault('INVALID_VAULT_PATH', 'Vault directory changed during the operation')
    }
    fileIdentity(stat)
    return stat
  })
}

export const resolveVaultMarkdownPath = (vaultsRoot, directory, rawPath) => {
  const relativePath = validateMarkdownRelativePath(rawPath)
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const initialSnapshot = snapshotVaultPath(vaultRoot, relativePath)
  const resolved = resolveExistingVaultPath(vaultRoot, relativePath)
  if (resolved.type !== 'file') {
    failVault('VAULT_PATH_NOT_FILE', 'Vault path is not a file')
  }

  const beforeOpenSnapshot = snapshotVaultPath(vaultRoot, relativePath)
  if (!sameSnapshot(initialSnapshot, beforeOpenSnapshot)) {
    failVault('INVALID_VAULT_PATH', 'Vault path changed while it was being validated')
  }

  return {
    directory,
    path: relativePath,
    vaultRoot,
    absolutePath: resolved.absolutePath,
    snapshot: beforeOpenSnapshot,
  }
}

export const verifyVaultMarkdownParent = (target) => {
  const expected = target.snapshot.slice(0, -1)
  const current = snapshotVaultParent(target.vaultRoot, target.path)
  if (!sameSnapshot(expected, current)) {
    failVault('INVALID_VAULT_PATH', 'Vault directory changed during the operation')
  }
  const canonicalParent = fs.realpathSync.native(path.dirname(target.absolutePath))
  if (!isWithin(target.vaultRoot, canonicalParent)) {
    failVault('INVALID_VAULT_PATH', 'Vault directory is outside the vault')
  }
}

export const verifyVaultMarkdownFile = (file) => {
  const currentSnapshot = snapshotVaultPath(file.vaultRoot, file.path)
  if (!sameSnapshot(file.snapshot, currentSnapshot)) {
    failVault('INVALID_VAULT_PATH', 'Vault path changed during the operation')
  }

  const stat = fs.lstatSync(file.absolutePath, { bigint: true })
  if (stat.isSymbolicLink() || !stat.isFile() || fileIdentity(stat) !== file.identity) {
    failVault('INVALID_VAULT_PATH', 'Vault file identity changed during the operation')
  }

  let canonical
  try {
    canonical = fs.realpathSync.native(file.absolutePath)
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
      failVault('INVALID_VAULT_PATH', 'Vault path changed during the operation')
    }
    throw err
  }
  if (!isWithin(file.vaultRoot, canonical)) {
    failVault('INVALID_VAULT_PATH', 'Vault file is outside the vault')
  }

  const opened = fs.fstatSync(file.fd, { bigint: true })
  if (!opened.isFile() || fileIdentity(opened) !== file.identity) {
    failVault('INVALID_VAULT_PATH', 'Opened file identity changed during the operation')
  }
}

export const readVaultMarkdownBytes = (file) => {
  const stat = fs.fstatSync(file.fd, { bigint: true })
  if (!stat.isFile() || fileIdentity(stat) !== file.identity) {
    failVault('INVALID_VAULT_PATH', 'Opened file identity changed during the operation')
  }
  if (stat.size > BigInt(MAX_MARKDOWN_BYTES)) {
    failVault('VAULT_FILE_TOO_LARGE', `File size (${stat.size} bytes) exceeds maximum limit of ${MAX_MARKDOWN_BYTES} bytes`)
  }

  const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES + 1)
  let totalBytesRead = 0
  let chunk = 0
  while ((chunk = fs.readSync(file.fd, buffer, totalBytesRead, buffer.length - totalBytesRead, totalBytesRead)) > 0) {
    totalBytesRead += chunk
    if (totalBytesRead > MAX_MARKDOWN_BYTES) {
      failVault('VAULT_FILE_TOO_LARGE', `File size exceeded maximum limit of ${MAX_MARKDOWN_BYTES} bytes during read`)
    }
  }
  return buffer.subarray(0, totalBytesRead)
}

/**
 * Node lacks portable handle-relative opens. This shared scope binds the file
 * read or write operation to the validated handle and always closes it.
 */
export const withVaultMarkdownFile = (vaultsRoot, directory, rawPath, operation) => {
  const resolved = resolveVaultMarkdownPath(vaultsRoot, directory, rawPath)
  // Windows lacks O_NOFOLLOW; component snapshots and opened-handle identity checks still apply.
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  let fd
  try {
    fd = fs.openSync(resolved.absolutePath, flags)
  } catch (err) {
    if (err.code === 'ENOENT') {
      failVault('VAULT_PATH_NOT_FOUND', 'Vault path not found')
    }
    if (err.code === 'ELOOP') {
      failVault('INVALID_VAULT_PATH', 'Symbolic links are not permitted in Markdown paths')
    }
    throw err
  }

  let descriptorOpen = true
  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile()) {
      failVault('VAULT_PATH_NOT_FILE', 'Vault path is not a regular file')
    }

    const openedIdentity = fileIdentity(stat)
    if (openedIdentity !== fileIdentity(resolved.snapshot.at(-1))) {
      failVault('INVALID_VAULT_PATH', 'Opened file does not match the validated vault entry')
    }

    const opened = {
      ...resolved,
      fd,
      identity: openedIdentity,
      close() {
        if (!descriptorOpen) return
        fs.closeSync(fd)
        descriptorOpen = false
      },
    }
    verifyVaultMarkdownFile(opened)
    return operation(opened)
  } finally {
    if (descriptorOpen) fs.closeSync(fd)
  }
}

/**
 * Reads a Markdown file from a vault in read-only mode with strict boundary,
 * size, and encoding checks.
 */
export const readVaultMarkdown = (vaultsRoot, directory, rawPath) =>
  withVaultMarkdownFile(vaultsRoot, directory, rawPath, (file) => {
    const fileBytes = readVaultMarkdownBytes(file)
    let content
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      content = decoder.decode(fileBytes)
    } catch {
      failVault('INVALID_FILE_ENCODING', 'File content is not valid UTF-8')
    }

    return {
      directory: file.directory,
      path: file.path,
      content,
      revision: crypto.createHash('sha256').update(fileBytes).digest('hex'),
    }
  })
