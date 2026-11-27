import * as properties from '../markdown/properties.js'
import {
  extractHeadings,
  extractBlocks,
  extractNoteReferences,
  createLinkLookup,
  resolveLink,
} from '../markdown/links.js'

const MAX_PARSED_NOTE_CACHE = 2000
const parsedNoteCache = new Map()

export const clearVaultIndexCache = () => {
  parsedNoteCache.clear()
}

const parseIndexedNote = (note, content, includeOffsets = false) => {
  const parsed = properties.parseNoteDocument(content)
  const aliasesProp = parsed.properties.find(
    (p) => p.key.toLowerCase() === 'aliases' || p.key.toLowerCase() === 'alias'
  )
  const aliases = Array.isArray(aliasesProp?.value)
    ? aliasesProp.value.map((a) => String(a).trim()).filter(Boolean)
    : typeof aliasesProp?.value === 'string' && aliasesProp.value.trim()
      ? [aliasesProp.value.trim()]
      : []

  const tags = properties.extractAllNoteTags(content, parsed)
  const headings = extractHeadings(parsed.body)
  const blocks = extractBlocks(parsed.body)
  const titleProp = parsed.properties.find((p) => p.key.toLowerCase() === 'title')
  const title =
    typeof titleProp?.value === 'string' && titleProp.value.trim()
      ? titleProp.value.trim()
      : getFileStem(note.path)
  const refs = extractNoteReferences(content, { parsedDoc: parsed, includeOffsets })

  return {
    content,
    parsed,
    aliases,
    tags,
    headings,
    blocks,
    title,
    refs,
  }
}

const getParsedNoteData = (note) => {
  const content = typeof note.content === 'string' ? note.content : ''
  const revision = typeof note.revision === 'string' ? note.revision : ''
  const key = `${note.path}\0${revision}\0${content.length}`
  const cached = parsedNoteCache.get(key)
  if (cached && cached.content === content) {
    parsedNoteCache.delete(key)
    parsedNoteCache.set(key, cached)
    return cached
  }

  const entry = parseIndexedNote(note, content)
  if (parsedNoteCache.size >= MAX_PARSED_NOTE_CACHE) {
    const oldestKey = parsedNoteCache.keys().next().value
    parsedNoteCache.delete(oldestKey)
  }
  parsedNoteCache.set(key, entry)
  return entry
}

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

export const describeVaultNote = (note) => {
  const { content, parsed, aliases, tags, headings, blocks, title, refs } = parseIndexedNote(note, note.content ?? '', true)
  return {
    bodyStart: content.length - parsed.body.length,
    note: {
      path: note.path,
      name: note.name || note.path.split('/').pop(),
      revision: note.revision || '',
      metadata: {
        title, aliases, tags, headings,
        blocks: blocks.map(({ text, ...position }) => position),
        properties: parsed.properties.map(({ key, type }) => ({ key, type })),
        refs: refs.map(({ offset, ...ref }) => ({
          ...ref,
          snippet: (ref.location === 'property'
            ? `${ref.propertyKey}: ${ref.raw}`
            : parsed.body.slice(Math.max(0, offset - 40), Math.min(offset + ref.raw.length + 60, offset + 120))
              .replace(/\r?\n/g, ' ').trim()).slice(0, 160),
        })),
      },
    },
  }
}

