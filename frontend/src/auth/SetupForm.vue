<template>
  <section class="auth-section" data-testid="setup-form">
    <h2>Create your Ayame space</h2>
    <p class="status-message">Create the owner account for this Ayame installation.</p>

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
          required
          :disabled="pending"
        />
      </div>

      <div class="form-group">
        <label for="setup-password" class="form-label">Password</label>
        <input
          id="setup-password"
          v-model="password"
          name="password"
          type="password"
          class="form-input"
          autocomplete="new-password"
          required
          :disabled="pending"
        />
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
import { ref } from 'vue'

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
