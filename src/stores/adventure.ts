import { defineStore } from 'pinia'
import {
  getState,
  putState,
  listPages,
  putPage,
  deletePagesFrom,
  deleteState,
  listSavePoints,
  putSavePoint,
  deleteSavePoint,
} from '@/db'
import { generateAction, generateCharacter, normalizeSave } from '@/ai/service'
import { errorMessage } from '@/ai/client'
import { createId } from '@/types'
import type { SaveData, StoryPage, SavePoint, WorldState, PanelField, LoreEntry, World } from '@/types'
import { useSettingsStore } from './settings'
import { useWorldStore, normalizeImportedLorebook } from './world'

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}

// ===== 后台中断检测：用 localStorage 持久化进行中的请求，重启后可检测并提示重试 =====
const PENDING_KEY = 'dreams_pending_request'

interface PendingRequest {
  worldId: string
  mode: 'start' | 'action'
  input: string
  opts?: { summarize?: boolean; expand?: boolean }
  hiddenPreset?: string
  startedAt: number
}

function savePendingRequest(req: PendingRequest): void {
  try { localStorage.setItem(PENDING_KEY, JSON.stringify(req)); console.log(`[pending] save: worldId=${req.worldId} mode=${req.mode} input="${req.input.slice(0, 30)}"`) } catch { /* ignore */ }
}

function loadPendingRequest(): PendingRequest | null {
  try {
    const s = localStorage.getItem(PENDING_KEY)
    if (!s) return null
    const req = JSON.parse(s) as PendingRequest
    console.log(`[pending] load: worldId=${req.worldId} mode=${req.mode} startedAt=${req.startedAt}`)
    return req
  } catch { return null }
}

function clearPendingRequest(): void {
  try { localStorage.removeItem(PENDING_KEY); console.log('[pending] clear') } catch { /* ignore */ }
}

// 将 AI 返回的世界书更新合并进现有世界书：按 title 匹配更新，否则新增
// 仅当世界已拥有 lorebook 字段时才合并（避免旧世界被意外创建世界书）
function mergeLoreUpdates(world: World, updates: LoreEntry[] | undefined): LoreEntry[] | null {
  if (!updates || updates.length === 0) return null
  if (!Array.isArray(world.lorebook)) return null
  const book: LoreEntry[] = world.lorebook.map((e) => ({ ...e }))
  for (const u of updates) {
    const title = (u.title ?? '').trim()
    const idx = title ? book.findIndex((b) => (b.title ?? '').trim() === title) : -1
    if (idx >= 0) {
      book[idx] = { ...book[idx], title: u.title, tags: u.tags, content: u.content, required: u.required, hidden: u.hidden }
    } else {
      book.push({ ...u })
    }
  }
  return book
}

