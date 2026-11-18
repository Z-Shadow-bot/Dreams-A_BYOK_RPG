import type { World, WorldState, StoryPage, SavePoint, MaState, AgentState, StoryMessage } from '@/types'

const DB_NAME = 'dreams'
const DB_VERSION = 2

const STORES = {
  worlds: 'worlds',
  states: 'states',
  pages: 'pages',
  savepoints: 'savepoints',
  settings: 'settings',
  maStates: 'maStates',
  agents: 'agents',
  messages: 'messages',
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
      // ===== v2：多智能体模式 =====
      if (!db.objectStoreNames.contains(STORES.maStates)) {
        db.createObjectStore(STORES.maStates, { keyPath: 'worldId' })
      }
      if (!db.objectStoreNames.contains(STORES.agents)) {
        const agents = db.createObjectStore(STORES.agents, { keyPath: ['worldId', 'charId'] })
        agents.createIndex('worldId', 'worldId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORES.messages)) {
        const msgs = db.createObjectStore(STORES.messages, { keyPath: 'id' })
        msgs.createIndex('worldId', 'worldId', { unique: false })
        msgs.createIndex('worldId_seq', ['worldId', 'seq'], { unique: false })
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
  const agentKeys = await withStore<IDBValidKey[]>(STORES.agents, 'readonly', (s) =>
    req(s.index('worldId').getAllKeys(id)),
  )
  const msgKeys = await withStore<IDBValidKey[]>(STORES.messages, 'readonly', (s) =>
    req(s.index('worldId').getAllKeys(id)),
  )
  const db = await openDB()
  const tx = db.transaction(
    [
      STORES.worlds,
      STORES.states,
      STORES.pages,
      STORES.savepoints,
      STORES.maStates,
      STORES.agents,
      STORES.messages,
    ],
    'readwrite',
  )
  tx.objectStore(STORES.worlds).delete(id)
  tx.objectStore(STORES.states).delete(id)
  tx.objectStore(STORES.maStates).delete(id)
  const pageStore = tx.objectStore(STORES.pages)
  for (const k of pageKeys) pageStore.delete(k)
  const spStore = tx.objectStore(STORES.savepoints)
  for (const k of spKeys) spStore.delete(k)
  const agentStore = tx.objectStore(STORES.agents)
  for (const k of agentKeys) agentStore.delete(k)
  const msgStore = tx.objectStore(STORES.messages)
  for (const k of msgKeys) msgStore.delete(k)
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

// 页数统计（懒加载用，无需读取正文）
export async function countPages(worldId: string): Promise<number> {
  return withStore<number>(STORES.pages, 'readonly', (s) => req(s.index('worldId').count(worldId)))
}

// 按 index 区间读取页面（闭区间；懒加载用，只取窗口内的页）
export async function getPagesRange(worldId: string, start: number, end: number): Promise<StoryPage[]> {
  if (end < start) return []
  const pages = await withStore<StoryPage[]>(STORES.pages, 'readonly', (s) => {
    const idx = s.index('worldId_index')
    const range = IDBKeyRange.bound([worldId, start], [worldId, end])
    return req(idx.getAll(range))
  })
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

// 用完整页面快照替换某世界的全部冒险页（读档恢复用）
export async function replacePages(worldId: string, pages: StoryPage[]): Promise<void> {
  const keys = await withStore<IDBValidKey[]>(STORES.pages, 'readonly', (s) =>
    req(s.index('worldId').getAllKeys(worldId)),
  )
  await withStore(STORES.pages, 'readwrite', (s) => {
    for (const k of keys) s.delete(k)
    for (const p of pages) s.put(deepClone(p))
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

// ===== 多智能体：运行状态 =====
export async function getMaState(worldId: string): Promise<MaState | undefined> {
  return withStore<MaState | undefined>(STORES.maStates, 'readonly', (s) => req(s.get(worldId)))
}

export async function putMaState(state: MaState): Promise<void> {
  await withStore(STORES.maStates, 'readwrite', (s) => req(s.put(deepClone(state))))
}

export async function deleteMaState(worldId: string): Promise<void> {
  await withStore(STORES.maStates, 'readwrite', (s) => req(s.delete(worldId)))
}

// ===== 多智能体：角色状态 =====
export async function listAgents(worldId: string): Promise<AgentState[]> {
  const arr = await getAllByIndex<AgentState>(STORES.agents, 'worldId', worldId)
  return arr.sort((a, b) => a.name.localeCompare(b.name))
}

export async function getAgent(worldId: string, charId: string): Promise<AgentState | undefined> {
  return withStore<AgentState | undefined>(STORES.agents, 'readonly', (s) => req(s.get([worldId, charId])))
}

export async function putAgent(agent: AgentState): Promise<void> {
  await withStore(STORES.agents, 'readwrite', (s) => req(s.put(deepClone(agent))))
}

export async function deleteAgent(worldId: string, charId: string): Promise<void> {
  await withStore(STORES.agents, 'readwrite', (s) => req(s.delete([worldId, charId])))
}

// ===== 多智能体：消息流 =====
// 按序号升序读取；fromSeq 用于增量拉取（只取上次之后的新消息）
export async function listMessages(worldId: string, fromSeq = 0): Promise<StoryMessage[]> {
  const arr = await withStore<StoryMessage[]>(STORES.messages, 'readonly', (s) => {
    const idx = s.index('worldId_seq')
    const range = IDBKeyRange.bound([worldId, fromSeq], [worldId, Number.MAX_SAFE_INTEGER])
    return req(idx.getAll(range))
  })
  return arr.sort((a, b) => a.seq - b.seq)
}

export async function countMessages(worldId: string): Promise<number> {
  const arr = await withStore<number>(STORES.messages, 'readonly', (s) => req(s.index('worldId').count(worldId)))
  return arr
}

export async function putMessage(msg: StoryMessage): Promise<void> {
  await withStore(STORES.messages, 'readwrite', (s) => req(s.put(deepClone(msg))))
}

export async function putMessages(msgs: StoryMessage[]): Promise<void> {
  if (msgs.length === 0) return
  await withStore(STORES.messages, 'readwrite', (s) => {
    for (const m of msgs) s.put(deepClone(m))
  })
}

// 删除序号大于 fromSeq 的消息（回退/重试用）
export async function deleteMessagesFrom(worldId: string, fromSeq: number): Promise<void> {
  const all = await listMessages(worldId)
  const toDelete = all.filter((m) => m.seq > fromSeq)
  if (toDelete.length === 0) return
  await withStore(STORES.messages, 'readwrite', (s) => {
    for (const m of toDelete) s.delete(m.id)
  })
}

// 用快照替换某世界的全部消息（读档/导入用）
export async function replaceMessages(worldId: string, msgs: StoryMessage[]): Promise<void> {
  const keys = await withStore<IDBValidKey[]>(STORES.messages, 'readonly', (s) =>
    req(s.index('worldId').getAllKeys(worldId)),
  )
  await withStore(STORES.messages, 'readwrite', (s) => {
    for (const k of keys) s.delete(k)
    for (const m of msgs) s.put(deepClone(m))
  })
}