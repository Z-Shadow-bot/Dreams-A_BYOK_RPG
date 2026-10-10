import { defineStore } from 'pinia'
import { listWorlds, putWorld, deleteWorld, getWorld } from '@/db'
import { removeDlcAudio } from '@/dlc'
import { clearBgmCache, stopBgm, isBgmFromDlc } from '@/audio/bgm'
import type { World, PanelField, LoreEntry, PresetCharacter } from '@/types'
import { createId } from '@/types'

export function normalizeImportedLorebook(raw: unknown[]): LoreEntry[] {
  const result: LoreEntry[] = []
  for (const item of raw) {
    const e = (item ?? {}) as Record<string, unknown>
    const content = typeof e.content === 'string' && e.content.trim() ? e.content.trim() : ''
    if (!content) continue
    const tags = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => !!t)
      : []
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : undefined
    result.push({ id: createId(), title, tags, content, required: !!e.required, hidden: e.hidden === true ? true : undefined })
  }
  return result
}

export const useWorldStore = defineStore('world', {
  state: () => ({
    worlds: [] as World[],
    currentWorldId: null as string | null,
    loaded: false,
  }),
  getters: {
    currentWorld(state): World | null {
      return state.worlds.find((w) => w.id === state.currentWorldId) ?? null
    },
  },
  actions: {
    async load() {
      try {
        this.worlds = await listWorlds()
        // 旧版本创建的世界没有原始快照：用当前值补一份，保证"重新开始冒险/复制世界"可用
        for (const w of this.worlds) {
          if (!w.original) {
            w.original = {
              worldSetting: w.worldSetting,
              lorebook: w.lorebook ? JSON.parse(JSON.stringify(w.lorebook)) as LoreEntry[] : [],
              panelSchema: JSON.parse(JSON.stringify(w.panelSchema)) as PanelField[],
            }
            await putWorld(w)
          }
        }
        // 默认选中最近更新的世界
        if (!this.currentWorldId && this.worlds.length > 0) {
          this.currentWorldId = this.worlds[0].id
        }
      } catch {
        this.worlds = []
      }
      this.loaded = true
    },
    async createWorld(
    name: string,
    worldSetting: string,
    panelSchema: PanelField[],
    lorebook: LoreEntry[] = [],
  ): Promise<World> {
    const now = Date.now()
    const world: World = {
      id: createId(),
      name,
      worldSetting,
      lorebook,
      panelSchema,
      createdAt: now,
      updatedAt: now,
      original: {
        worldSetting,
        lorebook: JSON.parse(JSON.stringify(lorebook)) as LoreEntry[],
        panelSchema: JSON.parse(JSON.stringify(panelSchema)) as PanelField[],
      },
    }
    await putWorld(world)
    this.worlds.unshift(world)
    this.currentWorldId = world.id
    return world
  },
    async createDlcWorld(
      name: string,
      worldSetting: string,
      panelSchema: PanelField[],
      dlc: {
        dlcId: string
        sceneField: string
        bgm: Record<string, string>
        lorebook?: LoreEntry[]
        presetCharacters?: PresetCharacter[]
      },
    ): Promise<World> {
      const now = Date.now()
      const world: World = {
        id: createId(),
        name,
        worldSetting,
        lorebook: dlc.lorebook,
        panelSchema,
        createdAt: now,
        updatedAt: now,
        original: {
          worldSetting,
          lorebook: dlc.lorebook ? JSON.parse(JSON.stringify(dlc.lorebook)) as LoreEntry[] : [],
          panelSchema: JSON.parse(JSON.stringify(panelSchema)) as PanelField[],
        },
        dlcId: dlc.dlcId,
        sceneField: dlc.sceneField,
        bgm: dlc.bgm,
        presetCharacters: dlc.presetCharacters,
      }
      await putWorld(world)
      this.worlds.unshift(world)
      this.currentWorldId = world.id
      return world
    },
    async removeWorld(id: string) {
      const w = this.worlds.find((x) => x.id === id)
      if (w?.dlcId) {
        if (isBgmFromDlc(w.dlcId)) await stopBgm()
        // 多个世界可能共享同一 DLC 音乐资源（如"复制世界"生成的副本），仅当没有其他世界还在使用时才删除音频
        const stillUsed = this.worlds.some((x) => x.id !== id && x.dlcId === w.dlcId)
        if (!stillUsed) {
          await removeDlcAudio(w.dlcId)
          clearBgmCache(w.dlcId)
        }
      }
      await deleteWorld(id)
      this.worlds = this.worlds.filter((w) => w.id !== id)
      if (this.currentWorldId === id) {
        this.currentWorldId = this.worlds[0]?.id ?? null
      }
    },
    async refreshWorld(id: string) {
      const w = await getWorld(id)
      if (w) {
        const idx = this.worlds.findIndex((x) => x.id === id)
        if (idx >= 0) this.worlds[idx] = w
      }
    },
    selectWorld(id: string | null) {
      this.currentWorldId = id
    },
    async touch(id: string) {
      const w = this.worlds.find((x) => x.id === id)
      if (!w) return
      const updated: World = { ...w, updatedAt: Date.now() }
      await putWorld(updated)
      w.updatedAt = updated.updatedAt
    },
    async updateWorld(
    id: string,
    updates: { name?: string; worldSetting?: string; panelSchema?: PanelField[]; lorebook?: LoreEntry[] },
  ) {
    const w = this.worlds.find((x) => x.id === id)
    if (!w) return
    const updated: World = {
      ...w,
      name: updates.name !== undefined ? updates.name : w.name,
      worldSetting: updates.worldSetting !== undefined ? updates.worldSetting : w.worldSetting,
      panelSchema: updates.panelSchema !== undefined ? updates.panelSchema : w.panelSchema,
      lorebook: updates.lorebook !== undefined ? updates.lorebook : w.lorebook,
      updatedAt: Date.now(),
    }
    await putWorld(updated)
    w.name = updated.name
    w.worldSetting = updated.worldSetting
    w.panelSchema = updated.panelSchema
    w.lorebook = updated.lorebook
    w.updatedAt = updated.updatedAt
    },
    // 基于世界的原始快照（旧世界无快照时用当前值）复制生成新世界，用于尝试多条冒险路线
    async duplicateWorld(id: string): Promise<World | null> {
      const src = this.worlds.find((w) => w.id === id)
      if (!src) return null
      const snapshot = src.original ?? {
        worldSetting: src.worldSetting,
        lorebook: src.lorebook ? JSON.parse(JSON.stringify(src.lorebook)) as LoreEntry[] : [],
        panelSchema: JSON.parse(JSON.stringify(src.panelSchema)) as PanelField[],
      }
      let n = 1
      let name = `${src.name}-副本1`
      const existed = new Set(this.worlds.map((w) => w.name))
      while (existed.has(name)) {
        n += 1
        name = `${src.name}-副本${n}`
      }
      const now = Date.now()
      const world: World = {
        id: createId(),
        name,
        worldSetting: snapshot.worldSetting,
        lorebook: JSON.parse(JSON.stringify(snapshot.lorebook)) as LoreEntry[],
        panelSchema: JSON.parse(JSON.stringify(snapshot.panelSchema)) as PanelField[],
        createdAt: now,
        updatedAt: now,
        original: JSON.parse(JSON.stringify(snapshot)) as World['original'],
        // 副本沿用 DLC 音乐与场景配置（与原件共享 dlcId 目录），预设角色选项一并保留
        dlcId: src.dlcId,
        sceneField: src.sceneField,
        bgm: src.bgm ? JSON.parse(JSON.stringify(src.bgm)) : undefined,
        presetCharacters: src.presetCharacters
          ? JSON.parse(JSON.stringify(src.presetCharacters)) as PresetCharacter[]
          : undefined,
      }
      await putWorld(world)
      this.worlds.unshift(world)
      this.currentWorldId = world.id
      return world
    },
    // 更新 DLC 世界元数据（bgm/sceneField 等），用于重新导入同名 DLC 时保留存档
    async updateDlcWorldMeta(
      id: string,
      meta: {
        worldSetting?: string
        panelSchema?: PanelField[]
        lorebook?: LoreEntry[]
        bgm?: Record<string, string>
        sceneField?: string
        presetCharacters?: PresetCharacter[]
      },
    ) {
      const w = this.worlds.find((x) => x.id === id)
      if (!w) return
      const updated: World = {
        ...w,
        worldSetting: meta.worldSetting !== undefined ? meta.worldSetting : w.worldSetting,
        panelSchema: meta.panelSchema !== undefined ? meta.panelSchema : w.panelSchema,
        lorebook: meta.lorebook !== undefined ? meta.lorebook : w.lorebook,
        bgm: meta.bgm !== undefined ? meta.bgm : w.bgm,
        sceneField: meta.sceneField !== undefined ? meta.sceneField : w.sceneField,
        presetCharacters: meta.presetCharacters !== undefined ? meta.presetCharacters : w.presetCharacters,
        updatedAt: Date.now(),
      }
      await putWorld(updated)
      w.worldSetting = updated.worldSetting
      w.panelSchema = updated.panelSchema
      w.lorebook = updated.lorebook
      w.bgm = updated.bgm
      w.sceneField = updated.sceneField
      w.presetCharacters = updated.presetCharacters
      w.updatedAt = updated.updatedAt
    },
    exportWorld(id: string): unknown | null {
      const w = this.worlds.find((x) => x.id === id)
      if (!w) return null
      return {
        type: 'dreams-world',
        version: 1,
        name: w.name,
        worldSetting: w.worldSetting,
        lorebook: w.lorebook ? JSON.parse(JSON.stringify(w.lorebook)) : [],
        panelSchema: w.panelSchema,
      }
    },
    async importWorld(raw: unknown): Promise<World> {
      const data = raw as Record<string, any>
      if (!data || data.type !== 'dreams-world') {
        throw new Error('无效的世界设定文件')
      }
      const name = typeof data.name === 'string' && data.name.trim() ? data.name : '导入的世界'
      const worldSetting = typeof data.worldSetting === 'string' ? data.worldSetting : ''
      const lorebook = Array.isArray(data.lorebook)
        ? normalizeImportedLorebook(data.lorebook)
        : []
      const rawSchema = Array.isArray(data.panelSchema) ? data.panelSchema : []
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
      if (panelSchema.length === 0) {
        throw new Error('无效的角色面板字段')
      }
      return this.createWorld(name, worldSetting, panelSchema, lorebook)
    },
  },
})