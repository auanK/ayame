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

test('resolveDatabasePath uses the Ayame default when neither database exists', (t) => {
  const dataDirectory = makeDataDirectory(t)
  assert.equal(
    resolveDatabasePath({ dataDirectory }),
    path.join(dataDirectory, 'ayame.sqlite')
  )
})

test('resolveDatabasePath keeps using the sole existing legacy database', (t) => {
  const dataDirectory = makeDataDirectory(t)
  const legacyPath = path.join(dataDirectory, 'nia.sqlite')
  fs.writeFileSync(legacyPath, 'legacy database')
  assert.equal(resolveDatabasePath({ dataDirectory }), legacyPath)
})

test('resolveDatabasePath uses the sole existing Ayame database', (t) => {
  const dataDirectory = makeDataDirectory(t)
  const ayamePath = path.join(dataDirectory, 'ayame.sqlite')
  fs.writeFileSync(ayamePath, 'ayame database')
  assert.equal(resolveDatabasePath({ dataDirectory }), ayamePath)
})

test('resolveDatabasePath rejects both default database names explicitly', (t) => {
  const dataDirectory = makeDataDirectory(t)
  fs.writeFileSync(path.join(dataDirectory, 'nia.sqlite'), 'legacy database')
  fs.writeFileSync(path.join(dataDirectory, 'ayame.sqlite'), 'ayame database')
  assert.throws(() => resolveDatabasePath({ dataDirectory }), /ambiguous database state/i)
})

test('resolveDatabasePath honors Ayame and legacy explicit configuration', (t) => {
  const dataDirectory = makeDataDirectory(t)
  const ayamePath = path.join(dataDirectory, 'custom-ayame.sqlite')
  const legacyPath = path.join(dataDirectory, 'custom-nia.sqlite')
  assert.equal(
    resolveDatabasePath({ dataDirectory, configuredPath: ayamePath }),
    ayamePath
  )
  assert.equal(
    resolveDatabasePath({ dataDirectory, legacyConfiguredPath: legacyPath }),
    legacyPath
  )
})

test('resolveDatabasePath rejects conflicting or empty explicit configuration', (t) => {
  const dataDirectory = makeDataDirectory(t)
  assert.throws(
    () => resolveDatabasePath({ dataDirectory, configuredPath: '/new.sqlite', legacyConfiguredPath: '/old.sqlite' }),
    /conflict/i
  )
  assert.throws(
    () => resolveDatabasePath({ dataDirectory, configuredPath: '', legacyConfiguredPath: '' }),
    /conflict/i
  )
  assert.throws(() => resolveDatabasePath({ dataDirectory, configuredPath: '' }), /non-empty/i)
  assert.throws(() => resolveDatabasePath({ dataDirectory, legacyConfiguredPath: '' }), /non-empty/i)
})

test('database selection leaves both database files untouched', (t) => {
  const dataDirectory = makeDataDirectory(t)
  const legacyPath = path.join(dataDirectory, 'nia.sqlite')
  const ayamePath = path.join(dataDirectory, 'ayame.sqlite')
  fs.writeFileSync(legacyPath, 'legacy bytes')
  const before = fs.readFileSync(legacyPath)

  assert.equal(resolveDatabasePath({ dataDirectory }), legacyPath)
  assert.deepEqual(fs.readFileSync(legacyPath), before)
  assert.equal(fs.existsSync(ayamePath), false)
})

test('resolveVaultsRootConfig preserves either configured path and rejects ambiguity or emptiness', (t) => {
  const defaultPath = path.join(makeDataDirectory(t), 'vaults')
  const selectedPath = '/mnt/knowledge'
  assert.deepEqual(
    resolveVaultsRootConfig({ defaultPath, configuredPath: selectedPath }),
    { path: selectedPath, createIfMissing: false }
  )
  assert.deepEqual(
    resolveVaultsRootConfig({ defaultPath, legacyConfiguredPath: selectedPath }),
    { path: selectedPath, createIfMissing: false }
  )
  assert.deepEqual(resolveVaultsRootConfig({ defaultPath }), { path: defaultPath, createIfMissing: true })
  assert.throws(
    () => resolveVaultsRootConfig({ defaultPath, configuredPath: selectedPath, legacyConfiguredPath: '/old' }),
    /conflict/i
  )
  assert.throws(() => resolveVaultsRootConfig({ defaultPath, configuredPath: '' }), /non-empty/i)
  assert.throws(() => resolveVaultsRootConfig({ defaultPath, legacyConfiguredPath: '' }), /non-empty/i)
})

