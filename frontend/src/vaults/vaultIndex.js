import {
  parseNoteDocument,
  extractAllNoteTags,
  matchesTagQuery,
} from '../markdown/properties.js'
import {
  extractHeadings,
  extractBlocks,
  extractNoteReferences,
  resolveLink,
} from '../markdown/links.js'

const getFileStem = (filePath) => {
  const base = String(filePath || '').split('/').pop() || ''
  return base.replace(/\.(md|markdown)$/i, '')
}

const getSnippetAround = (text, phrase) => {
  if (!text || !phrase) return ''
  const idx = text.toLowerCase().indexOf(phrase.toLowerCase())
  if (idx < 0) return text.slice(0, 120).trim()
  const start = Math.max(0, idx - 40)
  const end = Math.min(text.length, idx + phrase.length + 60)
  return text.slice(start, end).replace(/\r?\n/g, ' ').trim()
}

export const buildVaultIndex = (rawIndex = {}) => {
  const failures = Array.isArray(rawIndex.failures) ? [...rawIndex.failures] : []
  const complete = Boolean(rawIndex.complete) && failures.length === 0
  const folders = Array.isArray(rawIndex.folders) ? [...rawIndex.folders] : []
  const files = Array.isArray(rawIndex.files) ? [...rawIndex.files] : []
  const rawNotes = Array.isArray(rawIndex.notes) ? rawIndex.notes : []

  const aliasesByFile = {}
  const tagsByFile = {}
  const headingsByFile = {}
  const blocksByFile = {}
  const parsedByFile = {}
  const notesByPath = {}
  const propertyNamesSet = new Set()
  const knownPropertyTypes = {}

  for (const note of rawNotes) {
    if (!note || typeof note.path !== 'string') continue
    const content = typeof note.content === 'string' ? note.content : ''
    const parsed = parseNoteDocument(content)
    parsedByFile[note.path] = parsed

    const aliasesProp = parsed.properties.find(
      (p) => p.key.toLowerCase() === 'aliases' || p.key.toLowerCase() === 'alias'
    )
    const aliases = Array.isArray(aliasesProp?.value)
      ? aliasesProp.value.map((a) => String(a).trim()).filter(Boolean)
      : typeof aliasesProp?.value === 'string' && aliasesProp.value.trim()
        ? [aliasesProp.value.trim()]
        : []
    aliasesByFile[note.path] = aliases

    for (const prop of parsed.properties) {
      propertyNamesSet.add(prop.key)
      if (!knownPropertyTypes[prop.key]) {
        knownPropertyTypes[prop.key] = prop.type
      }
    }

    const tags = extractAllNoteTags(content)
    tagsByFile[note.path] = tags

    const headings = extractHeadings(parsed.body)
    const blocks = extractBlocks(parsed.body)
    headingsByFile[note.path] = headings
    blocksByFile[note.path] = blocks

    const titleProp = parsed.properties.find((p) => p.key.toLowerCase() === 'title')
    const title =
      typeof titleProp?.value === 'string' && titleProp.value.trim()
        ? titleProp.value.trim()
        : getFileStem(note.path)

    notesByPath[note.path] = {
      path: note.path,
      name: note.name || note.path.split('/').pop(),
      title,
      content,
      body: parsed.body,
      revision: note.revision || '',
      properties: parsed.properties,
      aliases,
      tags,
      headings,
      blocks,
    }
  }

  // Ensure all files from rawNotes are in files array
  const fileSet = new Set(files)
  for (const notePath of Object.keys(notesByPath)) {
    fileSet.add(notePath)
  }
  const allFiles = Array.from(fileSet).sort((a, b) =>
    a.localeCompare(b, undefined, { sensitivity: 'base' })
  )

  const outgoingByFile = {}
  const backlinksByFile = {}

  for (const filePath of allFiles) {
    backlinksByFile[filePath] = []
  }

  for (const [notePath, noteData] of Object.entries(notesByPath)) {
    const refs = extractNoteReferences(noteData.content)
    const resolvedOutgoing = []

    for (const ref of refs) {
      const resolution = resolveLink({
        sourcePath: notePath,
        linkTarget: ref.raw,
        knownFiles: allFiles,
        aliasesByFile,
        indexComplete: complete,
        kind: ref.kind,
      })

      const inFrontmatter = ref.location === 'property'
      const heading = ref.blockId ? null : ref.anchor || null
      const entry = {
        ...ref,
        rawTarget: ref.target,
        label: ref.alias || ref.target,
        heading,
        inFrontmatter,
        status: resolution.type,
        targetPath: resolution.path || null,
        candidates: resolution.candidates || [],
      }
      resolvedOutgoing.push(entry)

      if (resolution.type === 'resolved' && resolution.path) {
        if (!backlinksByFile[resolution.path]) {
          backlinksByFile[resolution.path] = []
        }
        backlinksByFile[resolution.path].push({
          sourcePath: notePath,
          sourceName: noteData.name,
          sourceTitle: noteData.title,
          raw: ref.raw,
          rawTarget: ref.target,
          label: ref.alias || ref.target,
          heading,
          blockId: ref.blockId || null,
          inFrontmatter,
          snippet: inFrontmatter
            ? `${ref.propertyKey}: ${ref.raw}`
            : getSnippetAround(noteData.body, ref.raw),
        })
      }
    }

    outgoingByFile[notePath] = resolvedOutgoing
  }

  // Aggregate tag counts across the vault
  const tagMap = new Map()
  for (const [notePath, tags] of Object.entries(tagsByFile)) {
    for (const tag of tags) {
      const key = tag.toLowerCase()
      if (!tagMap.has(key)) {
        tagMap.set(key, { tag, count: 0, files: [] })
      }
      const item = tagMap.get(key)
      item.count += 1
      item.files.push(notePath)
    }
  }
  const allTags = Array.from(tagMap.values()).sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' })
  )

  return {
    directory: rawIndex.directory || '',
    complete,
    failures,
    folders,
    files: allFiles,
    rawNotes: Object.values(notesByPath).map((n) => ({
      path: n.path,
      name: n.name,
      content: n.content,
      revision: n.revision,
    })),
    notesByPath,
    aliasesByFile,
    tagsByFile,
    allTags,
    knownPropertyNames: Array.from(propertyNamesSet).sort((a, b) =>
      a.localeCompare(b, undefined, { sensitivity: 'base' })
    ),
    knownPropertyTypes,
    headingsByFile,
    blocksByFile,
    outgoingByFile,
    backlinksByFile,
  }
}

