import type { LoreEntry } from '@/types'

// ===== 双字段条目（人物 / 地点）=====
// 人物：persona（设定）+ memory（记忆）
// 地点：setting（设定）+ event（事件，类似地点的记忆）
// 两类共用同一套迁移 / 注入 / 增量合并逻辑，仅字段名不同。

export function isDualEntry(e: LoreEntry): boolean {
  return e.isCharacter === true || e.isLocation === true
}

// 双字段条目的"设定"正文（旧数据回退到 content）
export function loreSettingText(e: LoreEntry): string {
  if (e.isLocation) return (e.setting ?? e.content ?? '').trim()
  return (e.persona ?? e.content ?? '').trim()
}

// 双字段条目的"第二字段"正文（人物的记忆 / 地点的事件）
export function loreEventText(e: LoreEntry): string {
  if (e.isLocation) return (e.event ?? '').trim()
  return (e.memory ?? '').trim()
}

export function loreSecondLabel(e: LoreEntry): string {
  return e.isLocation ? '事件' : '记忆'
}

// ===== 旧档迁移 =====

// 双字段条目若只有 content（设定与历史混在一起），整体迁入设定字段，content 保留作只读备份。
// 幂等：已有设定字段的条目直接返回原对象（引用不变，便于调用方判断是否发生迁移）。
export function migrateLoreEntry(e: LoreEntry): LoreEntry {
  if (!isDualEntry(e)) return e
  const hasSetting = e.isLocation ? e.setting !== undefined : e.persona !== undefined
  if (hasSetting) return e.migrated ? e : { ...e, migrated: true }
  const content = (e.content ?? '').trim()
  if (!content) return e
  return e.isLocation ? { ...e, setting: content, migrated: true } : { ...e, persona: content, migrated: true }
}

// 批量迁移世界书；无变化时返回原数组引用，调用方可据此判断是否需要回写
export function migrateLorebook(list?: LoreEntry[] | null): LoreEntry[] | undefined {
  if (!Array.isArray(list)) return list ?? undefined
  let changed = false
  const out = list.map((e) => {
    const n = migrateLoreEntry(e)
    if (n !== e) changed = true
    return n
  })
  return changed ? out : list
}

// ===== 展示文本 =====

// 双字段条目的可注入正文（设定 + 记忆/事件）
export function loreEntryDisplayText(e: LoreEntry): string {
  if (!isDualEntry(e)) return (e.content ?? '').trim()
  const setting = loreSettingText(e)
  const second = loreEventText(e)
  const summary = (e.summary ?? '').trim()
  const label = loreSecondLabel(e)
  const parts: string[] = []
  if (setting) parts.push(setting)
  if (summary) parts.push(`【${label}·摘要】\n${summary}`)
  if (second) parts.push(`【${label}】\n${second}`)
  return parts.join('\n')
}

// ===== 内容级增量 =====

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
  let insertAt = end
  while (insertAt - 1 > head && !lines[insertAt - 1].trim()) insertAt--
  return [...lines.slice(0, insertAt), text, ...lines.slice(insertAt)].join('\n')
}

// 通用字段级增量：全量替换优先，其次删行，最后追加（三者可组合）
export function applyLoreFieldDelta(
  oldValue: string,
  full: string | undefined,
  append: string | undefined,
  removeLines: string[] | undefined,
): string {
  const f = typeof full === 'string' ? full.trim() : ''
  if (f) return f
  let v = oldValue ?? ''
  if (removeLines && removeLines.length > 0) {
    v = v
      .split('\n')
      .filter((line) => !removeLines.some((m) => line.includes(m)))
      .join('\n')
  }
  const a = typeof append === 'string' ? append.trim() : ''
  if (a) v = v ? `${v}\n${a}` : a
  return v
}

// 世界书条目内容级 diff：在旧 content 基础上应用增量（全量替换 / 删除行 / 追加到栏目或末尾）
export function applyLoreContentDelta(oldContent: string, u: LoreEntry): string {
  const full = typeof u.content === 'string' ? u.content.trim() : ''
  if (full) return full
  let content = oldContent ?? ''
  const removeLines = Array.isArray(u.removeLines) ? u.removeLines.filter((s) => typeof s === 'string' && s.trim()) : []
  if (removeLines.length > 0) {
    content = content
      .split('\n')
      .filter((line) => !removeLines.some((m) => line.includes(m.trim())))
      .join('\n')
  }
  const append = typeof u.appendContent === 'string' ? u.appendContent.trim() : ''
  if (append) {
    const section = typeof u.appendTo === 'string' ? u.appendTo.trim() : ''
    content = section ? insertIntoSection(content, section, append) : content ? `${content}\n${append}` : append
  }
  return content
}

// ===== 合并 AI 返回的 loreUpdates =====

function loreKey(s: string | undefined): string {
  return (s ?? '').trim().toLowerCase()
}

function loreMatches(b: LoreEntry, title: string, aliases: string[]): boolean {
  const incoming = [title, ...aliases].map(loreKey).filter((k) => !!k)
  if (incoming.length === 0) return false
  const targets = [b.title ?? '', ...(b.aliases ?? [])].map(loreKey).filter((k) => !!k)
  return incoming.some((k) => targets.includes(k))
}

