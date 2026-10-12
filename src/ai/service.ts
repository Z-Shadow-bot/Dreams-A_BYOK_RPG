import { chat, extractJson, AIError } from './client'
import {
  buildActionSystemPrompt,
  bagDetailRule,
  buildActionPrompt,
  buildCharacterGenPrompt,
  buildWorldGenPrompt,
  buildActionRecoveryDiffPrompt,
  buildActionRecoverySplitNarrationPrompt,
  buildActionRecoverySplitSavePrompt,
  buildRewriteSyncPrompt,
  buildOptionsFallbackPrompt,
  type AdventureRules,
} from './prompts'
import { useSettingsStore } from '@/stores/settings'
import type {
  APIConfig,
  AIResponse,
  CharacterEntry,
  Item,
  LoreEntry,
  MapLocation,
  PanelField,
  SaveData,
  StoryPage,
  World,
} from '@/types'
import { createId } from '@/types'

// 读取每轮叙事字数区间的安全值（兼容旧配置）
function narrationRange(config: APIConfig): { min: number; max: number } {
  const min = typeof config.narrationMin === 'number' ? config.narrationMin : 200
  const max = typeof config.narrationMax === 'number' ? config.narrationMax : 500
  return { min, max: Math.max(min, max) }
}

// ===== 深度清洗工具：防御 AI 返回非预期结构导致页面崩溃 =====
function asString(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback
}

function asStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string')
}

function normalizeItem(v: unknown): Item {
  const it = (v ?? {}) as Record<string, unknown>
  return {
    name: asString(it.name),
    quantity: typeof it.quantity === 'number' ? it.quantity : undefined,
    state: asString(it.state) || undefined,
  }
}

function normalizeLocation(v: unknown): MapLocation {
  const loc = (v ?? {}) as Record<string, unknown>
  return {
    name: asString(loc.name),
    description: asString(loc.description),
    people: asStringArray(loc.people),
    visited: !!loc.visited,
  }
}

function normalizeCharacter(v: unknown): CharacterEntry {
  const c = (v ?? {}) as Record<string, unknown>
  return {
    name: asString(c.name),
    introduction: asString(c.introduction),
    attitude: asString(c.attitude),
  }
}

// 清洗 AI 返回的存档，保证结构与 panelSchema 完全一致，防止字段漂移
export function normalizeSave(raw: unknown, panelSchema: PanelField[]): SaveData {
  const r = (raw ?? {}) as Record<string, any>
  const panel: Record<string, string | number> = {}
  for (const f of panelSchema) {
    const v = r.panel?.[f.key]
    panel[f.key] = f.type === 'number' ? (typeof v === 'number' ? v : 0) : (typeof v === 'string' ? v : '')
  }
  const hidden: Record<string, string> = {}
  if (r.hidden && typeof r.hidden === 'object' && !Array.isArray(r.hidden)) {
    for (const [k, v] of Object.entries(r.hidden)) {
      if (typeof v === 'string') {
        hidden[k] = v
        continue
      }
      try {
        const s = JSON.stringify(v)
        if (typeof s === 'string') hidden[k] = s
      } catch {
        // 不可序列化的值忽略
      }
    }
  }
  return {
    panel,
    inventory: {
      equipment: (Array.isArray(r.inventory?.equipment) ? r.inventory.equipment : []).map(normalizeItem),
      items: (Array.isArray(r.inventory?.items) ? r.inventory.items : []).map(normalizeItem),
    },
    map: (Array.isArray(r.map) ? r.map : []).map(normalizeLocation),
    characters: (Array.isArray(r.characters) ? r.characters : []).map(normalizeCharacter),
    activeLocations: asStringArray(r.activeLocations),
    activeCharacters: asStringArray(r.activeCharacters),
    characterProfile: asString(r.characterProfile),
    experience: asString(r.experience),
    overview: {
      impression: asString(r.overview?.impression),
      ongoing: asString(r.overview?.ongoing),
      recentEvents: asStringArray(r.overview?.recentEvents),
      latestProgress: asString(r.overview?.latestProgress),
    },
    hidden,
    worldTime: asString(r.worldTime),
  }
}

function normalizeOptions(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((x): x is string => typeof x === 'string').slice(0, 3)
}

