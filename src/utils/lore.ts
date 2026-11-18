import type { LoreEntry } from '@/types'

// ===== 旧档迁移 =====

// 人物条目若只有 content（设定+记忆混合），整体迁入 persona，content 保留作只读备份。
// 幂等：已有 persona 的条目直接返回原对象（引用不变，便于调用方判断是否发生迁移）。
export function migrateLoreEntry(e: LoreEntry): LoreEntry {
  if (!e.isCharacter) return e
  if (e.persona !== undefined) return e.migrated ? e : { ...e, migrated: true }
  const content = (e.content ?? '').trim()
  if (!content) return e
  return { ...e, persona: content, migrated: true }
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

// 人物条目的可注入正文（设定 + 记忆）。与 ai/prompts.ts 的 loreEntryText 保持一致，
// 供非提示词场景（UI 预览、字数统计）复用。
export function loreEntryDisplayText(e: LoreEntry): string {
  if (!e.isCharacter) return (e.content ?? '').trim()
  const persona = (e.persona ?? e.content ?? '').trim()
  const memory = (e.memory ?? '').trim()
  if (!persona && !memory) return ''
  if (!memory) return persona
  return persona ? `${persona}\n【记忆】\n${memory}` : `【记忆】\n${memory}`
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

// 人物条目双字段合并：persona 与 memory 各自独立增量。
// 兼容旧提示词：未提供 persona 字段时，把 content 视为 persona 的全量替换。
function personaPatch(old: LoreEntry, u: LoreEntry): { persona: string; memory?: string; migrated: boolean } {
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
      const isCharacter = old.isCharacter === true || u.isCharacter === true
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
        ...(isCharacter ? personaPatch(old, u) : { content: applyLoreContentDelta(old.content, u) }),
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

    // 新条目
    if (u.isCharacter === true) {
      const p = (u.persona || u.content || '').trim()
      const m = (u.memory || u.memoryAppend || '').trim()
      if (!p && !m) continue
      next.push({
        id: u.id,
        title: u.title,
        aliases: aliases.length > 0 ? aliases : undefined,
        tags: u.tags,
        content: '',
        persona: p,
        memory: m || undefined,
        migrated: true,
        required: u.required,
        fixed: u.fixed,
        links: u.links,
        hidden: u.hidden,
        isLocation: u.isLocation,
        isCharacter: true,
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
