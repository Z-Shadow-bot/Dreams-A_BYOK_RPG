import { defineStore } from 'pinia'
import {
  getState,
  putState,
  listPages,
  putPage,
  deletePagesFrom,
  replacePages,
  deleteState,
  listSavePoints,
  putSavePoint,
  deleteSavePoint,
} from '@/db'
import { generateAction, generateCharacter, normalizeSave, syncAfterRewrite, ensureOptions } from '@/ai/service'
import { errorMessage } from '@/ai/client'
import { createId } from '@/types'
import type { SaveData, StoryPage, SavePoint, WorldState, PanelField, LoreEntry, World, PresetCharacter } from '@/types'
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

// 归一化的比对键：去空格并统一大小写，用于 title/aliases 匹配
function loreKey(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

// 判断更新项（title + aliases）是否指向已有条目 b（title 或 aliases 任一命中即为同一实体）
function loreMatches(b: LoreEntry, title: string, aliases: string[]): boolean {
  const incoming = [title, ...aliases].map(loreKey).filter((k) => !!k)
  if (incoming.length === 0) return false
  const targets = [b.title ?? '', ...(b.aliases ?? [])].map(loreKey).filter((k) => !!k)
  return incoming.some((k) => targets.includes(k))
}

// 将 AI 返回的世界书更新合并进现有世界书：按 title/aliases 匹配更新（含同义不同名合并），否则新增
// remove 标记：仅当条目完全重复或记录错误时 AI 返回 { title, remove: true }，删除对应条目
// 仅当世界已拥有 lorebook 字段时才合并（避免旧世界被意外创建世界书）
function mergeLoreUpdates(world: World, updates: LoreEntry[] | undefined): LoreEntry[] | null {
  if (!updates || updates.length === 0) return null
  if (!Array.isArray(world.lorebook)) return null
  const book: LoreEntry[] = world.lorebook.map((e) => ({ ...e }))
  for (const u of updates) {
    const title = (u.title ?? '').trim()
    const aliases = (u.aliases ?? []).map((a) => a.trim()).filter((a) => !!a)
    // 按 title/aliases 双向匹配定位已有条目（同义不同名视为同一条）
    const idx = title || aliases.length > 0 ? book.findIndex((b) => loreMatches(b, title, aliases)) : -1
    // 删除条目：按 title/aliases 匹配删除（fixed 条目不可删除）
    if (u.remove === true) {
      if (idx >= 0 && !book[idx].fixed) {
        book.splice(idx, 1)
      }
      continue
    }
    if (idx >= 0) {
      const old = book[idx]
      // 固定条目：AI 不得修改内容/tags/title/fixed/links，仅允许移除 hidden（彩蛋出场）
      if (old.fixed) {
        if (u.hidden === false || u.hidden === undefined) {
          book[idx] = { ...old, hidden: undefined }
        }
        continue
      }
      const newTitle = title || old.title
      // 合并别名：保留旧别名；改名时把旧标题转为别名；并入本次新别名
      const mergedAliases = new Set<string>()
      for (const a of old.aliases ?? []) mergedAliases.add(a)
      for (const a of aliases) mergedAliases.add(a)
      if ((old.title ?? '').trim() && loreKey(old.title) !== loreKey(newTitle)) {
        mergedAliases.add((old.title ?? '').trim())
      }
      // 去掉与当前标题重复的别名
      const titleKey = loreKey(newTitle)
      for (const a of [...mergedAliases]) {
        if (loreKey(a) === titleKey) mergedAliases.delete(a)
      }
      book[idx] = {
        ...old,
        title: newTitle,
        aliases: mergedAliases.size > 0 ? [...mergedAliases] : undefined,
        tags: u.tags,
        content: u.content,
        required: u.required,
        fixed: u.fixed,
        links: u.links,
        hidden: u.hidden,
        isLocation: u.isLocation,
        isCharacter: u.isCharacter,
      }
    } else {
      book.push({ ...u, remove: undefined, aliases: aliases.length > 0 ? aliases : undefined })
    }
  }
  return book
}

// 用世界书的 title/aliases 校正存档中的 active 名称：
// 条目改名后，存档 activeLocations/activeCharacters 可能仍以旧称呼（现已成为该条目的别名）出现，
// 这里将其替换为条目的当前标题，避免状态页按 title 匹配/排序失效。
function syncActiveNamesWithLorebook(save: SaveData | null, lorebook: LoreEntry[] | null | undefined): void {
  if (!save || !Array.isArray(lorebook)) return
  const titleKeys = new Set<string>()
  for (const e of lorebook) {
    const t = (e.title ?? '').trim()
    if (t) titleKeys.add(loreKey(t))
  }
  const aliasToTitle = new Map<string, string>()
  for (const e of lorebook) {
    const t = (e.title ?? '').trim()
    if (!t) continue
    const tKey = loreKey(t)
    for (const a of e.aliases ?? []) {
      const aKey = loreKey(a)
      // 跳过空值、与标题同名的别名，以及本身已是其它条目正式标题的别名
      if (!aKey || aKey === tKey || titleKeys.has(aKey)) continue
      aliasToTitle.set(aKey, t)
    }
  }
  if (aliasToTitle.size === 0) return
  const fix = (arr?: string[]) => {
    if (!Array.isArray(arr)) return
    for (let i = 0; i < arr.length; i++) {
      const cur = (arr[i] ?? '').trim()
      const mapped = aliasToTitle.get(loreKey(cur))
      if (mapped && cur !== mapped) arr[i] = mapped
    }
  }
  fix(save.activeLocations)
  fix(save.activeCharacters)
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
    recoveryNote: null as string | null, // 截断自动降级时展示的提示文案
    loadingEndTime: 0, // 最近一次生成完成的毫秒时间戳（用于返回冒险页时判断是否需要滚动到顶部）
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
      this.loadingEndTime = Date.now()
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
        // 兜底：读档时若存档早于条目改名，用当前世界书校正 active 中的旧称呼
        syncActiveNamesWithLorebook(this.currentSave, useWorldStore().currentWorld?.lorebook)
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
      this.recoveryNote = null
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
        result.options = await ensureOptions(result.options, result.narration, config, useSettingsStore().optionFallback)
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
        syncActiveNamesWithLorebook(this.currentSave, merged ?? freshWorld.lorebook)
        this.pages = [page]
        this.currentIndex = 0
        await this.persistState()
        void useWorldStore().touch(worldId)
      } catch (e) {
        this.error = errorMessage(e, useSettingsStore().devMode)
      } finally {
        this.loading = false
      this.loadingEndTime = Date.now()
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
      this.recoveryNote = null
      savePendingRequest({ worldId, mode: 'action', input, startedAt: Date.now() })
      try {
        const lastNarration = this.pages.length > 0
          ? this.pages[this.pages.length - 1].narration
          : undefined
        const config = useSettingsStore().config
        const s = useSettingsStore()
        // 玩家改写同步：若最新一页被改写，先让 AI 以改写版为准校正世界书与存档，再继续行动
        const latestEdited = this.pages.length > 0 && this.pages[this.pages.length - 1].edited
          ? this.pages[this.pages.length - 1]
          : null
        if (latestEdited) {
          this.recoveryNote = '检测到页面改写，正在与世界书和存档同步…'
          try {
            const sync = await syncAfterRewrite(world, this.currentSave, latestEdited, config)
            if (this.worldId !== worldId) return
            this.currentSave = sync.save
            const syncedMerged = mergeLoreUpdates(world, sync.loreUpdates)
            syncActiveNamesWithLorebook(this.currentSave, syncedMerged ?? world.lorebook)
            if (syncedMerged) {
              await useWorldStore().updateWorld(worldId, { lorebook: syncedMerged })
            }
            // 清除改写标记，避免每轮重复同步
            const cleared = { ...latestEdited, edited: undefined }
            this.pages[this.pages.length - 1] = cleared
            await putPage(cleared)
            this.recoveryNote = null
          } catch (syncErr) {
            this.recoveryNote = null
            this.error = `改写同步失败（${errorMessage(syncErr, s.devMode)}），将按当前状态继续行动`
          }
          if (this.worldId !== worldId) return
        }
        const result = await generateAction(
          world,
          this.currentSave,
          input,
          lastNarration,
          config,
          s.detailedBag,
          s.narrativeSpeed,
          () => {
            this.recoveryNote = '文本较长，正在优化生成方式，请稍候…'
          },
        )
        if (this.worldId !== worldId) return
        result.options = await ensureOptions(result.options, result.narration, config, s.optionFallback)
        // 彩蛋角色出场检测：检查 hidden lorebook 条目对应的角色是否出现在 characters 里
        if (world.lorebook) {
          for (const entry of world.lorebook) {
            if (!entry.hidden) continue
            const name = (entry.title ?? '').trim()
            if (!name) continue
            const appeared =
              (result.save.activeCharacters ?? []).some((c) => c.includes(name) || name.includes(c)) ||
              result.save.characters.some((c) => c.name.includes(name) || name.includes(c.name))
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
        syncActiveNamesWithLorebook(this.currentSave, merged ?? world.lorebook)
        this.currentIndex = page.index
        await this.persistState()
        await this.autoSaveIfDue(page.index + 1)
        void useWorldStore().touch(worldId)
      } catch (e) {
        this.error = errorMessage(e, useSettingsStore().devMode)
        this.pendingRetry = null
      } finally {
        this.loading = false
      this.loadingEndTime = Date.now()
        this.recoveryNote = null
        clearPendingRequest()
      }
    },
    setPage(index: number) {
      if (index >= 0 && index < this.pages.length) {
        this.currentIndex = index
      }
    },
    async rewritePage(index: number, newNarration: string) {
      if (index < 0 || index >= this.pages.length) return
      const trimmed = newNarration.trim()
      if (!trimmed) return
      const page = { ...this.pages[index], narration: trimmed, edited: true }
      this.pages[index] = page
      await putPage(page)
      void useWorldStore().touch(this.worldId ?? '')
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
        pages: clone(this.pages),
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
      // 优先使用完整页面快照恢复（存档内含故事页面，可完整读档）；
      // 兼容无快照的旧存档点：按 pageIndex 从数据库截断
      const snapshotPages =
        Array.isArray(sp.pages) && sp.pages.length > 0
          ? clone(sp.pages).sort((a, b) => a.index - b.index)
          : null
      if (snapshotPages) {
        await replacePages(worldId, snapshotPages)
        if (this.worldId !== worldId) return
        this.pages = snapshotPages
      } else {
        const allPages = await listPages(worldId)
        if (this.worldId !== worldId) return
        await deletePagesFrom(worldId, sp.pageIndex)
        if (this.worldId !== worldId) return
        this.pages = allPages.filter((p) => p.index <= sp.pageIndex)
      }
      this.currentSave = newSave
      this.currentIndex = this.pages.length > 0 ? this.pages.length - 1 : -1
      await this.persistState()
    },
    async removeSavePoint(id: string) {
      await deleteSavePoint(id)
      this.savePoints = this.savePoints.filter((sp) => sp.id !== id)
    },
    async renameSavePoint(id: string, name: string) {
      const sp = this.savePoints.find((x) => x.id === id)
      if (!sp) return
      const trimmed = name.trim()
      if (!trimmed) return
      const updated = { ...sp, name: trimmed }
      await putSavePoint(updated)
      const idx = this.savePoints.findIndex((x) => x.id === id)
      if (idx >= 0) this.savePoints[idx] = updated
    },
    async resetAdventure() {
      const worldId = this.worldId
      if (!worldId) return
      // 重置前把世界设定恢复到"创建时的原始快照"（世界书与核心设定可能已被剧情/玩家更新，直接清档无法真正重新开始）
      const worldStore = useWorldStore()
      const w = worldStore.currentWorld
      if (w?.original) {
        await worldStore.updateWorld(w.id, {
          worldSetting: w.original.worldSetting,
          lorebook: w.original.lorebook,
          panelSchema: w.original.panelSchema,
        })
        if (this.worldId !== worldId) return
      }
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
      this.recoveryNote = null
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
      syncActiveNamesWithLorebook(this.currentSave, world.lorebook)
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
    async updateExperience(text: string) {
      if (!this.currentSave) return
      this.currentSave = { ...this.currentSave, experience: text }
      try {
        await this.persistState()
      } catch {
        // 持久化失败不阻塞 UI
      }
    },
    // 自动存档（设置开启时）：按用户设定的周期（每 N 页）触发，存档名"自动存档-X"（X 为存档时的具体页码）
    // 每次触发都新建，不覆盖旧自动存档，给玩家充足的读档机会
    async autoSaveIfDue(pageNumber: number) {
      const worldId = this.worldId
      const world = useWorldStore().currentWorld
      if (!worldId || !this.currentSave || !world) return
      const s = useSettingsStore()
      if (!s.autoSave || pageNumber < 1) return
      const interval = Math.max(1, Math.round(s.autoSaveInterval) || 10)
      if (pageNumber % interval !== 0) return
      await this.createSavePoint(`自动存档-${pageNumber}`)
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
          ...(world.dlcId ? { dlcId: world.dlcId } : {}),
          ...(world.sceneField ? { sceneField: world.sceneField } : {}),
          ...(world.bgm ? { bgm: clone(world.bgm) } : {}),
          ...(world.presetCharacters ? { presetCharacters: clone(world.presetCharacters) } : {}),
          ...(world.characterFallback ? { characterFallback: world.characterFallback } : {}),
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

      const dlcUpdates: {
        dlcId?: string
        sceneField?: string
        bgm?: Record<string, string>
        presetCharacters?: PresetCharacter[]
        characterFallback?: string
      } = {}
      if (typeof worldData.dlcId === 'string' && worldData.dlcId) dlcUpdates.dlcId = worldData.dlcId
      if (
        typeof worldData.sceneField === 'string' &&
        worldData.sceneField &&
        panelSchema.some((f) => f.key === worldData.sceneField)
      ) {
        dlcUpdates.sceneField = worldData.sceneField
      }
      if (worldData.bgm && typeof worldData.bgm === 'object' && !Array.isArray(worldData.bgm)) {
        const bgm: Record<string, string> = {}
        for (const [k, v] of Object.entries(worldData.bgm as Record<string, unknown>)) {
          if (typeof k === 'string' && typeof v === 'string') bgm[k] = v
        }
        if (Object.keys(bgm).length > 0) dlcUpdates.bgm = bgm
      }
      if (Array.isArray(worldData.presetCharacters)) {
        const pcs: PresetCharacter[] = []
        for (const pc of worldData.presetCharacters as unknown[]) {
          if (!pc || typeof pc !== 'object') continue
          const r = pc as Record<string, unknown>
          if (typeof r.label !== 'string' || typeof r.description !== 'string') continue
          pcs.push({
            label: r.label,
            description: r.description,
            ...(typeof r.hidden === 'string' ? { hidden: r.hidden } : {}),
          })
        }
        if (pcs.length > 0) dlcUpdates.presetCharacters = pcs
      }
      if (typeof worldData.characterFallback === 'string' && worldData.characterFallback.trim()) {
        dlcUpdates.characterFallback = worldData.characterFallback.trim()
      }
      if (Object.keys(dlcUpdates).length > 0) {
        await worldStore.updateWorld(world.id, dlcUpdates)
      }

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
          // 页面快照同样重新映射 index，保证读档能完整恢复故事页面
          const spPages = Array.isArray(sp.pages)
            ? (sp.pages as Array<Record<string, unknown>>)
                .filter(
                  (p) => p && typeof p.playerInput === 'string' && typeof p.narration === 'string',
                )
                .map((p) => {
                  const orig = typeof p.index === 'number' ? (p.index as number) : 0
                  const mapped: StoryPage = {
                    id: createId(),
                    worldId: world.id,
                    index: indexMap.get(orig) ?? Math.min(orig, validRawPages.length - 1),
                    playerInput: p.playerInput as string,
                    narration: p.narration as string,
                    options: Array.isArray(p.options)
                      ? (p.options as unknown[]).filter((x) => typeof x === 'string') as string[]
                      : [],
                    createdAt: typeof p.createdAt === 'number' ? (p.createdAt as number) : Date.now(),
                  }
                  return mapped
                })
                .sort((a, b) => a.index - b.index)
            : undefined
          await putSavePoint({
            id: createId(),
            worldId: world.id,
            name: sp.name,
            save: normalizeSave(sp.save, panelSchema),
            pageIndex: indexMap.get(origPageIndex) ?? Math.min(origPageIndex, validRawPages.length - 1),
            pages: spPages && spPages.length > 0 ? spPages : undefined,
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