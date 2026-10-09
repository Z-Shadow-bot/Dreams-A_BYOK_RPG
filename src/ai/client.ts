import { CapacitorHttp } from '@capacitor/core'
import { getApiKey } from './secure'
import { startKeepAlive, stopKeepAlive } from '@/utils/keepalive'
import type { APIConfig, ChatMessage } from '@/types'

// 归一化 OpenAI 兼容接口地址
export function normalizeBaseUrl(baseUrl: string): string {
  let url = baseUrl.trim().replace(/\/+$/, '')
  if (/\/chat\/completions$/i.test(url)) return url
  if (/\/v\d+$/i.test(url)) return `${url}/chat/completions`
  return `${url}/v1/chat/completions`
}

// AI 调用错误：message 为面向用户的中文提示，detail 为开发者诊断信息（开发者模式才展示）
export class AIError extends Error {
  detail?: string
  constructor(message: string, detail?: string) {
    super(message)
    this.name = 'AIError'
    this.detail = detail
  }
}

// 把常见 HTTP 状态码翻译成小白可懂的中文
function httpErrorHint(status: number): string {
  switch (status) {
    case 400:
      return '请求参数有误，请检查「我的」页面填写的模型名称与 API 地址'
    case 401:
      return 'API Key 无效或已过期，请前往「我的」页面重新填写并保存'
    case 402:
      return '账户余额不足，请充值后重试'
    case 403:
      return '没有访问权限，请检查 API Key 与 API 地址是否正确'
    case 404:
      return 'API 地址或模型名称有误，请前往「我的」页面核对配置'
    case 408:
      return '服务响应超时，请稍后重试或延长「最大等待时间」'
    case 429:
      return '请求过于频繁或额度受限，请稍等片刻再试'
    default:
      if (status >= 500) return 'AI 服务暂时繁忙或出错，请稍后重试'
      return '请求未成功，请检查配置后重试'
  }
}

// 将任意异常转为展示文案；showDetail 为真（开发者模式）时附加技术详情
export function errorMessage(e: unknown, showDetail = false): string {
  const err = e instanceof Error ? e : new Error(String(e))
  if (showDetail && e instanceof AIError && e.detail) {
    return `${err.message}\n\n【技术详情】${e.detail}`
  }
  return err.message
}

// 只转义 JSON 字符串值内部的裸控制字符，保留字符串外部的合法空白（换行/制表符等）
function fixBareControlInStrings(json: string): string {
  let result = ''
  let inString = false
  let escape = false
  for (let i = 0; i < json.length; i++) {
    const ch = json[i]
    if (inString) {
      if (escape) {
        escape = false
        result += ch
      } else if (ch === '\\') {
        escape = true
        result += ch
      } else if (ch === '"') {
        inString = false
        result += ch
      } else if (ch >= '\x00' && ch <= '\x1f') {
        switch (ch) {
          case '\n': result += '\\n'; break
          case '\r': result += '\\r'; break
          case '\t': result += '\\t'; break
          default: result += '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')
        }
      } else {
        result += ch
      }
    } else {
      if (ch === '"') inString = true
      result += ch
    }
  }
  return result
}

// 去除 JSON 中字符串外的注释（// 与 /* */）并修复尾逗号；按引号状态扫描，不误伤字符串内的内容
function repairJsonText(json: string): string {
  let s = json.replace(/,(\s*[}\]])/g, '$1')
  let out = ''
  let inString = false
  let escape = false
  const n = s.length
  for (let i = 0; i < n; i++) {
    const ch = s[i]
    if (inString) {
      out += ch
      if (escape) escape = false
      else if (ch === '\\') escape = true
      else if (ch === '"') inString = false
    } else if (ch === '"') {
      inString = true
      out += ch
    } else if (ch === '/' && s[i + 1] === '/') {
      while (i < n && s[i] !== '\n' && s[i] !== '\r') i++
      out += '\n'
    } else if (ch === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2)
      i = end === -1 ? n : end + 1
      out += ' '
    } else {
      out += ch
    }
  }
  return out
}

// 从 AI 返回文本中提取 JSON 对象（容错处理 ```json 代码块 / 前后杂文 / 裸控制字符 / 注释 / 尾逗号）
export function extractJson(text: string): unknown {
  const trimmed = text.trim()
  // 去掉 markdown 代码块包裹
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : trimmed
  // 直接尝试解析
  try {
    return JSON.parse(body)
  } catch {
    // 用平衡括号匹配提取第一个完整 JSON 对象
    const start = body.indexOf('{')
    if (start === -1) {
      throw new AIError(
        'AI 返回的内容不是有效的结果，请重试一次；若反复出现，请尝试更换模型',
        `内容前 200 字符：${body.slice(0, 200)}`,
      )
    }
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < body.length; i++) {
      const ch = body[i]
      if (inString) {
        if (escape) escape = false
        else if (ch === '\\') escape = true
        else if (ch === '"') inString = false
      } else {
        if (ch === '"') inString = true
        else if (ch === '{') depth++
        else if (ch === '}') {
          depth--
          if (depth === 0) {
            const slice = body.slice(start, i + 1)
            try {
              return JSON.parse(slice)
            } catch {
              // 尝试修复 JSON 字符串值里的裸控制字符（换行/制表符等未转义情况）
              // 只转义字符串内部的裸控制字符，保留字符串外部的合法空白
              const fixed = fixBareControlInStrings(slice)
              try {
                return JSON.parse(fixed)
              } catch {
                // 再尝试去除注释、修复尾逗号
                const repaired = repairJsonText(fixed)
                try {
                  return JSON.parse(repaired)
                } catch (e2) {
                  throw new AIError(
                    'AI 返回的 JSON 格式有误，请重试一次；若反复出现，请尝试更换模型',
                    `解析错误：${e2 instanceof Error ? e2.message : String(e2)}\n内容前 200 字符：${fixed.slice(0, 200)}`,
                  )
                }
              }
            }
          }
        }
      }
    }
    throw new AIError(
      'AI 的输出被截断了，请重试，或更换上下文更长的模型',
      `内容前 200 字符：${body.slice(0, 200)}`,
    )
  }
}

