import { parseDocument, isMap, isSeq, isScalar, isAlias, YAMLMap, YAMLSeq } from 'yaml'

export const PROPERTY_TYPES = ['text', 'list', 'number', 'checkbox', 'date', 'datetime', 'tags']

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME_RE = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/
const NUMBER_RE = /^[+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?$/i
const INCOMPLETE_NUMBER_RE = /^[+-]?(?:\d+\.?|\.\d*)?(?:e[+-]?\d*)?$/i
const VALID_TAG_CHAR_RE = /^[\p{L}\p{N}_\-/]+$/u
const ONLY_DIGITS_RE = /^\d+$/
const isValidDate = (value) => DATE_RE.test(value) &&
  Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
  new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value

const detectLineEnding = (text) => {
  if (typeof text !== 'string') return '\n'
  const crlfCount = (text.match(/\r\n/g) || []).length
  const lfCount = (text.match(/(?<!\r)\n/g) || []).length
  return crlfCount > lfCount && crlfCount > 0 ? '\r\n' : '\n'
}

export const splitFrontmatter = (fullMarkdown) => {
  if (typeof fullMarkdown !== 'string') {
    return {
      hasFrontmatter: false,
      rawYaml: '',
      body: '',
      closingDelimiter: '---',
      lineEnding: '\n',
    }
  }

  const lineEnding = detectLineEnding(fullMarkdown)
  const match = fullMarkdown.match(/^---[ \t]*(\r?\n)([\s\S]*?\r?\n)?(---|\.\.\.)[ \t]*(?:\r?\n|$)/)
  if (!match) {
    return {
      hasFrontmatter: false,
      rawYaml: '',
      body: fullMarkdown,
      closingDelimiter: '---',
      lineEnding,
    }
  }

  const fullBlock = match[0]
  const rawYamlWithTrailingBreak = match[2] || ''
  const rawYaml = rawYamlWithTrailingBreak.replace(/\r?\n$/, '')
  const closingDelimiter = match[3] || '---'
  const body = fullMarkdown.slice(fullBlock.length)

  return {
    hasFrontmatter: true,
    rawYaml,
    body,
    closingDelimiter,
    lineEnding,
    fullBlockLength: fullBlock.length,
  }
}

export const validateTagName = (rawTag) => {
  if (typeof rawTag !== 'string') return null
  const trimmed = rawTag.trim()
  if (!trimmed) return null
  const withoutHash = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed
  if (!withoutHash || /\s/.test(withoutHash)) return null
  if (
    withoutHash.startsWith('/') ||
    withoutHash.endsWith('/') ||
    withoutHash.includes('//') ||
    ONLY_DIGITS_RE.test(withoutHash) ||
    !VALID_TAG_CHAR_RE.test(withoutHash)
  ) {
    return null
  }
  return withoutHash
}

const normalizeTagList = (raw) => {
  if (raw === null || raw === undefined || raw === '') return []
  const items = Array.isArray(raw)
    ? raw
    : typeof raw === 'string'
      ? raw.split(/[\s,]+/).filter(Boolean)
      : [String(raw)]

  const result = []
  const seen = new Set()
  for (const item of items) {
    const valid = validateTagName(String(item))
    if (valid && !seen.has(valid.toLowerCase())) {
      seen.add(valid.toLowerCase())
      result.push(valid)
    }
  }
  return result
}

export const inferPropertyType = (key, value, knownPropertyTypes = {}) => {
  const lowerKey = String(key || '').toLowerCase()
  if (lowerKey === 'tags' || lowerKey === 'tag') return 'tags'
  if (lowerKey === 'aliases' || lowerKey === 'alias' || lowerKey === 'cssclasses') return 'list'

  if (knownPropertyTypes && typeof knownPropertyTypes[key] === 'string') {
    const known = knownPropertyTypes[key]
    if (PROPERTY_TYPES.includes(known)) {
      return known
    }
  }

  if (typeof value === 'boolean') return 'checkbox'
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (Array.isArray(value)) return 'list'
  if (typeof value === 'string') {
    if (DATE_RE.test(value)) return 'date'
    if (DATETIME_RE.test(value)) return 'datetime'
  }
  return 'text'
}

// Decimal text must round-trip through Number's shortest decimal form; arbitrary precision is not supported.
export const parsePropertyNumber = (rawValue) => {
  if (typeof rawValue === 'number') {
    if (!Number.isFinite(rawValue)) return { ok: false, reason: 'OVERFLOW' }
    if (Number.isInteger(rawValue) && !Number.isSafeInteger(rawValue)) {
      return { ok: false, reason: 'UNSAFE_INTEGER' }
    }
    return { ok: true, value: rawValue }
  }
  if (typeof rawValue !== 'string') return { ok: false, reason: 'INVALID' }

  const value = rawValue.trim()
  if (!value) return { ok: false, reason: 'EMPTY' }
  if (!NUMBER_RE.test(value)) {
    return {
      ok: false,
      reason: INCOMPLETE_NUMBER_RE.test(value) ? 'INCOMPLETE' : 'INVALID',
    }
  }

  const parsed = Number(value)
  if (!Number.isFinite(parsed)) return { ok: false, reason: 'OVERFLOW' }
  const [mantissa] = value.split(/[eE]/)
  if (parsed === 0) {
    return /[1-9]/.test(mantissa)
      ? { ok: false, reason: 'UNDERFLOW' }
      : { ok: true, value: parsed }
  }
  if (Number.isInteger(parsed) && !Number.isSafeInteger(parsed)) {
    return { ok: false, reason: 'UNSAFE_INTEGER' }
  }
  if (canonicalDecimal(value) !== canonicalDecimal(String(parsed))) {
    return { ok: false, reason: 'PRECISION_LOSS' }
  }
  return { ok: true, value: parsed }
}

const canonicalDecimal = (value) => {
  const [mantissa, exponent = '0'] = value.toLowerCase().split('e')
  const sign = mantissa.startsWith('-') ? '-' : ''
  const unsigned = mantissa.replace(/^[+-]/, '')
  const decimalPoint = unsigned.indexOf('.')
  let digits = unsigned.replace('.', '').replace(/^0+/, '')
  if (!digits) return '0'

  let decimalExponent = Number(exponent) - (decimalPoint < 0 ? 0 : unsigned.length - decimalPoint - 1)
  const trailingZeros = digits.match(/0+$/)?.[0].length ?? 0
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros)
    decimalExponent += trailingZeros
  }
  return `${sign}${digits}e${decimalExponent}`
}

