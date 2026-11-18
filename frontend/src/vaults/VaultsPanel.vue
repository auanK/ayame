<template>
  <section
    class="vaults-panel"
    data-testid="vaults-panel"
    aria-labelledby="vaults-heading"
    :aria-busy="Boolean(operation)"
  >
    <header class="vaults-panel-header">
      <div>
        <h2 id="vaults-heading">Vaults</h2>
        <p class="status-message">
          <template v-if="hasLoaded && vaults.length > 0">
            <span class="sr-only">Your vaults · </span>
            <span class="vaults-summary">
              {{ vaults.length }} {{ vaults.length === 1 ? 'vault' : 'vaults' }} · {{ totalNotesCount }} {{ totalNotesCount === 1 ? 'note' : 'notes' }}
            </span>
          </template>
          <template v-else>Your vaults</template>
        </p>
      </div>
      <div class="vaults-header-actions">
        <button
          type="button"
          class="btn btn-secondary btn-compact"
          data-testid="refresh-vaults-button"
          :disabled="Boolean(operation)"
          @click="refreshVaults"
        >
          {{ operation === 'refreshing' ? 'Refreshing...' : 'Refresh' }}
        </button>
        <button
          v-if="hasLoaded && supportsCreateVault"
          type="button"
          class="btn btn-primary btn-compact"
          data-testid="new-vault-button"
          :disabled="Boolean(operation)"
          @click="toggleCreateForm"
        >
          New vault
        </button>
      </div>
    </header>

    <datalist id="vault-categories-list">
      <option v-for="cat in existingCategories" :key="cat" :value="cat" />
    </datalist>

    <input
      ref="coverFileInputRef"
      type="file"
      accept="image/png,image/jpeg,image/webp,image/gif"
      class="sr-only-input"
      data-testid="cover-file-input"
      @change="handleCoverFileSelected"
    />

    <p v-if="errorMessage" class="error-message" role="alert" aria-live="polite">
      {{ errorMessage }}
    </p>

    <p v-if="operation === 'loading' || (!hasLoaded && !errorMessage)" class="status-message" role="status" aria-busy="true">
      Loading vaults...
    </p>
    <p v-if="operation === 'refreshing'" class="status-message" role="status" aria-busy="true">
      Refreshing vaults...
    </p>

    <div v-if="hasLoaded && vaults.length === 0" class="vaults-empty-state">
      <h3>No vaults found.</h3>
      <p>Add a folder to Ayame's configured vaults directory, then refresh.</p>
    </div>

    <template v-else-if="hasLoaded">
      <!-- Minimalist Organization Toolbar -->
      <div class="vaults-toolbar" data-testid="vaults-toolbar">
        <div class="vaults-toolbar-row">
          <input
            v-model="searchQuery"
            type="search"
            class="form-input vaults-search-input"
            data-testid="vaults-search-input"
            placeholder="Search vaults by name, category, or #tag…"
            aria-label="Search vaults"
          />

          <div class="vaults-view-controls">
            <div class="vaults-segmented" role="group" aria-label="View mode">
              <button
                type="button"
                class="vaults-seg-btn"
                :class="{ 'vaults-seg-btn--active': viewMode === 'cards' }"
                data-testid="view-mode-cards"
                @click="viewMode = 'cards'"
              >
                Cards
              </button>
              <button
                type="button"
                class="vaults-seg-btn"
                :class="{ 'vaults-seg-btn--active': viewMode === 'categories' }"
                data-testid="view-mode-categories"
                @click="viewMode = 'categories'"
              >
                Categories
              </button>
              <button
                type="button"
                class="vaults-seg-btn"
                :class="{ 'vaults-seg-btn--active': viewMode === 'compact' }"
                data-testid="view-mode-compact"
                @click="viewMode = 'compact'"
              >
                Compact
              </button>
            </div>

            <select
              v-model="sortMode"
              class="form-input vaults-sort-select"
              data-testid="vaults-sort-select"
              aria-label="Sort vaults"
            >
              <option value="manual">Manual (Drag)</option>
              <option value="name">Name (A-Z)</option>
              <option value="recent">Recently updated</option>
              <option value="notes">Most notes</option>
            </select>
          </div>
        </div>

        <div
          v-if="categoryCounts.length > 0 || pinnedCount > 0 || allVaultTags.length > 0"
          class="vaults-filters-row"
        >
          <div
            v-if="categoryCounts.length > 0 || pinnedCount > 0"
            class="vaults-filter-pills"
            role="group"
            aria-label="Filter by category"
          >
            <button
              type="button"
              class="vault-filter-pill"
              :class="{ 'vault-filter-pill--active': selectedCategory === 'all' }"
              data-testid="category-filter-all"
              @click="selectedCategory = 'all'"
            >
              All ({{ vaults.length }})
            </button>
            <button
              v-if="pinnedCount > 0"
              type="button"
              class="vault-filter-pill"
              :class="{ 'vault-filter-pill--active': selectedCategory === 'pinned' }"
              data-testid="category-filter-pinned"
              @click="selectedCategory = 'pinned'"
            >
              Pinned ({{ pinnedCount }})
            </button>
            <button
              v-for="cat in categoryCounts"
              :key="cat.name"
              type="button"
              class="vault-filter-pill"
              :class="{ 'vault-filter-pill--active': selectedCategory === cat.name }"
              :data-testid="`category-filter-${cat.name}`"
              @click="selectedCategory = cat.name"
            >
              {{ cat.name }} ({{ cat.count }})
            </button>
            <button
              v-if="categoryCounts.length > 0 && uncategorizedCount > 0"
              type="button"
              class="vault-filter-pill"
              :class="{ 'vault-filter-pill--active': selectedCategory === '__uncategorized__' }"
              data-testid="category-filter-uncategorized"
              @click="selectedCategory = '__uncategorized__'"
            >
              Uncategorized ({{ uncategorizedCount }})
            </button>
          </div>

          <div v-if="allVaultTags.length > 0" class="vaults-tag-pills" role="group" aria-label="Filter by tag">
            <button
              v-for="tagInfo in allVaultTags"
              :key="tagInfo.tag"
              type="button"
              class="vault-tag-chip"
              :class="{ 'vault-tag-chip--active': selectedTag.toLowerCase() === tagInfo.tag.toLowerCase() }"
              :data-testid="`tag-filter-${tagInfo.tag}`"
              @click="toggleTagFilter(tagInfo.tag)"
            >
              #{{ tagInfo.tag }} ({{ tagInfo.count }})
            </button>
            <button
              v-if="selectedTag"
              type="button"
              class="vault-tag-clear-btn"
              data-testid="clear-tag-filter"
              @click="selectedTag = ''"
            >
              Clear tag
            </button>
          </div>
        </div>
      </div>

      <div v-if="filteredVaults.length === 0" class="vaults-empty-state" data-testid="vaults-filter-empty">
        <h3>No matching vaults.</h3>
        <p>Try clearing your search or category filter.</p>
      </div>

      <!-- Category Grouped View -->
      <div v-else-if="viewMode === 'categories'" class="vault-category-groups">
        <form
          v-if="!needsRefresh && hasApi('updateVault')"
          class="vault-category-creator"
          data-testid="add-category-bucket-form"
          @submit.prevent="addCustomCategoryBucket"
        >
          <input
            v-model="newCategoryName"
            type="text"
            maxlength="60"
            class="form-input vaults-category-creator-input"
            data-testid="add-category-bucket-input"
            placeholder="New category drop zone…"
            aria-label="New category name"
            :disabled="Boolean(operation)"
          />
          <button
            type="submit"
            class="btn btn-secondary btn-compact"
            data-testid="add-category-bucket-submit"
            :disabled="Boolean(operation) || !newCategoryName.trim()"
          >
            + Add category
          </button>
        </form>

        <section
          v-for="group in categorizedGroups"
          :key="group.key"
          class="vault-category-section"
          :class="{ 'vault-category-section--drop': dragOverCategory === group.key }"
          data-testid="category-drop-zone"
          :data-category-key="group.key"
          @dragover.prevent="handleCategoryDragOver(group.key)"
          @dragleave="handleCategoryDragLeave(group.key, $event)"
          @drop.prevent="handleCategoryDrop(group.key, $event)"
        >
          <header class="vault-category-header">
            <h3>{{ group.label }}</h3>
            <span class="vault-category-count">{{ group.items.length }}</span>
          </header>

          <p v-if="group.items.length === 0" class="vault-category-empty-drop">
            Drop vault cards here
          </p>
          <ul v-else class="vault-grid" :aria-label="`Vaults in ${group.label}`">
            <li
              v-for="vault in group.items"
              :key="vault.id || vault.directory"
              class="vault-row vault-card"
              :class="{
                'vault-card--dragging': draggingDirectory === vault.directory,
                'vault-card--drop-target': dragOverDirectory === vault.directory && draggingDirectory !== vault.directory,
                'vault-card--pinned': Boolean(vault.pinned),
              }"
              data-testid="vault-row"
              :data-vault-directory="vault.directory"
              :tabindex="needsRefresh ? undefined : 0"
              :draggable="!needsRefresh && !operation"
              @click="openVaultFromCard(vault)"
              @keydown.enter.self="openVaultFromCard(vault)"
              @dragstart="handleCardDragStart(vault, $event)"
              @dragover.prevent="handleCardDragOver(vault, $event)"
              @dragleave="handleCardDragLeave(vault, $event)"
              @drop.prevent.stop="handleCardDrop(vault, $event)"
              @dragend="clearCardDrag"
            >
              <div class="vault-card-banner" :style="bannerStyleFor(vault)">
                <img
                  v-if="vault.hasCover"
                  class="vault-cover-img"
                  data-testid="vault-cover-image"
                  :src="coverUrlFor(vault)"
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
                      @click.stop="togglePin(vault)"
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
                      @click.stop="triggerCoverInput(vault)"
                    >
                      <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                        <rect x="2" y="3" width="12" height="10" rx="1.8" />
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
                  </div>
                  <div class="vault-card-meta">
                    <span class="vault-directory">{{ vault.directory }}/</span>
                    <span>· {{ vault.noteCount || 0 }} {{ (vault.noteCount || 0) === 1 ? 'note' : 'notes' }}</span>
                    <span v-if="vault.lastModifiedAt">· {{ formatRelativeTime(vault.lastModifiedAt) }}</span>
                  </div>
                  <p v-if="vault.description" class="vault-description">{{ vault.description }}</p>
                </div>

                <div v-if="vault.tags && vault.tags.length > 0" class="vault-card-tags">
                  <template v-if="!needsRefresh">
                    <button
                      v-for="tag in vault.tags"
                      :key="tag"
                      type="button"
                      class="vault-tag-chip"
                      :class="{ 'vault-tag-chip--active': selectedTag.toLowerCase() === tag.toLowerCase() }"
                      @click.stop="toggleTagFilter(tag)"
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
                      @click.stop="$emit('open', vault)"
                    >
                      Open
                    </button>
                    <button
                      v-if="!vault.registered"
                      type="button"
                      class="btn btn-ghost"
                      :disabled="Boolean(operation)"
                      @click.stop="startEdit(vault)"
                    >
                      Customize
                    </button>
                    <template v-else>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        data-testid="edit-vault-button"
                        :disabled="Boolean(operation)"
                        @click.stop="startEdit(vault)"
                      >
                        Edit
                      </button>
                      <button
                        type="button"
                        class="btn btn-ghost"
                        :disabled="Boolean(operation)"
                        @click.stop="resetVault(vault)"
                      >
                        {{ operation === 'resetting' ? 'Resetting...' : 'Reset' }}
                      </button>
                    </template>
                  </div>
                </div>
              </div>
            </li>
          </ul>
        </section>
      </div>

      <!-- Cards Grid or Compact List View -->
      <ul
        v-else
        :class="viewMode === 'compact' ? 'vault-list' : 'vault-grid'"
        aria-label="Vaults"
      >
        <li
          v-for="vault in filteredVaults"
          :key="vault.id || vault.directory"
          class="vault-row"
          :class="[
            viewMode === 'compact' ? 'vault-card-compact' : 'vault-card',
            {
              'vault-card--dragging': draggingDirectory === vault.directory,
              'vault-card--drop-target': dragOverDirectory === vault.directory && draggingDirectory !== vault.directory,
              'vault-card--pinned': Boolean(vault.pinned),
            },
          ]"
          data-testid="vault-row"
          :data-vault-directory="vault.directory"
          :tabindex="needsRefresh ? undefined : 0"
          :draggable="!needsRefresh && !operation"
          @click="openVaultFromCard(vault)"
          @keydown.enter.self="openVaultFromCard(vault)"
          @dragstart="handleCardDragStart(vault, $event)"
          @dragover.prevent="handleCardDragOver(vault, $event)"
          @dragleave="handleCardDragLeave(vault, $event)"
          @drop.prevent.stop="handleCardDrop(vault, $event)"
          @dragend="clearCardDrag"
        >
          <div v-if="viewMode === 'cards'" class="vault-card-banner" :style="bannerStyleFor(vault)">
            <img
              v-if="vault.hasCover"
              class="vault-cover-img"
              data-testid="vault-cover-image"
              :src="coverUrlFor(vault)"
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
                  @click.stop="togglePin(vault)"
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
                  @click.stop="triggerCoverInput(vault)"
                >
                  <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true">
                    <rect x="2" y="3" width="12" height="10" rx="1.8" />
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
                <span v-if="viewMode === 'compact' && vault.category" class="vault-category-badge">
                  {{ vault.category }}
                </span>
              </div>
              <div class="vault-card-meta">
                <span class="vault-directory">{{ vault.directory }}/</span>
                <span>· {{ vault.noteCount || 0 }} {{ (vault.noteCount || 0) === 1 ? 'note' : 'notes' }}</span>
                <span v-if="vault.lastModifiedAt">· {{ formatRelativeTime(vault.lastModifiedAt) }}</span>
              </div>
              <p v-if="vault.description && viewMode === 'cards'" class="vault-description">
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
                  @click.stop="toggleTagFilter(tag)"
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
                  @click.stop="$emit('open', vault)"
                >
                  Open
                </button>
                <button
                  v-if="!vault.registered"
                  type="button"
                  class="btn btn-ghost"
                  :disabled="Boolean(operation)"
                  @click.stop="startEdit(vault)"
                >
                  Customize
                </button>
                <template v-else>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    data-testid="edit-vault-button"
                    :disabled="Boolean(operation)"
                    @click.stop="startEdit(vault)"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    class="btn btn-ghost"
                    :disabled="Boolean(operation)"
                    @click.stop="resetVault(vault)"
                  >
                    {{ operation === 'resetting' ? 'Resetting...' : 'Reset' }}
                  </button>
                </template>
              </div>
            </div>
          </div>
        </li>
      </ul>
    </template>

    <!-- Floating Modal: Create New Vault -->
    <div
      v-if="showCreateForm"
      class="ayame-modal-backdrop"
      data-testid="create-vault-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-vault-modal-title"
      @click.self="cancelCreateForm"
    >
      <div class="ayame-modal-card ayame-modal-card--wide">
        <form
          class="vault-editor"
          data-testid="create-vault-form"
          @submit.prevent="submitCreateVault"
        >
        <header class="ayame-modal-header">
          <div>
            <h3 id="create-vault-modal-title">Create new vault</h3>
            <p class="ayame-modal-subtitle">Creates a vault folder and registers its hub metadata.</p>
          </div>
          <button
            type="button"
            class="ayame-modal-close"
            aria-label="Close"
            :disabled="Boolean(operation)"
            @click="cancelCreateForm"
          >
            ×
          </button>
        </header>

        <div class="ayame-modal-body">
          <div class="vault-editor-fields">
            <div class="form-group">
              <label class="form-label" for="create-vault-name">Display name</label>
              <input
                id="create-vault-name"
                v-model="createDraft.name"
                class="form-input"
                type="text"
                maxlength="100"
                placeholder="e.g. Research Hub"
                :disabled="Boolean(operation)"
                required
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="create-vault-dir">Folder name (optional)</label>
              <input
                id="create-vault-dir"
                v-model="createDraft.directory"
                class="form-input"
                type="text"
                maxlength="100"
                placeholder="Auto-derived from display name"
                :disabled="Boolean(operation)"
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="create-vault-category">Category</label>
              <input
                id="create-vault-category"
                v-model="createDraft.category"
                class="form-input"
                type="text"
                maxlength="60"
                list="vault-categories-list"
                placeholder="e.g. Worldbuilding, Study"
                :disabled="Boolean(operation)"
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="create-vault-description">Description</label>
              <input
                id="create-vault-description"
                v-model="createDraft.description"
                class="form-input"
                type="text"
                maxlength="280"
                placeholder="Short summary"
                :disabled="Boolean(operation)"
              />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label" for="create-vault-tag-input">Tags</label>
            <div class="vault-tag-editor">
              <span
                v-for="tag in createDraft.tags"
                :key="tag"
                class="vault-tag-chip vault-tag-chip--editable"
              >
                #{{ tag }}
                <button
                  type="button"
                  class="vault-tag-remove"
                  aria-label="Remove tag"
                  @click="removeTagFromList(createDraft.tags, tag)"
                >
                  ×
                </button>
              </span>
              <input
                id="create-vault-tag-input"
                v-model="createTagInput"
                type="text"
                class="vault-tag-inline-input"
                placeholder="Add tag and press Enter"
                :disabled="Boolean(operation)"
                @keydown.enter.prevent="addTagFromInput('create')"
                @keydown.,.prevent="addTagFromInput('create')"
              />
            </div>
          </div>

          <div class="form-group">
            <span class="form-label">Accent</span>
            <div class="vault-color-swatches">
              <button
                type="button"
                class="vault-color-swatch vault-color-swatch--none"
                :class="{ 'vault-color-swatch--active': !createDraft.accentColor }"
                aria-label="No accent color"
                title="No accent color"
                @click="createDraft.accentColor = ''"
              >
                ∅
              </button>
              <button
                v-for="color in ACCENT_SWATCHES"
                :key="color"
                type="button"
                class="vault-color-swatch"
                :class="{ 'vault-color-swatch--active': createDraft.accentColor === color }"
                :style="{ backgroundColor: color }"
                :aria-label="`Select accent ${color}`"
                @click="createDraft.accentColor = createDraft.accentColor === color ? '' : color"
              />
            </div>
          </div>

          <label class="vault-checkbox-row">
            <input v-model="createDraft.createWelcomeNote" type="checkbox" :disabled="Boolean(operation)" />
            <span>Create an introductory Welcome.md note</span>
          </label>

          <p v-if="createError" class="error-message" role="alert" aria-live="polite">
            {{ createError }}
          </p>
        </div>

        <div class="ayame-modal-footer">
          <button type="button" class="btn btn-secondary" :disabled="Boolean(operation)" @click="cancelCreateForm">
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" data-testid="create-vault-submit" :disabled="Boolean(operation)">
            {{ operation === 'creating' ? 'Creating...' : 'Create vault' }}
          </button>
        </div>
        </form>
      </div>
    </div>

    <!-- Floating Modal: Customize / Edit Vault -->
    <div
      v-if="editingVault"
      class="ayame-modal-backdrop"
      data-testid="vault-editor-modal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="edit-vault-modal-title"
      @click.self="cancelEdit"
    >
      <div class="ayame-modal-card ayame-modal-card--wide">
        <form
          class="vault-editor"
          data-testid="vault-editor"
          @submit.prevent="saveVault(editingVault)"
        >
        <header class="ayame-modal-header">
          <div>
            <h3 id="edit-vault-modal-title">Customize vault</h3>
            <p class="vault-directory">{{ editingVault.directory }}/</p>
          </div>
          <button
            type="button"
            class="ayame-modal-close"
            aria-label="Close"
            :disabled="Boolean(operation)"
            @click="cancelEdit"
          >
            ×
          </button>
        </header>

        <div class="ayame-modal-body">
          <div class="vault-editor-fields">
            <div class="form-group">
              <label class="form-label" for="vault-name">Display name</label>
              <input
                id="vault-name"
                v-model="editDraft.name"
                class="form-input"
                name="name"
                type="text"
                maxlength="100"
                autocomplete="off"
                :disabled="Boolean(operation)"
                required
              />
            </div>

            <div class="form-group">
              <label class="form-label" for="edit-vault-category">Category</label>
              <input
                id="edit-vault-category"
                v-model="editDraft.category"
                class="form-input"
                type="text"
                maxlength="60"
                list="vault-categories-list"
                placeholder="Uncategorized"
                :disabled="Boolean(operation)"
              />
            </div>

            <div class="form-group vault-editor-field-full">
              <label class="form-label" for="edit-vault-description">Description</label>
              <input
                id="edit-vault-description"
                v-model="editDraft.description"
                class="form-input"
                type="text"
                maxlength="280"
                placeholder="Short summary of this vault"
                :disabled="Boolean(operation)"
              />
            </div>
          </div>

          <div class="vault-editor-extras">
            <div class="form-group">
              <label class="form-label" for="edit-vault-tag-input">Tags</label>
              <div class="vault-tag-editor">
                <span
                  v-for="tag in editDraft.tags"
                  :key="tag"
                  class="vault-tag-chip vault-tag-chip--editable"
                >
                  #{{ tag }}
                  <button
                    type="button"
                    class="vault-tag-remove"
                    aria-label="Remove tag"
                    @click="removeTagFromList(editDraft.tags, tag)"
                  >
                    ×
                  </button>
                </span>
                <input
                  id="edit-vault-tag-input"
                  v-model="editTagInput"
                  type="text"
                  class="vault-tag-inline-input"
                  placeholder="Add tag + Enter"
                  :disabled="Boolean(operation)"
                  @keydown.enter.prevent="addTagFromInput('edit')"
                  @keydown.,.prevent="addTagFromInput('edit')"
                />
              </div>
            </div>

            <div class="vault-editor-media-row">
              <div>
                <span class="form-label">Accent</span>
                <div class="vault-color-swatches">
                  <button
                    type="button"
                    class="vault-color-swatch vault-color-swatch--none"
                    :class="{ 'vault-color-swatch--active': !editDraft.accentColor }"
                    aria-label="No accent color"
                    title="No accent color"
                    @click="editDraft.accentColor = ''"
                  >
                    ∅
                  </button>
                  <button
                    v-for="color in ACCENT_SWATCHES"
                    :key="color"
                    type="button"
                    class="vault-color-swatch"
                    :class="{ 'vault-color-swatch--active': editDraft.accentColor === color }"
                    :style="{ backgroundColor: color }"
                    :aria-label="`Select accent ${color}`"
                    @click="editDraft.accentColor = editDraft.accentColor === color ? '' : color"
                  />
                </div>
              </div>

              <div class="vault-cover-controls">
                <span class="form-label">Cover image</span>
                <div class="vault-cover-preview">
                  <img
                    v-if="editingVault.hasCover"
                    :src="coverUrlFor(editingVault)"
                    class="vault-cover-thumb"
                    alt=""
                  />
                  <button
                    type="button"
                    class="btn btn-secondary btn-compact"
                    data-testid="editor-upload-cover-button"
                    :disabled="Boolean(operation)"
                    @click="triggerCoverInput(editingVault)"
                  >
                    Upload cover
                  </button>
                  <button
                    v-if="editingVault.hasCover"
                    type="button"
                    class="btn btn-secondary btn-compact"
                    data-testid="remove-cover-button"
                    :disabled="Boolean(operation)"
                    @click="removeCover(editingVault)"
                  >
                    Remove cover
                  </button>
                </div>
              </div>
            </div>
          </div>

          <p v-if="editError" class="error-message" role="alert" aria-live="polite">
            {{ editError }}
          </p>
        </div>

        <div class="ayame-modal-footer">
          <button
            type="button"
            class="btn btn-secondary"
            :disabled="Boolean(operation)"
            @click="cancelEdit"
          >
            Cancel
          </button>
          <button type="submit" class="btn btn-primary" data-testid="save-vault-button" :disabled="Boolean(operation)">
            {{ operation === 'saving' ? 'Saving...' : 'Save' }}
          </button>
        </div>
        </form>
      </div>
    </div>
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import * as api from './api.js'

