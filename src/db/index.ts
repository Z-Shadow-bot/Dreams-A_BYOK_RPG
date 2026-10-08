import type { World, WorldState, StoryPage, SavePoint } from '@/types'

const DB_NAME = 'dreams'
const DB_VERSION = 1

const STORES = {
  worlds: 'worlds',
  states: 'states',
  pages: 'pages',
  savepoints: 'savepoints',
  settings: 'settings',
} as const

let dbPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORES.worlds)) {
        db.createObjectStore(STORES.worlds, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORES.states)) {
        db.createObjectStore(STORES.states, { keyPath: 'worldId' })
      }
      if (!db.objectStoreNames.contains(STORES.pages)) {
        const pages = db.createObjectStore(STORES.pages, { keyPath: 'id' })
        pages.createIndex('worldId', 'worldId', { unique: false })
        pages.createIndex('worldId_index', ['worldId', 'index'], { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.savepoints)) {
        const sp = db.createObjectStore(STORES.savepoints, { keyPath: 'id' })
        sp.createIndex('worldId', 'worldId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.settings)) {
        db.createObjectStore(STORES.settings, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
  dbPromise.catch(() => {
    dbPromise = null
  })
  return dbPromise
}

function req<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
}

// 深拷贝为纯 JSON：剥离 Pinia/Vue 的 reactive Proxy，避免 IndexedDB structured clone 报错
function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

async function withStore<T>(
  name: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(name, mode)
    const store = tx.objectStore(name)
    let result: T
    Promise.resolve(fn(store))
      .then((v) => {
        result = v
      })
      .catch((e) => reject(e))
    tx.oncomplete = () => resolve(result)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

function getAllByIndex<T>(name: string, index: string, value: IDBValidKey): Promise<T[]> {
  return withStore<T[]>(name, 'readonly', (store) => {
    const idx = store.index(index)
    return req(idx.getAll(value))
  })
}

// ===== 世界 =====
export async function listWorlds(): Promise<World[]> {
  const all = await withStore<World[]>(STORES.worlds, 'readonly', (s) => req(s.getAll()))
  return all.sort((a, b) => b.updatedAt - a.updatedAt)
}

export async function getWorld(id: string): Promise<World | undefined> {
  return withStore<World | undefined>(STORES.worlds, 'readonly', (s) => req(s.get(id)))
}

export async function putWorld(world: World): Promise<void> {
  await withStore(STORES.worlds, 'readwrite', (s) => req(s.put(deepClone(world))))
}

export async function deleteWorld(id: string): Promise<void> {
  const pageKeys = await withStore<IDBValidKey[]>(STORES.pages, 'readonly', (s) =>
    req(s.index('worldId').getAllKeys(id)),
  )
  const spKeys = await withStore<IDBValidKey[]>(STORES.savepoints, 'readonly', (s) =>
    req(s.index('worldId').getAllKeys(id)),
  )
  const db = await openDB()
  const tx = db.transaction(
    [STORES.worlds, STORES.states, STORES.pages, STORES.savepoints],
    'readwrite',
  )
  tx.objectStore(STORES.worlds).delete(id)
  tx.objectStore(STORES.states).delete(id)
  const pageStore = tx.objectStore(STORES.pages)
  for (const k of pageKeys) pageStore.delete(k)
  const spStore = tx.objectStore(STORES.savepoints)
  for (const k of spKeys) spStore.delete(k)
  await new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(undefined)
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })
}

// ===== 世界状态（当前存档） =====
export async function getState(worldId: string): Promise<WorldState | undefined> {
  return withStore<WorldState | undefined>(STORES.states, 'readonly', (s) => req(s.get(worldId)))
}

export async function putState(state: WorldState): Promise<void> {
  await withStore(STORES.states, 'readwrite', (s) => req(s.put(deepClone(state))))
}

export async function deleteState(worldId: string): Promise<void> {
  await withStore(STORES.states, 'readwrite', (s) => req(s.delete(worldId)))
}

// ===== 冒险页 =====
export async function listPages(worldId: string): Promise<StoryPage[]> {
  const pages = await getAllByIndex<StoryPage>(STORES.pages, 'worldId', worldId)
  return pages.sort((a, b) => a.index - b.index)
}

export async function putPage(page: StoryPage): Promise<void> {
  await withStore(STORES.pages, 'readwrite', (s) => req(s.put(deepClone(page))))
}

export async function deletePagesFrom(worldId: string, fromIndex: number): Promise<void> {
  const pages = await listPages(worldId)
  const toDelete = pages.filter((p) => p.index > fromIndex)
  await withStore(STORES.pages, 'readwrite', (s) => {
    for (const p of toDelete) s.delete(p.id)
  })
}

// ===== 存档点 =====
export async function listSavePoints(worldId: string): Promise<SavePoint[]> {
  const sps = await getAllByIndex<SavePoint>(STORES.savepoints, 'worldId', worldId)
  return sps.sort((a, b) => b.createdAt - a.createdAt)
}

export async function putSavePoint(sp: SavePoint): Promise<void> {
  await withStore(STORES.savepoints, 'readwrite', (s) => req(s.put(deepClone(sp))))
}

export async function deleteSavePoint(id: string): Promise<void> {
  await withStore(STORES.savepoints, 'readwrite', (s) => req(s.delete(id)))
}

// ===== 设置 =====
export async function getSetting<T>(key: string): Promise<T | undefined> {
  const rec = await withStore<{ key: string; value: T } | undefined>(STORES.settings, 'readonly', (s) =>
    req(s.get(key)),
  )
  return rec?.value
}

export async function putSetting<T>(key: string, value: T): Promise<void> {
  await withStore(STORES.settings, 'readwrite', (s) => req(s.put(deepClone({ key, value }))))
}