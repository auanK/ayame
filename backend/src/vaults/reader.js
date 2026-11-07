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

/**
 * Reads a Markdown file from a vault in read-only mode with strict boundary,
 * size, and encoding checks.
 *
 * TOCTOU Note:
 * Path containment is validated via resolveExistingVaultPath and checked against
 * symlink escapes. While using read-only descriptors (fs.openSync with 'r') and
 * verifying the resulting descriptor via fs.fstatSync ensures the opened entity
 * is a regular file within the 2 MiB limit, user-space path resolution followed by
 * open is not an atomic kernel operation on general-purpose filesystems without
 * flags like openat2(RESOLVE_BENEATH).
 */
export const readVaultMarkdown = (vaultsRoot, directory, rawPath) => {
  const relativePath = validateMarkdownRelativePath(rawPath)
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)

  // Disallow symlink as final entry in the vault hierarchy
  const candidatePath = path.resolve(vaultRoot, path.join(...relativePath.split('/')))
  try {
    const lstat = fs.lstatSync(candidatePath)
    if (lstat.isSymbolicLink()) {
      failVault('INVALID_VAULT_PATH', 'Direct reading of symbolic link entries is prohibited')
    }
  } catch (err) {
    if (err.code === 'ENOENT') {
      failVault('VAULT_PATH_NOT_FOUND', 'Vault path not found')
    }
    throw err
  }

  const resolved = resolveExistingVaultPath(vaultRoot, relativePath)
  if (resolved.type !== 'file') {
    failVault('VAULT_PATH_NOT_FILE', 'Vault path is not a file')
  }

  let fd
  try {
    fd = fs.openSync(resolved.absolutePath, 'r')
  } catch (err) {
    if (err.code === 'ENOENT') {
      failVault('VAULT_PATH_NOT_FOUND', 'Vault path not found')
    }
    throw err
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) {
      failVault('VAULT_PATH_NOT_FILE', 'Vault path is not a regular file')
    }

    if (stat.size > MAX_MARKDOWN_BYTES) {
      failVault('VAULT_FILE_TOO_LARGE', `File size (${stat.size} bytes) exceeds maximum limit of ${MAX_MARKDOWN_BYTES} bytes`)
    }

    // Read up to MAX_MARKDOWN_BYTES + 1 to detect file growth beyond limit during read
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
