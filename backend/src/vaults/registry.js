import crypto from 'node:crypto'
import { resolveVaultRoot } from './filesystem.js'
import { discoverVaultDirectories, mergeVaults } from './discovery.js'

export const validVaultName = (name) => {
  return typeof name === 'string' && name.length > 0 && name.length <= 100 && name === name.trim()
}

export const registerVault = (
  database,
  vaultsRoot,
  { name, directory } = {},
  { idFn = crypto.randomUUID, resolveRootFn = resolveVaultRoot } = {}
) => {
  if (!validVaultName(name)) {
    const err = new Error('Invalid vault name')
    err.code = 'INVALID_VAULT_NAME'
    throw err
  }

  // Ensures physical direct-child directory exists and is valid
  resolveRootFn(vaultsRoot, directory)

  const id = idFn()

  try {
    database
      .prepare('INSERT INTO vault (id, name, directory) VALUES (?, ?, ?)')
      .run(id, name, directory)
  } catch (dbErr) {
    if (dbErr.code === 'SQLITE_CONSTRAINT_UNIQUE' || dbErr.message?.includes('UNIQUE constraint failed')) {
      const err = new Error('Vault already registered')
      err.code = 'VAULT_ALREADY_REGISTERED'
      throw err
    }
    throw dbErr
  }

  return { id, name, directory }
}

export const listRegisteredVaults = (database) => {
  return database
    .prepare('SELECT id, name, directory FROM vault ORDER BY name COLLATE NOCASE ASC, directory ASC')
    .all()
}

export const listVaults = (database, vaultsRoot) => {
  const discovered = discoverVaultDirectories(vaultsRoot)
  const registered = listRegisteredVaults(database)
  return mergeVaults(discovered, registered)
}

export const unregisterVault = (database, id) => {
  database.prepare('DELETE FROM vault WHERE id = ?').run(id)
}