const ACCENT_SWATCHES = [
  '#a99aca',
  '#d4a5b8',
  '#8ccff0',
  '#8fc7a8',
  '#e6c387',
  '#9da8c4',
]

const props = defineProps({
  initialVaults: {
    type: Array,
    default: null,
  },
})

const emit = defineEmits(['unauthorized', 'open', 'loaded'])

const vaults = ref([])
const hasLoaded = ref(false)
const operation = ref('')
const errorMessage = ref('')
const editError = ref('')
const editingDirectory = ref(null)
const editingWasRegistered = ref(false)
const needsRefresh = ref(false)

const editDraft = ref({
  name: '',
  category: '',
  description: '',
  tags: [],
  accentColor: '',
})
const editTagInput = ref('')

const showCreateForm = ref(false)
const createDraft = ref({
  name: '',
  directory: '',
  category: '',
  description: '',
  tags: [],
  accentColor: '#a99aca',
  createWelcomeNote: true,
})
const createTagInput = ref('')
const createError = ref('')

const searchQuery = ref('')
const selectedCategory = ref('all')
const selectedTag = ref('')
const viewMode = ref('cards') // 'cards' | 'categories' | 'compact'
const sortMode = ref('manual') // 'manual' | 'name' | 'recent' | 'notes'
const customCategoryBuckets = ref([])
const newCategoryName = ref('')

