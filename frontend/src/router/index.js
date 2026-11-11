import { getCurrentInstance, inject } from 'vue'
import {
  createMemoryHistory,
  createRouter,
  createWebHistory,
  routeLocationKey,
  routerKey,
} from 'vue-router'

const PassThroughRouteView = {
  name: 'AyameRouteView',
  render: () => null,
}

const MALFORMED_QUERY_MARKER = '\0MALFORMED_URI'

export const isValidVaultDirectory = (directory) =>
  typeof directory === 'string' &&
  directory.length > 0 &&
  !directory.includes('\0') &&
  !directory.includes('/') &&
  !directory.includes('\\') &&
  directory !== '.' &&
  directory !== '..' &&
  directory.trim() === directory

export const validateNoteQueryParam = (rawNote) => {
  if (rawNote === undefined) {
    return { present: false, valid: true, path: null }
  }
  if (
    rawNote === null ||
    Array.isArray(rawNote) ||
    typeof rawNote !== 'string' ||
    rawNote.length === 0 ||
    rawNote.trim().length === 0 ||
    rawNote.includes('\0') ||
    /[\x00-\x1f\x7f]/.test(rawNote) ||
    rawNote.includes('\\') ||
    rawNote.startsWith('/') ||
    rawNote.endsWith('/') ||
    /^[a-zA-Z]:/.test(rawNote)
  ) {
    return { present: true, valid: false, path: null }
  }

  const segments = rawNote.split('/')
  for (const segment of segments) {
    if (
      !segment ||
      segment.trim().length === 0 ||
      segment === '.' ||
      segment === '..' ||
      segment === '.trash' ||
      segment === '.obsidian' ||
      segment.endsWith('.ayame.lock') ||
      /^\..*\.ayame-[a-f0-9]+\.tmp$/i.test(segment) ||
      /[<>:"|?*]/.test(segment)
    ) {
      return { present: true, valid: false, path: null }
    }
  }

  const fileName = segments[segments.length - 1]
  if (!/\.(md|markdown)$/i.test(fileName)) {
    return { present: true, valid: false, path: null }
  }
  const stem = fileName.replace(/\.(md|markdown)$/i, '').trim()
  if (!stem) {
    return { present: true, valid: false, path: null }
  }

  return { present: true, valid: true, path: rawNote }
}

export const parseAyameQuery = (search) => {
  const query = {}
  if (!search || search === '?') return query

  const rawSearch = search.startsWith('?') ? search.slice(1) : search
  for (const part of rawSearch.split('&')) {
    if (!part) continue
    const eqIdx = part.indexOf('=')
    const rawKey = eqIdx >= 0 ? part.slice(0, eqIdx) : part
    const rawVal = eqIdx >= 0 ? part.slice(eqIdx + 1) : null
    let key
    try {
      key = decodeURIComponent(rawKey.replace(/\+/g, ' '))
    } catch {
      key = MALFORMED_QUERY_MARKER
    }
    let val = null
    if (rawVal !== null) {
      try {
        val = decodeURIComponent(rawVal.replace(/\+/g, ' '))
      } catch {
        val = MALFORMED_QUERY_MARKER
      }
    }
    if (key in query) {
      let current = query[key]
      if (!Array.isArray(current)) {
        current = query[key] = [current]
      }
      current.push(val)
    } else {
      query[key] = val
    }
  }
  return query
}

export const stringifyAyameQuery = (query) => {
  if (!query || typeof query !== 'object') return ''
  const parts = []
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue
    const encodedKey = encodeURIComponent(key)
    if (value === null) {
      parts.push(encodedKey)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        if (item === undefined) continue
        parts.push(item === null ? encodedKey : `${encodedKey}=${encodeURIComponent(String(item))}`)
      }
    } else {
      parts.push(`${encodedKey}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.join('&')
}

export const routes = [
  {
    path: '/',
    name: 'vaults',
    component: PassThroughRouteView,
  },
  {
    path: '/vault/:directory',
    name: 'vault',
    component: PassThroughRouteView,
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: PassThroughRouteView,
  },
]

export const createAyameRouter = (history = createWebHistory()) => {
  const isHistoryObject =
    history && typeof history === 'object' && 'location' in history && typeof history.listen === 'function'
  const resolvedHistory = isHistoryObject ? history : history?.history || createWebHistory()
  if (history && !isHistoryObject && typeof history.initialUrl === 'string') {
    resolvedHistory.replace(history.initialUrl)
  }

  let lastHistoryDelta = 0
  const origListen = resolvedHistory.listen.bind(resolvedHistory)
  resolvedHistory.listen = (callback) =>
    origListen((to, from, info) => {
      lastHistoryDelta =
        typeof info?.delta === 'number' && info.delta !== 0
          ? info.delta
          : info?.direction === 'back'
            ? -1
            : info?.direction === 'forward'
              ? 1
              : 0
      return callback(to, from, info)
    })

  const origPush = resolvedHistory.push.bind(resolvedHistory)
  resolvedHistory.push = (to, data) => {
    lastHistoryDelta = 0
    return origPush(to, data)
  }

  const origReplace = resolvedHistory.replace.bind(resolvedHistory)
  resolvedHistory.replace = (to, data) => {
    lastHistoryDelta = 0
    return origReplace(to, data)
  }

  const router = createRouter({
    history: resolvedHistory,
    routes,
    parseQuery: parseAyameQuery,
    stringifyQuery: stringifyAyameQuery,
  })

  Object.defineProperty(router, 'lastHistoryDelta', {
    get: () => lastHistoryDelta,
    set: (val) => {
      lastHistoryDelta = val
    },
  })

  return router
}

export const useAyameRouter = ({ initialVaultDirectory = null } = {}) => {
  let router = inject(routerKey, null)
  const route = inject(routeLocationKey, null)

  if (!router || !route) {
    const instance = getCurrentInstance()
    const initialUrl = initialVaultDirectory
      ? `/vault/${encodeURIComponent(initialVaultDirectory)}`
      : '/'
    const memoryHistory = createMemoryHistory()
    memoryHistory.replace(initialUrl)
    router = createAyameRouter(memoryHistory)
    if (instance?.appContext?.app) {
      instance.appContext.app.use(router)
    }
  }

  return {
    router,
    route: router.currentRoute,
  }
}

export default createAyameRouter
