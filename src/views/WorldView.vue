<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useWorldStore } from '@/stores/world'
import { useAdventureStore } from '@/stores/adventure'
import { useSettingsStore } from '@/stores/settings'
import { useMaStore } from '@/stores/multiagent'
import { generateWorld } from '@/ai/service'
import { errorMessage } from '@/ai/client'
import { downloadJSON, pickJSONFile, safeFilename, timestamp } from '@/utils/file'
import { pickZipFile, parseDlcZip, persistDlcAudio, removeDlcAudio } from '@/dlc'
import { clearBgmCache } from '@/audio/bgm'
import { createId, NARRATOR_ID, PLAYER_ID } from '@/types'
import type { PanelField, World, LoreEntry } from '@/types'

const worldStore = useWorldStore()
const adventure = useAdventureStore()
const settings = useSettingsStore()
const ma = useMaStore()

const showCreate = ref(false)
const newName = ref('')
const newDesc = ref('')
const newMultiAgent = ref(false)

const enhanceSummarize = ref(true) // 总结优化已有设定
const enhanceExpand = ref(true) // 补充更多合理设定
const creating = ref(false)
const createError = ref('')
const confirmDeleteId = ref<string | null>(null)
const deleteError = ref('')

const showEdit = ref(false)
const editId = ref<string | null>(null)
const editName = ref('')
const editSetting = ref('')
const editSchema = ref<PanelField[]>([])
const editError = ref('')
interface LoreEditRow {
  id: string
  title: string
  aliasesText: string
  lastVisitedTimeText: string
  tagsText: string
  content: string
  persona: string
  memory: string
  accessMode: 'public' | 'secret' | 'knownBy'
  accessWhoText: string
  required: boolean
  fixed?: boolean
  linksText: string
  hidden?: boolean
  isLocation?: boolean
  isCharacter?: boolean
}
const editLorebook = ref<LoreEditRow[]>([])
const editLoreFilter = ref('')
const editLoreOrder = ref<'asc' | 'desc'>('asc')
const confirmLoreDeleteId = ref<string | null>(null)
const editIsPreview = ref(false) // 新建世界后预览模式
const editTab = ref<'core' | 'schema' | 'lore' | 'agents'>('core')
const importError = ref('')
const exporting = ref(false)
const importing = ref(false)
const dlcError = ref('')
const importingDlc = ref(false)
const renamingWorldId = ref<string | null>(null)
const renamingWorldName = ref('')
const duplicating = ref(false)
const dupError = ref('')

function startRenameWorld(w: World) {
  renamingWorldId.value = w.id
  renamingWorldName.value = w.name
}

async function commitRenameWorld(w: World) {
  if (renamingWorldId.value !== w.id) return
  const newName = renamingWorldName.value.trim()
  renamingWorldId.value = null
  if (!newName || newName === w.name) return
  try {
    await worldStore.updateWorld(w.id, { name: newName })
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e)
  }
}

async function doDuplicate(w: World) {
  dupError.value = ''
  duplicating.value = true
  try {
    const copy = await worldStore.duplicateWorld(w.id)
    if (copy) {
      await adventure.open(copy.id)
    }
  } catch (e) {
    dupError.value = e instanceof Error ? e.message : String(e)
  } finally {
    duplicating.value = false
  }
}

function selectWorld(id: string) {
  confirmDeleteId.value = null
  worldStore.selectWorld(id)
  adventure.open(id)
}

async function onDelete(id: string) {
  deleteError.value = ''
  if (confirmDeleteId.value !== id) {
    confirmDeleteId.value = id
    return
  }
  const wasCurrent = id === worldStore.currentWorldId
  try {
    await worldStore.removeWorld(id)
    confirmDeleteId.value = null
    if (wasCurrent) {
      await adventure.open(worldStore.currentWorldId)
    }
  } catch (e) {
    deleteError.value = e instanceof Error ? e.message : String(e)
    confirmDeleteId.value = null
  }
}


async function doCreate() {
  createError.value = ''
  if (!newDesc.value.trim()) {
    createError.value = '请描述你想要的世界的创意'
    return
  }
  if (!settings.hasKey || !settings.config.baseUrl || !settings.config.model) {
    createError.value = '请先在「我的」页面完成 API 配置'
    return
  }
  creating.value = true
  try {
    const { worldSetting, lorebook, panelSchema } = await generateWorld(
      newDesc.value.trim(),
      settings.config,

      {
        summarize: enhanceSummarize.value,
        expand: enhanceExpand.value,
      },
    )
    const name = newName.value.trim() || newDesc.value.trim().slice(0, 12)
    const world = await worldStore.createWorld(name, worldSetting, panelSchema, lorebook, newMultiAgent.value)
    showCreate.value = false
    newName.value = ''
    newDesc.value = ''
    newMultiAgent.value = false
    // 生成后自动打开设定页让用户预览拆分结果
    openEdit(world)
    editIsPreview.value = true
    editTab.value = 'core'
  } catch (e) {
    createError.value = errorMessage(e, settings.devMode)
  } finally {
    creating.value = false
  }
}

