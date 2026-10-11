import { Capacitor } from '@capacitor/core'
import { SecureStoragePlugin } from 'capacitor-secure-storage-plugin'

const API_KEY = 'api_key'
const FALLBACK_KEY = 'dreams_api_key'

async function secureSet(key: string, value: string): Promise<boolean> {
  try {
    await SecureStoragePlugin.set({ key, value })
    // 写后读验证，避免原生层静默失败
    const res = await SecureStoragePlugin.get({ key })
    return res.value === value
  } catch {
    return false
  }
}

async function secureGet(key: string): Promise<string | null> {
  try {
    const res = await SecureStoragePlugin.get({ key })
    return res.value || null
  } catch {
    return null
  }
}

async function secureRemove(key: string): Promise<void> {
  try {
    await SecureStoragePlugin.remove({ key })
  } catch {
    // 忽略删除失败
  }
}

export async function saveApiKey(key: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const ok = await secureSet(API_KEY, key)
    if (!ok) {
      localStorage.setItem(FALLBACK_KEY, key)
    }
    return
  }
  localStorage.setItem(FALLBACK_KEY, key)
}

export async function getApiKey(): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const v = await secureGet(API_KEY)
    if (v) return v
    return localStorage.getItem(FALLBACK_KEY)
  }
  return localStorage.getItem(FALLBACK_KEY)
}

export async function removeApiKey(): Promise<void> {
  await secureRemove(API_KEY)
  localStorage.removeItem(FALLBACK_KEY)
}
// ===== 我的 API 配置各自的 Key（按 profileId 隔离存储） =====
const PROFILE_KEY_PREFIX = 'api_profile_key'
const PROFILE_FALLBACK_PREFIX = 'dreams_api_profile_key_'

export async function saveProfileKey(profileId: string, key: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const ok = await secureSet(`${PROFILE_KEY_PREFIX}:${profileId}`, key)
    if (!ok) {
      localStorage.setItem(`${PROFILE_FALLBACK_PREFIX}${profileId}`, key)
    }
    return
  }
  localStorage.setItem(`${PROFILE_FALLBACK_PREFIX}${profileId}`, key)
}

export async function getProfileKey(profileId: string): Promise<string | null> {
  if (Capacitor.isNativePlatform()) {
    const v = await secureGet(`${PROFILE_KEY_PREFIX}:${profileId}`)
    if (v) return v
    return localStorage.getItem(`${PROFILE_FALLBACK_PREFIX}${profileId}`)
  }
  return localStorage.getItem(`${PROFILE_FALLBACK_PREFIX}${profileId}`)
}

export async function removeProfileKey(profileId: string): Promise<void> {
  await secureRemove(`${PROFILE_KEY_PREFIX}:${profileId}`)
  localStorage.removeItem(`${PROFILE_FALLBACK_PREFIX}${profileId}`)
}