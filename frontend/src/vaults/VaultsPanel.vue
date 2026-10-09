<template>
  <section
    class="vaults-panel"
    data-testid="vaults-panel"
    aria-labelledby="vaults-heading"
    :aria-busy="Boolean(operation)"
  >
    <header class="vaults-panel-header">
      <div>
        <h2 id="vaults-heading">Vaults</h2>
        <p class="status-message">Your spaces, discovered from the filesystem.</p>
      </div>
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="refresh-vaults-button"
        :disabled="Boolean(operation)"
        @click="refreshVaults"
      >
        {{ operation === 'refreshing' ? 'Refreshing...' : 'Refresh' }}
      </button>
    </header>

    <p v-if="errorMessage" class="error-message" role="alert" aria-live="polite">
      {{ errorMessage }}
    </p>

    <p v-if="operation === 'loading' || (!hasLoaded && !errorMessage)" class="status-message" role="status" aria-busy="true">
      Loading vaults...
    </p>
    <p v-if="operation === 'refreshing'" class="status-message" role="status" aria-busy="true">
      Refreshing vaults...
    </p>

    <div v-if="hasLoaded && vaults.length === 0" class="vaults-empty-state">
      <h3>No vaults found.</h3>
      <p>Add a folder to Ayame's configured vaults directory, then refresh.</p>
    </div>

    <ul v-else-if="hasLoaded" class="vault-list" aria-label="Vaults">
      <li
        v-for="vault in vaults"
        :key="vault.id || vault.directory"
        class="vault-row"
        data-testid="vault-row"
      >
        <template v-if="editingDirectory === vault.directory">
          <form class="vault-editor" data-testid="vault-editor" @submit.prevent="saveVault(vault)">
            <h3>Customize vault</h3>
            <div class="vault-editor-fields">
              <div class="form-group">
                <label class="form-label" for="vault-name">Display name</label>
                <input
                  id="vault-name"
                  v-model="editedName"
                  class="form-input"
                  name="name"
                  type="text"
                  maxlength="100"
                  autocomplete="off"
                  :disabled="Boolean(operation)"
                  required
                />
              </div>
              <div class="form-group vault-directory-field">
                <span class="form-label">Directory</span>
                <p class="vault-directory">{{ vault.directory }}/</p>
              </div>
            </div>
            <p v-if="editError" class="error-message" role="alert" aria-live="polite">
              {{ editError }}
            </p>
            <div class="vault-actions">
              <button type="submit" class="btn btn-primary" :disabled="Boolean(operation)">
                {{ operation === 'saving' ? 'Saving...' : 'Save' }}
              </button>
              <button
                type="button"
                class="btn btn-secondary"
                :disabled="Boolean(operation)"
                @click="cancelEdit"
              >
                Cancel
              </button>
            </div>
          </form>
        </template>

        <template v-else>
          <div class="vault-details">
            <div class="vault-title-line">
              <h3>{{ vault.name }}</h3>
              <span class="vault-status">{{ vault.registered ? 'Customized' : 'Detected' }}</span>
            </div>
            <p class="vault-directory">{{ vault.directory }}/</p>
          </div>
          <div v-if="!needsRefresh" class="vault-actions">
            <button
              v-if="!vault.registered"
              type="button"
              class="btn btn-secondary"
              :disabled="Boolean(operation)"
              @click="startEdit(vault)"
            >
              Customize
            </button>
            <button
              v-else
              type="button"
              class="btn btn-secondary"
              :disabled="Boolean(operation)"
              @click="resetVault(vault)"
            >
              {{ operation === 'resetting' ? 'Resetting...' : 'Reset' }}
            </button>
          </div>
        </template>
      </li>
    </ul>
  </section>
</template>

<script setup>
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { getVaults, registerVault, unregisterVault } from './api.js'

const emit = defineEmits(['unauthorized'])

const vaults = ref([])
const hasLoaded = ref(false)
const operation = ref('')
const errorMessage = ref('')
const editError = ref('')
const editingDirectory = ref(null)
const editedName = ref('')
const needsRefresh = ref(false)