const draggingDirectory = ref(null)
const dragOverDirectory = ref(null)
const dragOverCategory = ref(null)

const coverFileInputRef = ref(null)
const coverTargetVault = ref(null)

let mounted = true

const hasApi = (name) => name in api && typeof api[name] === 'function'

const supportsCreateVault = computed(() => hasApi('createVault'))

const editingVault = computed(() => {
  if (!editingDirectory.value) return null
  return vaults.value.find((v) => v.directory === editingDirectory.value) || null
})

const totalNotesCount = computed(() =>
  vaults.value.reduce((sum, v) => sum + (typeof v.noteCount === 'number' ? v.noteCount : 0), 0)
)

const pinnedCount = computed(() => vaults.value.filter((v) => v.pinned).length)

const existingCategories = computed(() => {
  const set = new Set()
  for (const v of vaults.value) {
    if (v.category) set.add(v.category)
  }
  for (const bucket of customCategoryBuckets.value) {
    if (bucket) set.add(bucket)
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
})

const categoryCounts = computed(() => {
  const map = new Map()
  for (const v of vaults.value) {
    if (!v.category) continue
    map.set(v.category, (map.get(v.category) || 0) + 1)
  }
  return Array.from(map.entries())
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
})

const uncategorizedCount = computed(() => vaults.value.filter((v) => !v.category).length)

const allVaultTags = computed(() => {
  const map = new Map()
  for (const v of vaults.value) {
    for (const rawTag of v.tags || []) {
      const lower = rawTag.toLowerCase()
      if (!map.has(lower)) {
        map.set(lower, { tag: rawTag, count: 0 })
      }
      map.get(lower).count += 1
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.tag.localeCompare(b.tag, undefined, { sensitivity: 'base' })
  )
})

const sortedVaults = computed(() => {
  const list = [...vaults.value]
  if (sortMode.value !== 'manual') {
    list.sort((a, b) => {
      if (Boolean(a.pinned) !== Boolean(b.pinned)) {
        return a.pinned ? -1 : 1
      }
      if (sortMode.value === 'name') {
        return (
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) ||
          a.directory.localeCompare(b.directory)
        )
      }
      if (sortMode.value === 'recent') {
        return (b.lastModifiedAt || 0) - (a.lastModifiedAt || 0)
      }
      if (sortMode.value === 'notes') {
        return (b.noteCount || 0) - (a.noteCount || 0)
      }
      return 0
    })
  }
  return list
})

const filteredVaults = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  const activeTagLower = selectedTag.value.trim().toLowerCase()

  return sortedVaults.value.filter((v) => {
    if (selectedCategory.value === 'pinned' && !v.pinned) return false
    if (selectedCategory.value === '__uncategorized__' && v.category) return false
    if (
      selectedCategory.value !== 'all' &&
      selectedCategory.value !== 'pinned' &&
      selectedCategory.value !== '__uncategorized__' &&
      v.category !== selectedCategory.value
    ) {
      return false
    }

    if (activeTagLower) {
      const tags = (v.tags || []).map((t) => t.toLowerCase())
      if (!tags.includes(activeTagLower)) return false
    }

    if (q) {
      const cleanQ = q.startsWith('#') ? q.slice(1) : q
      const matchesName = v.name.toLowerCase().includes(q)
      const matchesDir = v.directory.toLowerCase().includes(q)
      const matchesDesc = (v.description || '').toLowerCase().includes(q)
      const matchesCat = (v.category || '').toLowerCase().includes(q)
      const matchesTag = (v.tags || []).some((t) => t.toLowerCase().includes(cleanQ))
      if (!matchesName && !matchesDir && !matchesDesc && !matchesCat && !matchesTag) {
        return false
      }
    }

    return true
  })
})

