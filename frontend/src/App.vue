<template>
  <main
    class="ayame-app"
    :class="{
      'ayame-app--fullscreen': view === 'authenticated' && resolvedVault,
      'ayame-app--workspace': view === 'authenticated' && !resolvedVault,
    }"
  >
    <header v-if="!resolvedVault" class="ayame-header">
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

    <template v-if="!resolvedVault">
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
        v-if="resolvedVault"
        :vault="resolvedVault"
        :pending="pending"
        :editor-saving="editorSaving"
        :editor-reloading="editorReloading"
        @back="handleCloseVault"
        @unauthorized="handleVaultUnauthorized"
        @state="handleEditorState"
        @logout="requestLogout"
      />
      <div
        v-else-if="resolvingVault"
        data-testid="vault-resolving-state"
        class="status-message"
        role="status"
        aria-busy="true"
      >
        Loading vault...
      </div>
      <VaultsPanel
        v-else
        :initial-vaults="prefetchedVaults"
        @loaded="handleVaultsLoaded"
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
import { ref, watch, onMounted, onUnmounted } from 'vue'
import SetupForm from './auth/SetupForm.vue'
import LoginForm from './auth/LoginForm.vue'
import VaultsPanel from './vaults/VaultsPanel.vue'
import VaultBrowser from './vaults/VaultBrowser.vue'
import { getAuthStatus, createOwner, login, logout } from './auth/api.js'
import { getVaults } from './vaults/api.js'
import { isValidVaultDirectory, useAyameRouter } from './router/index.js'

const { router, route } = useAyameRouter()

const view = ref('loading')
const pending = ref(false)
const errorMessage = ref('')
const preservedUsername = ref('')
const resolvedVault = ref(null)
const resolvingVault = ref(false)
const knownVaults = ref([])
const prefetchedVaults = ref(null)
const editorDirty = ref(false)
const editorSaving = ref(false)
const editorReloading = ref(false)
const logoutConfirm = ref(false)

let isMounted = true
let authGeneration = 0
let vaultResolveGeneration = 0

const ensureInitialRouteReady = async () => {
  if (route.value.matched.length === 0) {
    try {
      await router.replace(router.options.history.location || '/')
    } catch {}
  }
}

const handleVaultsLoaded = (vaults) => {
  if (Array.isArray(vaults)) {
    knownVaults.value = vaults
  }
  prefetchedVaults.value = null
}

const syncVaultFromRoute = async () => {
  if (route.value.matched.length === 0) {
    await ensureInitialRouteReady()
  }
  if (!isMounted || view.value !== 'authenticated') {
    return
  }

  const currentName = route.value.name
  if (currentName === 'vaults') {
    vaultResolveGeneration++
    resolvingVault.value = false
    resolvedVault.value = null
    editorDirty.value = false
    editorSaving.value = false
    editorReloading.value = false
    return
  }

  if (currentName === 'not-found') {
    vaultResolveGeneration++
    resolvingVault.value = false
    resolvedVault.value = null
    errorMessage.value = 'Page not found.'
    await router.replace({ name: 'vaults' })
    return
  }

  if (currentName === 'vault') {
    const rawDirectory = route.value.params?.directory
    const directory = typeof rawDirectory === 'string' ? rawDirectory : ''

    if (!isValidVaultDirectory(directory)) {
      vaultResolveGeneration++
      resolvingVault.value = false
      resolvedVault.value = null
      errorMessage.value = 'Invalid vault directory in URL.'
      await router.replace({ name: 'vaults' })
      return
    }

    if (resolvedVault.value && resolvedVault.value.directory === directory) {
      resolvingVault.value = false
      return
    }

    const cached = knownVaults.value.find((v) => v.directory === directory)
    if (cached) {
      vaultResolveGeneration++
      resolvingVault.value = false
      resolvedVault.value = cached
      return
    }

    const resolveGen = ++vaultResolveGeneration
    const currentAuthGen = authGeneration
    resolvingVault.value = true
    resolvedVault.value = null

    try {
      const result = await getVaults()
      if (
        !isMounted ||
        resolveGen !== vaultResolveGeneration ||
        currentAuthGen !== authGeneration ||
        view.value !== 'authenticated'
      ) {
        return
      }
      const vaults = Array.isArray(result?.vaults) ? result.vaults : []
      knownVaults.value = vaults
      const matched = vaults.find((v) => v.directory === directory)
      if (matched) {
        resolvingVault.value = false
        resolvedVault.value = matched
      } else {
        resolvingVault.value = false
        resolvedVault.value = null
        prefetchedVaults.value = vaults
        errorMessage.value = `Vault "${directory}" was not found.`
        await router.replace({ name: 'vaults' })
      }
    } catch (err) {
      if (
        !isMounted ||
        resolveGen !== vaultResolveGeneration ||
        currentAuthGen !== authGeneration ||
        view.value !== 'authenticated'
      ) {
        return
      }
      resolvingVault.value = false
      resolvedVault.value = null
      if (err?.code === 'UNAUTHORIZED') {
        handleVaultUnauthorized()
      } else {
        errorMessage.value = 'Could not load vaults. Try again.'
        await router.replace({ name: 'vaults' })
      }
    }
  }
}

