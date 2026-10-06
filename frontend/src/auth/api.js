const validateAuthStatus = (data) => {
  if (
    typeof data?.initialized !== 'boolean'
    || typeof data?.authenticated !== 'boolean'
    || (data.authenticated && !data.initialized)
  ) {
    const err = new Error('INVALID_AUTH_STATUS')
    err.code = 'INVALID_AUTH_STATUS'
    throw err
  }

  return {
    initialized: data.initialized,
    authenticated: data.authenticated,
  }
}

export const getAuthStatus = async () => {
  const res = await fetch('/auth/status', {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (!res.ok) {
    throw new Error('FAILED_TO_FETCH_STATUS')
  }
  const data = await res.json()
  return validateAuthStatus(data)
}

export const createOwner = async ({ username, password }) => {
  const res = await fetch('/auth/owner', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status === 201) {
    return { ok: true }
  }
  let data
  try {
    data = await res.json()
  } catch {}
  const errorCode = data?.error || 'FAILED_TO_CREATE_OWNER'
  const err = new Error(errorCode)
  err.code = errorCode
  throw err
}

export const login = async ({ username, password }) => {
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  if (res.status === 204) {
    return { ok: true }
  }
  let data
  try {
    data = await res.json()
  } catch {}
  const errorCode = data?.error || 'FAILED_TO_LOGIN'
  const err = new Error(errorCode)
  err.code = errorCode
  throw err
}

export const logout = async () => {
  const res = await fetch('/auth/logout', {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (res.status === 204) {
    return { ok: true }
  }
  if (res.status === 401) {
    const err = new Error('UNAUTHORIZED')
    err.code = 'UNAUTHORIZED'
    throw err
  }
  throw new Error('FAILED_TO_LOGOUT')
}