// 创建空世界：不调用 AI，直接创建一个面板/核心设定/世界书全空的世界，供完全手动创建的玩家使用
async function createEmptyWorld() {
  createError.value = ''
  try {
    const name = newName.value.trim() || '未命名世界'
    const world = await worldStore.createWorld(name, '', [], [], newMultiAgent.value)
    showCreate.value = false
    newName.value = ''
    newDesc.value = ''
    newMultiAgent.value = false
    // 切换冒险上下文到新世界（空世界无存档，冒险页会回到「开始冒险」状态），避免残留上一个世界的存档
    await adventure.open(world.id)
    // 直接打开设定页，方便玩家从零开始填写
    openEdit(world)
  } catch (e) {
    createError.value = e instanceof Error ? e.message : String(e)
  }
}

function formatTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

function openEdit(w: World) {
  editId.value = w.id
  editName.value = w.name
  editSetting.value = w.worldSetting
  try {
    editSchema.value = JSON.parse(JSON.stringify(w.panelSchema))
  } catch {
    editSchema.value = []
  }
  editLorebook.value = (w.lorebook ?? []).map((e) => {
    const isChar = e.isCharacter === true
    return {
      id: e.id,
      title: e.title ?? '',
      aliasesText: (e.aliases ?? []).join(', '),
      lastVisitedTimeText: e.lastVisitedTime ?? '',
      tagsText: (e.tags ?? []).join(', '),
      // 人物条目：content 迁入 persona 后清空，避免两个输入框内容重复
      content: isChar ? '' : (e.content ?? ''),
      persona: isChar ? (e.persona ?? e.content ?? '') : '',
      memory: isChar ? (e.memory ?? '') : '',
      accessMode: e.access?.mode ?? 'public',
      accessWhoText: (e.access?.who ?? []).join(', '),
      required: !!e.required,
      fixed: !!e.fixed,
      linksText: (e.links ?? []).join(', '),
      hidden: e.hidden,
      isLocation: e.isLocation,
      isCharacter: e.isCharacter,
    }
  })
  editLoreFilter.value = ''
  confirmLoreDeleteId.value = null
  editError.value = ''
  editIsPreview.value = false
  editTab.value = 'core'
  editMultiAgent.value = w.multiAgent === true
  expandedAgent.value = null
  if (editMultiAgent.value) void ma.open(w.id)
  showEdit.value = true
}

// 编辑另一个世界时 ma store 会被切到 editId；关闭弹窗后必须切回当前冒险世界，
// 否则冒险页读到的会是别的世界的角色状态。
watch(showEdit, (v) => {
  if (v) return
  const id = worldStore.currentWorldId
  if (id && worldStore.currentWorld?.multiAgent) void ma.open(id)
})

// ===== 智能体面板 =====
const editMultiAgent = ref(false)
const expandedAgent = ref<string | null>(null)
const agentDraft = ref({ privatePersona: '', memory: '', memorySummary: '' })

interface AgentRow {
  charId: string
  name: string
  role: string
  assigned: boolean
  system: boolean
  memoryLen: number
  present: boolean
}

const agentRows = computed<AgentRow[]>(() => {
  if (!editMultiAgent.value) return []
  const rows: AgentRow[] = []
  const narrator = ma.agentOf(NARRATOR_ID)
  rows.push({
    charId: NARRATOR_ID,
    name: '旁白',
    role: '叙事与裁决',
    assigned: true,
    system: true,
    memoryLen: (narrator?.memory ?? '').length,
    present: true,
  })
  const player = ma.agentOf(PLAYER_ID)
  rows.push({
    charId: PLAYER_ID,
    name: player?.name || '你',
    role: '玩家角色',
    assigned: true,
    system: true,
    memoryLen: (player?.memory ?? '').length,
    present: true,
  })
  for (const e of editLorebook.value) {
    if (!e.isCharacter) continue
    const a = ma.agentOf(e.id)
    rows.push({
      charId: e.id,
      name: e.title.trim() || '（未命名人物）',
      role: 'NPC',
      assigned: !!a,
      system: false,
      memoryLen: (a?.memory ?? '').length,
      present: a?.present === true,
    })
  }
  return rows
})

function openAgentPanel(charId: string) {
  const a = ma.agentOf(charId)
  if (!a) return
  expandedAgent.value = charId
  agentDraft.value = {
    privatePersona: a.privatePersona,
    memory: a.memory,
    memorySummary: a.memorySummary ?? '',
  }
}

async function saveAgentPanel() {
  const id = expandedAgent.value
  if (!id) return
  await ma.updateAgent(id, { ...agentDraft.value })
  expandedAgent.value = null
}

async function toggleAssign(row: AgentRow) {
  if (row.system) return
  if (row.assigned) {
    if (!confirm(`取消「${row.name}」的独立智能体？该角色的私有设定与记忆会被删除，且无法恢复。`)) return
    await ma.unassign(row.charId)
    if (expandedAgent.value === row.charId) expandedAgent.value = null
    return
  }
  const e = editLorebook.value.find((x) => x.id === row.charId)
  if (!e) return
  await ma.assign({
    id: e.id,
    title: e.title,
    tags: [],
    content: '',
    persona: e.persona,
    memory: e.memory,
    isCharacter: true,
  })
}

async function clearAgentMemory(charId: string) {
  if (!confirm('清空该角色的全部记忆？（私有设定不受影响）')) return
  await ma.clearMemory(charId)
  if (expandedAgent.value === charId) {
    const a = ma.agentOf(charId)
    if (a) agentDraft.value = { privatePersona: a.privatePersona, memory: a.memory, memorySummary: a.memorySummary ?? '' }
  }
}