// 核心调用：组装请求 → CapacitorHttp 原生直连 → 返回 AI 文本
export async function chat(messages: ChatMessage[], config: APIConfig): Promise<string> {
  const key = await getApiKey()
  if (!key) throw new AIError('尚未配置 API Key，请前往「我的」页面填写并保存')

  const url = normalizeBaseUrl(config.baseUrl)
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${key}`,
    ...config.extraHeaders,
  }

  const payload: Record<string, unknown> = {
    model: config.model,
    messages,
    temperature: config.temperature,

    stream: false,
    response_format: { type: 'json_object' },
  }
  // DeepSeek 默认开启思考模式（content 可能为空），显式关闭以直接输出最终回答
  if (/deepseek/i.test(config.model)) {
    payload.thinking = { type: 'disabled' }
  }

  // 最大等待时间由用户在「我的」页面设置，默认 180 秒
  const waitSeconds = config.maxWaitTime && config.maxWaitTime > 0 ? config.maxWaitTime : 180
  const connectTimeout = 30_000
  const readTimeout = Math.round(waitSeconds * 1000)

  const startedAt = Date.now()
  console.log(`[ai] chat开始: model=${config.model} url=${url} msgs=${messages.length} readTimeout=${readTimeout}ms`)
  // 请求期间启动前台服务保活：避免 App 挂后台时进程被系统冻结导致网络连接中断
  await startKeepAlive()
  try {
    // 监听前后台切换：Android 在 App 挂后台时可能暂停 WebView 并中断进行中的网络请求，
    // 回到前台后请求会以"连接被中止"类错误失败。此时应自动重试一次，而非让用户手动重试。
    let wentBackground = false
    const onVisibility = () => {
      if (document.hidden) wentBackground = true
    }
    document.addEventListener('visibilitychange', onVisibility)
    let response!: Awaited<ReturnType<typeof CapacitorHttp.post>>
    const doPost = () => CapacitorHttp.post({
      url,
      headers,
      data: JSON.stringify(payload),
      responseType: 'json',
      connectTimeout,
      readTimeout,
    })
    try {
      response = await doPost()
    } catch (e) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      const raw = e instanceof Error ? e.message : String(e)
      console.error(`[ai] chat异常: elapsed=${elapsed}s raw=${raw}`)
      if (wentBackground && !document.hidden) {
        // 请求期间进入过后台，且现已回到前台：判定为系统中断连接，自动重试
        console.log(`[ai] 请求期间应用进入后台导致连接中断，页面已恢复，自动重试 raw=${raw}`)
        try {
          response = await doPost()
          console.log(`[ai] 后台中断后重试成功: elapsed=${Math.round((Date.now() - startedAt) / 1000)}s`)
        } catch (e2) {
          const raw2 = e2 instanceof Error ? e2.message : String(e2)
          console.error(`[ai] 重试也失败: raw=${raw2}`)
          if (/timeout|timed\s*out|socket.?timeout/i.test(raw2)) {
            throw new AIError(
              `AI 响应超时（已等待 ${Math.round((Date.now() - startedAt) / 1000)} 秒）：设定较长或服务繁忙，请稍后重试，或延长「最大等待时间」`,
              `readTimeout=${readTimeout}ms`,
            )
          }
          throw new AIError('网络连接失败，请检查网络和 API 地址是否正确后重试', raw2)
        }
      } else if (/timeout|timed\s*out|socket.?timeout/i.test(raw)) {
        throw new AIError(
          `AI 响应超时（已等待 ${elapsed} 秒）：设定较长或服务繁忙，请稍后重试，或延长「最大等待时间」`,
          `readTimeout=${readTimeout}ms`,
        )
      } else {
        throw new AIError('网络连接失败，请检查网络和 API 地址是否正确后重试', raw)
      }
    } finally {
      document.removeEventListener('visibilitychange', onVisibility)
    }

    if (response.status < 200 || response.status >= 300) {
      let errBody = ''
      try {
        errBody = JSON.stringify(response.data)
      } catch {
        errBody = String(response.data)
      }
      if (errBody.length > 500) errBody = errBody.slice(0, 500) + '…'
      throw new AIError(httpErrorHint(response.status), `HTTP ${response.status}：${errBody}`)
    }

    const data = response.data as {
      choices?: Array<{
        message?: { content?: string }
        finish_reason?: string
      }>
      error?: { message?: string }
    }
    if (data.error) {
      throw new AIError(
        'AI 服务返回错误，请检查配置或稍后重试',
        `data.error：${JSON.stringify(data.error)}`,
      )
    }
    const choice = data?.choices?.[0]
    const msg = choice?.message
    const content = msg?.content?.trim()
    if (!content) {
      throw new AIError(
        'AI 没有返回内容，可能是被内容安全策略拦截或模型异常，请稍后重试或更换模型',
        `choices 为空或 content 为空（finish_reason=${choice?.finish_reason ?? '无'}）`,
      )
    }
    if (choice?.finish_reason === 'length') {
      throw new AIError(
        'AI 的输出超出了模型自身上限而被截断，建议重试，或更换上下文更长的模型',
        'finish_reason=length',
      )
    }
    console.log(`[ai] chat完成: elapsed=${Math.round((Date.now() - startedAt) / 1000)}s len=${content.length}`)
    return content
  } finally {
    await stopKeepAlive()
  }
}