test('main fails startup on environment conflicts and invalid explicit paths', (t) => {
  const tempDirectory = makeDataDirectory(t)
  const existingVaults = path.join(tempDirectory, 'mounted-vaults')
  fs.mkdirSync(existingVaults)
  const mainPath = path.join(import.meta.dirname, 'main.js')

  const runMain = (values) => {
    const env = { ...process.env }
    for (const name of ['AYAME_DATABASE_PATH', 'NIA_DATABASE_PATH', 'AYAME_VAULTS_PATH', 'NIA_VAULTS_PATH']) {
      delete env[name]
    }
    Object.assign(env, values)
    return spawnSync(process.execPath, [mainPath], {
      cwd: path.resolve(import.meta.dirname, '../..'),
      env,
      encoding: 'utf8',
      timeout: 5000,
    })
  }

  for (const [values, message] of [
    [{ AYAME_DATABASE_PATH: '/new.sqlite', NIA_DATABASE_PATH: '/old.sqlite' }, /AYAME_DATABASE_PATH and NIA_DATABASE_PATH/],
    [{ AYAME_DATABASE_PATH: path.join(tempDirectory, 'custom.sqlite'), AYAME_VAULTS_PATH: '/new', NIA_VAULTS_PATH: '/old' }, /AYAME_VAULTS_PATH and NIA_VAULTS_PATH/],
    [{ AYAME_DATABASE_PATH: path.join(tempDirectory, 'custom.sqlite'), NIA_VAULTS_PATH: path.join(tempDirectory, 'missing-vaults') }, /Vault root does not exist/],
    [{ AYAME_DATABASE_PATH: tempDirectory, AYAME_VAULTS_PATH: existingVaults }, /SQLITE_CANTOPEN|unable to open database file/i],
  ]) {
    const result = runMain(values)
    assert.notEqual(result.status, 0, result.stdout + result.stderr)
    assert.match(result.stderr, message)
  }
})

test('main rejects ambiguous defaults and never replaces a corrupt legacy database', (t) => {
  const tempDirectory = makeDataDirectory(t)
  const projectDirectory = path.join(tempDirectory, 'project')
  const backendDirectory = path.join(projectDirectory, 'backend')
  const sourceDirectory = path.resolve(import.meta.dirname)
  fs.mkdirSync(backendDirectory, { recursive: true })
  fs.cpSync(sourceDirectory, path.join(backendDirectory, 'src'), { recursive: true })
  fs.copyFileSync(path.join(sourceDirectory, '../package.json'), path.join(backendDirectory, 'package.json'))
  fs.symlinkSync(path.resolve(sourceDirectory, '../../node_modules'), path.join(backendDirectory, 'node_modules'), 'dir')

  const dataDirectory = path.join(projectDirectory, 'data')
  fs.mkdirSync(dataDirectory)
  const legacyPath = path.join(dataDirectory, 'nia.sqlite')
  const ayamePath = path.join(dataDirectory, 'ayame.sqlite')
  const mainPath = path.join(backendDirectory, 'src/main.js')
  const env = { ...process.env }
  for (const name of ['AYAME_DATABASE_PATH', 'NIA_DATABASE_PATH', 'AYAME_VAULTS_PATH', 'NIA_VAULTS_PATH']) {
    delete env[name]
  }
  const runMain = () => spawnSync(process.execPath, [mainPath], {
    cwd: projectDirectory,
    env,
    encoding: 'utf8',
    timeout: 5000,
  })

  const legacyBytes = Buffer.from('legacy database')
  const ayameBytes = Buffer.from('ayame database')
  fs.writeFileSync(legacyPath, legacyBytes)
  fs.writeFileSync(ayamePath, ayameBytes)
  const ambiguous = runMain()
  assert.notEqual(ambiguous.status, 0)
  assert.match(ambiguous.stderr, /Ambiguous database state/)
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes)
  assert.deepEqual(fs.readFileSync(ayamePath), ayameBytes)

  fs.rmSync(ayamePath)
  const corruptLegacy = runMain()
  assert.notEqual(corruptLegacy.status, 0)
  assert.match(corruptLegacy.stderr, /not a database|SQLITE_NOTADB/i)
  assert.deepEqual(fs.readFileSync(legacyPath), legacyBytes)
  assert.equal(fs.existsSync(ayamePath), false)
})
