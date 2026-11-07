import { listVaults, registerVault, unregisterVault } from './registry.js'
import { listVaultEntries } from './browser.js'
import { readVaultMarkdown } from './reader.js'

export const registerVaultRoutes = (app, db, vaultsRoot) => {
  app.get('/vaults', async (req, reply) => {
    const vaults = listVaults(db, vaultsRoot)
    return reply.send({ vaults })
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

  app.post('/vaults', async (req, reply) => {
    const { name, directory } = req.body || {}
    try {
      const vault = registerVault(db, vaultsRoot, { name, directory })
      return reply.code(201).send({
        vault: {
          id: vault.id,
          name: vault.name,
          directory: vault.directory,
          registered: true,
        },
      })
    } catch (err) {
      if (err.code === 'INVALID_VAULT_NAME') {
        return reply.code(400).send({ error: 'INVALID_VAULT_NAME' })
      }
      if (err.code === 'INVALID_VAULT_DIRECTORY') {
        return reply.code(400).send({ error: 'INVALID_VAULT_DIRECTORY' })
      }
      if (err.code === 'VAULT_ALREADY_REGISTERED') {
        return reply.code(409).send({ error: 'VAULT_ALREADY_REGISTERED' })
      }
      throw err
    }
  })

  app.delete('/vaults/:id', async (req, reply) => {
    const { id } = req.params
    unregisterVault(db, id)
    return reply.code(204).send()
  })
}