function addField() {
  editSchema.value.push({ key: '', label: '', type: 'text', unit: '' })
}

function removeField(i: number) {
  editSchema.value.splice(i, 1)
}

function moveField(i: number, dir: -1 | 1) {
  const arr = editSchema.value
  const j = i + dir
  if (j < 0 || j >= arr.length) return
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
}

// 规范化列表输入：把中文逗号（，）统一为「英文逗号 + 空格」，并去除空项
function normalizeListText(v: string): string {
  return v
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter((s) => !!s)
    .join(', ')
}

function addLoreEntry() {
  editLorebook.value.push({ id: createId(), title: '', aliasesText: '', lastVisitedTimeText: '', tagsText: '', content: '', persona: '', memory: '', accessMode: 'public', accessWhoText: '', required: false, linksText: '' })
}

function removeLoreEntry(id: string) {
  if (confirmLoreDeleteId.value !== id) {
    confirmLoreDeleteId.value = id
    return
  }
  editLorebook.value = editLorebook.value.filter((e) => e.id !== id)
  confirmLoreDeleteId.value = null
}

const filteredLorebook = computed(() => {
  const q = editLoreFilter.value.trim().toLowerCase()
  if (!q) return editLorebook.value
  return editLorebook.value
    .map((e) => {
      const body = `${e.content}\n${e.persona}\n${e.memory}`.toLowerCase()
      const rank = e.title.toLowerCase().includes(q)
        ? 0
        : e.tagsText.toLowerCase().includes(q)
          ? 1
          : body.includes(q)
            ? 2
            : 3
      return { e, rank }
    })
    .filter((x) => x.rank < 3)
    .sort((a, b) => a.rank - b.rank)
    .map((x) => x.e)
})

const displayedLorebook = computed(() =>
  editLoreOrder.value === 'desc' ? [...filteredLorebook.value].reverse() : filteredLorebook.value,
)

async function saveEdit() {
  if (!editId.value) return
  editError.value = ''
  const seen = new Set<string>()
  const schema: PanelField[] = []
  for (const f of editSchema.value) {
    const key = f.key.trim()
    const label = f.label.trim()
    if (!key || !label) continue
    if (seen.has(key)) {
      editError.value = `字段标识重复：${key}`
      return
    }
    seen.add(key)
    schema.push({
      key,
      label,
      type: f.type,
      unit: f.unit?.trim() || undefined,
    })
  }
  if (schema.length === 0) {
    editError.value = '至少需要一个角色面板字段'
    return
  }
  const lorebook: LoreEntry[] = []
  for (const r of editLorebook.value) {
    const isChar = r.isCharacter === true
    const persona = r.persona.trim()
    const memory = r.memory.trim()
    // 非人物条目用 content；人物条目用 persona/memory，取消勾选「人物」时回退到 content 兜底
    const content = isChar ? '' : (r.content.trim() || persona || memory)
    const finalPersona = isChar ? (persona || content) : ''
    if (isChar) {
      if (!finalPersona && !memory) continue
    } else if (!content) {
      continue
    }
    const tags = r.tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => !!t)
    const links = r.linksText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => !!t)
    const aliases = r.aliasesText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => !!t)
    const lastVisitedTime = r.lastVisitedTimeText.trim()
    const whoList = r.accessWhoText.split(/[,，]/).map((s) => s.trim()).filter(Boolean)
    const access =
      r.accessMode === 'public'
        ? undefined
        : { mode: r.accessMode, who: r.accessMode === 'knownBy' ? whoList : undefined }
    lorebook.push({
      id: r.id,
      title: r.title.trim() || undefined,
      aliases: aliases.length > 0 ? aliases : undefined,
      lastVisitedTime: lastVisitedTime || undefined,
      tags,
      content,
      persona: isChar ? (finalPersona || undefined) : undefined,
      memory: isChar ? (memory || undefined) : undefined,
      migrated: isChar ? true : undefined,
      access,
      required: r.required,
      fixed: r.fixed === true ? true : undefined,
      links: links.length > 0 ? links : undefined,
      hidden: r.hidden === true ? true : undefined,
      isLocation: r.isLocation === true ? true : undefined,
      isCharacter: r.isCharacter === true ? true : undefined,
    })
  }
  try {
    await worldStore.updateWorld(editId.value, {
      worldSetting: editSetting.value,
      panelSchema: schema,
      lorebook,
    })
    if (editId.value === worldStore.currentWorldId) {
      await adventure.renormalize()
    }
    showEdit.value = false
  } catch (e) {
    editError.value = e instanceof Error ? e.message : String(e)
  }
}

async function saveEditAndStart() {
  await saveEdit()
  if (!editError.value && editId.value) {
    await adventure.open(editId.value)
  }
}

async function exportWorld(w: World) {
  importError.value = ''
  exporting.value = true
  try {
    const data = worldStore.exportWorld(w.id)
    if (data) await downloadJSON(`${safeFilename(w.name)}_${timestamp()}.dreams-world.json`, data)
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    exporting.value = false
  }
}