const categorizedGroups = computed(() => {
  const map = new Map()
  if (!searchQuery.value.trim() && !selectedTag.value.trim() && selectedCategory.value === 'all') {
    for (const rawCat of customCategoryBuckets.value) {
      const clean = String(rawCat || '').trim()
      if (!clean || map.has(clean)) continue
      map.set(clean, {
        key: clean,
        label: clean,
        items: [],
      })
    }
  }
  for (const v of filteredVaults.value) {
    const key = v.category || '__uncategorized__'
    if (!map.has(key)) {
      map.set(key, {
        key,
        label: v.category || 'Uncategorized',
        items: [],
      })
    }
    map.get(key).items.push(v)
  }
  return Array.from(map.values()).sort((a, b) => {
    if (a.key === '__uncategorized__') return 1
    if (b.key === '__uncategorized__') return -1
    return a.label.localeCompare(b.label, undefined, { sensitivity: 'base' })
  })
})

const addCustomCategoryBucket = () => {
  const clean = newCategoryName.value.trim()
  if (!clean || /[\x00-\x1f\x7f]/.test(clean) || clean.length > 60) return
  if (!customCategoryBuckets.value.some((c) => c.toLowerCase() === clean.toLowerCase())) {
    customCategoryBuckets.value = [...customCategoryBuckets.value, clean]
  }
  newCategoryName.value = ''
}

