<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useAdventureStore } from '@/stores/adventure'
import { useWorldStore } from '@/stores/world'
import { useSettingsStore } from '@/stores/settings'
import { playSceneBgm, playBgmByName, setBgmMuted, isBgmPlaying } from '@/audio/bgm'

const adventure = useAdventureStore()
const worldStore = useWorldStore()
const settings = useSettingsStore()

const tabs = ['面板', '背包', '地图', '人物', '设定', '经历', '概述'] as const
type Tab = (typeof tabs)[number]
const activeTab = ref<Tab>('面板')

const save = computed(() => adventure.currentSave)
const schema = computed(() => worldStore.currentWorld?.panelSchema ?? [])

const profileEdit = ref('')
const profileSaving = ref(false)
const profileSaved = ref(false)
let profileSavedTimer: ReturnType<typeof setTimeout> | null = null

const experienceEdit = ref('')
const experienceSaving = ref(false)
const experienceSaved = ref(false)
let experienceSavedTimer: ReturnType<typeof setTimeout> | null = null

// 面板/背包本地改写（不调用 AI，直接改存档，下次行动传新存档）
const editMode = ref(false)
const editingPanelKey = ref<string | null>(null)
const panelEditValue = ref('')
const editingItem = ref<{ type: 'equipment' | 'items'; index: number } | null>(null)
const itemEditName = ref('')
const itemEditQty = ref('')
const itemEditState = ref('')

function startEditPanel(key: string) {
  if (!editMode.value || !save.value) return
  editingPanelKey.value = key
  panelEditValue.value = String(save.value.panel[key] ?? '')
}
function saveEditPanel() {
  if (!save.value || !editingPanelKey.value) return
  save.value.panel[editingPanelKey.value] = panelEditValue.value
  editingPanelKey.value = null
  void adventure.persistState()
}
function cancelEditPanel() {
  editingPanelKey.value = null
}
function startEditItem(type: 'equipment' | 'items', index: number) {
  if (!editMode.value || !save.value) return
  const it = save.value.inventory[type][index]
  editingItem.value = { type, index }
  itemEditName.value = it.name
  itemEditQty.value = String(it.quantity ?? '')
  itemEditState.value = it.state ?? ''
}
function saveEditItem() {
  if (!save.value || !editingItem.value) return
  const { type, index } = editingItem.value
  const it = save.value.inventory[type][index]
  it.name = itemEditName.value.trim()
  it.quantity = itemEditQty.value.trim() ? Number(itemEditQty.value) : undefined
  it.state = itemEditState.value.trim() || undefined
  editingItem.value = null
  void adventure.persistState()
}
function cancelEditItem() {
  editingItem.value = null
}
function removeItem(type: 'equipment' | 'items', index: number) {
  if (!save.value) return
  save.value.inventory[type].splice(index, 1)
  void adventure.persistState()
}

// 地图/人物条目本地改写（直接改对应世界书条目的 title/content）
const editingLore = ref<{ type: 'location' | 'character'; title: string } | null>(null)
const loreEditName = ref('')
const loreEditDesc = ref('')

function startEditLore(type: 'location' | 'character', title: string) {
  if (!editMode.value) return
  const world = worldStore.currentWorld
  if (!world?.lorebook) return
  const e = world.lorebook.find((x) => (type === 'location' ? x.isLocation : x.isCharacter) && (x.title ?? '').trim() === title)
  if (!e) return
  editingLore.value = { type, title }
  loreEditName.value = e.title ?? ''
  loreEditDesc.value = e.content ?? ''
}
function saveEditLore() {
  const world = worldStore.currentWorld
  if (!world?.lorebook || !editingLore.value) return
  const { type, title } = editingLore.value
  const e = world.lorebook.find((x) => (type === 'location' ? x.isLocation : x.isCharacter) && (x.title ?? '').trim() === title)
  if (e) {
    e.title = loreEditName.value.trim() || e.title
    e.content = loreEditDesc.value
  }
  editingLore.value = null
  void worldStore.updateWorld(world.id, { lorebook: world.lorebook })
}
function cancelEditLore() {
  editingLore.value = null
}

watch(
  () => save.value?.characterProfile,
  (v) => {
    profileEdit.value = v ?? ''
  },
  { immediate: true },
)

