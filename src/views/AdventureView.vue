<script lang="ts">
// 模块级滚动位置：切换路由会销毁并重建 AdventureView，实例级变量会随之丢失，
// 因此必须放在模块作用域，才能在「切走→切回」时保留原位。
let savedAdventureScroll = 0
</script>

<script setup lang="ts">
import { computed, ref, watch, onMounted, onBeforeUnmount, onUnmounted, nextTick } from 'vue'
import { useAdventureStore } from '@/stores/adventure'
import { useWorldStore } from '@/stores/world'
import { useSettingsStore } from '@/stores/settings'
import { useMaStore, clockText } from '@/stores/multiagent'
import { PLAYER_ID, NARRATOR_ID } from '@/types'
import MaGuideModal from '@/components/MaGuideModal.vue'
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
const commandsOpen = ref(false) // 特殊指令折叠栏
// ===== 多智能体（仅 World.multiAgent === true 时生效）=====
const ma = useMaStore()
const isMultiAgent = computed(() => worldStore.currentWorld?.multiAgent === true)
// 开局面板里的模式选择：世界未锁定模式时用本次选择锁定（默认跟随世界当前设定）
const modeChoice = ref<'normal' | 'multi'>(isMultiAgent.value ? 'multi' : 'normal')
watch(
  () => worldStore.currentWorldId,
  () => {
    modeChoice.value = worldStore.currentWorld?.multiAgent === true ? 'multi' : 'normal'
  },
)
// 玩法说明弹窗：每个多智能体世界「开始冒险」时弹一次（localStorage 本地记忆，不写入剧情/上下文）
const showMaGuide = ref(false)
const maGuideKey = () => `dreams_ma_guide_seen_${worldStore.currentWorldId ?? ''}`
function maTryShowGuide() {
  if (!isMultiAgent.value) return
  const key = maGuideKey()
  if (!key || localStorage.getItem(key)) return
  localStorage.setItem(key, '1')
  showMaGuide.value = true
}
const maAutoAdvance = computed(() => ma.ma?.autoAdvance ?? settings.maAutoAdvance)
const maHeartbeat = computed(() => ma.ma?.heartbeatInterval ?? settings.maNarratorHeartbeat)
// 多智能体模式用消息流判断"是否已开始"，普通模式用页历史
const hasAnyAdventure = computed(() => (isMultiAgent.value ? ma.messages.length > 0 : adventure.hasAdventure))
const maClock = computed(() => (ma.ma ? clockText(ma.ma.clockDay, ma.ma.clockMinute) : ''))
// 世界加载完成 / 切换世界后，加载多智能体状态（onMounted 时 world 可能尚未就绪）
watch(
  () => [worldStore.currentWorldId, worldStore.currentWorld?.multiAgent === true] as const,
  async ([id, isMa]) => {
    if (id && isMa) {
      await ma.open(id)
      syncSceneValue()
    }
  },
  { immediate: true },
)
const maStream = ref<HTMLElement | null>(null)
watch(
  () => ma.messages.length,
  async () => {
    if (!isMultiAgent.value) return
    await nextTick()
    maStream.value?.scrollTo({ top: maStream.value.scrollHeight })
  },
)
function maSend() {
  if (ma.turnLoading) return
  const v = input.value.trim()
  input.value = ''
  void (async () => {
    // 发送前整体覆盖快照（含本次输入），供「重试」退回本轮
    await adventure.captureMaTurn(v)
    await ma.submit(v || undefined)
    await applyMaSavePatch()
    syncSceneValue()
  })()
}
// 每轮结束后应用旁白产生的存档变更（面板/背包/位置等）
async function applyMaSavePatch() {
  const p = ma.ma?.pendingSavePatch
  if (!p) return
  await ma.patchMa({ pendingSavePatch: null })
  await adventure.applyExternalSavePatch(p)
}
// 特殊指令：当前生效的禁令（多智能体存 maState，普通模式存 WorldState）
const activeBans = computed(() =>
  isMultiAgent.value ? (ma.ma?.bannedEvents ?? []) : (adventure.bannedEvents ?? []),
)
function removeBan(text: string) {
  if (isMultiAgent.value) void ma.removeBanned(text)
  else void adventure.removeBanEvent(text)
}

