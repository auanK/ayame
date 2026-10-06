import path from 'node:path'
import { openDatabase } from './database.js'
import { createApp } from './app.js'
import { prepareVaultsRoot } from './vaults/filesystem.js'

const defaultDbPath = path.resolve(import.meta.dirname, '../../data/nia.sqlite')
const dbPath = process.env.NIA_DATABASE_PATH || defaultDbPath

const defaultVaultsRoot = path.resolve(import.meta.dirname, '../../data/vaults')
const isExplicitRoot = Boolean(process.env.NIA_VAULTS_PATH)
const rawVaultsRoot = process.env.NIA_VAULTS_PATH || defaultVaultsRoot

const vaultsRoot = prepareVaultsRoot(rawVaultsRoot, { createIfMissing: !isExplicitRoot })
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