watch(
  () => save.value?.experience,
  (v) => {
    experienceEdit.value = v ?? ''
  },
  { immediate: true },
)

async function saveProfile() {
  if (profileSaving.value || !adventure.hasAdventure) return
  profileSaving.value = true
  try {
    await adventure.updateCharacterProfile(profileEdit.value)
    profileSaved.value = true
    if (profileSavedTimer) clearTimeout(profileSavedTimer)
    profileSavedTimer = setTimeout(() => {
      profileSaved.value = false
      profileSavedTimer = null
    }, 2000)
  } finally {
    profileSaving.value = false
  }
}

async function saveExperience() {
  if (experienceSaving.value || !adventure.hasAdventure) return
  experienceSaving.value = true
  try {
    await adventure.updateExperience(experienceEdit.value)
    experienceSaved.value = true
    if (experienceSavedTimer) clearTimeout(experienceSavedTimer)
    experienceSavedTimer = setTimeout(() => {
      experienceSaved.value = false
      experienceSavedTimer = null
    }, 2000)
  } finally {
    experienceSaving.value = false
  }
}

async function toggleManualProfile(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  await settings.setManualProfile(checked)
}

const currentScene = computed(() => {
  const world = worldStore.currentWorld
  if (!world || !world.sceneField || !adventure.currentSave) return undefined
  const v = adventure.currentSave.panel[world.sceneField]
  return typeof v === 'string' ? v : v != null ? String(v) : undefined
})

function triggerBgm() {
  if (adventure.eggBgmPending) {
    const name = adventure.eggBgmPending
    adventure.eggBgmPending = null
    void playBgmByName(worldStore.currentWorld, name)
    return
  }
  if (adventure.hasAdventure && !isBgmPlaying()) {
    void playSceneBgm(worldStore.currentWorld, currentScene.value)
  }
}

onMounted(() => {
  void setBgmMuted(settings.muted)
  triggerBgm()
})

onUnmounted(() => {
  if (profileSavedTimer) clearTimeout(profileSavedTimer)
  if (experienceSavedTimer) clearTimeout(experienceSavedTimer)
})


async function toggleMute() {
  const next = !settings.muted
  await settings.setBgmMuted(next)
  await setBgmMuted(next)
}

async function toggleDetailedBag(e: Event) {
  const checked = (e.target as HTMLInputElement).checked
  await settings.setDetailedBag(checked)
}

// 世界书概览
const loreKeyword = ref('')
const loreOrder = ref<'asc' | 'desc'>('asc')
const loreOverview = computed(() => {
  const world = worldStore.currentWorld
  if (!world?.lorebook?.length) return []
  return world.lorebook.filter((e) => !e.hidden).map((e) => {
    return {
      id: e.id,
      title: e.title ?? '（无标题）',
      tags: e.tags ?? [],
      required: !!e.required,
      fixed: !!e.fixed,
      content: e.content ?? '',
    }
  })
})

const filteredLoreOverview = computed(() => {
  const q = loreKeyword.value.trim().toLowerCase()
  if (!q) return loreOverview.value
  return loreOverview.value
    .map((e) => {
      const rank = e.title.toLowerCase().includes(q)
        ? 0
        : (e.tags ?? []).some((t) => t.toLowerCase().includes(q))
          ? 1
          : e.content.toLowerCase().includes(q)
            ? 2
            : 3
      return { e, rank }
    })
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.e)
})

const displayedLoreOverview = computed(() =>
  loreOrder.value === 'desc' ? [...filteredLoreOverview.value].reverse() : filteredLoreOverview.value,
)

// 地图：优先从世界书 isLocation 条目读取，回退到存档 map（兼容旧存档）
const mapList = computed(() => {
  const world = worldStore.currentWorld
  const loreLocations = (world?.lorebook ?? []).filter((e) => e.isLocation && !e.hidden)
  if (loreLocations.length > 0) {
    const active = save.value?.activeLocations ?? []
    return loreLocations
      .map((e) => ({
        name: e.title ?? '（无标题）',
        description: e.content,
        active: active.includes((e.title ?? '').trim()),
      }))
      .sort((a, b) => {
        const ai = active.indexOf(a.name)
        const bi = active.indexOf(b.name)
        if (ai >= 0 && bi >= 0) return ai - bi
        if (ai >= 0) return -1
        if (bi >= 0) return 1
        return 0
      })
  }
  return (save.value?.map ?? []).map((loc) => ({
    name: loc.name,
    description: loc.description,
    active: false,
  }))
})

