import { Capacitor } from '@capacitor/core'
import { NativeAudio } from '@capacitor-community/native-audio'
import { Filesystem, Directory } from '@capacitor/filesystem'
import type { World } from '@/types'
import { idbGet } from '@/utils/idb'

const isNative = Capacitor.isNativePlatform()
const uriCache = new Map<string, string>()
let currentAssetId: string | null = null
let currentKey: string | null = null
let loadingAssetId: string | null = null
let loadingKey: string | null = null
let muted = false

const webAudioMap = new Map<string, HTMLAudioElement>()

function sanitizeAssetId(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_')
}

// 规范化 URI：先 decode（若已编码），再 encode，得到确定单次百分号编码的 URI，
// 避免对已编码的 %xx 造成双重编码（encodeURI 会把 % 编码为 %25）
function normalizeUri(uri: string): string {
  try {
    return encodeURI(decodeURI(uri))
  } catch {
    return encodeURI(uri)
  }
}

// 停止当前 BGM 并卸载（含 loading 中的 asset）
export async function stopBgm(): Promise<void> {
  if (!isNative) {
    if (loadingAssetId) {
      const a = webAudioMap.get(loadingAssetId)
      if (a) { a.pause(); a.src = ''; webAudioMap.delete(loadingAssetId) }
      loadingAssetId = null
      loadingKey = null
    }
    if (!currentAssetId) return
    const a = webAudioMap.get(currentAssetId)
    if (a) { a.pause(); a.src = ''; webAudioMap.delete(currentAssetId) }
    currentAssetId = null
    currentKey = null
    return
  }
  // 先处理 loading 中的 asset（preload 尚未完成的）
  if (loadingAssetId) {
    const lid = loadingAssetId
    loadingAssetId = null
    loadingKey = null
    console.log(`[bgm] stop: 卸载loading中的asset ${lid}`)
    try { await NativeAudio.unload({ assetId: lid }) } catch { /* 忽略 */ }
  }
  if (!currentAssetId) {
    console.log('[bgm] stop: 无播放中的asset，跳过')
    return
  }
  const id = currentAssetId
  console.log(`[bgm] stop: ${id} key=${currentKey}`)
  currentAssetId = null
  currentKey = null
  // stop 和 unload 分开 try-catch，确保 unload 总是执行
  try { await NativeAudio.stop({ assetId: id }) } catch (e) { console.error('[bgm] stop: stop失败', e) }
  try { await NativeAudio.unload({ assetId: id }); console.log('[bgm] stop: 成功') } catch (e) { console.error('[bgm] stop: unload失败', e) }
}

// 获取 BGM 文件的可用 URI（含缓存与日志）
async function resolveUri(dlcId: string, basename: string): Promise<string | null> {
  const cacheKey = `${dlcId}/${basename}`
  const cached = uriCache.get(cacheKey)
  if (cached) return cached
  if (!isNative) {
    const buf = await idbGet(`dlc/${dlcId}/bgm/${basename}`)
    if (!buf) return null
    const blob = new Blob([buf], { type: 'audio/mpeg' })
    const url = URL.createObjectURL(blob)
    uriCache.set(cacheKey, url)
    return url
  }
  try {
    const res = await Filesystem.getUri({
      path: `dlc/${dlcId}/bgm/${basename}`,
      directory: Directory.Data,
    })
    const uri = normalizeUri(res.uri)
    uriCache.set(cacheKey, uri)
    console.log(`[bgm] uri resolved: ${basename} -> ${uri}`)
    return uri
  } catch (e) {
    console.error(`[bgm] getUri 失败: ${basename}`, e)
    return null
  }
}

