import fs from 'node:fs'
import { resolveVaultRoot, resolveExistingVaultPath } from './filesystem.js'

const failVaultPath = (code = 'INVALID_VAULT_PATH', message = 'Invalid vault path') => {
  const err = new Error(message)
  err.code = code
  throw err
}

const validateRelativePath = (relativePath) => {
  if (relativePath === '' || relativePath === undefined || relativePath === null) {
    return ''
  }

  if (typeof relativePath !== 'string') {
    failVaultPath('INVALID_VAULT_PATH')
  }

  if (
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  const segments = relativePath.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    failVaultPath('INVALID_VAULT_PATH')
  }

  return relativePath
}

export const listVaultEntries = (vaultsRoot, directory, rawPath = '') => {
  const relativePath = validateRelativePath(rawPath)
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)

  let targetDir = vaultRoot
  if (relativePath !== '') {
    const resolved = resolveExistingVaultPath(vaultRoot, relativePath)
    if (resolved.type !== 'directory') {
      failVaultPath('VAULT_PATH_NOT_DIRECTORY', 'Vault path is not a directory')
    }
    targetDir = resolved.absolutePath
  }

  let dirEntries
  try {
    dirEntries = fs.readdirSync(targetDir, { withFileTypes: true })
  } catch {
    failVaultPath('VAULT_PATH_NOT_FOUND', 'Vault path not found')
  }

  const entries = []
  for (const dirent of dirEntries) {
    if (dirent.isSymbolicLink()) {
      continue
    }

    let type
    if (dirent.isDirectory()) {
      type = 'directory'
    } else if (dirent.isFile()) {
      type = 'file'
    } else {
      continue
    }

    const isAmbiguous = (
      dirent.name.includes('/') ||
      dirent.name.includes('\\') ||
      dirent.name.includes('\0') ||
      dirent.name === '.' ||
      dirent.name === '..'
    )

    const entryPath = isAmbiguous
      ? null
      : (relativePath === '' ? dirent.name : `${relativePath}/${dirent.name}`)

    entries.push({
      name: dirent.name,
      path: entryPath,
      type,
    })
  }

  entries.sort((a, b) => {
    if (a.type !== b.type) {
      return a.type === 'directory' ? -1 : 1
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name)
  })

  return {
    directory,
    path: relativePath,
    entries,
  }
}