// 把当前场景值同步给多智能体（用于世界书精确匹配）
function syncSceneValue() {
  const w = worldStore.currentWorld
  const save = adventure.currentSave
  if (!w?.sceneField || !save) return
  const v = String(save.panel[w.sceneField] ?? '')
  if (v && v !== (ma.ma?.sceneValue ?? '')) void ma.patchMa({ sceneValue: v })
}
// 重试：整体退回本轮（与普通模式语义一致），输入填回输入框供修改
async function maRetry() {
  if (ma.turnLoading) return
  if (!window.confirm('退回本轮？本轮生成的剧情、角色记忆与状态都会被撤销；你的输入会填回输入框，可修改后再发送。')) return
  try {
    const restored = await adventure.retryMaTurn()
    if (restored !== null) input.value = restored
    syncSceneValue()
  } catch (e) {
    ma.error = e instanceof Error ? e.message : String(e)
  }
}
function maChoose(o: string) {
  input.value = o
  void nextTick(() => actionInputEl.value?.focus())
}
async function ensureMa() {
  const id = worldStore.currentWorldId
  if (id) await ma.open(id)
}
async function onMaAutoAdvanceInput(e: Event) {
  const n = Math.round(Number((e.target as HTMLInputElement).value))
  if (!Number.isFinite(n)) return
  await ensureMa()
  await ma.patchMa({ autoAdvance: Math.max(1, Math.min(10, n)) })
}
async function onMaHeartbeatInput(e: Event) {
  const n = Math.round(Number((e.target as HTMLInputElement).value))
  if (!Number.isFinite(n)) return
  await ensureMa()
  await ma.patchMa({ heartbeatInterval: Math.max(1, Math.min(10, n)) })
}
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
  isMultiAgent.value
    ? ''
    : adventure.hasAdventure
      ? `${adventure.currentIndex + 1} / ${adventure.totalPages}`
      : '',
)
const canPrev = computed(() => adventure.currentIndex > 0)
const canNext = computed(() => adventure.currentIndex < adventure.totalPages - 1)
const isLatest = computed(
  () => adventure.hasAdventure && adventure.currentIndex === adventure.totalPages - 1,
)

