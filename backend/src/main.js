import path from 'node:path'
import { openDatabase } from './database.js'
import { createApp } from './app.js'
import { prepareVaultsRoot } from './vaults/filesystem.js'
import { resolveDatabasePath, resolveVaultsRootConfig } from './runtime-config.js'

const dataDirectory = path.resolve(import.meta.dirname, '../../data')
const dbPath = resolveDatabasePath({
  dataDirectory,
  configuredPath: process.env.AYAME_DATABASE_PATH,
  legacyConfiguredPath: process.env.NIA_DATABASE_PATH,
})

const vaultsRootConfig = resolveVaultsRootConfig({
  defaultPath: path.join(dataDirectory, 'vaults'),
  configuredPath: process.env.AYAME_VAULTS_PATH,
  legacyConfiguredPath: process.env.NIA_VAULTS_PATH,
})
const vaultsRoot = prepareVaultsRoot(vaultsRootConfig.path, {
  createIfMissing: vaultsRootConfig.createIfMissing,
})
const db = openDatabase(dbPath)
const app = createApp({ db, vaultsRoot })

const port = Number(process.env.PORT) || 3000
const host = '127.0.0.1'

try {
  await app.listen({ port, host })
} catch (err) {
  app.log.error(err)
  await app.close()
  process.exit(1)
}