const handleOpenVault = async (vault) => {
  if (!vault?.directory) return
  errorMessage.value = ''
  prefetchedVaults.value = null
  const existingIdx = knownVaults.value.findIndex((v) => v.directory === vault.directory)
  if (existingIdx >= 0) {
    const next = [...knownVaults.value]
    next[existingIdx] = vault
    knownVaults.value = next
  } else {
    knownVaults.value = [...knownVaults.value, vault]
  }
  await router.push({
    name: 'vault',
    params: {
      directory: vault.directory,
    },
  })
}

const handleCloseVault = async () => {
  editorDirty.value = false
  editorSaving.value = false
  editorReloading.value = false
  errorMessage.value = ''
  if (route.value.name !== 'vaults') {
    await router.push({ name: 'vaults' })
  } else {
    resolvedVault.value = null
  }
}

const fetchStatus = async () => {
  const currentAuthGen = ++authGeneration
  view.value = 'loading'
  errorMessage.value = ''
  await ensureInitialRouteReady()
  try {
    const status = await getAuthStatus()
    if (!isMounted || currentAuthGen !== authGeneration) return
    if (!status.initialized) {
      view.value = 'setup'
    } else if (status.authenticated) {
      view.value = 'authenticated'
      await syncVaultFromRoute()
    } else {
      view.value = 'login'
    }
  } catch {
    if (!isMounted || currentAuthGen !== authGeneration) return
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
    if (!isMounted) return
    preservedUsername.value = username
    view.value = 'login'
    errorMessage.value = ''
  } catch (err) {
    if (!isMounted) return
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
    if (isMounted) {
      pending.value = false
    }
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
    if (!isMounted) return
    authGeneration++
    view.value = 'authenticated'
    errorMessage.value = ''
    await syncVaultFromRoute()
  } catch (err) {
    if (!isMounted) return
    if (err.code === 'UNAUTHORIZED') {
      errorMessage.value = 'Invalid username or password.'
    } else {
      errorMessage.value = 'Ayame could not reach the server.'
    }
  } finally {
    if (isMounted) {
      pending.value = false
    }
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

const clearAuthenticatedState = () => {
  authGeneration++
  vaultResolveGeneration++
  resolvingVault.value = false
  resolvedVault.value = null
  knownVaults.value = []
  prefetchedVaults.value = null
  editorDirty.value = false
  editorSaving.value = false
  editorReloading.value = false
  logoutConfirm.value = false
}

const handleLogout = async () => {
  if (pending.value || editorSaving.value || editorReloading.value) {
    return
  }
  pending.value = true
  errorMessage.value = ''

  try {
    await logout()
    if (!isMounted) return
    clearAuthenticatedState()
    view.value = 'login'
    errorMessage.value = ''
    if (route.value.path !== '/') {
      await router.replace({ name: 'vaults' })
    }
  } catch (err) {
    if (!isMounted) return
    if (err.code === 'UNAUTHORIZED') {
      clearAuthenticatedState()
      view.value = 'login'
      errorMessage.value = ''
      if (route.value.path !== '/') {
        await router.replace({ name: 'vaults' })
      }
    } else {
      errorMessage.value = 'Ayame could not reach the server.'
    }
  } finally {
    if (isMounted) {
      pending.value = false
    }
  }
}

const handleVaultUnauthorized = () => {
  clearAuthenticatedState()
  view.value = 'login'
  errorMessage.value = ''
}

watch(
  () => [route.value.name, route.value.params?.directory, route.value.fullPath],
  () => {
    if (view.value === 'authenticated') {
      void syncVaultFromRoute()
    }
  }
)

onMounted(() => {
  isMounted = true
  fetchStatus()
})

onUnmounted(() => {
  isMounted = false
  authGeneration++
  vaultResolveGeneration++
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