const throwInvalidPropertyNumber = (reason) => {
  throw Object.assign(new TypeError('Invalid property number'), {
    code: 'INVALID_PROPERTY_NUMBER',
    reason,
  })
}

const unsafeNumericSource = (scalar) => {
  if (!isScalar(scalar) || typeof scalar.value !== 'number' || typeof scalar.source !== 'string') {
    return null
  }
  const parsed = parsePropertyNumber(scalar.source.replaceAll('_', ''))
  return !Number.isFinite(scalar.value) ||
    (Number.isInteger(scalar.value) && !Number.isSafeInteger(scalar.value)) ||
    ['OVERFLOW', 'UNDERFLOW', 'UNSAFE_INTEGER', 'PRECISION_LOSS'].includes(parsed.reason)
    ? scalar.source
    : null
}

export const coercePropertyValue = (value, targetType) => {
  switch (targetType) {
    case 'tags':
      return normalizeTagList(value)
    case 'list':
      if (Array.isArray(value)) return value.map((v) => String(v ?? ''))
      if (value === null || value === undefined || value === '') return []
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean)
      }
      return [String(value)]
    case 'checkbox':
      if (typeof value === 'boolean') return value
      if (typeof value === 'string') {
        return value.trim().toLowerCase() === 'true' || value.trim() === '1'
      }
      return Boolean(value)
    case 'number': {
      const parsed = parsePropertyNumber(value)
      if (!parsed.ok) throwInvalidPropertyNumber(parsed.reason)
      return parsed.value
    }
    case 'date': {
      const str = String(value ?? '').trim()
      if (DATE_RE.test(str)) return str
      if (DATETIME_RE.test(str)) return str.slice(0, 10)
      return str
    }
    case 'datetime': {
      const str = String(value ?? '').trim()
      if (DATE_RE.test(str)) return `${str}T00:00`
      return str
    }
    case 'text':
    default:
      if (Array.isArray(value)) return value.join(', ')
      if (value === null || value === undefined) return ''
      return String(value)
  }
}

