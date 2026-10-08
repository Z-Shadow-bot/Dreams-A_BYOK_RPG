<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useAdventureStore } from '@/stores/adventure'
import { useWorldStore } from '@/stores/world'
import { useSettingsStore } from '@/stores/settings'
import { playSceneBgm, playBgmByName, setBgmMuted, isBgmPlaying } from '@/audio/bgm'

const adventure = useAdventureStore()
const worldStore = useWorldStore()
const settings = useSettingsStore()

const tabs = ['面板', '背包', '地图', '人物', '设定', '概述'] as const
type Tab = (typeof tabs)[number]
const activeTab = ref<Tab>('面板')

const save = computed(() => adventure.currentSave)
const schema = computed(() => worldStore.currentWorld?.panelSchema ?? [])

const profileEdit = ref('')
const profileSaving = ref(false)
const profileSaved = ref(false)
let profileSavedTimer: ReturnType<typeof setTimeout> | null = null

watch(
  () => save.value?.characterProfile,
  (v) => {
    profileEdit.value = v ?? ''
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

// 世界书概览：条目 + 与当前存档的一致性提示
const loreOverview = computed(() => {
  const world = worldStore.currentWorld
  if (!world?.lorebook?.length) return []
  const saveNames = new Set<string>()
  if (save.value) {
    for (const m of save.value.map) saveNames.add(m.name)
    for (const c of save.value.characters) saveNames.add(c.name)
  }
  return world.lorebook.filter((e) => !e.hidden).map((e) => {
    const matched = (e.tags ?? []).some((t) =>
      [...saveNames].some((n) => n.includes(t) || t.includes(n)),
    )
    return {
      id: e.id,
      title: e.title ?? '（无标题）',
      tags: e.tags ?? [],
      required: !!e.required,
      matched,
      preview: e.content.slice(0, 80) + (e.content.length > 80 ? '…' : ''),
    }
  })
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
          <div v-for="f in schema" :key="f.key" class="panel-row">
            <span class="panel-label">{{ f.label }}</span>
            <span class="panel-value">{{ save.panel[f.key] }}{{ f.unit ?? '' }}</span>
          </div>
        </div>

        <!-- 背包 -->
        <div v-else-if="activeTab === '背包'" class="bag">
          <section class="block">
            <h3 class="block-title">装备</h3>
            <p v-if="save.inventory.equipment.length === 0" class="muted">（空）</p>
            <div v-for="(it, i) in save.inventory.equipment" :key="i" class="row bag-row">
              <span class="bag-name">{{ it.name }}</span>
              <p v-if="it.state" class="bag-state">{{ it.state }}</p>
            </div>
          </section>
          <section class="block">
            <h3 class="block-title">物品</h3>
            <p v-if="save.inventory.items.length === 0" class="muted">（空）</p>
            <div v-for="(it, i) in save.inventory.items" :key="i" class="row bag-row">
              <span class="bag-name">{{ it.name }}{{ it.quantity ? ` ×${it.quantity}` : '' }}</span>
              <p v-if="it.state" class="bag-state">{{ it.state }}</p>
            </div>
          </section>
          <label class="detail-row">
            <input
              type="checkbox"
              :checked="settings.detailedBag"
              @change="toggleDetailedBag"
            />
            <span>精细化背包描述：对背包物品生成更详细的外观与状态描述</span>
          </label>
        </div>

        <!-- 地图 -->
        <div v-else-if="activeTab === '地图'" class="list">
          <p v-if="save.map.length === 0" class="muted">（暂无地点）</p>
          <div v-for="(loc, i) in save.map" :key="i" class="card">
            <div class="card-head">
              <span class="card-name">{{ loc.name }}</span>
              <span v-if="!loc.visited" class="badge">未到达</span>
            </div>
            <p class="card-desc">{{ loc.description }}</p>
            <p v-if="loc.people.length" class="card-people">人物：{{ loc.people.join('、') }}</p>
          </div>
        </div>

        <!-- 人物 -->
        <div v-else-if="activeTab === '人物'" class="list">
          <p v-if="save.characters.length === 0" class="muted">（尚未接触任何人物）</p>
          <div v-for="(c, i) in save.characters" :key="i" class="card">
            <div class="card-head">
              <span class="card-name">{{ c.name }}</span>
              <span class="badge">{{ c.attitude }}</span>
            </div>
            <p class="card-desc">{{ c.introduction }}</p>
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
          <button class="save-profile-btn" :disabled="profileSaving" @click="saveProfile">
            {{ profileSaved ? '已保存 ✓' : '保存设定' }}
          </button>

          <section v-if="loreOverview.length > 0" class="block lore-overview">
            <h3 class="block-title">世界书（{{ loreOverview.length }} 条）</h3>
            <div v-for="entry in loreOverview" :key="entry.id" class="lore-overview-row">
              <div class="lore-overview-head">
                <span class="lore-overview-title">{{ entry.title }}</span>
                <span v-if="entry.required" class="lore-flag">铁律</span>
                <span
                  class="lore-match"
                  :class="{ matched: entry.matched, orphan: !entry.matched }"
                >{{ entry.matched ? '已对应' : '暂未对应' }}</span>
              </div>
              <div class="lore-overview-tags">
                <span v-for="t in entry.tags" :key="t" class="lore-tag">{{ t }}</span>
              </div>
              <p class="lore-overview-preview">{{ entry.preview }}</p>
            </div>
          </section>
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
  margin-top: 14px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  line-height: 1.5;
}
.detail-row input {
  width: 16px;
  height: 16px;
  cursor: pointer;
  margin-top: 1px;
  flex: none;
}
.lore-overview {
  margin-top: 16px;
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
.lore-match {
  font-size: 11px;
  margin-left: auto;
}
.lore-match.matched {
  color: var(--active);
}
.lore-match.orphan {
  color: var(--muted);
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
.events {
  padding-left: 20px;
}
.events li {
  margin-bottom: 6px;
  line-height: 1.6;
  font-size: 14px;
}
</style>