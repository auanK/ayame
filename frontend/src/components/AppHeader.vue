<template>
  <header class="ayame-header" :class="{ 'ayame-header--desktop': authenticated }">
    <div class="ayame-brand-row">
      <AyameMark :size="authenticated ? 18 : 26" />
      <h1 class="ayame-wordmark">ayame</h1>
      <p v-if="authenticated" class="ayame-tagline ayame-tagline--inline">A place to think.</p>
    </div>
    <div v-if="authenticated" class="ayame-header-actions">
      <button
        type="button"
        class="btn btn-secondary btn-compact"
        data-testid="account-button"
        :disabled="disabled"
        @click="emit('open-account')"
      >
        Account
      </button>
      <button
        type="button"
        class="btn btn-secondary btn-compact"
        data-testid="logout-button"
        :disabled="disabled"
        @click="emit('logout')"
      >
        {{ pending ? 'Signing out...' : 'Logout' }}
      </button>
    </div>
  </header>
</template>

<script setup>
import AyameMark from '../auth/AyameMark.vue'

defineProps({
  authenticated: {
    type: Boolean,
    default: false,
  },
  pending: {
    type: Boolean,
    default: false,
  },
  disabled: {
    type: Boolean,
    default: false,
  },
})

const emit = defineEmits(['open-account', 'logout'])
</script>