export const isPropertyValueCompatible = (value, type, key = '') => {
  const lowerKey = String(key).toLowerCase()
  const flatList = Array.isArray(value) && value.every((item) =>
    item === null || ['string', 'number', 'boolean'].includes(typeof item)
  )

  switch (type) {
    case 'tags':
      return typeof value === 'string' || flatList
    case 'list':
      return flatList || (
        ['alias', 'aliases', 'cssclasses'].includes(lowerKey) && typeof value === 'string'
      )
    case 'number':
      return (typeof value === 'number' && Number.isFinite(value) &&
        (!Number.isInteger(value) || Number.isSafeInteger(value))) ||
        (typeof value === 'string' && parsePropertyNumber(value).ok)
    case 'checkbox':
      return typeof value === 'boolean' ||
        (typeof value === 'string' && /^(true|false|1|0)$/i.test(value.trim()))
    case 'date':
      return typeof value === 'string' && isValidDate(value)
    case 'datetime':
      return typeof value === 'string' && DATETIME_RE.test(value) &&
        isValidDate(value.slice(0, 10)) &&
        Number.isFinite(Date.parse(value))
    case 'text':
      return value === null || value === undefined ||
        ['string', 'number', 'boolean'].includes(typeof value)
    default:
      return false
  }
}

export const parseNoteDocument = (fullMarkdown, knownPropertyTypes = {}) => {
  const split = splitFrontmatter(fullMarkdown)
  if (!split.hasFrontmatter) {
    return {
      hasFrontmatter: false,
      valid: true,
      error: null,
      rawYaml: '',
      body: split.body,
      properties: [],
      lineEnding: split.lineEnding,
    }
  }

  if (split.rawYaml.trim() === '') {
    return {
      hasFrontmatter: true,
      valid: true,
      error: null,
      rawYaml: split.rawYaml,
      body: split.body,
      properties: [],
      lineEnding: split.lineEnding,
    }
  }

  let doc
  try {
    doc = parseDocument(split.rawYaml, { prettyErrors: false })
  } catch (err) {
    return {
      hasFrontmatter: true,
      valid: false,
      error: err.message || 'Invalid YAML frontmatter',
      rawYaml: split.rawYaml,
      body: split.body,
      properties: [],
      lineEnding: split.lineEnding,
    }
  }

  if (doc.errors && doc.errors.length > 0) {
    return {
      hasFrontmatter: true,
      valid: false,
      error: doc.errors[0].message || 'Invalid YAML frontmatter',
      rawYaml: split.rawYaml,
      body: split.body,
      properties: [],
      lineEnding: split.lineEnding,
    }
  }

  const contents = doc.contents
  if (contents !== null && !isMap(contents)) {
    return {
      hasFrontmatter: true,
      valid: false,
      error: 'Frontmatter root must be a YAML mapping',
      rawYaml: split.rawYaml,
      body: split.body,
      properties: [],
      lineEnding: split.lineEnding,
    }
  }

  const properties = []
  if (isMap(contents)) {
    for (const pair of contents.items) {
      const key = isScalar(pair.key) ? String(pair.key.value ?? '') : String(pair.key ?? '')
      if (!key) continue
      const jsVal = pair.value && typeof pair.value.toJSON === 'function'
        ? pair.value.toJSON()
        : pair.value
      const scalar = isScalar(pair.value) ? pair.value : isAlias(pair.value) ? pair.value.resolve(doc) : null
      const unsafeNumber = unsafeNumericSource(scalar)

      let type = unsafeNumber === null ? inferPropertyType(key, jsVal, knownPropertyTypes) : 'text'
      if (unsafeNumber === null && !isPropertyValueCompatible(jsVal, type, key)) {
        const inferred = inferPropertyType('', jsVal)
        type = isPropertyValueCompatible(jsVal, inferred, key) ? inferred : 'text'
      }
      let normalizedValue = unsafeNumber ?? jsVal
      if (unsafeNumber === null) {
        if (type === 'tags') {
          normalizedValue = normalizeTagList(jsVal)
        } else if (type === 'list') {
          normalizedValue = Array.isArray(jsVal)
            ? jsVal.map((item) => (item === null || item === undefined ? '' : String(item)))
            : jsVal === null || jsVal === undefined || jsVal === ''
              ? []
              : [String(jsVal)]
        } else if (type === 'checkbox') {
          normalizedValue = coercePropertyValue(jsVal, type)
        } else if (type === 'number') {
          normalizedValue = typeof jsVal === 'number' ? jsVal : Number(jsVal)
        } else if (
          type === 'text' &&
          jsVal !== null &&
          typeof jsVal === 'object'
        ) {
          normalizedValue = jsVal
        } else if (jsVal === null || jsVal === undefined) {
          normalizedValue = ''
        } else {
          normalizedValue = String(jsVal)
        }
      }

      properties.push({
        key,
        value: normalizedValue,
        type,
      })
    }
  }

  return {
    hasFrontmatter: true,
    valid: true,
    error: null,
    rawYaml: split.rawYaml,
    body: split.body,
    properties,
    lineEnding: split.lineEnding,
  }
}

