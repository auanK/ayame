import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVaultRoot, resolveMutableVaultPath } from './filesystem.js'
import { detectImageMime, extensionForImageMime } from './images.js'

export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // 5 MiB

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const RESERVED_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\..*)?$/i
const FORBIDDEN_NAME_CHARS = /[\x00-\x1f\x7f/\\:<>?"|*]/

const fail = (code, message) => {
  const err = new Error(message)
  err.code = code
  throw err
}

const isWithin = (root, target) => {
  const relative = path.relative(root, target)
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}

const syncDirectory = (dirPath) => {
  if (process.platform === 'win32') return
  const fd = fs.openSync(dirPath, fs.constants.O_RDONLY)
  try {
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
}

const validateFolderPath = (rawFolderPath) => {
  if (rawFolderPath === '' || rawFolderPath === undefined) return ''
  if (
    typeof rawFolderPath !== 'string' ||
    rawFolderPath.includes('\0') ||
    rawFolderPath.includes('\\') ||
    rawFolderPath.startsWith('/') ||
    /^[a-zA-Z]:/.test(rawFolderPath)
  ) {
    fail('INVALID_VAULT_PATH', 'Invalid folder path')
  }
  const segments = rawFolderPath.split('/')
  for (const seg of segments) {
    if (
      !seg ||
      seg.trim() !== seg ||
      seg === '.' ||
      seg === '..' ||
      seg === '.trash' ||
      seg === '.obsidian' ||
      seg.startsWith('.') ||
      /[. ]$/.test(seg) ||
      FORBIDDEN_NAME_CHARS.test(seg) ||
      RESERVED_DEVICE_NAME.test(seg) ||
      Buffer.byteLength(seg, 'utf8') > 255
    ) {
      fail('INVALID_VAULT_PATH', 'Invalid attachment folder segment')
    }
  }
  return rawFolderPath
}

const ensureDirectoryChain = (vaultRoot, folderPath) => {
  if (!folderPath) return vaultRoot
  let current = vaultRoot
  for (const seg of folderPath.split('/')) {
    const next = path.join(current, seg)
    if (!isWithin(vaultRoot, next)) {
      fail('INVALID_VAULT_PATH', 'Attachment folder escapes vault')
    }
    let stat
    try {
      stat = fs.lstatSync(next)
    } catch (err) {
      if (err.code !== 'ENOENT') throw err
      fs.mkdirSync(next, { recursive: false })
      stat = fs.lstatSync(next)
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      fail('INVALID_VAULT_PATH', 'Attachment folder segment is not a valid directory')
    }
    current = fs.realpathSync.native(next)
    if (!isWithin(vaultRoot, current)) {
      fail('INVALID_VAULT_PATH', 'Attachment folder escapes vault')
    }
  }
  return current
}

const sanitizeBaseStem = (rawFileName) => {
  const base = path.posix.basename(String(rawFileName || 'image').replace(/\\/g, '/'))
  const parsed = path.posix.parse(base)
  let stem = parsed.name
    .replace(FORBIDDEN_NAME_CHARS, '-')
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '')
    .trim()

  if (!stem || stem === '.' || stem === '..' || RESERVED_DEVICE_NAME.test(stem)) {
    stem = `image-${crypto.randomBytes(3).toString('hex')}`
  }
  if (Buffer.byteLength(stem, 'utf8') > 180) {
    stem = stem.slice(0, 120).trim()
  }
  return { stem, originalExt: parsed.ext.toLowerCase() }
}

const pickUniqueFileName = (dirAbs, stem, ext) => {
  const firstCandidate = `${stem}${ext}`
  if (!fs.existsSync(path.join(dirAbs, firstCandidate))) {
    return firstCandidate
  }
  for (let i = 1; i <= 999; i++) {
    const candidate = `${stem}-${i}${ext}`
    if (!fs.existsSync(path.join(dirAbs, candidate))) {
      return candidate
    }
  }
  return `${stem}-${Date.now()}${ext}`
}

export const saveVaultAttachment = (
  vaultsRoot,
  directory,
  { folderPath = 'Attachments', fileName = 'image' } = {},
  buffer
) => {
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const cleanFolder = validateFolderPath(folderPath)

  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    fail('UNSUPPORTED_IMAGE_TYPE', 'Attachment must be a non-empty PNG, JPEG, WebP, or GIF image')
  }
  if (buffer.length > MAX_ATTACHMENT_BYTES) {
    fail('VAULT_ATTACHMENT_TOO_LARGE', 'Attachment exceeds 5 MiB limit')
  }

  const mime = detectImageMime(buffer)
  if (!mime) {
    fail('UNSUPPORTED_IMAGE_TYPE', 'Only PNG, JPEG, WebP, and GIF attachments are supported')
  }

  const targetDirAbs = ensureDirectoryChain(vaultRoot, cleanFolder)
  const { stem, originalExt } = sanitizeBaseStem(fileName)
  const expectedExt = extensionForImageMime(mime)
  const finalExt = mime === 'image/jpeg' && originalExt === '.jpeg' ? '.jpeg' : expectedExt
  const finalName = pickUniqueFileName(targetDirAbs, stem, finalExt)
  const targetAbs = path.join(targetDirAbs, finalName)

  if (!isWithin(vaultRoot, targetAbs)) {
    fail('INVALID_VAULT_PATH', 'Attachment path escapes vault')
  }

  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | (fs.constants.O_NOFOLLOW ?? 0)
  const fd = fs.openSync(targetAbs, flags, 0o666)
  try {
    let offset = 0
    while (offset < buffer.length) {
      offset += fs.writeSync(fd, buffer, offset, buffer.length - offset)
    }
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  syncDirectory(targetDirAbs)

  const relativePath = cleanFolder ? `${cleanFolder}/${finalName}` : finalName
  return {
    directory,
    path: relativePath,
    name: finalName,
    mimeType: mime,
  }
}

export const readVaultMedia = (vaultsRoot, directory, rawPath) => {
  if (typeof rawPath !== 'string' || rawPath.length === 0 || rawPath.trim() === '') {
    fail('INVALID_VAULT_PATH', 'Media path is required')
  }
  const segments = rawPath.split(/[/\\]+/)
  if (segments[0] === '.trash' || segments[0] === '.obsidian') {
    fail('INVALID_VAULT_PATH', 'Media path is restricted')
  }

  const ext = path.posix.extname(rawPath).toLowerCase()
  if (!IMAGE_EXTENSIONS.has(ext)) {
    fail('UNSUPPORTED_IMAGE_TYPE', 'Unsupported media extension')
  }

  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const resolved = resolveMutableVaultPath(vaultRoot, rawPath)
  if (resolved.type !== 'file') {
    fail('VAULT_PATH_NOT_FILE', 'Media path is not a file')
  }

  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  let fd
  try {
    fd = fs.openSync(resolved.absolutePath, flags)
  } catch (err) {
    if (err.code === 'ENOENT') fail('VAULT_PATH_NOT_FOUND', 'Media file not found')
    if (err.code === 'ELOOP') fail('INVALID_VAULT_PATH', 'Symbolic links are not permitted')
    throw err
  }

  try {
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) fail('VAULT_PATH_NOT_FILE', 'Media path is not a regular file')
    if (stat.size > MAX_ATTACHMENT_BYTES) {
      fail('VAULT_ATTACHMENT_TOO_LARGE', 'Media file exceeds 5 MiB limit')
    }
    const buffer = fs.readFileSync(fd)
    const mimeType = detectImageMime(buffer)
    if (!mimeType) {
      fail('UNSUPPORTED_IMAGE_TYPE', 'Media content is not a supported image')
    }
    return { buffer, mimeType }
  } finally {
    fs.closeSync(fd)
  }
}
