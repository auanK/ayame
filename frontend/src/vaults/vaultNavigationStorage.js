import { validateNoteQueryParam } from '../router/index.js'

const prefix = 'ayame:vault-navigation:v1:'
const isNotePath = (path) => validateNoteQueryParam(path).valid

export function loadVaultNavigation(directory) {
  try {
    const state = JSON.parse(localStorage.getItem(prefix + directory))
    const tabs = Array.isArray(state?.tabs) ? [...new Set(state.tabs.filter(isNotePath))] : []
    return { tabs, active: isNotePath(state?.active) ? state.active : null }
  } catch {
    return { tabs: [], active: null }
  }
}

export function saveVaultNavigation(directory, tabs, active) {
  try {
    if (tabs.length || active) {
      localStorage.setItem(prefix + directory, JSON.stringify({ tabs, active }))
    } else {
      localStorage.removeItem(prefix + directory)
    }
  } catch {}
}

export function clearVaultNavigation() {
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const key = localStorage.key(i)
      if (key?.startsWith(prefix)) localStorage.removeItem(key)
    }
  } catch {}
}
