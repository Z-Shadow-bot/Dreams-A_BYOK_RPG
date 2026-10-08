import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory } from '@capacitor/filesystem'
import { unzipSync, strFromU8 } from 'fflate'
import type { DlcManifest, PanelField, LoreEntry } from '@/types'
import { createId } from '@/types'
import { idbPut, idbDeletePrefix } from '@/utils/idb'

const isNative = Capacitor.isNativePlatform()

function uint8ToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function basename(p: string): string {
  const parts = p.split('/').filter(Boolean)
  return parts[parts.length - 1] || p
}

// 校验并整理 panelSchema，防止 DLC 内非法字段导致崩溃
function normalizePanelSchema(raw: unknown): PanelField[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const result: PanelField[] = []
  for (const item of raw) {
    const f = item as Record<string, unknown>
    if (!f || typeof f.key !== 'string' || typeof f.label !== 'string') continue
    const key = f.key.trim()
    const label = f.label.trim()
    if (!key || !label || seen.has(key)) continue
    seen.add(key)
    result.push({
      key,
      label,
      type: f.type === 'number' ? 'number' : 'text',
      unit: typeof f.unit === 'string' && f.unit.trim() ? f.unit.trim() : undefined,
    })
  }
  return result
}

function normalizeLorebook(raw: unknown): LoreEntry[] {
  if (!Array.isArray(raw)) return []
  const result: LoreEntry[] = []
  for (const item of raw) {
    const e = (item ?? {}) as Record<string, unknown>
    const content = typeof e.content === 'string' && e.content.trim() ? e.content.trim() : ''
    if (!content) continue
    const tags = Array.isArray(e.tags)
      ? e.tags.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => !!t)
      : []
    const title = typeof e.title === 'string' && e.title.trim() ? e.title.trim() : undefined
    result.push({ id: createId(), title, tags, content, required: !!e.required, hidden: e.hidden === true ? true : undefined })
  }
  return result
}

function normalizePresetCharacter(raw: unknown): { label: string; description: string; hidden?: string } | null {
  if (typeof raw === 'string') {
    const s = raw.trim()
    return s ? { label: s, description: s } : null
  }
  const o = (raw ?? {}) as Record<string, unknown>
  const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : ''
  const description = typeof o.description === 'string' && o.description.trim() ? o.description.trim() : ''
  if (!label || !description) return null
  const hidden = typeof o.hidden === 'string' && o.hidden.trim() ? o.hidden.trim() : undefined
  return { label, description, hidden }
}

export interface ParsedDlc {
  manifest: DlcManifest
  // 场景类型 -> 音乐文件名（basename，已去除目录前缀）
  bgm: Record<string, string>
  // 音乐文件名（basename） -> 原始字节
  bgmBytes: Record<string, Uint8Array>
}