const yamlNodePaths = (root) => {
  const byNode = new Map()
  const byPath = new Map()
  const visit = (node, path) => {
    if (!node || typeof node !== 'object') return
    const pathKey = JSON.stringify(path)
    byNode.set(node, pathKey)
    byPath.set(pathKey, node)
    if (isMap(node)) {
      node.items.forEach((pair, index) => {
        visit(pair.key, [...path, 'key', index])
        const key = isScalar(pair.key)
          ? `${typeof pair.key.value}:${String(pair.key.value)}`
          : `index:${index}`
        visit(pair.value, [...path, 'value', key])
      })
    } else if (isSeq(node)) {
      node.items.forEach((item, index) => visit(item, [...path, 'item', index]))
    }
  }
  visit(root, [])
  return { byNode, byPath }
}

const preserveUnsafeNumberSources = (doc, serialized) => {
  const originalSources = new Map()
  const collect = (node) => {
    if (!node || typeof node !== 'object') return
    const source = unsafeNumericSource(node)
    if (source !== null) originalSources.set(node, source)
    if (isMap(node)) {
      for (const pair of node.items) {
        collect(pair.key)
        collect(pair.value)
      }
    } else if (isSeq(node)) {
      for (const item of node.items) collect(item)
    }
  }
  collect(doc.contents)
  if (originalSources.size === 0) return serialized

  const currentPaths = yamlNodePaths(doc.contents).byNode
  const serializedDoc = parseDocument(serialized, { prettyErrors: false })
  if (serializedDoc.errors.length > 0) {
    throw new TypeError('Could not safely preserve numeric YAML values')
  }
  const serializedNodes = yamlNodePaths(serializedDoc.contents).byPath
  const replacements = []
  for (const [node, source] of originalSources) {
    const path = currentPaths.get(node)
    if (path === undefined) continue
    const outputNode = serializedNodes.get(path)
    if (!isScalar(outputNode) || !outputNode.range) {
      throw new TypeError('Could not safely preserve numeric YAML values')
    }
    replacements.push([outputNode.range[0], outputNode.range[1], source])
  }
  for (const [start, end, source] of replacements.sort((a, b) => b[0] - a[0])) {
    serialized = `${serialized.slice(0, start)}${source}${serialized.slice(end)}`
  }
  return serialized
}

const formatYamlDocument = (doc, split) => {
  const eol = split.lineEnding || '\n'
  const serialized = preserveUnsafeNumberSources(
    doc,
    doc.toString({ lineWidth: 0, nullStr: '' })
  )
    .replace(/\r?\n/g, eol)
    .replace(/(\r?\n)+$/, '')

  const closing = split.closingDelimiter || '---'
  if (!serialized) {
    return `---${eol}${closing}${eol}${split.body}`
  }
  return `---${eol}${serialized}${eol}${closing}${eol}${split.body}`
}

const createYamlNodeForValue = (doc, value, type) => {
  if (type === 'tags' || type === 'list') {
    const arr = Array.isArray(value) ? value : coercePropertyValue(value, type)
    const seq = new YAMLSeq()
    seq.flow = arr.length === 0
    for (const item of arr) {
      seq.add(doc.createNode(String(item ?? '')))
    }
    return seq
  }
  if (type === 'checkbox') {
    return doc.createNode(Boolean(value))
  }
  if (type === 'number') {
    const parsed = parsePropertyNumber(value)
    if (!parsed.ok) throwInvalidPropertyNumber(parsed.reason)
    return doc.createNode(parsed.value)
  }
  return doc.createNode(value === null || value === undefined ? '' : value)
}

