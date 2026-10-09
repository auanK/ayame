<template>
  <section class="auth-section" data-testid="login-form">
    <h2>Login</h2>
    <p class="status-message">Sign in to continue.</p>

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
          required
          :disabled="pending"
        />
      </div>

      <div class="form-group">
        <label for="login-password" class="form-label">Password</label>
        <input
          id="login-password"
          v-model="password"
          name="password"
          type="password"
          class="form-input"
          autocomplete="current-password"
          required
          :disabled="pending"
        />
      </div>

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
  emit('submit', {
    username: username.value,
    password: submittedPassword,
  })
}
</script>
