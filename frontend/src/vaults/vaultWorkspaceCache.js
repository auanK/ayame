export const vaultWorkspaceCacheKey = Symbol('Ayame vault workspace cache')

const MAX_VAULTS = 3
const MAX_FOLDERS = 32
const MAX_FOLDER_ENTRIES = 2_000
const MAX_INDEX_PATHS = 10_000
const MAX_INDEX_TEXT_BYTES = 8 * 1024 * 1024
const MAX_AGE_MS = 30_000

export const isFreshWorkspaceSnapshot = (snapshot) =>
  Boolean(snapshot && Date.now() - snapshot.checkedAt < MAX_AGE_MS)

export function createVaultWorkspaceCache() {
  const vaults = new Map()

  function get(directory) {
    const vault = vaults.get(directory)
    if (!vault) return null
    vaults.delete(directory)
    vaults.set(directory, vault)
    return vault
  }

  function ensureVault(directory) {
    const existing = get(directory)
    if (existing) return existing
    const vault = { folders: new Map(), index: null }
    vaults.set(directory, vault)
    if (vaults.size > MAX_VAULTS) vaults.delete(vaults.keys().next().value)
    return vault
  }

  function putEntries(directory, path, entries) {
    const { folders } = ensureVault(directory)
    folders.delete(path)
    if (entries.length > MAX_FOLDER_ENTRIES) return
    folders.set(path, { entries, checkedAt: Date.now() })
    if (folders.size > MAX_FOLDERS) {
      const oldestFolder = [...folders.keys()].find((key) => key !== '')
      folders.delete(oldestFolder)
    }
  }

  function putIndex(directory, index, checkedAt) {
    const vault = ensureVault(directory)
    const bytes = index.rawNotes.reduce((total, note) => total + note.content.length * 2, 0)
    vault.index = bytes <= MAX_INDEX_TEXT_BYTES && index.files.length + index.folders.length <= MAX_INDEX_PATHS
      ? { data: index, checkedAt }
      : null
  }

  return {
    get,
    putEntries,
    putIndex,
    invalidateIndex(directory) {
      const vault = vaults.get(directory)
      if (vault) vault.index = null
    },
    invalidate(directory) {
      vaults.delete(directory)
    },
    clear() {
      vaults.clear()
    },
  }
}
