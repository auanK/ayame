import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { resolveVaultRoot, resolveExistingVaultPath, resolveMutableVaultPath } from './filesystem.js'
import { readVaultMarkdown } from './reader.js'
import { saveVaultMarkdown } from './writer.js'

const SUPPORTED_NOTE_EXTENSIONS = new Set(['.md', '.markdown'])
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

export const isInternalVaultArtifact = (name) =>
  name === '.trash' ||
  name.endsWith('.ayame.lock') ||
  /^\..*\.ayame-[a-f0-9]+\.tmp$/i.test(name)

const validateEntryRelativePath = (relativePath, { allowTrash = false } = {}) => {
  if (typeof relativePath !== 'string' || relativePath.length === 0 || relativePath.trim() === '') {
    fail('INVALID_VAULT_PATH', 'Vault path must be a non-empty string')
  }

  if (
    relativePath.includes('\0') ||
    relativePath.includes('\\') ||
    relativePath.startsWith('/') ||
    /^[a-zA-Z]:/.test(relativePath)
  ) {
    fail('INVALID_VAULT_PATH', 'Invalid vault path format')
  }

  const segments = relativePath.split('/')
  if (segments.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    fail('INVALID_VAULT_PATH', 'Invalid vault path segments')
  }

  if (!allowTrash && segments[0] === '.trash') {
    fail('INVALID_VAULT_PATH', 'Direct access to .trash is not permitted')
  }

  return relativePath
}

const validateTargetSegmentName = (name) => {
  if (
    typeof name !== 'string' ||
    name.length === 0 ||
    name.trim() !== name ||
    name === '.' ||
    name === '..' ||
    name === '.trash' ||
    /[. ]$/.test(name) ||
    FORBIDDEN_NAME_CHARS.test(name) ||
    RESERVED_DEVICE_NAME.test(name) ||
    Buffer.byteLength(name, 'utf8') > 255
  ) {
    fail('INVALID_ENTRY_NAME', 'Invalid entry name')
  }
}

const validateTargetRelativePath = (targetPath) => {
  const normalized = validateEntryRelativePath(targetPath)
  for (const segment of normalized.split('/')) {
    validateTargetSegmentName(segment)
  }
  return normalized
}

const hasLockForFile = (absoluteFilePath) => {
  const lockPath = path.join(
    path.dirname(absoluteFilePath),
    `.${path.basename(absoluteFilePath)}.ayame.lock`
  )
  return fs.existsSync(lockPath)
}

const verifyNoLocksOrSymlinksInTree = (absolutePath, type) => {
  const lstat = fs.lstatSync(absolutePath)
  if (lstat.isSymbolicLink()) {
    fail('INVALID_VAULT_PATH', 'Symbolic links are not permitted')
  }

  if (type === 'file') {
    if (hasLockForFile(absolutePath)) {
      fail('VAULT_FILE_LOCKED', 'Vault file is currently locked')
    }
    return 0
  }

  let descendantCount = 0
  const walk = (dirPath) => {
    const entries = fs.readdirSync(dirPath, { withFileTypes: true })
    for (const dirent of entries) {
      if (dirent.name.endsWith('.ayame.lock')) {
        fail('VAULT_FILE_LOCKED', 'A file inside the folder is currently locked')
      }
      if (dirent.isSymbolicLink()) {
        fail('INVALID_VAULT_PATH', 'Symbolic links are not permitted inside vault folders')
      }
      const childPath = path.join(dirPath, dirent.name)
      if (dirent.isDirectory()) {
        descendantCount += 1
        walk(childPath)
      } else if (dirent.isFile()) {
        if (hasLockForFile(childPath)) {
          fail('VAULT_FILE_LOCKED', 'A file inside the folder is currently locked')
        }
        descendantCount += 1
      }
    }
  }

  walk(absolutePath)
  return descendantCount
}

const ensureDirectoryChain = (vaultRoot, relativeParentPath) => {
  if (!relativeParentPath) return vaultRoot
  let current = vaultRoot
  for (const seg of relativeParentPath.split('/')) {
    validateTargetSegmentName(seg)
    const next = path.join(current, seg)
    if (!isWithin(vaultRoot, next)) {
      fail('INVALID_VAULT_PATH', 'Target path escapes the vault')
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
      fail('VAULT_PATH_NOT_DIRECTORY', 'Target parent path is not a directory')
    }
    current = fs.realpathSync.native(next)
    if (!isWithin(vaultRoot, current)) {
      fail('INVALID_VAULT_PATH', 'Target parent directory escapes the vault')
    }
  }
  return current
}

