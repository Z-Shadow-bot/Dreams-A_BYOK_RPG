import { defineStore } from 'pinia'
import { getSetting, putSetting } from '@/db'
import {
  getApiKey,
  saveApiKey,
  removeApiKey,
  saveProfileKey,
  getProfileKey,
  removeProfileKey,
} from '@/ai/secure'
import type { APIConfig, ApiProfile } from '@/types'

const CONFIG_KEY = 'api_config'
const API_PROFILES_KEY = 'api_profiles'
const DEV_MODE_KEY = 'dev_mode'
const BGM_MUTED_KEY = 'bgm_muted'
const BAG_DETAIL_KEY = 'bag_detail'
const TRUNCATE_STRATEGY_KEY = 'truncate_strategy'
const NARRATIVE_SPEED_KEY = 'narrative_speed'
const NARRATIVE_DETAIL_KEY = 'narrative_detail'
const AUTO_SAVE_KEY = 'auto_save'
const AUTO_SAVE_INTERVAL_KEY = 'auto_save_interval'
const MANUAL_PROFILE_KEY = 'manual_profile'
const EVENT_FREQUENCY_KEY = 'event_frequency'
const DIFFICULTY_KEY = 'difficulty'
const ALLOW_REWRITE_KEY = 'allow_rewrite'
const OPTION_FALLBACK_KEY = 'option_fallback'
const LORE_LIMIT_KEY = 'lore_limit'
const LORE_BUDGET_KEY = 'lore_budget'
const LINK_BUDGET_KEY = 'link_budget'
const WORLD_SETTING_MAX_KEY = 'world_setting_max'
const OPTION_COUNT_KEY = 'option_count'
const FONT_SIZE_KEY = 'font_size'
const TEXT_COLOR_KEY = 'text_color'
const BG_COLOR_KEY = 'bg_color'

const DEFAULT_CONFIG: APIConfig = {
  baseUrl: '',
  model: '',
  extraHeaders: {},
  temperature: 0.8,
  maxWaitTime: 180,
  narrationMin: 200,
  narrationMax: 500,
}

export type TruncateStrategy = 'diff' | 'split'

export type Difficulty = 'easy' | 'normal' | 'hard' | 'nightmare'

export type NarrativeSpeed = 'fine' | 'normal' | 'fast' | 'rapid'

export type NarrativeDetail = 'brief' | 'normal' | 'detailed' | 'extreme'

export type EventFrequency = 'none' | 'normal' | 'frequent' | 'doom'

