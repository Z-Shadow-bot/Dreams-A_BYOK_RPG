import type { BannedEvent } from '@/utils/commands'

export type { BannedEvent }

// ===== 角色面板字段定义（创建世界时由 AI 生成） =====
export interface PanelField {
  key: string // 字段标识（英文 key，用于存档存取）
  label: string // 显示名
  type: 'text' | 'number' // 字段类型
  unit?: string // 单位（如 "岁"、"枚"）
}

// ===== 背包 =====
export interface Item {
  name: string
  quantity?: number
  state?: string // 物品状态描述
  remove?: boolean // 删除标记（仅用于 AI 输出：在物品对象中设 remove:true 表示从背包删除该名称物品；不持久化）
}

export interface InventoryData {
  equipment: Item[] // 装备栏（上）
  items: Item[] // 普通物品栏（下）
}

// ===== 技能 =====
export interface Skill {
  name: string // 技能名称
  description: string // 技能描述（能做到什么）
  remove?: boolean // 删除标记（仅用于 AI 输出：设 remove:true 表示删除该技能；不持久化）
}

// ===== 地图 =====
export interface MapLocation {
  name: string
  description: string // 地点简要情况
  people: string[] // 位于该地点的人物
  visited: boolean // 是否已到达（未到达的为"可前往"）
}

// ===== 人物 =====
export interface CharacterEntry {
  name: string
  introduction: string // 简要介绍
  attitude: string // 当前态度（友善/中立/警惕等）
}

// ===== 概述（四栏） =====
export interface OverviewData {
  impression: string // 第一栏：角色主观认知/当前处境
  ongoing: string // 第二栏：进行中的事项
  recentEvents: string[] // 第三栏：近期关键事件（2-3件）
  latestProgress: string // 第四栏：角色最新进展
}

// ===== 多智能体模式（仅 World.multiAgent === true 使用）=====

// 旁白的伏笔/秘密：只有旁白与旁白上下文可见；必须显式处置（fired / expired），不允许静默消失
export interface Secret {
  id: string
  text: string // 伏笔内容
  trigger?: string // 触发条件（自然语言，给旁白参考）
  expiresAtDay?: number // 世界日超过该值时由本地标记过期，等待旁白处置
  status: 'pending' | 'fired' | 'expired'
}

// 战斗状态：由旁白在开场建立回合序，之后按序轮转，导演判定结束
export interface MaCombat {
  active: boolean
  round: number
  order: string[] // charId 序列
  index: number // 当前轮到的位置
}

// 多智能体运行状态（每个世界一条）
export interface MaState {
  worldId: string
  clockDay: number // 世界日（从 1 开始）
  clockMinute: number // 当天分钟数 0-1439
  beat: number // 已推进拍数
  narratorIdle: number // 距上次旁白调用过了几拍
  lastSpeakerId: string | null // 上一次发言者（禁止连续同人）
  presence: string[] // 在场 charId（导演每拍可修正）
  sceneState: string // 旁白权威层：当前世界事实
  sceneAsOfSeq: number // sceneState 对应的最后一条消息序号
  sceneValue?: string // world.sceneField 对应的值（由视图层同步，用于世界书精确匹配）
  eventType?: string // 对话 | 对峙 | 战斗 | 探索 | 过场（导演/旁白维护）
  combat?: MaCombat // 战斗状态（可选）
  secrets: Secret[]
  digestSeq: number // 已生成剧情摘要的截至序号
  storySummary: string // 滚动剧情摘要
  autoAdvanceLeft: number // 剩余自动推进拍数
  autoAdvance?: number // 本世界的自动推进拍数设置（缺省用全局默认）
  heartbeatInterval?: number // 本世界的旁白心跳间隔设置（缺省用全局默认）
  pendingSavePatch?: Record<string, unknown> | null // 旁白产生的存档变更，由视图层应用后清空
  bannedEvents?: BannedEvent[] // 「终止事件」禁令（倒计时制，每拍 -1，归零失效）
  pendingPurge?: string[] // 待旁白清理的事件（清理后从队列移除）
  createdAt: number
  updatedAt: number
}

// 单个智能体的私有状态（旁白与玩家角色也用同结构，charId 为保留值）
export interface AgentState {
  worldId: string
  charId: string // 对应 isCharacter 条目 id；NARRATOR_ID / PLAYER_ID 为保留值
  name: string
  isPlayer?: boolean
  isNarrator?: boolean
  privatePersona: string // 私密设定（仅本人上下文可见）
  memory: string // 近期记忆原文（每条带时间前缀）
  memorySummary?: string // 更早记忆的压缩摘要
  stance?: string // 此刻状态（一句话：在做什么/在意什么），发言时由本人更新
  knownLore?: string[] // 该角色应当知道的世界书条目标题白名单（优化人设时由 AI 建议、玩家确认）
  rev: number // 单调递增，异步写回校验用
  lastSeenDay?: number // 上次在场/被调用的世界日（离线推演用）
  present?: boolean
  updatedAt: number
}

