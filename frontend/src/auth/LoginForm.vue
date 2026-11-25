<template>
  <section class="auth-section" data-testid="login-form">
    <div class="auth-card-header">
      <h2>Welcome back</h2>
      <p class="status-message">Sign in to access your vaults.</p>
    </div>

    <div v-if="errorMessage" class="error-message" role="alert" aria-live="polite">
      {{ errorMessage }}
    </div>

    <form @submit.prevent="handleSubmit">
      <div class="form-group">
        <label for="login-username" class="form-label">Username</label>
        <input
          id="login-username"
          v-model="username"
          name="username"
          type="text"
          class="form-input"
          autocomplete="username"
          autocapitalize="none"
          spellcheck="false"
          required
          :disabled="pending"
        />
      </div>

      <PasswordField
        id="login-password"
        ref="passwordFieldRef"
        v-model="password"
        autocomplete="current-password"
        :disabled="pending"
      />

      <label class="auth-remember-row">
        <input
          v-model="rememberMe"
          type="checkbox"
          data-testid="remember-me-checkbox"
          :disabled="pending"
        />
        <span>Keep me signed in (30 days)</span>
      </label>

      <button
        type="submit"
        class="btn btn-primary"
        :disabled="pending"
      >
        {{ pending ? 'Signing in...' : 'Sign In' }}
      </button>
    </form>
  </section>
</template>

<script setup>
import { ref, watch } from 'vue'
import PasswordField from '../components/PasswordField.vue'

const props = defineProps({
  pending: {
    type: Boolean,
    default: false,
  },
  errorMessage: {
    type: String,
    default: '',
  },
  initialUsername: {
    type: String,
    default: '',
  },
})

const emit = defineEmits(['submit'])

const username = ref(props.initialUsername)
const password = ref('')
const rememberMe = ref(false)
const passwordFieldRef = ref(null)

watch(
  () => props.initialUsername,
  (newVal) => {
    if (newVal) {
      username.value = newVal
    }
  }
)

const handleSubmit = () => {
  if (props.pending) {
    return
  }
  const submittedPassword = password.value
  password.value = ''
  passwordFieldRef.value?.resetVisibility?.()
  const payload = {
    username: username.value,
    password: submittedPassword,
  }
  if (rememberMe.value) {
    payload.rememberMe = true
  }
  emit('submit', payload)
}
</script>
