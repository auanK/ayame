<template>
  <section class="auth-section auth-card" data-testid="setup-form">
    <div class="auth-card-header">
      <h2>Create your Ayame space</h2>
      <p class="status-message">Create the owner account for this Ayame installation.</p>
    </div>

    <div v-if="errorMessage" class="error-message" role="alert" aria-live="polite">
      {{ errorMessage }}
    </div>

    <form @submit.prevent="handleSubmit">
      <div class="form-group">
        <label for="setup-username" class="form-label">Username</label>
        <input
          id="setup-username"
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
        <p
          class="auth-field-hint"
          :class="{
            'auth-field-hint--valid': username.length > 0 && usernameValid,
            'auth-field-hint--warn': username.length > 0 && !usernameValid,
          }"
          data-testid="setup-username-hint"
        >
          Lowercase letters, numbers, dots, underscores, or hyphens (max 32).
        </p>
      </div>

      <div class="form-group">
        <label for="setup-password" class="form-label">Password</label>
        <div class="password-field">
          <input
            id="setup-password"
            v-model="password"
            name="password"
            :type="showPassword ? 'text' : 'password'"
            class="form-input form-input--with-toggle"
            autocomplete="new-password"
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
        <div v-if="password.length > 0" class="password-strength" data-testid="password-strength">
          <div class="password-strength-track">
            <div
              class="password-strength-fill"
              :class="`password-strength-fill--${passwordStrength.level}`"
              :style="{ width: passwordStrength.width }"
            />
          </div>
          <span class="password-strength-label">{{ passwordStrength.label }}</span>
        </div>
      </div>

      <button
        type="submit"
        class="btn btn-primary"
        :disabled="pending"
      >
        {{ pending ? 'Creating account...' : 'Create Account' }}
      </button>
    </form>
  </section>
</template>

<script setup>
import { computed, ref } from 'vue'

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
const capsLockOn = ref(false)

const usernameValid = computed(() => /^[a-z0-9][a-z0-9._-]{0,31}$/.test(username.value))

const passwordStrength = computed(() => {
  const value = password.value
  let score = 0
  if (value.length >= 8) score += 1
  if (value.length >= 14) score += 1
  if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score += 1
  if (/[0-9]/.test(value) || /[^a-zA-Z0-9]/.test(value)) score += 1

  if (value.length < 8 || score <= 1) {
    return { level: 'weak', width: '33%', label: 'Short' }
  }
  if (score <= 3) {
    return { level: 'medium', width: '68%', label: 'Good' }
  }
  return { level: 'strong', width: '100%', label: 'Strong' }
})

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
  emit('submit', {
    username: username.value,
    password: submittedPassword,
  })
}
</script>
