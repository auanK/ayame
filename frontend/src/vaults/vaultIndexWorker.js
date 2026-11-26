import { buildVaultIndex } from './vaultIndex.js'

self.onmessage = ({ data: { id, raw } }) => {
  try {
    self.postMessage({ id, index: buildVaultIndex(raw) })
  } catch (error) {
    self.postMessage({ id, error: error.message })
  }
}
