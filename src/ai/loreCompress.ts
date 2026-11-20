import type { APIConfig, LoreEntry, World } from '@/types'
import { useWorldStore } from '@/stores/world'
import { useSettingsStore } from '@/stores/settings'
import { isDualEntry, loreSettingText, loreEventText } from '@/utils/lore'
import { compressDualEntry, compressSetting } from './agents'

// 双字段条目（人物/地点）的压缩：
// 1) 第二字段（记忆/事件）超阈值 → 摘要 + 把长期影响提升进设定 + 保留近期原文
// 2) 设定栏（可能因提升变长）超阈值 → 只去冗余、不删事实
// 失败静默，不影响主流程。普通模式与多智能体共用。

function pickTargets(world: World, titles: Set<string>, threshold: number): LoreEntry[] {
  return (world.lorebook ?? [])
    .filter((e) => isDualEntry(e) && !e.fixed && !e.hidden && titles.has((e.title ?? '').trim()))
    .filter((e) => loreEventText(e).length > threshold || loreSettingText(e).length > threshold)
    .slice(0, 2)
}

export async function compressDualEntries(
  worldId: string,
  titles: Set<string>,
  config: APIConfig,
): Promise<void> {
  const st = useSettingsStore()
  const threshold = st.loreMemoryThreshold
  if (!threshold || threshold <= 0 || titles.size === 0) return

  const first = useWorldStore().currentWorld
  if (!first || first.id !== worldId) return
  const targets = pickTargets(first, titles, threshold)

  for (const entry of targets) {
    try {
      const isLoc = entry.isLocation === true
      const kind: 'character' | 'location' = isLoc ? 'location' : 'character'
      const settingKey: 'persona' | 'setting' = isLoc ? 'setting' : 'persona'
      const secondKey: 'memory' | 'event' = isLoc ? 'event' : 'memory'
      const name = (entry.title ?? '').trim() || '（无名）'

      let patch: Partial<LoreEntry> = {}
      let setting = loreSettingText(entry)

      // 1) 第二字段压缩 + 提升
      const second = loreEventText(entry)
      if (second.length > threshold) {
        const res = await compressDualEntry(
          {
            worldName: first.name,
            name,
            kind,
            setting,
            summary: (entry.summary ?? '').trim(),
            second,
            threshold,
          },
          config,
        )
        const lines = second.split('\n').map((l) => l.trim()).filter(Boolean)
        const kept = lines.slice(res.keepFrom).join('\n')
        // 模型未真正压缩（全文保留）时不写，避免摘要与原文重复
        if (kept.length < second.length) {
          if (res.promote.trim()) {
            setting = `${setting}\n${res.promote.trim()}`.trim()
            patch[settingKey] = setting
          }
          // res.summary 已是"已有摘要 + 本次压缩"的合并结果，直接替换
          patch.summary = res.summary.trim() || undefined
          patch[secondKey] = kept
        }
      }

      // 2) 设定栏压缩（含刚提升进来的内容）
      if (setting.length > threshold) {
        const compressed = await compressSetting(first.name, name, kind, setting, config)
        if (compressed && compressed.length < setting.length) {
          patch[settingKey] = compressed
        }
      }

      if (Object.keys(patch).length === 0) continue

      const fresh = useWorldStore().currentWorld
      if (!fresh || fresh.id !== worldId) return
      const book = (fresh.lorebook ?? []).map((x) => (x.id === entry.id ? { ...x, ...patch } : x))
      await useWorldStore().updateWorld(worldId, { lorebook: book })
    } catch (err) {
      console.warn('[lore-compress] 双字段压缩失败（已忽略）', err)
    }
  }
}
