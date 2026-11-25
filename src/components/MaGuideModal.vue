<script setup lang="ts">
const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <div class="mg-mask" @click.self="emit('close')">
    <div class="mg-card">
      <h3 class="mg-title">多智能体模式 · 怎么玩</h3>
      <div class="mg-body">
        <p>
          每位在场角色都由独立的 AI 扮演，你们在同一场戏里各自扮演自己的角色。为提升沉浸感，
          你不会被特殊对待，你是他们中的一员。
        </p>
        <p>
          输入框<b>留空</b>，直接点<b>继续</b>，即可继续推进一步。由调度决定谁接着开口；
          轮到你的角色时会出现几个「可能的反应」，点一下填进输入框，可修改后再发送。
        </p>
        <p class="mg-tag">
          <b>特权</b>：没轮到你、也就是没有选项时，通过输入框＋发送随时能<b>插嘴</b>，想做就做想说就说。
        </p>
        <p>
          想一次多看几拍，在<b>冒险设置</b>里调高「自动推进」。
        </p>

        <p class="mg-sep">—— 关于状态页 ——</p>
        <p>
          面板、背包、状态页面由旁白在推进剧情时同步更新；推进间隙它们可能比当前剧情略旧，属正常现象，
          不影响剧情推进。旁白往下走时会把最新进展写入各角色的记忆，随时可通过<b>手动改写</b>校正。
        </p>
      </div>
      <div class="mg-actions">
        <button class="mg-btn" @click="emit('close')">我知道了</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mg-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 220;
  padding: 16px;
}
.mg-card {
  background: var(--bg, #1a1a1a);
  color: var(--text, #eee);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  padding: 20px 20px 16px;
  width: 100%;
  max-width: 420px;
  max-height: 86vh;
  overflow-y: auto;
  box-sizing: border-box;
}
.mg-title {
  font-size: 17px;
  margin: 0 0 8px;
  text-align: center;
  color: #c9a227;
}
.mg-body p {
  font-size: 13px;
  line-height: 1.75;
  margin: 0 0 10px;
}
.mg-tag {
  margin: 12px 0;
}
.mg-sep {
  text-align: center;
  color: var(--muted, #999);
  font-size: 12px;
  margin: 14px 0 8px !important;
  letter-spacing: 1px;
}
.mg-body b {
  color: #c9a227;
}
.mg-actions {
  display: flex;
  justify-content: center;
  margin-top: 6px;
}
.mg-btn {
  background: #c9a227;
  border: none;
  color: #1a1a1a;
  font-weight: 700;
  padding: 8px 24px;
  border-radius: 999px;
  font-size: 13px;
  cursor: pointer;
}
</style>
