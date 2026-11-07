import fs from 'node:fs'
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

/**
 * Reads a Markdown file from a vault in read-only mode with strict boundary,
 * size, and encoding checks.
 *
 * Node does not expose openat/openat2 or Windows handle-relative opens. The
 * reader therefore checks every path component before and after opening and
 * compares the opened handle's device/inode identity. This rejects observed
 * substitutions, but cannot make ancestor traversal atomic against an active
 * local process that can replace and restore directories during the checks.
 */
export const readVaultMarkdown = (vaultsRoot, directory, rawPath) => {
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

  try {
    const stat = fs.fstatSync(fd, { bigint: true })
    if (!stat.isFile()) {
      failVault('VAULT_PATH_NOT_FILE', 'Vault path is not a regular file')
    }

    const openedIdentity = fileIdentity(stat)
    if (openedIdentity !== fileIdentity(initialSnapshot.at(-1))) {
      failVault('INVALID_VAULT_PATH', 'Opened file does not match the validated vault entry')
    }

    const afterOpenSnapshot = snapshotVaultPath(vaultRoot, relativePath)
    if (!sameSnapshot(initialSnapshot, afterOpenSnapshot)) {
      failVault('INVALID_VAULT_PATH', 'Vault path changed while it was being opened')
    }

    const canonicalAfterOpen = fs.realpathSync.native(resolved.absolutePath)
    if (!isWithin(vaultRoot, canonicalAfterOpen)) {
      failVault('INVALID_VAULT_PATH', 'Opened file is outside the vault')
    }

    if (stat.size > BigInt(MAX_MARKDOWN_BYTES)) {
      failVault('VAULT_FILE_TOO_LARGE', `File size (${stat.size} bytes) exceeds maximum limit of ${MAX_MARKDOWN_BYTES} bytes`)
    }

    // Read up to MAX_MARKDOWN_BYTES + 1 to detect file growth beyond the limit during read.
    const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES + 1)
    let totalBytesRead = 0
    let chunk = 0

    while ((chunk = fs.readSync(fd, buffer, totalBytesRead, buffer.length - totalBytesRead, null)) > 0) {
      totalBytesRead += chunk
      if (totalBytesRead > MAX_MARKDOWN_BYTES) {
        failVault('VAULT_FILE_TOO_LARGE', `File size exceeded maximum limit of ${MAX_MARKDOWN_BYTES} bytes during read`)
      }
    }

    const fileBytes = buffer.subarray(0, totalBytesRead)
    let content
    try {
      const decoder = new TextDecoder('utf-8', { fatal: true })
      content = decoder.decode(fileBytes)
    } catch {
      failVault('INVALID_FILE_ENCODING', 'File content is not valid UTF-8')
    }

    return {
      directory,
      path: relativePath,
      content,
    }
  } finally {
    fs.closeSync(fd)
  }
}
