const apiError = (code) => {
  const error = new Error(code)
  error.code = code
  return error
}

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024

const request = async (url, options, failureCode) => {
  try {
    return await fetch(url, options)
  } catch {
    throw apiError(failureCode)
  }
}

const readJson = async (response) => {
  try {
    return await response.json()
  } catch {
    throw apiError('INVALID_VAULT_RESPONSE')
  }
}

const validateVault = (vault) => {
  if (
    !vault
    || typeof vault !== 'object'
    || Array.isArray(vault)
    || typeof vault.name !== 'string'
    || vault.name.length === 0
    || typeof vault.directory !== 'string'
    || vault.directory.length === 0
    || typeof vault.registered !== 'boolean'
    || (vault.registered && (typeof vault.id !== 'string' || vault.id.length === 0))
    || (!vault.registered && vault.id !== null)
  ) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return {
    id: vault.id,
    name: vault.name,
    directory: vault.directory,
    registered: vault.registered,
  }
}

const errorResponseCode = async (response, failureCode) => {
  let code
  try {
    code = (await response.json())?.error
  } catch {}

  if (response.status === 400 && ['INVALID_VAULT_NAME', 'INVALID_VAULT_DIRECTORY'].includes(code)) {
    return code
  }
  if (response.status === 409 && code === 'VAULT_ALREADY_REGISTERED') {
    return code
  }
  return failureCode
}

export const getVaults = async () => {
  const response = await request('/vaults', {
    method: 'GET',
    credentials: 'same-origin',
  }, 'FAILED_TO_FETCH_VAULTS')

  if (response.status === 401) {
    throw apiError('UNAUTHORIZED')
  }
  if (response.status !== 200) {
    throw apiError('FAILED_TO_FETCH_VAULTS')
  }

  const data = await readJson(response)
  if (!data || typeof data !== 'object' || Array.isArray(data) || !Array.isArray(data.vaults)) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return { vaults: data.vaults.map(validateVault) }
}

export const registerVault = async ({ name, directory }) => {
  const response = await request('/vaults', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, directory }),
  }, 'FAILED_TO_REGISTER_VAULT')

  if (response.status === 401) {
    throw apiError('UNAUTHORIZED')
  }
  if (response.status !== 201) {
    throw apiError(await errorResponseCode(response, 'FAILED_TO_REGISTER_VAULT'))
  }

  const data = await readJson(response)
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  const vault = validateVault(data.vault)
  if (!vault.registered) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }
  return { vault }
}

