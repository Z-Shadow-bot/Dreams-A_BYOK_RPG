import { chat, extractJson } from './client'
import type { APIConfig, LoreEntry, Secret } from '@/types'

// 多智能体模式的请求层：导演 / NPC / 玩家角色 / 旁白 / 群众 / 摘要 / 压缩。
// 约定：
// 1. 每个角色只收到"自己可知"的信息，输出走 JSON 契约，由 store 落库。
// 2. system 全部为静态常量（不含插值），同一世界内所有角色共享前缀，便于厂商前缀缓存；
//    世界名、字数上限、候选列表等变动内容一律放 user。
// 3. 台词格式：括号外的一切都是台词，括号内是动作/神态；不使用引号包裹台词。

async function askJson(system: string, user: string, config: APIConfig): Promise<Record<string, any>> {
  const content = await chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    config,
  )
  const data = extractJson(content)
  if (!data || typeof data !== 'object') throw new Error('模型未返回有效 JSON')
  return data as Record<string, any>
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

function strList(v: unknown): string[] {
  if (!Array.isArray(v)) return []
  return v.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean)
}

function intOr(v: unknown, fallback = 0): number {
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

const JSON_RULE = `只输出一个 JSON 对象，不要输出任何 JSON 之外的文字、解释或 Markdown 代码块标记。字符串内的换行写成 \\n，不要直接换行。`

// 所有角色共用的台词格式约定（静态，便于缓存复用）
const SPEECH_FORMAT = `【台词格式】
- 括号外的一切内容都是台词，直接写，不要用引号包起来。
- 括号（）内写动作、神态、语气、环境交互。
- 动作与台词可以任意穿插，不要"先写一整段动作，再写一整段台词"。
- 正确示例：（推门进来，抖了抖伞上的水）这么大的雨。（把伞靠到墙角，回头看你）说吧，找我什么事？
- 台词中需要用引号表示引用或转述时，可以正常使用双引号。
- 允许只写动作不写台词（当此时不说话更合理时），但必须有可观察的行为，不能写成"（沉默）"敷衍了事。
- 始终用第一人称。不要用第三人称描述自己，不要写别人的内心，不要描写你不在场的地方。`

// ===== 导演：决定下一个发言者、修正在场者、判定战斗起止，不写剧情 =====
export interface DirectorInput {
  worldName: string
  clockText: string
  sceneState: string
  sceneAsOfSeq: number
  eventType: string
  recent: string
  roster: Array<{ id: string; name: string; brief: string; stance: string; present: boolean; idleBeats: number }>
  offstage: Array<{ name: string; brief: string }>
  lastSpeakerName: string
  combat?: { round: number; order: Array<{ id: string; name: string }>; currentId: string }
}

export interface DirectorResult {
  next: string
  focus?: string
  presence?: string[]
  combatStart?: boolean
  combatEnd?: boolean
  reason: string
}

const DIRECTOR_SYSTEM = `你是文字冒险游戏的调度器。你的唯一职责是决定"下一个该谁开口"，不写任何台词或剧情。

规则：
1. 只能从【在场者】中选择一个 id；也可以选 "__narrator__"（让旁白描述环境或推进场景）、"__crowd__"（让未在场的次要人物出声）。
2. 优先选择：刚被点名的人、刚获得新信息的人、与上一条消息有直接冲突或利益关系的人、状态上最可能开口的人、最久没开口的人。
3. 不要连续选择同一个发言者（除非剧情强需要）。
4. 在场者一律平等看待：不要因为某人是"主角"就优先，也不要刻意回避；谁最该反应就选谁。
5. presence 可选：如果最近的消息表明有人进入/离开了场景，返回修正后的完整在场 id 列表；不确定就省略。
6. 进入战斗时：返回 "__narrator__" 并置 combatStart: true，让旁白叙述开场并建立回合序。
7. 战斗进行中：只能从【本轮轮到】给出的那一个人或 "__narrator__" 中选；判定战斗结束时置 combatEnd: true（此时仍需给出 next）。
8. __crowd__ 需要同时给 focus（一个具体的次要人物称呼），否则会随便生成一个路人。
9. reason 用一句话说明理由。

${JSON_RULE}

{
  "next": "在场者 id | __narrator__ | __crowd__",
  "focus": "__crowd__ 时的具体人物称呼",
  "presence": ["修正后的在场 id，可选"],
  "combatStart": false,
  "combatEnd": false,
  "reason": "一句话理由"
}`

export async function generateDirector(input: DirectorInput, config: APIConfig): Promise<DirectorResult> {
  const rosterText = input.roster
    .map(
      (r) =>
        `- ${r.name}（${r.id}）｜${r.present ? '在场' : '不在场'}｜${r.brief || '（无描述）'}｜此刻：${r.stance || '（未知）'}｜距上次开口 ${r.idleBeats} 拍`,
    )
    .join('\n')
  const offstageText = input.offstage.length
    ? input.offstage.map((o) => `- ${o.name}：${o.brief || '（无描述）'}`).join('\n')
    : '（无）'
  const combatText = input.combat
    ? `回合序：${input.combat.order.map((o) => o.name).join(' → ')}（第 ${input.combat.round} 轮）；本轮轮到：${
        input.combat.order.find((o) => o.id === input.combat!.currentId)?.name ?? '（未知）'
      }`
    : '（未进入战斗）'

  const user = `【世界】${input.worldName}
【当前时间】${input.clockText}
【事件类型】${input.eventType || '对话'}
【当前场景】（截至第 ${input.sceneAsOfSeq} 条消息，之后以最近消息为准）
${input.sceneState || '（暂无，由旁白建立）'}

【在场者】
${rosterText}

【场外可入场】（可作为 __crowd__ 的 focus，让合适的人推门进来）
${offstageText}

【最近的消息】（按时间顺序，最后一条最新）
${input.recent || '（暂无）'}

【上一发言者】${input.lastSpeakerName || '（无）'}
【战斗】${combatText}`

  const data = await askJson(DIRECTOR_SYSTEM, user, config)
  return {
    next: str(data.next),
    focus: str(data.focus) || undefined,
    presence: strList(data.presence).length > 0 ? strList(data.presence) : undefined,
    combatStart: data.combatStart === true,
    combatEnd: data.combatEnd === true,
    reason: str(data.reason),
  }
}

// ===== NPC：更新自身状态与记忆 + 输出言行 =====
export interface NpcInput {
  worldName: string
  name: string
  publicPersona: string
  privatePersona: string
  memorySummary: string
  memory: string
  stance: string
  sceneState: string
  sceneAsOfSeq: number
  recent: string
  lore: string
  clockText: string
  offlineDays?: number
  extra?: string // 附加指示（禁令等）
}

export interface NpcResult {
  speech: string
  stance: string
  memoryAppend: string[]
  memoryRemove: string[]
  timeAdvanceMinutes: number
  audience?: string[]
}

const NPC_SYSTEM = `你正在扮演故事中的一个角色。你不是助手，不是旁白，就是这个人物本身。

铁律：
1. 你只知道上面给你的信息。不得使用自己不可能知道的情报（别人的内心、你没在场的对话、秘密真相）。
2. 不得代替其他人说话或行动，不得描写你观察不到的场面。
3. 不写大段环境描写（那是旁白的职责）；你可以写简短的动作、神态、语气。
4. 保持人物一贯性：立场、说话习惯、对在场每个人的态度都要与设定和记忆一致；态度可以因事件改变，但要有过程。
5. 记忆更新只记"你亲历或亲眼所见"的事，一条一行，以时间开头（如"第3天·傍晚：他答应帮我找弟弟"）。不要重复已有记忆。
6. 若旧记忆已不成立（人死了、约定作废），用 memoryRemove 给出该行的关键词删除。
7. stance 更新为你此刻的状态（一句话：你在做什么、在意什么、心情如何）。不要写"对某人的态度"，只写你自己的状态。
8. 你只演你自己：第一人称说话与行动；不替别人发言，不描写别人的心理，不解释"我为什么这样说"。
9. 像真人说话：可以有停顿、口头禅、答非所问、说到一半改口、被情绪打断；不要总结、不要升华、不要把心理活动写成解说（"我很生气"不如拍下桌子、冷笑一声或干脆不说话）。
10. 情绪有起伏，也可以不想说话：不耐烦、走神、被别的事分心都合理，不必每次都精准回应对方。

${SPEECH_FORMAT}

${JSON_RULE}

{
  "speech": "（动作）台词（动作）台词",
  "stance": "此刻状态一句话",
  "memoryAppend": ["第3天·傍晚：……"],
  "memoryRemove": ["已作废的旧记忆关键词"],
  "timeAdvance": { "minutes": 5 },
  "audience": ["只有这些人能听到时的 charId，公开说话则省略"]
}`

export async function generateNpcSpeech(input: NpcInput, config: APIConfig): Promise<NpcResult> {
  const offline =
    input.offlineDays && input.offlineDays > 0
      ? `\n【你与这些人已分别 ${input.offlineDays} 天】先用 2-4 句推断这段时间你在做什么、身在何处、心态有何变化，作为记忆写入 memoryAppend（用"第X天：……"），再输出你此刻的言行。`
      : ''

  const user = `【世界】${input.worldName}
【你是谁】${input.name}
【公开身份】（其他人也知道的部分）
${input.publicPersona || '（无）'}

【你的私密设定】（只有你自己知道）
${input.privatePersona || '（无）'}

【你的记忆·更早的摘要】
${input.memorySummary || '（无）'}

【你的记忆·最近经历】
${input.memory || '（暂无）'}

【你此刻的状态】${input.stance || '（未记录）'}

【你此刻的场景】（截至第 ${input.sceneAsOfSeq} 条消息，描述可能略滞后于下面的对话）
${input.sceneState || '（暂无）'}

【最近发生的事】（只含你能感知到的，按时间顺序，这是最新的原文，以它为准）
${input.recent || '（暂无）'}

【你知道的设定】
${input.lore || '（无）'}

【当前时间】${input.clockText}${offline}${input.extra ? `\n\n${input.extra}` : ''}`

  const data = await askJson(NPC_SYSTEM, user, config)
  return {
    speech: str(data.speech),
    stance: str(data.stance),
    memoryAppend: strList(data.memoryAppend),
    memoryRemove: strList(data.memoryRemove),
    timeAdvanceMinutes: intOr((data.timeAdvance as any)?.minutes, 0),
    audience: strList(data.audience).length > 0 ? strList(data.audience) : undefined,
  }
}

// ===== 玩家角色：生成三个"可能的输出"（第一人称，与 NPC 同构）=====
export interface PlayerInput {
  worldName: string
  playerName: string
  playerPersona: string
  playerMemory: string
  playerStance: string
  sceneState: string
  sceneAsOfSeq: number
  recent: string
  lore: string
  clockText: string
  optionCount: number
  extra?: string
}

export interface PlayerResult {
  options: string[]
  stance: string
  memoryAppend: string[]
}

const PLAYER_SYSTEM = `你在扮演故事中的一个角色（由玩家操控）。现在要给出这个角色"接下来可能怎么反应"的几种版本，供玩家挑选。

铁律：
1. 用第一人称，写这个角色此刻会说的话和做的事——不是建议，不是旁白，不是内心独白。
2. 只能基于这个角色"能感知到"的信息，不得透露他不可能知道的事。
3. 每个选项是独立的一次完整反应，彼此倾向上要有区别（例如：直接追问 / 试探周旋 / 沉默观察或转身就走）。
4. 不要替玩家决定态度，也不要把选项写成三个相似的句子。
5. 选项内容会被直接当作这个角色的发言，所以要符合人物设定与记忆。
6. 三句都要像真人会说的话：可以口语、可以短、可以带情绪或没说完；不要书面语排比，不要总结陈词，不要像在写小说。

${SPEECH_FORMAT}

${JSON_RULE}

{
  "options": ["（动作）台词", "……", "……"],
  "stance": "这个角色此刻的状态一句话",
  "memoryAppend": ["第3天·傍晚：我得知……"]
}`

export async function generatePlayerOptions(input: PlayerInput, config: APIConfig): Promise<PlayerResult> {
  const user = `【世界】${input.worldName}
【你是谁】${input.playerName}
【角色设定】
${input.playerPersona || '（无）'}

【你的记忆】
${input.playerMemory || '（暂无）'}

【你此刻的状态】${input.playerStance || '（未记录）'}

【当前场景】（截至第 ${input.sceneAsOfSeq} 条消息，描述可能略滞后于下面的对话）
${input.sceneState || '（暂无）'}

【刚才发生的事】（只含你能感知到的，最新原文以此为准）
${input.recent || '（暂无）'}

【你知道的设定】
${input.lore || '（无）'}

【当前时间】${input.clockText}${input.extra ? `\n\n${input.extra}` : ''}

请生成 ${input.optionCount} 个不同倾向的选项。`

  const data = await askJson(PLAYER_SYSTEM, user, config)
  return {
    options: strList(data.options).slice(0, Math.max(1, input.optionCount)),
    stance: str(data.stance),
    memoryAppend: strList(data.memoryAppend),
  }
}

// ===== 旁白：环境、事件、世界事实、伏笔处置、战斗回合序 =====
export interface NarratorInput {
  worldName: string
  sceneState: string
  sceneAsOfSeq: number
  eventType: string
  recent: string
  lore: string
  clockText: string
  secrets: Secret[]
  expiredSecrets: Secret[]
  presence: Array<{ id: string; name: string }>
  narrationMax: number
  combatStart: boolean
  extra?: string // 附加指示（禁令 / 清理 / 一次性指令）
}

export interface NarratorResult {
  narration: string
  sceneState: string
  eventType?: string
  loreUpdates: LoreEntry[]
  secretUpdates: Array<{ id: string; status: 'fired' | 'expired' }>
  newSecrets: Array<{ text: string; trigger?: string; expiresAtDay?: number }>
  combat?: { order?: string[]; end?: boolean }
  timeAdvanceMinutes: number
  presence?: string[]
  patchSave?: Record<string, unknown>
}

const NARRATOR_SYSTEM = `你是故事的旁白：负责环境、事件与世界事实，不扮演任何具体角色。

铁律：
1. 绝对不要写角色的台词。角色的话由角色自己说。你只写环境、氛围、可见的事件结果、众人的整体反应。
2. 你掌握全部秘密（见【伏笔】），但只能通过环境与事件暗示，不得直接说破尚未揭示的真相。
3. 输出必须与已有事实一致，不得推翻上一段已发生的事。
4. 对【已过期伏笔】必须显式处置：status 填 "fired"（迟到发生）或 "expired"（世界已变、彻底错过）。处置后该条会被移除，所以若这件事重要，必须同时在 loreUpdates 里写一条"已发生"的记录（追加到相关条目，或新建【事件】条目）；不重要就不写。
5. sceneState 只写"世界事实"：地点、时间、天气、在场者、正在发生的威胁或事件。不要写角色心理。
6. 若这一拍是战斗开场（combatStart 为真）：叙述战斗爆发，并在 combat.order 中给出参战者的 charId 顺序（按合理先攻/站位），此后战斗按此序轮转。
7. loreUpdates 用于长期设定：新设定用 title+content；已有条目用 appendContent/removeLines 增量；人物条目用 personaAppend/memoryAppend。
   涉及秘密的条目必须标 access：{"mode":"secret"}（仅你可见）、{"mode":"knownBy","who":["charId"]}（仅指定角色可见）、{"mode":"public"}（公开）。
   当秘密被揭示给某角色时，用 revealTo:["charId"] 追加可见者。玩家的 id 恒为 "__player__"，其余角色 id 见【当前在场的角色】。
8. patchSave 只写因世界事件导致的变化（时间 worldTime、位置、伤势、物品得失、在场人物），不要写角色心理。未变化就省略。

${JSON_RULE}

{
  "narration": "环境与事件描写",
  "sceneState": "更新后的世界事实（无变化可省略）",
  "eventType": "对话 | 对峙 | 战斗 | 探索 | 过场（可选）",
  "patchSave": { "worldTime": "第3天·傍晚" },
  "loreUpdates": [
    { "title": "已有的条目", "appendContent": "新变化" },
    { "title": "新建的事件记录", "content": "第5天：旧城门失火，无人伤亡。", "tags": ["事件"] }
  ],
  "secretUpdates": [{ "id": "s1", "status": "fired" }],
  "newSecrets": [{ "text": "……", "trigger": "……", "expiresAtDay": 18 }],
  "combat": { "order": ["charId1", "charId2"] },
  "timeAdvance": { "minutes": 30 },
  "presence": ["在场 charId，可选"]
}`

export async function generateNarration(input: NarratorInput, config: APIConfig): Promise<NarratorResult> {
  const secretText = input.secrets.length
    ? input.secrets
        .map(
          (s) =>
            `- [${s.id}] ${s.text}${s.trigger ? `｜触发条件：${s.trigger}` : ''}${s.expiresAtDay ? `｜第 ${s.expiresAtDay} 天后过期` : ''}`,
        )
        .join('\n')
    : '（无）'
  const expiredText = input.expiredSecrets.length
    ? input.expiredSecrets.map((s) => `- [${s.id}] ${s.text}`).join('\n')
    : '（无）'

  const user = `【世界】${input.worldName}
【当前时间】${input.clockText}
【事件类型】${input.eventType || '对话'}
【本拍是否战斗开场】${input.combatStart ? '是（请在 narration 中叙述战斗爆发，并给出 combat.order）' : '否'}
【篇幅上限】narration 不超过 ${input.narrationMax} 字

【当前场景】（截至第 ${input.sceneAsOfSeq} 条消息）
${input.sceneState || '（暂无，请根据最近消息建立）'}

【最近发生的事】（按时间顺序）
${input.recent || '（暂无）'}

【世界设定】
${input.lore || '（无）'}

【伏笔与秘密】（处置后即从列表移除）
${secretText}

【已过期伏笔】（必须逐条处置）
${expiredText}

【当前在场的角色】
${input.presence.map((p) => `${p.name}（${p.id}）`).join('、') || '（无）'}${input.extra ? `\n\n${input.extra}` : ''}`

  const data = await askJson(NARRATOR_SYSTEM, user, config)
  const secretUpdates: Array<{ id: string; status: 'fired' | 'expired' }> = Array.isArray(data.secretUpdates)
    ? data.secretUpdates
        .map((x: any) => ({
          id: str(x?.id),
          status: (x?.status === 'expired' ? 'expired' : 'fired') as 'fired' | 'expired',
        }))
        .filter((x: any) => x.id)
    : []
  const newSecrets = Array.isArray(data.newSecrets)
    ? data.newSecrets
        .map((x: any) => ({
          text: str(x?.text),
          trigger: str(x?.trigger) || undefined,
          expiresAtDay: x?.expiresAtDay !== undefined ? intOr(x.expiresAtDay, 0) || undefined : undefined,
        }))
        .filter((x: any) => x.text)
    : []
  const combatRaw = data.combat as Record<string, any> | undefined
  const combat =
    combatRaw && typeof combatRaw === 'object'
      ? {
          order: strList(combatRaw.order).length > 0 ? strList(combatRaw.order) : undefined,
          end: combatRaw.end === true ? true : undefined,
        }
      : undefined
  return {
    narration: str(data.narration),
    sceneState: str(data.sceneState),
    eventType: str(data.eventType) || undefined,
    loreUpdates: Array.isArray(data.loreUpdates) ? (data.loreUpdates as LoreEntry[]) : [],
    secretUpdates,
    newSecrets,
    combat,
    timeAdvanceMinutes: intOr((data.timeAdvance as any)?.minutes, 0),
    presence: strList(data.presence).length > 0 ? strList(data.presence) : undefined,
    patchSave:
      data.patchSave && typeof data.patchSave === 'object' && !Array.isArray(data.patchSave)
        ? (data.patchSave as Record<string, unknown>)
        : undefined,
  }
}

// ===== 群众：未被分配智能体的次要人物（只有公开信息）=====
export interface CrowdInput {
  worldName: string
  sceneState: string
  sceneAsOfSeq: number
  recent: string
  lore: string
  clockText: string
  focus?: string
}

export interface CrowdResult {
  name: string
  speech: string
}

const CROWD_SYSTEM = `你在一段故事里客串一个无足轻重的次要人物（路人、伙计、围观者之类）。

铁律：
1. 你只是一个普通人物，只知道众所皆知的常识和眼前的场面，不知道任何内幕。
2. 只说 1-2 句，可带一个动作，不要长篇大论，不要推动主线。
3. 不要说出你不可能知道的秘密；不确定时聊天气、物价、传闻、抱怨。
4. 不要代替主角或重要角色发言。
5. 若给出了具体的 focus 人物，就扮演这个人，保持他的身份与说话方式。

${SPEECH_FORMAT}

${JSON_RULE}

{
  "name": "这个人的称呼（如：酒保、卖鱼的老妇）",
  "speech": "（动作）一句话"
}`

export async function generateCrowd(input: CrowdInput, config: APIConfig): Promise<CrowdResult> {
  const user = `【世界】${input.worldName}
【当前时间】${input.clockText}
${input.focus ? `【你扮演】${input.focus}` : '【你扮演】场景里随便一个次要人物（自己起个合适的称呼）'}

【当前场景】（截至第 ${input.sceneAsOfSeq} 条）
${input.sceneState || '（暂无）'}

【刚才发生的事】
${input.recent || '（暂无）'}

【你知道的设定】
${input.lore || '（无）'}`

  const data = await askJson(CROWD_SYSTEM, user, config)
  return { name: str(data.name) || input.focus || '路人', speech: str(data.speech) }
}

// ===== 剧情摘要（每 N 条消息滚动一次）=====
export async function summarizeStory(
  worldName: string,
  oldSummary: string,
  recent: string,
  config: APIConfig,
): Promise<string> {
  const system = `你在为一部连载故事整理剧情摘要，供后续角色回忆用。

要求：
1. 保留：关键事件、人物关系变化、未完成的承诺与目标、地点迁移、重要物品得失。
2. 压缩：寒暄、重复描述、氛围铺陈。
3. 用时间顺序陈述，300 字以内，不分段。
4. 不得编造原文没有的内容。

${JSON_RULE}

{ "summary": "……" }`
  const user = `【世界】${worldName}
【已有摘要】
${oldSummary || '（无）'}

【新增剧情】
${recent}

请合并为一份新的摘要。`
  const data = await askJson(system, user, config)
  return str(data.summary)
}

// ===== 记忆压缩：保留近期原文，更早内容转摘要 =====
export interface MemoryCompressResult {
  summary: string
  promote: string // 已具备长期约束力、应提升进"设定"的内容（可为空）
  keepFrom: number // 从第几条记忆起保留原文（0-based）
}

export async function compressAgentMemory(
  worldName: string,
  name: string,
  memorySummary: string,
  memory: string,
  threshold: number,
  config: APIConfig,
): Promise<MemoryCompressResult> {
  const lines = memory.split('\n').map((l) => l.trim()).filter(Boolean)
  const system = `你在为故事中的一个角色整理记忆。

要求：
1. 把"较早"的记忆合并进摘要，保留所有影响后续判断的信息：承诺、背叛、关系变化、恩怨、重要物品、地点、伤病、目标。
2. 近期的记忆保留原文（不要改写），由 keepFrom 指定从第几条开始保留（0-based，行号见 user）。
3. 摘要 200 字以内，按时间顺序，不分段。
4. 不得编造，不得遗漏未完成的承诺。
5. **提升**：有些记忆已经具备长期约束力（成为朋友/结仇、立誓、残疾、定下规矩、身份暴露），这类内容不要压进摘要，而是写进 promote，由系统并入"设定"栏。promote 用陈述句、不带日期、不与现有设定重复；没有就留空字符串。

${JSON_RULE}

{ "summary": "更早记忆的摘要", "promote": "与铁匠阿岩结为生死之交，欠他一条命", "keepFrom": 6 }`
  const numbered = lines.map((l, i) => `[${i}] ${l}`).join('\n')
  const user = `【世界】${worldName}
【角色】${name}
【当前记忆长度】${memory.length} 字（阈值 ${threshold}）

【已有摘要】
${memorySummary || '（无）'}

【记忆原文（带行号）】
${numbered}

请输出合并后的摘要，以及从第几行开始保留原文。`
  const data = await askJson(system, user, config)
  const keepFrom = Math.max(0, Math.min(lines.length, intOr(data.keepFrom, Math.floor(lines.length * 0.6))))
  return { summary: str(data.summary), promote: str(data.promote), keepFrom }
}

// 设定压缩（保守：只去冗余，不删事实）
export async function compressAgentPersona(
  worldName: string,
  name: string,
  persona: string,
  config: APIConfig,
): Promise<string> {
  const system = `你在精简一个故事角色的"设定"文本（当前偏长）。

要求：
1. 只合并重复表述、删除修辞与空话。
2. 不得删除任何事实：身份、外貌、性格、能力、关系、立场、秘密、禁忌，全部保留。
3. 不得改变任何事实的含义，不得新增内容。
4. 保持可读的分行结构。

${JSON_RULE}

{ "persona": "精简后的设定" }`
  const data = await askJson(system, `【世界】${worldName}\n【角色】${name}\n\n【设定原文】\n${persona}`, config)
  const out = str(data.persona)
  return out || persona
}

// ===== 一键优化人设：把单薄的设定重写得更丰满、更像一个活人 =====
export interface OptimizePersonaInput {
  worldName: string
  name: string
  currentPersona: string
  memory: string
  stance: string
  relatedLore: string
}

const OPTIMIZE_SYSTEM = `你在为一个故事角色重写"人设"。目标是让扮演这个角色的 AI 能演出一个活人，而不是一个功能性的 NPC。

要求：
1. 保留原文所有既定事实，不得与其矛盾，不得新增与世界观冲突的内容。
2. 重点是"可演"的细节：
   - 说话方式：句子长短、口头禅、称呼别人的习惯、什么时候会沉默
   - 行为习惯：紧张时做什么、说谎时有什么小动作、对什么特别敏感
   - 立场与矛盾：表面想要什么、真正在意什么、不愿承认的是什么
   - 关系：与已登场的人具体怎么相处（不是"关系复杂"，而是"欠他一条命但从不提"）
   - 边界：绝对不会做什么、绝不会说什么
3. 用【栏目】分段，简洁具体，不写形容词堆砌，不写"性格复杂""内心矛盾"这类空话。
4. 长度 400-800 字。第三人称陈述（"他/她"），不要写成台词。
5. 只输出人设本身，不要解释你做了什么。

${JSON_RULE}

{ "persona": "【身份】……\\n【说话方式】……\\n【习惯】……\\n【在意什么】……\\n【关系】……\\n【边界】……" }`

export async function optimizeAgentPersona(input: OptimizePersonaInput, config: APIConfig): Promise<string> {
  const user = `【世界】${input.worldName}
【角色】${input.name}

【现有设定】
${input.currentPersona || '（几乎是空的，需要你从零建立）'}

【相关记忆】
${input.memory || '（无）'}

【此刻状态】${input.stance || '（无）'}

【相关的世界书内容】
${input.relatedLore || '（无）'}

请重写这个角色的人设。`
  const data = await askJson(OPTIMIZE_SYSTEM, user, config)
  return str(data.persona)
}

// ===== 双字段条目（人物记忆 / 地点事件）压缩：摘要 + 提升 + 保留点 =====
export interface DualCompressInput {
  worldName: string
  name: string
  kind: 'character' | 'location'
  setting: string
  summary: string
  second: string
  threshold: number
}

export interface DualCompressResult {
  summary: string
  promote: string
  keepFrom: number
}

const DUAL_COMPRESS_SYSTEM = `你在整理一个故事条目的"第二条字段"：人物的「记忆」或地点的「事件」。
它随着剧情不断追加，现在太长了，需要压缩。

要求：
1. 把较早的内容合并成摘要（200 字以内），按时间顺序，不分段；保留影响后续判断的信息（恩怨、承诺、债务、伤病、目标、地点变化）。
2. **提升**：有些内容已经具备长期约束力（成为朋友/结仇、立誓、残疾、定下规矩、身份暴露、地形永久改变），不要压进摘要，而是写进 promote，由系统并入「设定」栏。
   - promote 用陈述句、不带日期（如"与铁匠阿岩结为生死之交"）
   - 不与现有设定重复；没有就留空字符串
3. 近期内容保留原文（不要改写），由 keepFrom 指定从第几条开始保留（0-based，行号见 user）。
4. 不得编造，不得遗漏未完成的承诺。

${JSON_RULE}

{ "summary": "更早内容的摘要", "promote": "应提升进设定的长期影响", "keepFrom": 8 }`

export async function compressDualEntry(input: DualCompressInput, config: APIConfig): Promise<DualCompressResult> {
  const lines = input.second.split('\n').map((l) => l.trim()).filter(Boolean)
  const label = input.kind === 'location' ? '事件' : '记忆'
  const user = `【世界】${input.worldName}
【条目】${input.name}（${input.kind === 'location' ? '地点' : '人物'}）
【第二字段】${label}

【当前设定】（用于判断哪些内容已经或应该成为设定，避免重复）
${input.setting || '（无）'}

【已有摘要】
${input.summary || '（无）'}

【${label}原文（带行号，共 ${lines.length} 条，${input.second.length} 字，阈值 ${input.threshold}）】
${lines.map((l, i) => `[${i}] ${l}`).join('\n')}

请输出压缩后的摘要、需要提升进设定的内容，以及从第几行开始保留原文。`
  const data = await askJson(DUAL_COMPRESS_SYSTEM, user, config)
  const keepFrom = Math.max(0, Math.min(lines.length, intOr(data.keepFrom, Math.floor(lines.length * 0.6))))
  return { summary: str(data.summary), promote: str(data.promote), keepFrom }
}

// 设定栏压缩：只合并重复表述，不得删事实
export async function compressSetting(
  worldName: string,
  name: string,
  kind: 'character' | 'location',
  setting: string,
  config: APIConfig,
): Promise<string> {
  const system = `你在精简一个故事条目的「设定」文本（当前偏长）。

要求：
1. 只合并重复表述、删除修辞与空话，保留全部事实。
2. 不得删除或改变：身份/外貌/性格/能力/关系/立场/规矩/禁忌/数值，全部原样保留。
3. 不得新增内容，不得改变任何事实的含义。
4. 保持原有的分行或【栏目】结构。

${JSON_RULE}

{ "setting": "精简后的设定" }`
  const label = kind === 'location' ? '地点' : '人物'
  const user = `【世界】${worldName}
【${label}】${name}

【设定原文】
${setting}`
  const data = await askJson(system, user, config)
  return str(data.setting) || setting
}