const coverUrlFor = (vault) => {
  if (hasApi('getVaultCoverUrl')) {
    return api.getVaultCoverUrl(vault.directory, vault.coverUpdatedAt)
  }
  const base = `/vaults/${encodeURIComponent(vault.directory)}/cover`
  return vault.coverUpdatedAt ? `${base}?v=${encodeURIComponent(String(vault.coverUpdatedAt))}` : base
}

const bannerStyleFor = (vault) => {
  if (!vault || vault.hasCover || !vault.accentColor) return undefined
  const color = String(vault.accentColor).trim()
  if (!color) return undefined
  return {
    backgroundColor: `color-mix(in srgb, ${color} 28%, #161720)`,
  }
}

const formatRelativeTime = (ms) => {
  if (!ms || typeof ms !== 'number') return ''
  const diffSec = Math.max(0, Math.floor((Date.now() - ms) / 1000))
  if (diffSec < 60) return 'just now'
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDays = Math.floor(diffHr / 24)
  if (diffDays < 30) return `${diffDays}d ago`
  return new Date(ms).toLocaleDateString()
}

const openVaultFromCard = (vault) => {
  if (needsRefresh.value || operation.value) return
  emit('open', vault)
}

const showUnauthorized = () => {
  if (mounted) {
    emit('unauthorized')
  }
}