// 人物：优先从世界书 isCharacter 条目读取，回退到存档 characters（兼容旧存档）
const characterList = computed(() => {
  const world = worldStore.currentWorld
  const loreCharacters = (world?.lorebook ?? []).filter((e) => e.isCharacter && !e.hidden)
  if (loreCharacters.length > 0) {
    const active = save.value?.activeCharacters ?? []
    return loreCharacters
      .map((e) => ({
        name: e.title ?? '（无标题）',
        description: e.content,
        active: active.includes((e.title ?? '').trim()),
      }))
      .sort((a, b) => {
        const ai = active.indexOf(a.name)
        const bi = active.indexOf(b.name)
        if (ai >= 0 && bi >= 0) return ai - bi
        if (ai >= 0) return -1
        if (bi >= 0) return 1
        return 0
      })
  }
  return (save.value?.characters ?? []).map((c) => ({
    name: c.name,
    description: c.introduction,
    active: false,
  }))
})
</script>

<template>
  <div class="page">

    <header class="header">
      <h1>状态</h1>
      <button
        v-if="worldStore.currentWorld?.dlcId && save"
        class="mute-btn"
        :class="{ muted: settings.muted }"
        @click="toggleMute"
      >
        {{ settings.muted ? '🔇' : '🔊' }}
      </button>
    </header>

    <div v-if="!save" class="empty">
      <p>当前世界尚未开始冒险</p>
      <p>在「世界」选择一个世界，再到「冒险」中创建角色开始</p>
    </div>

    <template v-else>
      <div class="tabs">
        <button
          v-for="t in tabs"
          :key="t"
          class="tab"
          :class="{ active: activeTab === t }"
          @click="activeTab = t"
        >
          {{ t }}
        </button>
      </div>

      <div class="content">
        <!-- 角色面板 -->
        <div v-if="activeTab === '面板'" class="panel">
          <label class="edit-toggle-row">
            <input type="checkbox" v-model="editMode" />
            <span>允许改写（开启后双击条目编辑）</span>
          </label>
          <div v-for="f in schema" :key="f.key" class="panel-row" @dblclick="startEditPanel(f.key)">
            <span class="panel-label">{{ f.label }}</span>
            <template v-if="editingPanelKey === f.key">
              <input v-model="panelEditValue" class="status-edit-input" @keyup.enter="saveEditPanel" @keyup.esc="cancelEditPanel" />
              <button class="status-edit-btn save" @click="saveEditPanel">完成</button>
              <button class="status-edit-btn cancel" @click="cancelEditPanel">取消</button>
            </template>
            <span v-else class="panel-value">{{ save.panel[f.key] }}{{ f.unit ?? '' }}</span>
          </div>

        </div>

        <!-- 背包 -->
        <div v-else-if="activeTab === '背包'" class="bag">
          <label class="edit-toggle-row">
            <input type="checkbox" v-model="editMode" />
            <span>允许改写（开启后双击条目编辑）</span>
          </label>
          <label class="detail-row">
            <input
              type="checkbox"
              :checked="settings.detailedBag"
              @change="toggleDetailedBag"
            />
            <span>精细化背包描述：生成更详细的介绍描述</span>
          </label>
          <section class="block">
            <h3 class="block-title">装备</h3>
            <p v-if="save.inventory.equipment.length === 0" class="muted">（空）</p>
            <div v-for="(it, i) in save.inventory.equipment" :key="i" class="row bag-row" @dblclick="startEditItem('equipment', i)">
              <template v-if="editingItem && editingItem.type === 'equipment' && editingItem.index === i">
                <input v-model="itemEditName" class="status-edit-input" placeholder="名称" />
                <input v-model="itemEditState" class="status-edit-input" placeholder="状态" />
                <button class="status-edit-btn save" @click="saveEditItem">完成</button>
                <button class="status-edit-btn cancel" @click="cancelEditItem">取消</button>
              </template>
              <template v-else>
                <span class="bag-name">{{ it.name }}</span>
                <p v-if="it.state" class="bag-state">{{ it.state }}</p>
                <button v-if="editMode" class="item-del-btn" @click.stop="removeItem('equipment', i)">✕</button>
              </template>
            </div>
          </section>
          <section class="block">
            <h3 class="block-title">物品</h3>
            <p v-if="save.inventory.items.length === 0" class="muted">（空）</p>
            <div v-for="(it, i) in save.inventory.items" :key="i" class="row bag-row" @dblclick="startEditItem('items', i)">
              <template v-if="editingItem && editingItem.type === 'items' && editingItem.index === i">
                <input v-model="itemEditName" class="status-edit-input" placeholder="名称" />
                <input v-model="itemEditQty" class="status-edit-input qty" placeholder="数量" />
                <input v-model="itemEditState" class="status-edit-input" placeholder="状态" />
                <button class="status-edit-btn save" @click="saveEditItem">完成</button>
                <button class="status-edit-btn cancel" @click="cancelEditItem">取消</button>
              </template>
              <template v-else>
                <span class="bag-name">{{ it.name }}{{ it.quantity ? ` ×${it.quantity}` : '' }}</span>
                <p v-if="it.state" class="bag-state">{{ it.state }}</p>
                <button v-if="editMode" class="item-del-btn" @click.stop="removeItem('items', i)">✕</button>
              </template>
            </div>
          </section>
          </div>

        <!-- 地图 -->
        <div v-else-if="activeTab === '地图'" class="list">
          <label class="edit-toggle-row">
            <input type="checkbox" v-model="editMode" />
            <span>允许改写（开启后双击条目编辑）</span>
          </label>
          <p v-if="mapList.length === 0" class="muted">（暂无地点）</p>
          <div v-for="(loc, i) in mapList" :key="i" class="card" @dblclick="startEditLore('location', loc.name)">
            <div class="card-head">
              <span class="card-name">{{ loc.name }}</span>
              <span v-if="loc.active" class="badge">当前</span>
            </div>
            <template v-if="editingLore && editingLore.type === 'location' && editingLore.title === loc.name">
              <input v-model="loreEditName" class="status-edit-input" placeholder="名称" />
              <textarea v-model="loreEditDesc" class="status-edit-textarea" rows="4" placeholder="描述" />
              <div class="edit-actions">
                <button class="status-edit-btn save" @click="saveEditLore">完成</button>
                <button class="status-edit-btn cancel" @click="cancelEditLore">取消</button>
              </div>
            </template>
            <p v-else class="card-desc">{{ loc.description }}</p>
          </div>
        </div>

        <!-- 人物 -->
        <div v-else-if="activeTab === '人物'" class="list">
          <label class="edit-toggle-row">
            <input type="checkbox" v-model="editMode" />
            <span>允许改写（开启后双击条目编辑）</span>
          </label>
          <p v-if="characterList.length === 0" class="muted">（尚未接触任何人物）</p>
          <div v-for="(c, i) in characterList" :key="i" class="card" @dblclick="startEditLore('character', c.name)">
            <div class="card-head">
              <span class="card-name">{{ c.name }}</span>
              <span v-if="c.active" class="badge">当前</span>
            </div>
            <template v-if="editingLore && editingLore.type === 'character' && editingLore.title === c.name">
              <input v-model="loreEditName" class="status-edit-input" placeholder="名称" />
              <textarea v-model="loreEditDesc" class="status-edit-textarea" rows="4" placeholder="描述" />
              <div class="edit-actions">
                <button class="status-edit-btn save" @click="saveEditLore">完成</button>
                <button class="status-edit-btn cancel" @click="cancelEditLore">取消</button>
              </div>
            </template>
            <p v-else class="card-desc">{{ c.description }}</p>
          </div>
        </div>

        <!-- 角色设定 -->
        <div v-else-if="activeTab === '设定'" class="prose">
          <textarea
            v-model="profileEdit"
            class="profile-edit"
            rows="12"
            placeholder="角色设定…"
          />
          <label class="detail-row">
            <input
              type="checkbox"
              :checked="settings.manualProfile"
              @change="toggleManualProfile"
            />
            <span>手动更新设定</span>
          </label>
          <p class="profile-hint">
            开启后，AI 推进剧情时不会自动修改上方「角色设定」中的人设内容，人设完全由你手动维护，
            避免剧情发展把角色设定改乱。仅影响人设，不影响经历、面板与状态等内容的自动更新。
          </p>
          <button class="save-profile-btn" :disabled="profileSaving" @click="saveProfile">
            {{ profileSaved ? '已保存 ✓' : '保存设定' }}
          </button>
          <p class="lore-tip">编辑世界书请在「世界 - 设定 - 世界书」</p>

          <section v-if="loreOverview.length > 0" class="block lore-overview">
            <div class="lore-overview-header">
              <h3 class="block-title">世界书（{{ loreOverview.length }} 条）</h3>
              <button class="lore-order-btn" @click="loreOrder = loreOrder === 'asc' ? 'desc' : 'asc'">
                {{ loreOrder === 'asc' ? '正序 ↑' : '倒序 ↓' }}
              </button>
            </div>
            <input v-model="loreKeyword" class="lore-search" placeholder="检索条目（标题/标签/内容）" />
            <div v-for="entry in displayedLoreOverview" :key="entry.id" class="lore-overview-row">
              <div class="lore-overview-head">
                <span class="lore-overview-title">{{ entry.title }}</span>
                <span v-if="entry.required" class="lore-flag">必需</span>
                <span v-if="entry.fixed" class="lore-flag fixed">固定</span>
              </div>
              <div class="lore-overview-tags">
                <span v-for="t in entry.tags" :key="t" class="lore-tag">{{ t }}</span>
              </div>
              <p class="lore-overview-preview">{{ entry.content }}</p>
            </div>
            <p v-if="displayedLoreOverview.length === 0" class="muted">没有匹配的条目</p>
          </section>
        </div>

        <!-- 角色经历 -->
        <div v-else-if="activeTab === '经历'" class="prose">

          <textarea
            v-model="experienceEdit"
            class="profile-edit"
            rows="12"
            placeholder="角色经历…"
          />
          <button class="save-profile-btn" :disabled="experienceSaving" @click="saveExperience">
            {{ experienceSaved ? '已保存 ✓' : '保存经历' }}
          </button>
        </div>

        <!-- 概述 -->
        <div v-else class="overview">
          <section class="block">
            <h3 class="block-title">主观认知</h3>
            <p class="body-text">{{ save.overview.impression || '（空）' }}</p>
          </section>
          <section class="block">
            <h3 class="block-title">进行中的事项</h3>
            <p class="body-text">{{ save.overview.ongoing || '（无）' }}</p>
          </section>
          <section class="block">
            <h3 class="block-title">近期关键事件</h3>
            <p v-if="save.overview.recentEvents.length === 0" class="muted">（无）</p>
            <ul class="events">
              <li v-for="(e, i) in save.overview.recentEvents" :key="i">{{ e }}</li>
            </ul>
          </section>
          <section class="block">
            <h3 class="block-title">最新进展</h3>
            <p class="body-text">{{ save.overview.latestProgress || '（无）' }}</p>
          </section>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>