// 消息流（多智能体模式下取代 StoryPage 作为剧情载体）
export interface StoryMessage {
  id: string
  worldId: string
  seq: number // 从 0 递增
  speakerId: string // charId | NARRATOR_ID | CROWD_ID | PLAYER_ID
  speakerName: string
  text: string
  knows: string[] // 可见的 charId 集合（旁白恒知）
  appliedTo: string[] // 已吸收进记忆的 charId 集合
  createdAt: number
  meta?: { day: number; minute: number }
}

export const NARRATOR_ID = '__narrator__'
export const PLAYER_ID = '__player__'
export const CROWD_ID = '__crowd__'

// ===== 存档（全量 JSON，每轮由 AI 重写） =====
export interface SaveData {
  panel: Record<string, string | number> // 角色面板（按 panelSchema 填充）
  inventory: InventoryData
  map: MapLocation[] // 已废弃：地点信息改由世界书条目（isLocation）存储，保留字段仅兼容旧存档
  characters: CharacterEntry[] // 已废弃：人物信息改由世界书条目（isCharacter）存储，保留字段仅兼容旧存档
  activeLocations?: string[] // 当前正在交互/即将前往的地点名称，对应世界书条目强制注入
  activeCharacters?: string[] // 当前正在交互/即将见面的人物名称，对应世界书条目强制注入
  characterProfile: string // 角色设定（人设：出身、性格等相对稳定的背景，更新时需保持稳定）
  experience: string // 角色经历（冒险以来的经历概述，随剧情持续更新，与人设分开记录）
  skills: Skill[] // 技能列表（角色能做到什么，全量传入；AI 按名称 diff 更新）
  overview: OverviewData
  hidden: Record<string, string> // 隐藏条目（状态页不显示，仅作 AI 参考）
  worldTime?: string // 世界时钟（自然语言，如"启程后第12天·深秋·入夜前"，AI 每轮维护，避免时间线错乱）
}

// ===== 世界书条目的可见性（多智能体模式）=====
// 缺省 = public：所有角色都能注入；secret：仅旁白；knownBy：仅列出的角色 + 旁白
export interface LoreAccess {
  mode: 'public' | 'secret' | 'knownBy'
  who?: string[] // charId 列表（mode === 'knownBy' 时有效）
}

// ===== 世界书条目（详细设定，按标签按需注入） =====
export interface LoreEntry {
  id: string
  title?: string // 条目标题，便于检索定位
  aliases?: string[] // 别名/曾用称呼（如改名前的旧称呼）：用于识别同一实体并参与检索匹配，避免同义不同名生成重复条目
  tags: string[] // 标签（场景/地点/人物/主题等），用于按需命中
  content: string // 条目正文（详细设定）；人物条目迁移后保留为旧版只读备份，不参与注入
  // ===== 人物条目专用双字段（仅 isCharacter 使用）=====
  persona?: string // 【人物】设定：身份/性格/关系基础/能力等相对稳定的部分（公开）
  memory?: string // 【人物】记忆：经历/承诺/状态变化等随剧情演进的部分
  setting?: string // 【地点】设定：地理、氛围、规矩、势力等相对稳定的部分
  event?: string // 【地点】事件：这里发生过什么（类似地点的记忆）
  summary?: string // 双字段条目：更早记忆/事件的压缩摘要（压缩时把重要内容提升进设定栏）
  migrated?: boolean // 已把旧 content 迁入 persona/setting（content 保留作只读备份）
  // ===== 多智能体可见性（缺省 public；普通模式不生效）=====
  access?: LoreAccess
  revealTo?: string[] // 仅 loreUpdates 输出：把该条目的可见性揭示给这些 charId（不持久化）
  required?: boolean // 必需：每轮必需（AI 创建时标注，通常 2-5 条）
  fixed?: boolean // 固定：AI 不得通过 loreUpdates 修改此条目（用于不会改变的底层设定）
  links?: string[] // 关联条目标题列表：当本条目被注入时，这些标题对应的条目也会一并注入（仅展开一层）
  hidden?: boolean // 隐藏条目（彩蛋NPC等，状态页世界书概览不显示；角色出场后通过 loreUpdates 移除此标记）
  isLocation?: boolean // 地点条目（AI 自动打上，不显示为标签，不需要玩家编辑；状态页"地图"从此类条目读取）
  isCharacter?: boolean // 人物条目（AI 自动打上，不显示为标签，不需要玩家编辑；状态页"人物"从此类条目读取）
  lastVisitedTime?: string // 上次到访/接触的冒险时间（worldTime 快照），用于故地重游/故人重逢时判断时间流逝
  remove?: boolean // 删除标记（仅用于 loreUpdates 输出：仅当条目完全重复或记录错误时 AI 返回 { title, remove: true }；已死亡/损毁的条目须保留并用 content 标注终态，不持久化）
  // ===== 内容级增量更新（仅用于 loreUpdates 输出，不持久化）=====
  appendContent?: string // 追加到条目内容（未提供 content 时生效；可配合 appendTo 指定栏目）
  appendTo?: string // 追加目标栏目（如「关键记忆」）；命中对应【栏目】标题时插入该区段末尾，否则追加到条目末尾
  removeLines?: string[] // 删除条目内容中包含这些子串的行（逐行匹配）
  // ===== 人物条目双字段增量（仅用于 loreUpdates 输出，不持久化）=====
  personaAppend?: string // 追加到 persona 末尾
  personaRemoveLines?: string[] // 从 persona 删除包含这些子串的行
  // ===== 地点条目双字段增量（仅用于 loreUpdates 输出，不持久化）=====
  settingAppend?: string // 追加到 setting 末尾
  settingRemoveLines?: string[] // 从 setting 删除包含这些子串的行
  eventAppend?: string // 追加到 event 末尾
  eventRemoveLines?: string[] // 从 event 删除包含这些子串的行
  memoryAppend?: string // 追加到 memory 末尾（多条用换行分隔）
  memoryRemoveLines?: string[] // 从 memory 删除包含这些子串的行
}

