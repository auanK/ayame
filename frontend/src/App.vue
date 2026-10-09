<template>
  <main class="ayame-app" :class="{ 'ayame-app--workspace': view === 'authenticated' }">
    <header class="ayame-header">
      <h1 class="ayame-wordmark">ayame</h1>
      <button
        v-if="view === 'authenticated'"
        type="button"
        class="btn btn-secondary"
        data-testid="logout-button"
        :disabled="pending"
        @click="handleLogout"
      >
        {{ pending ? 'Signing out...' : 'Logout' }}
      </button>
    </header>

    <p class="ayame-tagline">A place to think.</p>
    <div class="ayame-divider" aria-hidden="true"></div>

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
      <h2>Workspace</h2>
      <p class="status-message">Your workspace is ready.</p>
      <p
        v-if="errorMessage"
        class="error-message"
        role="alert"
        aria-live="polite"
      >
        {{ errorMessage }}
      </p>
    </section>
  </main>
</template>

<script setup>
import { ref, onMounted } from 'vue'
import SetupForm from './auth/SetupForm.vue'
import LoginForm from './auth/LoginForm.vue'
import { getAuthStatus, createOwner, login, logout } from './auth/api.js'

const view = ref('loading')
const pending = ref(false)
const errorMessage = ref('')
const preservedUsername = ref('')

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

const handleLogout = async () => {
  if (pending.value) {
    return
  }
  pending.value = true
  errorMessage.value = ''

  try {
    await logout()
    view.value = 'login'
    errorMessage.value = ''
  } catch (err) {
    if (err.code === 'UNAUTHORIZED') {
      view.value = 'login'
      errorMessage.value = ''
    } else {
      errorMessage.value = 'Ayame could not reach the server.'
    }
  } finally {
    pending.value = false
  }
}

onMounted(() => {
  fetchStatus()
})
</script>
