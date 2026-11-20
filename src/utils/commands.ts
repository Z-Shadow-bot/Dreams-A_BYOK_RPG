// 特殊指令：玩家在输入里写「（指令：终止事件，旧城门的火灾）」，
// 本地剥离后翻译成给叙事引擎的指示，不进入叙事文本。
//
// 设计要点：
// 1. 只有完整符合格式才触发（必须有「指令：」前缀），避免正文里的普通括号词被误判。
// 2. 括号与冒号全角/半角均可，参数前的逗号也兼容全/半角。
// 3. 一次性指令（跳过/换场/回顾）只影响本次请求；终止事件同时写入倒计时禁令。

export type CommandType = 'terminate' | 'skip' | 'scene' | 'recap'

export interface SpecialCommand {
  type: CommandType
  arg: string
  raw: string
}

export interface ParsedCommands {
  text: string // 剥离指令后的正文
  commands: SpecialCommand[]
}

const COMMAND_RE = /[（(]\s*指令\s*[：:]\s*(终止事件|跳过|换场|回顾)\s*(?:[，,]\s*([^）)]*?))?\s*[）)]/g

const TYPE_MAP: Record<string, CommandType> = {
  终止事件: 'terminate',
  跳过: 'skip',
  换场: 'scene',
  回顾: 'recap',
}

export function parseSpecialCommands(input: string): ParsedCommands {
  const src = input ?? ''
  const commands: SpecialCommand[] = []
  const cleaned = src.replace(COMMAND_RE, (_m, name: string, arg?: string) => {
    const type = TYPE_MAP[name]
    if (!type) return _m
    commands.push({ type, arg: (arg ?? '').trim(), raw: _m })
    return ' '
  })
  // 合并剥离后留下的多余空白/空行
  const text = cleaned.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim()
  return { text, commands }
}

export interface BannedEvent {
  text: string
  roundsLeft: number
}

export const BAN_ROUNDS = 10 // 禁令持续回合数
export const BAN_LIMIT = 5 // 同时生效的禁令上限

// 追加禁令：同名的重置计时；超出上限时淘汰最旧的
export function addBanned(list: BannedEvent[], text: string): BannedEvent[] {
  const t = text.trim()
  if (!t) return list
  const next = list.filter((b) => b.text !== t)
  next.push({ text: t, roundsLeft: BAN_ROUNDS })
  return next.slice(-BAN_LIMIT)
}

// 每次推进后递减，归零即移除
export function tickBanned(list: BannedEvent[]): BannedEvent[] {
  if (!list || list.length === 0) return []
  return list.map((b) => ({ ...b, roundsLeft: b.roundsLeft - 1 })).filter((b) => b.roundsLeft > 0)
}

// 注入给叙事引擎的一句话禁令（无禁令返回空串，零成本）
export function bannedPrompt(list: BannedEvent[] | undefined): string {
  if (!list || list.length === 0) return ''
  const items = list.map((b) => `- ${b.text}`).join('\n')
  return `【禁止展开的事件】（玩家已明确要求不再提及，请勿主动提起、回忆或暗示）\n${items}`
}

// 一次性指令 → 本次请求的附加指示
export function onceInstruction(commands: SpecialCommand[]): string {
  const lines: string[] = []
  for (const c of commands) {
    if (c.type === 'skip') {
      lines.push(c.arg ? `- 「${c.arg}」用一句话带过，不要展开细节。` : '- 接下来的过程用一句话带过，不要展开细节。')
    } else if (c.type === 'scene') {
      lines.push(c.arg ? `- 直接跳到下一个场景：${c.arg}。用简短过渡交代时间流逝，不要停留在当前场景。` : '- 直接结束当前场景，跳到下一个场景，用简短过渡交代时间流逝。')
    } else if (c.type === 'recap') {
      lines.push(c.arg ? `- 先简要回顾与「${c.arg}」有关的已知信息（不超过三句），再继续推进。` : '- 先简要回顾目前已知的关键信息（不超过三句），再继续推进。')
    }
  }
  return lines.length > 0 ? `【本次特别要求】\n${lines.join('\n')}` : ''
}

// 终止事件 → 清理要求（一次性）
export function purgeInstruction(list: string[]): string {
  const items = list.filter((t) => !!t.trim())
  if (items.length === 0) return ''
  return [
    '【需要清理的事件】（玩家要求这些事不再被提起，请彻底清理它们的痕迹）',
    ...items.map((t) => `- ${t}`),
    '清理方式：用 loreUpdates 的 removeLines / personaRemoveLines / memoryRemoveLines 删除世界书条目中相关行，必要时用 content/persona/memory 整体重写；同时从 overview.recentEvents 与 experience 中移除相关内容，并更新 sceneState。只删除与该事件相关的描述，不要删除条目本身或其他信息。',
  ].join('\n')
}
