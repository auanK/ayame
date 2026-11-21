<template>
  <header class="workspace-topbar">
    <div
      class="workspace-topbar-left"
      :style="explorerOpen ? { width: `${explorerWidth + 1}px` } : undefined"
    >
      <button
        type="button"
        class="workspace-text-button"
        :class="{ 'workspace-text-button--active': explorerOpen }"
        data-testid="toggle-explorer-button"
        :aria-expanded="explorerOpen ? 'true' : 'false'"
        title="Toggle file explorer"
        @click="emit('toggle-explorer')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1" />
          <path d="M6 2.5v11" />
        </svg>
        <span>Explorer</span>
      </button>

      <span class="workspace-topbar-divider" aria-hidden="true" />

      <div class="workspace-breadcrumb">
        <button
          type="button"
          class="workspace-breadcrumb-home"
          data-testid="workspace-home-button"
          aria-label="Back to vaults"
          title="Back to vaults"
          :disabled="busySaving"
          @click="emit('back-to-vaults')"
        >
          <svg viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true">
            <path d="M7.5 2.5 4 6l3.5 3.5" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span>Vaults</span>
        </button>

        <span class="workspace-breadcrumb-sep" aria-hidden="true">/</span>

        <div class="vault-dropdown-wrapper">
          <button
            type="button"
            class="vault-name-trigger"
            :class="{ 'vault-name-trigger--open': showVaultMenu }"
            data-testid="vault-name-trigger"
            :aria-expanded="showVaultMenu ? 'true' : 'false'"
            title="Vault menu"
            @click.stop="emit('update:showVaultMenu', !showVaultMenu)"
          >
            <span
              v-if="vault.accentColor"
              class="vault-accent-dot"
              :style="{ backgroundColor: vault.accentColor }"
              aria-hidden="true"
            />
            <span class="vault-name">{{ vault.name }}</span>
            <svg class="vault-name-chevron" viewBox="0 0 12 12" width="11" height="11" fill="none" aria-hidden="true">
              <path d="M3 4.5 6 7.5l3-3" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>

        <div
          v-show="showVaultMenu"
          class="vault-dropdown-menu"
          role="menu"
          data-testid="vault-dropdown-menu"
          @click.stop
        >
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="back-to-vaults-button"
            :disabled="busySaving"
            @click="closeMenu(); emit('back-to-vaults')"
          >
            <span>Switch vault</span>
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="vault-settings-button"
            @click="closeMenu(); emit('open-settings')"
          >
            <span>Vault settings…</span>
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="open-trash-button"
            @click="closeMenu(); emit('open-trash')"
          >
            <span>Trash</span>
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="refresh-browser-button"
            :disabled="loadingRoot || refreshing || busySaving"
            @click="closeMenu(); emit('refresh')"
          >
            <span>{{ refreshing ? 'Refreshing…' : 'Refresh vault' }}</span>
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="toggle-readable-line-button"
            @click="closeMenu(); emit('toggle-readable-line')"
          >
            <span>Readable line length</span>
          </button>
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="toggle-properties-button"
            @click="closeMenu(); emit('toggle-properties')"
          >
            <span>Toggle properties</span>
          </button>
          <div class="dropdown-divider" />
          <button
            type="button"
            class="dropdown-menu-item"
            data-testid="account-settings-button"
            @click="closeMenu(); emit('open-account')"
          >
            <span>Account &amp; security…</span>
          </button>
          <button
            type="button"
            class="dropdown-menu-item dropdown-menu-item--danger"
            data-testid="logout-button"
            :disabled="logoutDisabled"
            @click="closeMenu(); emit('logout')"
          >
            <span>Logout</span>
          </button>
        </div>
        </div>
      </div>
    </div>

    <div
      v-if="openTabs.length > 0 || graphTabOpen"
      class="workspace-tabs-bar"
      data-testid="workspace-tabs"
      role="tablist"
    >
      <div
        v-for="tabPath in openTabs"
        :key="tabPath"
        class="workspace-tab-item"
        :class="{ 'workspace-tab-item--active': activeWorkspaceView === 'note' && selectedFile === tabPath }"
        @mousedown.middle.prevent
        @auxclick.middle.prevent="emit('close-tab', tabPath)"
      >
        <button
          type="button"
          class="workspace-tab-btn"
          :class="{ 'workspace-tab--active': activeWorkspaceView === 'note' && selectedFile === tabPath }"
          data-testid="workspace-tab"
          :data-tab-path="tabPath"
          @click="emit('select-note', tabPath)"
        >
          {{ stripMarkdownExtension(tabPath.split('/').pop()) }}
        </button>
        <button
          type="button"
          class="workspace-tab-close"
          data-testid="close-tab-button"
          :data-tab-path="tabPath"
          aria-label="Close tab"
          @click.stop="emit('close-tab', tabPath)"
        >
          ×
        </button>
      </div>
      <div
        v-if="graphTabOpen"
        class="workspace-tab-item"
        :class="{ 'workspace-tab-item--active': activeWorkspaceView === 'graph' }"
        data-testid="workspace-graph-tab-item"
        @mousedown.middle.prevent
        @auxclick.middle.prevent="emit('close-graph-tab')"
      >
        <button
          type="button"
          class="workspace-tab-btn"
          :class="{ 'workspace-tab--active': activeWorkspaceView === 'graph' }"
          data-testid="workspace-graph-tab"
          role="tab"
          :aria-selected="activeWorkspaceView === 'graph' ? 'true' : 'false'"
          @click="emit('open-graph')"
        >
          Graph
        </button>
        <button
          type="button"
          class="workspace-tab-close"
          data-testid="close-graph-tab-button"
          aria-label="Close graph tab"
          @click.stop="emit('close-graph-tab')"
        >
          ×
        </button>
      </div>
    </div>
    <div v-else class="workspace-tabs-spacer" aria-hidden="true" />

    <nav
      class="workspace-graph-nav"
      data-testid="workspace-graph-nav"
      aria-label="Graph navigation"
    >
      <button
        type="button"
        class="workspace-nav-graph"
        :class="{ 'workspace-nav-graph--active': activeWorkspaceView === 'graph' && graphTabOpen }"
        data-testid="open-graph-button"
        :aria-pressed="activeWorkspaceView === 'graph' && graphTabOpen ? 'true' : 'false'"
        title="Open graph view"
        @click="emit('open-graph')"
      >
        <svg
          class="workspace-graph-icon"
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          aria-hidden="true"
        >
          <path d="M4 11.5L8 4.5L12.5 10.5M4 11.5L12.5 10.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
          <circle cx="8" cy="4.5" r="1.8" fill="currentColor" />
          <circle cx="4" cy="11.5" r="1.8" fill="currentColor" />
          <circle cx="12.5" cy="10.5" r="1.8" fill="currentColor" />
        </svg>
        <span>Graph</span>
      </button>
    </nav>

    <div class="workspace-topbar-actions">
      <button
        type="button"
        class="workspace-text-button workspace-text-button--icon"
        data-testid="topbar-quick-switcher-button"
        title="Quick switcher (Ctrl+O)"
        aria-label="Quick switcher"
        @click="emit('open-quick-switcher')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
          <circle cx="7" cy="7" r="4.2" />
          <path d="m10.2 10.2 3.3 3.3" stroke-linecap="round" />
        </svg>
      </button>
      <button
        type="button"
        class="workspace-text-button workspace-text-button--icon"
        data-testid="topbar-daily-note-button"
        title="Today's daily note"
        aria-label="Today's daily note"
        @click="emit('open-daily-note')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
          <rect x="2.2" y="3.2" width="11.6" height="10.3" rx="1" />
          <path d="M2.2 6.4h11.6M5.5 2v2.4M10.5 2v2.4" stroke-linecap="round" />
        </svg>
      </button>
      <button
        type="button"
        class="workspace-text-button"
        data-testid="command-palette-button"
        title="Commands (Ctrl+P)"
        @click="emit('open-command-palette')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
          <path d="M5.5 5.2a1.6 1.6 0 1 1 0 3.2h5a1.6 1.6 0 1 1 0-3.2M5.5 10.8a1.6 1.6 0 1 0 0-3.2m5 3.2a1.6 1.6 0 1 0 0-3.2M6.4 4.8v6.4m3.2-6.4v6.4" stroke-linecap="round" />
        </svg>
        <span>Commands</span>
      </button>
      <button
        type="button"
        class="workspace-text-button"
        :class="{ 'workspace-text-button--active': contextOpen }"
        data-testid="toggle-right-panel-button"
        :aria-expanded="contextOpen ? 'true' : 'false'"
        title="Toggle contextual panel"
        @click="emit('toggle-context')"
      >
        <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.35" aria-hidden="true">
          <rect x="2" y="2.5" width="12" height="11" rx="1" />
          <path d="M10 2.5v11" />
        </svg>
        <span>Panel</span>
      </button>
    </div>
  </header>
