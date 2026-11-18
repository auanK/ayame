import fs from 'node:fs'
import path from 'node:path'
import { resolveVaultRoot } from './filesystem.js'

const isInternalArtifact = (name) =>
  name === '.trash' ||
  name === '.obsidian' ||
  name.endsWith('.ayame.lock') ||
  /^\..*\.ayame-[a-f0-9]+\.tmp$/i.test(name)

const isMarkdownNote = (name) => /\.(md|markdown)$/i.test(name)

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

export const collectVaultStats = (vaultsRoot, directory) => {
  let vaultRoot
  try {
    vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  } catch {
    return { noteCount: 0, lastModifiedAt: null }
  }

  let noteCount = 0
  let maxMtime = 0

  const walk = (dirPath) => {
    let entries
    try {
      entries = fs.readdirSync(dirPath, { withFileTypes: true })
    } catch {
      return
    }

    for (const dirent of entries) {
      if (dirent.isSymbolicLink() || isInternalArtifact(dirent.name)) {
        continue
      }
      const absPath = path.join(dirPath, dirent.name)
      if (dirent.isDirectory()) {
        walk(absPath)
      } else if (dirent.isFile() && isMarkdownNote(dirent.name)) {
        try {
          const lstat = fs.lstatSync(absPath)
          if (lstat.isSymbolicLink() || !lstat.isFile()) continue
          noteCount += 1
          const mtime = Math.floor(lstat.mtimeMs)
          if (mtime > maxMtime) maxMtime = mtime
        } catch {}
      }
    }
  }

  walk(vaultRoot)
  return {
    noteCount,
    lastModifiedAt: noteCount > 0 && maxMtime > 0 ? maxMtime : null,
  }
}

const getStats = (statsByDir, directory) => {
  const raw = statsByDir instanceof Map ? statsByDir.get(directory) : statsByDir?.[directory]
  return {
    noteCount: typeof raw?.noteCount === 'number' ? raw.noteCount : 0,
    lastModifiedAt: typeof raw?.lastModifiedAt === 'number' ? raw.lastModifiedAt : null,
  }
}

export const mergeVaults = (discoveredDirectories = [], registeredVaults = [], statsByDir = new Map()) => {
  const registeredByDir = new Map(
    registeredVaults.map((vault) => [vault.directory, vault])
  )

  const merged = []
  for (const directory of discoveredDirectories) {
    const registered = registeredByDir.get(directory)
    const stats = getStats(statsByDir, directory)
    if (registered) {
      merged.push({
        id: registered.id,
        name: registered.name,
        directory: registered.directory,
        registered: true,
        position: typeof registered.position === 'number' ? registered.position : null,
        category: typeof registered.category === 'string' ? registered.category : '',
        tags: Array.isArray(registered.tags) ? [...registered.tags] : [],
        description: typeof registered.description === 'string' ? registered.description : '',
        accentColor: typeof registered.accentColor === 'string' ? registered.accentColor : '',
        pinned: Boolean(registered.pinned),
        hasCover: Boolean(registered.hasCover),
        coverUpdatedAt: typeof registered.coverUpdatedAt === 'number' ? registered.coverUpdatedAt : null,
        noteCount: stats.noteCount,
        lastModifiedAt: stats.lastModifiedAt,
      })
    } else {
      merged.push({
        id: null,
        name: directory,
        directory,
        registered: false,
        position: null,
        category: '',
        tags: [],
        description: '',
        accentColor: '',
        pinned: false,
        hasCover: false,
        coverUpdatedAt: null,
        noteCount: stats.noteCount,
        lastModifiedAt: stats.lastModifiedAt,
      })
    }
  }

  merged.sort((a, b) => {
    const aPos = typeof a.position === 'number' ? a.position : Number.POSITIVE_INFINITY
    const bPos = typeof b.position === 'number' ? b.position : Number.POSITIVE_INFINITY
    if (aPos !== bPos) return aPos - bPos
    return (
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
      a.directory.localeCompare(b.directory)
    )
  })

  return merged
}
