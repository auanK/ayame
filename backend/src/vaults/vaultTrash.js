import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVaultRoot, VAULT_TRASH_DIRECTORY } from './filesystem.js'

const validId = (id) => /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(id)
const fail = (code) => { throw Object.assign(new Error(code), { code }) }

const readDirectory = (directory) => {
  try {
    return fs.lstatSync(directory)
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
    return null
  }
}

const trashRootFor = (vaultsRoot, create = false) => {
  const root = fs.realpathSync.native(vaultsRoot)
  const trash = path.join(root, VAULT_TRASH_DIRECTORY)
  if (create) {
    try {
      fs.mkdirSync(trash, { mode: 0o700 })
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
    }
  }
  const info = readDirectory(trash)
  if (!info) return null
  if (!info.isDirectory() || fs.realpathSync.native(trash) !== trash) fail('INVALID_VAULT_ROOT')
  return trash
}

const readTrashItem = (trash, id) => {
  const item = path.join(trash, id)
  const info = readDirectory(item)
  if (!info?.isDirectory() || fs.realpathSync.native(item) !== item) return null
  const children = fs.readdirSync(item, { withFileTypes: true })
  if (children.length !== 1 || !children[0].isDirectory()) return null
  const directory = children[0].name
  const source = path.join(item, directory)
  if (directory.toLowerCase() === VAULT_TRASH_DIRECTORY || fs.realpathSync.native(source) !== source) return null
  return { id, directory, item, source, trashedAt: info.mtimeMs }
}

export const listTrashedVaults = (vaultsRoot) => {
  const trash = trashRootFor(vaultsRoot)
  if (!trash) return []
  return fs.readdirSync(trash)
    .filter(validId)
    .map((id) => readTrashItem(trash, id))
    .filter(Boolean)
    .sort((a, b) => b.trashedAt - a.trashedAt)
    .map(({ id, directory, trashedAt }) => ({ id, directory, trashedAt }))
}

export const moveVaultToTrash = (vaultsRoot, directory) => {
  const source = resolveVaultRoot(vaultsRoot, directory)
  const trash = trashRootFor(vaultsRoot, true)
  const id = randomUUID()
  const item = path.join(trash, id)
  fs.mkdirSync(item, { mode: 0o700 })
  try {
    fs.renameSync(source, path.join(item, directory))
  } catch (error) {
    try { fs.rmdirSync(item) } catch {}
    throw error
  }
  return { id, directory }
}

export const restoreTrashedVault = (vaultsRoot, id) => {
  if (!validId(id)) fail('INVALID_TRASH_ID')
  const trash = trashRootFor(vaultsRoot)
  const entry = trash && readTrashItem(trash, id)
  if (!entry) fail('VAULT_TRASH_NOT_FOUND')
  const destination = path.join(path.dirname(trash), entry.directory)
  if (readDirectory(destination)) fail('VAULT_ALREADY_EXISTS')
  fs.renameSync(entry.source, destination)
  try { fs.rmdirSync(entry.item) } catch {}
  return { directory: entry.directory }
}
