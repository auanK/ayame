import {
  MAX_VAULT_COVER_BYTES,
  listRegisteredVaults,
  registerVault,
  createVault,
  updateVaultMetadata,
  reorderVaults,
  setVaultCover,
  getVaultCover,
  clearVaultCover,
  unregisterVault,
} from './registry.js'
import { collectVaultStats, mergeVaults } from './discovery.js'
import { createVaultScanner } from './vaultScanner.js'
import { SUPPORTED_IMAGE_MIMES } from './images.js'
import { createCoverThumbnailCache } from './coverThumbnails.js'
import { MAX_ATTACHMENT_BYTES, saveVaultAttachment, readVaultMedia } from './attachments.js'
import { listVaultEntries } from './browser.js'
import { MAX_MARKDOWN_BYTES, readVaultMarkdown } from './reader.js'
import { saveVaultMarkdown } from './writer.js'
import { createVaultFolder, createVaultNote } from './creator.js'
import { listTrashedVaults, moveVaultToTrash, restoreTrashedVault } from './vaultTrash.js'
import {
  relocateVaultEntry,
  moveVaultEntryToTrash,
  listVaultTrash,
  restoreVaultTrashEntry,
  deleteVaultTrashEntryPermanently,
  deleteVaultEntryPermanently,
} from './operations.js'

const CREATE_ERROR_STATUS = {
  INVALID_VAULT_DIRECTORY: 400,
  INVALID_VAULT_PATH: 400,
  INVALID_CREATE_PAYLOAD: 400,
  INVALID_ENTRY_NAME: 400,
  VAULT_PATH_NOT_DIRECTORY: 400,
  VAULT_PATH_NOT_FOUND: 404,
  VAULT_ENTRY_EXISTS: 409,
  VAULT_FILE_TOO_LARGE: 413,
  UNSUPPORTED_FILE_TYPE: 415,
  VAULT_CREATE_FAILED: 500,
  VAULT_CREATE_RESULT_UNKNOWN: 500,
}

const OPERATION_ERROR_STATUS = {
  INVALID_VAULT_DIRECTORY: 400,
  INVALID_VAULT_PATH: 400,
  INVALID_OPERATION_PAYLOAD: 400,
  INVALID_ENTRY_NAME: 400,
  INVALID_VAULT_MOVE: 400,
  INVALID_TRASH_ID: 400,
  VAULT_PATH_NOT_DIRECTORY: 400,
  VAULT_PATH_NOT_FOUND: 404,
  VAULT_TRASH_NOT_FOUND: 404,
  VAULT_ENTRY_EXISTS: 409,
  VAULT_FILE_CONFLICT: 409,
  UNSUPPORTED_FILE_TYPE: 415,
  VAULT_FILE_LOCKED: 423,
  VAULT_TRASH_RESULT_UNKNOWN: 500,
}

const VAULT_META_ERROR_STATUS = {
  INVALID_VAULT_NAME: 400,
  INVALID_VAULT_DIRECTORY: 400,
  INVALID_VAULT_PATH: 400,
  VAULT_PATH_NOT_FILE: 400,
  INVALID_VAULT_CATEGORY: 400,
  INVALID_VAULT_TAGS: 400,
  INVALID_VAULT_DESCRIPTION: 400,
  INVALID_VAULT_COLOR: 400,
  INVALID_VAULT_PAYLOAD: 400,
  INVALID_VAULT_ORDER: 400,
  INVALID_VAULT_ROOT: 500,
  VAULT_CREATE_FAILED: 500,
  VAULT_PATH_NOT_FOUND: 404,
  VAULT_COVER_NOT_FOUND: 404,
  VAULT_ALREADY_REGISTERED: 409,
  VAULT_ALREADY_EXISTS: 409,
  VAULT_COVER_TOO_LARGE: 413,
  VAULT_ATTACHMENT_TOO_LARGE: 413,
  UNSUPPORTED_IMAGE_TYPE: 415,
}

