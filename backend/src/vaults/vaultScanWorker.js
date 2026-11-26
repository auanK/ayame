import { parentPort, workerData } from 'node:worker_threads'
import { scanVaultIndex } from './operations.js'
import { collectVaultStats, discoverVaultDirectories } from './discovery.js'

const { vaultsRoot } = workerData

parentPort.on('message', ({ id, directory }) => {
  try {
    let result
    if (directory === null) {
      const directories = discoverVaultDirectories(vaultsRoot)
      const stats = new Map(directories.map((name) => [name, collectVaultStats(vaultsRoot, name)]))
      result = { directories, stats }
    } else {
      result = scanVaultIndex(vaultsRoot, directory)
    }
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
  }
})