export const scanVaultIndex = (vaultsRoot, directory) => {
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const folders = []
  const files = []
  const notes = []
  const failures = []

  const walk = (currentAbsDir, relativePrefix) => {
    let entries
    try {
      entries = fs.readdirSync(currentAbsDir, { withFileTypes: true })
    } catch (err) {
      failures.push({
        path: relativePrefix || '.',
        reason: err.code || 'VAULT_READ_FAILED',
      })
      return
    }

    for (const dirent of entries) {
      if (dirent.isSymbolicLink()) continue
      if (isInternalVaultArtifact(dirent.name)) continue
      if (
        dirent.name.includes('/') ||
        dirent.name.includes('\\') ||
        dirent.name.includes('\0') ||
        dirent.name === '.' ||
        dirent.name === '..'
      ) {
        continue
      }

      const relPath = relativePrefix === '' ? dirent.name : `${relativePrefix}/${dirent.name}`
      const absPath = path.join(currentAbsDir, dirent.name)

      if (dirent.isDirectory()) {
        folders.push(relPath)
        walk(absPath, relPath)
      } else if (dirent.isFile()) {
        files.push(relPath)
        const ext = path.posix.extname(dirent.name).toLowerCase()
        if (SUPPORTED_NOTE_EXTENSIONS.has(ext)) {
          try {
            const read = readVaultMarkdown(vaultsRoot, directory, relPath)
            notes.push({
              path: relPath,
              name: dirent.name,
              content: read.content,
              revision: read.revision,
            })
          } catch (err) {
            failures.push({
              path: relPath,
              reason: err.code || 'VAULT_READ_FAILED',
            })
          }
        }
      }
    }
  }

  walk(vaultRoot, '')

  folders.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
  files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }) || a.localeCompare(b))
  notes.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path))
  failures.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }) || a.path.localeCompare(b.path))

  return {
    directory,
    complete: failures.length === 0,
    failures,
    folders,
    files,
    notes,
  }
}

const stripNoteExt = (p) => p.replace(/\.(md|markdown)$/i, '')

const normalizeRelativeLookup = (fromFilePath, rawTarget) => {
  const cleaned = rawTarget.trim().replace(/\\/g, '/')
  if (!cleaned) return null
  if (!cleaned.startsWith('./') && !cleaned.startsWith('../')) {
    return cleaned.replace(/^\/+/, '')
  }
  const baseDir = path.posix.dirname(fromFilePath || '')
  const joined = baseDir === '.' ? path.posix.normalize(cleaned) : path.posix.normalize(`${baseDir}/${cleaned}`)
  if (joined === '..' || joined.startsWith('../')) return null
  return joined
}

const resolveUniqueTargetBeforeMove = (rawTarget, sourceNotePath, allFilesBeforeMove) => {
  const lookup = normalizeRelativeLookup(sourceNotePath, rawTarget)
  if (!lookup) return null

  const lookupLower = lookup.toLowerCase()
  const lookupNoExt = stripNoteExt(lookupLower)
  const hasExplicitSlash = rawTarget.includes('/')

  if (hasExplicitSlash) {
    const exactMatches = allFilesBeforeMove.filter((filePath) => {
      const lower = filePath.toLowerCase()
      return lower === lookupLower || stripNoteExt(lower) === lookupNoExt
    })
    return exactMatches.length === 1 ? exactMatches[0] : null
  }

  // Root exact match or unique basename match across the vault
  const basenameMatches = allFilesBeforeMove.filter((filePath) => {
    const baseLower = path.posix.basename(filePath).toLowerCase()
    return baseLower === lookupLower || stripNoteExt(baseLower) === lookupNoExt
  })

  if (basenameMatches.length === 1) {
    return basenameMatches[0]
  }
  return null
}