export const unregisterVault = async (id) => {
  const response = await request(`/vaults/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    credentials: 'same-origin',
  }, 'FAILED_TO_UNREGISTER_VAULT')

  if (response.status === 401) {
    throw apiError('UNAUTHORIZED')
  }
  if (response.status !== 204) {
    throw apiError('FAILED_TO_UNREGISTER_VAULT')
  }
  return { ok: true }
}

const validateEntry = (entry) => {
  if (
    !entry
    || typeof entry !== 'object'
    || Array.isArray(entry)
    || typeof entry.name !== 'string'
    || entry.name.length === 0
    || !['directory', 'file'].includes(entry.type)
    || (entry.path !== null && typeof entry.path !== 'string')
  ) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return {
    name: entry.name,
    path: entry.path,
    type: entry.type,
  }
}

export const getVaultEntries = async (directory, path = '') => {
  const query = path ? `?path=${encodeURIComponent(path)}` : ''
  const url = `/vaults/${encodeURIComponent(directory)}/entries${query}`
  const response = await request(url, {
    method: 'GET',
    credentials: 'same-origin',
  }, 'FAILED_TO_FETCH_ENTRIES')

  if (response.status === 401) {
    throw apiError('UNAUTHORIZED')
  }
  if (response.status !== 200) {
    let errorCode
    try {
      errorCode = (await response.json())?.error
    } catch {}
    if (['INVALID_VAULT_DIRECTORY', 'INVALID_VAULT_PATH', 'VAULT_PATH_NOT_FOUND', 'VAULT_PATH_NOT_DIRECTORY'].includes(errorCode)) {
      throw apiError(errorCode)
    }
    throw apiError('FAILED_TO_FETCH_ENTRIES')
  }

  const data = await readJson(response)
  if (
    !data
    || typeof data !== 'object'
    || Array.isArray(data)
    || typeof data.directory !== 'string'
    || data.directory.length === 0
    || typeof data.path !== 'string'
    || !Array.isArray(data.entries)
  ) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return {
    directory: data.directory,
    path: data.path,
    entries: data.entries.map(validateEntry),
  }
}

export const getVaultMarkdown = async (directory, path) => {
  const query = `?path=${encodeURIComponent(path ?? '')}`
  const url = `/vaults/${encodeURIComponent(directory ?? '')}/content${query}`
  const response = await request(url, {
    method: 'GET',
    credentials: 'same-origin',
  }, 'FAILED_TO_FETCH_MARKDOWN')

  if (response.status === 401) {
    throw apiError('UNAUTHORIZED')
  }
  if (response.status !== 200) {
    let errorCode
    try {
      errorCode = (await response.json())?.error
    } catch {}
    if ([
      'INVALID_VAULT_DIRECTORY',
      'INVALID_VAULT_PATH',
      'VAULT_PATH_NOT_FOUND',
      'VAULT_PATH_NOT_FILE',
      'UNSUPPORTED_FILE_TYPE',
      'VAULT_FILE_TOO_LARGE',
      'INVALID_FILE_ENCODING',
    ].includes(errorCode)) {
      throw apiError(errorCode)
    }
    throw apiError('FAILED_TO_FETCH_MARKDOWN')
  }

  const data = await readJson(response)
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.directory !== 'string' ||
    typeof data.path !== 'string' ||
    typeof data.content !== 'string' ||
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision) ||
    data.directory !== directory ||
    data.path !== path
  ) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return {
    directory: data.directory,
    path: data.path,
    content: data.content,
    revision: data.revision,
  }
}

export const saveVaultMarkdown = async (directory, path, { content, expectedRevision }) => {
  const url = `/vaults/${encodeURIComponent(directory ?? '')}/content?path=${encodeURIComponent(path ?? '')}`
  const response = await request(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content, expectedRevision }),
  }, 'VAULT_SAVE_RESULT_UNKNOWN')

  if (response.status === 401) throw apiError('UNAUTHORIZED')
  if (response.status !== 200) {
    let errorCode
    try {
      errorCode = (await response.json())?.error
    } catch {}
    if (response.status === 409 && errorCode === 'VAULT_FILE_CONFLICT') throw apiError(errorCode)
    if (response.status === 404 && errorCode === 'VAULT_PATH_NOT_FOUND') throw apiError(errorCode)
    if (response.status === 400 && errorCode === 'VAULT_PATH_NOT_FILE') throw apiError(errorCode)
    if (response.status === 413 && errorCode === 'VAULT_FILE_TOO_LARGE') throw apiError(errorCode)
    if (response.status === 423 && errorCode === 'VAULT_FILE_LOCKED') throw apiError(errorCode)
    if (response.status === 415 && errorCode === 'UNSUPPORTED_FILE_TYPE') throw apiError(errorCode)
    if (response.status === 400 && ['INVALID_VAULT_DIRECTORY', 'INVALID_VAULT_PATH', 'VAULT_PATH_NOT_FILE', 'INVALID_MARKDOWN_PAYLOAD'].includes(errorCode)) {
      throw apiError(errorCode)
    }
    if (response.status === 422 && ['INVALID_FILE_ENCODING', 'INVALID_MARKDOWN_CONTENT'].includes(errorCode)) {
      throw apiError(errorCode)
    }
    if (response.status === 500 && errorCode === 'VAULT_SAVE_RESULT_UNKNOWN') throw apiError(errorCode)
    throw apiError('VAULT_SAVE_RESULT_UNKNOWN')
  }

  let data
  try {
    data = await readJson(response)
  } catch {
    throw apiError('VAULT_SAVE_RESULT_UNKNOWN')
  }
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.directory !== 'string' ||
    typeof data.path !== 'string' ||
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision) ||
    data.directory !== directory ||
    data.path !== path
  ) {
    throw apiError('VAULT_SAVE_RESULT_UNKNOWN')
  }

  return { directory: data.directory, path: data.path, revision: data.revision }
}

const CREATE_ERROR_CODES = [
  'INVALID_VAULT_DIRECTORY',
  'INVALID_VAULT_PATH',
  'INVALID_CREATE_PAYLOAD',
  'INVALID_ENTRY_NAME',
  'VAULT_PATH_NOT_FOUND',
  'VAULT_PATH_NOT_DIRECTORY',
  'VAULT_ENTRY_EXISTS',
  'UNSUPPORTED_FILE_TYPE',
  'VAULT_CREATE_FAILED',
  'VAULT_CREATE_RESULT_UNKNOWN',
]

export const createVaultFolder = async (directory, { parentPath = '', name }) => {
  const url = `/vaults/${encodeURIComponent(directory ?? '')}/folders`
  const response = await request(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name }),
  }, 'FAILED_TO_CREATE_FOLDER')

  if (response.status === 401) throw apiError('UNAUTHORIZED')
  if (response.status !== 201) {
    let errorCode
    try {
      errorCode = (await response.json())?.error
    } catch {}
    if (CREATE_ERROR_CODES.includes(errorCode)) {
      throw apiError(errorCode)
    }
    throw apiError('FAILED_TO_CREATE_FOLDER')
  }

  const data = await readJson(response)
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.directory !== 'string' ||
    data.directory !== directory ||
    typeof data.path !== 'string' ||
    data.path.length === 0 ||
    typeof data.name !== 'string' ||
    data.name.length === 0
  ) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return {
    directory: data.directory,
    path: data.path,
    name: data.name,
  }
}

export const createVaultNote = async (directory, { parentPath = '', name }) => {
  const url = `/vaults/${encodeURIComponent(directory ?? '')}/notes`
  const response = await request(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ parentPath, name }),
  }, 'FAILED_TO_CREATE_NOTE')

  if (response.status === 401) throw apiError('UNAUTHORIZED')
  if (response.status !== 201) {
    let errorCode
    try {
      errorCode = (await response.json())?.error
    } catch {}
    if (CREATE_ERROR_CODES.includes(errorCode)) {
      throw apiError(errorCode)
    }
    throw apiError('FAILED_TO_CREATE_NOTE')
  }

  const data = await readJson(response)
  if (
    !data ||
    typeof data !== 'object' ||
    Array.isArray(data) ||
    typeof data.directory !== 'string' ||
    data.directory !== directory ||
    typeof data.path !== 'string' ||
    data.path.length === 0 ||
    typeof data.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(data.revision)
  ) {
    throw apiError('INVALID_VAULT_RESPONSE')
  }

  return {
    directory: data.directory,
    path: data.path,
    revision: data.revision,
  }
}
