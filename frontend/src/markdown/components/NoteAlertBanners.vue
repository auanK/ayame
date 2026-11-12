<template>
  <p v-if="reloading" class="editor-status" role="status" data-testid="markdown-reloading">
    Loading server copy…
  </p>
  <p v-if="saveError" class="editor-error" role="alert" data-testid="markdown-save-error">
    {{ saveError }}
    <button
      v-if="saveState === 'error' && !conflict && !saveResultUnknown"
      type="button"
      class="action-button inline-retry-button"
      data-testid="markdown-retry-save"
      :disabled="saving || reloading"
      @click="emit('retry-save')"
    >
      Retry save
    </button>
  </p>
  <p v-if="saveNotice" class="editor-status" role="status">{{ saveNotice }}</p>
  <p v-if="copyMessage" class="editor-status" role="status">{{ copyMessage }}</p>

  <div v-if="conflict" class="editor-conflict" role="alert" data-testid="markdown-conflict">
    <p>This note changed on the server. Your local draft is still here.</p>
    <div class="conflict-actions">
      <button
        type="button"
        class="action-button"
        data-testid="markdown-copy-draft"
        @click="emit('copy-draft')"
      >
        Copy draft
      </button>
      <button
        type="button"
        class="action-button"
        data-testid="markdown-reload-server"
        :disabled="reloading"
        @click="emit('request-reload')"
      >
        Load server copy…
      </button>
    </div>
  </div>

  <div
    v-if="saveResultUnknown"
    class="editor-conflict"
    role="alert"
    data-testid="markdown-save-unknown"
  >
    <p>The server may have saved this note. Verify its current contents before trying again.</p>
    <button
      type="button"
      class="action-button"
      data-testid="markdown-verify-save"
      :disabled="saving || reloading"
      @click="emit('verify-server')"
    >
      Verify server copy
    </button>
  </div>

  <div
    v-if="reloadConfirm"
    class="editor-confirm"
    role="dialog"
    aria-modal="true"
    aria-labelledby="reload-title"
  >
    <p id="reload-title">Discard your draft and load the current server copy?</p>
    <div class="confirm-actions">
      <button type="button" class="action-button" @click="emit('cancel-reload')">
        Keep editing
      </button>
      <button
        type="button"
        class="action-button"
        data-testid="markdown-confirm-reload"
        @click="emit('confirm-reload')"
      >
        Discard draft and reload
      </button>
    </div>
  </div>
</template>

<script setup>
defineProps({
  reloading: { type: Boolean, default: false },
  saving: { type: Boolean, default: false },
  saveState: { type: String, default: 'saved' },
  saveError: { type: String, default: '' },
  saveNotice: { type: String, default: '' },
  copyMessage: { type: String, default: '' },
  conflict: { type: Boolean, default: false },
  saveResultUnknown: { type: Boolean, default: false },
  reloadConfirm: { type: Boolean, default: false },
})

const emit = defineEmits([
  'retry-save',
  'copy-draft',
  'request-reload',
  'verify-server',
  'cancel-reload',
  'confirm-reload',
])
</script>
