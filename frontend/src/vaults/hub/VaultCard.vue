<template>
  <li
    class="vault-row"
    :class="[
      compact ? 'vault-card-compact' : 'vault-card',
      {
        'vault-card--dragging': dragging,
        'vault-card--drop-target': dropTarget,
        'vault-card--pinned': Boolean(vault.pinned),
      },
    ]"
    data-testid="vault-row"
    :data-vault-directory="vault.directory"
    :tabindex="needsRefresh ? undefined : 0"
    :draggable="!needsRefresh && !operation"
    @click="emit('open-card', vault)"
    @keydown.enter.self="emit('open-card', vault)"
    @dragstart="emit('drag-start', vault, $event)"
    @dragover.prevent="emit('drag-over', vault, $event)"
    @dragleave="emit('drag-leave', vault, $event)"
    @drop.prevent.stop="emit('drop-card', vault, $event)"
    @dragend="emit('drag-end')"
  >
    <div v-if="!compact" class="vault-card-banner" :style="bannerStyle">
      <img
        v-if="vault.hasCover"
        class="vault-cover-img"
        data-testid="vault-cover-image"
        :src="coverUrl"
        :alt="`Cover for ${vault.name}`"
      />

      <div class="vault-banner-top" :class="{ 'vault-banner-top--cover': vault.hasCover }">
        <div class="vault-banner-badges">
          <span v-if="vault.category" class="vault-category-badge">{{ vault.category }}</span>
        </div>
        <div v-if="!needsRefresh" class="vault-banner-actions">
          <button
            type="button"
            class="vault-icon-pill"
            :class="{ 'vault-icon-pill--active': vault.pinned }"
            data-testid="pin-vault-button"
            :aria-pressed="vault.pinned ? 'true' : 'false'"
            :aria-label="vault.pinned ? 'Unpin vault' : 'Pin vault'"
            :title="vault.pinned ? 'Unpin vault' : 'Pin vault'"
            :disabled="Boolean(operation)"
            @click.stop="emit('toggle-pin', vault)"
          >
            {{ vault.pinned ? '★' : '☆' }}
          </button>
          <button
            type="button"
            class="vault-icon-pill"
            data-testid="upload-cover-button"
            aria-label="Upload cover image"
            title="Upload cover image"
            :disabled="Boolean(operation)"
            @click.stop="emit('upload-cover', vault)"
          >
            <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
              <rect x="2" y="3" width="12" height="10" rx="1" />
              <circle cx="5.7" cy="6.6" r="1.1" />
              <path d="m3.5 11.5 2.8-2.6 2 1.8 2.1-2.2 2.1 3" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="vault-card-body">
      <div class="vault-details">
        <div class="vault-title-line">
          <h3>{{ vault.name }}</h3>
          <span v-if="compact && vault.category" class="vault-category-badge">
            {{ vault.category }}
          </span>
        </div>
        <div class="vault-card-meta">
          <span class="vault-directory">{{ vault.directory }}/</span>
          <span>· {{ vault.noteCount || 0 }} {{ (vault.noteCount || 0) === 1 ? 'note' : 'notes' }}</span>
          <span v-if="vault.lastModifiedAt">· {{ formattedTime }}</span>
        </div>
        <p v-if="vault.description && !compact" class="vault-description">
          {{ vault.description }}
        </p>
      </div>

      <div v-if="vault.tags && vault.tags.length > 0" class="vault-card-tags">
        <template v-if="!needsRefresh">
          <button
            v-for="tag in vault.tags"
            :key="tag"
            type="button"
            class="vault-tag-chip"
            :class="{ 'vault-tag-chip--active': selectedTag.toLowerCase() === tag.toLowerCase() }"
            @click.stop="emit('toggle-tag', tag)"
          >
            #{{ tag }}
          </button>
        </template>
        <template v-else>
          <span v-for="tag in vault.tags" :key="tag" class="vault-tag-chip">#{{ tag }}</span>
        </template>
      </div>

      <div v-if="!needsRefresh" class="vault-card-footer">
        <div class="vault-actions">
          <button
            type="button"
            class="btn btn-ghost btn-open-vault"
            data-testid="open-vault-button"
            :disabled="Boolean(operation)"
            @click.stop="emit('open', vault)"
          >
            Open
          </button>
          <button
            v-if="!vault.registered"
            type="button"
            class="btn btn-ghost"
            :disabled="Boolean(operation)"
            @click.stop="emit('edit', vault)"
          >
            Customize
          </button>
          <template v-else>
            <button
              type="button"
              class="btn btn-ghost"
              data-testid="edit-vault-button"
              :disabled="Boolean(operation)"
              @click.stop="emit('edit', vault)"
            >
              Edit
            </button>
            <button
              type="button"
              class="btn btn-ghost"
              :disabled="Boolean(operation)"
              @click.stop="emit('reset', vault)"
            >
              {{ operation === 'resetting' ? 'Resetting...' : 'Reset' }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </li>
</template>

<script setup>
defineProps({
  vault: { type: Object, required: true },
  compact: { type: Boolean, default: false },
  dragging: { type: Boolean, default: false },
  dropTarget: { type: Boolean, default: false },
  needsRefresh: { type: Boolean, default: false },
  operation: { type: String, default: '' },
  selectedTag: { type: String, default: '' },
  coverUrl: { type: String, default: '' },
  bannerStyle: { type: Object, default: undefined },
  formattedTime: { type: String, default: '' },
})

const emit = defineEmits([
  'open',
  'open-card',
  'edit',
  'reset',
  'toggle-pin',
  'upload-cover',
  'toggle-tag',
  'drag-start',
  'drag-over',
  'drag-leave',
  'drop-card',
  'drag-end',
])
</script>
