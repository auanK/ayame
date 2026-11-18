<template>
  <div
    class="ayame-modal-backdrop"
    data-testid="account-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="account-modal-title"
    @click.self="$emit('close')"
  >
    <div class="ayame-modal-card">
      <header class="ayame-modal-header">
        <div>
          <h3 id="account-modal-title">Account &amp; security</h3>
          <p v-if="username" class="ayame-modal-subtitle">Signed in as @{{ username }}</p>
        </div>
        <button
          type="button"
          class="btn btn-secondary btn-compact"
          data-testid="close-account-modal"
          aria-label="Close account modal"
          @click="$emit('close')"
        >
          Close
        </button>
      </header>

      <div v-if="loadingAccount" class="status-message" role="status">
        Loading account details...
      </div>

      <div v-else class="account-sections">
        <section class="account-section">
          <div class="account-session-row">
            <div>
              <strong>Active sessions</strong>
              <p class="account-muted">
                {{ activeSessions }} active {{ activeSessions === 1 ? 'session' : 'sessions' }} on this installation
              </p>
            </div>
            <button
              type="button"
              class="btn btn-secondary btn-compact"
              data-testid="logout-other-sessions-button"
              :disabled="revokingOthers || activeSessions <= 1"
              @click="handleLogoutOthers"
            >
              {{ revokingOthers ? 'Signing out...' : 'Sign out other devices' }}
            </button>
          </div>
          <p v-if="sessionMessage" class="account-success" role="status">
            {{ sessionMessage }}
          </p>
          <p v-if="sessionError" class="error-message" role="alert">
            {{ sessionError }}
          </p>
        </section>

        <section class="account-section">
          <h4>Change password</h4>
          <form data-testid="change-password-form" @submit.prevent="handlePasswordSubmit">
            <div class="form-group">
              <label for="account-current-password" class="form-label">Current password</label>
              <input
                id="account-current-password"
                v-model="currentPassword"
                type="password"
                class="form-input"
                autocomplete="current-password"
                required
                :disabled="savingPassword"
              />
            </div>

            <div class="form-group">
              <label for="account-new-password" class="form-label">New password</label>
              <input
                id="account-new-password"
                v-model="newPassword"
                type="password"
                class="form-input"
                autocomplete="new-password"
                required
                :disabled="savingPassword"
              />
            </div>

            <div class="form-group">
              <label for="account-confirm-password" class="form-label">Confirm new password</label>
              <input
                id="account-confirm-password"
                v-model="confirmPassword"
                type="password"
                class="form-input"
                autocomplete="new-password"
                required
                :disabled="savingPassword"
              />
            </div>

            <p v-if="passwordError" class="error-message" role="alert">
              {{ passwordError }}
            </p>
            <p v-if="passwordSuccess" class="account-success" role="status">
              {{ passwordSuccess }}
            </p>

            <button type="submit" class="btn btn-primary" :disabled="savingPassword">
              {{ savingPassword ? 'Updating...' : 'Update password' }}
            </button>
          </form>
        </section>
      </div>
    </div>
  </div>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import * as authApi from './api.js'

const emit = defineEmits(['close', 'unauthorized'])

const loadingAccount = ref(true)
const username = ref('')
const activeSessions = ref(1)
const revokingOthers = ref(false)
const sessionMessage = ref('')
const sessionError = ref('')

const currentPassword = ref('')
const newPassword = ref('')
const confirmPassword = ref('')
const savingPassword = ref(false)
const passwordError = ref('')
const passwordSuccess = ref('')

let mounted = true

const loadAccount = async () => {
  loadingAccount.value = true
  sessionError.value = ''
  try {
    if (typeof authApi.getAccount === 'function') {
      const info = await authApi.getAccount()
      if (!mounted) return
      username.value = info.username
      activeSessions.value = info.activeSessions
    }
  } catch (err) {
    if (!mounted) return
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    sessionError.value = 'Could not load account details.'
  } finally {
    if (mounted) {
      loadingAccount.value = false
    }
  }
}