const partitionMarkdownForLinkRewrite = (text) => {
  const segments = []
  let cursor = 0
  const len = text.length

  // 1. Check for YAML Frontmatter at start of file
  let frontmatterEnd = 0
  if (text.startsWith('---')) {
    const endMatch = text.match(/^---[ \t]*\r?\n([\s\S]*?\r?\n)(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/)
    if (endMatch) {
      const frontmatterFull = endMatch[0]
      segments.push({ type: 'frontmatter', value: frontmatterFull })
      cursor = frontmatterFull.length
      frontmatterEnd = cursor
    }
  }

  let textStart = cursor

  while (cursor < len) {
    // 2. Obsidian comment %% ... %%
    if (text.startsWith('%%', cursor)) {
      if (cursor > textStart) {
        segments.push({ type: 'text', value: text.slice(textStart, cursor) })
      }
      const closeIdx = text.indexOf('%%', cursor + 2)
      if (closeIdx !== -1) {
        segments.push({ type: 'literal', value: text.slice(cursor, closeIdx + 2) })
        cursor = closeIdx + 2
      } else {
        segments.push({ type: 'literal', value: text.slice(cursor) })
        cursor = len
      }
      textStart = cursor
      continue
    }

    // 3. Indented code block: lines starting with 4 spaces or tab, preceded by blank line or document start
    const isLineStart = cursor === 0 || text[cursor - 1] === '\n'
    if (isLineStart) {
      let precededByBlankLine = false
      if (cursor === 0 || (frontmatterEnd && cursor === frontmatterEnd)) {
        precededByBlankLine = true
      } else {
        const prevNewline = text.lastIndexOf('\n', cursor - 2)
        const prevLine = text.slice(prevNewline + 1, cursor - 1)
        if (prevLine.trim() === '') {
          precededByBlankLine = true
        }
      }

      if (precededByBlankLine) {
        const isIndented = text.startsWith('    ', cursor) || text.startsWith('\t', cursor)
        if (isIndented) {
          let scanPos = cursor
          let lastIndentedEnd = -1

          while (scanPos < len) {
            const nextNl = text.indexOf('\n', scanPos)
            const lineEnd = nextNl === -1 ? len : nextNl + 1
            const line = nextNl === -1 ? text.slice(scanPos) : text.slice(scanPos, nextNl)

            if (line.startsWith('    ') || line.startsWith('\t')) {
              lastIndentedEnd = lineEnd
              scanPos = lineEnd
            } else if (line.trim() === '') {
              scanPos = lineEnd
            } else {
              break
            }
          }

          if (lastIndentedEnd > cursor) {
            if (cursor > textStart) {
              segments.push({ type: 'text', value: text.slice(textStart, cursor) })
            }
            segments.push({ type: 'literal', value: text.slice(cursor, lastIndentedEnd) })
            cursor = lastIndentedEnd
            textStart = cursor
            continue
          }
        }
      }
    }

    // 4. Fenced code block: ``` or ~~~
    if (isLineStart) {
      let spaceCount = 0
      while (cursor + spaceCount < len && (text[cursor + spaceCount] === ' ' || text[cursor + spaceCount] === '\t')) {
        spaceCount++
      }
      const fenceChar = text[cursor + spaceCount]
      if (spaceCount <= 3 && (fenceChar === '`' || fenceChar === '~')) {
        let fenceLen = 0
        while (cursor + spaceCount + fenceLen < len && text[cursor + spaceCount + fenceLen] === fenceChar) {
          fenceLen++
        }
        if (fenceLen >= 3) {
          if (cursor > textStart) {
            segments.push({ type: 'text', value: text.slice(textStart, cursor) })
          }
          const fenceStr = fenceChar.repeat(fenceLen)
          const lineEnd = text.indexOf('\n', cursor + spaceCount + fenceLen)
          let blockEnd = -1
          if (lineEnd === -1) {
            blockEnd = len
          } else {
            let searchPos = lineEnd + 1
            while (searchPos < len) {
              const nextLineEnd = text.indexOf('\n', searchPos)
              const line = nextLineEnd === -1 ? text.slice(searchPos) : text.slice(searchPos, nextLineEnd)
              const trimmedLine = line.trimStart()
              const leadingSpaces = line.length - trimmedLine.length
              if (leadingSpaces <= 3 && trimmedLine.startsWith(fenceStr)) {
                const afterFence = trimmedLine.slice(fenceLen).trim()
                if (afterFence === '' || afterFence.startsWith(fenceChar)) {
                  blockEnd = nextLineEnd === -1 ? len : nextLineEnd + 1
                  break
                }
              }
              if (nextLineEnd === -1) break
              searchPos = nextLineEnd + 1
            }
          }
          if (blockEnd === -1) blockEnd = len
          segments.push({ type: 'literal', value: text.slice(cursor, blockEnd) })
          cursor = blockEnd
          textStart = cursor
          continue
        }
      }
    }

    // 4. Escaped link: \[[...]] or \[[...#...] or \[...](...)
    if (text[cursor] === '\\' && cursor + 1 < len && text[cursor + 1] === '[') {
      if (text.startsWith('\\[\\[', cursor)) {
        if (cursor > textStart) {
          segments.push({ type: 'text', value: text.slice(textStart, cursor) })
        }
        const closeIdx = text.indexOf(']]', cursor + 3)
        if (closeIdx !== -1) {
          segments.push({ type: 'literal', value: text.slice(cursor, closeIdx + 2) })
          cursor = closeIdx + 2
        } else {
          segments.push({ type: 'literal', value: text.slice(cursor) })
          cursor = len
        }
        textStart = cursor
        continue
      }
      const matchEscMd = text.slice(cursor).match(/^\\\[[^\]\r\n]*\]\([^)\r\n]+\)/)
      if (matchEscMd) {
        if (cursor > textStart) {
          segments.push({ type: 'text', value: text.slice(textStart, cursor) })
        }
        segments.push({ type: 'literal', value: matchEscMd[0] })
        cursor += matchEscMd[0].length
        textStart = cursor
        continue
      }
      if (cursor > textStart) {
        segments.push({ type: 'text', value: text.slice(textStart, cursor) })
      }
      segments.push({ type: 'literal', value: '\\[' })
      cursor += 2
      textStart = cursor
      continue
    }

    // 5. Inline code: `...`
    if (text[cursor] === '`') {
      let tickCount = 0
      while (cursor + tickCount < len && text[cursor + tickCount] === '`') {
        tickCount++
      }
      if (cursor > textStart) {
        segments.push({ type: 'text', value: text.slice(textStart, cursor) })
      }
      const tickStr = '`'.repeat(tickCount)
      const closeIdx = text.indexOf(tickStr, cursor + tickCount)
      if (closeIdx !== -1) {
        segments.push({ type: 'literal', value: text.slice(cursor, closeIdx + tickCount) })
        cursor = closeIdx + tickCount
      } else {
        segments.push({ type: 'literal', value: text.slice(cursor) })
        cursor = len
      }
      textStart = cursor
      continue
    }

    cursor++
  }

  if (cursor > textStart) {
    segments.push({ type: 'text', value: text.slice(textStart, cursor) })
  }

  return segments
}

