import fs from 'node:fs'
import path from 'node:path'

const selectConfiguredPath = (name, value, legacyName, legacyValue) => {
  if (value !== undefined && legacyValue !== undefined) {
    throw new Error(`Conflicting configuration: ${name} and ${legacyName} are both set`)
  }

  const selected = value === undefined ? legacyValue : value
  if (selected !== undefined && (typeof selected !== 'string' || selected.trim() === '' || selected.includes('\0'))) {
    throw new Error(`${value === undefined ? legacyName : name} must be a non-empty valid path`)
  }
  return selected
}

export const resolveDatabasePath = ({ dataDirectory, configuredPath, legacyConfiguredPath }) => {
  const selected = selectConfiguredPath('AYAME_DATABASE_PATH', configuredPath, 'NIA_DATABASE_PATH', legacyConfiguredPath)
  if (selected !== undefined) {
    return selected
  }

  const legacyPath = path.join(dataDirectory, 'nia.sqlite')
  const ayamePath = path.join(dataDirectory, 'ayame.sqlite')
  const hasLegacy = fs.existsSync(legacyPath)
  const hasAyame = fs.existsSync(ayamePath)

  if (hasLegacy && hasAyame) {
    throw new Error(`Ambiguous database state: both ${legacyPath} and ${ayamePath} exist`)
  }
  return hasLegacy ? legacyPath : ayamePath
}

export const resolveVaultsRootConfig = ({ defaultPath, configuredPath, legacyConfiguredPath }) => {
  const selected = selectConfiguredPath('AYAME_VAULTS_PATH', configuredPath, 'NIA_VAULTS_PATH', legacyConfiguredPath)
  return {
    path: selected === undefined ? defaultPath : selected,
    createIfMissing: selected === undefined,
  }
}
