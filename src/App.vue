<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue'
import { useRouter } from 'vue-router'
import { useSettingsStore } from '@/stores/settings'
import { useWorldStore } from '@/stores/world'
import { useAdventureStore } from '@/stores/adventure'
import { setBgmMuted } from '@/audio/bgm'
import BottomBar from '@/components/BottomBar.vue'

const settings = useSettingsStore()
const worldStore = useWorldStore()
const adventure = useAdventureStore()
const router = useRouter()

const loadingSeconds = ref(0)
let loadingTimer: ReturnType<typeof setInterval> | null = null

const isLongSetting = computed(() => (worldStore.currentWorld?.worldSetting?.length ?? 0) > 5000)

// 显示设置：应用到全局 CSS 变量
function applyDisplaySettings() {
  const root = document.documentElement
  root.style.setProperty('--text', settings.textColor)
  root.style.setProperty('--bg', settings.bgColor)
  root.style.setProperty('--font-size-narration', settings.fontSize + 'px')
}
watch(() => settings.textColor, applyDisplaySettings)
watch(() => settings.bgColor, applyDisplaySettings)
watch(() => settings.fontSize, applyDisplaySettings)

watch(
  () => adventure.loading,
  (v, old) => {
    if (v) {
      loadingSeconds.value = 0
      loadingTimer = setInterval(() => {
        loadingSeconds.value++
      }, 1000)
    } else {
      if (loadingTimer) clearInterval(loadingTimer)
      loadingTimer = null
      // 生成完成：如果当前不在冒险页，自动跳转
      if (old && adventure.hasAdventure && router.currentRoute.value.name !== 'adventure') {
        router.push('/adventure')
      }
    }
  },
)

onMounted(async () => {
  try {
    await Promise.all([settings.load(), worldStore.load()])
    applyDisplaySettings()
    await setBgmMuted(settings.muted)
    await adventure.open(worldStore.currentWorldId)
  } catch {
    // 初始化失败时 stores 已用默认值，不阻塞 UI
  }
})
</script>

<template>
  <div class="app">
    <div v-if="adventure.loading && adventure.hasAdventure" class="loading-banner">
      <span class="loading-spinner"></span>
      <span class="loading-text">正在生成…</span>
      <span v-if="loadingSeconds >= 1" class="loading-elapsed">{{ loadingSeconds }}s</span>
      <span v-if="isLongSetting && loadingSeconds < 5" class="loading-extra">设定较长，请耐心等待</span>
      <span v-if="loadingSeconds > 180" class="loading-extra">耗时较长，可尝试减小世界书条目数</span>
      <span v-if="adventure.recoveryNote" class="loading-extra">{{ adventure.recoveryNote }}</span>
    </div>
    <main class="app-main" :class="{ 'loading-pad': adventure.loading && adventure.hasAdventure }">
      <router-view v-slot="{ Component }">
        <component :is="Component" />
      </router-view>
    </main>
    <BottomBar />
  </div>
</template>

<style scoped>
.app {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.app-main {
  flex: 1;
  overflow-y: auto;
  position: relative;
}
.app-main.loading-pad {
  padding-top: 32px;
}
.loading-banner {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 200;
  background: var(--active);
  color: #fff;
  padding: 7px 16px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 10px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.4);
  line-height: 1.4;
  min-height: 32px;
}
.loading-spinner {
  flex: none;
  width: 12px;
  height: 12px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
.loading-text {
  font-weight: 600;
  white-space: nowrap;
}
.loading-elapsed {
  opacity: 0.8;
  white-space: nowrap;
}
.loading-extra {
  opacity: 0.85;
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>