// 解析 zip 内容为 DLC 清单 + 音乐文件字节
export function parseDlcZip(zipBytes: Uint8Array): ParsedDlc {
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zipBytes)
  } catch {
    throw new Error('无法解析 DLC 压缩包，请确认是有效的 .zip 文件')
  }
  const rawJson = files['dlc.json']
  if (!rawJson) throw new Error('DLC 包内缺少 dlc.json')
  let manifest: DlcManifest
  try {
    manifest = JSON.parse(strFromU8(rawJson)) as DlcManifest
  } catch {
    throw new Error('dlc.json 不是有效的 JSON')
  }
  if (!manifest || manifest.type !== 'dreams-dlc') {
    throw new Error('这不是有效的 Dreams DLC 包')
  }
  const name = typeof manifest.world?.name === 'string' ? manifest.world.name.trim() : ''
  const worldSetting = typeof manifest.world?.worldSetting === 'string' ? manifest.world.worldSetting : ''
  const panelSchema = normalizePanelSchema(manifest.world?.panelSchema)
  if (!name || !worldSetting || panelSchema.length === 0) {
    throw new Error('DLC 内的世界信息不完整（缺少名称、设定或面板字段）')
  }
  const lorebook = normalizeLorebook(manifest.world?.lorebook)
  manifest.world.lorebook = lorebook.length ? lorebook : undefined

  let sceneField =
    typeof manifest.sceneField === 'string' && manifest.sceneField.trim() ? manifest.sceneField.trim() : 'scene'
  const validKeys = new Set(panelSchema.map((f) => f.key))
  if (!validKeys.has(sceneField)) {
    sceneField = ''
  }
  manifest.sceneField = sceneField

  const presetCharacters = Array.isArray(manifest.presetCharacters)
    ? manifest.presetCharacters
        .map((c) => normalizePresetCharacter(c))
        .filter((c): c is { label: string; description: string; hidden?: string } => c !== null)
    : undefined
  manifest.presetCharacters = presetCharacters?.length ? presetCharacters : undefined

  const bgm: Record<string, string> = {}
  const bgmBytes: Record<string, Uint8Array> = {}
  const rawBgm = manifest.bgm && typeof manifest.bgm === 'object' ? manifest.bgm : {}
  console.log(`[dlc] BGM映射表: ${JSON.stringify(rawBgm)}`)
  for (const [scene, filePath] of Object.entries(rawBgm)) {
    if (typeof filePath !== 'string' || !filePath.trim()) continue
    const trimmedPath = filePath.trim()
    let bytes = files[trimmedPath]
    if (!bytes) bytes = files[`BGM/${trimmedPath}`]
    if (!bytes) {
      console.warn(`[dlc] BGM文件未找到: scene=${scene} path=${trimmedPath}`)
      continue
    }
    const fn = basename(trimmedPath)
    bgm[scene] = fn
    bgmBytes[fn] = bytes
    console.log(`[dlc] BGM匹配成功: scene=${scene} -> ${fn} (${bytes.length} bytes)`)
  }
  console.log(`[dlc] BGM总计: ${Object.keys(bgmBytes).length}个文件`)

  return { manifest, bgm, bgmBytes }
}

// 把 DLC 音乐以二进制形式写入 Documents 目录
export async function persistDlcAudio(dlcId: string, bgmBytes: Record<string, Uint8Array>): Promise<void> {
  const entries = Object.entries(bgmBytes)
  console.log(`[dlc] persistDlcAudio: dlcId=${dlcId} ${entries.length}个文件`)
  if (!isNative) {
    await Promise.all(
      entries.map(async ([filename, bytes]) => {
        await idbPut(`dlc/${dlcId}/bgm/${filename}`, bytes)
      }),
    )
    console.log('[dlc] persistDlcAudio: 全部完成(web)')
    return
  }
  await Promise.all(
    entries.map(async ([filename, bytes]) => {
      try {
        await Filesystem.writeFile({
          path: `dlc/${dlcId}/bgm/${filename}`,
          data: uint8ToBase64(bytes),
          directory: Directory.Data,
          recursive: true,
        })
        console.log(`[dlc] 写入BGM成功: ${filename} (${bytes.length} bytes)`)
      } catch (e) {
        console.error(`[dlc] 写入BGM失败: ${filename}`, e)
        throw e
      }
    }),
  )
  console.log('[dlc] persistDlcAudio: 全部完成')
}

// 删除 DLC 音乐目录（删除世界时清理）
export async function removeDlcAudio(dlcId: string): Promise<void> {
  if (!isNative) {
    await idbDeletePrefix(`dlc/${dlcId}/`).catch(() => {})
    return
  }
  try {
    await Filesystem.rmdir({ path: `dlc/${dlcId}`, directory: Directory.Data, recursive: true })
  } catch {
    // 目录不存在或删除失败，忽略
  }
}

// 选择 zip 文件，返回其原始字节
export function pickZipFile(): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.zip,application/zip,application/x-zip-compressed'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        reject(new Error('未选择文件'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
      reader.readAsArrayBuffer(file)
    }
    input.click()
  })
}