const normalizeLineEndings = (text) => String(text ?? '').replace(/\r\n|\r/g, '\n')
const newlineTokens = (text) => [...String(text ?? '').matchAll(/\r\n|\r|\n/g)].map(([ending]) => ending)
const defaultLineEnding = (tokens, fallback = '\n') => {
  if (!tokens || !tokens.length) return fallback
  const counts = new Map()
  for (const ending of tokens) counts.set(ending, (counts.get(ending) ?? 0) + 1)
  return [...counts].sort((a, b) => b[1] - a[1])[0][0]
}

const reconcileLineEndings = (originalText, nextText, fallbackEol = '\n') => {
  if (originalText === nextText) return nextText
  const previousNorm = normalizeLineEndings(originalText)
  const nextNorm = normalizeLineEndings(nextText)
  if (previousNorm === nextNorm) {
    return originalText
  }

  let prefix = 0
  while (prefix < previousNorm.length && prefix < nextNorm.length && previousNorm[prefix] === nextNorm[prefix]) {
    prefix++
  }
  let suffix = 0
  while (
    suffix < previousNorm.length - prefix &&
    suffix < nextNorm.length - prefix &&
    previousNorm[previousNorm.length - 1 - suffix] === nextNorm[nextNorm.length - 1 - suffix]
  ) {
    suffix++
  }

  const oldTokens = newlineTokens(originalText)
  const prefixTokens = newlineTokens(previousNorm.slice(0, prefix)).length
  const oldMiddleEnd = previousNorm.length - suffix
  const suffixTokens = newlineTokens(previousNorm.slice(oldMiddleEnd)).length
  const addedBreaks = (nextNorm.slice(prefix, nextNorm.length - suffix).match(/\n/g) ?? []).length
  const lineEnding = defaultLineEnding(oldTokens, fallbackEol)

  const tokens = [
    ...oldTokens.slice(0, prefixTokens),
    ...Array(addedBreaks).fill(lineEnding),
    ...(suffixTokens ? oldTokens.slice(-suffixTokens) : []),
  ]
  let tokenIndex = 0
  return nextNorm.replace(/\n/g, () => tokens[tokenIndex++] ?? lineEnding)
}

export const updateBodyInMarkdown = (fullMarkdown, nextBody) => {
  const split = splitFrontmatter(fullMarkdown)
  const originalBody = split.hasFrontmatter ? split.body : fullMarkdown
  const eol = split.lineEnding || '\n'
  const reconciledBody = reconcileLineEndings(originalBody, String(nextBody ?? ''), eol)
  if (!split.hasFrontmatter) {
    return reconciledBody
  }
  const prefix = fullMarkdown.slice(0, split.fullBlockLength)
  return `${prefix}${reconciledBody}`
}

export const replaceRawYamlInMarkdown = (fullMarkdown, nextRawYaml) => {
  const split = splitFrontmatter(fullMarkdown)
  const eol = split.lineEnding || '\n'
  const cleanedYaml = String(nextRawYaml ?? '')
    .replace(/\r?\n/g, eol)
    .replace(/(\r?\n)+$/, '')
  const closing = split.closingDelimiter || '---'
  const bodyPart = split.hasFrontmatter
    ? split.body
    : fullMarkdown.startsWith(eol)
      ? fullMarkdown
      : `${eol}${fullMarkdown}`

  if (!cleanedYaml) {
    return `---${eol}${closing}${eol}${bodyPart}`
  }
  return `---${eol}${cleanedYaml}${eol}${closing}${eol}${bodyPart}`
}

