<template>
  <main
    class="ayame-app"
    :class="{
      'ayame-app--fullscreen': view === 'authenticated' && activeVault,
      'ayame-app--workspace': view === 'authenticated' && !activeVault,
    }"
  >
    <header v-if="!activeVault" class="ayame-header">
      <h1 class="ayame-wordmark">ayame</h1>
      <button
        v-if="view === 'authenticated'"
        type="button"
        class="btn btn-secondary"
        data-testid="logout-button"
        :disabled="pending || editorSaving || editorReloading"
        @click="requestLogout"
      >
        {{ pending ? 'Signing out...' : 'Logout' }}
      </button>
    </header>

    <template v-if="!activeVault">
      <p class="ayame-tagline">A place to think.</p>
      <div class="ayame-divider" aria-hidden="true"></div>
    </template>

    <div
      v-if="view === 'loading'"
      data-testid="loading-state"
      class="status-message"
    >
      Loading Ayame...
    </div>

    <div
      v-else-if="view === 'error'"
      data-testid="error-state"
    >
      <h2>Unable to connect</h2>
      <p class="error-message" role="alert" aria-live="polite">
        {{ errorMessage || 'Ayame could not reach the server.' }}
      </p>
      <button
        type="button"
        class="btn btn-secondary"
        data-testid="retry-button"
        @click="fetchStatus"
      >
        Retry
      </button>
    </div>

    <SetupForm
      v-else-if="view === 'setup'"
      :pending="pending"
      :error-message="errorMessage"
      :initial-username="preservedUsername"
      @submit="handleSetupSubmit"
    />

    <LoginForm
      v-else-if="view === 'login'"
      :pending="pending"
      :error-message="errorMessage"
      :initial-username="preservedUsername"
      @submit="handleLoginSubmit"
    />

    <section
      v-else-if="view === 'authenticated'"
      data-testid="authenticated-shell"
      class="workspace"
    >
      <VaultBrowser
        v-if="activeVault"
        :vault="activeVault"
        :pending="pending"
        :editor-saving="editorSaving"
        :editor-reloading="editorReloading"
        @back="handleCloseVault"
        @unauthorized="handleVaultUnauthorized"
        @state="handleEditorState"
        @logout="requestLogout"
      />
      <VaultsPanel
        v-else
        @open="handleOpenVault"
        @unauthorized="handleVaultUnauthorized"
      />
      <p
        v-if="errorMessage"
        class="error-message"
        role="alert"
        aria-live="polite"
      >
        {{ errorMessage }}
      </p>
    </section>

    <div v-if="logoutConfirm" class="logout-confirm" role="dialog" aria-modal="true" aria-labelledby="logout-title">
      <p id="logout-title">Discard your unsaved changes and log out?</p>
      <button type="button" class="btn btn-secondary" data-testid="logout-keep-editing" :disabled="editorSaving || editorReloading" @click="logoutConfirm = false">Keep editing</button>
      <button type="button" class="btn btn-secondary" data-testid="logout-discard-changes" :disabled="editorSaving || editorReloading" @click="confirmLogout">Discard changes and log out</button>
    </div>
  </main>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import SetupForm from './auth/SetupForm.vue'
import LoginForm from './auth/LoginForm.vue'
import VaultsPanel from './vaults/VaultsPanel.vue'
import VaultBrowser from './vaults/VaultBrowser.vue'
import { getAuthStatus, createOwner, login, logout } from './auth/api.js'

const view = ref('loading')
const pending = ref(false)
const errorMessage = ref('')
const preservedUsername = ref('')
const activeVault = ref(null)
const editorDirty = ref(false)
const editorSaving = ref(false)
const editorReloading = ref(false)
const logoutConfirm = ref(false)

const handleOpenVault = (vault) => {
  activeVault.value = vault
  errorMessage.value = ''
}

const handleCloseVault = () => {
  activeVault.value = null
  editorDirty.value = false
  editorSaving.value = false
  editorReloading.value = false
  errorMessage.value = ''
}

const fetchStatus = async () => {
  view.value = 'loading'
  errorMessage.value = ''
  try {
    const status = await getAuthStatus()
    if (!status.initialized) {
      view.value = 'setup'
    } else if (status.authenticated) {
      view.value = 'authenticated'
    } else {
      view.value = 'login'
    }
  } catch {
    view.value = 'error'
    errorMessage.value = 'Ayame could not reach the server.'
  }
}

const handleSetupSubmit = async ({ username, password }) => {
  if (pending.value) {
    return
  }
  pending.value = true
  errorMessage.value = ''

  try {
    await createOwner({ username, password })
    preservedUsername.value = username
    view.value = 'login'
    errorMessage.value = ''
  } catch (err) {
    if (err.code === 'INVALID_USERNAME') {
      errorMessage.value = 'Use up to 32 lowercase letters, numbers, dots, underscores, or hyphens.'
    } else if (err.code === 'INVALID_PASSWORD') {
      errorMessage.value = 'Enter a password between 1 and 1024 characters.'
    } else if (err.code === 'OWNER_ALREADY_EXISTS') {
      errorMessage.value = ''
      await fetchStatus()
    } else {
      errorMessage.value = 'Ayame could not reach the server.'
    }
  } finally {
    pending.value = false
  }
}

const handleLoginSubmit = async ({ username, password }) => {
  if (pending.value) {
    return
  }
  pending.value = true
  errorMessage.value = ''

  try {
    await login({ username, password })
    view.value = 'authenticated'
    errorMessage.value = ''
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') {
      errorMessage.value = 'Invalid username or password.'
    } else {
      errorMessage.value = 'Ayame could not reach the server.'
    }
  } finally {
    pending.value = false
  }
}

const requestLogout = () => {
  if (pending.value || editorSaving.value || editorReloading.value) return
  if (editorDirty.value) {
    logoutConfirm.value = true
    return
  }
  handleLogout()
}

const confirmLogout = () => {
  if (editorSaving.value || editorReloading.value) return
  logoutConfirm.value = false
  handleLogout()
}

const handleEditorState = (state) => {
  editorDirty.value = Boolean(state?.dirty)
  editorSaving.value = Boolean(state?.saving)
  editorReloading.value = Boolean(state?.reloading)
}

const handleLogout = async () => {
  if (pending.value || editorSaving.value || editorReloading.value) {
    return
  }
  pending.value = true
  errorMessage.value = ''

  try {
    await logout()
    activeVault.value = null
    editorDirty.value = false
    editorSaving.value = false
    editorReloading.value = false
    view.value = 'login'
    errorMessage.value = ''
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') {
      activeVault.value = null
      editorDirty.value = false
      editorSaving.value = false
      editorReloading.value = false
      view.value = 'login'
      errorMessage.value = ''
    } else {
      errorMessage.value = 'Ayame could not reach the server.'
    }
  } finally {
    pending.value = false
  }
}

const handleVaultUnauthorized = () => {
  activeVault.value = null
  editorDirty.value = false
  editorSaving.value = false
  editorReloading.value = false
  logoutConfirm.value = false
  view.value = 'login'
  errorMessage.value = ''
}

onMounted(() => {
  fetchStatus()
})
</script>

<style scoped>
.logout-confirm {
  padding: 0.75rem;
  border: 1px solid rgba(212, 203, 228, 0.2);
  border-radius: 6px;
  background: rgba(17, 18, 24, 0.9);
}
</style>
