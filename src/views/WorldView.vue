<script setup lang="ts">
import { computed, ref } from 'vue'
import { useWorldStore } from '@/stores/world'
import { useAdventureStore } from '@/stores/adventure'
import { useSettingsStore } from '@/stores/settings'
import { generateWorld } from '@/ai/service'
import { errorMessage } from '@/ai/client'
import { downloadJSON, pickJSONFile, safeFilename, timestamp } from '@/utils/file'
import { pickZipFile, parseDlcZip, persistDlcAudio, removeDlcAudio } from '@/dlc'
import { clearBgmCache } from '@/audio/bgm'
import { createId } from '@/types'
import type { PanelField, World, LoreEntry } from '@/types'

const worldStore = useWorldStore()
const adventure = useAdventureStore()
const settings = useSettingsStore()

const showCreate = ref(false)
const newName = ref('')
const newDesc = ref('')

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
  tagsText: string
  content: string
  required: boolean
  fixed?: boolean
  linksText: string
  hidden?: boolean
}
const editLorebook = ref<LoreEditRow[]>([])
const editLoreFilter = ref('')
const editIsPreview = ref(false) // 新建世界后预览模式
const editTab = ref<'core' | 'schema' | 'lore'>('core')
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
    const world = await worldStore.createWorld(name, worldSetting, panelSchema, lorebook)
    showCreate.value = false
    newName.value = ''
    newDesc.value = ''
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
  editLorebook.value = (w.lorebook ?? []).map((e) => ({
    id: e.id,
    title: e.title ?? '',
    tagsText: (e.tags ?? []).join(', '),
    content: e.content ?? '',
    required: !!e.required,
    fixed: !!e.fixed,
    linksText: (e.links ?? []).join(', '),
    hidden: e.hidden,
  }))
  editLoreFilter.value = ''
  editError.value = ''
  editIsPreview.value = false
  editTab.value = 'core'
  showEdit.value = true
}

function addField() {
  editSchema.value.push({ key: '', label: '', type: 'text', unit: '' })
}

function removeField(i: number) {
  editSchema.value.splice(i, 1)
}

function addLoreEntry() {
  editLorebook.value.push({ id: createId(), title: '', tagsText: '', content: '', required: false, linksText: '' })
}

function removeLoreEntry(id: string) {
  editLorebook.value = editLorebook.value.filter((e) => e.id !== id)
}

const filteredLorebook = computed(() => {
  const q = editLoreFilter.value.trim().toLowerCase()
  if (!q) return editLorebook.value
  return editLorebook.value.filter(
    (e) =>
      e.title.toLowerCase().includes(q) ||
      e.tagsText.toLowerCase().includes(q) ||
      e.content.toLowerCase().includes(q),
  )
})

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
    const content = r.content.trim()
    if (!content) continue
    const tags = r.tagsText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => !!t)
    const links = r.linksText
      .split(/[,，]/)
      .map((t) => t.trim())
      .filter((t) => !!t)
    lorebook.push({
      id: r.id,
      title: r.title.trim() || undefined,
      tags,
      content,
      required: r.required,
      fixed: r.fixed === true ? true : undefined,
      links: links.length > 0 ? links : undefined,
      hidden: r.hidden === true ? true : undefined,
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
        await worldStore.updateDlcWorldMeta(existing.id, {
          worldSetting: m.world.worldSetting,
          panelSchema: m.world.panelSchema,
          lorebook: m.world.lorebook,
          bgm: parsed.bgm,
          sceneField: parsed.manifest.sceneField,
          presetCharacters: m.presetCharacters,
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
        <h2>创建新世界</h2>
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
        </div>

        <div v-if="editTab === 'core'" class="edit-panel">
          <label class="field-label">核心设定（每轮必读，建议精简）</label>
          <textarea v-model="editSetting" class="textarea" rows="12" />
        </div>

        <div v-if="editTab === 'schema'" class="edit-panel">
          <label class="field-label">角色面板字段</label>
          <div class="schema-list">
            <div v-for="(f, i) in editSchema" :key="i" class="schema-row">
              <input v-model="f.key" class="schema-input key" placeholder="标识" />
              <input v-model="f.label" class="schema-input label" placeholder="显示名" />
              <select v-model="f.type" class="schema-input type">
                <option value="text">文本</option>
                <option value="number">数值</option>
              </select>
              <input v-model="f.unit" class="schema-input unit" placeholder="单位" />
              <button class="schema-del" @click="removeField(i)">✕</button>
            </div>
          </div>
          <button class="add-field-btn" @click="addField">＋ 添加字段</button>
        </div>

        <div v-if="editTab === 'lore'" class="edit-panel">
          <label class="field-label">世界书（按需注入的详细设定）</label>
          <input v-model="editLoreFilter" class="input lore-search" placeholder="检索条目（标题 / 标签 / 内容）…" />
          <div class="lore-list">
            <div v-for="entry in filteredLorebook" :key="entry.id" class="lore-card">
              <div class="lore-head">
                <input v-model="entry.title" class="input lore-title" placeholder="条目标题（可选）" />
                <label class="lore-required">
                  <input type="checkbox" v-model="entry.required" />
                  <span>必带</span>
                </label>
                <label class="lore-required">
                  <input type="checkbox" v-model="entry.fixed" />
                  <span>固定</span>
                </label>
                <button class="schema-del" @click="removeLoreEntry(entry.id)">✕</button>
              </div>
              <input v-model="entry.tagsText" class="input lore-tags" placeholder="标签（逗号分隔，如：山脉, 鹰族, 边境）" />
              <input v-model="entry.linksText" class="input lore-tags" placeholder="关联条目（逗号分隔的条目标题，注入时一并带入）" />
              <textarea v-model="entry.content" class="textarea" rows="4" placeholder="条目详细设定内容" />
            </div>
            <p v-if="filteredLorebook.length === 0" class="muted-text">
              {{ editLorebook.length === 0 ? '暂无世界书条目' : '没有匹配的条目' }}
            </p>
          </div>
          <button class="add-field-btn" @click="addLoreEntry">＋ 添加条目</button>
        </div>

        <p v-if="editError" class="error">{{ editError }}</p>
        <div class="modal-actions">
          <button class="btn ghost" @click="showEdit = false">{{ editIsPreview ? '跳过' : '取消' }}</button>
          <button v-if="editIsPreview" class="btn primary" @click="saveEditAndStart">保存并开始冒险</button>
          <button v-else class="btn primary" @click="saveEdit">保存</button>
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
.schema-del {
  flex: none;
  background: transparent;
  color: var(--danger);
  border: none;
  font-size: 16px;
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