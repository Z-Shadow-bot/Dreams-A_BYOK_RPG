<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { getLogText, clearLog } from '@/utils/logger'
import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'
import { getStorageInfo, requestPersistentStorage, isStoragePersisted, formatBytes } from '@/utils/storage'
import type { StorageInfo } from '@/utils/storage'

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

    <section class="block">
      <h3 class="block-title">API 配置（OpenAI 兼容格式）</h3>

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

      <div class="range-row">
        <div class="setting-control">
          <label class="field-label">每轮叙事字数下限</label>
          <input v-model.number="form.narrationMin" class="input" type="number" step="10" min="50" />
        </div>
        <div class="setting-control">
          <label class="field-label">每轮叙事字数上限</label>
          <input v-model.number="form.narrationMax" class="input" type="number" step="10" min="50" />
        </div>
      </div>
      <p class="setting-hint standalone">控制每次行动返回的叙事正文长短（约字）：设小更简洁、响应更快，设大更详细、耗时更久</p>

      <div class="setting-row">
        <div class="setting-control">
          <label class="field-label">单次请求最长等待（秒）</label>
          <input v-model.number="form.maxWaitTime" class="input" type="number" step="10" min="10" />
        </div>
        <p class="setting-hint">这是防止模型卡住/超时的保险上限，不是生成速度：设短不会更快，只会在答案未答完时提前中断。模型较慢或设定较长时建议加大（如 600）</p>
      </div>

      <p v-if="error" class="error">{{ error }}</p>
      <button class="save-btn" @click="save">{{ saved ? '已保存 ✓' : '保存配置' }}</button>

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
}
.block-title {
  font-size: 14px;
  color: var(--muted);
  font-weight: 600;
  margin-bottom: 14px;
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
.dev-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 14px;
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