const readerBody = ref<HTMLElement | null>(null)
// 切换页面（如去看状态/世界书）再返回时保留原位置；仅翻页/生成新页才回顶部
let suppressScrollReset = true
function getScroller(): Element | null {
  return readerBody.value?.closest('.app-main') ?? document.scrollingElement
}
watch(currentPage, () => {
  if (suppressScrollReset) return
  const scroller = getScroller()
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

// 彩蛋 BGM 播放后的保护窗口：在此期间 triggerBgm 跳过场景 BGM，
// 避免 onMounted 先播彩蛋 BGM、随后 watch(currentScene) 立即用场景 BGM 覆盖
let eggBgmLockUntil = 0
function triggerBgm() {
  if (adventure.eggBgmPending) {
    const name = adventure.eggBgmPending
    adventure.eggBgmPending = null
    eggBgmLockUntil = Date.now() + 3000
    void playBgmByName(worldStore.currentWorld, name)
    return
  }
  if (Date.now() < eggBgmLockUntil) return
  if (adventure.hasAdventure) {
    void playSceneBgm(worldStore.currentWorld, currentScene.value)
  } else {
    void stopBgm()
  }
}


onMounted(async () => {
  if (isMultiAgent.value && worldStore.currentWorldId) {
    await ma.open(worldStore.currentWorldId)
  }
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
  // 从其他页面切回时恢复冒险页滚动位置（当前页未变，watcher 不会回顶部）
  // 但如果刚完成生成（loadingEndTime 在 3 秒内），则滚动到顶部显示最新内容
  suppressScrollReset = true
  await nextTick()
  const scroller = getScroller()
  const justFinishedLoading = adventure.loadingEndTime > 0 && Date.now() - adventure.loadingEndTime < 3000
  if (scroller && !justFinishedLoading && savedAdventureScroll > 0) {
    scroller.scrollTop = savedAdventureScroll
  } else if (scroller && justFinishedLoading) {
    scroller.scrollTop = 0
  }
  savedAdventureScroll = 0
  requestAnimationFrame(() => {
    suppressScrollReset = false
  })
})

onBeforeUnmount(() => {
  if (loadingTimer) clearInterval(loadingTimer)
  loadingTimer = null
  const scroller = getScroller()
  if (scroller) savedAdventureScroll = scroller.scrollTop
})

onUnmounted(() => {})



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
  const wid = worldStore.currentWorldId
  const world = worldStore.currentWorld
  // 首次开局：锁定所选模式到世界（已锁定的世界沿用当前模式不变）
  if (wid && world && world.multiAgent === undefined) {
    await worldStore.setWorldMode(wid, modeChoice.value === 'multi')
  }
  const isMulti = worldStore.currentWorld?.multiAgent === true
  const opts = {
    summarize: enhanceSummarize.value,
    expand: enhanceExpand.value,
  }
  if (isMulti) {
    maTryShowGuide()
    if (wid) await ma.open(wid)
    await adventure.startAdventure(startInput.value.trim(), opts, hiddenPreset.value)
    const page = adventure.currentPage
    if (wid && page) {
      await ma.seedOpening({
        worldId: wid,
        playerInput: startInput.value.trim(),
        narration: page.narration,
        playerProfile: adventure.currentSave?.characterProfile ?? startInput.value.trim(),
      })
    }
    return
  }
  await adventure.startAdventure(startInput.value.trim(), opts, hiddenPreset.value)
}

function prev() {
  if (canPrev.value) void adventure.setPage(adventure.currentIndex - 1)
}
function next() {
  if (canNext.value) void adventure.setPage(adventure.currentIndex + 1)
}
function goLatest() {
  void adventure.setPage(adventure.totalPages - 1)
}
// 点击行动选项：不再立即发送，而是复制到下方输入框，方便玩家修改后再发送
const actionInputEl = ref<HTMLTextAreaElement | null>(null)
function choose(option: string) {
  input.value = option
  void nextTick(() => {
    actionInputEl.value?.focus()
  })
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
          v-if="isMultiAgent && adventure.pendingMaTurn && !ma.turnLoading"
          class="rollback-btn"
          @click="maRetry"
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
    <div v-if="!hasAnyAdventure" class="start">
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
      <div class="mode-row">
        <template v-if="isMultiAgent">
          <span class="mode-check no-toggle">冒险模式：多智能体</span>
        </template>
        <template v-else>
          <label class="mode-check">
            <input type="radio" value="normal" v-model="modeChoice" />
            <span>普通模式</span>
          </label>
          <label class="mode-check">
            <input type="radio" value="multi" v-model="modeChoice" />
            <span>多智能体模式</span>
          </label>
        </template>
      </div>
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
      <!-- 多智能体模式：消息流 -->
      <template v-if="isMultiAgent">
        <div class="ma-head">
          <span class="ma-clock">{{ maClock }}</span>
          <span v-if="ma.beatsTotal > 1" class="ma-beats">自动 {{ ma.beatsDone }}/{{ ma.beatsTotal }}</span>
        </div>
        <div ref="maStream" class="ma-stream">
          <p v-if="ma.messages.length === 0" class="ma-empty">发送第一句话，故事就开始了。</p>
          <div
            v-for="m in ma.messages"
            :key="m.id"
            class="ma-msg"
            :class="{ self: m.speakerId === PLAYER_ID, narrator: m.speakerId === NARRATOR_ID }"
          >
            <div class="ma-speaker">
              {{ m.speakerName }}
              <span v-if="settings.maGodView && !m.knows.includes(PLAYER_ID)" class="ma-blind">你的角色不知情</span>
            </div>
            <div class="ma-text">{{ m.text }}</div>
          </div>
          <div v-if="ma.turnLoading" class="ma-thinking">
            推进中 {{ ma.beatsDone }}/{{ ma.beatsTotal || 1 }}…
          </div>
        </div>
        <div v-if="settings.maGodView && (ma.ma?.secrets.length ?? 0) > 0" class="ma-secrets">
          <p class="ma-secrets-title">旁白的伏笔（{{ ma.ma?.secrets.length }}）</p>
          <p v-for="s in ma.ma?.secrets ?? []" :key="s.id" class="ma-secret">
            · {{ s.text }}<span v-if="s.expiresAtDay">（第 {{ s.expiresAtDay }} 天后过期）</span>
          </p>
        </div>
        <div class="ma-controls">
          <div v-if="ma.pendingPlayer" class="ma-waiting">大家都在等你。</div>
          <button
            v-for="(o, i) in ma.currentOptions"
            :key="i"
            class="option"
            :disabled="ma.turnLoading"
            @click="maChoose(o)"
          >
            {{ o }}
          </button>
          <div class="input-row">
            <textarea
              ref="actionInputEl"
              v-model="input"
              class="input"
              rows="3"
              placeholder="说点什么，或描述你的行动…（Ctrl+Enter 发送）"
              :disabled="ma.turnLoading"
              @keydown.ctrl.enter.prevent="maSend"
              @keydown.meta.enter.prevent="maSend"
            />
            <button class="send" :disabled="ma.turnLoading" @click="maSend">
              {{ input.trim() ? '发送' : '继续' }}
            </button>
          </div>
          <p class="ma-hint">空着发送 = 让场景继续。轮到你的角色时可以自由插话。</p>
          <div v-if="ma.error" class="error-row">
            <span class="error">⚠ {{ ma.error }}</span>
          </div>
        </div>
      </template>

      <!-- 普通模式：分页阅读 -->
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
              <span class="setting-label">游戏难度调整</span>
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
            <template v-if="isMultiAgent">
              <div class="setting-row">
                <span class="setting-label">自动推进</span>
                <input
                  type="range"
                  class="difficulty-range"
                  min="1"
                  max="10"
                  step="1"
                  :value="maAutoAdvance"
                  @input="onMaAutoAdvanceInput"
                />
                <span class="difficulty-value">{{ maAutoAdvance }} 拍</span>
              </div>
              <div class="setting-row">
                <span class="setting-label">旁白心跳</span>
                <input
                  type="range"
                  class="difficulty-range"
                  min="1"
                  max="10"
                  step="1"
                  :value="maHeartbeat"
                  @input="onMaHeartbeatInput"
                />
                <span class="difficulty-value">{{ maHeartbeat }} 拍</span>
              </div>
              <div class="setting-hint">
                自动推进：每轮最多连续推进几拍（1 = 每次都由你发送）；轮到你的角色时立即暂停并重新计数。
                旁白心跳：连续多少拍没有旁白就强制插入一次，避免场景与伏笔过时。
              </div>
              <label class="setting-row">
                <span class="setting-label">上帝视角</span>
                <input
                  type="checkbox"
                  :checked="settings.maGodView"
                  @change="settings.setMaGodView(($event.target as HTMLInputElement).checked)"
                />
              </label>
              <div v-if="settings.maGodView" class="setting-hint">
                标出你的角色不知情的消息，并显示旁白的伏笔清单。仅供复盘与排查，不影响剧情推进。
              </div>
            </template>
            <div class="commands-help">
              <button class="settings-toggle" @click="commandsOpen = !commandsOpen">
                <span>特殊指令</span>
                <span class="settings-arrow">{{ commandsOpen ? '▾' : '▸' }}</span>
              </button>
              <template v-if="commandsOpen">
                <p class="setting-hint">在输入框里写指令，可与其他文字混用；指令本身不会进入剧情。</p>
                <ul class="cmd-list">
                  <li><code>（指令：终止事件，旧城门的火灾）</code>不再提及该事件并清理相关记录（10 回合）</li>
                  <li><code>（指令：跳过，打斗过程）</code>用一句话带过，不展开</li>
                  <li><code>（指令：换场，第二天清晨的城门口）</code>直接跳到下一个场景</li>
                  <li><code>（指令：回顾，与铁匠的约定）</code>先简要回顾已知信息</li>
                </ul>
                <p class="setting-hint">括号与冒号全角/半角均可；只有带「指令：」前缀才会生效。</p>
                <div v-if="activeBans.length" class="ban-list">
                  <p class="ban-title">生效中的禁令</p>
                  <div v-for="b in activeBans" :key="b.text" class="ban-item">
                    <span>{{ b.text }}（剩 {{ b.roundsLeft }} 回合）</span>
                    <button class="ban-remove" @click="removeBan(b.text)">解除</button>
                  </div>
                </div>
              </template>
            </div>
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
            ref="actionInputEl"
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
    </template>

    <div v-if="bgmMissing" class="bgm-missing-row">
      <span class="bgm-missing">⚠ 该世界的背景音乐未加载（旧版本导入所致）。请在「世界」页重新导入 DLC，选择「更新现有世界」即可修复。</span>
    </div>
    <div v-if="adventure.error" class="error-row">
      <span class="error">⚠ {{ adventure.error }}</span>
      <button class="retry-btn" @click="adventure.retry()">重试</button>
    </div>

    <!-- 多智能体玩法说明（只在开始时弹一次，非剧情内容） -->
    <MaGuideModal v-if="showMaGuide" @close="showMaGuide = false" />

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
.mode-row {
  display: flex;
  gap: 16px;
  margin: 12px 0 4px;
  font-size: 13px;
}
.mode-check {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted);
  cursor: pointer;
}
.mode-check.no-toggle {
  color: var(--muted);
  cursor: default;
}
.mode-check input {
  accent-color: var(--yellow);
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
.ma-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 2px 2px 8px;
  font-size: 12px;
  color: var(--muted);
}
.ma-stream {
  max-height: 60vh;
  overflow-y: auto;
  padding: 6px 2px;
  min-height: 120px;
}
.ma-empty {
  color: var(--muted);
  text-align: center;
  padding: 28px 0;
  font-size: 13px;
}
.ma-msg {
  margin-bottom: 14px;
  max-width: 94%;
}
.ma-msg.self {
  margin-left: auto;
  text-align: right;
}
.ma-speaker {
  font-size: 12px;
  color: var(--muted);
  margin-bottom: 3px;
}
.ma-text {
  font-size: var(--font-size-narration, 16px);
  line-height: 1.7;
  white-space: pre-wrap;
}
.ma-msg.narrator .ma-text {
  color: #b9b3a3;
}
.ma-msg.self .ma-text {
  color: #d9d2c0;
}
.ma-thinking {
  color: var(--muted);
  font-size: 13px;
  padding: 6px 0;
}
.ma-controls {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}
.ma-waiting {
  font-size: 12px;
  color: #c9a227;
}
.cmd-list {
  margin: 6px 0 4px;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.8;
  color: var(--muted);
}
.cmd-list code {
  color: #c9a227;
  font-size: 12px;
}
.ban-list {
  margin-top: 8px;
  font-size: 12px;
}
.ban-title {
  color: var(--muted);
  margin-bottom: 4px;
}
.ban-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
}
.ban-remove {
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  color: var(--muted);
  font-size: 11px;
  padding: 1px 8px;
  cursor: pointer;
}
.ma-blind {
  margin-left: 6px;
  font-size: 10px;
  color: #b07b7b;
  border: 1px solid rgba(200, 120, 120, 0.35);
  border-radius: 4px;
  padding: 0 4px;
}
.ma-secrets {
  border: 1px dashed rgba(255, 255, 255, 0.16);
  border-radius: 8px;
  padding: 8px 10px;
  margin-top: 8px;
  font-size: 12px;
  color: var(--muted);
}
.ma-secrets-title {
  color: #b07b7b;
  margin-bottom: 4px;
}
.ma-secret {
  line-height: 1.6;
}
.ma-hint {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
}
.reader {
  display: flex;
  flex: 1;
  min-height: 0;
}.nav {
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
  font-size: var(--font-size-narration, 16px);
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

</style>