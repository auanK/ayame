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

export const login = async ({ username, password, rememberMe } = {}) => {
  const payload = { username, password }
  if (rememberMe === true) {
    payload.rememberMe = true
  }
  const res = await fetch('/auth/login', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  if (res.status === 204) {
    return { ok: true }
  }
  let data
  try {
    data = await res.json()
  } catch {}
  const errorCode = res.status === 429
    ? (data?.error || 'TOO_MANY_ATTEMPTS')
    : (data?.error || 'FAILED_TO_LOGIN')
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

export const getAccount = async () => {
  const res = await fetch('/auth/account', {
    method: 'GET',
    credentials: 'same-origin',
  })
  if (res.status === 401) {
    const err = new Error('UNAUTHORIZED')
    err.code = 'UNAUTHORIZED'
    throw err
  }
  if (!res.ok) {
    const err = new Error('FAILED_TO_FETCH_ACCOUNT')
    err.code = 'FAILED_TO_FETCH_ACCOUNT'
    throw err
  }
  const data = await res.json()
  if (typeof data?.username !== 'string' || typeof data?.activeSessions !== 'number') {
    const err = new Error('INVALID_ACCOUNT_RESPONSE')
    err.code = 'INVALID_ACCOUNT_RESPONSE'
    throw err
  }
  return {
    username: data.username,
    activeSessions: data.activeSessions,
  }
}

export const changePassword = async ({ currentPassword, newPassword }) => {
  const res = await fetch('/auth/password', {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ currentPassword, newPassword }),
  })
  if (res.status === 204) {
    return { ok: true }
  }
  let data
  try {
    data = await res.json()
  } catch {}
  let errorCode = 'FAILED_TO_CHANGE_PASSWORD'
  if (res.status === 401) {
    errorCode = data?.error === 'INVALID_CURRENT_PASSWORD' ? 'INVALID_CURRENT_PASSWORD' : 'UNAUTHORIZED'
  } else if (res.status === 400) {
    errorCode = data?.error || 'INVALID_PASSWORD'
  }
  const err = new Error(errorCode)
  err.code = errorCode
  throw err
}

export const logoutOtherSessions = async () => {
  const res = await fetch('/auth/logout-others', {
    method: 'POST',
    credentials: 'same-origin',
  })
  if (res.status === 401) {
    const err = new Error('UNAUTHORIZED')
    err.code = 'UNAUTHORIZED'
    throw err
  }
  if (!res.ok) {
    const err = new Error('FAILED_TO_LOGOUT_OTHERS')
    err.code = 'FAILED_TO_LOGOUT_OTHERS'
    throw err
  }
  const data = await res.json()
  return {
    revoked: Number(data?.revoked) || 0,
  }
}