export type OptionFallback = 'generic' | 'regenerate'

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    config: { ...DEFAULT_CONFIG } as APIConfig,
    apiProfiles: [] as ApiProfile[], // 我的 API：已保存的多个配置，可快速切换
    hasKey: false,
    loaded: false,
    devMode: false,
    muted: false,
    detailedBag: false, // 精细化背包描述：对物品生成更精细的 state 描述
    truncateStrategy: 'diff' as TruncateStrategy, // 输出截断自动重试策略：diff 精简修改指令 / split 拆分输出
    narrativeSpeed: 'normal' as NarrativeSpeed, // 叙事推进速度：精细/正常/快速/极速，控制每轮叙事推进的幅度
    narrativeDetail: 'normal' as NarrativeDetail, // 描写细致程度：简洁/常规/精细/极致，仅影响叙事描写，不影响存档与世界书
    autoSave: true, // 自动存档
    autoSaveInterval: 10, // 自动存档周期（每 N 页存档一次）
    manualProfile: false, // 手动更新设定：开启后 AI 不得修改玩家角色人设
    eventFrequency: 'normal' as EventFrequency, // 突发事件频率：无/正常/频繁/厄运，控制突发事件出现概率
    difficulty: 'normal' as Difficulty, // 游戏难度：简单/正常/困难/噩梦，影响行动成功率与敌人强度
    allowRewrite: false, // 允许改写：开启后双击最新页面可编辑，行动前 AI 先同步改写内容
    optionFallback: 'generic' as OptionFallback, // AI 未正常生成选项时的兜底：generic 通用兜底选项 / regenerate 追加补全请求
    loreLimit: 15, // 世界书最大匹配条目数（全局）
    loreBudget: 4000, // 世界书注入字符预算上限
    linkBudget: 2000, // 关联条目额外字符预算
    worldSettingMax: 3000, // 核心设定字数上限
    optionCount: 3, // 每轮选项数量上限
    fontSize: 16, // 正文字体大小（px）
    textColor: '#ffffff', // 全局文本颜色
    bgColor: '#000000', // 全局背景颜色
  }),
  actions: {
    async load() {
      try {
        const saved = await getSetting<APIConfig>(CONFIG_KEY)
        if (saved) this.config = { ...DEFAULT_CONFIG, ...saved }
      } catch {
        // 配置读取失败，使用默认值
      }
      try {
        const list = await getSetting<ApiProfile[]>(API_PROFILES_KEY)
        this.apiProfiles = Array.isArray(list) ? list : []
      } catch {
        this.apiProfiles = []
      }
      try {
        const key = await getApiKey()
        this.hasKey = !!key
      } catch {
        this.hasKey = false
      }
      try {
        const dev = await getSetting<boolean>(DEV_MODE_KEY)
        this.devMode = !!dev
      } catch {
        this.devMode = false
      }
      try {
        const m = await getSetting<boolean>(BGM_MUTED_KEY)
        this.muted = !!m
      } catch {
        this.muted = false
      }
      try {
        const d = await getSetting<boolean>(BAG_DETAIL_KEY)
        this.detailedBag = !!d
      } catch {
        this.detailedBag = false
      }
      try {
        const s = await getSetting<string>(TRUNCATE_STRATEGY_KEY)
        this.truncateStrategy = s === 'split' ? 'split' : 'diff'
      } catch {
        this.truncateStrategy = 'diff'
      }
      try {
        const ns = await getSetting<string>(NARRATIVE_SPEED_KEY)
        this.narrativeSpeed =
          ns === 'fine' || ns === 'fast' || ns === 'rapid' ? ns : 'normal'
      } catch {
        this.narrativeSpeed = 'normal'
      }
      try {
        const nd = await getSetting<string>(NARRATIVE_DETAIL_KEY)
        this.narrativeDetail =
          nd === 'brief' || nd === 'detailed' || nd === 'extreme' ? nd : 'normal'
      } catch {
        this.narrativeDetail = 'normal'
      }
      try {
        const a = await getSetting<boolean>(AUTO_SAVE_KEY)
        this.autoSave = a === false ? false : true
      } catch {
        this.autoSave = true
      }
      try {
        const ai = await getSetting<number>(AUTO_SAVE_INTERVAL_KEY)
        this.autoSaveInterval = typeof ai === 'number' && ai >= 1 ? Math.round(ai) : 10
      } catch {
        this.autoSaveInterval = 10
      }
      try {
        const m = await getSetting<boolean>(MANUAL_PROFILE_KEY)
        this.manualProfile = !!m
      } catch {
        this.manualProfile = false
      }
      try {
        const ef = await getSetting<string>(EVENT_FREQUENCY_KEY)
        this.eventFrequency =
          ef === 'none' || ef === 'frequent' || ef === 'doom' ? ef : 'normal'
      } catch {
        this.eventFrequency = 'normal'
      }
      try {
        const d = await getSetting<string>(DIFFICULTY_KEY)
        this.difficulty =
          d === 'easy' || d === 'hard' || d === 'nightmare' ? d : 'normal'
      } catch {
        this.difficulty = 'normal'
      }
      try {
        const a = await getSetting<boolean>(ALLOW_REWRITE_KEY)
        this.allowRewrite = !!a
      } catch {
        this.allowRewrite = false
      }
      try {
        const o = await getSetting<string>(OPTION_FALLBACK_KEY)
        this.optionFallback = o === 'regenerate' ? 'regenerate' : 'generic'
      } catch {
        this.optionFallback = 'generic'
      }
      try {
        const ll = await getSetting<number>(LORE_LIMIT_KEY)
        this.loreLimit = typeof ll === 'number' && ll >= 0 ? Math.round(ll) : 15
      } catch {
        this.loreLimit = 15
      }
      try {
        const lb = await getSetting<number>(LORE_BUDGET_KEY)
        this.loreBudget = typeof lb === 'number' && lb > 0 ? Math.round(lb) : 4000
      } catch {
        this.loreBudget = 4000
      }
      try {
        const lb2 = await getSetting<number>(LINK_BUDGET_KEY)
        this.linkBudget = typeof lb2 === 'number' && lb2 >= 0 ? Math.round(lb2) : 2000
      } catch {
        this.linkBudget = 2000
      }
      try {
        const wsm = await getSetting<number>(WORLD_SETTING_MAX_KEY)
        this.worldSettingMax = typeof wsm === 'number' && wsm > 0 ? Math.round(wsm) : 3000
      } catch {
        this.worldSettingMax = 3000
      }
      try {
        const oc = await getSetting<number>(OPTION_COUNT_KEY)
        this.optionCount = typeof oc === 'number' && oc >= 0 ? Math.round(oc) : 3
      } catch {
        this.optionCount = 3
      }
      try {
        const fs = await getSetting<number>(FONT_SIZE_KEY)
        this.fontSize = typeof fs === 'number' && fs >= 10 && fs <= 28 ? Math.round(fs) : 16
      } catch {
        this.fontSize = 16
      }
      try {
        const tc = await getSetting<string>(TEXT_COLOR_KEY)
        this.textColor = typeof tc === 'string' && tc.trim() ? tc.trim() : '#ffffff'
      } catch {
        this.textColor = '#ffffff'
      }
      try {
        const bc = await getSetting<string>(BG_COLOR_KEY)
        this.bgColor = typeof bc === 'string' && bc.trim() ? bc.trim() : '#000000'
      } catch {
        this.bgColor = '#000000'
      }
      this.loaded = true
    },
    async saveConfig(cfg: APIConfig) {
      const next = { ...cfg }
      await putSetting(CONFIG_KEY, next)
      this.config = next
    },
    async setApiKey(key: string) {
      await saveApiKey(key)
      this.hasKey = !!key
    },
    async clearApiKey() {
      await removeApiKey()
      this.hasKey = false
    },
    // ===== 我的 API：多配置保存与快速切换 =====
    async saveApiProfile(profile: ApiProfile, apiKey?: string) {
      const idx = this.apiProfiles.findIndex((p) => p.id === profile.id)
      if (idx >= 0) this.apiProfiles[idx] = profile
      else this.apiProfiles.push(profile)
      try {
        await putSetting(API_PROFILES_KEY, this.apiProfiles)
      } catch {
        // 保存失败不阻塞内存生效
      }
      if (apiKey && apiKey.trim()) {
        await saveProfileKey(profile.id, apiKey.trim())
      }
    },
    async removeApiProfile(id: string) {
      this.apiProfiles = this.apiProfiles.filter((p) => p.id !== id)
      try {
        await putSetting(API_PROFILES_KEY, this.apiProfiles)
      } catch {
        // 保存失败不阻塞内存生效
      }
      await removeProfileKey(id)
    },
    async switchApiProfile(id: string) {
      const p = this.apiProfiles.find((x) => x.id === id)
      if (!p) return
      await this.saveConfig({
        baseUrl: p.baseUrl,
        model: p.model,
        extraHeaders: p.extraHeaders ?? {},
        temperature: p.temperature,
        maxWaitTime: p.maxWaitTime,
        narrationMin: p.narrationMin ?? 200,
        narrationMax: p.narrationMax ?? 500,
      })
      const key = await getProfileKey(id)
      if (key) {
        await this.setApiKey(key)
      } else {
        // 该 profile 未保存过 API Key：清空当前 Key，避免残留上一个 profile 的 Key 请求本配置导致鉴权错误
        await this.clearApiKey()
      }
    },
    async setDevMode(v: boolean) {
      this.devMode = v
      try {
        await putSetting(DEV_MODE_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
      }
    },
    async setBgmMuted(v: boolean) {
      this.muted = v
      try {
        await putSetting(BGM_MUTED_KEY, v)
      } catch {
        // 保存失败不阻塞静音生效
      }
    },
    async setDetailedBag(v: boolean) {
      this.detailedBag = v
      try {
        await putSetting(BAG_DETAIL_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
      }
    },
    async setTruncateStrategy(v: TruncateStrategy) {
      this.truncateStrategy = v
      try {
        await putSetting(TRUNCATE_STRATEGY_KEY, v)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setNarrativeSpeed(v: NarrativeSpeed) {
      this.narrativeSpeed = v
      try {
        await putSetting(NARRATIVE_SPEED_KEY, v)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setNarrativeDetail(v: NarrativeDetail) {
      this.narrativeDetail = v
      try {
        await putSetting(NARRATIVE_DETAIL_KEY, v)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setAutoSave(v: boolean) {
      this.autoSave = v
      try {
        await putSetting(AUTO_SAVE_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
      }
    },
    async setAutoSaveInterval(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v >= 1 ? Math.round(v) : 10
      this.autoSaveInterval = n
      try {
        await putSetting(AUTO_SAVE_INTERVAL_KEY, n)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setManualProfile(v: boolean) {
      this.manualProfile = v
      try {
        await putSetting(MANUAL_PROFILE_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
      }
    },
    async setEventFrequency(v: EventFrequency) {
      this.eventFrequency = v
      try {
        await putSetting(EVENT_FREQUENCY_KEY, v)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setDifficulty(v: Difficulty) {
      this.difficulty = v
      try {
        await putSetting(DIFFICULTY_KEY, v)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setAllowRewrite(v: boolean) {
      this.allowRewrite = v
      try {
        await putSetting(ALLOW_REWRITE_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
      }
    },
    async setOptionFallback(v: OptionFallback) {
      this.optionFallback = v
      try {
        await putSetting(OPTION_FALLBACK_KEY, v)
      } catch {
        // 保存失败不阻塞设置生效
      }
    },
    async setLoreLimit(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 15
      this.loreLimit = n
      try { await putSetting(LORE_LIMIT_KEY, n) } catch { /* ignore */ }
    },
    async setLoreBudget(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 4000
      this.loreBudget = n
      try { await putSetting(LORE_BUDGET_KEY, n) } catch { /* ignore */ }
    },
    async setLinkBudget(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 2000
      this.linkBudget = n
      try { await putSetting(LINK_BUDGET_KEY, n) } catch { /* ignore */ }
    },
    async setWorldSettingMax(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v > 0 ? Math.round(v) : 3000
      this.worldSettingMax = n
      try { await putSetting(WORLD_SETTING_MAX_KEY, n) } catch { /* ignore */ }
    },
    async setOptionCount(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v >= 0 ? Math.round(v) : 3
      this.optionCount = n
      try { await putSetting(OPTION_COUNT_KEY, n) } catch { /* ignore */ }
    },
    async setFontSize(v: number) {
      const n = typeof v === 'number' && isFinite(v) && v >= 10 && v <= 28 ? Math.round(v) : 16
      this.fontSize = n
      try { await putSetting(FONT_SIZE_KEY, n) } catch { /* ignore */ }
    },
    async setTextColor(v: string) {
      this.textColor = typeof v === 'string' && v.trim() ? v.trim() : '#ffffff'
      try { await putSetting(TEXT_COLOR_KEY, this.textColor) } catch { /* ignore */ }
    },
    async setBgColor(v: string) {
      this.bgColor = typeof v === 'string' && v.trim() ? v.trim() : '#000000'
      try { await putSetting(BG_COLOR_KEY, this.bgColor) } catch { /* ignore */ }
    },
  },
})