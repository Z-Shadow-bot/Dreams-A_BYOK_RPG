import { Capacitor } from '@capacitor/core'
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem'
import { Share } from '@capacitor/share'

export function safeFilename(name: string): string {
  return name.replace(/[<>:"/\\|?*]/g, '_').slice(0, 100).trim() || 'export'
}

export function timestamp(): string {
  const d = new Date()
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

export async function downloadJSON(filename: string, data: unknown): Promise<void> {
  let json: string
  try {
    json = JSON.stringify(data, null, 2)
  } catch {
    throw new Error('数据无法序列化，可能包含循环引用')
  }

  if (Capacitor.isNativePlatform()) {
    const result = await Filesystem.writeFile({
      path: `exports/${filename}`,
      data: json,
      directory: Directory.Cache,
      recursive: true,
      encoding: Encoding.UTF8,
    })
    await Share.share({
      title: filename,
      files: [result.uri],
      dialogTitle: '导出文件',
    })
  } else {
    const blob = new Blob([json], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
}

export async function downloadText(filename: string, content: string): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    const result = await Filesystem.writeFile({
      path: `exports/${filename}`,
      data: content,
      directory: Directory.Cache,
      recursive: true,
      encoding: Encoding.UTF8,
    })
    await Share.share({
      title: filename,
      files: [result.uri],
      dialogTitle: '导出文件',
    })
  } else {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
}

export function pickJSONFile(): Promise<string> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'application/json,.json'
    input.onchange = () => {
      const file = input.files?.[0]
      if (!file) {
        reject(new Error('未选择文件'))
        return
      }
      const reader = new FileReader()
      reader.onload = () => resolve(reader.result as string)
      reader.onerror = () => reject(reader.error ?? new Error('读取文件失败'))
      reader.readAsText(file)
    }
    input.click()
  })
}