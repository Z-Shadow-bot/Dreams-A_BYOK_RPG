import { chat, extractJson, AIError } from './client'
import {
  buildActionSystemPrompt,
  bagDetailRule,
  buildActionPrompt,
  buildCharacterGenPrompt,
  buildWorldGenPrompt,

  buildActionRecoverySplitNarrationPrompt,
  buildActionRecoverySplitSavePrompt,
  buildLoreCompressPrompt,
  buildOptionsFallbackPrompt,
  type AdventureRules,
  type LoreInjectionConfig,
} from './prompts'
import { useSettingsStore } from '@/stores/settings'
import type { NarrativeSpeed } from '@/stores/settings'
import type {
  APIConfig,
  AIResponse,
  CharacterEntry,
  Item,
  LoreEntry,
  MapLocation,
  PanelField,
  SaveData,
  Skill,
  World,
} from '@/types'
import { createId } from '@/types'

// 读取每轮叙事字数区间的安全值（兼容旧配置）
function narrationRange(config: APIConfig): { min: number; max: number } {
  const min = typeof config.narrationMin === 'number' ? config.narrationMin : 200
  const max = typeof config.narrationMax === 'number' ? config.narrationMax : 500
  return { min, max }
}

function getLoreCfg(): LoreInjectionConfig {
  const st = useSettingsStore()
  return { loreLimit: st.loreLimit, loreBudget: st.loreBudget, linkBudget: st.linkBudget }
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

function normalizeSkill(v: unknown): Skill {
  const s = (v ?? {}) as Record<string, unknown>
  return {
    name: asString(s.name),
    description: asString(s.description),
  }
}

// 按物品名增量合并物品列表：AI 只需列出本轮新增或发生变化的物品，未列出的保留原样；
// 物品对象带 remove: true 表示删除该名称的物品（不持久化）。
// 这样即使模型漏输出部分物品，也不会把背包清空。
function mergeItems(baseList: Item[], incoming: unknown): Item[] {
  const base = Array.isArray(baseList) ? baseList : []
  if (!Array.isArray(incoming)) return base.map((it) => ({ ...it }))
  const out: Item[] = base.map((it) => ({ ...it }))
  for (const raw of incoming) {
    const it = (raw ?? {}) as Record<string, unknown>
    const name = asString(it.name).trim()
    if (!name) continue
    const idx = out.findIndex((x) => (x.name ?? '').trim() === name)
    if (it.remove === true) {
      if (idx >= 0) out.splice(idx, 1)
      continue
    }
    if (idx >= 0) {
      // 更新：只覆盖 AI 明确提供的字段，未提供的保留原值
      const old = out[idx]
      out[idx] = {
        name: old.name,
        quantity: typeof it.quantity === 'number' ? it.quantity : old.quantity,
        state: typeof it.state === 'string' && it.state.trim() !== '' ? it.state : old.state,
      }
    } else {
      out.push(normalizeItem(it))
    }
  }
  return out
}

// 按技能名增量合并技能列表：AI 只列出本轮新增或变化的技能，未列出的保留原样；
// 带 remove:true 表示删除该技能（不持久化）。避免漏输出导致清空。
function mergeSkills(baseList: Skill[], incoming: unknown): Skill[] {
  const base = Array.isArray(baseList) ? baseList : []
  if (!Array.isArray(incoming)) return base.map((s) => ({ ...s }))
  const out: Skill[] = base.map((s) => ({ ...s }))
  for (const raw of incoming) {
    const s = (raw ?? {}) as Record<string, unknown>
    const name = asString(s.name).trim()
    if (!name) continue
    const idx = out.findIndex((x) => (x.name ?? '').trim() === name)
    if (s.remove === true) {
      if (idx >= 0) out.splice(idx, 1)
      continue
    }
    if (idx >= 0) {
      const old = out[idx]
      out[idx] = {
        name: old.name,
        description: typeof s.description === 'string' && s.description.trim() !== '' ? s.description : old.description,
      }
    } else {
      out.push(normalizeSkill(s))
    }
  }
  return out
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
    skills: (Array.isArray(r.skills) ? r.skills : []).map(normalizeSkill),
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
  const max = useSettingsStore().optionCount
  return raw.filter((x): x is string => typeof x === 'string').slice(0, max)
}

// 手动更新设定开关：开启后 AI 生成的存档不得修改玩家角色人设（characterProfile 强制保持原值）
function lockProfileIfNeeded(save: SaveData, base: SaveData): SaveData {
  if (useSettingsStore().manualProfile) {
    save.characterProfile = base.characterProfile
  }
  return save
}

// 布尔字段三态：未提供 → undefined（合并时保留旧值）；显式 true / false → 覆盖
function asTriBool(v: unknown): boolean | undefined {
  if (v === true) return true
  if (v === false) return false
  return undefined
}

// 归一化单条世界书条目（AI 返回无 id，由这里分配）
// remove 标记：仅当条目完全重复或记录错误时 AI 返回 { title, remove: true } 表示删除该条目（无需 content）
// 内容级增量：支持 appendContent / appendTo / removeLines（无 content 时为纯增量更新）
function normalizeLoreEntry(v: unknown): LoreEntry | null {
  const e = (v ?? {}) as Record<string, unknown>
  const title = asString(e.title).trim()
  // 删除条目：仅完全重复或记录错误时使用，只需 title + remove 标记，不需要 content
  if (e.remove === true && title) {
    return { id: createId(), title, tags: [], content: '', remove: true }
  }
  const content = asString(e.content).trim()
  const appendContent = asString(e.appendContent).trim()
  const appendTo = asString(e.appendTo).trim() || undefined
  const removeLines = Array.isArray(e.removeLines)
    ? e.removeLines
        .filter((x): x is string => typeof x === 'string')
        .map((x) => x.trim())
        .filter((x) => !!x)
    : undefined
  const hasDelta = !!appendContent || (removeLines ? removeLines.length > 0 : false)
  // 纯内容增量更新：允许无 content，但必须有 title（用于匹配已有条目）；新增条目则必须有 content
  if (!content && !hasDelta) return null
  if (!content && !title) return null
  const tags = asStringArray(e.tags).map((t) => t.trim()).filter((t) => !!t)
  const aliases = asStringArray(e.aliases).map((t) => t.trim()).filter((t) => !!t)
  return {
    id: createId(),
    title: title || undefined,
    aliases: aliases.length > 0 ? aliases : undefined,
    tags,
    content,
    required: asTriBool(e.required),
    fixed: asTriBool(e.fixed),
    links: Array.isArray(e.links)
      ? asStringArray(e.links).map((t) => t.trim()).filter((t) => !!t)
      : undefined,
    hidden: asTriBool(e.hidden),
    isLocation: asTriBool(e.isLocation),
    isCharacter: asTriBool(e.isCharacter),
    lastVisitedTime: asString(e.lastVisitedTime).trim() || undefined,
    appendContent: appendContent || undefined,
    appendTo,
    removeLines: removeLines && removeLines.length > 0 ? removeLines : undefined,
  }
}

// 世界书条目内容级 diff：在旧 content 基础上应用增量（全量替换 / 删除行 / 追加到栏目或末尾）
export function applyLoreContentDelta(oldContent: string, u: LoreEntry): string {
  // 1) 完整替换优先
  const full = typeof u.content === 'string' ? u.content.trim() : ''
  if (full) return full
  let content = oldContent ?? ''
  // 2) 删除包含指定子串的行
  const removeLines = Array.isArray(u.removeLines) ? u.removeLines.filter((s) => typeof s === 'string' && s.trim()) : []
  if (removeLines.length > 0) {
    content = content
      .split('\n')
      .filter((line) => !removeLines.some((m) => line.includes(m.trim())))
      .join('\n')
  }
  // 3) 追加（可指定栏目：插入到该【栏目】区段末尾）
  const append = typeof u.appendContent === 'string' ? u.appendContent.trim() : ''
  if (append) {
    const section = typeof u.appendTo === 'string' ? u.appendTo.trim() : ''
    content = section ? insertIntoSection(content, section, append) : content ? `${content}\n${append}` : append
  }
  return content
}

// 判断某一行是否是栏目标题（【xxx】 或 # / ## 开头）
function isSectionHeading(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  return (t.startsWith('【') && t.includes('】')) || t.startsWith('#')
}

// 把 text 插入到标题含 section 的区段末尾（下一个栏目标题之前）；找不到栏目则追加到末尾
function insertIntoSection(content: string, section: string, text: string): string {
  const lines = content.split('\n')
  let head = -1
  for (let i = 0; i < lines.length; i++) {
    if (isSectionHeading(lines[i]) && lines[i].includes(section)) {
      head = i
      break
    }
  }
  if (head === -1) return content ? `${content}\n${text}` : text
  let end = lines.length
  for (let i = head + 1; i < lines.length; i++) {
    if (isSectionHeading(lines[i])) {
      end = i
      break
    }
  }
  // 去掉该区段末尾的空行后再插入
  let insertAt = end
  while (insertAt - 1 > head && !lines[insertAt - 1].trim()) insertAt--
  return [...lines.slice(0, insertAt), text, ...lines.slice(insertAt)].join('\n')
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
    [{ role: 'user', content: buildWorldGenPrompt(userInput, opts, useSettingsStore().worldSettingMax) }],
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
      { role: 'user', content: buildCharacterGenPrompt(world, userInput, min, max, opts, hiddenPreset, getLoreCfg()) + bagDetailRule(detailedBag) },
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
  narrativeSpeed: NarrativeSpeed = 'normal',
  onRecoverStart?: () => void,
  unseenNpc?: LoreEntry,
): Promise<AIResponse> {
  const { min, max } = narrationRange(config)
  const system = buildActionSystemPrompt(min, max, world, detailedBag, true)
  const st = useSettingsStore()
  const rules: AdventureRules = { eventFrequency: st.eventFrequency, difficulty: st.difficulty, narrativeDetail: st.narrativeDetail }
  try {
    const content = await chat(
      [
        { role: 'system', content: system },
        {
          role: 'user',
          content: buildActionPrompt(world, currentSave, userInput, lastNarration, narrativeSpeed, rules, getLoreCfg(), unseenNpc),
        },
      ],
      config,
    )
    const data = extractJson(content) as Record<string, any>
    return {
      narration: typeof data.narration === 'string' ? data.narration : '',
      options: normalizeOptions(data.options),
      save: lockProfileIfNeeded(applySavePatch(currentSave, data.patchSave ?? data.save ?? {}), currentSave),
      loreUpdates: normalizeLorebook(data.loreUpdates),
    }
  } catch (e) {
    if (e instanceof AIError && e.truncated) {
      // 输出被截断：按用户设置的策略自动降级重试，避免再次截断
      onRecoverStart?.()
      return recoverAction(world, currentSave, userInput, lastNarration, config, detailedBag, narrativeSpeed, unseenNpc)
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
  if (valid.length > 0) return valid.slice(0, useSettingsStore().optionCount)
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

// 世界书条目超长时的独立压缩请求：返回压缩后的正文；失败或空则返回原文（不影响主流程）
export async function compressLoreEntry(
  world: World,
  entry: LoreEntry,
  config: APIConfig,
  threshold: number,
): Promise<string> {
  const content = await chat(
    [{ role: 'user', content: buildLoreCompressPrompt(world, entry, threshold) }],
    config,
  )
  const data = extractJson(content) as Record<string, any>
  const out = typeof data.content === 'string' ? data.content.trim() : ''
  return out || entry.content
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
  if (typeof p.characterProfile === 'string' && p.characterProfile.trim() !== '') out.characterProfile = p.characterProfile
  if (typeof p.experience === 'string' && p.experience.trim() !== '') out.experience = p.experience
  if (typeof p.worldTime === 'string' && p.worldTime.trim() !== '') out.worldTime = p.worldTime
  if (p.overview && typeof p.overview === 'object' && !Array.isArray(p.overview)) {
    const o = p.overview as Record<string, unknown>
    if (typeof o.impression === 'string' && o.impression.trim() !== '') out.overview.impression = o.impression
    if (typeof o.ongoing === 'string' && o.ongoing.trim() !== '') out.overview.ongoing = o.ongoing
    if (Array.isArray(o.recentEvents)) {
      out.overview.recentEvents = o.recentEvents.filter((x): x is string => typeof x === 'string')
    }
    if (typeof o.latestProgress === 'string' && o.latestProgress.trim() !== '') out.overview.latestProgress = o.latestProgress
  }
  if (p.inventory && typeof p.inventory === 'object' && !Array.isArray(p.inventory)) {
    const inv = p.inventory as Record<string, unknown>
    if (Array.isArray(inv.equipment)) out.inventory.equipment = mergeItems(out.inventory.equipment, inv.equipment)
    if (Array.isArray(inv.items)) out.inventory.items = mergeItems(out.inventory.items, inv.items)
  }
  if (Array.isArray(p.skills)) out.skills = mergeSkills(out.skills, p.skills)
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

// 截断后的降级重试：split（拆分两次请求，分别生成叙事与存档变化）
async function recoverAction(
  world: World,
  currentSave: SaveData,
  userInput: string,
  lastNarration: string | undefined,
  config: APIConfig,
  detailedBag: boolean,
  narrativeSpeed: NarrativeSpeed,
  unseenNpc?: LoreEntry,
): Promise<AIResponse> {
  const { min, max } = narrationRange(config)
  const system = buildActionSystemPrompt(min, max, world, detailedBag, true)
  const st = useSettingsStore()
  const rules: AdventureRules = { eventFrequency: st.eventFrequency, difficulty: st.difficulty, narrativeDetail: st.narrativeDetail }
  const loreCfg = getLoreCfg()
  // split：第 1 次生成叙事+选项+存档变化，第 2 次生成世界书更新
  const p1 = await chat(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: buildActionRecoverySplitNarrationPrompt(world, currentSave, userInput, lastNarration, narrativeSpeed, rules, loreCfg, unseenNpc),
      },
    ],
    config,
  )
  const d1 = extractJson(p1) as Record<string, any>
  const narration = typeof d1.narration === 'string' ? d1.narration : ''
  const options = normalizeOptions(d1.options)
  const patchedSave = lockProfileIfNeeded(applySavePatch(currentSave, d1.patchSave ?? d1.save ?? {}), currentSave)
  const p2 = await chat(
    [
      { role: 'system', content: system },
      {
        role: 'user',
        content: buildActionRecoverySplitSavePrompt(world, patchedSave, narration || '（本轮未生成叙事）', userInput, loreCfg),
      },
    ],
    config,
  )
  const d2 = extractJson(p2) as Record<string, any>
  return {
    narration,
    options,
    save: patchedSave,
    loreUpdates: normalizeLorebook(d2.loreUpdates),
  }
}