export const setPropertyInMarkdown = (fullMarkdown, key, value, type = 'text') => {
  const trimmedKey = String(key ?? '').trim()
  if (!trimmedKey) return fullMarkdown

  const split = splitFrontmatter(fullMarkdown)
  const eol = split.lineEnding || '\n'

  let doc
  if (split.hasFrontmatter && split.rawYaml.trim() !== '') {
    doc = parseDocument(split.rawYaml, { prettyErrors: false })
    if (doc.errors.length > 0 || (doc.contents !== null && !isMap(doc.contents))) {
      return fullMarkdown
    }
  } else {
    doc = parseDocument('', { prettyErrors: false })
  }

  if (!isMap(doc.contents)) {
    doc.contents = new YAMLMap()
  }

  const effectiveType = inferPropertyType(trimmedKey, value, { [trimmedKey]: type })
  const coerced = coercePropertyValue(value, effectiveType)
  const node = createYamlNodeForValue(doc, coerced, effectiveType)

  doc.set(trimmedKey, node)

  const targetSplit = split.hasFrontmatter
    ? split
    : {
        ...split,
        hasFrontmatter: true,
        closingDelimiter: '---',
        lineEnding: eol,
        body: fullMarkdown,
      }

  return formatYamlDocument(doc, targetSplit)
}

const propertyNamesConflict = (left, right) => left.toLowerCase() === right.toLowerCase()

export const addPropertyToMarkdown = (fullMarkdown, key, value, type = 'text') => {
  const trimmedKey = String(key ?? '').trim()
  if (!trimmedKey) return { ok: false, reason: 'INVALID_PROPERTY_NAME' }

  const parsed = parseNoteDocument(fullMarkdown)
  if (!parsed.valid) return { ok: false, reason: 'INVALID_YAML' }
  if (parsed.properties.some((property) => propertyNamesConflict(property.key, trimmedKey))) {
    return { ok: false, reason: 'PROPERTY_ALREADY_EXISTS' }
  }
  if (!PROPERTY_TYPES.includes(type) || !isPropertyValueCompatible(value, type, trimmedKey)) {
    return { ok: false, reason: 'INVALID_PROPERTY_VALUE' }
  }

  const markdown = setPropertyInMarkdown(fullMarkdown, trimmedKey, value, type)
  return markdown === fullMarkdown
    ? { ok: false, reason: 'INVALID_YAML' }
    : { ok: true, markdown }
}

export const removePropertyFromMarkdown = (fullMarkdown, key) => {
  const split = splitFrontmatter(fullMarkdown)
  if (!split.hasFrontmatter) return fullMarkdown

  const doc = parseDocument(split.rawYaml, { prettyErrors: false })
  if (doc.errors.length > 0 || !isMap(doc.contents)) return fullMarkdown

  doc.delete(key)
  return formatYamlDocument(doc, split)
}

export const renamePropertyInMarkdownResult = (fullMarkdown, oldKey, newKey) => {
  const trimmedNew = String(newKey ?? '').trim()
  if (!trimmedNew) return { ok: false, reason: 'INVALID_PROPERTY_NAME' }

  const split = splitFrontmatter(fullMarkdown)
  if (!split.hasFrontmatter) return { ok: false, reason: 'PROPERTY_NOT_FOUND' }

  const doc = parseDocument(split.rawYaml, { prettyErrors: false })
  if (doc.errors.length > 0 || !isMap(doc.contents)) return { ok: false, reason: 'INVALID_YAML' }

  const items = doc.contents.items
  const pair = items.find(
    (p) => (isScalar(p.key) ? String(p.key.value) : String(p.key)) === String(oldKey)
  )
  if (!pair) return { ok: false, reason: 'PROPERTY_NOT_FOUND' }

  const currentKey = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
  if (currentKey === trimmedNew) return { ok: true, changed: false }
  if (items.some((item) => item !== pair && propertyNamesConflict(
    isScalar(item.key) ? String(item.key.value) : String(item.key),
    trimmedNew
  ))) {
    return { ok: false, reason: 'PROPERTY_ALREADY_EXISTS' }
  }

  if (isScalar(pair.key)) {
    pair.key.value = trimmedNew
  } else {
    pair.key = doc.createNode(trimmedNew)
  }

  return { ok: true, changed: true, markdown: formatYamlDocument(doc, split) }
}

export const renamePropertyInMarkdown = (fullMarkdown, oldKey, newKey) => {
  const result = renamePropertyInMarkdownResult(fullMarkdown, oldKey, newKey)
  return result.ok && result.changed ? result.markdown : fullMarkdown
}

