import { buildVaultIndex } from './vaultIndex.js'

export function createVaultIndexBuilder() {
  const pending = new Map()
  let worker
  let lastId = 0
  let closed = false

  function stop(error) {
    worker?.terminate()
    worker = null
    for (const { reject } of pending.values()) reject(error)
    pending.clear()
  }

  function startWorker() {
    const thread = new Worker(new URL('./vaultIndexWorker.js', import.meta.url), { type: 'module' })
    thread.onmessage = ({ data: { id, index, error } }) => {
      const request = pending.get(id)
      if (!request) return
      pending.delete(id)
      if (error) request.reject(new Error(error))
      else request.resolve(index)
    }
    thread.onerror = (error) => {
      if (worker === thread) stop(new Error(error.message || 'Vault index worker stopped'))
    }
    thread.onmessageerror = () => {
      if (worker === thread) stop(new Error('Invalid vault index worker response'))
    }
    return thread
  }

  return {
    async build(raw) {
      if (closed) throw new Error('Vault index builder closed')
      if (typeof Worker !== 'function') return buildVaultIndex(raw)
      try {
        worker ??= startWorker()
        const id = ++lastId
        return await new Promise((resolve, reject) => {
          worker.postMessage({ id, raw })
          pending.set(id, { resolve, reject })
        })
      } catch (error) {
        if (closed) throw error
        return buildVaultIndex(raw)
      }
    },
    close() {
      closed = true
      stop(new Error('Vault index builder closed'))
    },
  }
}
