const apiError = (code) => {
  const error = new Error(code)
  error.code = code
  return error
}

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
