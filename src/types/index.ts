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
}

export interface InventoryData {
  equipment: Item[] // 装备栏（上）
  items: Item[] // 普通物品栏（下）
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

// ===== 存档（全量 JSON，每轮由 AI 重写） =====
export interface SaveData {
  panel: Record<string, string | number> // 角色面板（按 panelSchema 填充）
  inventory: InventoryData
  map: MapLocation[]
  characters: CharacterEntry[]
  characterProfile: string // 角色设定
  overview: OverviewData
  hidden: Record<string, string> // 隐藏条目（状态页不显示，仅作 AI 参考）
  worldTime?: string // 世界时钟（自然语言，如"启程后第12天·深秋·入夜前"，AI 每轮维护，避免时间线错乱）
}

// ===== 世界书条目（详细设定，按标签按需注入） =====
export interface LoreEntry {
  id: string
  title?: string // 条目标题，便于检索定位
  tags: string[] // 标签（场景/地点/人物/主题等），用于按需命中
  content: string // 条目正文（详细设定）
  required?: boolean // 全局铁律：每轮必带（AI 创建时标注，通常 2-5 条）
  hidden?: boolean // 隐藏条目（彩蛋NPC等，状态页世界书概览不显示；角色出场后通过 loreUpdates 移除此标记）
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
  // 以下为 DLC 世界专属字段（可选）
  dlcId?: string // 关联的 DLC 唯一标识，同时作为音乐文件目录名
  sceneField?: string // 存档 panel 中标记「当前场景类型」的字段 key
  bgm?: Record<string, string> // 场景类型 -> 音乐文件名（相对 bgm/ 目录）
  presetCharacters?: PresetCharacter[] // DLC 预设角色（label 简称 + description 完整设定），导入后供玩家选择
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
}

// ===== 世界运行状态（当前存档 + 页历史） =====
export interface WorldState {
  worldId: string
  currentSave: SaveData // 当前存档
  currentIndex: number // 当前页序号
  createdAt: number
  updatedAt: number
}

// ===== 存档点 =====
export interface SavePoint {
  id: string
  worldId: string
  name: string
  save: SaveData
  pageIndex: number // 保存时的页序号
  lorebook?: LoreEntry[] // 存档时的世界书快照（读档时恢复，避免时间线不一致）
  worldSetting?: string // 存档时的核心设定快照
  panelSchema?: PanelField[] // 存档时的面板字段快照
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
    characterProfile: '',
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