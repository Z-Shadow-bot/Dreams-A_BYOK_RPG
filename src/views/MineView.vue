<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { getLogText, clearLog } from '@/utils/logger'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { getStorageInfo, requestPersistentStorage, isStoragePersisted, formatBytes } from '@/utils/storage'
import type { StorageInfo } from '@/utils/storage'
import { createId } from '@/types'

const settings = useSettingsStore()

const isWeb = !Capacitor.isNativePlatform()

const form = reactive({
  baseUrl: '',
  model: '',
  extraHeadersText: '{}',
  temperature: 0.8,
  maxWaitTime: 180,
  narrationMin: 200,
  narrationMax: 500,
})

const isWideTemp = computed(
  () =>
    /openai|gpt|deepseek/i.test(form.baseUrl.toLowerCase()) ||
    /openai|gpt|deepseek/i.test(form.model.toLowerCase()),
)

const temperatureHint = computed(() =>
  isWideTemp.value
    ? '0~2，温度越低越严谨保守，温度越高越创新随机'
    : '0~1，温度越低越严谨保守，温度越高越创新随机',
)
const apiKey = ref('')
const saved = ref(false)
const error = ref('')
const devMode = ref(false)

// 折叠栏状态
const apiConfigOpen = ref(false)
const genSettingsOpen = ref(false)
const contextSettingsOpen = ref(false)

interface ModelPreset {
  provider: string
  model: string
  baseUrl: string
}

const MODEL_PRESETS: ModelPreset[] = [
  { provider: 'DeepSeek', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com' },
  { provider: 'DeepSeek', model: 'deepseek-v4-pro', baseUrl: 'https://api.deepseek.com' },
  { provider: 'OpenAI', model: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
  { provider: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  { provider: '通义千问', model: 'qwen-plus', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: '通义千问', model: 'qwen-turbo', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  { provider: '智谱 GLM', model: 'glm-4-plus', baseUrl: 'https://open.bigmodel.cn/api/paas/v4' },
  { provider: '月之暗面 Kimi', model: 'moonshot-v1-8k', baseUrl: 'https://api.moonshot.cn/v1' },
  { provider: '字节豆包', model: 'doubao-pro-32k', baseUrl: 'https://ark.cn-beijing.volces.com/api/v3' },
]

function onModelChange() {
  const preset = MODEL_PRESETS.find((p) => p.model === form.model.trim())
  if (preset) {
    form.baseUrl = preset.baseUrl
  }
}

function toggleDevMode() {
  settings.setDevMode(devMode.value)
}

// ===== 我的 API：多配置保存与快速切换 =====
const myApiList = computed(() => settings.apiProfiles)
const activeProfileId = computed(
  () =>
    settings.apiProfiles.find(
      (p) => p.baseUrl === settings.config.baseUrl && p.model === settings.config.model,
    )?.id ?? '',
)

async function switchProfile(id: string) {
  await settings.switchApiProfile(id)
  form.baseUrl = settings.config.baseUrl
  form.model = settings.config.model
  form.extraHeadersText = JSON.stringify(settings.config.extraHeaders ?? {}, null, 2)
  form.temperature = settings.config.temperature
  form.maxWaitTime = settings.config.maxWaitTime ?? 180
  form.narrationMin = settings.config.narrationMin ?? 200
  form.narrationMax = settings.config.narrationMax ?? 500
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}

async function saveAsProfile() {
  error.value = ''
  let headers: Record<string, string> = {}
  try {
    const parsed = form.extraHeadersText.trim() ? JSON.parse(form.extraHeadersText) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      error.value = '额外请求头必须是合法的 JSON 对象'
      return
    }
    headers = parsed as Record<string, string>
  } catch {
    error.value = '额外请求头必须是合法的 JSON 对象'
    return
  }
  if (!form.model.trim() || !form.baseUrl.trim()) {
    error.value = '请填写模型名称和 API 地址'
    return
  }
  const temperature = Number(form.temperature)
  const maxWaitTime = Number(form.maxWaitTime)
  const narrationMin = Number(form.narrationMin)
  const narrationMax = Number(form.narrationMax)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    error.value = '温度需在 0 ~ 2 之间'
    return
  }
  if (!Number.isFinite(maxWaitTime) || maxWaitTime < 10) {
    error.value = '最大等待时间需不小于 10 秒'
    return
  }
  if (!Number.isFinite(narrationMin) || narrationMin < 50) {
    error.value = '每轮叙事字数下限需不小于 50'
    return
  }
  if (!Number.isFinite(narrationMax) || narrationMax > 5000) {
    error.value = '每轮叙事字数上限需不大于 5000'
    return
  }
  if (narrationMin > narrationMax) {
    error.value = '每轮叙事字数下限不能大于上限'
    return
  }
  const existing = settings.apiProfiles.find(
    (p) => p.baseUrl === form.baseUrl.trim() && p.model === form.model.trim(),
  )
  const defaultName = form.model.trim() || '我的 API'
  const name = window.prompt(
    existing ? '该模型配置已在列表中，可修改名称以便区分，或直接确定' : '为这个 API 配置起一个名字（用于列表显示）',
    existing?.name ?? defaultName,
  )
  if (name === null) return
  await settings.saveApiProfile(
    {
      id: existing?.id ?? createId(),
      name: name.trim() || defaultName,
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      extraHeaders: headers,
      temperature,
      maxWaitTime,
      narrationMin,
      narrationMax,
    },
    apiKey.value,
  )
  apiKey.value = ''
  saved.value = true
  setTimeout(() => (saved.value = false), 2000)
}

async function removeProfile(id: string, name: string) {
  if (!window.confirm(`删除「${name}」？该配置保存的 API Key 也会一并移除。`)) return
  await settings.removeApiProfile(id)
}


// 生成设置：narrationMin/Max/maxWaitTime 随 API 配置保存，optionCount 独立保存
async function onGenSettingsChange() {
  const narrationMin = Number(form.narrationMin)
  const narrationMax = Number(form.narrationMax)
  const maxWaitTime = Number(form.maxWaitTime)
  if (
    Number.isFinite(narrationMin) && narrationMin >= 50 &&
    Number.isFinite(narrationMax) && narrationMax <= 5000 &&
    Number.isFinite(maxWaitTime) && maxWaitTime >= 10 &&
    narrationMin <= narrationMax
  ) {
    await settings.saveConfig({
      ...settings.config,
      narrationMin,
      narrationMax,
      maxWaitTime,
    })
  }
}

function onOptionCountInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n) && n >= 0) settings.setOptionCount(Math.floor(n))
}