let mounted = true

const showUnauthorized = () => {
  if (mounted) {
    emit('unauthorized')
  }
}

const loadCurrentVaults = async () => {
  try {
    const result = await getVaults()
    if (!mounted) {
      return false
    }
    vaults.value = result.vaults
    hasLoaded.value = true
    needsRefresh.value = false
    if (editingDirectory.value && !result.vaults.some((vault) => (
      vault.directory === editingDirectory.value && !vault.registered
    ))) {
      editingDirectory.value = null
      editedName.value = ''
      editError.value = ''
    }
    return true
  } catch (error) {
    if (!mounted) {
      return false
    }
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
      return null
    }
    return false
  }
}

const refreshVaults = async () => {
  if (operation.value) {
    return
  }

  const hadLoaded = hasLoaded.value
  operation.value = hadLoaded ? 'refreshing' : 'loading'
  errorMessage.value = ''

  try {
    const loaded = await loadCurrentVaults()
    if (mounted && loaded === false && errorMessage.value === '') {
      errorMessage.value = hadLoaded
        ? 'Could not refresh vaults. Try again.'
        : 'Could not load vaults. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

const startEdit = (vault) => {
  if (operation.value || needsRefresh.value || vault.registered) {
    return
  }
  editingDirectory.value = vault.directory
  editedName.value = vault.name
  editError.value = ''
  errorMessage.value = ''
}

const cancelEdit = () => {
  if (operation.value) {
    return
  }
  editingDirectory.value = null
  editedName.value = ''
  editError.value = ''
}

const refreshAfterMutation = async (failureMessage) => {
  needsRefresh.value = true
  const loaded = await loadCurrentVaults()
  if (!mounted) {
    return
  }
  if (loaded) {
    errorMessage.value = ''
  } else if (loaded === false) {
    errorMessage.value = failureMessage
  }
}

const saveVault = async (vault) => {
  if (operation.value || needsRefresh.value || editingDirectory.value !== vault.directory) {
    return
  }

  const directory = vault.directory
  const name = editedName.value
  operation.value = 'saving'
  editError.value = ''
  errorMessage.value = ''

  try {
    await registerVault({ name, directory })
    if (!mounted) {
      return
    }
    editingDirectory.value = null
    editedName.value = ''
    await refreshAfterMutation(
      'Customization was saved, but the list could not be refreshed. Refresh to see the latest state.'
    )
  } catch (error) {
    if (!mounted) {
      return
    }
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
    } else if (error.code === 'INVALID_VAULT_NAME') {
      editError.value = 'Enter a valid display name and try again.'
    } else if (error.code === 'INVALID_VAULT_DIRECTORY' || error.code === 'VAULT_ALREADY_REGISTERED') {
      editingDirectory.value = null
      editedName.value = ''
      needsRefresh.value = true
      const message = error.code === 'INVALID_VAULT_DIRECTORY'
        ? 'This vault folder is no longer available. Refresh and try again.'
        : 'This vault was customized elsewhere. The list has been refreshed.'
      const loaded = await loadCurrentVaults()
      if (mounted && loaded !== null) {
        errorMessage.value = loaded ? message : 'The vault changed, but the list could not be refreshed. Refresh to see the latest state.'
      }
    } else {
      editError.value = 'Could not customize this vault. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

const resetVault = async (vault) => {
  if (operation.value || needsRefresh.value || !vault.registered) {
    return
  }

  operation.value = 'resetting'
  errorMessage.value = ''

  try {
    await unregisterVault(vault.id)
    if (!mounted) {
      return
    }
    await refreshAfterMutation(
      'Customization was reset, but the list could not be refreshed. Refresh to see the latest state.'
    )
  } catch (error) {
    if (!mounted) {
      return
    }
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
    } else {
      errorMessage.value = 'Could not reset this vault. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

onMounted(refreshVaults)
onBeforeUnmount(() => {
  mounted = false
})
</script>
