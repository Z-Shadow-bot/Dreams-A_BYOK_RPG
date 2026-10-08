import { defineStore } from 'pinia'
import { getSetting, putSetting } from '@/db'
import { getApiKey, saveApiKey, removeApiKey } from '@/ai/secure'
import type { APIConfig } from '@/types'

const CONFIG_KEY = 'api_config'
const DEV_MODE_KEY = 'dev_mode'
const BGM_MUTED_KEY = 'bgm_muted'
const BAG_DETAIL_KEY = 'bag_detail'

const DEFAULT_CONFIG: APIConfig = {
  baseUrl: '',
  model: '',
  extraHeaders: {},
  temperature: 0.8,
  maxWaitTime: 180,
  narrationMin: 200,
  narrationMax: 500,
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    config: { ...DEFAULT_CONFIG } as APIConfig,
    hasKey: false,
    loaded: false,
    devMode: false,
    muted: false,
    detailedBag: false, // 精细化背包描述：对物品生成更精细的 state 描述
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
  },
})