// 手动更新设定开关：开启后 AI 生成的存档不得修改玩家角色人设（characterProfile 强制保持原值）
function lockProfileIfNeeded(save: SaveData, base: SaveData): SaveData {
  if (useSettingsStore().manualProfile) {
    save.characterProfile = base.characterProfile
  }
  return save
}

// 将 AI 返回的存档与当前存档智能合并（字段级增量更新）：
// AI 返回了某字段 → 用 AI 的值覆盖；未返回 → 保留旧值。
// 这样即使模型在某轮漏填/漏返回部分字段，也不会清空面板、背包、地图、人物等已有数据。
// 明确表示"清空"只需要 AI 返回空字符串或空数组。
export function mergeSave(base: SaveData, raw: unknown, panelSchema: PanelField[]): SaveData {
  const out: SaveData = JSON.parse(JSON.stringify(base)) as SaveData
  const r = (raw ?? {}) as Record<string, any>

  // 面板：仅覆盖 AI 明确返回的键，未返回的键保留原值
  if (r.panel && typeof r.panel === 'object' && !Array.isArray(r.panel)) {
    const rp = r.panel as Record<string, unknown>
    for (const f of panelSchema) {
      const v = rp[f.key]
      if (typeof v === 'number' && Number.isFinite(v)) {
        ;(out.panel as Record<string, string | number>)[f.key] = f.type === 'number' ? v : String(v)
      } else if (typeof v === 'string' && v.trim() !== '') {
        const n = Number(v)
        ;(out.panel as Record<string, string | number>)[f.key] = f.type === 'number' && Number.isFinite(n) ? n : v
      }
    }
  }

  // 数组字段：AI 明确返回数组才整体替换（缺失 = 未更新；空数组 = 明确清空）
  if (r.inventory && typeof r.inventory === 'object' && !Array.isArray(r.inventory)) {
    const inv = r.inventory as Record<string, unknown>
    if (Array.isArray(inv.equipment)) out.inventory.equipment = inv.equipment.map(normalizeItem)
    if (Array.isArray(inv.items)) out.inventory.items = inv.items.map(normalizeItem)
  }
  if (Array.isArray(r.map)) out.map = r.map.map(normalizeLocation)
  if (Array.isArray(r.characters)) out.characters = r.characters.map(normalizeCharacter)
  if (Array.isArray(r.activeLocations)) out.activeLocations = asStringArray(r.activeLocations)
  if (Array.isArray(r.activeCharacters)) out.activeCharacters = asStringArray(r.activeCharacters)

  // 字符串字段：AI 返回字符串才覆盖（空字符串 = 明确清空；缺失 = 未更新）
  if (typeof r.characterProfile === 'string') out.characterProfile = r.characterProfile
  if (typeof r.experience === 'string') out.experience = r.experience
  if (typeof r.worldTime === 'string') out.worldTime = r.worldTime

  // 概览：逐项合并
  if (r.overview && typeof r.overview === 'object' && !Array.isArray(r.overview)) {
    const o = r.overview as Record<string, unknown>
    if (typeof o.impression === 'string') out.overview.impression = o.impression
    if (typeof o.ongoing === 'string') out.overview.ongoing = o.ongoing
    if (Array.isArray(o.recentEvents)) {
      out.overview.recentEvents = o.recentEvents.filter((x): x is string => typeof x === 'string')
    }
    if (typeof o.latestProgress === 'string') out.overview.latestProgress = o.latestProgress
  }

  // 隐藏记录：AI 返回对象才应用（支持 add/remove 指令或整体对象）
  if (r.hidden && typeof r.hidden === 'object' && !Array.isArray(r.hidden)) {
    const h = r.hidden as Record<string, any>
    if (h.add && typeof h.add === 'object' && !Array.isArray(h.add)) {
      for (const [k, v] of Object.entries(h.add as Record<string, unknown>)) {
        if (typeof v === 'string') out.hidden[k] = v
        else if (v !== undefined && v !== null) {
          try {
            out.hidden[k] = JSON.stringify(v)
          } catch {
            // 不可序列化的值忽略
          }
        }
      }
    }
    if (Array.isArray(h.remove)) {
      for (const k of h.remove) {
        if (typeof k === 'string') delete out.hidden[k]
      }
    }
    if (!h.add && !h.remove) {
      for (const [k, v] of Object.entries(h)) {
        if (typeof v === 'string') out.hidden[k] = v
        else if (v !== undefined && v !== null) {
          try {
            out.hidden[k] = JSON.stringify(v)
          } catch {
            // 不可序列化的值忽略
          }
        }
      }
    }
  }

  return out
}

