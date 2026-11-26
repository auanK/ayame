<template>
  <BaseModal
    title="Account & security"
    title-id="account-modal-title"
    :subtitle="username ? `Signed in as @${username}` : ''"
    test-id="account-modal"
    close-test-id="close-account-modal"
    close-aria-label="Close account modal"
    @close="$emit('close')"
  >
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

          <div class="account-form-actions">
            <button type="submit" class="btn btn-primary" :disabled="savingPassword">
              {{ savingPassword ? 'Updating...' : 'Update password' }}
            </button>
          </div>
        </form>
      </section>
    </div>
  </BaseModal>
</template>

<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import BaseModal from '../components/BaseModal.vue'
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

onMounted(() => {
  void loadAccount()
})

onUnmounted(() => {
  mounted = false
})
</script>

<style scoped>
.account-sections {
  display: flex;
  flex-direction: column;
  gap: 1.15rem;
}

.account-section {
  padding-top: 0;
}

.account-section + .account-section {
  padding-top: 1.1rem;
  border-top: 1px solid var(--ayame-border);
}

.account-section h4 {
  margin: 0 0 0.8rem;
  font-size: 0.875rem;
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
  margin: 0.2rem 0 0;
  color: var(--ayame-text-muted);
  font-size: 0.8rem;
}

.account-form-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: 0.25rem;
}

.account-success {
  margin: 0.75rem 0 0;
  padding: 0.5rem 0.7rem;
  border: 1px solid color-mix(in srgb, var(--ayame-success-accent) 35%, transparent);
  border-left: 2px solid var(--ayame-success-accent);
  border-radius: var(--radius-xs);
  background: color-mix(in srgb, var(--ayame-success-accent) 10%, transparent);
  color: var(--ayame-success);
  font-size: 0.82rem;
}
</style>