// 上下文设置
function onLoreLimitInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n) && n >= 0) settings.setLoreLimit(Math.floor(n))
}
function onLoreBudgetInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n) && n > 0) settings.setLoreBudget(Math.floor(n))
}
function onLinkBudgetInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n) && n >= 0) settings.setLinkBudget(Math.floor(n))
}
function onWorldSettingMaxInput(e: Event) {
  const n = Number((e.target as HTMLInputElement).value)
  if (Number.isFinite(n) && n > 0) settings.setWorldSettingMax(Math.floor(n))
}

onMounted(async () => {
  if (!settings.loaded) {
    await settings.load()
  }
  form.baseUrl = settings.config.baseUrl
  form.model = settings.config.model
  form.extraHeadersText = JSON.stringify(settings.config.extraHeaders ?? {}, null, 2)
  form.temperature = settings.config.temperature

  form.maxWaitTime = settings.config.maxWaitTime ?? 180
  form.narrationMin = settings.config.narrationMin ?? 200
  form.narrationMax = settings.config.narrationMax ?? 500
  devMode.value = settings.devMode

  // PWA 端：申请持久化存储并展示用量，降低浏览器自动清理丢失存档的概率
  if (isWeb) {
    if (!(await isStoragePersisted())) {
      await requestPersistentStorage()
    }
    storageInfo.value = await getStorageInfo()
  }
})

const storageInfo = ref<StorageInfo | null>(null)

const storageRatio = computed(() => {
  const info = storageInfo.value
  if (!info || !info.quota) return 0
  return Math.min(100, Math.round((info.usage / info.quota) * 100))
})