// ===== 世界原始快照（创建世界时保存：供"重新开始冒险"重置设定、"复制世界"生成副本使用） =====
export interface WorldOriginal {
  worldSetting: string
  lorebook: LoreEntry[]
  panelSchema: PanelField[]
}

// ===== 世界 =====
export interface World {
  id: string
  name: string
  worldSetting: string // 核心设定（全局铁律 + 框架，生成时由 AI 压缩；旧世界可为全文）
  lorebook?: LoreEntry[] // 世界书条目（详细设定，按需注入；可选，旧世界兼容）
  panelSchema: PanelField[] // 角色面板字段定义
  createdAt: number
  updatedAt: number
  original?: WorldOriginal // 创建时的原始设定快照（不含冒险内容）
  // 以下为 DLC 世界专属字段（可选）
  dlcId?: string // 关联的 DLC 唯一标识，同时作为音乐文件目录名
  sceneField?: string // 存档 panel 中标记「当前场景类型」的字段 key
  bgm?: Record<string, string> // 场景类型 -> 音乐文件名（相对 bgm/ 目录）
  presetCharacters?: PresetCharacter[] // DLC 预设角色（label 简称 + description 完整设定），导入后供玩家选择
  characterFallback?: string // 角色来源兜底：玩家创建的角色不符合世界规则时的兜底处理，仅在创建角色（开始冒险）时注入，不在后续行动中使用
  loreLimit?: number // 单轮注入的世界书最大匹配条目数（默认 12；越大每轮消耗 token 越多，生成越慢）
  dlcLoreTitles?: string[] // DLC 初始世界书条目的 title 列表（更新 DLC 时用于区分初始条目与玩家添加条目）
  sourceId?: string // 导入世界的源 id（用于后续导入同一源世界时识别为「更新」而非「新建」）
  baseLoreTitles?: string[] // 分享/导入世界的基线条目 title 列表（导入更新时区分基线条目与玩家新增条目，作用同 dlcLoreTitles）
  multiAgent?: boolean // 多智能体模式：创建世界时二选一，创建后不可更改
}

// ===== 预设角色（DLC 提供的可选起始角色） =====
export interface PresetCharacter {
  label: string // 简称（下拉框显示）
  description: string // 完整设定（选择后填入"角色设定"输入框，玩家可见可编辑）
  hidden?: string // 隐藏设定（不显示给玩家，仅传给 AI 生成初始存档用，可埋彩蛋）
}

// ===== DLC 清单（zip 内的 dlc.json 结构） =====
export interface DlcManifest {
  type: 'dreams-dlc'
  version: number
  title: string
  world: {
    name: string
    worldSetting: string
    lorebook?: LoreEntry[] // 世界书条目（DLC 制作时预置，导入后随冒险维护）
    panelSchema: PanelField[]
  }
  sceneField: string // 场景字段 key
  bgm: Record<string, string> // 场景类型 -> 音乐文件名
  presetCharacters?: PresetCharacter[] // 预设角色（label 简称 + description 完整设定）
  characterFallback?: string // 角色来源兜底：玩家创建的角色不符合世界规则时的兜底处理，仅在创建角色时注入
}