const rewriteWikilinksInString = (
  str,
  noteOldPath,
  allFilesBeforeMove,
  allFilesAfterMove,
  movedFileMap
) => {
  return str.replace(
    /(!?\[\[)([^\]|#\r\n]+)(#[^\]|\r\n]*)?(\|[^\]\r\n]*)?(\]\])/g,
    (fullMatch, openBrackets, rawTarget, anchorPart = '', aliasPart = '', closeBrackets) => {
      const trimmedTarget = rawTarget.trim()
      if (!trimmedTarget) return fullMatch

      const resolvedOld = resolveUniqueTargetBeforeMove(trimmedTarget, noteOldPath, allFilesBeforeMove)
      if (!resolvedOld || !movedFileMap.has(resolvedOld)) {
        return fullMatch
      }

      const resolvedNew = movedFileMap.get(resolvedOld)
      const hadExplicitExt = /\.(md|markdown)$/i.test(trimmedTarget)
      const hadSlash = trimmedTarget.includes('/')

      const newBase = path.posix.basename(resolvedNew)
      const newStem = stripNoteExt(newBase)
      const newStemLower = newStem.toLowerCase()

      const postMoveBasenameCollisions = allFilesAfterMove.filter(
        (filePath) => stripNoteExt(path.posix.basename(filePath)).toLowerCase() === newStemLower
      )

      const useFullPath = hadSlash || postMoveBasenameCollisions.length > 1
      let replacementTarget
      if (useFullPath) {
        replacementTarget = hadExplicitExt ? resolvedNew : stripNoteExt(resolvedNew)
      } else {
        replacementTarget = hadExplicitExt ? newBase : newStem
      }

      return `${openBrackets}${replacementTarget}${anchorPart}${aliasPart}${closeBrackets}`
    }
  )
}

const rewriteMarkdownLinksInString = (
  str,
  noteOldPath,
  noteNewPath,
  allFilesBeforeMove,
  movedFileMap
) => {
  return str.replace(
    /(!?\[(?:[^\]\\]|\\.)*\]\()([^)\r\n]+)(\))/g,
    (fullMatch, prefix, rawHref, suffix) => {
      const trimmedHref = rawHref.trim()
      if (
        !trimmedHref ||
        trimmedHref.startsWith('#') ||
        /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmedHref) ||
        trimmedHref.startsWith('//')
      ) {
        return fullMatch
      }

      const hashIndex = trimmedHref.indexOf('#')
      const pathPartRaw = hashIndex >= 0 ? trimmedHref.slice(0, hashIndex) : trimmedHref
      const anchorPart = hashIndex >= 0 ? trimmedHref.slice(hashIndex) : ''

      let decodedPath
      try {
        decodedPath = decodeURIComponent(pathPartRaw)
      } catch {
        decodedPath = pathPartRaw
      }

      const resolvedOld = resolveUniqueTargetBeforeMove(decodedPath, noteOldPath, allFilesBeforeMove)
      if (!resolvedOld) return fullMatch

      const targetMoved = movedFileMap.has(resolvedOld)
      const sourceMoved =
        noteOldPath !== noteNewPath &&
        (decodedPath.startsWith('./') || decodedPath.startsWith('../') || decodedPath.includes('/'))
      if (!targetMoved && !sourceMoved) {
        return fullMatch
      }

      const resolvedNew = movedFileMap.get(resolvedOld) || resolvedOld
      const fromDir = path.posix.dirname(noteNewPath)
      let relPath = fromDir === '.' ? resolvedNew : path.posix.relative(fromDir, resolvedNew)

      if (decodedPath.startsWith('./') && !relPath.startsWith('.')) {
        relPath = `./${relPath}`
      }

      const encodedPath = relPath
        .split('/')
        .map((seg) => seg.replace(/ /g, '%20'))
        .join('/')

      return `${prefix}${encodedPath}${anchorPart}${suffix}`
    }
  )
}

