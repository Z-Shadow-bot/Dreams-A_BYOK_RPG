// PWA 持久化存储：向浏览器申请"持久配额"，标记为持久化的站点数据在浏览器自动清理时不会被清除，
// 降低存档（IndexedDB）与设置（localStorage）因缓存清理而丢失的概率。仅在安全上下文（https）可用。
export async function requestPersistentStorage(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persist) return false
  try {
    const ok = await navigator.storage.persist()
    console.log(`[storage] persist 申请结果: ${ok}`)
    return ok
  } catch (e) {
    console.error('[storage] persist 调用失败', e)
    return false
  }
}

export async function isStoragePersisted(): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage || !navigator.storage.persisted) return false
  try {
    return await navigator.storage.persisted()
  } catch {
    return false
  }
}

export interface StorageInfo {
  supported: boolean
  persisted: boolean
  usage: number
  quota: number
}

export async function getStorageInfo(): Promise<StorageInfo> {
  const info: StorageInfo = { supported: false, persisted: false, usage: 0, quota: 0 }
  if (typeof navigator === 'undefined' || !navigator.storage) return info
  info.supported = true
  try {
    if (navigator.storage.persisted) info.persisted = await navigator.storage.persisted()
  } catch {
    /* ignore */
  }
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate()
      info.usage = est.usage ?? 0
      info.quota = est.quota ?? 0
    }
  } catch {
    /* ignore */
  }
  return info
}

export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`
}