// 归一化单条世界书条目（AI 返回无 id，由这里分配）
function normalizeLoreEntry(v: unknown): LoreEntry | null {
  const e = (v ?? {}) as Record<string, unknown>
  const content = asString(e.content).trim()
  if (!content) return null
  const tags = asStringArray(e.tags).map((t) => t.trim()).filter((t) => !!t)
  const title = asString(e.title).trim()
  return {
    id: createId(),
    title: title || undefined,
    tags,
    content,
    required: !!e.required,
    fixed: e.fixed === true ? true : undefined,
    links: asStringArray(e.links).map((t) => t.trim()).filter((t) => !!t),
    hidden: e.hidden === true ? true : undefined,
    isLocation: e.isLocation === true ? true : undefined,
    isCharacter: e.isCharacter === true ? true : undefined,
  }
}

// 归一化世界书数组：过滤非法/空内容条目
export function normalizeLorebook(raw: unknown): LoreEntry[] {
  if (!Array.isArray(raw)) return []
  const result: LoreEntry[] = []
  for (const item of raw) {
    const e = normalizeLoreEntry(item)
    if (e) result.push(e)
  }
  return result
}

// 生成世界设定 + 角色面板字段（无世界书时 lorebook 为空数组）
export async function generateWorld(
  userInput: string,
  config: APIConfig,
  opts: { summarize?: boolean; expand?: boolean } = {},
): Promise<{ worldSetting: string; lorebook: LoreEntry[]; panelSchema: PanelField[] }> {
  const content = await chat(
    [{ role: 'user', content: buildWorldGenPrompt(userInput, opts) }],
    config,
  )
  const data = extractJson(content) as { worldSetting?: string; lorebook?: unknown[]; panelSchema?: PanelField[] }
  const aiSetting = typeof data.worldSetting === 'string' && data.worldSetting.trim() ? data.worldSetting.trim() : ''
  const lorebook = normalizeLorebook(data.lorebook)
  const worldSetting = aiSetting

  const rawSchema: unknown[] = Array.isArray(data.panelSchema) ? (data.panelSchema as unknown[]) : []
  const seenKey = new Set<string>()
  const panelSchema: PanelField[] = []
  for (const item of rawSchema) {
    const f = item as Record<string, unknown>
    if (!f || typeof f.key !== 'string' || typeof f.label !== 'string') continue
    const key = f.key.trim()
    const label = f.label.trim()
    if (!key || !label || seenKey.has(key)) continue
    seenKey.add(key)
    panelSchema.push({
      key,
      label,
      type: f.type === 'number' ? 'number' : 'text',
      unit: typeof f.unit === 'string' && f.unit ? f.unit : undefined,
    })
  }
  if (!worldSetting || panelSchema.length === 0) {
    throw new AIError('AI 生成的世界设定不完整，请重试一次')
  }
  return { worldSetting, lorebook, panelSchema }
}

// 生成角色设定 + 初始存档（含开场）
export async function generateCharacter(
  world: World,
  userInput: string,
  config: APIConfig,
  opts: { summarize?: boolean; expand?: boolean } = {},
  detailedBag: boolean = false,
  hiddenPreset?: string,
): Promise<AIResponse> {
  const { min, max } = narrationRange(config)
  const content = await chat(
    [
      { role: 'system', content: buildActionSystemPrompt(min, max) },
      { role: 'user', content: buildCharacterGenPrompt(world, userInput, min, max, opts, hiddenPreset) + bagDetailRule(detailedBag) },
    ],
    config,
  )
  const data = extractJson(content) as Record<string, any>
  return {
    narration: typeof data.narration === 'string' ? data.narration : '',
    options: normalizeOptions(data.options),
    save: normalizeSave(data.save, world.panelSchema),
    loreUpdates: normalizeLorebook(data.loreUpdates),
  }
}

