<script setup lang="ts">
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { useAdventureStore } from '@/stores/adventure'
import { useWorldStore } from '@/stores/world'
import { useSettingsStore } from '@/stores/settings'
import { playSceneBgm, playBgmByName, stopBgm, setBgmMuted } from '@/audio/bgm'

const adventure = useAdventureStore()
const worldStore = useWorldStore()
const settings = useSettingsStore()

const startInput = ref('')
const input = computed({
  get: () => adventure.draftInput,
  set: (v) => {
    adventure.draftInput = v
  },
})
const enhanceSummarize = ref(true) // 总结优化已有设定
const enhanceExpand = ref(true) // 补充更多合理设定

const adventureSettingsOpen = ref(false) // 冒险设置折叠栏
const difficultyOrder = ['easy', 'normal', 'hard', 'nightmare'] as const
const difficultyLabels = ['简单', '正常', '困难', '噩梦']
const difficultyIndex = computed(() => {
  const i = difficultyOrder.indexOf(settings.difficulty)
  return i >= 0 ? i : 1
})
function onDifficultyInput(e: Event) {
  const i = Number((e.target as HTMLInputElement).value)
  void settings.setDifficulty(difficultyOrder[i] ?? 'normal')
}

const narrativeSpeedOrder = ['fine', 'normal', 'fast', 'rapid'] as const
const narrativeSpeedLabels = ['精细', '正常', '快速', '极速']
const narrativeSpeedIndex = computed(() => {
  const i = narrativeSpeedOrder.indexOf(settings.narrativeSpeed)
  return i >= 0 ? i : 1
})
function onNarrativeSpeedInput(e: Event) {
  const i = Number((e.target as HTMLInputElement).value)
  void settings.setNarrativeSpeed(narrativeSpeedOrder[i] ?? 'normal')
}

const eventFreqOrder = ['none', 'normal', 'frequent', 'doom'] as const
const eventFreqLabels = ['无', '正常', '频繁', '厄运']
const eventFreqIndex = computed(() => {
  const i = eventFreqOrder.indexOf(settings.eventFrequency)
  return i >= 0 ? i : 1
})
function onEventFreqInput(e: Event) {
  const i = Number((e.target as HTMLInputElement).value)
  void settings.setEventFrequency(eventFreqOrder[i] ?? 'normal')
}

const narrativeDetailOrder = ['brief', 'normal', 'detailed', 'extreme'] as const
const narrativeDetailLabels = ['简洁', '常规', '精细', '极致']
const narrativeDetailIndex = computed(() => {
  const i = narrativeDetailOrder.indexOf(settings.narrativeDetail)
  return i >= 0 ? i : 1
})
function onNarrativeDetailInput(e: Event) {
  const i = Number((e.target as HTMLInputElement).value)
  void settings.setNarrativeDetail(narrativeDetailOrder[i] ?? 'normal')
}


// 允许改写：双击最新页内容可编辑，行动前 AI 先同步改写内容
const editingPage = ref(false)
const editText = ref('')
function startRewrite() {
  const p = adventure.currentPage
  if (!p || !settings.allowRewrite || !isLatest.value || editingPage.value) return
  editText.value = p.narration
  editingPage.value = true
}
function cancelRewrite() {
  editingPage.value = false
  editText.value = ''
}
async function saveRewrite() {
  const p = adventure.currentPage
  if (!p) return
  await adventure.rewritePage(adventure.currentIndex, editText.value)
  editingPage.value = false
  editText.value = ''
}

const worldName = computed(() => worldStore.currentWorld?.name ?? '未选择世界')
const currentPage = computed(() => adventure.currentPage)
const pageIndicator = computed(() =>
  adventure.hasAdventure ? `${adventure.currentIndex + 1} / ${adventure.pages.length}` : '',
)
const canPrev = computed(() => adventure.currentIndex > 0)
const canNext = computed(() => adventure.currentIndex < adventure.pages.length - 1)
const isLatest = computed(
  () => adventure.hasAdventure && adventure.currentIndex === adventure.pages.length - 1,
)

const readerBody = ref<HTMLElement | null>(null)
watch(currentPage, () => {
  const scroller = readerBody.value?.closest('.app-main') ?? document.scrollingElement
  if (scroller) scroller.scrollTop = 0
}, { flush: 'post' })

