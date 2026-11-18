<template>
  <section class="auth-section auth-card" data-testid="login-form">
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

      <div class="form-group">
        <label for="login-password" class="form-label">Password</label>
        <div class="password-field">
          <input
            id="login-password"
            v-model="password"
            name="password"
            :type="showPassword ? 'text' : 'password'"
            class="form-input form-input--with-toggle"
            autocomplete="current-password"
            required
            :disabled="pending"
            @keydown="handleKeyState"
            @keyup="handleKeyState"
            @blur="capsLockOn = false"
          />
          <button
            type="button"
            class="password-toggle-btn"
            data-testid="toggle-password-visibility"
            :aria-label="showPassword ? 'Hide password' : 'Show password'"
            :aria-pressed="showPassword ? 'true' : 'false'"
            :disabled="pending"
            @click="showPassword = !showPassword"
          >
            {{ showPassword ? 'Hide' : 'Show' }}
          </button>
        </div>
        <p v-if="capsLockOn" class="auth-caps-warning" data-testid="caps-lock-warning" role="status">
          Caps Lock is on
        </p>
      </div>

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
const showPassword = ref(false)
const rememberMe = ref(false)
const capsLockOn = ref(false)

watch(
  () => props.initialUsername,
  (newVal) => {
    if (newVal) {
      username.value = newVal
    }
  }
)

const handleKeyState = (event) => {
  if (typeof event.getModifierState === 'function') {
    capsLockOn.value = Boolean(event.getModifierState('CapsLock'))
  }
}

const handleSubmit = () => {
  if (props.pending) {
    return
  }
  const submittedPassword = password.value
  password.value = ''
  showPassword.value = false
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