export const registerVaultRoutes = (app, db, vaultsRoot) => {
  const scanner = createVaultScanner(vaultsRoot)
  const getThumbnail = createCoverThumbnailCache()
  app.addHook('onClose', () => scanner.close())
  app.addHook('onSend', async (req, _reply, payload) => {
    if (req.routeOptions.url?.startsWith('/vaults') && req.method !== 'GET' && req.routeOptions.config?.affectsVault !== false) {
      scanner.invalidate()
    }
    return payload
  })
  app.addContentTypeParser(
    [...SUPPORTED_IMAGE_MIMES, 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body)
    }
  )

  app.get('/vaults', async (req, reply) => {
    const { directories, stats } = await scanner.scan()
    const vaults = mergeVaults(directories, listRegisteredVaults(db), stats)
    return reply.send({ vaults })
  })

  app.get('/vaults/trash', { config: { noStore: true } }, () => ({ items: listTrashedVaults(vaultsRoot) }))

  app.post('/vaults/:directory/trash-vault', { config: { noStore: true } }, (req, reply) => {
    try {
      return moveVaultToTrash(vaultsRoot, req.params.directory)
    } catch (error) {
      const status = VAULT_META_ERROR_STATUS[error.code]
      if (status) return reply.code(status).send({ error: error.code })
      throw error
    }
  })

  app.post('/vaults/trash/:id/restore', { config: { noStore: true } }, (req, reply) => {
    try {
      return restoreTrashedVault(vaultsRoot, req.params.id)
    } catch (error) {
      const status = OPERATION_ERROR_STATUS[error.code] ?? VAULT_META_ERROR_STATUS[error.code]
      if (status) return reply.code(status).send({ error: error.code })
      throw error
    }
  })

  app.get('/vaults/:directory/entries', async (req, reply) => {
    const { directory } = req.params
    const relativePath = req.query?.path ?? ''
    try {
      const result = listVaultEntries(vaultsRoot, directory, relativePath)
      return reply.send(result)
    } catch (err) {
      if (err.code === 'INVALID_VAULT_DIRECTORY') {
        return reply.code(400).send({ error: 'INVALID_VAULT_DIRECTORY' })
      }
      if (err.code === 'INVALID_VAULT_PATH') {
        return reply.code(400).send({ error: 'INVALID_VAULT_PATH' })
      }
      if (err.code === 'VAULT_PATH_NOT_FOUND') {
        return reply.code(404).send({ error: 'VAULT_PATH_NOT_FOUND' })
      }
      if (err.code === 'VAULT_PATH_NOT_DIRECTORY') {
        return reply.code(400).send({ error: 'VAULT_PATH_NOT_DIRECTORY' })
      }
      throw err
    }
  })

  app.get('/vaults/:directory/content', { config: { noStore: true } }, async (req, reply) => {
    const { directory } = req.params
    const relativePath = req.query?.path ?? ''
    try {
      const result = readVaultMarkdown(vaultsRoot, directory, relativePath)
      return reply.send(result)
    } catch (err) {
      if (err.code === 'INVALID_VAULT_DIRECTORY') {
        return reply.code(400).send({ error: 'INVALID_VAULT_DIRECTORY' })
      }
      if (err.code === 'INVALID_VAULT_PATH') {
        return reply.code(400).send({ error: 'INVALID_VAULT_PATH' })
      }
      if (err.code === 'VAULT_PATH_NOT_FOUND') {
        return reply.code(404).send({ error: 'VAULT_PATH_NOT_FOUND' })
      }
      if (err.code === 'VAULT_PATH_NOT_FILE') {
        return reply.code(400).send({ error: 'VAULT_PATH_NOT_FILE' })
      }
      if (err.code === 'UNSUPPORTED_FILE_TYPE') {
        return reply.code(415).send({ error: 'UNSUPPORTED_FILE_TYPE' })
      }
      if (err.code === 'VAULT_FILE_TOO_LARGE') {
        return reply.code(413).send({ error: 'VAULT_FILE_TOO_LARGE' })
      }
      if (err.code === 'INVALID_FILE_ENCODING') {
        return reply.code(422).send({ error: 'INVALID_FILE_ENCODING' })
      }
      throw err
    }
  })

  app.put('/vaults/:directory/content', {
    bodyLimit: MAX_MARKDOWN_BYTES * 6 + 1024,
    config: { noStore: true },
  }, async (req, reply) => {
    try {
      const result = saveVaultMarkdown(
        vaultsRoot,
        req.params.directory,
        req.query?.path ?? '',
        req.body
      )
      return reply.send(result)
    } catch (err) {
      const statusByCode = {
        INVALID_VAULT_DIRECTORY: 400,
        INVALID_VAULT_PATH: 400,
        INVALID_MARKDOWN_PAYLOAD: 400,
        VAULT_PATH_NOT_FOUND: 404,
        VAULT_PATH_NOT_FILE: 400,
        VAULT_FILE_CONFLICT: 409,
        VAULT_FILE_LOCKED: 423,
        VAULT_FILE_TOO_LARGE: 413,
        UNSUPPORTED_FILE_TYPE: 415,
        INVALID_FILE_ENCODING: 422,
        INVALID_MARKDOWN_CONTENT: 422,
        VAULT_SAVE_FAILED: 500,
        VAULT_SAVE_RESULT_UNKNOWN: 500,
      }
      const status = statusByCode[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/:directory/folders', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = createVaultFolder(vaultsRoot, req.params.directory, req.body)
      return reply.code(201).send(result)
    } catch (err) {
      const status = CREATE_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/:directory/notes', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = createVaultNote(vaultsRoot, req.params.directory, req.body)
      return reply.code(201).send(result)
    } catch (err) {
      const status = CREATE_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.get('/vaults/:directory/index', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = await scanner.scan(req.params.directory)
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.get('/vaults/:directory/search', { config: { noStore: true } }, async (req, reply) => {
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
    if (!query || query.length > 256) return reply.code(400).send({ error: 'INVALID_VAULT_SEARCH_QUERY' })
    try {
      const results = await scanner.search(req.params.directory, query)
      return reply.send({ results })
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.get('/vaults/:directory/mentions', { config: { noStore: true } }, async (req, reply) => {
    const path = req.query.path
    if (typeof path !== 'string' || !path.trim() || path.length > 4096) {
      return reply.code(400).send({ error: 'INVALID_VAULT_PATH' })
    }
    try {
      const mentions = await scanner.mentions(req.params.directory, path)
      return reply.send({ mentions })
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/:directory/relocate', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = relocateVaultEntry(vaultsRoot, req.params.directory, req.body)
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.get('/vaults/:directory/trash', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = listVaultTrash(vaultsRoot, req.params.directory)
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/:directory/trash', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = moveVaultEntryToTrash(vaultsRoot, req.params.directory, req.body)
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/:directory/trash/restore', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = restoreVaultTrashEntry(vaultsRoot, req.params.directory, req.body)
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.delete('/vaults/:directory/trash/:id', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = deleteVaultTrashEntryPermanently(vaultsRoot, req.params.directory, req.params.id)
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.delete('/vaults/:directory/entries', { config: { noStore: true } }, async (req, reply) => {
    try {
      const result = deleteVaultEntryPermanently(vaultsRoot, req.params.directory, req.body || { path: req.query?.path ?? '' })
      return reply.send(result)
    } catch (err) {
      const status = OPERATION_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults', { config: { noStore: true } }, async (req, reply) => {
    const { name, directory, category, tags, description, accentColor, pinned } = req.body || {}
    try {
      const vault = registerVault(db, vaultsRoot, {
        name,
        directory,
        category,
        tags,
        description,
        accentColor,
        pinned,
      })
      return reply.code(201).send({
        vault: {
          ...vault,
          ...collectVaultStats(vaultsRoot, vault.directory),
        },
      })
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/create', { config: { noStore: true } }, async (req, reply) => {
    try {
      const vault = createVault(db, vaultsRoot, req.body || {})
      return reply.code(201).send({ vault })
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.put('/vaults/order', { config: { noStore: true } }, async (req, reply) => {
    try {
      const vaults = reorderVaults(db, vaultsRoot, req.body?.directories)
      return reply.send({ vaults })
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.patch('/vaults/:directory', { config: { noStore: true } }, async (req, reply) => {
    try {
      const vault = updateVaultMetadata(db, vaultsRoot, req.params.directory, req.body || {})
      return reply.send({ vault })
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.put('/vaults/:directory/cover', {
    bodyLimit: MAX_VAULT_COVER_BYTES,
    config: { noStore: true },
  }, async (req, reply) => {
    try {
      const vault = setVaultCover(db, vaultsRoot, req.params.directory, req.body)
      return reply.send({ vault })
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.get('/vaults/:directory/cover', async (req, reply) => {
    try {
      const cover = getVaultCover(db, vaultsRoot, req.params.directory)
      reply.header('content-security-policy', "default-src 'none'")
      reply.header('x-content-type-options', 'nosniff')
      reply.header('cache-control', 'private, no-cache')
      if (req.query.variant !== 'thumbnail') {
        return reply.type(cover.mimeType).send(cover.buffer)
      }

      const thumbnail = await getThumbnail(cover)
      reply.header('vary', 'Cookie')
      reply.header('etag', thumbnail.etag)
      if (cover.updatedAt > 0 && req.query.v === String(cover.updatedAt)) {
        reply.header('cache-control', 'private, max-age=300, immutable')
      }
      const validators = req.headers['if-none-match']?.split(',') ?? []
      if (validators.some((tag) => tag.trim() === '*' || tag.trim().replace(/^W\//, '') === thumbnail.etag)) {
        return reply.code(304).send()
      }
      return reply.type(thumbnail.mimeType).send(thumbnail.buffer)
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.delete('/vaults/:directory/cover', { config: { noStore: true } }, async (req, reply) => {
    try {
      const vault = clearVaultCover(db, vaultsRoot, req.params.directory)
      return reply.send({ vault })
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.post('/vaults/:directory/attachments', {
    bodyLimit: MAX_ATTACHMENT_BYTES,
    config: { noStore: true },
  }, async (req, reply) => {
    try {
      const folderPath = req.query?.folderPath ?? 'Attachments'
      const fileName = req.query?.filename ?? 'image'
      const saved = saveVaultAttachment(
        vaultsRoot,
        req.params.directory,
        { folderPath, fileName },
        req.body
      )
      return reply.code(201).send(saved)
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.get('/vaults/:directory/media', async (req, reply) => {
    try {
      const media = readVaultMedia(vaultsRoot, req.params.directory, req.query?.path ?? '')
      reply.header('content-type', media.mimeType)
      reply.header('content-security-policy', "default-src 'none'")
      reply.header('x-content-type-options', 'nosniff')
      reply.header('cache-control', 'private, max-age=300')
      return reply.send(media.buffer)
    } catch (err) {
      const status = VAULT_META_ERROR_STATUS[err.code]
      if (status) return reply.code(status).send({ error: err.code })
      throw err
    }
  })

  app.delete('/vaults/:id', { config: { noStore: true } }, async (req, reply) => {
    const { id } = req.params
    unregisterVault(db, id)
    return reply.code(204).send()
  })
}