const loadingSeconds = ref(0)
let loadingTimer: ReturnType<typeof setInterval> | null = null
watch(
  () => adventure.loading,
  (v) => {
    if (v) {
      loadingSeconds.value = 0
      loadingTimer = setInterval(() => {
        loadingSeconds.value++
      }, 1000)
    } else {
      if (loadingTimer) clearInterval(loadingTimer)
      loadingTimer = null
    }
  },
)

const worldSettingLen = computed(() => worldStore.currentWorld?.worldSetting?.length ?? 0)
const isLongSetting = computed(() => worldSettingLen.value > 5000)

const currentScene = computed(() => {
  const world = worldStore.currentWorld
  if (!world || !world.sceneField || !adventure.currentSave) return undefined
  const v = adventure.currentSave.panel[world.sceneField]
  return typeof v === 'string' ? v : v != null ? String(v) : undefined
})

// DLC 世界的 BGM 映射为空（通常是旧版本导入所致），提示用户重新导入 DLC
const bgmMissing = computed(() => {
  const w = worldStore.currentWorld
  return !!(w?.dlcId && w.bgm && Object.keys(w.bgm).length === 0)
})

const presetCharacters = computed(() => worldStore.currentWorld?.presetCharacters ?? [])
const selectedPreset = ref('')
const hiddenPreset = ref<string | undefined>(undefined)
function applyPreset() {
  const key = selectedPreset.value
  if (!key) {
    hiddenPreset.value = undefined
    return
  }
  const p = presetCharacters.value.find((c) => c.label === key)
  if (p) {
    startInput.value = p.description
    hiddenPreset.value = p.hidden
  }
}

function triggerBgm() {
  if (adventure.eggBgmPending) {
    const name = adventure.eggBgmPending
    adventure.eggBgmPending = null
    void playBgmByName(worldStore.currentWorld, name)
    return
  }
  if (adventure.hasAdventure) {
    void playSceneBgm(worldStore.currentWorld, currentScene.value)
  } else {
    void stopBgm()
  }
}


onMounted(() => {
  void setBgmMuted(settings.muted)
  triggerBgm()
  // 恢复被后台中断的 startAdventure 输入
  if (!adventure.hasAdventure && adventure.lastInput && adventure.lastMode === 'start' && adventure.error) {
    startInput.value = adventure.lastInput
    if (adventure.lastStartOpts) {
      enhanceSummarize.value = adventure.lastStartOpts.summarize ?? true
      enhanceExpand.value = adventure.lastStartOpts.expand ?? true
    }
  }
})

onUnmounted(() => {
  if (loadingTimer) clearInterval(loadingTimer)
  loadingTimer = null
})



watch(currentScene, () => triggerBgm())

async function toggleMute() {
  const next = !settings.muted
  await settings.setBgmMuted(next)
  await setBgmMuted(next)
}

async function begin() {
  if (!startInput.value.trim()) return
  if (!settings.hasKey || !settings.config.baseUrl || !settings.config.model) {
    adventure.error = '请先在「我的」页面完成 API 配置'
    return
  }
  await adventure.startAdventure(startInput.value.trim(), {
    summarize: enhanceSummarize.value,
    expand: enhanceExpand.value,
  }, hiddenPreset.value)
}

function prev() {
  if (canPrev.value) adventure.setPage(adventure.currentIndex - 1)
}
function next() {
  if (canNext.value) adventure.setPage(adventure.currentIndex + 1)
}
function goLatest() {
  adventure.setPage(adventure.pages.length - 1)
}
function choose(option: string) {
  adventure.takeAction(option)
}
async function submit() {
  if (adventure.loading) return
  const v = input.value.trim()
  if (!v) return
  input.value = ''
  await adventure.takeAction(v)
}
async function rollback() {
  if (!adventure.pendingRetry || adventure.loading) return
  if (!window.confirm('回退到上一步并撤销本次输出？你可以修改输入后再继续。')) return
  const restored = await adventure.rollbackLast()
  if (restored) {
    input.value = restored
  }
}
</script>