// 生成行动（冒险主循环）
export async function generateAction(
  world: World,
  currentSave: SaveData,
  userInput: string,
  lastNarration: string | undefined,
  config: APIConfig,
  detailedBag: boolean = false,
  fastForward: boolean = false,
  onRecoverStart?: () => void,
): Promise<AIResponse> {
  const { min, max } = narrationRange(config)
  const system = buildActionSystemPrompt(min, max, world, detailedBag)
  const st = useSettingsStore()
  const rules: AdventureRules = { reduceEvents: st.reduceEvents, difficulty: st.difficulty }
  try {
    const content = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: buildActionPrompt(world, currentSave, userInput, lastNarration, fastForward, rules),
        },
      ],
      config,
    )
    const data = extractJson(content) as Record<string, any>
    return {
      narration: typeof data.narration === 'string' ? data.narration : '',
      options: normalizeOptions(data.options),
      save: lockProfileIfNeeded(mergeSave(currentSave, data.save, world.panelSchema), currentSave),
      loreUpdates: normalizeLorebook(data.loreUpdates),
    }
  } catch (e) {
    if (e instanceof AIError && e.truncated) {
      // 输出被截断：按用户设置的策略自动降级重试，避免再次截断
      onRecoverStart?.()
      return recoverAction(world, currentSave, userInput, lastNarration, config, detailedBag, fastForward)
    }
    throw e
  }
}

// 通用兜底选项：AI 未生成选项时的默认行动方向
const GENERIC_OPTIONS: string[] = ['继续前进', '环顾四周，观察环境', '查看自身状态']

// 确保选项非空：AI 未正常生成选项时按用户设置兜底
export async function ensureOptions(
  options: string[],
  narration: string,
  config: APIConfig,
  fallback: 'generic' | 'regenerate',
): Promise<string[]> {
  const valid = options.filter((o) => typeof o === 'string' && o.trim())
  if (valid.length > 0) return valid.slice(0, 3)
  if (fallback === 'generic') return [...GENERIC_OPTIONS]
  try {
    const content = await chat(
      [{ role: 'user', content: buildOptionsFallbackPrompt(narration) }],
      config,
    )
    const data = extractJson(content) as Record<string, any>
    const regenerated = normalizeOptions(data.options)
    return regenerated.length > 0 ? regenerated : [...GENERIC_OPTIONS]
  } catch {
    return [...GENERIC_OPTIONS]
  }
}

// 将 patchSave 修改指令应用到现有存档上（只改列出的字段，数组字段整体替换）
export function applySavePatch(base: SaveData, patch: unknown): SaveData {
  const out: SaveData = JSON.parse(JSON.stringify(base)) as SaveData
  const p = (patch ?? {}) as Record<string, any>
  if (p.panel && typeof p.panel === 'object' && !Array.isArray(p.panel)) {
    for (const [k, v] of Object.entries(p.panel)) {
      if (typeof v === 'string' || typeof v === 'number') {
        (out.panel as Record<string, string | number>)[k] = v
      }
    }
  }
  if (typeof p.characterProfile === 'string') out.characterProfile = p.characterProfile
  if (typeof p.experience === 'string') out.experience = p.experience
  if (typeof p.worldTime === 'string') out.worldTime = p.worldTime
  if (p.overview && typeof p.overview === 'object' && !Array.isArray(p.overview)) {
    const o = p.overview as Record<string, unknown>
    if (typeof o.impression === 'string') out.overview.impression = o.impression
    if (typeof o.ongoing === 'string') out.overview.ongoing = o.ongoing
    if (Array.isArray(o.recentEvents)) {
      out.overview.recentEvents = o.recentEvents.filter((x): x is string => typeof x === 'string')
    }
    if (typeof o.latestProgress === 'string') out.overview.latestProgress = o.latestProgress
  }
  if (p.inventory && typeof p.inventory === 'object' && !Array.isArray(p.inventory)) {
    const inv = p.inventory as Record<string, unknown>
    if (Array.isArray(inv.equipment)) out.inventory.equipment = inv.equipment.map(normalizeItem)
    if (Array.isArray(inv.items)) out.inventory.items = inv.items.map(normalizeItem)
  }
  if (Array.isArray(p.map)) out.map = p.map.map(normalizeLocation)
  if (Array.isArray(p.characters)) out.characters = p.characters.map(normalizeCharacter)
  if (Array.isArray(p.activeLocations)) out.activeLocations = asStringArray(p.activeLocations)
  if (Array.isArray(p.activeCharacters)) out.activeCharacters = asStringArray(p.activeCharacters)
  if (p.hidden && typeof p.hidden === 'object' && !Array.isArray(p.hidden)) {
    const h = p.hidden as Record<string, any>
    if (h.add && typeof h.add === 'object' && !Array.isArray(h.add)) {
      for (const [k, v] of Object.entries(h.add as Record<string, unknown>)) {
        if (typeof v === 'string') out.hidden[k] = v
        else if (v !== undefined && v !== null) {
          try {
            out.hidden[k] = JSON.stringify(v)
          } catch {
            // 不可序列化的值忽略
          }
        }
      }
    }
    if (Array.isArray(h.remove)) {
      for (const k of h.remove) {
        if (typeof k === 'string') delete out.hidden[k]
      }
    }
  }
  return out
}