.page {
  padding: 16px;
  min-height: 100%;
}
.header h1 {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.mute-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 18px;
  line-height: 1;
}
.mute-btn.muted {
  opacity: 0.5;
}
.empty {
  text-align: center;
  color: var(--muted);
  padding: 60px 20px;
  line-height: 1.8;
}
.tabs {
  display: flex;
  gap: 6px;
  overflow-x: auto;
  margin-bottom: 16px;
  padding-bottom: 4px;
}
.tab {
  flex: none;
  padding: 8px 14px;
  border-radius: 16px;
  background: var(--surface);
  color: var(--muted);
  font-size: 14px;
  border: 1px solid var(--border);
}
.tab.active {
  color: var(--active);
  border-color: var(--active);
  background: #0d1b2e;
}
.content {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.panel-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px 16px;
  margin-bottom: 8px;
}
.panel-label {
  color: var(--muted);
  font-size: 14px;
}
.panel-value {
  font-weight: 600;
  font-size: 15px;
}
.status-edit-input {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--active);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 14px;
  min-width: 0;
}
.status-edit-input.qty {
  flex: none;
  width: 60px;
}
.status-edit-btn {
  flex: none;
  border: none;
  border-radius: 6px;
  padding: 6px 12px;
  font-size: 13px;
  cursor: pointer;
}
.status-edit-btn.save {
  background: var(--active);
  color: #fff;
}
.status-edit-btn.cancel {
  background: var(--surface-2);
  color: var(--muted);
  border: 1px solid var(--border);
}
.item-del-btn {
  flex: none;
  background: transparent;
  color: var(--danger);
  border: none;
  font-size: 14px;
  padding: 2px 6px;
  cursor: pointer;
}
.edit-toggle-row {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 0;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}
.edit-toggle-row input,
.detail-row input {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border: 1.5px solid var(--muted);
  border-radius: 4px;
  background: var(--bg);
  cursor: pointer;
  flex: none;
  position: relative;
}
.edit-toggle-row input:checked,
.detail-row input:checked {
  background: var(--active);
  border-color: var(--active);
}
.edit-toggle-row input:checked::after,
.detail-row input:checked::after {
  content: '✓';
  position: absolute;
  left: 2px;
  top: -3px;
  font-size: 13px;
  color: #fff;
}
.status-edit-textarea {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--active);
  border-radius: 6px;
  padding: 6px 8px;
  font-size: 14px;
  resize: vertical;
  min-height: 80px;
  margin: 4px 0;
}
.edit-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
}
.block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
}
.block-title {
  font-size: 13px;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 10px;
}
.row {
  display: flex;
  justify-content: space-between;
  padding: 8px 0;
  border-bottom: 1px solid var(--border);
}
.row:last-child {
  border-bottom: none;
}
.row-sub {
  color: var(--muted);
  font-size: 13px;
}
.bag-row {
  flex-direction: column;
  align-items: flex-start;
  gap: 4px;
}
.bag-name {
  font-weight: 500;
  font-size: 15px;
}
.bag-state {
  color: var(--muted);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.detail-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 8px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  line-height: 1.5;
}
.lore-overview {
  margin-top: 16px;
}
.lore-overview-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.lore-order-btn {
  flex: none;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
}
.lore-search {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 9px 12px;
  margin-bottom: 4px;
  font-size: 14px;
}
.lore-overview-row {
  padding: 10px 0;
  border-bottom: 1px solid var(--border);
}
.lore-overview-row:last-child {
  border-bottom: none;
}
.lore-overview-head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 4px;
}
.lore-overview-title {
  font-weight: 600;
  font-size: 14px;
}
.lore-flag {
  font-size: 10px;
  color: #000;
  background: var(--yellow);
  border-radius: 4px;
  padding: 1px 5px;
}
.lore-flag.fixed {
  color: #fff;
  background: var(--active);
}
.lore-overview-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 4px;
}
.lore-tag {
  font-size: 11px;
  color: var(--muted);
  background: var(--surface-2);
  border-radius: 4px;
  padding: 1px 6px;
}
.lore-overview-preview {
  font-size: 13px;
  color: var(--muted);
  line-height: 1.5;
  margin: 0;
}
.muted {
  color: var(--muted);
  font-size: 14px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 10px;
}
.card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 8px;
}
.card-name {
  font-weight: 600;
  font-size: 16px;
}
.badge {
  font-size: 12px;
  color: var(--active);
  border: 1px solid var(--active);
  border-radius: 10px;
  padding: 2px 8px;
}
.card-desc {
  color: #ccc;
  font-size: 14px;
  line-height: 1.6;
}
.card-people {
  color: var(--muted);
  font-size: 13px;
  margin-top: 6px;
}
.profile-text,
.body-text {
  font-size: 15px;
  line-height: 1.7;
  white-space: pre-wrap;
}
.profile-edit {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  resize: vertical;
  line-height: 1.7;
  font-size: 15px;
  min-height: 200px;
}
.save-profile-btn {
  margin-top: 12px;
  width: 100%;
  background: var(--active);
  color: #fff;
  font-weight: 600;
  border-radius: 10px;
  padding: 12px;
  font-size: 15px;
}
.save-profile-btn:disabled {
  opacity: 0.5;
}
.profile-hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.6;
  margin: 6px 0 0;
  padding: 8px 10px;
  background: var(--surface-2);
  border-radius: 8px;
}
.profile-tip {
  color: var(--muted);
  font-size: 13px;
}
.lore-tip {
  font-size: 12px;
  color: var(--muted);
  margin: 10px 0 0;
  text-align: center;
}
.events {
  padding-left: 20px;
}
.events li {
  margin-bottom: 6px;
  line-height: 1.6;
  font-size: 14px;
}
</style>