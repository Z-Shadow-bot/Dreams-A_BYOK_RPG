import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import router from './router'
import { installLogger } from './utils/logger'
import './style.css'

installLogger()

// 监听 app 前后台切换，记录到日志（用于诊断 AI 请求挂后台中断问题）
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    console.log('[app] 进入后台 visibilitychange')
  } else {
    console.log('[app] 回到前台 visibilitychange')
  }
})
window.addEventListener('pagehide', () => console.log('[app] pagehide'))
window.addEventListener('pageshow', () => console.log('[app] pageshow'))

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.mount('#app')