// 预加载并循环播放指定 BGM
async function startBgm(dlcId: string, basename: string): Promise<void> {
  const cacheKey = `${dlcId}/${basename}`
  const assetId = `bgm_${sanitizeAssetId(`${dlcId}_${basename}`)}`
  if (!isNative) {
    if (currentAssetId && currentAssetId !== assetId) {
      const old = webAudioMap.get(currentAssetId)
      if (old) { old.pause(); old.src = ''; webAudioMap.delete(currentAssetId) }
      currentAssetId = null
      currentKey = null
    }
    if (loadingAssetId && loadingAssetId !== assetId) {
      const old = webAudioMap.get(loadingAssetId)
      if (old) { old.pause(); old.src = ''; webAudioMap.delete(loadingAssetId) }
    }
    loadingAssetId = assetId
    loadingKey = cacheKey
    const uri = await resolveUri(dlcId, basename)
    if (!uri) {
      if (loadingAssetId === assetId) { loadingAssetId = null; loadingKey = null }
      return
    }
    const audio = new Audio(uri)
    audio.loop = true
    audio.volume = muted ? 0 : 1
    webAudioMap.set(assetId, audio)
    try {
      await audio.play()
      if (loadingAssetId !== assetId) {
        audio.pause(); audio.src = ''; webAudioMap.delete(assetId)
        return
      }
      currentAssetId = assetId
      currentKey = cacheKey
    } catch (e) {
      console.error(`[bgm] web播放失败: ${basename}`, e)
      webAudioMap.delete(assetId)
    } finally {
      if (loadingAssetId === assetId) { loadingAssetId = null; loadingKey = null }
    }
    return
  }
  // 打断当前正在播放的 asset：先 stop 再 unload，避免 MediaPlayer 播放中直接 unload 导致状态异常
  if (currentAssetId && currentAssetId !== assetId) {
    const oldId = currentAssetId
    currentAssetId = null
    currentKey = null
    try { await NativeAudio.stop({ assetId: oldId }) } catch { /* 忽略 */ }
    try { await NativeAudio.unload({ assetId: oldId }) } catch { /* 忽略 */ }
  }
  // 打断正在加载中的 asset
  if (loadingAssetId && loadingAssetId !== assetId) {
    try { await NativeAudio.unload({ assetId: loadingAssetId }) } catch { /* 忽略 */ }
  }
  // 提前设置 loading 状态，防止 stopBgm 完成到此处之间的竞态空窗期
  loadingAssetId = assetId
  loadingKey = cacheKey
  const uri = await resolveUri(dlcId, basename)
  if (!uri) {
    if (loadingAssetId === assetId) { loadingAssetId = null; loadingKey = null }
    return
  }
  console.log(`[bgm] preload开始: ${basename} assetId=${assetId} uri=${uri}`)
  try {
    await NativeAudio.preload({ assetId, assetPath: uri, isUrl: true, audioChannelNum: 1 })
    console.log(`[bgm] preload完成: ${basename}`)
    if (loadingAssetId !== assetId) { console.log('[bgm] preload后被打断，return'); return }
    await NativeAudio.play({ assetId })
    console.log(`[bgm] play完成: ${basename}`)
    if (loadingAssetId !== assetId) {
      console.log('[bgm] play后被打断，卸载幽灵asset')
      try { await NativeAudio.unload({ assetId }) } catch { /* 忽略 */ }
      return
    }
    await NativeAudio.loop({ assetId })
    console.log(`[bgm] loop完成: ${basename}`)
    await NativeAudio.setVolume({ assetId, volume: muted ? 0 : 1 })
    console.log(`[bgm] setVolume完成: ${basename} vol=${muted ? 0 : 1}`)
    currentAssetId = assetId
    currentKey = cacheKey
    console.log(`[bgm] started: ${basename}`)
  } catch (e) {
    console.error(`[bgm] 播放失败: ${basename}`, e)
    try {
      await NativeAudio.unload({ assetId })
    } catch {
      // 卸载失败忽略
    }
  } finally {
    if (loadingAssetId === assetId) {
      loadingAssetId = null
      loadingKey = null
    }
  }
}

// 根据当前场景类型播放对应 BGM（循环）
export async function playSceneBgm(world: World | null, scene: string | undefined): Promise<void> {
  console.log(`[bgm] playSceneBgm: dlcId=${world?.dlcId ?? '无'} scene=${scene ?? '无'} currentKey=${currentKey} loadingKey=${loadingKey}`)
  if (!world || !world.dlcId || !world.bgm || !scene) {
    console.log('[bgm] playSceneBgm: 条件不足，调stopBgm', { dlcId: world?.dlcId, hasBgm: !!world?.bgm, scene })
    await stopBgm()
    return
  }
  const basename = world.bgm[scene]
  if (!basename) {
    console.log(`[bgm] playSceneBgm: scene "${scene}" 无对应BGM，调stopBgm`)
    console.log(`[bgm] playSceneBgm: bgm映射表keys=${JSON.stringify(Object.keys(world.bgm))}`)
    await stopBgm()
    return
  }
  const cacheKey = `${world.dlcId}/${basename}`
  if (currentKey === cacheKey) { console.log('[bgm] playSceneBgm: 已在播放同一曲目，跳过'); return }
  if (loadingKey === cacheKey) { console.log('[bgm] playSceneBgm: 正在加载同一曲目，跳过'); return }
  console.log(`[bgm] playSceneBgm: 切换到 ${basename}`)
  await stopBgm()
  await startBgm(world.dlcId, basename)
}

// 按文件名播放 BGM（用于彩蛋等特殊触发，循环播放）
export async function playBgmByName(world: World | null, basename: string): Promise<void> {
  console.log(`[bgm] playBgmByName: dlcId=${world?.dlcId ?? '无'} basename=${basename} currentKey=${currentKey} loadingKey=${loadingKey}`)
  if (!world || !world.dlcId || !basename) {
    console.log('[bgm] playBgmByName: 条件不足，调stopBgm')
    await stopBgm()
    return
  }
  const cacheKey = `${world.dlcId}/${basename}`
  if (currentKey === cacheKey) { console.log('[bgm] playBgmByName: 已在播放，跳过'); return }
  if (loadingKey === cacheKey) { console.log('[bgm] playBgmByName: 正在加载，跳过'); return }
  await stopBgm()
  await startBgm(world.dlcId, basename)
}

// 设置静音状态（仅调音量，不卸载，便于随时恢复）
export async function setBgmMuted(v: boolean): Promise<void> {
  muted = v
  const id = currentAssetId ?? loadingAssetId
  if (!id) return
  if (!isNative) {
    const a = webAudioMap.get(id)
    if (a) a.volume = v ? 0 : 1
    return
  }
  try {
    await NativeAudio.setVolume({ assetId: id, volume: v ? 0 : 1 })
  } catch (e) {
    console.error('[bgm] setVolume 失败', e)
  }
}

export function isBgmMuted(): boolean {
  return muted
}

export function isBgmPlaying(): boolean {
  return currentKey !== null
}

export function isBgmFromDlc(dlcId: string): boolean {
  const prefix = `${dlcId}/`
  return (currentKey !== null && currentKey.startsWith(prefix)) ||
         (loadingKey !== null && loadingKey.startsWith(prefix))
}


export function clearBgmCache(dlcId: string): void {
  const prefix = `${dlcId}/`
  for (const key of uriCache.keys()) {
    if (key.startsWith(prefix)) uriCache.delete(key)
  }
}