// 双字段条目增量合并：设定与第二字段各自独立。
// 兼容旧提示词：未提供设定字段时，把 content 视为设定的全量替换。
function dualPatch(
  old: LoreEntry,
  u: LoreEntry,
): { persona?: string; memory?: string; setting?: string; event?: string; migrated: boolean } {
  if (old.isLocation === true || u.isLocation === true) {
    const settingBase = old.setting ?? old.content ?? ''
    const settingFull = u.setting ?? (u.content ? u.content : undefined)
    const setting = applyLoreFieldDelta(settingBase, settingFull, u.settingAppend, u.settingRemoveLines)
    const event = applyLoreFieldDelta(old.event ?? '', u.event, u.eventAppend, u.eventRemoveLines)
    return { setting, event: event || undefined, migrated: true }
  }
  const personaBase = old.persona ?? old.content ?? ''
  const personaFull = u.persona ?? (u.content ? u.content : undefined)
  const persona = applyLoreFieldDelta(personaBase, personaFull, u.personaAppend, u.personaRemoveLines)
  const memory = applyLoreFieldDelta(old.memory ?? '', u.memory, u.memoryAppend, u.memoryRemoveLines)
  return { persona, memory: memory || undefined, migrated: true }
}

// 把 revealTo 追加进 access.who（不覆盖已有可见者）
function applyReveal(entry: LoreEntry, revealTo: string[] | undefined): LoreEntry {
  if (!revealTo || revealTo.length === 0) return entry
  const acc = entry.access ?? { mode: 'knownBy' as const, who: [] }
  if (acc.mode === 'public') return entry
  const who = new Set(acc.who ?? [])
  for (const id of revealTo) if (id) who.add(id)
  return { ...entry, access: { mode: 'knownBy', who: [...who] } }
}

// 将 AI 返回的世界书更新合并进现有世界书：按 title/aliases 匹配更新（含同义不同名合并），否则新增。
// 无更新或更新为空时返回 null（调用方据此判断是否写库）。
export function mergeLoreUpdates(book: LoreEntry[], updates: LoreEntry[] | undefined): LoreEntry[] | null {
  if (!updates || updates.length === 0) return null
  const next: LoreEntry[] = book.map((e) => ({ ...e }))
  for (const u of updates) {
    const title = (u.title ?? '').trim()
    const aliases = (u.aliases ?? []).map((a) => a.trim()).filter((a) => !!a)
    const idx = title || aliases.length > 0 ? next.findIndex((b) => loreMatches(b, title, aliases)) : -1

    if (u.remove === true) {
      if (idx >= 0 && !next[idx].fixed) next.splice(idx, 1)
      continue
    }

    if (idx >= 0) {
      const old = next[idx]
      // 固定条目：AI 不得修改内容，仅允许显式 hidden:false 移除隐藏（彩蛋出场）
      if (old.fixed) {
        if (u.hidden === false) next[idx] = { ...old, hidden: undefined }
        continue
      }
      const isDual = isDualEntry(old) || isDualEntry(u)
      const newTitle = title || old.title
      const mergedAliases = new Set<string>()
      for (const a of old.aliases ?? []) mergedAliases.add(a)
      for (const a of aliases) mergedAliases.add(a)
      if ((old.title ?? '').trim() && loreKey(old.title) !== loreKey(newTitle)) {
        mergedAliases.add((old.title ?? '').trim())
      }
      const titleKey = loreKey(newTitle)
      for (const a of [...mergedAliases]) {
        if (loreKey(a) === titleKey) mergedAliases.delete(a)
      }
      const merged: LoreEntry = {
        ...old,
        title: newTitle,
        aliases: mergedAliases.size > 0 ? [...mergedAliases] : undefined,
        tags: u.tags.length > 0 ? u.tags : old.tags,
        ...(isDual ? dualPatch(old, u) : { content: applyLoreContentDelta(old.content, u) }),
        required: u.required !== undefined ? u.required : old.required,
        fixed: u.fixed !== undefined ? u.fixed : old.fixed,
        links: u.links !== undefined ? u.links : old.links,
        hidden: u.hidden !== undefined ? u.hidden : old.hidden,
        isLocation: u.isLocation !== undefined ? u.isLocation : old.isLocation,
        isCharacter: u.isCharacter !== undefined ? u.isCharacter : old.isCharacter,
        lastVisitedTime: u.lastVisitedTime !== undefined ? u.lastVisitedTime : old.lastVisitedTime,
        access: u.access !== undefined ? u.access : old.access,
      }
      next[idx] = applyReveal(merged, u.revealTo)
      continue
    }

    // 新条目：人物与地点都走双字段
    if (isDualEntry(u)) {
      const isLoc = u.isLocation === true
      const a = (isLoc ? u.setting || u.content : u.persona || u.content) ?? ''
      const b = (isLoc ? u.event || u.eventAppend : u.memory || u.memoryAppend) ?? ''
      if (!a.trim() && !b.trim()) continue
      next.push({
        id: u.id,
        title: u.title,
        aliases: aliases.length > 0 ? aliases : undefined,
        tags: u.tags,
        content: '',
        ...(isLoc ? { setting: a.trim(), event: b.trim() || undefined } : { persona: a.trim(), memory: b.trim() || undefined }),
        migrated: true,
        required: u.required,
        fixed: u.fixed,
        links: u.links,
        hidden: u.hidden,
        isLocation: u.isLocation,
        isCharacter: u.isCharacter,
        lastVisitedTime: u.lastVisitedTime,
        access: u.access,
      })
      continue
    }
    const newContent = (u.content || u.appendContent || '').trim()
    if (!newContent) continue
    next.push({
      id: u.id,
      title: u.title,
      aliases: aliases.length > 0 ? aliases : undefined,
      tags: u.tags,
      content: newContent,
      required: u.required,
      fixed: u.fixed,
      links: u.links,
      hidden: u.hidden,
      isLocation: u.isLocation,
      isCharacter: u.isCharacter,
      lastVisitedTime: u.lastVisitedTime,
      access: u.access,
    })
  }
  return next
}