async function save() {
  error.value = ''
  let headers: Record<string, string> = {}
  try {
    const parsed = form.extraHeadersText.trim() ? JSON.parse(form.extraHeadersText) : {}
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      error.value = '额外请求头必须是合法的 JSON 对象'
      return
    }
    headers = parsed as Record<string, string>
  } catch {
    error.value = '额外请求头必须是合法的 JSON 对象'
    return
  }
  if (!form.model.trim() || !form.baseUrl.trim()) {
    error.value = '请填写模型名称和 API 地址'
    return
  }
  const temperature = Number(form.temperature)
  const maxWaitTime = Number(form.maxWaitTime)
  const narrationMin = Number(form.narrationMin)
  const narrationMax = Number(form.narrationMax)
  if (!Number.isFinite(temperature) || temperature < 0 || temperature > 2) {
    error.value = '温度需在 0 ~ 2 之间'
    return
  }
  if (!Number.isFinite(maxWaitTime) || maxWaitTime < 10) {
    error.value = '最大等待时间需不小于 10 秒'
    return
  }
  if (!Number.isFinite(narrationMin) || narrationMin < 50) {
    error.value = '每轮叙事字数下限需不小于 50'
    return
  }
  if (!Number.isFinite(narrationMax) || narrationMax > 5000) {
    error.value = '每轮叙事字数上限需不大于 5000'
    return
  }
  if (narrationMin > narrationMax) {
    error.value = '每轮叙事字数下限不能大于上限'
    return
  }
  try {
    await settings.saveConfig({
      baseUrl: form.baseUrl.trim(),
      model: form.model.trim(),
      extraHeaders: headers,
      temperature,
      maxWaitTime,
      narrationMin,
      narrationMax,
    })
    if (apiKey.value.trim()) {
      await settings.setApiKey(apiKey.value.trim())
      apiKey.value = ''
    }
    saved.value = true
    setTimeout(() => (saved.value = false), 2000)
    } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

