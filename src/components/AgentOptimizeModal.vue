<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useMaStore } from '@/stores/multiagent'
import { useWorldStore } from '@/stores/world'
import { useSettingsStore } from '@/stores/settings'
import { optimizeAgentPersona } from '@/ai/agents'
import { errorMessage } from '@/ai/client'
import { loreEntryText } from '@/ai/prompts'

const props = defineProps<{ charId: string }>()
const emit = defineEmits<{ close: []; applied: [] }>()

const ma = useMaStore()
const worldStore = useWorldStore()
const settings = useSettingsStore()

const agent = computed(() => ma.agentOf(props.charId))
const loading = ref(false)
const error = ref('')
const draft = ref('')
const generated = ref('') // AI 原始生成结果，便于改了之后一键退回

async function run() {
  const world = worldStore.currentWorld
  const a = agent.value
  if (!world || !a) return
  loading.value = true
  error.value = ''
  try {
    const entry = (world.lorebook ?? []).find((e) => e.id === props.charId)
    draft.value = await optimizeAgentPersona(
      {
        worldName: world.name,
        name: a.name,
        currentPersona: a.privatePersona,
        memory: a.memory,
        stance: a.stance ?? '',
        relatedLore: entry ? loreEntryText(entry, props.charId) : '',
      },
      settings.config,
    )
    generated.value = draft.value
  } catch (e) {
    error.value = errorMessage(e, settings.devMode)
  } finally {
    loading.value = false
  }
}

async function apply() {
  if (!draft.value.trim()) return
  await ma.updateAgent(props.charId, { privatePersona: draft.value.trim() })
  emit('applied')
  emit('close')
}

onMounted(run)
</script>

<template>
  <div class="ao-mask" @click.self="emit('close')">
    <div class="ao-card">
      <h3 class="ao-title">优化人设 · {{ agent?.name ?? '' }}</h3>
      <p class="ao-hint">
        会根据现有设定与记忆重写一份更“可演”的人设（说话方式、习惯、在意的东西、边界）。
        右侧可以直接修改，改完点“采用这份”；确认后才会替换，随时可以取消。
      </p>
      <div v-if="error" class="ao-error">⚠ {{ error }}</div>
      <div class="ao-compare">
        <div class="ao-col">
          <p class="ao-label">当前</p>
          <textarea class="ao-text" rows="12" :value="agent?.privatePersona ?? ''" readonly />
        </div>
        <div class="ao-col">
          <p class="ao-label">优化后{{ loading ? '（生成中…）' : '（可编辑）' }}</p>
          <textarea v-model="draft" class="ao-text" rows="12" placeholder="等待生成…" />
        </div>
      </div>
      <div class="ao-actions">
        <button
          v-if="generated && draft !== generated"
          class="ao-btn ghost"
          :disabled="loading"
          @click="draft = generated"
        >
          恢复生成结果
        </button>
        <button class="ao-btn ghost" :disabled="loading" @click="run">重新生成</button>
        <button class="ao-btn ghost" @click="emit('close')">取消</button>
        <button class="ao-btn primary" :disabled="loading || !draft.trim()" @click="apply">采用这份</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ao-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 200;
  padding: 16px;
}
.ao-card {
  background: var(--bg, #1a1a1a);
  color: var(--text, #eee);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  padding: 16px;
  width: 100%;
  max-width: 760px;
  max-height: 90vh;
  overflow-y: auto;
}
.ao-title {
  font-size: 16px;
  margin-bottom: 6px;
}
.ao-hint {
  font-size: 12px;
  color: var(--muted, #999);
  line-height: 1.6;
  margin-bottom: 10px;
}
.ao-error {
  color: #e08a8a;
  font-size: 12px;
  margin-bottom: 8px;
}
.ao-compare {
  display: flex;
  gap: 10px;
}
.ao-col {
  flex: 1;
  min-width: 0;
}
.ao-label {
  font-size: 12px;
  color: var(--muted, #999);
  margin-bottom: 4px;
}
.ao-text {
  width: 100%;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px;
  color: inherit;
  font-size: 13px;
  line-height: 1.6;
  padding: 8px;
  resize: vertical;
}
.ao-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 12px;
}
.ao-btn {
  font-size: 13px;
  padding: 6px 14px;
  border-radius: 8px;
  cursor: pointer;
  border: 1px solid rgba(255, 255, 255, 0.16);
  background: none;
  color: inherit;
}
.ao-btn.primary {
  background: #c9a227;
  border-color: #c9a227;
  color: #1a1a1a;
}
.ao-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
@media (max-width: 560px) {
  .ao-compare {
    flex-direction: column;
  }
}
</style>
