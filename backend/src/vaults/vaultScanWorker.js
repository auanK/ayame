import { parentPort, workerData } from 'node:worker_threads'
import { createVaultSearchIndex } from './vaultSearchIndex.js'
import { collectVaultStats, discoverVaultDirectories } from './discovery.js'

const { vaultsRoot } = workerData
const vaultIndex = createVaultSearchIndex(vaultsRoot)

parentPort.on('message', ({ id, directory, type, value }) => {
  if (type === 'invalidate') {
    vaultIndex.invalidate()
    return
  }
  try {
    let result
    if (directory === null) {
      const directories = discoverVaultDirectories(vaultsRoot)
      const stats = new Map(directories.map((name) => [name, collectVaultStats(vaultsRoot, name)]))
      result = { directories, stats }
    } else if (type === 'search') result = vaultIndex.search(directory, value)
    else if (type === 'mentions') result = vaultIndex.mentions(directory, value)
    else result = vaultIndex.scan(directory)
    parentPort.postMessage({ id, result })
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, code: error.code } })
  }
})