// ===== 冒险页（单轮，仅供回顾剧情，不存存档快照） =====
export interface StoryPage {
  id: string
  worldId: string
  index: number // 页序号（从 0 开始）
  playerInput: string // 玩家输入/选择
  narration: string // AI 叙事
  options: string[] // AI 给出的参考选项
  createdAt: number
  edited?: boolean // 玩家手动改写过的页面（行动前 AI 需先同步改写内容）
}

// ===== 世界运行状态（当前存档 + 页历史） =====
export interface WorldState {
  worldId: string
  currentSave: SaveData // 当前存档
  currentIndex: number // 当前页序号
  pendingRetry?: {
    input: string
    save: SaveData
    pages: StoryPage[]
    currentIndex: number
    lorebook: LoreEntry[] | null
  } | null
  // 多智能体：本轮回退快照（每次提交前整体覆盖，重试时整体退回）
  pendingMaTurn?: MaTurnSnapshot | null
  // 普通模式：「终止事件」禁令（倒计时制，每回合 -1，归零失效）
  bannedEvents?: BannedEvent[]
  npcSurpriseCounter?: number // 距下一次"久未见 NPC 随机引入"还剩的回合数（1-10 随机重置）
  createdAt: number
  updatedAt: number
}

// 多智能体一轮的完整快照（一次提交可能推进多拍）
export interface MaTurnSnapshot {
  beforeSeq: number // 本轮之前的最大消息序号（-1 表示空）
  input?: string // 玩家本轮输入（重试时填回输入框，可修改）
  ma: MaState // 时钟/场景/伏笔/beat/战斗全量
  agents: AgentState[] // 全部角色状态（含 rev，回退后异步写回自动失效）
  lorebook?: LoreEntry[] // 世界书快照（旁白可能修改）
  save?: SaveData // 存档快照（旁白 patchSave 可能修改）
  createdAt: number
}

// ===== 存档点 =====
export interface SavePoint {
  id: string
  worldId: string
  name: string
  save: SaveData
  pageIndex: number // 保存时的页序号
  pages?: StoryPage[] // 保存时的完整冒险页快照（读档时恢复，避免截断后无法找回后续页面）
  lorebook?: LoreEntry[] // 存档时的世界书快照（读档时恢复，避免时间线不一致）
  worldSetting?: string // 存档时的核心设定快照
  panelSchema?: PanelField[] // 存档时的面板字段快照
  // ===== 多智能体模式快照（仅 World.multiAgent 时存在）=====
  maState?: MaState
  agents?: AgentState[]
  messages?: StoryMessage[]
  createdAt: number
}

// ===== API 配置（key 单独存 Keystore） =====
export interface APIConfig {
  baseUrl: string
  model: string
  extraHeaders: Record<string, string>
  temperature: number
  // 不再限制输出长度，交由模型自动决定；保留字段以兼容旧配置
  maxTokens?: number
  maxWaitTime: number // 最大等待时间（秒），对应网络请求读取超时
  narrationMin?: number // 每轮叙事字数下限
  narrationMax?: number // 每轮叙事字数上限
  deepThink?: boolean // 深度思考：开启后按模型类型追加思考/推理参数（DeepSeek/Qwen/GLM/GPT/Gemini）
  webSearch?: boolean // 联网搜索：开启后生成世界/完善设定/写世界书/设计事件时让模型尝试联网检索补充（依赖模型/服务端支持，默认关闭）
}

// ===== 我的 API（保存多个配置，快速切换；apiKey 独立存 Keystore） =====
export interface ApiProfile {
  id: string
  name: string
  baseUrl: string
  model: string
  extraHeaders: Record<string, string>
  temperature: number
  maxWaitTime: number
  narrationMin: number
  narrationMax: number
  deepThink?: boolean // 深度思考开关
  webSearch?: boolean // 联网搜索开关（保存到 profile，切换时一并生效）
}

// ===== AI 请求 / 响应 =====
export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface AIRequest {
  messages: ChatMessage[]
  temperature: number
  maxTokens: number
}

export interface AIResponse {
  narration: string
  options: string[]
  save: SaveData
  loreUpdates?: LoreEntry[] // 可选：本轮出现值得长期记录的新设定（世界书更新）
}

// ===== 初始存档工厂 =====
export function createEmptySave(panelSchema: PanelField[]): SaveData {
  const panel: Record<string, string | number> = {}
  for (const f of panelSchema) {
    panel[f.key] = f.type === 'number' ? 0 : ''
  }
  return {
    panel,
    inventory: { equipment: [], items: [] },
    map: [],
    characters: [],
    activeLocations: [],
    activeCharacters: [],
    characterProfile: '',
    experience: '',
    skills: [],
    overview: {
      impression: '',
      ongoing: '',
      recentEvents: [],
      latestProgress: '',
    },
    hidden: {},
  }
}

export function createId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}