<template>
  <div class="page">
    <header class="header">

      <span class="world-name">{{ worldName }}</span>
      <div class="header-right">
        <button
          v-if="adventure.pendingRetry"
          class="rollback-btn"
          :disabled="adventure.loading"
          @click="rollback"
        >
          重试
        </button>
        <button
          v-if="worldStore.currentWorld?.dlcId"
          class="mute-btn"
          :class="{ muted: settings.muted }"
          @click="toggleMute"
        >
          {{ settings.muted ? '🔇' : '🔊' }}
        </button>
        <span class="page-indicator">{{ pageIndicator }}</span>
      </div>
    </header>

    <!-- 未开始冒险 -->
    <div v-if="!adventure.hasAdventure" class="start">
      <h2>开始你的冒险</h2>
      <p class="start-tip">请描述你想扮演的角色，AI 会为你整理角色设定并拉开序幕</p>
      <textarea
        v-model="startInput"
        class="textarea"
        rows="5"
        placeholder="例如：一个落魄的流浪剑客，背负着未了的心愿，踏入这座陌生的城市…"
      />
      <label v-if="presetCharacters.length" class="preset-select-row">
        <span class="preset-label">或选择预设角色</span>
        <select v-model="selectedPreset" class="preset-select" @change="applyPreset">
          <option value="">（自定义）</option>
          <option v-for="c in presetCharacters" :key="c.label" :value="c.label">{{ c.label }}</option>
        </select>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" v-model="enhanceSummarize" />
        <span>总结优化已有设定</span>
      </label>
      <label class="checkbox-row">
        <input type="checkbox" v-model="enhanceExpand" />
        <span>补充更多合理设定</span>
      </label>
      <p class="desc-hint">两者都不勾选：仅按输入忠实整理，不额外编造</p>
      <button class="start-btn" :disabled="adventure.loading || !startInput.trim()" @click="begin">
        {{ adventure.loading ? '正在生成…' : '开始冒险' }}
      </button>
    </div>

    <!-- 冒险中 -->
    <template v-else>
      <div class="reader">
        <button class="nav prev" :disabled="!canPrev" @click="prev">‹</button>
        <div ref="readerBody" class="reader-body">
          <div v-if="currentPage" class="ai-notice">内容由AI生成，仅供参考</div>
          <div v-if="currentPage" class="player-input">你的行动：{{ currentPage.playerInput }}</div>
          <div class="narration" @dblclick="startRewrite">
            <template v-if="editingPage">
              <textarea
                v-model="editText"
                class="rewrite-input"
                rows="10"
                placeholder="修改本页内容…（Ctrl+Enter 完成 / Esc 取消）"
                @keydown.esc.prevent="cancelRewrite"
                @keydown.ctrl.enter.prevent="saveRewrite"
                @keydown.meta.enter.prevent="saveRewrite"
              ></textarea>
              <div class="rewrite-btns">
                <button class="rewrite-save" @click="saveRewrite">完成</button>
                <button class="rewrite-cancel" @click="cancelRewrite">取消</button>
              </div>
            </template>
            <template v-else>
              <span>{{ currentPage?.narration }}</span>
              <div v-if="isLatest && settings.allowRewrite" class="rewrite-hint">双击本页内容可编辑改写</div>
            </template>
          </div>
        </div>
        <button class="nav next" :disabled="!canNext" @click="next">›</button>
      </div>

      <div v-if="isLatest" class="controls">
        <div class="adventure-settings">
          <button class="settings-toggle" @click="adventureSettingsOpen = !adventureSettingsOpen">
            <span>冒险设置</span>
            <span class="settings-arrow">{{ adventureSettingsOpen ? '▾' : '▸' }}</span>
          </button>
          <template v-if="adventureSettingsOpen">
            <div class="setting-row">
              <span class="setting-label">叙事推进速度</span>
              <input
                type="range"
                class="difficulty-range"
                min="0"
                max="3"
                step="1"
                :value="narrativeSpeedIndex"
                @input="onNarrativeSpeedInput"
              />
              <span class="difficulty-value">{{ narrativeSpeedLabels[narrativeSpeedIndex] }}</span>
            </div>
            <div class="setting-row">
              <span class="setting-label">突发事件频率</span>
              <input
                type="range"
                class="difficulty-range"
                min="0"
                max="3"
                step="1"
                :value="eventFreqIndex"
                @input="onEventFreqInput"
              />
              <span class="difficulty-value">{{ eventFreqLabels[eventFreqIndex] }}</span>
            </div>
            <div class="setting-row">
              <span class="setting-label">描写细致程度</span>
              <input
                type="range"
                class="difficulty-range"
                min="0"
                max="3"
                step="1"
                :value="narrativeDetailIndex"
                @input="onNarrativeDetailInput"
              />
              <span class="difficulty-value">{{ narrativeDetailLabels[narrativeDetailIndex] }}</span>
            </div>
            <div v-if="narrativeDetailIndex >= 2" class="setting-hint">
              建议选择较大的允许模型输出的文本长度
            </div>
            <div class="setting-row">
              <span class="setting-label">游戏难度</span>
              <input
                type="range"
                class="difficulty-range"
                min="0"
                max="3"
                step="1"
                :value="difficultyIndex"
                @input="onDifficultyInput"
              />
              <span class="difficulty-value">{{ difficultyLabels[difficultyIndex] }}</span>
            </div>
            <label class="setting-row">
              <span class="setting-label">允许改写</span>
              <input
                type="checkbox"
                :checked="settings.allowRewrite"
                @change="settings.setAllowRewrite(($event.target as HTMLInputElement).checked)"
              />
            </label>
          </template>
        </div>
        <button
          v-for="(o, i) in currentPage?.options ?? []"
          :key="i"
          class="option"
          :disabled="adventure.loading"
          @click="choose(o)"
        >
          {{ o }}
        </button>
        <div class="input-row">
          <textarea
            v-model="input"
            class="input"
            rows="3"
            placeholder="或输入你自己的行动…（Ctrl+Enter 发送）"
            :disabled="adventure.loading"
            @keydown.ctrl.enter.prevent="submit"
            @keydown.meta.enter.prevent="submit"
          />
          <button class="send" :disabled="adventure.loading || !input.trim()" @click="submit">
            发送
          </button>
        </div>
      </div>
      <button v-else class="to-latest" @click="goLatest">回到最新 →</button>
    </template>

    <div v-if="bgmMissing" class="bgm-missing-row">
      <span class="bgm-missing">⚠ 该世界的背景音乐未加载（旧版本导入所致）。请在「世界」页重新导入 DLC，选择「更新现有世界」即可修复。</span>
    </div>
    <div v-if="adventure.error" class="error-row">
      <span class="error">⚠ {{ adventure.error }}</span>
      <button class="retry-btn" @click="adventure.retry()">重试</button>
    </div>

    <div v-if="adventure.loading && adventure.hasAdventure" class="loading-mask">
      <div class="loading-box">
        <span>正在生成…</span>
        <span v-if="loadingSeconds >= 1" class="loading-elapsed">已等待 {{ loadingSeconds }} 秒</span>
        <span v-if="isLongSetting" class="loading-hint">设定较长，首次生成可能需要更久，请耐心等待</span>
        <span v-if="adventure.recoveryNote" class="loading-hint">{{ adventure.recoveryNote }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 16px;
  min-height: 100%;
  display: flex;
  flex-direction: column;
}
.header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 14px;
}
.header-right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.rollback-btn {
  background: transparent;
  color: var(--active);
  border: 1px solid var(--active);
  border-radius: 8px;
  padding: 4px 12px;
  font-size: 13px;
}
.rollback-btn:disabled {
  opacity: 0.5;
}
.mute-btn {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 4px 10px;
  font-size: 16px;
  line-height: 1;
}
.mute-btn.muted {
  opacity: 0.5;
}
.world-name {
  font-size: 16px;
  font-weight: 700;
}
.page-indicator {
  color: var(--muted);
  font-size: 13px;
}
.start {
  flex: 1;
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 14px;
  padding-bottom: 40px;
}
.start h2 {
  font-size: 20px;
}
.start-tip {
  color: var(--muted);
  line-height: 1.6;
}
.textarea {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  resize: none;
  line-height: 1.6;
}
.start-btn {
  background: var(--yellow);
  color: #000;
  font-weight: 700;
  padding: 14px;
  border-radius: 10px;
  font-size: 16px;
}
.start-btn:disabled {
  opacity: 0.4;
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}
.checkbox-row input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.desc-hint {
  color: var(--muted);
  font-size: 11px;
  margin: 4px 0 8px;
  opacity: 0.8;
}
.preset-select-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 4px 0;
}
.preset-label {
  color: var(--muted);
  font-size: 13px;
  flex: none;
}
.preset-select {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 8px 10px;
  font-size: 14px;
}
.reader {
  display: flex;
  flex: 1;
  min-height: 0;
}
.nav {
  position: fixed;
  top: 50%;
  transform: translateY(-50%);
  z-index: 60;
  width: 34px;
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--surface);
  color: var(--text);
  border: 1px solid var(--border);
  border-radius: 18px;
  font-size: 22px;
  padding: 0;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.25);
  opacity: 0.9;
}
.nav.prev {
  left: 6px;
}
.nav.next {
  right: 6px;
}
.nav:disabled {
  opacity: 0.2;
}
.reader-body {
  flex: 1;
  min-width: 0;
  padding: 0 42px;
}
.ai-notice {
  color: var(--muted);
  font-size: 11px;
  margin-bottom: 6px;
  opacity: 0.6;
  line-height: 1.4;
}
.player-input {
  color: var(--active);
  font-size: 13px;
  margin-bottom: 10px;
  line-height: 1.5;
}
.rewrite-hint {
  color: var(--muted);
  font-size: 11px;
  margin-top: 8px;
  text-align: center;
  opacity: 0.7;
}
.rewrite-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
  resize: vertical;
  box-sizing: border-box;
}
.rewrite-btns {
  display: flex;
  gap: 8px;
  margin-top: 8px;
  justify-content: flex-end;
}
.rewrite-save {
  background: var(--active);
  color: #fff;
  border: none;
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.rewrite-cancel {
  background: var(--surface-2);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
}
.narration {
  font-size: 16px;
  line-height: 1.9;
  white-space: pre-wrap;
}
.controls {
  margin-top: 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-bottom: 8px;
}
.adventure-settings {
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
}
.settings-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: var(--surface);
  border: none;
  color: var(--text);
  padding: 12px 14px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
}
.settings-arrow {
  color: var(--muted);
  font-size: 13px;
}
.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: var(--surface-2);
  cursor: pointer;
}
.setting-label {
  font-size: 13px;
  color: var(--text);
}
.setting-row input[type='checkbox'] {
  width: 16px;
  height: 16px;
  cursor: pointer;
  flex: none;
}
.difficulty-range {
  flex: 1;
  min-width: 0;
  accent-color: var(--active);
}
.difficulty-value {
  flex: none;
  font-size: 13px;
  color: var(--active);
  font-weight: 600;
  min-width: 44px;
  text-align: right;
}
.setting-hint {
  font-size: 12px;
  color: var(--muted);
  padding-left: 8px;
  margin-top: -4px;
  margin-bottom: 4px;
  line-height: 1.5;
}
.option {
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 10px;
  padding: 13px 16px;
  font-size: 15px;
  line-height: 1.5;
}
.option:disabled {
  opacity: 0.5;
}
.input-row {
  display: flex;
  gap: 8px;
  align-items: flex-end;
}
.input {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  resize: vertical;
  line-height: 1.6;
  font-size: 15px;
  min-height: 60px;
}
.send {
  flex: none;
  background: var(--active);
  color: #fff;
  border-radius: 10px;
  padding: 0 18px;
  font-weight: 600;
}
.send:disabled {
  opacity: 0.4;
}
.to-latest {
  margin-top: 20px;
  background: var(--surface);
  color: var(--active);
  border: 1px solid var(--active);
  border-radius: 10px;
  padding: 12px;
  font-size: 15px;
}
.error-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
}
.bgm-missing-row {
  margin-top: 12px;
}
.bgm-missing {
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
}
.error {
  color: var(--danger);
  font-size: 13px;
  line-height: 1.5;
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
}
.retry-btn {
  flex: none;
  background: var(--danger);
  color: #fff;
  font-weight: 600;
  border-radius: 8px;
  padding: 6px 16px;
  font-size: 13px;
}
.loading-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
}
.loading-box {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 20px 32px;
  font-size: 15px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  text-align: center;
}
.loading-elapsed {
  color: var(--muted);
  font-size: 13px;
}
.loading-hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  max-width: 240px;
}
</style>