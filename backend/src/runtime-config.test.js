import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { resolveDatabasePath, resolveVaultsRootConfig } from './runtime-config.js'

const makeDataDirectory = (t) => {
  const dataDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'ayame-runtime-config-'))
  t.after(() => fs.rmSync(dataDirectory, { recursive: true, force: true }))
  return dataDirectory
}

test('resolveDatabasePath returns the default ayame.sqlite path when configuredPath is omitted', (t) => {
  const dataDirectory = makeDataDirectory(t)
  assert.equal(
    resolveDatabasePath({ dataDirectory }),
    path.join(dataDirectory, 'ayame.sqlite')
  )
})

test('resolveDatabasePath returns configuredPath when explicitly defined', (t) => {
  const dataDirectory = makeDataDirectory(t)
  const customPath = path.join(dataDirectory, 'custom-ayame.sqlite')
  assert.equal(
    resolveDatabasePath({ dataDirectory, configuredPath: customPath }),
    customPath
  )
})

test('resolveDatabasePath rejects empty, whitespace-only, or null-byte configuredPath values', (t) => {
  const dataDirectory = makeDataDirectory(t)
  for (const invalidValue of ['', '   ', 'bad\0path.sqlite', 123, null]) {
    assert.throws(
      () => resolveDatabasePath({ dataDirectory, configuredPath: invalidValue }),
      /AYAME_DATABASE_PATH must be a non-empty valid path/
    )
  }
})

test('unrelated files in dataDirectory do not alter default database resolution and remain untouched', (t) => {
  const dataDirectory = makeDataDirectory(t)
  const unrelatedSqlite = path.join(dataDirectory, 'unrelated.sqlite')
  const notesDb = path.join(dataDirectory, 'notes.db')
  fs.writeFileSync(unrelatedSqlite, 'unrelated-sqlite-bytes')
  fs.writeFileSync(notesDb, 'notes-db-bytes')

  const resolved = resolveDatabasePath({ dataDirectory })
  assert.equal(resolved, path.join(dataDirectory, 'ayame.sqlite'))
  assert.equal(fs.readFileSync(unrelatedSqlite, 'utf8'), 'unrelated-sqlite-bytes')
  assert.equal(fs.readFileSync(notesDb, 'utf8'), 'notes-db-bytes')
  assert.equal(fs.existsSync(resolved), false)
})

test('resolveVaultsRootConfig uses defaultPath with createIfMissing true when configuredPath is omitted', (t) => {
  const defaultPath = path.join(makeDataDirectory(t), 'vaults')
  assert.deepEqual(
    resolveVaultsRootConfig({ defaultPath }),
    { path: defaultPath, createIfMissing: true }
  )
})

test('resolveVaultsRootConfig uses configuredPath with createIfMissing false when explicitly defined', (t) => {
  const defaultPath = path.join(makeDataDirectory(t), 'vaults')
  const selectedPath = '/mnt/knowledge'
  assert.deepEqual(
    resolveVaultsRootConfig({ defaultPath, configuredPath: selectedPath }),
    { path: selectedPath, createIfMissing: false }
  )
})

test('resolveVaultsRootConfig rejects empty, whitespace-only, or null-byte configuredPath values', (t) => {
  const defaultPath = path.join(makeDataDirectory(t), 'vaults')
  for (const invalidValue of ['', '   ', 'bad\0vaults', 123, null]) {
    assert.throws(
      () => resolveVaultsRootConfig({ defaultPath, configuredPath: invalidValue }),
      /AYAME_VAULTS_PATH must be a non-empty valid path/
    )
  }
})

test('main fails startup when AYAME_VAULTS_PATH points to an inexistent directory or AYAME_DATABASE_PATH is invalid or corrupted', (t) => {
  const tempDirectory = makeDataDirectory(t)
  const existingVaults = path.join(tempDirectory, 'mounted-vaults')
  fs.mkdirSync(existingVaults)
  const corruptedDbPath = path.join(tempDirectory, 'corrupt.sqlite')
  fs.writeFileSync(corruptedDbPath, 'not a valid sqlite database')
  const mainPath = path.join(import.meta.dirname, 'main.js')

  const runMain = (values) => {
    const env = { ...process.env }
    delete env.AYAME_DATABASE_PATH
    delete env.AYAME_VAULTS_PATH
    Object.assign(env, values)
    return spawnSync(process.execPath, [mainPath], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      encoding: 'utf8',
      timeout: 5000,
    })
  }

  for (const [values, message] of [
    [
      {
        AYAME_DATABASE_PATH: path.join(tempDirectory, 'custom.sqlite'),
        AYAME_VAULTS_PATH: path.join(tempDirectory, 'missing-vaults'),
      },
      /Vault root does not exist/,
    ],
    [
      {
        AYAME_DATABASE_PATH: tempDirectory,
        AYAME_VAULTS_PATH: existingVaults,
      },
      /SQLITE_CANTOPEN|unable to open database file/i,
    ],
    [
      {
        AYAME_DATABASE_PATH: corruptedDbPath,
        AYAME_VAULTS_PATH: existingVaults,
      },
      /SQLITE_NOTADB|file is not a database/i,
    ],
  ]) {
    const result = runMain(values)
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stderr, message)
  }
})