const loadCurrentVaults = async () => {
  try {
    const result = await api.getVaults()
    if (!mounted) {
      return false
    }
    vaults.value = result.vaults
    hasLoaded.value = true
    needsRefresh.value = false
    emit('loaded', result.vaults)
    if (editingDirectory.value) {
      const target = result.vaults.find((vault) => vault.directory === editingDirectory.value)
      const stillValid = Boolean(target) && (editingWasRegistered.value || !target.registered)
      if (!stillValid) {
        editingDirectory.value = null
        editDraft.value = { name: '', category: '', description: '', tags: [], accentColor: '' }
        editTagInput.value = ''
        editError.value = ''
      }
    }
    return true
  } catch (error) {
    if (!mounted) {
      return false
    }
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
      return null
    }
    return false
  }
}

const refreshVaults = async () => {
  if (operation.value) {
    return
  }

  const hadLoaded = hasLoaded.value
  operation.value = hadLoaded ? 'refreshing' : 'loading'
  errorMessage.value = ''

  try {
    const loaded = await loadCurrentVaults()
    if (mounted && loaded === false && errorMessage.value === '') {
      errorMessage.value = hadLoaded
        ? 'Could not refresh vaults. Try again.'
        : 'Could not load vaults. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

const addTagToList = (list, rawTag) => {
  const cleaned = String(rawTag || '').trim().replace(/^#+/, '').replace(/,+$/, '').trim()
  if (!cleaned) return
  if (!list.some((t) => t.toLowerCase() === cleaned.toLowerCase())) {
    list.push(cleaned)
  }
}

const removeTagFromList = (list, tagToRemove) => {
  const idx = list.indexOf(tagToRemove)
  if (idx >= 0) list.splice(idx, 1)
}

const addTagFromInput = (mode) => {
  if (mode === 'create') {
    addTagToList(createDraft.value.tags, createTagInput.value)
    createTagInput.value = ''
  } else {
    addTagToList(editDraft.value.tags, editTagInput.value)
    editTagInput.value = ''
  }
}

const toggleTagFilter = (tag) => {
  if (selectedTag.value.toLowerCase() === tag.toLowerCase()) {
    selectedTag.value = ''
  } else {
    selectedTag.value = tag
  }
}

const toggleCreateForm = () => {
  if (operation.value) return
  showCreateForm.value = !showCreateForm.value
  createError.value = ''
}

const cancelCreateForm = () => {
  if (operation.value) return
  showCreateForm.value = false
  createError.value = ''
}

const submitCreateVault = async () => {
  if (operation.value || !hasApi('createVault')) return
  if (createTagInput.value.trim()) {
    addTagFromInput('create')
  }

  operation.value = 'creating'
  createError.value = ''
  errorMessage.value = ''

  try {
    const payload = {
      name: createDraft.value.name,
      category: createDraft.value.category,
      tags: [...createDraft.value.tags],
      description: createDraft.value.description,
      accentColor: createDraft.value.accentColor,
      createWelcomeNote: createDraft.value.createWelcomeNote,
    }
    if (createDraft.value.directory.trim()) {
      payload.directory = createDraft.value.directory.trim()
    }
    await api.createVault(payload)
    if (!mounted) return
    showCreateForm.value = false
    createDraft.value = {
      name: '',
      directory: '',
      category: '',
      description: '',
      tags: [],
      accentColor: '#a99aca',
      createWelcomeNote: true,
    }
    createTagInput.value = ''
    await refreshAfterMutation('Vault was created, but the list could not be refreshed. Refresh to see the latest state.')
  } catch (error) {
    if (!mounted) return
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
    } else if (error.code === 'VAULT_ALREADY_EXISTS') {
      createError.value = 'A vault folder with that directory name already exists.'
    } else if (error.code === 'INVALID_VAULT_NAME') {
      createError.value = 'Enter a valid display name and try again.'
    } else if (error.code === 'INVALID_VAULT_DIRECTORY') {
      createError.value = 'Enter a valid folder name without path separators.'
    } else if (error.code === 'INVALID_VAULT_TAGS') {
      createError.value = 'Tags cannot contain spaces or special symbols.'
    } else {
      createError.value = 'Could not create vault. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

const startEdit = (vault) => {
  if (operation.value || needsRefresh.value) {
    return
  }
  if (vault.registered && !hasApi('updateVault')) {
    return
  }
  editingDirectory.value = vault.directory
  editingWasRegistered.value = Boolean(vault.registered)
  editDraft.value = {
    name: vault.name,
    category: vault.category || '',
    description: vault.description || '',
    tags: Array.isArray(vault.tags) ? [...vault.tags] : [],
    accentColor: vault.accentColor || '',
  }
  editTagInput.value = ''
  editError.value = ''
  errorMessage.value = ''
}

const cancelEdit = () => {
  if (operation.value) {
    return
  }
  editingDirectory.value = null
  editingWasRegistered.value = false
  editDraft.value = { name: '', category: '', description: '', tags: [], accentColor: '' }
  editTagInput.value = ''
  editError.value = ''
}

const refreshAfterMutation = async (failureMessage) => {
  needsRefresh.value = true
  const loaded = await loadCurrentVaults()
  if (!mounted) {
    return
  }
  if (loaded) {
    errorMessage.value = ''
  } else if (loaded === false) {
    errorMessage.value = failureMessage
  }
}

const saveVault = async (vault) => {
  if (!vault || operation.value || needsRefresh.value || editingDirectory.value !== vault.directory) {
    return
  }

  if (editTagInput.value.trim()) {
    addTagFromInput('edit')
  }

  const directory = vault.directory
  const name = editDraft.value.name
  const hasExtendedMetadata = Boolean(
    editDraft.value.category.trim() ||
    editDraft.value.description.trim() ||
    editDraft.value.tags.length > 0 ||
    editDraft.value.accentColor
  )

  operation.value = 'saving'
  editError.value = ''
  errorMessage.value = ''

  try {
    if (!vault.registered) {
      const payload = hasExtendedMetadata
        ? {
            name,
            directory,
            category: editDraft.value.category.trim(),
            description: editDraft.value.description.trim(),
            tags: [...editDraft.value.tags],
            accentColor: editDraft.value.accentColor,
          }
        : { name, directory }
      await api.registerVault(payload)
    } else if (hasApi('updateVault')) {
      await api.updateVault(directory, {
        name,
        category: editDraft.value.category.trim(),
        description: editDraft.value.description.trim(),
        tags: [...editDraft.value.tags],
        accentColor: editDraft.value.accentColor,
      })
    }

    if (!mounted) {
      return
    }
    editingDirectory.value = null
    editingWasRegistered.value = false
    editDraft.value = { name: '', category: '', description: '', tags: [], accentColor: '' }
    await refreshAfterMutation(
      'Customization was saved, but the list could not be refreshed. Refresh to see the latest state.'
    )
  } catch (error) {
    if (!mounted) {
      return
    }
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
    } else if (error.code === 'INVALID_VAULT_NAME') {
      editError.value = 'Enter a valid display name and try again.'
    } else if (error.code === 'INVALID_VAULT_TAGS') {
      editError.value = 'Tags cannot contain spaces or special symbols.'
    } else if (error.code === 'INVALID_VAULT_DIRECTORY' || error.code === 'VAULT_ALREADY_REGISTERED') {
      editingDirectory.value = null
      editingWasRegistered.value = false
      editDraft.value = { name: '', category: '', description: '', tags: [], accentColor: '' }
      needsRefresh.value = true
      const message = error.code === 'INVALID_VAULT_DIRECTORY'
        ? 'This vault folder is no longer available. Refresh and try again.'
        : 'This vault was customized elsewhere. The list has been refreshed.'
      const loaded = await loadCurrentVaults()
      if (mounted && loaded !== null) {
        errorMessage.value = loaded ? message : 'The vault changed, but the list could not be refreshed. Refresh to see the latest state.'
      }
    } else {
      editError.value = 'Could not customize this vault. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

const resetVault = async (vault) => {
  if (operation.value || needsRefresh.value || !vault.registered) {
    return
  }

  operation.value = 'resetting'
  errorMessage.value = ''

  try {
    await api.unregisterVault(vault.id)
    if (!mounted) {
      return
    }
    await refreshAfterMutation(
      'Customization was reset, but the list could not be refreshed. Refresh to see the latest state.'
    )
  } catch (error) {
    if (!mounted) {
      return
    }
    if (error.code === 'UNAUTHORIZED') {
      showUnauthorized()
    } else {
      errorMessage.value = 'Could not reset this vault. Try again.'
    }
  } finally {
    if (mounted) {
      operation.value = ''
    }
  }
}

const togglePin = async (vault) => {
  if (operation.value || needsRefresh.value || !hasApi('updateVault')) return
  operation.value = 'saving'
  errorMessage.value = ''
  try {
    await api.updateVault(vault.directory, { pinned: !vault.pinned })
    if (!mounted) return
    await refreshAfterMutation('Could not refresh vaults after pinning.')
  } catch (error) {
    if (!mounted) return
    if (error.code === 'UNAUTHORIZED') showUnauthorized()
    else errorMessage.value = 'Could not update pin state. Try again.'
  } finally {
    if (mounted) operation.value = ''
  }
}

const persistOrderDirectories = async (nextDirectories) => {
  if (operation.value || needsRefresh.value || !hasApi('reorderVaults')) return
  operation.value = 'reordering'
  errorMessage.value = ''
  try {
    const result = await api.reorderVaults(nextDirectories)
    if (!mounted) return
    vaults.value = result.vaults
    sortMode.value = 'manual'
    emit('loaded', result.vaults)
  } catch (error) {
    if (!mounted) return
    if (error.code === 'UNAUTHORIZED') showUnauthorized()
    else errorMessage.value = 'Could not save vault order. Try again.'
  } finally {
    if (mounted) operation.value = ''
  }
}

const clearCardDrag = () => {
  draggingDirectory.value = null
  dragOverDirectory.value = null
  dragOverCategory.value = null
}

const handleCardDragStart = (vault, event) => {
  if (operation.value || needsRefresh.value || editingDirectory.value) {
    event.preventDefault?.()
    return
  }
  draggingDirectory.value = vault.directory
  if (event.dataTransfer) {
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', vault.directory)
  }
}

const handleCardDragOver = (vault, event) => {
  if (event.dataTransfer?.types?.includes?.('Files') || draggingDirectory.value) {
    dragOverDirectory.value = vault.directory
  }
}

const handleCardDragLeave = (vault, event) => {
  if (event.currentTarget?.contains?.(event.relatedTarget)) return
  if (dragOverDirectory.value === vault.directory) {
    dragOverDirectory.value = null
  }
}

const handleCardDrop = async (targetVault, event) => {
  const droppedFile = event.dataTransfer?.files?.[0]
  if (droppedFile && !draggingDirectory.value) {
    clearCardDrag()
    await uploadCoverFile(targetVault, droppedFile)
    return
  }

  const sourceDir = draggingDirectory.value || event.dataTransfer?.getData?.('text/plain')
  clearCardDrag()
  if (!sourceDir || sourceDir === targetVault.directory) return

  const dirs = vaults.value.map((v) => v.directory)
  const fromIdx = dirs.indexOf(sourceDir)
  const toIdx = dirs.indexOf(targetVault.directory)
  if (fromIdx < 0 || toIdx < 0) return

  const next = [...dirs]
  const [moved] = next.splice(fromIdx, 1)
  next.splice(toIdx, 0, moved)

  if (viewMode.value === 'categories') {
    const sourceVault = vaults.value.find((v) => v.directory === sourceDir)
    if (sourceVault && sourceVault.category !== targetVault.category && hasApi('updateVault')) {
      await api.updateVault(sourceDir, { category: targetVault.category || '' })
    }
  }

  await persistOrderDirectories(next)
}

const handleCategoryDragOver = (categoryKey) => {
  if (draggingDirectory.value) {
    dragOverCategory.value = categoryKey
  }
}

const handleCategoryDragLeave = (categoryKey, event) => {
  if (event.currentTarget?.contains?.(event.relatedTarget)) return
  if (dragOverCategory.value === categoryKey) {
    dragOverCategory.value = null
  }
}

const handleCategoryDrop = async (categoryKey, event = null) => {
  const sourceDir = draggingDirectory.value || event?.dataTransfer?.getData?.('text/plain')
  clearCardDrag()
  if (!sourceDir || !hasApi('updateVault')) return
  const targetCategory = categoryKey === '__uncategorized__' ? '' : categoryKey
  const sourceVault = vaults.value.find((v) => v.directory === sourceDir)
  if (!sourceVault || sourceVault.category === targetCategory) return

  operation.value = 'saving'
  errorMessage.value = ''
  try {
    await api.updateVault(sourceDir, { category: targetCategory })
    if (!mounted) return
    await refreshAfterMutation('Category updated, but vaults could not be refreshed.')
  } catch (error) {
    if (!mounted) return
    if (error.code === 'UNAUTHORIZED') showUnauthorized()
    else errorMessage.value = 'Could not move vault to category.'
  } finally {
    if (mounted) operation.value = ''
  }
}

const prepareCoverPayload = async (file) => {
  if (!file || file.type === 'image/gif') return file
  if (typeof createImageBitmap !== 'function' || typeof document === 'undefined') return file
  try {
    const bitmap = await createImageBitmap(file)
    if (!bitmap || !bitmap.width || bitmap.width <= 1280) {
      bitmap?.close?.()
      return file
    }
    const scale = 1280 / bitmap.width
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) {
      bitmap.close?.()
      return file
    }
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    bitmap.close?.()
    const targetType = file.type === 'image/png' ? 'image/png' : 'image/webp'
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, targetType, 0.86))
    return blob && blob.size < file.size ? blob : file
  } catch {
    return file
  }
}

const triggerCoverInput = (vault) => {
  if (operation.value || needsRefresh.value || !hasApi('uploadVaultCover')) return
  coverTargetVault.value = vault
  if (coverFileInputRef.value) {
    coverFileInputRef.value.value = ''
    coverFileInputRef.value.click()
  }
}

const uploadCoverFile = async (vault, file) => {
  if (!vault || !file || operation.value || !hasApi('uploadVaultCover')) return
  operation.value = 'uploading'
  errorMessage.value = ''
  try {
    const payload = await prepareCoverPayload(file)
    await api.uploadVaultCover(vault.directory, payload)
    if (!mounted) return
    await refreshAfterMutation('Cover uploaded, but vaults could not be refreshed.')
  } catch (error) {
    if (!mounted) return
    if (error.code === 'UNAUTHORIZED') showUnauthorized()
    else if (error.code === 'VAULT_COVER_TOO_LARGE') errorMessage.value = 'Cover image exceeds the 2 MiB limit.'
    else if (error.code === 'UNSUPPORTED_IMAGE_TYPE') errorMessage.value = 'Use a PNG, JPEG, WebP, or GIF image.'
    else errorMessage.value = 'Could not upload cover image. Try again.'
  } finally {
    if (mounted) operation.value = ''
  }
}

const handleCoverFileSelected = async (event) => {
  const file = event.target?.files?.[0]
  const target = coverTargetVault.value
  coverTargetVault.value = null
  if (file && target) {
    await uploadCoverFile(target, file)
  }
}

const removeCover = async (vault) => {
  if (!vault || operation.value || !hasApi('deleteVaultCover')) return
  operation.value = 'saving'
  errorMessage.value = ''
  try {
    await api.deleteVaultCover(vault.directory)
    if (!mounted) return
    await refreshAfterMutation('Cover removed, but vaults could not be refreshed.')
  } catch (error) {
    if (!mounted) return
    if (error.code === 'UNAUTHORIZED') showUnauthorized()
    else errorMessage.value = 'Could not remove cover image. Try again.'
  } finally {
    if (mounted) operation.value = ''
  }
}

const handleModalEscape = (event) => {
  if (event.key !== 'Escape' || operation.value) return
  if (editingDirectory.value) {
    cancelEdit()
  } else if (showCreateForm.value) {
    cancelCreateForm()
  }
}

onMounted(() => {
  window.addEventListener('keydown', handleModalEscape)
  if (Array.isArray(props.initialVaults)) {
    vaults.value = props.initialVaults
    hasLoaded.value = true
    needsRefresh.value = false
    emit('loaded', props.initialVaults)
    return
  }
  refreshVaults()
})

onBeforeUnmount(() => {
  mounted = false
  window.removeEventListener('keydown', handleModalEscape)
})
</script>
