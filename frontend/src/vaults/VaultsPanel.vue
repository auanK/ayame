<template>
  <section
    class="vaults-panel"
    data-testid="vaults-panel"
    aria-labelledby="vaults-heading"
    :aria-busy="Boolean(operation)"
  >
    <header class="vaults-panel-header">
      <div class="vaults-panel-title-block">
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

    <div class="vaults-panel-content">
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
        <VaultsToolbar
          v-model:search-query="searchQuery"
          v-model:view-mode="viewMode"
          v-model:sort-mode="sortMode"
          v-model:selected-category="selectedCategory"
          :selected-tag="selectedTag"
          :total-count="vaults.length"
          :pinned-count="pinnedCount"
          :uncategorized-count="uncategorizedCount"
          :category-counts="categoryCounts"
          :all-vault-tags="allVaultTags"
          @toggle-tag="toggleTagFilter"
          @clear-tag="selectedTag = ''"
        />

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

          <VaultCategoryGroup
            v-for="group in categorizedGroups"
            :key="group.key"
            :group="group"
            :is-drop-target="dragOverCategory === group.key"
            :dragging-directory="draggingDirectory"
            :drag-over-directory="dragOverDirectory"
            :needs-refresh="needsRefresh"
            :operation="operation"
            :selected-tag="selectedTag"
            :cover-url-for="coverUrlFor"
            :banner-style-for="bannerStyleFor"
            :format-relative-time="formatRelativeTime"
            @drag-over="handleCategoryDragOver"
            @drag-leave="handleCategoryDragLeave"
            @drop-category="handleCategoryDrop"
            @open="emit('open', $event)"
            @open-card="openVaultFromCard"
            @edit="startEdit"
            @reset="resetVault"
            @toggle-pin="togglePin"
            @upload-cover="triggerCoverInput"
            @toggle-tag="toggleTagFilter"
            @card-drag-start="handleCardDragStart"
            @card-drag-over="handleCardDragOver"
            @card-drag-leave="handleCardDragLeave"
            @card-drop="handleCardDrop"
            @card-drag-end="clearCardDrag"
          />
        </div>

        <!-- Cards Grid or Compact List View -->
        <ul
          v-else
          :class="viewMode === 'compact' ? 'vault-list' : 'vault-grid'"
          aria-label="Vaults"
        >
          <VaultCard
            v-for="vault in filteredVaults"
            :key="vault.id || vault.directory"
            :vault="vault"
            :compact="viewMode === 'compact'"
            :dragging="draggingDirectory === vault.directory"
            :drop-target="dragOverDirectory === vault.directory && draggingDirectory !== vault.directory"
            :needs-refresh="needsRefresh"
            :operation="operation"
            :selected-tag="selectedTag"
            :cover-url="coverUrlFor(vault)"
            :banner-style="bannerStyleFor(vault)"
            :formatted-time="formatRelativeTime(vault.lastModifiedAt)"
            @open="emit('open', $event)"
            @open-card="openVaultFromCard"
            @edit="startEdit"
            @reset="resetVault"
            @toggle-pin="togglePin"
            @upload-cover="triggerCoverInput"
            @toggle-tag="toggleTagFilter"
            @drag-start="handleCardDragStart"
            @drag-over="handleCardDragOver"
            @drag-leave="handleCardDragLeave"
            @drop-card="handleCardDrop"
            @drag-end="clearCardDrag"
          />
        </ul>
      </template>
    </div>

    <VaultFormModal
      v-if="showCreateForm"
      mode="create"
      :draft="createDraft"
      :operation="operation"
      :error-message="createError"
      @close="cancelCreateForm"
      @submit="submitCreateVault"
    />

    <VaultFormModal
      v-if="editingVault"
      mode="edit"
      :draft="editDraft"
      :vault="editingVault"
      :cover-url="coverUrlFor(editingVault)"
      :operation="operation"
      :error-message="editError"
      @close="cancelEdit"
      @submit="saveVault(editingVault)"
      @upload-cover="triggerCoverInput"
      @remove-cover="removeCover"
    />
  </section>
</template>

<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import * as api from './api.js'
import VaultsToolbar from './hub/VaultsToolbar.vue'
import VaultCard from './hub/VaultCard.vue'
import VaultCategoryGroup from './hub/VaultCategoryGroup.vue'
import VaultFormModal from './hub/VaultFormModal.vue'

const props = defineProps({
  initialVaults: {
    type: Array,
    default: null,
  },
  refreshInitialVaults: { type: Boolean, default: false },
})

const emit = defineEmits(['unauthorized', 'open', 'loaded'])

const vaults = ref([])
const hasLoaded = ref(false)
const operation = ref('')
let operationGeneration = 0
watch(operation, () => { operationGeneration++ }, { flush: 'sync' })
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
    backgroundColor: `color-mix(in srgb, ${color} 22%, var(--workspace-editor))`,
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

const loadCurrentVaults = async (isCurrent = () => mounted) => {
  try {
    const result = await api.getVaults()
    if (!isCurrent()) {
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
        editError.value = ''
      }
    }
    return true
  } catch (error) {
    if (!isCurrent()) {
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

onMounted(() => {
  if (Array.isArray(props.initialVaults)) {
    vaults.value = props.initialVaults
    hasLoaded.value = true
    needsRefresh.value = false
    if (props.refreshInitialVaults) {
      const generation = operationGeneration
      void loadCurrentVaults(() => mounted && generation === operationGeneration)
    } else {
      emit('loaded', props.initialVaults)
    }
    return
  }
  refreshVaults()
})

onBeforeUnmount(() => {
  mounted = false
})
</script>
