<script setup lang="ts">
import { ref, watch } from 'vue'
import { useAdventureStore } from '@/stores/adventure'
import { useWorldStore } from '@/stores/world'
import { downloadJSON, downloadText, pickJSONFile, safeFilename, timestamp } from '@/utils/file'
import type { SavePoint } from '@/types'

const adventure = useAdventureStore()
const worldStore = useWorldStore()
const name = ref('')
const confirmId = ref<string | null>(null)
const confirmRestart = ref(false)
const restartError = ref('')
const importError = ref('')
const exporting = ref(false)
const importing = ref(false)
const saving = ref(false)
const opError = ref('')
const novelExporting = ref(false)
const novelFrom = ref(1)
const novelTo = ref(1)
const novelFromEdited = ref(false)
const novelToEdited = ref(false)

watch(() => adventure.currentIndex, (idx) => {
  const current = idx >= 0 ? idx + 1 : 1
  if (!novelFromEdited.value) novelFrom.value = 1
  if (!novelToEdited.value) novelTo.value = current
})

async function save() {
  if (saving.value) return
  saving.value = true
  opError.value = ''
  try {
    await adventure.createSavePoint(name.value)
    name.value = ''
  } catch (e) {
    opError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

async function onLoad(sp: SavePoint) {
  if (confirmId.value === sp.id) {
    opError.value = ''
    try {
      await adventure.loadSavePoint(sp)
      confirmId.value = null
    } catch (e) {
      opError.value = e instanceof Error ? e.message : String(e)
    }
  } else {
    confirmId.value = sp.id
  }
}

async function remove(id: string) {
  opError.value = ''
  try {
    await adventure.removeSavePoint(id)
  } catch (e) {
    opError.value = e instanceof Error ? e.message : String(e)
  }
}

async function onRestart() {
  if (!confirmRestart.value) {
    confirmRestart.value = true
    return
  }
  confirmRestart.value = false
  restartError.value = ''
  try {
    await adventure.resetAdventure()
  } catch (e) {
    restartError.value = e instanceof Error ? e.message : String(e)
  }
}

async function exportAdventure() {
  importError.value = ''
  exporting.value = true
  try {
    const data = adventure.exportAdventure()
    if (!data) {
      importError.value = '当前没有可导出的冒险数据'
      return
    }
    const worldName = worldStore.currentWorld?.name ?? 'adventure'
    await downloadJSON(`${safeFilename(worldName)}_${timestamp()}.dreams-adventure.json`, data)
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    exporting.value = false
  }
}

async function importAdventureFile() {
  importError.value = ''
  importing.value = true
  try {
    const text = await pickJSONFile()
    const data = JSON.parse(text)
    await adventure.importAdventure(data)
  } catch (e) {
    importError.value = e instanceof Error ? e.message : String(e)
  } finally {
    importing.value = false
  }
}

function formatTime(t: number): string {
  return new Date(t).toLocaleString('zh-CN', { hour12: false })
}

async function exportNovel() {
  importError.value = ''
  opError.value = ''
  if (adventure.pages.length === 0) {
    opError.value = '当前没有可导出的故事内容'
    return
  }
  const from = Math.round(novelFrom.value)
  const to = Math.round(novelTo.value)
  const total = adventure.pages.length
  if (!Number.isFinite(from) || !Number.isFinite(to)) {
    opError.value = '页码范围无效'
    return
  }
  const first = Math.max(1, Math.min(from, total))
  const last = Math.max(first, Math.min(to, total))
  const worldName = worldStore.currentWorld?.name ?? '冒险记录'
  const lines: string[] = [`${worldName}`, `（节选自冒险记录 · 第 ${first}-${last} 页）`, '']
  for (let i = first - 1; i <= last - 1; i++) {
    const p = adventure.pages[i]
    if (!p) continue
    lines.push(`【第 ${i + 1} 页】`)
    if (p.playerInput && p.playerInput.trim()) {
      lines.push(`》${p.playerInput.trim()}`)
    }
    lines.push(p.narration.trim(), '')
  }
  lines.push(`—— 完 · 共 ${last - first + 1} 页 ——`)
  novelExporting.value = true
  try {
    await downloadText(`${safeFilename(worldName)}_小说_${timestamp()}.txt`, lines.join('\n'))
  } catch (e) {
    opError.value = e instanceof Error ? e.message : String(e)
  } finally {
    novelExporting.value = false
  }
}
</script>

<template>
  <div class="page">
    <header class="header">
      <h1>存档</h1>
    </header>

    <div v-if="adventure.hasAdventure" class="save-bar">
      <input v-model="name" class="input" placeholder="存档点名称（可选）" />
      <button class="save-btn" :disabled="saving" @click="save">
        {{ saving ? '保存中…' : '保存当前存档' }}
      </button>
    </div>

    <div v-if="adventure.hasAdventure" class="restart-bar">
      <button
        class="restart-btn"
        :class="{ confirm: confirmRestart }"
        @click="onRestart"
      >
        {{ confirmRestart ? '确认重新开始？将清除当前冒险' : '重新开始冒险' }}
      </button>
    </div>

    <p v-if="restartError" class="restart-error">⚠ {{ restartError }}</p>

    <p v-if="opError" class="restart-error">⚠ {{ opError }}</p>

    <div class="io-bar">
      <button v-if="adventure.hasAdventure" class="io-btn" :disabled="exporting" @click="exportAdventure">
        {{ exporting ? '导出中…' : '导出冒险' }}
      </button>
      <button class="io-btn import" :disabled="importing" @click="importAdventureFile">
        {{ importing ? '导入中…' : '导入冒险' }}
      </button>
    </div>

    <div v-if="adventure.hasAdventure" class="novel-bar">
      <button class="io-btn novel" :disabled="novelExporting" @click="exportNovel">
        {{ novelExporting ? '导出中…' : '导出为小说' }}
      </button>
      <input
        v-model.number="novelFrom"
        type="number"
        min="1"
        :max="adventure.pages.length"
        class="page-input"
        @input="novelFromEdited = true"
      />
      <span class="range-sep">~</span>
      <input
        v-model.number="novelTo"
        type="number"
        min="1"
        :max="adventure.pages.length"
        class="page-input"
        @input="novelToEdited = true"
      />
    </div>

    <p v-if="importError" class="restart-error">⚠ {{ importError }}</p>

    <p
      v-if="!adventure.hasAdventure && adventure.savePoints.length === 0"
      class="empty"
    >
      当前世界尚未开始冒险，也没有存档点
    </p>

    <div v-if="adventure.savePoints.length > 0" class="list">
      <div v-for="sp in adventure.savePoints" :key="sp.id" class="card">
        <div class="card-name">{{ sp.name }}</div>
        <div class="card-meta">第 {{ sp.pageIndex + 1 }} 页 · {{ formatTime(Number(sp.createdAt)) }}</div>
        <div class="card-actions">
          <button
            class="btn-load"
            :class="{ confirm: confirmId === sp.id }"
            @click="onLoad(sp)"
          >
            {{ confirmId === sp.id ? '确认读档？' : '读档' }}
          </button>
          <button class="btn-del" @click="remove(sp.id)">删除</button>
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
  padding: 40px 20px;
  line-height: 1.8;
}
.save-bar {
  display: flex;
  gap: 8px;
  margin-bottom: 18px;
}
.input {
  flex: 1;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
}
.save-btn {
  flex: none;
  background: var(--yellow);
  color: #000;
  font-weight: 700;
  border-radius: 10px;
  padding: 0 16px;
}
.card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px;
  margin-bottom: 10px;
}
.card-name {
  font-weight: 600;
  font-size: 16px;
  margin-bottom: 4px;
}
.card-meta {
  color: var(--muted);
  font-size: 12px;
  margin-bottom: 12px;
}
.card-actions {
  display: flex;
  gap: 10px;
}
.btn-load {
  background: var(--active);
  color: #fff;
  font-weight: 600;
  border-radius: 8px;
  padding: 8px 16px;
}
.btn-load.confirm {
  background: var(--danger);
}
.btn-del {
  background: var(--surface-2);
  color: var(--muted);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 8px 16px;
}
.restart-bar {
  margin-bottom: 18px;
}
.restart-btn {
  width: 100%;
  background: var(--surface);
  color: var(--danger);
  border: 1px solid var(--danger);
  border-radius: 10px;
  padding: 12px;
  font-size: 15px;
}
.restart-btn.confirm {
  background: var(--danger);
  color: #fff;
}
.restart-error {
  color: var(--danger);
  font-size: 13px;
  padding: 8px 12px;
  background: rgba(255, 95, 95, 0.1);
  border-radius: 8px;
  margin-bottom: 12px;
}
.io-bar {
  display: flex;
  gap: 10px;
  margin-bottom: 18px;
}
.io-btn {
  flex: 1;
  background: var(--surface);
  color: var(--active);
  border: 1px solid var(--active);
  border-radius: 10px;
  padding: 12px;
  font-size: 15px;
}
.io-btn.import {
  color: var(--text);
  border-color: var(--border);
}
.io-btn:disabled {
  opacity: 0.5;
}
.novel-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 18px;
}
.io-btn.novel {
  padding: 10px 14px;
  font-size: 14px;
}
.page-input {
  width: 64px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 8px;
  text-align: center;
  color: var(--text);
}
.range-sep {
  color: var(--muted);
}
</style>