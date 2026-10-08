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