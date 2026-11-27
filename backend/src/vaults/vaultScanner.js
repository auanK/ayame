import { Worker } from 'node:worker_threads'

export function createVaultScanner(vaultsRoot) {
  const pending = new Map()
  const inFlight = new Map()
  let worker
  let lastId = 0

  function fail(error) {
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
    inFlight.clear()
  }

  function startWorker() {
    const thread = new Worker(new URL('./vaultScanWorker.js', import.meta.url), {
      workerData: { vaultsRoot },
      execArgv: [],
    })
    thread.on('message', ({ id, result, error }) => {
      const request = pending.get(id)
      if (!request) return
      pending.delete(id)
      if (error) request.reject(Object.assign(new Error(error.message), { code: error.code }))
      else request.resolve(result)
    })
    thread.on('error', (error) => {
      if (worker !== thread) return
      worker = null
      fail(error)
    })
    thread.on('exit', () => {
      if (worker !== thread) return
      worker = null
      fail(new Error('Vault scan worker stopped'))
    })
    return thread
  }

  function request(directory, type, value) {
    const key = JSON.stringify([directory, type, value])
    const existing = inFlight.get(key)
    if (existing) return existing

    const id = ++lastId
    const request = new Promise((resolve, reject) => {
      worker ??= startWorker()
      worker.postMessage({ id, directory, type, value })
      pending.set(id, { resolve, reject })
    }).finally(() => {
      if (inFlight.get(key) === request) inFlight.delete(key)
    })
    inFlight.set(key, request)
    return request
  }

  return {
    scan: (directory = null) => request(directory, 'scan'),
    search: (directory, query) => request(directory, 'search', query),
    mentions: (directory, path) => request(directory, 'mentions', path),
    invalidate() {
      inFlight.clear()
      worker?.postMessage({ type: 'invalidate' })
    },
    async close() {
      const thread = worker
      worker = null
      fail(new Error('Vault scanner closed'))
      if (thread) await thread.terminate()
    },
  }
}
