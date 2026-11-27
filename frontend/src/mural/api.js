const ROOT = '/vaults/mural/cards'

const request = async (path, options) => {
  const response = await fetch(`${ROOT}${path}`, { credentials: 'same-origin', ...options })
  if (response.status === 401) throw Object.assign(new Error('UNAUTHORIZED'), { code: 'UNAUTHORIZED' })
  const data = await response.json()
  if (!response.ok) {
    const code = data?.error || 'MURAL_REQUEST_FAILED'
    throw Object.assign(new Error(code), { code, status: response.status, note: data?.note })
  }
  return data
}

const put = (path, payload) => request(path, {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(payload),
})

export const listMuralCards = ({ archived = false, trashed = false, after, group, signal }) => {
  if (trashed) {
    const query = new URLSearchParams({ trashed: 'true' })
    if (after) query.set('after', after)
    return request(`?${query}`, { signal })
  }
  const query = new URLSearchParams({ archived: String(archived) })
  if (group) query.set('pinned', String(group === 'pinned'))
  else query.set('groups', 'true')
  if (after) query.set('after', after)
  return request(`?${query}`, { signal })
}

export const readMuralNote = (id, signal) => request(`/${encodeURIComponent(id)}`, { signal })

export const writeMuralNote = (id, payload) => put(`/${encodeURIComponent(id)}`, payload)

export const trashMuralNote = (id, revision) => request(`/${encodeURIComponent(id)}/trash?revision=${revision}`, { method: 'POST' })

export const restoreMuralNote = (id, revision) => request(`/${encodeURIComponent(id)}/restore?revision=${revision}`, { method: 'POST' })

export const deleteMuralNote = (id, revision) => request(`/${encodeURIComponent(id)}?revision=${revision}`, { method: 'DELETE' })

export const emptyMuralTrash = () => request('/trash', { method: 'DELETE' })

export const moveMuralNote = (id, payload) => put(`/${encodeURIComponent(id)}/position`, payload)

export const resizeMuralCard = (id, imageWidth) => put(`/${encodeURIComponent(id)}/size`, { imageWidth })

const imagePath = (id) => `/${encodeURIComponent(id)}/image`

export const getMuralImageUrl = (id, version, original = false) => {
  const query = new URLSearchParams({ v: version })
  if (original) query.set('variant', 'original')
  return `${ROOT}${imagePath(id)}?${query}`
}

export const uploadMuralImage = (id, file, revision = null) => {
  const query = revision === null ? 'create=image' : `revision=${revision}`
  return request(`${imagePath(id)}?${query}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
  })
}

export const removeMuralImage = (id, revision) => request(`${imagePath(id)}?revision=${revision}`, { method: 'DELETE' })
