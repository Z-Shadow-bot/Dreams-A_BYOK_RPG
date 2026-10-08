<script setup lang="ts">
import { useRoute } from 'vue-router'

const route = useRoute()

function isActive(name: string) {
  return route.name === name
}
</script>

<template>
  <nav class="bottom-bar">
    <router-link to="/" class="tab" :class="{ active: isActive('world') }">
      <span class="label">世界</span>
    </router-link>
    <router-link to="/status" class="tab" :class="{ active: isActive('status') }">
      <span class="label">状态</span>
    </router-link>
    <router-link
      to="/adventure"
      class="tab adventure"
      :class="{ active: isActive('adventure') }"
    >
      <span class="adventure-btn">冒险</span>
    </router-link>
    <router-link to="/archive" class="tab" :class="{ active: isActive('archive') }">
      <span class="label">存档</span>
    </router-link>
    <router-link to="/mine" class="tab" :class="{ active: isActive('mine') }">
      <span class="label">我的</span>
    </router-link>
  </nav>
</template>

<style scoped>
.bottom-bar {
  display: flex;
  height: 62px;
  background: #000;
  border-top: 1px solid #222;
  padding-bottom: env(safe-area-inset-bottom);
  position: relative;
  z-index: 10;
}
.tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  text-decoration: none;
  font-size: 13px;
  transition: color 0.15s;
}
.tab.active {
  color: var(--active);
}
.label {
  line-height: 1;
}
.adventure {
  position: relative;
}
.adventure-btn {
  position: absolute;
  top: -24px;
  width: 58px;
  height: 58px;
  border-radius: 50%;
  background: var(--yellow);
  color: #000;
  font-weight: 700;
  font-size: 15px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
  transition: box-shadow 0.15s;
}
.adventure.active .adventure-btn {
  box-shadow:
    0 0 0 3px #000,
    0 0 0 5px var(--active),
    0 4px 14px rgba(0, 0, 0, 0.6);
}
</style>