// 截断后的降级重试：diff（精简修改指令）或 split（拆分两次请求）
async function recoverAction(
  world: World,
  currentSave: SaveData,
  userInput: string,
  lastNarration: string | undefined,
  config: APIConfig,
  detailedBag: boolean,
  fastForward: boolean,
): Promise<AIResponse> {
  const { min, max } = narrationRange(config)
  const system = buildActionSystemPrompt(min, max, world, detailedBag)
  const st = useSettingsStore()
  const rules: AdventureRules = { reduceEvents: st.reduceEvents, difficulty: st.difficulty }
  const strategy = st.truncateStrategy
  if (strategy === 'diff') {
    const content = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: buildActionRecoveryDiffPrompt(world, currentSave, userInput, lastNarration, fastForward, rules),
        },
      ],
      config,
    )
    const data = extractJson(content) as Record<string, any>
    const patched = lockProfileIfNeeded(applySavePatch(currentSave, data.patchSave), currentSave)
    return {
      narration: typeof data.narration === 'string' ? data.narration : '',
      options: normalizeOptions(data.options),
      save: normalizeSave(patched, world.panelSchema),
      loreUpdates: normalizeLorebook(data.loreUpdates),
    }
  }
  // split：第 1 次生成叙事与选项，第 2 次生成完整存档
  const p1 = await chat(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: buildActionRecoverySplitNarrationPrompt(world, currentSave, userInput, lastNarration, fastForward, rules),
      },
    ],
    config,
  )
  const d1 = extractJson(p1) as Record<string, any>
  const narration = typeof d1.narration === 'string' ? d1.narration : ''
  const options = normalizeOptions(d1.options)
  const p2 = await chat(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: buildActionRecoverySplitSavePrompt(world, currentSave, narration || '（本轮未生成叙事）', userInput),
      },
    ],
    config,
  )
  const d2 = extractJson(p2) as Record<string, any>
  return {
    narration,
    options,
    save: lockProfileIfNeeded(mergeSave(currentSave, d2.save, world.panelSchema), currentSave),
    loreUpdates: normalizeLorebook(d2.loreUpdates),
  }
}
// 改写同步：玩家手动改写了最新页叙事后，在下一次行动前调用，
// 让 AI 以改写版为准修正存档与世界书（patchSave 语义，只列变化）
export async function syncAfterRewrite(
  world: World,
  currentSave: SaveData,
  page: StoryPage,
  config: APIConfig,
  onRecoverStart?: () => void,
): Promise<{ save: SaveData; loreUpdates: LoreEntry[] }> {
  const { min, max } = narrationRange(config)
  const system = buildActionSystemPrompt(min, max, world)
  try {
    const content = await chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: buildRewriteSyncPrompt(world, currentSave, page) },
      ],
      config,
    )
    const data = extractJson(content) as Record<string, any>
    const patched = lockProfileIfNeeded(
      applySavePatch(currentSave, data.patchSave ?? data.save ?? {}),
      currentSave,
    )
    return {
      save: patched,
      loreUpdates: normalizeLorebook(data.loreUpdates),
    }
  } catch (e) {
    if (e instanceof AIError && e.truncated) {
      onRecoverStart?.()
    }
    throw e
  }
}