export const reorderPropertiesInMarkdown = (fullMarkdown, orderedKeys = []) => {
  const split = splitFrontmatter(fullMarkdown)
  if (!split.hasFrontmatter) return fullMarkdown

  const doc = parseDocument(split.rawYaml, { prettyErrors: false })
  if (doc.errors.length > 0 || !isMap(doc.contents)) return fullMarkdown

  const itemsByKey = new Map()
  for (const pair of doc.contents.items) {
    const k = isScalar(pair.key) ? String(pair.key.value) : String(pair.key)
    itemsByKey.set(k, pair)
  }

  const reordered = []
  for (const k of orderedKeys) {
    if (itemsByKey.has(k)) {
      reordered.push(itemsByKey.get(k))
      itemsByKey.delete(k)
    }
  }
  for (const pair of itemsByKey.values()) {
    reordered.push(pair)
  }

  doc.contents.items = reordered
  return formatYamlDocument(doc, split)
}

export const buildInitialNoteContent = (noteName, options = {}) => {
  const stem = String(noteName ?? '')
    .replace(/\.(md|markdown)$/i, '')
    .trim()
  const eol = options.lineEnding || '\n'
  const includeFrontmatter = options.includeFrontmatter !== false
  if (!includeFrontmatter) return ''

  const doc = parseDocument('', { prettyErrors: false })
  doc.contents = new YAMLMap()
  doc.set('title', doc.createNode(stem))
  if (options.defaultType) {
    doc.set('type', doc.createNode(String(options.defaultType)))
  }
  const tagsSeq = new YAMLSeq()
  tagsSeq.flow = true
  doc.set('tags', tagsSeq)

  const yamlStr = doc
    .toString({ lineWidth: 0 })
    .replace(/\r?\n/g, eol)
    .replace(/(\r?\n)+$/, '')
  return `---${eol}${yamlStr}${eol}---${eol}${eol}`
}

export const extractBodyTags = (markdownBody) => {
  if (typeof markdownBody !== 'string' || !markdownBody) return []

  // Strip fenced code blocks, inline code, links, and wikilinks before scanning for #tags
  const withoutCodeFences = markdownBody.replace(
    /^(?:[ \t]*)(`{3,}|~{3,})[\s\S]*?^(?:[ \t]*)\1[ \t]*$/gm,
    ''
  )
  const withoutComments = withoutCodeFences.replace(/%%[\s\S]*?%%/g, '')
  const withoutInlineCode = withoutComments.replace(/`[^`\n]+`/g, '')
  const withoutWikilinks = withoutInlineCode.replace(/!?\[\[[^\]]+\]\]/g, '')
  const withoutMdLinks = withoutWikilinks.replace(/!?\[[^\]]*\]\([^)\n]+\)/g, '')

  const tagRegex = /(?:^|[\s(])#([\p{L}\p{N}_\-/]+)/gu
  const tags = []
  const seen = new Set()

  let match
  while ((match = tagRegex.exec(withoutMdLinks)) !== null) {
    const candidate = validateTagName(match[1])
    if (candidate && !seen.has(candidate.toLowerCase())) {
      seen.add(candidate.toLowerCase())
      tags.push(candidate)
    }
  }

  return tags
}

export const extractAllNoteTags = (fullMarkdown) => {
  const parsed = parseNoteDocument(fullMarkdown)
  const combined = []
  const seen = new Set()

  const addTag = (raw) => {
    const valid = validateTagName(raw)
    if (valid && !seen.has(valid.toLowerCase())) {
      seen.add(valid.toLowerCase())
      combined.push(valid)
    }
  }

  if (parsed.valid) {
    for (const prop of parsed.properties) {
      if (prop.key.toLowerCase() === 'tags' || prop.key.toLowerCase() === 'tag') {
        const list = Array.isArray(prop.value) ? prop.value : [prop.value]
        for (const t of list) addTag(String(t))
      }
    }
  }

  for (const t of extractBodyTags(parsed.body)) {
    addTag(t)
  }

  return combined
}

export const matchesTagQuery = (noteTags, queryTag) => {
  const cleanQuery = validateTagName(queryTag)
  if (!cleanQuery || !Array.isArray(noteTags)) return false
  const targetLower = cleanQuery.toLowerCase()

  return noteTags.some((tag) => {
    const lower = String(tag).toLowerCase()
    return lower === targetLower || lower.startsWith(`${targetLower}/`)
  })
}