const logBusy = ref(false)
const logMsg = ref('')
async function downloadLog() {
  if (logBusy.value) return
  logBusy.value = true
  logMsg.value = ''
  try {
    const text = getLogText()
    if (!text) {
      logMsg.value = '日志为空'
      return
    }
    const filename = `dreams-log-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`
    if (!Capacitor.isNativePlatform()) {
      const blob = new Blob([text], { type: 'text/plain' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
      return
    }
    await Filesystem.writeFile({
      path: filename,
      data: text,
      directory: Directory.Cache,
      encoding: Encoding.UTF8,
    })
    const uri = await Filesystem.getUri({ path: filename, directory: Directory.Cache })
    await Share.share({
      title: filename,
      text,
      url: uri.uri,
      dialogTitle: '导出运行日志',
    })
  } catch (e) {
    logMsg.value = e instanceof Error ? e.message : String(e)
  } finally {
    logBusy.value = false
  }
}

async function doClearLog() {
  clearLog()
  logMsg.value = '日志已清空'
  setTimeout(() => (logMsg.value = ''), 2000)
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>我的</h1>
    </header>

    <!-- 我的 API -->
    <section class="block api-profiles-block">
      <h3 class="block-title">我的 API</h3>
      <p v-if="myApiList.length === 0" class="api-empty">
        还没有保存的配置。在下方填好参数后点「保存为我的 API」，即可一键切换多个 API。
      </p>
      <div
        v-for="p in myApiList"
        :key="p.id"
        class="api-item"
        :class="{ active: activeProfileId === p.id }"
      >
        <button class="api-item-main" @click="switchProfile(p.id)">
          <span class="api-name">{{ p.name }}</span>
          <span class="api-model">{{ p.model }}</span>
        </button>
        <button class="api-del" @click="removeProfile(p.id, p.name)">✕</button>
      </div>
    </section>

    <!-- API 配置（可折叠） -->
    <section class="block">
      <button class="section-toggle" @click="apiConfigOpen = !apiConfigOpen">
        <span>API 配置</span>
        <span class="toggle-arrow">{{ apiConfigOpen ? '▾' : '▸' }}</span>
      </button>
      <template v-if="apiConfigOpen">
        <p class="section-subtitle">OpenAI 兼容格式</p>

        <label class="field-label">模型名称</label>
        <input
          v-model="form.model"
          list="model-presets"
          class="input"
          placeholder="点击选择常见模型，或手动输入"
          @change="onModelChange"
        />
        <datalist id="model-presets">
          <option
            v-for="p in MODEL_PRESETS"
            :key="p.model"
            :value="p.model"
            :label="`${p.provider} · ${p.model}`"
          />
        </datalist>

        <label class="field-label">API 地址</label>
        <input v-model="form.baseUrl" class="input" placeholder="选择模型后自动填充，可手动修改" />

        <label class="field-label">
          API Key
          <span v-if="settings.hasKey" class="key-tip">（已保存）</span>
        </label>
        <input
          v-model="apiKey"
          class="input"
          type="password"
          :placeholder="settings.hasKey ? '留空则保留原 Key' : 'sk-…'"
        />

        <label class="field-label">额外请求头（JSON，可选）</label>
        <textarea v-model="form.extraHeadersText" class="textarea" rows="3" />

        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">温度</label>
            <input
              v-model.number="form.temperature"
              class="input"
              type="number"
              step="0.1"
              min="0"
              max="2"
            />
          </div>
          <p class="setting-hint">{{ temperatureHint }}</p>
        </div>

        <p v-if="error" class="error">{{ error }}</p>
        <button class="save-btn" @click="save">{{ saved ? '已保存 ✓' : '保存配置' }}</button>
        <button class="save-btn ghost" @click="saveAsProfile">保存为我的 API（快速切换）</button>
      </template>
    </section>

    <!-- 生成设置（可折叠） -->
    <section class="block">
      <button class="section-toggle" @click="genSettingsOpen = !genSettingsOpen">
        <span>生成设置</span>
        <span class="toggle-arrow">{{ genSettingsOpen ? '▾' : '▸' }}</span>
      </button>
      <template v-if="genSettingsOpen">
        <div class="range-row">
          <div class="setting-control">
            <label class="field-label">每轮叙事字数下限</label>
            <input v-model.number="form.narrationMin" class="input" type="number" step="10" min="50" @change="onGenSettingsChange" />
          </div>
          <div class="setting-control">
            <label class="field-label">每轮叙事字数上限</label>
            <input v-model.number="form.narrationMax" class="input" type="number" step="10" min="50" @change="onGenSettingsChange" />
          </div>
        </div>
        <p class="setting-hint standalone">控制每次行动返回的叙事正文长短（约字）：设小更简洁、响应更快，设大更详细、耗时更久</p>

        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">单次请求最长等待（秒）</label>
            <input v-model.number="form.maxWaitTime" class="input" type="number" step="10" min="10" @change="onGenSettingsChange" />
          </div>
          <p class="setting-hint">这是防止模型卡住/超时的保险上限，不是生成速度：设短不会更快，只会在答案未答完时提前中断。模型较慢或设定较长时建议加大（如 600）</p>
        </div>

        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">选项数量上限</label>
            <input
              type="number"
              class="input"
              min="0"
              step="1"
              :value="settings.optionCount"
              @input="onOptionCountInput"
            />
          </div>
          <p class="setting-hint">每轮生成可选行动方向的最大数量（默认 3）</p>
        </div>

        <div class="truncate-group">

          <p class="truncate-label">AI 选项未正常生成时</p>
          <label class="radio-row">
            <input
              type="radio"
              value="generic"
              :checked="settings.optionFallback === 'generic'"
              @change="settings.setOptionFallback('generic')"
            />
            <span>使用通用兜底选项（推荐）：直接填入固定的通用行动选项</span>
          </label>
          <label class="radio-row">
            <input
              type="radio"
              value="regenerate"
              :checked="settings.optionFallback === 'regenerate'"
              @change="settings.setOptionFallback('regenerate')"
            />
            <span>追加一次补全请求：让 AI 基于本轮叙事重新生成选项（失败回退通用）</span>
          </label>
          <p class="truncate-hint">当 AI 返回的选项为空或缺失时自动触发，保证玩家总有可选行动</p>
        </div>
      </template>
    </section>

    <!-- 上下文设置（可折叠） -->
    <section class="block">
      <button class="section-toggle" @click="contextSettingsOpen = !contextSettingsOpen">
        <span>上下文设置</span>
        <span class="toggle-arrow">{{ contextSettingsOpen ? '▾' : '▸' }}</span>
      </button>
      <template v-if="contextSettingsOpen">
        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">世界书最大匹配条目数</label>
            <input
              type="number"
              class="input"
              min="0"
              step="1"
              placeholder="默认 15"
              :value="settings.loreLimit"
              @input="onLoreLimitInput"
            />
          </div>
          <p class="setting-hint">每轮从世界书中最多注入多少条匹配条目（默认 15，越大消耗 token 越多）</p>
        </div>

        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">世界书注入字符上限</label>
            <input
              type="number"
              class="input"
              min="1"
              step="100"
              placeholder="默认 4000"
              :value="settings.loreBudget"
              @input="onLoreBudgetInput"
            />
          </div>
          <p class="setting-hint">每轮注入世界书的总字符预算（默认 4000）</p>
        </div>

        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">关联条目额外预算</label>
            <input
              type="number"
              class="input"
              min="0"
              step="100"
              placeholder="默认 2000"
              :value="settings.linkBudget"
              @input="onLinkBudgetInput"
            />
          </div>
          <p class="setting-hint">关联条目（links）展开的额外字符预算（默认 2000）</p>
        </div>

        <div class="setting-row">
          <div class="setting-control">
            <label class="field-label">核心设定字数上限</label>
            <input
              type="number"
              class="input"
              min="1"
              step="100"
              placeholder="默认 3000"
              :value="settings.worldSettingMax"
              @input="onWorldSettingMaxInput"
            />
          </div>
          <p class="setting-hint">世界核心设定（worldSetting）的最大字数，超出时精简并拆入世界书条目（默认 3000）</p>
        </div>
      </template>
    </section>

    <!-- 开发者模式 + 日志 + 说明 -->
    <section class="block">
      <label class="dev-row">
        <input type="checkbox" v-model="devMode" @change="toggleDevMode" />
        <span>开发者模式报错：显示完整错误信息（含技术详情），便于排查问题</span>
      </label>

      <div class="log-row">
        <button class="log-btn" :disabled="logBusy" @click="downloadLog">
          {{ logBusy ? '导出中…' : '导出运行日志' }}
        </button>
        <button class="log-btn-clear" @click="doClearLog">清空日志</button>
      </div>
      <p v-if="logMsg" class="log-msg">{{ logMsg }}</p>

      <p class="note">
        说明：API Key 仅加密存储在本机安全区域（Android Keystore），请求由 App 原生网络层直连你所填写的提供方，不经任何中间服务器。预设模型与地址仅供快速参考，请以官方最新文档为准。
      </p>
    </section>

    <section v-if="isWeb && storageInfo" class="block storage-block">
      <h3 class="block-title">存储状态</h3>
      <div class="storage-bar">
        <div class="storage-bar-track">
          <div class="storage-bar-fill" :style="{ width: storageRatio + '%' }" />
        </div>
        <span class="storage-bar-pct">{{ storageRatio }}%</span>
      </div>
      <p class="storage-detail">
        已用 {{ formatBytes(storageInfo.usage) }} / 配额 {{ formatBytes(storageInfo.quota) }}
      </p>
      <p class="storage-status" :class="{ persisted: storageInfo.persisted }">
        {{ storageInfo.persisted ? '✓ 已申请持久化存储，存档不易被浏览器自动清理' : '⚠ 未获得持久化配额，浏览器可能自动清理存档' }}
      </p>
      <p class="storage-tip">
        提示：将本页"添加到主屏幕"可获得更可靠的持久化保护。仍可在浏览器设置中手动清除站点数据。
      </p>
    </section>

    <footer class="footer">
      <p>本游戏由 @猎梦人 创作</p>
      <p>问题/建议欢迎加入QQ群1125851038反馈</p>
      <p class="thanks">「Thank you for playing my game.」</p>
    </footer>
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
.block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 16px;
  margin-bottom: 16px;
}
.block-title {
  font-size: 14px;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 14px;
}
.section-toggle {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: transparent;
  border: none;
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  cursor: pointer;
  padding: 0;
}
.toggle-arrow {
  color: var(--muted);
  font-size: 14px;
}
.section-subtitle {
  font-size: 12px;
  color: var(--muted);
  margin: 12px 0 0;
}
.field-label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin: 14px 0 6px;
}
.key-tip {
  color: #4ade80;
}
.input,
.textarea {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 11px 12px;
  resize: none;
}
.setting-row {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 14px;
}
.setting-control {
  flex: 0 0 150px;
  min-width: 0;
}
.setting-control .field-label {
  margin-top: 0;
}
.setting-hint {
  flex: 1;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  margin: 0;
}
.range-row {
  display: flex;
  gap: 12px;
  margin-top: 14px;
}
.range-row .setting-control {
  flex: 1;
  min-width: 0;
}
.setting-hint.standalone {
  margin-top: 8px;
}
.error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 12px;
}
.save-btn {
  width: 100%;
  background: var(--active);
  color: #fff;
  font-weight: 600;
  border-radius: 10px;
  padding: 13px;
  margin-top: 18px;
  font-size: 15px;
}
.save-btn.ghost {
  background: var(--surface-2);
  color: var(--active);
  border: 1px solid var(--border);
  margin-top: 10px;
}
.api-profiles-block {
  margin-bottom: 16px;
}
.api-empty {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  margin: 0;
}
.api-item {
  display: flex;
  align-items: center;
  gap: 8px;
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 8px 10px;
  margin-top: 8px;
}
.api-item.active {
  border-color: var(--active);
  background: #0d1b2e;
}
.api-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  background: transparent;
  border: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  padding: 0;
}
.api-name {
  font-size: 14px;
  font-weight: 600;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.api-model {
  font-size: 11px;
  color: var(--muted);
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.api-item.active .api-model {
  color: var(--active);
}
.api-del {
  flex: none;
  background: transparent;
  border: none;
  color: var(--danger);
  font-size: 15px;
  padding: 4px 8px;
  cursor: pointer;
}
.dev-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  line-height: 1.5;
}
.dev-row input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.truncate-group {
  margin-top: 14px;
  padding-top: 12px;
  border-top: 1px dashed var(--border);
}
.truncate-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin-bottom: 8px;
}
.radio-row {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
  line-height: 1.5;
  margin-top: 6px;
}
.radio-row input {
  width: 15px;
  height: 15px;
  margin-top: 1px;
  cursor: pointer;
  flex: none;
}
.truncate-hint {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.5;
  margin-top: 8px;
  opacity: 0.85;
}
.log-row {
  display: flex;
  gap: 10px;
  margin-top: 14px;
}
.log-btn {
  flex: 1;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 10px;
  font-size: 14px;
}
.log-btn:disabled {
  opacity: 0.5;
}
.log-btn-clear {
  flex: none;
  background: transparent;
  border: 1px solid var(--border);
  color: var(--muted);
  border-radius: 8px;
  padding: 10px 14px;
  font-size: 14px;
}
.log-msg {
  color: var(--muted);
  font-size: 12px;
  margin-top: 6px;
}
.note {
  color: var(--muted);
  font-size: 12px;
  line-height: 1.6;
  margin-top: 14px;
}
.storage-block {
  margin-top: 16px;
}
.storage-bar {
  display: flex;
  align-items: center;
  gap: 10px;
}
.storage-bar-track {
  flex: 1;
  height: 8px;
  background: var(--surface-2);
  border-radius: 4px;
  overflow: hidden;
}
.storage-bar-fill {
  height: 100%;
  background: var(--active);
  border-radius: 4px;
  transition: width 0.3s;
}
.storage-bar-pct {
  font-size: 13px;
  font-weight: 600;
  min-width: 36px;
  text-align: right;
}
.storage-detail {
  font-size: 13px;
  color: var(--muted);
  margin-top: 8px;
}
.storage-status {
  font-size: 13px;
  margin-top: 8px;
  color: #f59e0b;
}
.storage-status.persisted {
  color: #4ade80;
}
.storage-tip {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.5;
  margin-top: 6px;
}
.footer {
  margin-top: 28px;
  text-align: center;
  color: var(--muted);
  font-size: 12px;
  line-height: 1.8;
}
.footer .thanks {
  margin-top: 4px;
  font-style: italic;
  opacity: 0.7;
}
</style>