const rewriteLinksInNoteContent = (
  content,
  noteOldPath,
  noteNewPath,
  allFilesBeforeMove,
  allFilesAfterMove,
  movedFileMap
) => {
  const segments = partitionMarkdownForLinkRewrite(content)
  const rewritten = segments.map((seg) => {
    if (seg.type === 'literal') {
      return seg.value
    }
    if (seg.type === 'frontmatter') {
      return rewriteWikilinksInString(
        seg.value,
        noteOldPath,
        allFilesBeforeMove,
        allFilesAfterMove,
        movedFileMap
      )
    }
    const afterWiki = rewriteWikilinksInString(
      seg.value,
      noteOldPath,
      allFilesBeforeMove,
      allFilesAfterMove,
      movedFileMap
    )
    return rewriteMarkdownLinksInString(
      afterWiki,
      noteOldPath,
      noteNewPath,
      allFilesBeforeMove,
      movedFileMap
    )
  })
  return rewritten.join('')
}

export const relocateVaultEntry = (vaultsRoot, directory, rawPayload) => {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    fail('INVALID_OPERATION_PAYLOAD', 'Invalid relocate payload')
  }

  const sourcePath = validateEntryRelativePath(rawPayload.sourcePath)
  const targetPath = validateTargetRelativePath(rawPayload.targetPath)
  const updateLinks = rawPayload.updateLinks !== false
  const expectedRevision = rawPayload.expectedRevision

  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const sourceResolved = resolveMutableVaultPath(vaultRoot, sourcePath)

  verifyNoLocksOrSymlinksInTree(sourceResolved.absolutePath, sourceResolved.type)

  if (sourceResolved.type === 'file') {
    const sourceExt = path.posix.extname(sourcePath).toLowerCase()
    const targetExt = path.posix.extname(targetPath).toLowerCase()
    if (SUPPORTED_NOTE_EXTENSIONS.has(sourceExt) && !SUPPORTED_NOTE_EXTENSIONS.has(targetExt)) {
      fail('UNSUPPORTED_FILE_TYPE', 'Markdown notes must keep a .md or .markdown extension')
    }
    if (SUPPORTED_NOTE_EXTENSIONS.has(sourceExt)) {
      if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
        fail('INVALID_OPERATION_PAYLOAD', 'Markdown notes require a valid 64-character hex expectedRevision')
      }
      const current = readVaultMarkdown(vaultsRoot, directory, sourcePath)
      if (current.revision !== expectedRevision) {
        fail('VAULT_FILE_CONFLICT', 'Note changed before rename or move')
      }
    }
  }

  if (sourcePath === targetPath) {
    return {
      directory,
      oldPath: sourcePath,
      newPath: targetPath,
      updatedFiles: [],
      failedFiles: [],
    }
  }

  if (
    sourceResolved.type === 'directory' &&
    (targetPath === sourcePath || targetPath.startsWith(`${sourcePath}/`))
  ) {
    fail('INVALID_VAULT_MOVE', 'Cannot move a folder into itself')
  }

  const targetParentRel = path.posix.dirname(targetPath) === '.' ? '' : path.posix.dirname(targetPath)
  const targetParentAbs = ensureDirectoryChain(vaultRoot, targetParentRel)
  const targetAbs = path.join(targetParentAbs, path.posix.basename(targetPath))

  if (!isWithin(vaultRoot, targetAbs)) {
    fail('INVALID_VAULT_PATH', 'Target path escapes the vault')
  }

  try {
    const destStat = fs.lstatSync(targetAbs, { bigint: true })
    if (destStat.isSymbolicLink()) {
      fail('INVALID_VAULT_PATH', 'Target path is a symbolic link')
    }
    const sourceLstat = fs.lstatSync(sourceResolved.absolutePath, { bigint: true })
    const sameInode =
      destStat.dev === sourceLstat.dev &&
      destStat.ino === sourceLstat.ino &&
      sourcePath.toLowerCase() === targetPath.toLowerCase()
    if (!sameInode) {
      fail('VAULT_ENTRY_EXISTS', 'Target path already exists')
    }
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  const indexBefore = scanVaultIndex(vaultsRoot, directory)
  const movedFileMap = new Map()
  if (sourceResolved.type === 'file') {
    movedFileMap.set(sourcePath, targetPath)
  } else {
    const prefix = `${sourcePath}/`
    for (const filePath of indexBefore.files) {
      if (filePath.startsWith(prefix)) {
        movedFileMap.set(filePath, `${targetPath}/${filePath.slice(prefix.length)}`)
      }
    }
  }

  const allFilesBeforeMove = indexBefore.files
  const allFilesAfterMove = allFilesBeforeMove.map((f) => movedFileMap.get(f) || f)

  fs.renameSync(sourceResolved.absolutePath, targetAbs)

  const updatedFiles = []
  const failedFiles = []

  if (updateLinks && movedFileMap.size > 0) {
    for (const note of indexBefore.notes) {
      const noteOldPath = note.path
      const noteNewPath = movedFileMap.get(noteOldPath) || noteOldPath
      const rewritten = rewriteLinksInNoteContent(
        note.content,
        noteOldPath,
        noteNewPath,
        allFilesBeforeMove,
        allFilesAfterMove,
        movedFileMap
      )

      if (rewritten !== note.content) {
        try {
          saveVaultMarkdown(vaultsRoot, directory, noteNewPath, {
            content: rewritten,
            expectedRevision: note.revision,
          })
          updatedFiles.push(noteNewPath)
        } catch {
          failedFiles.push(noteNewPath)
        }
      }
    }
  }

  return {
    directory,
    oldPath: sourcePath,
    newPath: targetPath,
    updatedFiles,
    failedFiles,
  }
}