</template>

<script setup>
defineProps({
  vault: { type: Object, required: true },
  explorerOpen: { type: Boolean, default: true },
  explorerWidth: { type: Number, default: 256 },
  contextOpen: { type: Boolean, default: false },
  showVaultMenu: { type: Boolean, default: false },
  openTabs: { type: Array, default: () => [] },
  graphTabOpen: { type: Boolean, default: false },
  activeWorkspaceView: { type: String, default: 'note' },
  selectedFile: { type: String, default: null },
  loadingRoot: { type: Boolean, default: false },
  refreshing: { type: Boolean, default: false },
  busySaving: { type: Boolean, default: false },
  logoutDisabled: { type: Boolean, default: false },
})

const emit = defineEmits([
  'update:showVaultMenu',
  'toggle-explorer',
  'toggle-context',
  'back-to-vaults',
  'open-settings',
  'open-trash',
  'refresh',
  'toggle-readable-line',
  'toggle-properties',
  'open-account',
  'logout',
  'select-note',
  'close-tab',
  'open-graph',
  'close-graph-tab',
  'open-quick-switcher',
  'open-daily-note',
  'open-command-palette',
])

const closeMenu = () => emit('update:showVaultMenu', false)
const stripMarkdownExtension = (name) => String(name || '').replace(/\.md$/i, '')
</script>
