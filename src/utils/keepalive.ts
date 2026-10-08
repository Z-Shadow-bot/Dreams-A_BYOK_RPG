import { Capacitor, registerPlugin } from '@capacitor/core'

interface KeepAlivePlugin {
  start(): Promise<void>
  stop(): Promise<void>
}

const KeepAlive = registerPlugin<KeepAlivePlugin>('KeepAlive')

function available(): boolean {
  return Capacitor.isNativePlatform()
}

export async function startKeepAlive(): Promise<void> {
  if (!available()) return
  try {
    await KeepAlive.start()
    console.log('[keepalive] 前台服务已启动')
  } catch (e) {
    console.error('[keepalive] start 失败', e)
  }
}

export async function stopKeepAlive(): Promise<void> {
  if (!available()) return
  try {
    await KeepAlive.stop()
    console.log('[keepalive] 前台服务已停止')
  } catch (e) {
    console.error('[keepalive] stop 失败', e)
  }
}