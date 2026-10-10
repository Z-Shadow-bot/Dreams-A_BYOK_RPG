import { defineStore } from 'pinia'
import { getSetting, putSetting } from '@/db'
import { getApiKey, saveApiKey, removeApiKey } from '@/ai/secure'
import type { APIConfig } from '@/types'

const CONFIG_KEY = 'api_config'
const DEV_MODE_KEY = 'dev_mode'
const BGM_MUTED_KEY = 'bgm_muted'
const BAG_DETAIL_KEY = 'bag_detail'
const TRUNCATE_STRATEGY_KEY = 'truncate_strategy'
const FAST_FORWARD_KEY = 'fast_forward'
const AUTO_SAVE_KEY = 'auto_save'
const MANUAL_PROFILE_KEY = 'manual_profile'

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

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    config: { ...DEFAULT_CONFIG } as APIConfig,
    hasKey: false,
    loaded: false,
    devMode: false,
    muted: false,
    detailedBag: false, // 精细化背包描述：对物品生成更精细的 state 描述
    truncateStrategy: 'diff' as TruncateStrategy, // 输出截断自动重试策略：diff 精简修改指令 / split 拆分输出
    fastForward: false, // 快速推进叙事：省略无关细节，直接推进主线
    autoSave: true, // 每 10 页自动存档
    manualProfile: false, // 手动更新设定：开启后 AI 不得修改玩家角色人设
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
        const f = await getSetting<boolean>(FAST_FORWARD_KEY)
        this.fastForward = !!f
      } catch {
        this.fastForward = false
      }
      try {
        const a = await getSetting<boolean>(AUTO_SAVE_KEY)
        this.autoSave = a === false ? false : true
      } catch {
        this.autoSave = true
      }
      try {
        const m = await getSetting<boolean>(MANUAL_PROFILE_KEY)
        this.manualProfile = !!m
      } catch {
        this.manualProfile = false
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
    async setFastForward(v: boolean) {
      this.fastForward = v
      try {
        await putSetting(FAST_FORWARD_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
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
    async setManualProfile(v: boolean) {
      this.manualProfile = v
      try {
        await putSetting(MANUAL_PROFILE_KEY, v)
      } catch {
        // 保存失败不阻塞开关生效
      }
    },
  },
})