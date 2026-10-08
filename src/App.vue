<script setup lang="ts">
import { onMounted } from 'vue'
import { useSettingsStore } from '@/stores/settings'
import { useWorldStore } from '@/stores/world'
import { useAdventureStore } from '@/stores/adventure'
import { setBgmMuted } from '@/audio/bgm'
import BottomBar from '@/components/BottomBar.vue'

const settings = useSettingsStore()
const worldStore = useWorldStore()
const adventure = useAdventureStore()

onMounted(async () => {
  try {
    await Promise.all([settings.load(), worldStore.load()])
    await setBgmMuted(settings.muted)
    await adventure.open(worldStore.currentWorldId)
  } catch {
    // 初始化失败时 stores 已用默认值，不阻塞 UI
  }
})
</script>

<template>
  <div class="app">
    <main class="app-main">
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
</style>