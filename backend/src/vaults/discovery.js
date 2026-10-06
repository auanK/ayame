import fs from 'node:fs'
import path from 'node:path'

export const discoverVaultDirectories = (vaultsRoot) => {
  if (typeof vaultsRoot !== 'string' || vaultsRoot.length === 0 || vaultsRoot.includes('\0')) {
    return []
  }

  let canonicalRoot
  try {
    canonicalRoot = fs.realpathSync.native(vaultsRoot)
    if (!fs.statSync(canonicalRoot).isDirectory()) {
      return []
    }
  } catch {
    return []
  }

  const entries = fs.readdirSync(canonicalRoot, { withFileTypes: true })
  const discovered = []

  for (const entry of entries) {
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      continue
    }

    const childPath = path.join(canonicalRoot, entry.name)
    try {
      const lstat = fs.lstatSync(childPath)
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
        continue
      }

      const canonicalChild = fs.realpathSync.native(childPath)
      if (path.dirname(canonicalChild) !== canonicalRoot) {
        continue
      }

      discovered.push(entry.name)
    } catch {
      continue
    }
  }

  discovered.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
  return discovered
}

export const mergeVaults = (discoveredDirectories = [], registeredVaults = []) => {
  const registeredByDir = new Map(
    registeredVaults.map((vault) => [vault.directory, vault])
  )

  const merged = []
  for (const directory of discoveredDirectories) {
    const registered = registeredByDir.get(directory)
    if (registered) {
      merged.push({
        id: registered.id,
        name: registered.name,
        directory: registered.directory,
        registered: true,
      })
    } else {
      merged.push({
        id: null,
        name: directory,
        directory,
        registered: false,
      })
    }
  }

  merged.sort(
    (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.directory.localeCompare(b.directory)
  )

  return merged
}
