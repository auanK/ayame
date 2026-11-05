<template>
  <div class="form-group">
    <label :for="id" class="form-label">{{ label }}</label>
    <div class="password-field">
      <input
        :id="id"
        :value="modelValue"
        :name="name"
        :type="showPassword ? 'text' : 'password'"
        class="form-input form-input--with-toggle"
        :autocomplete="autocomplete"
        :required="required"
        :disabled="disabled"
        @input="emit('update:modelValue', $event.target.value)"
        @keydown="handleKeyState"
        @keyup="handleKeyState"
        @blur="capsLockOn = false"
      />
      <button
        type="button"
        class="password-toggle-btn"
        :data-testid="toggleTestId"
        :aria-label="showPassword ? 'Hide password' : 'Show password'"
        :aria-pressed="showPassword ? 'true' : 'false'"
        :disabled="disabled"
        @click="showPassword = !showPassword"
      >
        {{ showPassword ? 'Hide' : 'Show' }}
      </button>
    </div>
    <p
      v-if="detectCapsLock && capsLockOn"
      class="auth-caps-warning"
      data-testid="caps-lock-warning"
      role="status"
    >
      Caps Lock is on
    </p>
    <slot />
  </div>
</template>

<script setup>
import { ref } from 'vue'

const props = defineProps({
  id: {
    type: String,
    required: true,
  },
  label: {
    type: String,
    default: 'Password',
  },
  name: {
    type: String,
    default: 'password',
  },
  modelValue: {
    type: String,
    default: '',
  },
  autocomplete: {
    type: String,
    default: 'current-password',
  },
  required: {
    type: Boolean,
    default: true,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
  detectCapsLock: {
    type: Boolean,
    default: true,
  },
  toggleTestId: {
    type: String,
    default: 'toggle-password-visibility',
  },
})

const emit = defineEmits(['update:modelValue'])

const showPassword = ref(false)
const capsLockOn = ref(false)

const handleKeyState = (event) => {
  if (!props.detectCapsLock) return
  if (typeof event.getModifierState === 'function') {
    capsLockOn.value = Boolean(event.getModifierState('CapsLock'))
  }
}

const resetVisibility = () => {
  showPassword.value = false
}

defineExpose({ resetVisibility })
</script>