const handleLogoutOthers = async () => {
  if (revokingOthers.value || typeof authApi.logoutOtherSessions !== 'function') return
  revokingOthers.value = true
  sessionMessage.value = ''
  sessionError.value = ''
  try {
    const res = await authApi.logoutOtherSessions()
    if (!mounted) return
    activeSessions.value = 1
    sessionMessage.value = res.revoked > 0
      ? `Signed out ${res.revoked} other ${res.revoked === 1 ? 'session' : 'sessions'}.`
      : 'No other active sessions found.'
  } catch (err) {
    if (!mounted) return
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    sessionError.value = 'Could not sign out other sessions.'
  } finally {
    if (mounted) {
      revokingOthers.value = false
    }
  }
}

const handlePasswordSubmit = async () => {
  if (savingPassword.value || typeof authApi.changePassword !== 'function') return
  passwordError.value = ''
  passwordSuccess.value = ''

  if (newPassword.value !== confirmPassword.value) {
    passwordError.value = 'New passwords do not match.'
    return
  }

  savingPassword.value = true
  try {
    await authApi.changePassword({
      currentPassword: currentPassword.value,
      newPassword: newPassword.value,
    })
    if (!mounted) return
    currentPassword.value = ''
    newPassword.value = ''
    confirmPassword.value = ''
    activeSessions.value = 1
    passwordSuccess.value = 'Password updated. Other sessions signed out.'
  } catch (err) {
    if (!mounted) return
    if (err?.code === 'UNAUTHORIZED') {
      emit('unauthorized')
      return
    }
    if (err?.code === 'INVALID_CURRENT_PASSWORD') {
      passwordError.value = 'Current password is incorrect.'
    } else if (err?.code === 'INVALID_PASSWORD') {
      passwordError.value = 'Enter a new password between 1 and 1024 characters.'
    } else {
      passwordError.value = 'Could not update password. Try again.'
    }
  } finally {
    if (mounted) {
      savingPassword.value = false
    }
  }
}

const handleEsc = (event) => {
  if (event.key === 'Escape') {
    emit('close')
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleEsc)
  void loadAccount()
})

onUnmounted(() => {
  mounted = false
  window.removeEventListener('keydown', handleEsc)
})
</script>

<style scoped>
.ayame-modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
  background: rgba(11, 12, 16, 0.72);
  backdrop-filter: blur(4px);
}

.ayame-modal-card {
  width: min(100%, 460px);
  max-height: 90vh;
  overflow-y: auto;
  padding: 1.5rem;
  border: 1px solid var(--ayame-border);
  border-radius: 10px;
  background: var(--ayame-surface);
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.55);
}

.ayame-modal-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--ayame-border);
  margin-bottom: 1rem;
}

.ayame-modal-header h3 {
  margin: 0;
  font-family: Georgia, 'Times New Roman', serif;
  font-size: 1.25rem;
  font-weight: 400;
  color: var(--ayame-text);
}

.ayame-modal-subtitle {
  margin: 0.2rem 0 0;
  color: var(--ayame-primary);
  font-size: 0.875rem;
}

.account-sections {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
}

.account-section {
  padding: 1rem;
  border: 1px solid var(--ayame-border);
  border-radius: 8px;
  background: rgba(17, 18, 24, 0.45);
}

.account-section h4 {
  margin: 0 0 0.85rem;
  font-size: 0.95rem;
  font-weight: 600;
  color: var(--ayame-text);
}

.account-session-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
}

.account-muted {
  margin: 0.25rem 0 0;
  color: var(--ayame-text-muted);
  font-size: 0.84rem;
}

.account-success {
  margin: 0.75rem 0 0;
  padding: 0.55rem 0.7rem;
  border: 1px solid rgba(143, 199, 168, 0.35);
  border-radius: 4px;
  background: rgba(143, 199, 168, 0.1);
  color: #a9dec0;
  font-size: 0.85rem;
}
</style>
