import { listVaults, registerVault, unregisterVault } from './registry.js'

export const registerVaultRoutes = (app, db, vaultsRoot) => {
  app.get('/vaults', async (req, reply) => {
    const vaults = listVaults(db, vaultsRoot)
    return reply.send({ vaults })
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