export const useAdventureStore = defineStore('adventure', {
  state: () => ({
    worldId: null as string | null,
    currentSave: null as SaveData | null,
    pages: [] as StoryPage[],
    currentIndex: -1,
    savePoints: [] as SavePoint[],
    loading: false,
    error: null as string | null,
    opened: false,
    lastInput: null as string | null,
    lastMode: null as 'start' | 'action' | null,
    lastStartOpts: null as { summarize?: boolean; expand?: boolean } | null,
    lastHiddenPreset: null as string | undefined | null,
    eggBgmPending: null as string | null,
    draftInput: '',
    pendingRetry: null as null | {
      input: string
      save: SaveData
      pages: StoryPage[]
      currentIndex: number
      lorebook: LoreEntry[] | null
    },
  }),
  getters: {
    hasAdventure(state): boolean {
      return state.currentSave !== null
    },
    currentPage(state): StoryPage | null {
      if (state.currentIndex >= 0 && state.currentIndex < state.pages.length) {
        return state.pages[state.currentIndex]
      }
      return null
    },
  },
  actions: {
    async open(worldId: string | null) {
      if (this.worldId === worldId && this.opened) return
      this.worldId = worldId
      this.currentSave = null
      this.pages = []
      this.currentIndex = -1
      this.savePoints = []
      this.error = null
      this.loading = false
      this.opened = false
      this.lastInput = null
      this.lastMode = null
      this.lastStartOpts = null
      this.lastHiddenPreset = null
      this.eggBgmPending = null
      this.draftInput = ''
      if (!worldId) {
        this.opened = true
        return
      }
      const state = await getState(worldId)
      if (this.worldId !== worldId) return
      const pages = await listPages(worldId)
      if (this.worldId !== worldId) return
      const sps = await listSavePoints(worldId)
      if (this.worldId !== worldId) return
      if (state && state.currentSave) {
        this.currentSave = state.currentSave
        this.currentIndex = state.currentIndex
      }
      this.pages = pages
      this.savePoints = sps
      if (this.pages.length > 0) {
        if (this.currentIndex < 0 || this.currentIndex >= this.pages.length) {
          this.currentIndex = this.pages.length - 1
        }
      } else {
        this.currentIndex = -1
      }
      // 检测后台中断的请求：若 localStorage 中有本世界的 pending request，
      // 且状态未在请求之后更新过，说明请求被进程杀死中断，提示用户重试
      const pending = loadPendingRequest()
      if (pending && pending.worldId === worldId) {
        const stateUpdatedAt = state?.updatedAt ?? 0
        if (stateUpdatedAt > pending.startedAt) {
          // 状态在请求开始之后更新过 → 请求已成功，只是没来得及清除标记
          clearPendingRequest()
        } else {
          // 请求被中断：恢复重试所需的信息并提示用户
          this.lastInput = pending.input
          this.lastMode = pending.mode
          if (pending.mode === 'start') {
            this.lastStartOpts = pending.opts ?? null
            this.lastHiddenPreset = pending.hiddenPreset ?? null
          }
          this.error = '上次请求因应用转入后台可能被系统中断，请点「重试」重新发送'
          clearPendingRequest()
        }
      }
      this.opened = true
    },
    async persistState() {
      if (!this.worldId) return
      const state: WorldState = {
        worldId: this.worldId,
        currentSave: clone(this.currentSave as SaveData),
        currentIndex: this.currentIndex,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }
      await putState(state)
    },
    async startAdventure(characterInput: string, opts: { summarize?: boolean; expand?: boolean } = {}, hiddenPreset?: string) {
      const world = useWorldStore().currentWorld
      const worldId = this.worldId
      if (!world || !worldId) {
        this.error = '未选择世界，无法开始冒险'
        return
      }
      this.lastInput = characterInput
      this.lastMode = 'start'
      this.lastStartOpts = opts
      this.lastHiddenPreset = hiddenPreset
      this.pendingRetry = null
      this.loading = true
      this.error = null
      savePendingRequest({ worldId, mode: 'start', input: characterInput, opts, hiddenPreset, startedAt: Date.now() })
      try {
        let actualInput = characterInput
        const eggEntry = world.lorebook?.find((e) => {
          if (!e.hidden) return false
          const name = (e.title ?? '').trim()
          if (!name) return false
          const prefix = `扮演${name}`
          if (!characterInput.startsWith(prefix)) return false
          const next = characterInput[prefix.length]
          return !next || next === '。' || next === '.' || next === ' ' || next === '\n' || next === '\t'
        })
        if (eggEntry) {
          const name = (eggEntry.title ?? '').trim()
          const prefix = `扮演${name}`
          const after = characterInput.slice(prefix.length)
          const extra = after.replace(/^[。.\s]+/, '').trim()
          actualInput = extra ? `${eggEntry.content}\n\n【玩家补充】${extra}` : eggEntry.content
          const newLorebook = (world.lorebook ?? []).filter((e) => e.id !== eggEntry.id)
          await useWorldStore().updateWorld(worldId, { lorebook: newLorebook })
          if (this.worldId !== worldId) return
          const bgmTag = (eggEntry.tags ?? []).find((t) => t.startsWith('eggBgm:'))
          if (bgmTag) this.eggBgmPending = bgmTag.slice('eggBgm:'.length)
        }
        const freshWorld = useWorldStore().currentWorld ?? world
        const config = useSettingsStore().config
        const result = await generateCharacter(
          freshWorld,
          actualInput,
          config,
          opts,
          useSettingsStore().detailedBag,
          hiddenPreset,
        )
        if (this.worldId !== worldId) return
        await deletePagesFrom(worldId, -1)
        if (this.worldId !== worldId) return
        const merged = mergeLoreUpdates(freshWorld, result.loreUpdates)
        if (merged) {
          await useWorldStore().updateWorld(worldId, { lorebook: merged })
        }
        const page: StoryPage = {
          id: createId(),
          worldId,
          index: 0,
          playerInput: characterInput,
          narration: result.narration,
          options: result.options,
          createdAt: Date.now(),
        }
        await putPage(page)
        if (this.worldId !== worldId) return
        this.currentSave = result.save
        this.pages = [page]
        this.currentIndex = 0
        await this.persistState()
        void useWorldStore().touch(worldId)
      } catch (e) {
        this.error = errorMessage(e, useSettingsStore().devMode)
      } finally {
        this.loading = false
        clearPendingRequest()
      }
    },
    async takeAction(input: string) {
      const world = useWorldStore().currentWorld
      const worldId = this.worldId
      if (!world || !worldId || !this.currentSave) {
        this.error = '尚未开始冒险，无法采取行动'
        return
      }
      this.lastInput = input
      this.lastMode = 'action'
      // 保存"本次行动前"的完整临时快照，供"回退重来"使用
      this.pendingRetry = {
        input,
        save: clone(this.currentSave),
        pages: clone(this.pages),
        currentIndex: this.currentIndex,
        lorebook: world && Array.isArray(world.lorebook) ? clone(world.lorebook) : null,
      }
      this.loading = true
      this.error = null
      savePendingRequest({ worldId, mode: 'action', input, startedAt: Date.now() })
      try {
        const lastNarration = this.pages.length > 0
          ? this.pages[this.pages.length - 1].narration
          : undefined
        const config = useSettingsStore().config
        const result = await generateAction(
          world,
          this.currentSave,
          input,
          lastNarration,
          config,
          useSettingsStore().detailedBag,
        )
        if (this.worldId !== worldId) return
        // 彩蛋角色出场检测：检查 hidden lorebook 条目对应的角色是否出现在 characters 里
        if (world.lorebook) {
          for (const entry of world.lorebook) {
            if (!entry.hidden) continue
            const name = (entry.title ?? '').trim()
            if (!name) continue
            const appeared = result.save.characters.some((c) => c.name.includes(name) || name.includes(c.name))
            if (!appeared) continue
            const playedKey = `easterEgg_${name}_played`
            if (result.save.hidden[playedKey]) continue
            result.save.hidden[playedKey] = 'true'
            const bgmTag = (entry.tags ?? []).find((t) => t.startsWith('eggBgm:'))
            if (bgmTag) this.eggBgmPending = bgmTag.slice('eggBgm:'.length)
          }
        }
        const merged = mergeLoreUpdates(world, result.loreUpdates)
        if (merged) {
          await useWorldStore().updateWorld(worldId, { lorebook: merged })
        }
        const page: StoryPage = {
          id: createId(),
          worldId,
          index: this.pages.length,
          playerInput: input,
          narration: result.narration,
          options: result.options,
          createdAt: Date.now(),
        }
        await putPage(page)
        if (this.worldId !== worldId) return

        this.pages.push(page)
        this.currentSave = result.save
        this.currentIndex = page.index
        await this.persistState()
        void useWorldStore().touch(worldId)
      } catch (e) {
        this.error = errorMessage(e, useSettingsStore().devMode)
        this.pendingRetry = null
      } finally {
        this.loading = false
        clearPendingRequest()
      }
    },
    setPage(index: number) {
      if (index >= 0 && index < this.pages.length) {
        this.currentIndex = index
      }
    },
    async createSavePoint(name: string) {
      if (!this.worldId || !this.currentSave || this.pages.length === 0) return
      const world = useWorldStore().currentWorld
      const sp: SavePoint = {
        id: createId(),
        worldId: this.worldId,
        name: name || `存档 ${this.savePoints.length + 1}`,
        save: clone(this.currentSave),
        pageIndex: this.pages.length - 1,
        lorebook: world && Array.isArray(world.lorebook) ? clone(world.lorebook) : undefined,
        worldSetting: world ? world.worldSetting : undefined,
        panelSchema: world ? clone(world.panelSchema) : undefined,
        createdAt: Date.now(),
      }
      await putSavePoint(sp)
      this.savePoints.unshift(sp)
    },
    async loadSavePoint(sp: SavePoint) {
      const worldId = this.worldId
      if (!worldId) return
      const worldStore = useWorldStore()
      // 恢复存档时的完整世界快照（核心设定 + 面板字段 + 世界书），确保时间线一致
      if (sp.lorebook !== undefined || sp.worldSetting !== undefined || sp.panelSchema !== undefined) {
        await worldStore.updateWorld(worldId, {
          ...(sp.lorebook !== undefined ? { lorebook: clone(sp.lorebook) } : {}),
          ...(sp.worldSetting !== undefined ? { worldSetting: sp.worldSetting } : {}),
          ...(sp.panelSchema !== undefined ? { panelSchema: clone(sp.panelSchema) } : {}),
        })
        if (this.worldId !== worldId) return
      }
      const world = worldStore.currentWorld
      const newSave = world ? normalizeSave(sp.save, world.panelSchema) : clone(sp.save)
      const allPages = await listPages(worldId)
      if (this.worldId !== worldId) return
      await deletePagesFrom(worldId, sp.pageIndex)
      if (this.worldId !== worldId) return
      this.currentSave = newSave
      this.pages = allPages.filter((p) => p.index <= sp.pageIndex)
      this.currentIndex = this.pages.length > 0 ? this.pages.length - 1 : -1
      await this.persistState()
    },
    async removeSavePoint(id: string) {
      await deleteSavePoint(id)
      this.savePoints = this.savePoints.filter((sp) => sp.id !== id)
    },
    async resetAdventure() {
      const worldId = this.worldId
      if (!worldId) return
      await deleteState(worldId)
      if (this.worldId !== worldId) return
      clearPendingRequest()
      this.currentSave = null
      this.pages = []
      this.currentIndex = -1
      this.lastInput = null
      this.lastMode = null
      this.lastStartOpts = null
      this.lastHiddenPreset = null
      this.eggBgmPending = null
      this.pendingRetry = null
      this.draftInput = ''
      this.error = null
    },
    async retry() {
      if (!this.lastInput || !this.lastMode || this.loading) return
      if (this.lastMode === 'start') {
        await this.startAdventure(this.lastInput, this.lastStartOpts ?? {}, this.lastHiddenPreset ?? undefined)
      } else {
        await this.takeAction(this.lastInput)
      }
    },
    async rollbackLast(): Promise<string | null> {
      const snap = this.pendingRetry
      const worldId = this.worldId
      if (!snap || !worldId || this.loading) return null
      const worldStore = useWorldStore()
      if (snap.lorebook !== null) {
        await worldStore.updateWorld(worldId, { lorebook: clone(snap.lorebook) })
        if (this.worldId !== worldId) return null
      }
      const world = worldStore.currentWorld
      await deletePagesFrom(worldId, snap.currentIndex)
      if (this.worldId !== worldId) return null
      this.currentSave = world ? normalizeSave(snap.save, world.panelSchema) : clone(snap.save)
      this.pages = clone(snap.pages)
      this.currentIndex = snap.currentIndex
      await this.persistState()
      this.pendingRetry = null
      return snap.input
    },
    async renormalize() {
      const world = useWorldStore().currentWorld
      if (!world || !this.currentSave) return
      this.currentSave = normalizeSave(this.currentSave, world.panelSchema)
      try {
        await this.persistState()
      } catch {
        // 持久化失败不阻塞 UI
      }
    },
    async updateCharacterProfile(text: string) {
      if (!this.currentSave) return
      this.currentSave = { ...this.currentSave, characterProfile: text }
      try {
        await this.persistState()
      } catch {
        // 持久化失败不阻塞 UI
      }
    },
    exportAdventure(): unknown | null {
      const world = useWorldStore().currentWorld
      if (!world || !this.currentSave) return null
      return {
        type: 'dreams-adventure',
        version: 1,
        world: {
          name: world.name,
          worldSetting: world.worldSetting,
          lorebook: world.lorebook ? clone(world.lorebook) : [],
          panelSchema: world.panelSchema,
        },
        currentSave: this.currentSave,
        currentIndex: this.currentIndex,
        pages: this.pages,
        savePoints: this.savePoints,
      }
    },
    async importAdventure(raw: unknown): Promise<string> {
      const data = raw as Record<string, any>
      if (!data || data.type !== 'dreams-adventure') {
        throw new Error('无效的冒险存档文件')
      }
      const worldData = data.world as Record<string, any>
      if (!worldData) throw new Error('无效的世界设定数据')
      const name = typeof worldData.name === 'string' && worldData.name.trim() ? worldData.name : '导入的世界'
      const worldSetting = typeof worldData.worldSetting === 'string' ? worldData.worldSetting : ''
      const rawSchema = Array.isArray(worldData.panelSchema) ? worldData.panelSchema : []
      const seen = new Set<string>()
      const panelSchema: PanelField[] = []
      for (const item of rawSchema) {
        const f = item as Record<string, unknown>
        if (!f || typeof f.key !== 'string' || typeof f.label !== 'string') continue
        const key = f.key.trim()
        const label = f.label.trim()
        if (!key || !label || seen.has(key)) continue
        seen.add(key)
        panelSchema.push({
          key,
          label,
          type: f.type === 'number' ? 'number' : 'text',
          unit: typeof f.unit === 'string' && f.unit.trim() ? f.unit.trim() : undefined,
        })
      }
      if (panelSchema.length === 0) throw new Error('无效的角色面板字段')
      if (!data.currentSave || typeof data.currentSave !== 'object') {
        throw new Error('无效的冒险存档文件：缺少当前存档数据')
      }

      const rawLorebook = Array.isArray(worldData.lorebook) ? normalizeImportedLorebook(worldData.lorebook) : []
      const worldStore = useWorldStore()
      const world = await worldStore.createWorld(name, worldSetting, panelSchema, rawLorebook)

      try {
        const rawPages = Array.isArray(data.pages) ? data.pages : []
        const validRawPages: Array<{
          origIndex: number
          playerInput: string
          narration: string
          options: string[]
          createdAt: number
        }> = []
        for (const p of rawPages) {
          if (!p || typeof p.playerInput !== 'string' || typeof p.narration !== 'string') continue
          validRawPages.push({
            origIndex: typeof p.index === 'number' ? p.index : validRawPages.length,
            playerInput: p.playerInput,
            narration: p.narration,
            options: Array.isArray(p.options) ? p.options.filter((x: unknown) => typeof x === 'string') : [],
            createdAt: typeof p.createdAt === 'number' ? p.createdAt : Date.now(),
          })
        }
        validRawPages.sort((a, b) => a.origIndex - b.origIndex)
        const indexMap = new Map<number, number>()
        for (let i = 0; i < validRawPages.length; i++) {
          indexMap.set(validRawPages[i].origIndex, i)
          await putPage({
            id: createId(),
            worldId: world.id,
            index: i,
            playerInput: validRawPages[i].playerInput,
            narration: validRawPages[i].narration,
            options: validRawPages[i].options,
            createdAt: validRawPages[i].createdAt,
          })
        }

        const rawSPs = Array.isArray(data.savePoints) ? data.savePoints : []
        for (const sp of rawSPs) {
          if (!sp || typeof sp.name !== 'string') continue
          const origPageIndex = typeof sp.pageIndex === 'number' ? sp.pageIndex : 0
          const spLorebook = Array.isArray(sp.lorebook) ? normalizeImportedLorebook(sp.lorebook) : undefined
          await putSavePoint({
            id: createId(),
            worldId: world.id,
            name: sp.name,
            save: normalizeSave(sp.save, panelSchema),
            pageIndex: indexMap.get(origPageIndex) ?? Math.min(origPageIndex, validRawPages.length - 1),
            lorebook: spLorebook,
            createdAt: typeof sp.createdAt === 'number' ? sp.createdAt : Date.now(),
          })
        }

        const currentSave = normalizeSave(data.currentSave, panelSchema)
        const origCurrentIndex = typeof data.currentIndex === 'number' ? data.currentIndex : 0
        const currentIndex =
          indexMap.get(origCurrentIndex) ?? Math.max(0, Math.min(origCurrentIndex, validRawPages.length - 1))
        await putState({
          worldId: world.id,
          currentSave,
          currentIndex,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      } catch (e) {
        await worldStore.removeWorld(world.id)
        throw e
      }

      await this.open(world.id)
      return world.id
    },
  },
})