export const buildVaultIndex = (rawIndex = {}) => {
  const failures = Array.isArray(rawIndex.failures) ? [...rawIndex.failures] : []
  const complete = Boolean(rawIndex.complete) && failures.length === 0
  const folders = Array.isArray(rawIndex.folders) ? [...rawIndex.folders] : []
  const files = Array.isArray(rawIndex.files) ? [...rawIndex.files] : []
  const rawNotes = Array.isArray(rawIndex.notes) ? rawIndex.notes : []
  const metadataOnly = rawIndex.metadataOnly === true

  const aliasesByFile = {}
  const tagsByFile = {}
  const headingsByFile = {}
  const blocksByFile = {}
  const notesByPath = {}
  const sourceNotes = new Map()
  const propertyNamesSet = new Set()
  const knownPropertyTypes = {}

  for (const rawNote of rawNotes) {
    if (!rawNote || typeof rawNote.path !== 'string') continue
    const note = metadataOnly && !rawNote.metadata ? describeVaultNote(rawNote).note : rawNote
    const data = note.metadata ?? getParsedNoteData(note)
    const { parsed, aliases, tags, headings, blocks, title, content } = data
    const propertyDefinitions = parsed?.properties ?? data.properties
    aliasesByFile[note.path] = aliases

    for (const prop of propertyDefinitions) {
      propertyNamesSet.add(prop.key)
      if (!knownPropertyTypes[prop.key]) {
        knownPropertyTypes[prop.key] = prop.type
      }
    }

    tagsByFile[note.path] = tags
    headingsByFile[note.path] = headings
    blocksByFile[note.path] = blocks

    notesByPath[note.path] = {
      path: note.path,
      name: note.name || note.path.split('/').pop(),
      title,
      content,
      body: parsed?.body,
      revision: note.revision || '',
      properties: propertyDefinitions,
      aliases,
      tags,
      headings,
      blocks,
      refs: data.refs,
    }
    sourceNotes.set(note.path, note.metadata ? note : {
      path: note.path,
      name: notesByPath[note.path].name,
      content,
      revision: notesByPath[note.path].revision,
    })
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
  const lookup = createLinkLookup(allFiles, aliasesByFile)

  for (const filePath of allFiles) {
    backlinksByFile[filePath] = []
  }

  for (const [notePath, noteData] of Object.entries(notesByPath)) {
    const refs = noteData.refs || extractNoteReferences(noteData.content)
    const resolvedOutgoing = []

    for (const ref of refs) {
      const resolution = resolveLink({
        sourcePath: notePath,
        linkTarget: ref.raw,
        lookup,
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
          snippet: ref.snippet ?? (inFrontmatter
            ? `${ref.propertyKey}: ${ref.raw}`
            : getSnippetAround(noteData.body, ref.raw)),
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
    metadataOnly,
    rawNotes: Array.from(sourceNotes.values()),
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
    metadataOnly: index.metadataOnly,
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

export const getMentionTerms = (index, notePath) => {
  const targetNote = index.notesByPath?.[notePath]
  const stem = getFileStem(notePath)
  const searchTerms = new Set([stem])
  if (targetNote?.title) searchTerms.add(targetNote.title)
  for (const alias of targetNote?.aliases || []) {
    if (alias) searchTerms.add(alias)
  }
  return [...searchTerms].filter((term) => term.length >= 2)
}

export const getBacklinksForNote = (index, notePath, { readText = (note) => note, limit = Infinity } = {}) => {
  if (!index || !notePath) return { linked: [], unlinkedMentions: [] }
  const linked = index.backlinksByFile?.[notePath] || []
  const searchTerms = getMentionTerms(index, notePath)

  const unlinkedMentions = []
  const linkedSourceSet = new Set(linked.map((b) => b.sourcePath))

  for (const [otherPath, otherNote] of Object.entries(index.notesByPath || {})) {
    if (otherPath === notePath) continue
    if (linkedSourceSet.has(otherPath)) continue
    const bodyText = readText(otherNote)?.body || ''
    const foldedBody = bodyText.toLowerCase()
    for (const term of searchTerms) {
      if (foldedBody.includes(term.toLowerCase())) {
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
    if (unlinkedMentions.length >= limit) break
  }

  return { linked, unlinkedMentions }
}

export const getNotesByTag = (index, tagQuery) => {
  if (!index || !tagQuery) return []
  const results = []
  for (const [notePath, tags] of Object.entries(index.tagsByFile || {})) {
    const matchedTags = tags.filter((t) => properties.matchesTagQuery([t], tagQuery))
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

export const searchVaultNotes = (index, rawQuery, { contentMatches, readText = (note) => note, limit = Infinity } = {}) => {
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
      .slice(0, limit)
  }

  if (query.startsWith('#') || query.toLowerCase().startsWith('tag:')) {
    const tagQ = query.toLowerCase().startsWith('tag:') ? query.slice(4).trim() : query
    return getNotesByTag(index, tagQ).slice(0, limit).map((item) => ({
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
    } else if (contentMatches ? contentMatches.has(note.path) : note.content?.toLowerCase().includes(qLower)) {
      scored.push({
        score: 60,
        path: note.path,
        name: note.name,
        title: note.title,
        matchType: 'content',
      })
    }
  }

  return scored
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }))
    .slice(0, limit)
    .map(({ score, ...result }) => {
      if (result.matchType !== 'content') return result
      const text = readText(index.notesByPath[result.path])
      return { ...result, snippet: getSnippetAround(text?.body || text?.content, query) }
    })
}
