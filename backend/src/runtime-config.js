import path from 'node:path'

const validateConfiguredPath = (name, value) => {
  if (value === undefined) {
    return undefined
  }
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${name} must be a non-empty valid path`)
  }
  return value
}

export const resolveDatabasePath = ({ dataDirectory, configuredPath }) => {
  const selected = validateConfiguredPath('AYAME_DATABASE_PATH', configuredPath)
  return selected ?? path.join(dataDirectory, 'ayame.sqlite')
}

export const resolveVaultsRootConfig = ({ defaultPath, configuredPath }) => {
  const selected = validateConfiguredPath('AYAME_VAULTS_PATH', configuredPath)
  return {
    path: selected ?? defaultPath,
    createIfMissing: selected === undefined,
  }
}
