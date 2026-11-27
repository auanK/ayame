import fs from 'node:fs'
import Database from 'better-sqlite3'
import { buildVaultIndex, describeVaultNote, getBacklinksForNote, getMentionTerms, searchVaultNotes } from '../../../shared/markdown/vaultIndex.js'
import { scanVaultIndex } from './operations.js'
import { readVaultMarkdown } from './reader.js'

const MAX_INDEXED_VAULTS = 3
const METADATA_RECHECK_MS = 5_000
const MAX_RESULTS = 100

const fingerprintOf = (absolutePath) => {
  const stat = fs.lstatSync(absolutePath, { bigint: true })
  if (!stat.isFile() || stat.dev === 0n || stat.ino === 0n) return null
  return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`
}

const sameList = (left, right) => left.length === right.length && left.every((item, i) => item === right[i])

const openTextIndex = () => {
  // An empty SQLite filename creates a temporary database, removed when closed.
  const db = new Database('')
  db.pragma('cache_size = -2048')
  db.pragma('temp_store = FILE')
  db.exec(`
    CREATE TABLE note_text (
      path TEXT NOT NULL UNIQUE,
      content TEXT NOT NULL,
      folded TEXT NOT NULL,
      body_start INTEGER NOT NULL,
      has_null INTEGER NOT NULL
    );
    CREATE INDEX note_text_with_null ON note_text(has_null) WHERE has_null = 1;
    CREATE VIRTUAL TABLE note_matches USING fts5(
      folded, content='note_text', content_rowid='rowid', tokenize='trigram case_sensitive 1'
    );
    CREATE TRIGGER note_text_insert AFTER INSERT ON note_text BEGIN
      INSERT INTO note_matches(rowid, folded) VALUES (new.rowid, new.folded);
    END;
    CREATE TRIGGER note_text_update AFTER UPDATE ON note_text BEGIN
      INSERT INTO note_matches(note_matches, rowid, folded) VALUES ('delete', old.rowid, old.folded);
      INSERT INTO note_matches(rowid, folded) VALUES (new.rowid, new.folded);
    END;
    CREATE TRIGGER note_text_delete AFTER DELETE ON note_text BEGIN
      INSERT INTO note_matches(note_matches, rowid, folded) VALUES ('delete', old.rowid, old.folded);
    END;
  `)

  const upsert = db.prepare(`
    INSERT INTO note_text (path, content, folded, body_start, has_null) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(path) DO UPDATE SET content = excluded.content, folded = excluded.folded,
      body_start = excluded.body_start, has_null = excluded.has_null
  `)
  const getText = db.prepare('SELECT content, body_start FROM note_text WHERE path = ?')
  const deleteText = db.prepare('DELETE FROM note_text WHERE path = ?')
  const findByTrigram = db.prepare(`
    SELECT note_text.path FROM note_matches JOIN note_text ON note_text.rowid = note_matches.rowid
      WHERE note_matches MATCH ?
    UNION ALL
    SELECT path FROM note_text WHERE has_null = 1 AND instr(folded, ?) > 0
  `).pluck()
  const findBySubstring = db.prepare('SELECT path FROM note_text WHERE instr(folded, ?) > 0').pluck()

  return {
    read(path) {
      const row = getText.get(path)
      return row && { content: row.content, body: row.content.slice(row.body_start) }
    },
    put(path, content, bodyStart) {
      upsert.run(path, content, content.toLowerCase(), bodyStart, Number(content.includes('\0')))
    },
    delete: (path) => deleteText.run(path),
    matches(term) {
      const folded = term.toLowerCase()
      if (folded.includes('\0') || !/^.{3}/su.test(folded)) return findBySubstring.iterate(folded)
      return findByTrigram.iterate(`"${folded.replaceAll('"', '""')}"`, folded)
    },
    transaction: (fn) => db.transaction(fn),
    close: () => db.close(),
  }
}

export function createVaultSearchIndex(vaultsRoot) {
  const vaults = new Map()

  function getVault(directory) {
    const existing = vaults.get(directory)
    if (existing) {
      vaults.delete(directory)
      vaults.set(directory, existing)
      return existing
    }
    const vault = { text: openTextIndex(), notes: new Map(), snapshot: null, resolved: null, checkedAt: null }
    vaults.set(directory, vault)
    if (vaults.size > MAX_INDEXED_VAULTS) {
      const first = vaults.keys().next().value
      vaults.get(first).text.close()
      vaults.delete(first)
    }
    return vault
  }

  function refresh(vault, directory) {
    const notes = new Map()
    const snapshot = vault.text.transaction(() => {
      const index = scanVaultIndex(vaultsRoot, directory, {
        indexNote(relativePath, name, absolutePath) {
          const fingerprint = fingerprintOf(absolutePath)
          const saved = vault.notes.get(relativePath)
          if (fingerprint && saved?.fingerprint === fingerprint) {
            notes.set(relativePath, saved)
            return saved.note
          }
          const document = readVaultMarkdown(vaultsRoot, directory, relativePath)
          const stable = fingerprint && fingerprint === fingerprintOf(absolutePath)
          const currentFingerprint = stable ? fingerprint : null
          if (saved?.note.revision === document.revision) {
            notes.set(relativePath, { fingerprint: currentFingerprint, note: saved.note })
            return saved.note
          }
          const { note, bodyStart } = describeVaultNote({ ...document, name })
          vault.text.put(relativePath, document.content, bodyStart)
          notes.set(relativePath, { fingerprint: currentFingerprint, note })
          return note
        },
      })
      for (const previous of vault.notes.keys()) {
        if (!notes.has(previous)) vault.text.delete(previous)
      }
      return { ...index, metadataOnly: true }
    })()

    const previous = vault.snapshot
    if (!previous || !sameList(previous.notes, snapshot.notes) || !sameList(previous.files, snapshot.files) ||
      previous.complete !== snapshot.complete) vault.resolved = null
    vault.notes = notes
    vault.snapshot = snapshot
    vault.checkedAt = Date.now()
    return snapshot
  }

  function forQuery(directory) {
    const vault = getVault(directory)
    if (vault.checkedAt === null || Date.now() - vault.checkedAt >= METADATA_RECHECK_MS) refresh(vault, directory)
    vault.resolved ??= buildVaultIndex(vault.snapshot)
    return vault
  }

  return {
    scan: (directory) => refresh(getVault(directory), directory),
    search(directory, query) {
      const vault = forQuery(directory)
      const paths = /^#|^tag:/i.test(query) ? new Set() : new Set(vault.text.matches(query))
      return searchVaultNotes(vault.resolved, query, {
        contentMatches: paths,
        readText: ({ path }) => vault.text.read(path),
        limit: MAX_RESULTS,
      })
    },
    mentions(directory, path) {
      const vault = forQuery(directory)
      const paths = new Set()
      for (const term of getMentionTerms(vault.resolved, path)) {
        for (const candidate of vault.text.matches(term)) paths.add(candidate)
      }
      return getBacklinksForNote(vault.resolved, path, {
        readText: (note) => paths.has(note.path) ? vault.text.read(note.path) : null,
        limit: MAX_RESULTS,
      }).unlinkedMentions
    },
    invalidate() {
      for (const vault of vaults.values()) vault.checkedAt = null
    },
  }
}
