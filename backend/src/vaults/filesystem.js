import fs from 'node:fs'
import path from 'node:path'

const failVaultDirectory = (message = 'Invalid vault directory') => {
  const err = new Error(message)
  err.code = 'INVALID_VAULT_DIRECTORY'
  throw err
}

const failVaultPath = (code = 'INVALID_VAULT_PATH', message = 'Invalid vault path') => {
  const err = new Error(message)
  err.code = code
  throw err
}

export const prepareVaultsRoot = (rootPath, { createIfMissing = false } = {}) => {
  if (
    typeof rootPath !== 'string' ||
    rootPath.length === 0 ||
    rootPath.includes('\0')
  ) {
    const err = new Error('Invalid vault root')
    err.code = 'INVALID_VAULT_ROOT'
    throw err
  }

  const resolved = path.resolve(rootPath)
  const parsed = path.parse(resolved)
  if (parsed.root === resolved) {
    const err = new Error('Invalid vault root: cannot be filesystem root')
    err.code = 'INVALID_VAULT_ROOT'
    throw err
  }

  if (createIfMissing) {
    if (!fs.existsSync(resolved)) {
      fs.mkdirSync(resolved, { recursive: true })
    }
  }

  let lstat
  try {
    lstat = fs.lstatSync(resolved)
  } catch {
    const err = new Error('Vault root does not exist')
    err.code = 'INVALID_VAULT_ROOT'
    throw err
  }

  if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    const err = new Error('Vault root must be a directory and not a symlink')
    err.code = 'INVALID_VAULT_ROOT'
    throw err
  }

  let canonical
  try {
    canonical = fs.realpathSync.native(resolved)
  } catch {
    const err = new Error('Cannot resolve canonical vault root')
    err.code = 'INVALID_VAULT_ROOT'
    throw err
  }

  const canonicalParsed = path.parse(canonical)
  if (canonicalParsed.root === canonical) {
    const err = new Error('Invalid vault root: canonical path cannot be filesystem root')
    err.code = 'INVALID_VAULT_ROOT'
    throw err
  }

  return canonical
}

export const findExactDirectoryEntry = (entries, directory) => {
  if (!Array.isArray(entries) || typeof directory !== 'string') {
    return null
  }
  const match = entries.find((entry) => entry && entry.name === directory)
  if (!match) {
    return null
  }
  if (typeof match.isSymbolicLink === 'function' && match.isSymbolicLink()) {
    return null
  }
  if (typeof match.isDirectory === 'function' && !match.isDirectory()) {
    return null
  }
  return match
}

export const resolveVaultRoot = (vaultsRoot, directory) => {
  if (
    typeof vaultsRoot !== 'string' ||
    vaultsRoot.length === 0 ||
    vaultsRoot.includes('\0') ||
    typeof directory !== 'string' ||
    directory.length === 0 ||
    directory.includes('\0') ||
    directory.includes('/') ||
    directory.includes('\\') ||
    directory === '.' ||
    directory === '..' ||
    directory.trim() !== directory
  ) {
    failVaultDirectory()
  }

  let canonicalVaultsRoot
  try {
    canonicalVaultsRoot = fs.realpathSync.native(vaultsRoot)
    if (!fs.statSync(canonicalVaultsRoot).isDirectory()) {
      failVaultDirectory()
    }
  } catch {
    failVaultDirectory()
  }

  let entries
  try {
    entries = fs.readdirSync(canonicalVaultsRoot, { withFileTypes: true })
  } catch {
    failVaultDirectory()
  }

  const exactEntry = findExactDirectoryEntry(entries, directory)
  if (!exactEntry) {
    failVaultDirectory()
  }

  const candidate = path.join(canonicalVaultsRoot, exactEntry.name)
  try {
    const lstat = fs.lstatSync(candidate)
    if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
      failVaultDirectory()
    }

    const canonicalCandidate = fs.realpathSync.native(candidate)
    if (path.dirname(canonicalCandidate) !== canonicalVaultsRoot) {
      failVaultDirectory()
    }

    return canonicalCandidate
  } catch {
    failVaultDirectory()
  }
}

export const resolveExistingVaultPath = (vaultRoot, relativePath) => {
  if (
    typeof relativePath !== 'string' ||
    relativePath.length === 0 ||
    relativePath.includes('\0')
  ) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  // Reject absolute or drive-letter paths across platforms
  if (
    path.isAbsolute(relativePath) ||
    relativePath.startsWith('/') ||
    relativePath.startsWith('\\') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  // Fail closed against traversal across POSIX and Windows separators
  const segments = relativePath.split(/[/\\]+/)
  if (segments.some((seg) => seg === '..')) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  let canonicalVaultRoot
  try {
    canonicalVaultRoot = fs.realpathSync.native(vaultRoot)
    if (!fs.statSync(canonicalVaultRoot).isDirectory()) {
      failVaultPath('INVALID_VAULT_PATH')
    }
  } catch {
    failVaultPath('INVALID_VAULT_PATH')
  }

  const normalizedRelative = path.join(...segments)
  const candidate = path.resolve(canonicalVaultRoot, normalizedRelative)

  // Syntactic containment check before disk access
  const isCandidateSyntacticallyInside =
    candidate === canonicalVaultRoot ||
    candidate.startsWith(canonicalVaultRoot + path.sep)
  if (!isCandidateSyntacticallyInside) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  // Verify existence
  let lstat
  try {
    lstat = fs.lstatSync(candidate)
  } catch {
    failVaultPath('VAULT_PATH_NOT_FOUND', 'Vault path not found')
  }

  // Resolve canonical target (follows symlinks to real target)
  let canonicalCandidate
  try {
    canonicalCandidate = fs.realpathSync.native(candidate)
  } catch {
    failVaultPath('VAULT_PATH_NOT_FOUND', 'Vault path not found')
  }

  // Canonical containment check (prevents sibling-prefix tricks and symlink escapes)
  const isCanonicallyInside =
    canonicalCandidate === canonicalVaultRoot ||
    canonicalCandidate.startsWith(canonicalVaultRoot + path.sep)
  if (!isCanonicallyInside) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  let stat
  try {
    stat = fs.statSync(canonicalCandidate)
  } catch {
    failVaultPath('VAULT_PATH_NOT_FOUND', 'Vault path not found')
  }

  return {
    absolutePath: canonicalCandidate,
    type: stat.isDirectory() ? 'directory' : 'file',
  }
}