export const updateNoteInVaultIndex = (index, updatedNote) => {
  if (!index || !updatedNote || typeof updatedNote.path !== 'string') return index
  const existingNotes = Array.isArray(index.rawNotes) ? index.rawNotes : []
  const filtered = existingNotes.filter((n) => n.path !== updatedNote.path)
  filtered.push({
    path: updatedNote.path,
    name: updatedNote.name || updatedNote.path.split('/').pop(),
    content: updatedNote.content ?? '',
    revision: updatedNote.revision ?? '',
  })
  const fileSet = new Set(index.files || [])
  fileSet.add(updatedNote.path)
  return buildVaultIndex({
    directory: index.directory,
    complete: index.complete,
    failures: index.failures || [],
    folders: index.folders,
    files: Array.from(fileSet),
    notes: filtered,
  })
}

export const getOutgoingLinksForNote = (index, notePath) => {
  if (!index || !notePath) return { resolved: [], unresolved: [] }
  const all = index.outgoingByFile?.[notePath] || []
  return {
    resolved: all.filter((item) => item.status === 'resolved'),
    unresolved: all.filter((item) => item.status !== 'resolved'),
  }
}

export const getBacklinksForNote = (index, notePath) => {
  if (!index || !notePath) return { linked: [], unlinkedMentions: [] }
  const linked = index.backlinksByFile?.[notePath] || []
  const targetNote = index.notesByPath?.[notePath]
  const stem = getFileStem(notePath)
  const searchTerms = new Set([stem])
  if (targetNote?.title) searchTerms.add(targetNote.title)
  for (const alias of targetNote?.aliases || []) {
    if (alias) searchTerms.add(alias)
  }

  const unlinkedMentions = []
  const linkedSourceSet = new Set(linked.map((b) => b.sourcePath))

  for (const [otherPath, otherNote] of Object.entries(index.notesByPath || {})) {
    if (otherPath === notePath) continue
    if (linkedSourceSet.has(otherPath)) continue
    const bodyText = otherNote.body || ''
    for (const term of searchTerms) {
      if (!term || term.length < 2) continue
      if (bodyText.toLowerCase().includes(term.toLowerCase())) {
        unlinkedMentions.push({
          sourcePath: otherPath,
          sourceName: otherNote.name,
          sourceTitle: otherNote.title,
          matchedTerm: term,
          snippet: getSnippetAround(bodyText, term),
        })
        break
      }
    }
  }

  return { linked, unlinkedMentions }
}

