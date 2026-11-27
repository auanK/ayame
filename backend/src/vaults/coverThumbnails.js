import { createHash } from 'node:crypto'

const MAX_CACHED_THUMBNAILS = 32
const MAX_CACHED_BYTES = 16 * 1024 * 1024
const MAX_INPUT_PIXELS = 24_000_000

const hash = (buffer) => createHash('sha256').update(buffer).digest('hex')

export const resizeImageThumbnail = async (buffer, { animated = false, width = 640, height = 320 } = {}) => {
  const { default: sharp } = await import('sharp')
  return sharp(buffer, { animated, limitInputPixels: MAX_INPUT_PIXELS })
    .autoOrient()
    .resize({ width, height, fit: 'inside', withoutEnlargement: true })
    .webp({ quality: 72, effort: 2 })
    .toBuffer()
}

const createThumbnail = async ({ buffer, mimeType }, sourceHash) => {
  const animated = mimeType === 'image/gif' || mimeType === 'image/webp'
  const resized = await resizeImageThumbnail(buffer, { animated }).catch(() => null)
  if (resized && resized.length < buffer.length) {
    return { buffer: resized, mimeType: 'image/webp', etag: `"${hash(resized)}"` }
  }
  return { buffer, mimeType, etag: `"${sourceHash}"` }
}

export const createCoverThumbnailCache = () => {
  const cached = new Map()
  const pending = new Map()
  let cachedBytes = 0
  let tail = Promise.resolve()

  return (cover) => {
    const key = hash(cover.buffer)
    const existing = cached.get(key)
    if (existing) {
      cached.delete(key)
      cached.set(key, existing)
      return existing
    }
    if (pending.has(key)) return pending.get(key)

    // Share concurrent requests for the same cover and bound native decoding work.
    const job = tail.then(async () => {
      const thumbnail = await createThumbnail(cover, key)
      cached.set(key, thumbnail)
      cachedBytes += thumbnail.buffer.length
      while (cached.size > MAX_CACHED_THUMBNAILS || cachedBytes > MAX_CACHED_BYTES) {
        const oldest = cached.keys().next().value
        cachedBytes -= cached.get(oldest).buffer.length
        cached.delete(oldest)
      }
      return thumbnail
    }).finally(() => pending.delete(key))
    tail = job.catch(() => {})
    pending.set(key, job)
    return job
  }
}