async function importWorldFile() {
  importError.value = ''
  importing.value = true
  try {
    const text = await pickJSONFile()
    const data = JSON.parse(text)
    // 若存在同源世界（id 相同），询问是「更新（保留存档）」还是「新建」
    const sourceId = typeof data?.id === 'string' && data.id.trim() ? data.id.trim() : undefined
    const existing = worldStore.findImportedWorld(sourceId)
    if (existing) {
      const update = window.confirm(
        `已存在同源世界「${existing.name}」。\n\n确定 = 更新该世界的设定、面板与世界书，保留当前冒险存档\n取消 = 创建全新世界`,
      )
      if (update) {
        await worldStore.updateImportedWorld(existing.id, data)
        worldStore.selectWorld(existing.id)
        await adventure.open(existing.id)
        await adventure.renormalize()
        return
      }
    }
    await worldStore.importWorld(data)
    await adventure.open(worldStore.currentWorldId)
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    importing.value = false
  }
}

async function doImportDlc() {
  dlcError.value = ''
  importingDlc.value = true
  const dlcId = createId()
  try {
    const zipBytes = await pickZipFile()
    const parsed = parseDlcZip(zipBytes)
    const m = parsed.manifest
    // 检测同名 DLC 世界：若已存在，询问用户是更新现有世界（保留存档）还是新建
    const existing = worldStore.worlds.find((w) => w.name === m.world.name && w.dlcId)
    if (existing) {
      const update = window.confirm(
        `已存在同名世界「${m.world.name}」。\n\n确定 = 更新该世界的设定与 BGM，保留当前冒险存档\n取消 = 创建全新世界`,
      )
      if (update) {
        const oldDlcId = existing.dlcId!
        await persistDlcAudio(oldDlcId, parsed.bgmBytes)
        clearBgmCache(oldDlcId)
        // 合并世界书（保留存档更新）：
        //  - DLC 初始条目：fixed 用新版覆盖；非 fixed 保留玩家版（避免吞掉彩蛋角色出场等玩家进度）
        //  - 玩家添加的条目（不在旧 DLC 初始列表）：保留
        //  - 新版新增条目：加入；新版删除的初始条目：移除
        const newLore = m.world.lorebook ?? []
        const oldLore = existing.lorebook ?? []
        const oldDlcTitles = new Set(existing.dlcLoreTitles ?? [])
        const newTitles = new Set(newLore.map((e) => (e.title ?? '').trim()).filter(Boolean))
        const oldByTitle = new Map(oldLore.map((e) => [(e.title ?? '').trim(), e]))
        const mergedLore: LoreEntry[] = []
        for (const e of newLore) {
          const t = (e.title ?? '').trim()
          const old = t ? oldByTitle.get(t) : undefined
          // 非 fixed 且旧世界已有同名 → 保留玩家版；否则采用新版
          mergedLore.push(old && e.fixed !== true ? old : e)
        }
        for (const e of oldLore) {
          const t = (e.title ?? '').trim()
          if (!t || oldDlcTitles.has(t) || newTitles.has(t)) continue
          mergedLore.push(e) // 玩家添加的条目，保留
        }
        // 合并 panelSchema：保留玩家新增的字段（旧有但新版无同 key），DLC 预设字段用新版
        const newSchema = m.world.panelSchema ?? []
        const oldSchema = existing.panelSchema ?? []
        const newKeys = new Set(newSchema.map((f) => f.key))
        const mergedSchema = [...newSchema, ...oldSchema.filter((f) => !newKeys.has(f.key))]
        await worldStore.updateDlcWorldMeta(existing.id, {
          worldSetting: m.world.worldSetting,
          panelSchema: mergedSchema,
          lorebook: mergedLore,
          bgm: parsed.bgm,
          sceneField: parsed.manifest.sceneField,
          presetCharacters: m.presetCharacters,
          characterFallback: parsed.manifest.characterFallback,
          dlcLoreTitles: newLore.map((e) => (e.title ?? '').trim()).filter((t) => !!t),
        })
        await adventure.open(existing.id)
        await adventure.renormalize()
        return
      }
    }
    await persistDlcAudio(dlcId, parsed.bgmBytes)
    try {
      const world = await worldStore.createDlcWorld(m.world.name, m.world.worldSetting, m.world.panelSchema, {
        dlcId,
        sceneField: parsed.manifest.sceneField,
        bgm: parsed.bgm,
        lorebook: m.world.lorebook,
        presetCharacters: m.presetCharacters,
        characterFallback: parsed.manifest.characterFallback,
      })
      await adventure.open(world.id)
    } catch (e) {
      await removeDlcAudio(dlcId).catch(() => {})
      throw e
    }
  } catch (e) {
    dlcError.value = errorMessage(e, settings.devMode)
  } finally {
    importingDlc.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>世界</h1>
    </header>

    <div v-if="worldStore.worlds.length === 0" class="empty">
      <p>还没有任何世界</p>
      <p>点击下方按钮，用你的创意生成第一个世界</p>
    </div>

    <p v-if="deleteError" class="delete-error">⚠ 删除失败：{{ deleteError }}</p>
    <p v-if="importError" class="delete-error">⚠ 导入失败：{{ importError }}</p>
    <p v-if="dlcError" class="delete-error">⚠ DLC 导入失败：{{ dlcError }}</p>
    <p v-if="dupError" class="delete-error">⚠ 复制失败：{{ dupError }}</p>

    <div class="world-list">
      <div
        v-for="w in worldStore.worlds"
        :key="w.id"
        class="world-card"
        :class="{ current: w.id === worldStore.currentWorldId }"
        @click="selectWorld(w.id)"
      >
        <div class="card-top">
          <input
            v-if="renamingWorldId === w.id"
            v-model="renamingWorldName"
            class="input world-name-edit"
            maxlength="60"
            @keyup.enter="commitRenameWorld(w)"
            @keyup.esc="renamingWorldId = null"
            @blur="commitRenameWorld(w)"
            @click.stop
          />
          <div
            v-else
            class="world-name"
            :title="'双击重命名'"
            @dblclick.stop="startRenameWorld(w)"
          >
            {{ w.name }}
            <span v-if="w.dlcId" class="dlc-badge">DLC</span>
          </div>
          <div class="card-btns">
            <button class="edit-btn" :disabled="duplicating" @click.stop="doDuplicate(w)">
              复制
            </button>
            <button class="edit-btn" @click.stop="openEdit(w)">设定</button>
            <button class="edit-btn" :disabled="exporting" @click.stop="exportWorld(w)">
              {{ exporting ? '导出中…' : '导出' }}
            </button>
            <button
              class="delete-btn"
              :class="{ confirm: confirmDeleteId === w.id }"
              @click.stop="onDelete(w.id)"
            >
              {{ confirmDeleteId === w.id ? '确认删除？' : '删除' }}
            </button>
          </div>
        </div>
        <div class="world-meta">更新于 {{ formatTime(Number(w.updatedAt)) }} · 双击名称可重命名</div>
      </div>
    </div>

    <div class="fab-row">
      <button class="fab" @click="showCreate = true">＋ 创建新世界</button>
      <button class="fab import-fab" :disabled="importing" @click="importWorldFile">
        {{ importing ? '导入中…' : '导入世界' }}
      </button>
      <button class="fab dlc-fab" :disabled="importingDlc" @click="doImportDlc">
        {{ importingDlc ? '导入中…' : '导入 DLC' }}
      </button>
    </div>

    <div v-if="showCreate" class="modal-mask" @click.self="showCreate = false">
      <div class="modal">
        <div class="modal-title-row">
          <h2>创建新世界</h2>
          <button class="empty-world-btn" @click="createEmptyWorld">创建空世界</button>
        </div>
        <label class="field-label">世界名称（可选）</label>
        <input v-model="newName" class="input" placeholder="例如：末日废土、仙侠大陆…" />
        <label class="field-label">世界设定 / 创意描述</label>
        <textarea
          v-model="newDesc"
          class="textarea"
          placeholder="描述你想要的世界的背景、风格、规则…或直接粘贴完整的世界设定，AI 会拆分并生成核心设定与世界书"
          rows="8"
        />
        <p class="desc-hint">设定会被拆为「精简核心设定 + 世界书条目」：越长越丰富，每轮只注入相关条目，更快更稳</p>
        <label class="checkbox-row">
          <input type="checkbox" v-model="enhanceSummarize" />
          <span>总结优化已有设定</span>
        </label>
        <label class="checkbox-row">
          <input type="checkbox" v-model="enhanceExpand" />
          <span>补充更多合理设定</span>
        </label>
        <p class="desc-hint">两者都不勾选：仅按原文忠实整理，尽量不改动内容</p>
        <label class="checkbox-row">
          <input type="checkbox" v-model="newMultiAgent" />
          <span>多智能体模式</span>
        </label>
        <p class="desc-hint">
          每个在场角色由独立 AI 扮演，各自拥有私密设定与记忆；旁白负责环境与未分配的路人。
          创建后不可更改（想换模式可复制世界）。
        </p>
        <p v-if="createError" class="error">{{ createError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" @click="showCreate = false">取消</button>
          <button class="btn primary" :disabled="creating" @click="doCreate">
            {{ creating ? '生成中…' : '生成并创建' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="showEdit" class="modal-mask" @click.self="showEdit = false">
      <div class="modal edit-modal">
        <h2>
          世界设定 · {{ editName }}
          <span v-if="editIsPreview" class="preview-badge">新生成 · 请确认</span>
        </h2>
        <div class="edit-tabs">
          <button class="edit-tab" :class="{ active: editTab === 'core' }" @click="editTab = 'core'">核心设定</button>
          <button class="edit-tab" :class="{ active: editTab === 'schema' }" @click="editTab = 'schema'">面板字段</button>
          <button class="edit-tab" :class="{ active: editTab === 'lore' }" @click="editTab = 'lore'">
            世界书<span v-if="editLorebook.length" class="tab-count">{{ editLorebook.length }}</span>
          </button>
          <button class="edit-tab" :class="{ active: editTab === 'agents' }" @click="editTab = 'agents'">
            智能体<span v-if="editMultiAgent && ma.npcs.length" class="tab-count">{{ ma.npcs.length }}</span>
          </button>
        </div>

        <div class="edit-sticky-actions">
          <p v-if="editError" class="error">{{ editError }}</p>
          <div class="modal-actions">
            <button class="btn ghost" @click="showEdit = false">{{ editIsPreview ? '跳过' : '取消' }}</button>
            <button v-if="editIsPreview" class="btn primary" @click="saveEditAndStart">保存并开始冒险</button>
            <button v-else class="btn primary" @click="saveEdit">保存</button>
          </div>
        </div>

        <div v-if="editTab === 'core'" class="edit-panel">
          <label class="field-label">核心设定（每轮必读，建议精简）</label>
          <textarea v-model="editSetting" class="textarea" rows="12" />
        </div>

        <div v-if="editTab === 'schema'" class="edit-panel">
          <div class="schema-header">
            <label class="field-label">角色面板字段<span class="scroll-hint">（可上下左右滚动查看/编辑）</span></label>
            <button class="add-field-btn add-field-top" @click="addField">＋ 添加字段</button>
          </div>
          <div class="schema-list">
            <div v-for="(f, i) in editSchema" :key="i" class="schema-row">
              <input v-model="f.key" class="schema-input key" placeholder="标识" />
              <input v-model="f.label" class="schema-input label" placeholder="显示名" />
              <select v-model="f.type" class="schema-input type">
                <option value="text">文本</option>
                <option value="number">数值</option>
              </select>
              <input v-model="f.unit" class="schema-input unit" placeholder="单位" />
              <button class="schema-move" :disabled="i === 0" @click="moveField(i, -1)">↑</button>
              <button class="schema-move" :disabled="i === editSchema.length - 1" @click="moveField(i, 1)">↓</button>
              <button class="schema-del" @click="removeField(i)">✕</button>
            </div>
          </div>
        </div>

        <div v-if="editTab === 'lore'" class="edit-panel">
          <div class="lore-toolbar">
            <label class="field-label">世界书（按需注入的详细设定）</label>
            <button
              class="lore-order-btn"
              @click="editLoreOrder = editLoreOrder === 'asc' ? 'desc' : 'asc'"
            >
              {{ editLoreOrder === 'asc' ? '正序 ↑' : '倒序 ↓' }}
            </button>
          </div>
          <div class="lore-toolbar">
            <input v-model="editLoreFilter" class="input lore-search" placeholder="检索条目（标题/标签/内容）" />
            <button class="add-field-btn lore-add-top" @click="addLoreEntry">＋ 添加条目</button>
          </div>
          <div class="lore-list">
            <div v-for="entry in displayedLorebook" :key="entry.id" class="lore-card">
              <div class="lore-head">
                <input v-model="entry.title" class="input lore-title" placeholder="条目标题（可选）" />
                <button
                  class="schema-del"
                  :class="{ confirm: confirmLoreDeleteId === entry.id }"
                  @click="removeLoreEntry(entry.id)"
                >
                  {{ confirmLoreDeleteId === entry.id ? '确认删除？' : '✕' }}
                </button>
              </div>
              <div class="lore-flags">
                <label class="lore-required">
                  <input type="checkbox" v-model="entry.required" />
                  <span>必需</span>
                </label>
                <label class="lore-required">
                  <input type="checkbox" v-model="entry.fixed" />
                  <span>固定</span>
                </label>
                <label class="lore-required">
                  <input type="checkbox" v-model="entry.isLocation" />
                  <span>地点</span>
                </label>
                <label class="lore-required">
                  <input type="checkbox" v-model="entry.isCharacter" />
                  <span>人物</span>
                </label>
              </div>
              <input v-model="entry.aliasesText" @blur="entry.aliasesText = normalizeListText(entry.aliasesText)" class="input lore-tags" placeholder="别名/曾用称呼（逗号分隔，如：神秘人, 旧称）" />
              <select v-if="editMultiAgent" v-model="entry.accessMode" class="input lore-tags">
                <option value="public">可见性：公开（所有角色都能知道）</option>
                <option value="secret">可见性：秘密（仅旁白可见）</option>
                <option v-if="entry.accessMode === 'knownBy'" value="knownBy">
                  可见性：仅指定角色（由剧情揭示）
                </option>
              </select>
              <input v-model="entry.lastVisitedTimeText" class="input lore-tags" placeholder="上次到访时间（冒险时间，如：启程第12天·深秋·入夜前）" />
              <input v-model="entry.tagsText" @blur="entry.tagsText = normalizeListText(entry.tagsText)" class="input lore-tags" placeholder="标签（逗号分隔，如：山脉, 鹰族, 边境）" />
              <input v-model="entry.linksText" @blur="entry.linksText = normalizeListText(entry.linksText)" class="input lore-tags" placeholder="关联条目（逗号分隔的条目标题，注入时一并带入）" />
              <template v-if="entry.isCharacter">
                <label class="field-label lore-sub-label">设定（身份/性格/关系基础，相对稳定）</label>
                <textarea v-model="entry.persona" class="textarea" rows="4" placeholder="这个人物是谁：身份、性格、外貌、能力、与他人的关系基础" />
                <label class="field-label lore-sub-label">记忆（经历/承诺/状态，随剧情更新）</label>
                <textarea v-model="entry.memory" class="textarea" rows="4" placeholder="这个人物记得什么：每条以时间开头，如「第3天：答应带你同行」" />
              </template>
              <textarea v-else v-model="entry.content" class="textarea" rows="4" placeholder="条目详细设定内容" />
            </div>
            <p v-if="displayedLorebook.length === 0" class="muted-text">
              {{ editLorebook.length === 0 ? '暂无世界书条目' : '没有匹配的条目' }}
            </p>
          </div>
        </div>

        <div v-if="editTab === 'agents'" class="edit-panel">
          <template v-if="editMultiAgent">
            <p class="desc-hint">
              勾选「独立智能体」后，该角色由单独的 AI 扮演并拥有私有设定与记忆。
              旁白与玩家角色始终存在，也可在此编辑。
            </p>
            <div v-for="row in agentRows" :key="row.charId" class="agent-card">
              <div class="agent-head">
                <button class="agent-name-btn" @click="openAgentPanel(row.charId)">
                  {{ row.name }}<span class="agent-role">{{ row.role }}</span>
                </button>
                <label v-if="!row.system" class="lore-required">
                  <input type="checkbox" :checked="row.assigned" @change="toggleAssign(row)" />
                  <span>独立智能体</span>
                </label>
                <span v-else class="agent-badge">系统</span>
              </div>
              <p v-if="row.assigned" class="agent-meta">
                记忆 {{ row.memoryLen }} 字{{ row.present ? ' · 在场' : '' }}
              </p>
              <template v-if="expandedAgent === row.charId">
                <label class="lore-sub-label">私有设定（仅本人上下文可见）</label>
                <textarea
                  v-model="agentDraft.privatePersona"
                  class="textarea"
                  rows="4"
                  placeholder="只有这个角色自己知道的设定：秘密、真实目的、内心立场"
                />
                <label class="lore-sub-label">记忆（每条以时间开头）</label>
                <textarea
                  v-model="agentDraft.memory"
                  class="textarea"
                  rows="6"
                  placeholder="第3天：他答应了带你同行……"
                />
                <label class="lore-sub-label">记忆摘要（更早内容的压缩，可留空）</label>
                <textarea v-model="agentDraft.memorySummary" class="textarea" rows="3" placeholder="更早经历的摘要" />
                <div class="agent-actions">
                  <button class="btn primary" @click="saveAgentPanel">保存</button>
                  <button class="btn ghost" @click="expandedAgent = null">取消</button>
                  <button class="btn ghost" @click="clearAgentMemory(row.charId)">清空记忆</button>
                </div>
              </template>
            </div>
            <p v-if="agentRows.length <= 2" class="muted-text">
              世界书里还没有人物条目，先到「世界书」添加条目并勾选「人物」。
            </p>
          </template>
          <p v-else class="muted-text">
            这个世界未开启多智能体模式。该模式需在创建世界时选择，创建后不可更改。
          </p>
        </div>

      </div>
    </div>
  </div>
</template>

<style scoped>
.page {
  padding: 16px;
  min-height: 100%;
}
.header h1 {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 16px;
}
.empty {
  text-align: center;
  color: var(--muted);
  padding: 60px 20px;
  line-height: 1.8;
}
.delete-error {
  color: var(--danger);
  font-size: 13px;
  padding: 8px 12px;
  background: rgba(255, 95, 95, 0.1);
  border-radius: 8px;
  margin-bottom: 12px;
}
.world-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.world-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px;
}
.world-card.current {
  border-color: var(--active);
  background: #0d1b2e;
}
.card-top {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
}
.world-name {
  font-size: 17px;
  font-weight: 600;
  margin-bottom: 6px;
  word-break: break-all;
}
.world-name-edit {
  margin-bottom: 6px;
  padding: 6px 10px;
  font-size: 16px;
  font-weight: 600;
}
.delete-btn {
  flex: none;
  background: transparent;
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12px;
}
.delete-btn.confirm {
  color: #fff;
  background: var(--danger);
  border-color: var(--danger);
}
.world-meta {
  font-size: 12px;
  color: var(--muted);
}
.fab-row {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: 88px;
  display: flex;
  gap: 8px;
}
.fab {
  background: var(--yellow);
  color: #000;
  font-weight: 700;
  padding: 10px 10px;
  border-radius: 20px;
  font-size: 14px;
  white-space: nowrap;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.5);
  flex: 1.6;
}
.fab:disabled {
  opacity: 0.5;
}
.import-fab {
  background: var(--surface);
  color: var(--active);
  border: 1px solid var(--active);
  font-size: 12px;
  flex: 1;
}
.dlc-fab {
  background: var(--surface);
  color: var(--yellow);
  border: 1px solid var(--yellow);
  font-size: 12px;
  flex: 1;
}
.dlc-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  color: #000;
  background: var(--yellow);
  border-radius: 4px;
  padding: 1px 5px;
  margin-left: 6px;
  vertical-align: middle;
}
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
  padding: 20px;
}
.modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  padding: 20px;
  width: 100%;
  max-width: 420px;
}
.modal h2 {
  font-size: 18px;
  margin-bottom: 16px;
}
.modal-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.modal-title-row h2 {
  margin-bottom: 0;
}
.empty-world-btn {
  flex: none;
  background: var(--surface-2);
  color: var(--active);
  border: 1px solid var(--active);
  border-radius: 8px;
  padding: 6px 12px;
  font-size: 13px;
  white-space: nowrap;
  cursor: pointer;
}
.field-label {
  display: block;
  font-size: 13px;
  color: var(--muted);
  margin: 12px 0 6px;
}
.desc-hint {
  color: var(--muted);
  font-size: 12px;
  margin: 6px 0 0;
}
.checkbox-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  font-size: 13px;
  color: var(--muted);
  cursor: pointer;
}
.checkbox-row input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}
.input,
.textarea {
  width: 100%;
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  resize: none;
}
.error {
  color: var(--danger);
  font-size: 13px;
  margin-top: 10px;
  white-space: pre-wrap;
  word-break: break-word;
}
.modal-actions {
  display: flex;
  gap: 12px;
  margin-top: 18px;
}
.btn {
  flex: 1;
  padding: 12px;
  border-radius: 8px;
  font-size: 15px;
}
.btn.primary {
  background: var(--active);
  color: #fff;
  font-weight: 600;
}
.btn.primary:disabled {
  opacity: 0.5;
}
.btn.ghost {
  background: var(--surface-2);
  color: var(--text);
  border: 1px solid var(--border);
}
.card-btns {
  display: flex;
  gap: 8px;
  flex: none;
}
.edit-btn {
  background: transparent;
  color: var(--active);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 5px 12px;
  font-size: 12px;
}
.edit-btn:disabled {
  opacity: 0.5;
}
.edit-modal {
  max-width: 480px;
  max-height: 85vh;
  overflow-y: auto;
}
.edit-sticky-actions {
  position: sticky;
  top: 0;
  z-index: 10;
  background: var(--surface);
  padding: 8px 0 10px;
  margin-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.edit-sticky-actions .modal-actions {
  margin-top: 8px;
}
.edit-sticky-actions .error {
  margin-top: 4px;
}
.schema-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 8px;
}
.schema-header .field-label {
  margin: 0;
}
.scroll-hint {
  font-size: 11px;
  color: var(--muted);
  font-weight: 400;
  margin-left: 4px;
}
.add-field-top {
  flex: none;
  width: auto;
  white-space: nowrap;
  padding: 6px 12px;
  font-size: 13px;
}
.schema-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 8px;
}
.schema-row {
  display: flex;
  gap: 6px;
  align-items: center;
}
.schema-input {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 8px;
  font-size: 13px;
}
.schema-input.key {
  flex: 1;
}
.schema-input.label {
  flex: 1.2;
}
.schema-input.type {
  flex: none;
  width: 64px;
}
.schema-input.unit {
  flex: none;
  width: 60px;
}
.schema-move {
  flex: none;
  background: transparent;
  color: var(--muted);
  border: none;
  font-size: 14px;
  padding: 4px 6px;
  cursor: pointer;
}
.schema-move:disabled {
  opacity: 0.3;
  cursor: default;
}
.schema-del {
  flex: none;
  background: transparent;
  color: var(--danger);
  border: none;
  font-size: 16px;
  padding: 4px 8px;
}
.schema-del.confirm {
  color: #fff;
  background: var(--danger);
  border-radius: 6px;
  font-size: 12px;
  padding: 4px 8px;
}
.add-field-btn {
  background: var(--surface-2);
  color: var(--active);
  border: 1px dashed var(--border);
  border-radius: 8px;
  padding: 8px;
  width: 100%;
  font-size: 14px;
}
.lore-search {
  margin-bottom: 10px;
  flex: 1;
}
.lore-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lore-toolbar .field-label {
  margin-bottom: 0;
}
.lore-order-btn {
  flex: none;
  background: var(--surface-2);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 13px;
  cursor: pointer;
}
.lore-add-top {
  flex: none;
  width: auto;
  white-space: nowrap;
  padding: 8px 12px;
}
.lore-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 10px;
}
.lore-card {
  background: var(--surface-2);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.lore-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.lore-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 6px;
}
.lore-title {
  flex: 1;
}
.lore-required {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  cursor: pointer;
}
.lore-required input {
  width: 14px;
  height: 14px;
  cursor: pointer;
}
.lore-tags {
  font-size: 13px;
}
.muted-text {
  color: var(--muted);
  font-size: 13px;
  text-align: center;
  padding: 12px 0;
}
.lore-sub-label {
  display: block;
  margin: 10px 0 4px;
  font-size: 12px;
  color: var(--muted);
}
.agent-card {
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  padding: 12px;
  margin-bottom: 10px;
}
.agent-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.agent-name-btn {
  background: none;
  border: none;
  padding: 0;
  color: var(--text);
  font-size: 14px;
  text-align: left;
  cursor: pointer;
}
.agent-role {
  margin-left: 8px;
  font-size: 12px;
  color: var(--muted);
}
.agent-badge {
  font-size: 11px;
  color: var(--muted);
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 6px;
  padding: 1px 6px;
}
.agent-meta {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted);
}
.agent-actions {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.edit-tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
}
.edit-tab {
  flex: 1;
  padding: 8px 0;
  border-radius: 10px;
  background: var(--surface);
  color: var(--muted);
  font-size: 14px;
  border: 1px solid var(--border);
  text-align: center;
}
.edit-tab.active {
  color: var(--active);
  border-color: var(--active);
  background: #0d1b2e;
}
.tab-count {
  display: inline-block;
  font-size: 11px;
  color: var(--muted);
  margin-left: 4px;
}
.edit-tab.active .tab-count {
  color: var(--active);
}
.preview-badge {
  display: inline-block;
  font-size: 12px;
  color: var(--yellow);
  margin-left: 8px;
  vertical-align: middle;
}
.edit-panel {
  min-height: 200px;
}
</style>