export const getNotesByTag = (index, tagQuery) => {
  if (!index || !tagQuery) return []
  const results = []
  for (const [notePath, tags] of Object.entries(index.tagsByFile || {})) {
    const matchedTags = tags.filter((t) => matchesTagQuery([t], tagQuery))
    if (matchedTags.length > 0) {
      const note = index.notesByPath?.[notePath]
      results.push({
        path: notePath,
        name: note?.name || notePath.split('/').pop(),
        title: note?.title || getFileStem(notePath),
        matchedTags,
      })
    }
  }
  return results.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
}

export const searchVaultNotes = (index, rawQuery) => {
  if (!index) return []
  const query = String(rawQuery || '').trim()
  if (!query) {
    return Object.values(index.notesByPath || {})
      .map((n) => ({
        path: n.path,
        name: n.name,
        title: n.title,
        matchType: 'file',
        snippet: '',
      }))
      .sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
  }

  if (query.startsWith('#') || query.toLowerCase().startsWith('tag:')) {
    const tagQ = query.toLowerCase().startsWith('tag:') ? query.slice(4).trim() : query
    return getNotesByTag(index, tagQ).map((item) => ({
      ...item,
      matchType: 'tag',
      snippet: item.matchedTags.map((t) => `#${t}`).join(' '),
    }))
  }

  const qLower = query.toLowerCase()
  const scored = []

  for (const note of Object.values(index.notesByPath || {})) {
    const nameLower = note.name.toLowerCase()
    const pathLower = note.path.toLowerCase()
    const titleLower = (note.title || '').toLowerCase()
    const aliasMatch = (note.aliases || []).find((a) => a.toLowerCase().includes(qLower))
    const tagMatch = (note.tags || []).find((t) => t.toLowerCase().includes(qLower))

    if (nameLower.includes(qLower) || pathLower.includes(qLower)) {
      scored.push({
        score: nameLower.startsWith(qLower) ? 100 : 90,
        path: note.path,
        name: note.name,
        title: note.title,
        matchType: 'filename',
        snippet: note.path,
      })
    } else if (titleLower.includes(qLower)) {
      scored.push({
        score: 85,
        path: note.path,
        name: note.name,
        title: note.title,
        matchType: 'title',
        snippet: note.title,
      })
    } else if (aliasMatch) {
      scored.push({
        score: 80,
        path: note.path,
        name: note.name,
        title: note.title,
        matchType: 'alias',
        snippet: `Alias: ${aliasMatch}`,
      })
    } else if (tagMatch) {
      scored.push({
        score: 75,
        path: note.path,
        name: note.name,
        title: note.title,
        matchType: 'tag',
        snippet: `#${tagMatch}`,
      })
    } else if (note.content.toLowerCase().includes(qLower)) {
      scored.push({
        score: 60,
        path: note.path,
        name: note.name,
        title: note.title,
        matchType: 'content',
        snippet: getSnippetAround(note.body || note.content, query),
      })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
    .map(({ score, ...rest }) => rest)
}