const ensureTrashDirectory = (vaultRoot) => {
  const trashDir = path.join(vaultRoot, '.trash')
  if (!fs.existsSync(trashDir)) {
    fs.mkdirSync(trashDir, { recursive: false })
  }
  const stat = fs.lstatSync(trashDir)
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    fail('INVALID_VAULT_PATH', 'Invalid .trash directory')
  }
  return trashDir
}

const validateTrashId = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{6,80}$/.test(id)) {
    fail('INVALID_TRASH_ID', 'Invalid trash item identifier')
  }
  return id
}

export const moveVaultEntryToTrash = (vaultsRoot, directory, rawPayload) => {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    fail('INVALID_OPERATION_PAYLOAD', 'Invalid trash payload')
  }

  const relativePath = validateEntryRelativePath(rawPayload.path)
  const expectedRevision = rawPayload.expectedRevision

  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const resolved = resolveMutableVaultPath(vaultRoot, relativePath)

  const descendantCount = verifyNoLocksOrSymlinksInTree(resolved.absolutePath, resolved.type)

  const ext = path.posix.extname(relativePath).toLowerCase()
  const isNote = resolved.type === 'file' && SUPPORTED_NOTE_EXTENSIONS.has(ext)
  if (isNote) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      fail('INVALID_OPERATION_PAYLOAD', 'Markdown notes require a valid 64-character hex expectedRevision')
    }
    const current = readVaultMarkdown(vaultsRoot, directory, relativePath)
    if (current.revision !== expectedRevision) {
      fail('VAULT_FILE_CONFLICT', 'File changed before deletion')
    }
  }

  const trashDir = ensureTrashDirectory(vaultRoot)
  const id = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}`
  const entryTrashPath = path.join(trashDir, `${id}.entry`)
  const metaTrashPath = path.join(trashDir, `${id}.meta.json`)

  const metadata = {
    id,
    originalPath: relativePath,
    name: path.posix.basename(relativePath),
    type: resolved.type,
    deletedAt: new Date().toISOString(),
    descendantCount,
    status: 'pending',
  }

  // 1. Write metadata with status: pending BEFORE renaming entry
  fs.writeFileSync(metaTrashPath, JSON.stringify(metadata, null, 2), 'utf8')

  // 2. Rename entry into .trash
  try {
    fs.renameSync(resolved.absolutePath, entryTrashPath)
  } catch (renameErr) {
    try {
      fs.unlinkSync(metaTrashPath)
    } catch {}
    throw renameErr
  }

  // 3. Mark committed
  try {
    metadata.status = 'committed'
    fs.writeFileSync(metaTrashPath, JSON.stringify(metadata, null, 2), 'utf8')
  } catch (metaErr) {
    fail(
      'VAULT_TRASH_RESULT_UNKNOWN',
      `Trash entry was moved to .trash but post-commit metadata write failed: ${metaErr.message}`
    )
  }

  return {
    directory,
    ...metadata,
  }
}

export const listVaultTrash = (vaultsRoot, directory) => {
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const trashDir = path.join(vaultRoot, '.trash')
  if (!fs.existsSync(trashDir)) {
    return { directory, items: [] }
  }

  const lstat = fs.lstatSync(trashDir)
  if (lstat.isSymbolicLink() || !lstat.isDirectory()) {
    fail('INVALID_VAULT_PATH', 'Invalid .trash directory')
  }

  const entries = fs.readdirSync(trashDir, { withFileTypes: true })
  const items = []
  const loadedEntryIds = new Set()

  // First pass: inspect all .meta.json files
  for (const dirent of entries) {
    if (!dirent.isFile() || dirent.isSymbolicLink() || !dirent.name.endsWith('.meta.json')) {
      continue
    }
    const metaFilePath = path.join(trashDir, dirent.name)
    try {
      const raw = fs.readFileSync(metaFilePath, 'utf8')
      const parsed = JSON.parse(raw)
      if (!parsed || typeof parsed.id !== 'string') continue

      const entryPath = path.join(trashDir, `${parsed.id}.entry`)
      const entryExists = fs.existsSync(entryPath)

      // Reconcile pending / interrupted operation
      if (parsed.status === 'pending') {
        if (!entryExists) {
          // Stale pending metadata where entry was never renamed -> clean up safely
          try {
            fs.unlinkSync(metaFilePath)
          } catch {}
          continue
        } else {
          // Rename succeeded before interruption -> heal to committed
          parsed.status = 'committed'
          try {
            fs.writeFileSync(metaFilePath, JSON.stringify(parsed, null, 2), 'utf8')
          } catch {}
        }
      }

      if (!entryExists) {
        continue
      }

      loadedEntryIds.add(parsed.id)
      items.push({
        id: parsed.id,
        originalPath: parsed.originalPath,
        name: parsed.name,
        type: parsed.type,
        deletedAt: parsed.deletedAt,
        descendantCount: parsed.descendantCount ?? 0,
      })
    } catch {
      // Malformed metadata file will be handled below if matching .entry exists
    }
  }

  // Second pass: discover orphaned .entry files (without valid meta.json)
  for (const dirent of entries) {
    if (dirent.isSymbolicLink() || !dirent.name.endsWith('.entry')) {
      continue
    }
    const entryId = dirent.name.slice(0, -6)
    if (!entryId || loadedEntryIds.has(entryId)) {
      continue
    }

    const entryPath = path.join(trashDir, dirent.name)
    try {
      const entryStat = fs.lstatSync(entryPath)
      const isDir = entryStat.isDirectory()
      const inferredName = isDir ? entryId : `${entryId}.md`
      const inferredOriginalPath = isDir ? `recovered/${entryId}` : `recovered/${inferredName}`

      const reconstructedMeta = {
        id: entryId,
        originalPath: inferredOriginalPath,
        name: inferredName,
        type: isDir ? 'directory' : 'file',
        deletedAt: entryStat.mtime.toISOString(),
        descendantCount: 0,
        status: 'committed',
        recovered: true,
      }

      // Write reconstructed metadata so subsequent operations (like restore) work cleanly
      const metaFilePath = path.join(trashDir, `${entryId}.meta.json`)
      try {
        fs.writeFileSync(metaFilePath, JSON.stringify(reconstructedMeta, null, 2), 'utf8')
      } catch {}

      loadedEntryIds.add(entryId)
      items.push({
        id: entryId,
        originalPath: reconstructedMeta.originalPath,
        name: reconstructedMeta.name,
        type: reconstructedMeta.type,
        deletedAt: reconstructedMeta.deletedAt,
        descendantCount: reconstructedMeta.descendantCount,
      })
    } catch {}
  }

  items.sort((a, b) => String(b.deletedAt).localeCompare(String(a.deletedAt)) || b.id.localeCompare(a.id))

  return {
    directory,
    items,
  }
}

export const restoreVaultTrashEntry = (vaultsRoot, directory, rawPayload) => {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    fail('INVALID_TRASH_ID', 'Invalid trash restore payload')
  }

  const id = validateTrashId(rawPayload.id)
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const trashDir = path.join(vaultRoot, '.trash')
  const metaPath = path.join(trashDir, `${id}.meta.json`)
  const entryPath = path.join(trashDir, `${id}.entry`)

  if (!fs.existsSync(metaPath) || !fs.existsSync(entryPath)) {
    fail('VAULT_TRASH_NOT_FOUND', 'Trash item not found')
  }

  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  const targetRelPath =
    rawPayload.targetPath !== undefined && rawPayload.targetPath !== null && rawPayload.targetPath !== ''
      ? validateTargetRelativePath(rawPayload.targetPath)
      : validateTargetRelativePath(meta.originalPath)

  const parentRel = path.posix.dirname(targetRelPath) === '.' ? '' : path.posix.dirname(targetRelPath)
  const parentAbs = ensureDirectoryChain(vaultRoot, parentRel)
  const targetAbs = path.join(parentAbs, path.posix.basename(targetRelPath))

  if (!isWithin(vaultRoot, targetAbs)) {
    fail('INVALID_VAULT_PATH', 'Restore destination escapes the vault')
  }

  try {
    const destStat = fs.lstatSync(targetAbs)
    if (destStat.isSymbolicLink()) {
      fail('INVALID_VAULT_PATH', 'Restore destination is a symbolic link')
    }
    fail('VAULT_ENTRY_EXISTS', 'Restore destination is already occupied')
  } catch (err) {
    if (err.code !== 'ENOENT') throw err
  }

  fs.renameSync(entryPath, targetAbs)
  fs.unlinkSync(metaPath)

  return {
    directory,
    id,
    path: targetRelPath,
    type: meta.type,
  }
}

export const deleteVaultTrashEntryPermanently = (vaultsRoot, directory, rawId) => {
  const id = validateTrashId(rawId)
  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const trashDir = path.join(vaultRoot, '.trash')
  const metaPath = path.join(trashDir, `${id}.meta.json`)
  const entryPath = path.join(trashDir, `${id}.entry`)

  if (!fs.existsSync(metaPath) && !fs.existsSync(entryPath)) {
    fail('VAULT_TRASH_NOT_FOUND', 'Trash item not found')
  }

  if (fs.existsSync(entryPath)) {
    fs.rmSync(entryPath, { recursive: true, force: false })
  }
  if (fs.existsSync(metaPath)) {
    fs.unlinkSync(metaPath)
  }

  return {
    directory,
    id,
  }
}

export const deleteVaultEntryPermanently = (vaultsRoot, directory, rawPayload) => {
  if (!rawPayload || typeof rawPayload !== 'object' || Array.isArray(rawPayload)) {
    fail('INVALID_OPERATION_PAYLOAD', 'Invalid delete payload')
  }

  const relativePath = validateEntryRelativePath(rawPayload.path)
  const expectedRevision = rawPayload.expectedRevision

  const vaultRoot = resolveVaultRoot(vaultsRoot, directory)
  const resolved = resolveMutableVaultPath(vaultRoot, relativePath)

  verifyNoLocksOrSymlinksInTree(resolved.absolutePath, resolved.type)

  const ext = path.posix.extname(relativePath).toLowerCase()
  const isNote = resolved.type === 'file' && SUPPORTED_NOTE_EXTENSIONS.has(ext)
  if (isNote) {
    if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(expectedRevision)) {
      fail('INVALID_OPERATION_PAYLOAD', 'Markdown notes require a valid 64-character hex expectedRevision')
    }
    const current = readVaultMarkdown(vaultsRoot, directory, relativePath)
    if (current.revision !== expectedRevision) {
      fail('VAULT_FILE_CONFLICT', 'File changed before permanent deletion')
    }
  }

  fs.rmSync(resolved.absolutePath, { recursive: true, force: false })

  return {
    directory,
    path: relativePath,
    type: resolved.type,
  }
}
