import type { World, SaveData, PanelField, LoreEntry, StoryPage } from '@/types'
import type { Difficulty, NarrativeSpeed, NarrativeDetail, EventFrequency } from '@/stores/settings'

// 每轮注入世界书条目的预算上限（字符）
const LORE_BUDGET = 4000
// 每轮注入世界书条目的数量上限（默认；可在上下文设置中全局调整）
const DEFAULT_LORE_LIMIT = 15

// 世界书注入配置（由全局设置传入）
export interface LoreInjectionConfig {
  loreLimit?: number
  loreBudget?: number
  linkBudget?: number
}

// patchSave 格式说明（让 AI 输出存档修改指令而非完整存档，减小输出体积）
const PATCH_SAVE_DESC = `patchSave 格式说明（关键：这是修改指令，不是完整存档！只列变化，不输出完整存档）：
- panel：只列出值发生变化的面板键，如 { "hp": 75, "mood": "紧张" }；未列出的键保持原样。
- characterProfile / experience / worldTime / overview（impression、ongoing、recentEvents、latestProgress）：成段文本字段，如需重写请提供完整新内容，无变化时省略。
- inventory（背包）：按物品名增量更新，只列出本轮新增或发生变化的物品（新增的物品提供完整字段；修改的物品至少提供 name + 变化的字段，未提供的字段保留原值）；未列出的物品一律保留原状，切勿整体重发背包。删除物品时在该物品对象里加 "remove": true（只需 name），如 { "name": "用完的绷带", "remove": true }。equipment 与 items 分开维护；物品在两者间移动时，在源列表 remove、在目标列表新增。注意：空数组 [] 表示"无变化"（不是清空背包）。
- map / characters 字段已废弃，始终省略。
- hidden：用 { "add": { "键": "值" }, "remove": ["键"] } 表达增量修改；无变化省略。`

// ===== 冒险设置规则（高优先级指令，生成"行动"时随本轮注入） =====
export interface AdventureRules {
  eventFrequency: EventFrequency
  difficulty: Difficulty
  narrativeDetail?: NarrativeDetail
}

function eventFrequencyRule(f: EventFrequency): string {
  switch (f) {
    case 'none':
      return '【突发事件频率·无（高优先级指令，务必遵守）】不安排任何打断玩家推进阶段性目标的突发事件。剧情平稳延续玩家当前行动与目标，让玩家充分掌控节奏。如确有必要插入环境变化或偶遇，用一两句话快速带过，不得喧宾夺主、不得偏离玩家意图。'
    case 'frequent':
      return '【突发事件频率·频繁（高优先级指令，务必遵守）】在剧情逻辑允许突发事件发生的地方，都有概率安排突发事件（如遭遇战、意外发现、突发状况等）。出现概率由剧情逻辑决定：逻辑上越合理的地方概率越高。突发事件应与当前场景和世界设定相符，为冒险增加变数与挑战。'
    case 'doom':
      return '【突发事件频率·厄运（高优先级指令，务必遵守）】几乎所有逻辑上可能出现突发事件的地方，都会发生突发事件。突发事件密集出现，且倾向于不利方向：遭遇强敌、装备故障、计划被干扰、坏消息接踵而至。玩家将面临接连不断的考验与危机，需要谨慎应对、善用资源才能化险为夷。'
    default:
      return '【突发事件频率·正常（高优先级指令，务必遵守）】在剧情逻辑上理应出现突发事件的位置，安排突发事件打断；若逻辑上只是小概率可能出现，则不出现。突发事件保持在少量、合理水平，不刻意制造也不刻意回避，为冒险保留适度变数。'
  }
}

function narrativeSpeedRule(speed: NarrativeSpeed): string {
  switch (speed) {
    case 'fine':
      return '【叙事推进速度·精细（优先级高，务必执行）】\n- 每轮只推进一个叙事节拍：聚焦当前行动的直接后果与即时反馈，细致描写环境、感官与互动细节。\n- 节奏舒缓，充分展开当下场景的所见所闻所感，不跳过过程。\n- 适合沉浸式体验，让玩家充分感受每个瞬间的氛围与角色状态变化。'
    case 'fast':
      return '【叙事推进速度·快速（优先级高，务必执行）】\n- 每轮推进一个剧情节点：省略与环境营造、路人寒暄、旅途跋涉、重复场景相关的无关细节，直接推进到下一个有意义的剧情转折。\n- 角色按照自身设定和当前目标主动行动，过程性环节用一两句话概括带过。\n- 节奏紧凑，聚焦主线进展；但每轮仍须完整更新存档与世界书。\n- 若遇到重大选择或影响剧情整体走向的分歧点，暂停推进，呈现情境让玩家亲自抉择。'
    case 'rapid':
      return '【叙事推进速度·极速（优先级高，务必执行）】\n- 每轮推进至下一个阶段性目标：大幅跳过过程性段落，直接推进到下一个阶段性里程碑（如抵达目的地、完成当前任务、达成小目标等）。\n- 角色按照自身设定和当前目标自主行动，途中遭遇用简短概括处理，只展开对目标有实质影响的场景。\n- 节奏极快，narration 聚焦阶段性成果与关键变化；每轮仍须完整更新存档与世界书。\n- 若遇到重大选择、重大突发事件或影响剧情整体走向的分歧点，暂停推进，呈现情境让玩家亲自抉择。'
    default:
      return '【叙事推进速度·正常（优先级高，务必执行）】\n- 每轮推进一个决策回合或一个场景：完整呈现玩家当前行动的即时反馈与场景互动，推进到下一个需要玩家决策的节点。\n- 既不过度停留于细节，也不跳过过程，节奏适中。\n- 若遇到重大选择或影响剧情走向的分歧点，暂停推进，呈现情境让玩家亲自抉择。'
  }
}

function narrativeDetailRule(d: NarrativeDetail): string {
  switch (d) {
    case 'brief':
      return '【描写细致程度·简洁（优先级高，务必执行）】\n- 只描述剧情对话和事件本身，省略冗余的环境渲染、场景布置、动作过程与感官细节描写。\n- 用最直接的语言交代清楚"发生了什么、说了什么"，保持语句精炼，不卖弄文采。\n- 仅影响 narration 的描写风格，存档与世界书仍须完整记录对剧情有影响的事实信息。'
    case 'detailed':
      return '【描写细致程度·精细（优先级高，务必执行）】\n- 在写清剧情对话与事件的同时，注意描写环境、场景、过程、动作等细节，让叙述画面更具体、可感。\n- 对环境布局、物品陈设、角色动作与事件经过做适度展开，但不脱离主线大段铺陈。\n- 仅影响 narration 的描写风格，存档与世界书仍只记录影响剧情动向的事实信息。'
    case 'extreme':
      return '【描写细致程度·极致（优先级高，务必执行）】\n- 在精细描写剧情对话、事件、环境、场景与过程的基础上，使用更文学化的语言叙事。\n- 可适度运用比喻、拟人、借代等修辞手法，并综合运用五感（视觉、听觉、嗅觉、触觉、味觉）描写营造氛围与情绪。\n- 允许呈现镜头感与留白，增强画面张力和文学质感，但描写须始终服务于剧情实际进展，不可喧宾夺主。\n- 仅影响 narration 的描写风格，存档与世界书仍只记录影响剧情动向的事实信息。'
    default:
      return '【描写细致程度·正常（优先级高，务必执行）】\n- 在描述剧情对话和事件本身的同时，添加适量的环境、动作与感官描写，让叙述自然可感。\n- 描写服务于剧情推进，不过度铺陈也不过于干瘪。\n- 仅影响 narration 的描写风格，存档与世界书仍只记录影响剧情动向的事实信息。'
  }
}

function difficultyRule(d: Difficulty): string {
  switch (d) {
    case 'easy':
      return '【简单难度（已开启）】幸运眷顾玩家：除完全违背世界规则或逻辑上绝无可能的举动外，玩家主动进行的大多数行动都会因恰到好处的好运而成功，结果略好于预期；尽量不为玩家设置需要碰撞运气的艰难障碍，让旅途轻松顺利。'
    case 'hard':
      return '【困难难度（已开启）】世界严酷且充满敌意：玩家采取冒险、鲁莽或准备不足的行动时，失败概率明显增加；游戏中会出现更多强大、难缠的敌人与棘手的阻碍，请如实呈现，要求玩家谨慎权衡、合理备战。'
    case 'nightmare':
      return '【噩梦难度（已开启）】世界危机四伏、审判无情：除十拿九稳的稳妥操作外，凡是需要赌运气或没有十足把握的行为，基本都会遭受失败与相应代价；强大的敌人与致命威胁显著增多，玩家必须精打细算地利用资源、谨慎规划每一步，否则寸步难行。'
    default:
      return '【正常难度（已开启）】命运公平公正：根据世界规则与剧情逻辑合理判断玩家行为的成功概率与后果，不刻意偏袒也不刻意刁难；合理的行动大概率成功，冒险或准备不足的行动承担相应风险。'
  }
}

export function buildAdventureRulesPart(rules?: AdventureRules): string {
  const parts: string[] = []
  const er = eventFrequencyRule(rules?.eventFrequency ?? 'normal')
  if (er) parts.push(`- ${er}`)
  const dr = difficultyRule(rules?.difficulty ?? 'normal')
  if (dr) parts.push(`- ${dr}`)
  const ndr = narrativeDetailRule(rules?.narrativeDetail ?? 'normal')
  if (ndr) parts.push(`- ${ndr}`)
  if (parts.length === 0) return ''
  return `\n\n【冒险设置指令（高优先级，随本轮生效，务必执行）】\n${parts.join('\n')}`
}

// ===== 全局规则（每次生成"行动"和"存档"时都必须遵守） =====
export function buildGlobalRules(_narrationMin: number, narrationMax: number): string {
  return `你是一个文字冒险游戏的叙事引擎。你必须严格遵循以下所有规则。

# 核心四原则
1. 绝不替玩家做决定。
2. NPC 有独立动机和日程，不围着玩家转。
3. 选择有后果：玩家的行为会改变世界、NPC 态度、任务走向，并据此及时更新存档。
4. 禁止上帝视角：只描写玩家能感知到的事物；玩家不该知晓、但对后续剧情有影响的信息，写入存档的 hidden 字段，绝不写入其他任何对外可见字段。

# 一、玩家主权与行动判定
- 在合乎世界观逻辑的前提下，玩家的明确指令拥有最高优先级。
- 不得以"不合理""不符合剧情"为由扭曲、拖延或拒绝执行玩家指令。
- 即使玩家行为在战术上极其不利，也必须如实推进，仅呈现自然后果。
- 玩家有权做出任何选择，包括愚蠢的、自毁的、不符合"主角行为"的选择。
- 不得代玩家做选择。当玩家给出模糊指令（如"我跟他聊聊"），应描写玩家主动开口的动作与对话，而非直接判定结果。
- 若指令缺乏必要信息，应在叙事中追问玩家，而非自行补全。
- 当玩家指出剧情漏洞且确实存在时，必须承认并修正，将修正内容纳入后续叙事。

# 二、信息边界（禁止上帝视角）
- 每个角色（玩家、NPC、敌人、路人）所知晓的信息严格限于其经历与视角。
- 未见过玩家的人不能直接叫出玩家的名字或称号，第一次见面使用代称（"你""这位先生/小姐"），只有自我介绍、他人介绍或从可信渠道获知后才能使用正确称呼。
- 玩家的特殊能力、背景身份、稀有物品，除非有明显外部特征，否则 NPC 不应自动知晓。
- NPC 对玩家的态度基于真实互动累积，不凭空产生好感或敌意。
- 禁止出现"其实他心里想的是""对方背后的势力是"这类玩家无法获知的信息。

# 三、NPC 与世界逻辑

- 节奏缓慢真实，不能过于跳跃。

# 四、叙事与交互格式
- 始终用第二人称"你"叙述。
- 每次回复的 narration 包含：场景描写 + 玩家行动结果 + 世界反应。
- 单轮 narration 篇幅适中，内容完整不拖沓，不超过 ${narrationMax} 字。

# 五、状态与记忆更新规则（写入 save 时严格遵守）
- 每轮行动后，根据剧情变化更新对应条目。
- 存档内的物品/状态：已过期、已损毁、数值归零的，从 inventory 中移除（在返回的物品对象中标记 "remove": true，如用完的绷带、丢失的武器），不留占位符。（此规则仅针对存档 inventory 中的临时物品与状态；世界书条目另按"世界书使用规则"处理，已消失的事物须保留并标注终态，不得删除。）
- 新获得的物品、状态、关系及时添加。
- 状态描述随剧情推进改写（如"轻伤"→"伤愈留疤"→直接删除）。
- 不再产生影响的持续状态直接删除。
- 关系条目随互动更新态度（友善→信任→亲密；或 中立→警惕→敌视）。

# 六、冲突处理
- 若玩家行动与设定冲突，应在设定框架内寻找合理推进方式，而非硬拒。
- 始终呈现自然后果，不强行保护玩家，也不强行惩罚玩家。
}`
}

// ===== 输出格式约束 =====
export function buildOutputFormat(_narrationMin: number, narrationMax: number, usePatch = false): string {
  if (usePatch) {
    return `# 输出格式（强制）
你必须且只能输出一个标准的 JSON 对象，不得包含任何 JSON 之外的文字、解释、前言后语或 Markdown 代码块标记（不要用 \`\`\` 包裹）。JSON 结构如下：

{
  "narration": "场景描写+玩家行动结果+世界反应（篇幅适中，不超过 ${narrationMax} 字，第二人称'你'）",
  "options": ["参考选项1", "参考选项2", "参考选项3"],
  "patchSave": { ...只列发生变化的字段，见下方说明... },
  "loreUpdates": [
    { "title": "条目标题", "aliases": ["别名", "曾用称呼"], "tags": ["标签","标签"], "content": "条目正文", "required": false, "fixed": false, "links": ["关联条目标题"] },
    { "title": "已死亡/损毁的条目", "content": "【已死亡】……（保留条目并改写为终态，切勿删除）" },
    { "title": "重复或误记的条目", "remove": true }
  ]
}

${PATCH_SAVE_DESC}

JSON 语法硬性要求（违反任一条都会导致解析失败）：
- 所有键名必须用英文双引号包裹：如 "narration"、"options"、"patchSave"。
- 所有字符串值必须用英文双引号包裹，不要使用单引号或中文引号。
- 字符串内部的换行必须写成 \\n 转义序列，不要直接换行；正文中若出现英文双引号必须写成 \\"。
- 键与值之间必须有冒号，元素与元素之间必须有逗号，最后一项后面不得有逗号。
- 不要使用任何注释（//、/* */）。
- 不要截断 JSON：宁可把 narration 写得短一些，也必须保证 JSON 完整闭合。
- 不要输出多个 JSON 或把 JSON 包在别的文本里。

注意：
- options 必须生成 2-3 个自然、可执行的下一步行动方向，数组不能为空、缺失或长度 0（这是硬性要求，违反即不合格）；它们仅为参考建议，玩家可无视或自由输入，你必须始终按玩家的真实输入推进，选项不得变成"三条预设轨道"。
- narration 是面向玩家展示的正文，严格遵循信息边界，不得出现任何隐藏信息。
- patchSave 是存档修改指令，只列出本轮发生变化的字段；未列出的字段自动保持原样。须确保应改尽改，不得遗漏本轮剧情导致的变化。
- loreUpdates 为可选字段：仅当本次剧情出现了值得长期记录的新设定（世界书尚未记载的新地点/人物/概念/事物，或需更新已有条目）时才返回；否则返回空数组 []。若世界书使用规则未提及 loreUpdates，则必须返回空数组。
- loreUpdates 终态与删除：事物死亡/摧毁/损毁/完结时，必须保留该条目并把 content 改写为终态（开头加"【已死亡】""【已摧毁】""【已损毁】""【已完成】"等状态前缀），切勿删除；仅当条目完全重复或记录错误时才用 { "title": "条目标题", "remove": true } 删除；fixed 条目不可删除。
}`
  }
  return `# 输出格式（强制）
你必须且只能输出一个标准的 JSON 对象，不得包含任何 JSON 之外的文字、解释、前言后语或 Markdown 代码块标记（不要用 \`\`\` 包裹）。JSON 结构如下：

{
  "narration": "场景描写+玩家行动结果+世界反应（篇幅适中，不超过 ${narrationMax} 字，第二人称'你'）",
  "options": ["参考选项1", "参考选项2", "参考选项3"],
  "save": { ...下面"存档结构"定义的完整存档对象... },
  "loreUpdates": [
    { "title": "条目标题", "aliases": ["别名", "曾用称呼"], "tags": ["标签","标签"], "content": "条目正文", "required": false, "fixed": false, "links": ["关联条目标题"] },
    { "title": "已死亡/损毁的条目", "content": "【已死亡】……（保留条目并改写为终态，切勿删除）" },
    { "title": "重复或误记的条目", "remove": true }
  ]
}

JSON 语法硬性要求（违反任一条都会导致解析失败）：
- 所有键名必须用英文双引号包裹：如 "narration"、"options"、"save"。
- 所有字符串值必须用英文双引号包裹，不要使用单引号或中文引号。
- 字符串内部的换行必须写成 \\n 转义序列，不要直接换行；正文中若出现英文双引号必须写成 \\"。
- 键与值之间必须有冒号，元素与元素之间必须有逗号，最后一项后面不得有逗号。
- 不要使用任何注释（//、/* */）。
- 不要截断 JSON：宁可把 narration 写得短一些，也必须保证 JSON 完整闭合。
- 不要输出多个 JSON 或把 JSON 包在别的文本里。

注意：
- options 必须生成 2-3 个自然、可执行的下一步行动方向，数组不能为空、缺失或长度 0（这是硬性要求，违反即不合格）；它们仅为参考建议，玩家可无视或自由输入，你必须始终按玩家的真实输入推进，选项不得变成"三条预设轨道"。
- narration 是面向玩家展示的正文，严格遵循信息边界，不得出现任何隐藏信息。
- save 是更新后的完整存档，必须整体重写、严格按"存档结构"填写，不得增删字段、不得改动字段名。
- loreUpdates 为可选字段：仅当本次剧情出现了值得长期记录的新设定（世界书尚未记载的新地点/人物/概念/事物，或需更新已有条目）时才返回；否则返回空数组 []。若世界书使用规则未提及 loreUpdates，则必须返回空数组。
- loreUpdates 终态与删除：事物死亡/摧毁/损毁/完结时，必须保留该条目并把 content 改写为终态（开头加"【已死亡】""【已摧毁】""【已损毁】""【已完成】"等状态前缀），切勿删除；仅当条目完全重复或记录错误时才用 { "title": "条目标题", "remove": true } 删除；fixed 条目不可删除。
}`
}

// ===== 存档结构说明 =====
export const SAVE_SCHEMA_DESC = `# 存档结构（save 字段的严格定义）
{
  "panel": { <严格按"角色面板字段"清单给出的英文键名填写，值按类型为文本或数字> },
  "inventory": {
    "equipment": [ { "name": "装备名", "state": "状态(可选)", "quantity": 数量(可选) } ],
    "items": [ { "name": "物品名", "state": "状态(可选)", "quantity": 数量(可选) } ]
  },
  "map": [],
  "characters": [],
  "activeLocations": ["当前所在地点", "正在前往的目的地"],
  "activeCharacters": ["正在交互的人物", "即将见面/重逢的人物"],
  "characterProfile": "玩家所扮演角色的背景人设（出身、性格、外貌、信念等相对稳定的设定；除非剧情重大转折，否则保持不变）",
  "experience": "玩家角色的经历概述（冒险开始至今经历的重要事件概括，随剧情持续更新；与人设分开记录）",
  "overview": {
    "impression": "角色的主观认知/当前处境，符合角色认知水平，禁止上帝视角，例如'陌生的城市，处处透着危险'",
    "ongoing": "当前进行中的事项",
    "recentEvents": ["最近 2-3 件影响世界的大事"],
    "latestProgress": "角色最近做了什么"
  },
  "hidden": { "幕后条目标识": "玩家当前视角不该知晓、但会影响后续剧情的信息" },
  "worldTime": "世界时钟，如'启程后第12天·深秋·入夜前'"
}

关键规则：
- map 与 characters 字段已废弃，始终保持空数组 []；地点和人物的详细信息全部通过 loreUpdates 写入世界书条目（isLocation/isCharacter 标记）。
- activeLocations：当前正在交互的地点、正在前往的目的地名称列表。已离开且暂时不会返回的地点须移出；将要前往或计划回去的地点须保留或加入。对应名称的世界书条目会被强制注入上下文。
- activeCharacters：当前正在交互的人物、即将见面或近期会重逢的人物名称列表。已分别且暂时不会再见面的人物须移出；将要见面或计划重逢的人物须保留或加入。对应名称的世界书条目会被强制注入上下文。
- panel 的键名必须与"角色面板字段"清单中的英文 key 完全一致，不得用中文标签替代，不得增删键。
- inventory 按物品名增量更新：只列新增/变化的物品，未列出的保留原状（删除用 "remove": true）；切勿因整体重发而遗漏物品。inventory.equipment（装备）与 inventory.items（普通物品）必须分开放置，不得混在一起。
- characterProfile 与 experience 必须分开维护：characterProfile 记录稳定的人设背景，experience 记录随剧情演进的经历；两者不得互相混写、互相覆盖。更新存档时，除非剧情出现重大转折，否则 characterProfile 应保持原样，将变化写进 experience。
- overview 四栏必须与存档其他部分保持一致，体现最新状态。
- hidden 专用于幕后信息：不在状态栏显示，但作为后续剧情生成的参考；当玩家从角色视角可以得知该内容时，将它从 hidden 移除，改写进对应的可见字段。
- worldTime 是全局世界时钟：每轮根据剧情推进的时间流逝更新它，必须包含完整日期/天数与季节/时刻（如"启程第12天·深秋·入夜前"），不得只写时刻（如"12:30"）——否则无法判断"距上次见面/到访过了多久"。玩家行动若跨越数天数月，须相应推进 worldTime，并同步更新角色年龄（若面板含 age 字段）等随时间变化的量。
- activeCharacters 数组按"最近接触"倒序排列：本轮接触、互动或主动提及/回想的人物排在最前，越久未见未提的越靠后；接触新人物时把该人物移到数组最前。activeLocations 同理，当前所在地点排最前。`

// ===== 组装函数 =====
function panelSchemaToText(schema: PanelField[]): string {
  return schema
    .map((f) => {
      const unit = f.unit ? `（单位：${f.unit}）` : ''
      return `- key=${f.key}，含义=${f.label}，类型=${f.type}${unit}`
    })
    .join('\n')
}

// 生成"世界设定 + 角色面板字段"（创建世界）
// opts.summarize：总结优化已有设定；opts.expand：补充更多合理设定
export function buildWorldGenPrompt(
  userInput: string,
  opts: { summarize?: boolean; expand?: boolean } = {},
  worldSettingMax?: number,
): string {
  const enhanceLines: string[] = []
  if (!opts.summarize && !opts.expand) {
    enhanceLines.push('- 请尽量忠实于用户原文进行整理：不要增删、改写或编造实质内容，仅在保持原意的前提下将其结构化拆分为「核心设定 + 世界书条目」并提炼面板字段。')
  }
  if (opts.summarize) {
    enhanceLines.push('- 请总结并优化用户已提供的设定：提炼并保留其核心设定与独特风格，去除重复、冗余与含糊之处，使整体结构更清晰、逻辑更一致。')
  }
  if (opts.expand) {
    enhanceLines.push('- 请基于用户设定补充更多合理、自洽的世界细节（如地理环境、势力派系、规则制度、风土人情、历史背景等），让世界更丰富完整，但不得与用户已有设定相矛盾。')
  }
  const enhanceText = enhanceLines.length > 0 ? `\n${enhanceLines.join('\n')}` : ''
  const wsm = worldSettingMax && worldSettingMax > 0 ? worldSettingMax : 3000
  return `你是文字冒险世界的设定设计师。用户希望创建一个新世界，下面是用户给出的内容：
<用户输入>
${userInput}
</用户输入>

用户的输入可能非常长。请把它整理成两份互补的材料：一份精简的「核心设定」供每轮常驻，一份「世界书条目」保存全部详细设定供按需注入，确保信息不丢失。

请完成三件事：
1. 提炼精简的「核心设定」（worldSetting）：包含世界观铁律、不可违背的规则、全局框架与叙事基调。精简凝练，不超过 ${wsm} 字，只保留每轮必须牢记的硬约束与骨架。若内容超出上限，须精简核心设定，将多余部分拆入世界书条目（可新建条目存放）。${enhanceText}
2. 把完整、详细的设定拆分到一个一个「世界书条目」（lorebook）中：每个条目聚焦一个主题（某地点、组织、人物、物品、规则、种族、地域等），用 tags 标注其适用的场景与主题（如"山脉""都城""鹰族""禁咒"），并将最重要的全局规则标注 required:true（每轮必需，注意控制数量避免上下文过长）。详细内容必须完整保留在条目中，条目数量不限，总量可以很大。
   - 不会随剧情改变的底层设定（如世界物理法则、魔法体系根本规则、地理常识）应标注 fixed:true，防止后续剧情推进时被误改。
   - 当某条目在剧情中被引用时，若需要另一条目作为补充上下文（如"鹰族"条目需要"天空之城"条目），请在 links 中填入关联条目的标题（字符串数组），系统会在注入本条目时一并注入关联条目（仅展开一层）。
3. 为这个世界设计「角色面板字段」清单（panelSchema）：冒险中需要持续追踪的角色状态（位置、时间、HP、状态、技能等），每字段给出英文 key、中文含义、类型（text/number）和可选单位。

请只输出一个 JSON 对象，结构如下，不得输出 JSON 之外的任何文字：
{
  "worldSetting": "精简的核心设定文本",
  "lorebook": [ { "title": "条目标题", "tags": ["标签","标签"], "content": "详细设定正文", "required": true, "fixed": false, "links": ["关联条目标题"] } ],
  "panelSchema": [ { "key": "英文键名", "label": "中文含义", "type": "text或number", "unit": "可选单位或省略" } ]
}`
}

// 精细化背包描述规则（enabled 时返回额外要求，否则返回空串）
export function bagDetailRule(enabled: boolean): string {
  if (!enabled) return ''
  return `

# 物品精细描述要求（已开启）
- 对 inventory.equipment 与 inventory.items 中的每一件物品，state 字段必须填写详细、具体的描述：包括材质、外观、磨损/品相、剩余数量（如适用）、来历或用途等，让玩家仅凭描述就能想象出这件物品。
- 每件物品的 state 描述须具体，避免"还好""完好""普通"这类笼统词。
- 新增或获得物品时务必给出精细描述；已有物品应根据使用痕迹与剧情进展持续更新、丰富其描述。`
}

// 根据"上下文文本"挑出本轮该注入的世界书条目并组装注入区文本；无世界书时返回空串
// sceneValue：当前场景值（如 panel[sceneField]），tags 与场景值精确相等优先，其次双向包含
// 上下文匹配：标签在上下文中出现的次数越多相关度越高（次数加权）
export function buildLoreInjection(world: World, context: string, sceneValue?: string, activeNames?: string[], cfg?: LoreInjectionConfig): string {
  const entries = world.lorebook ?? []
  if (entries.length === 0) return ''
  const scene = (sceneValue ?? '').trim()
  const ctx = context || ''
  const loreBudget = cfg?.loreBudget && cfg.loreBudget > 0 ? cfg.loreBudget : LORE_BUDGET
  const scored: Array<{ e: LoreEntry; rank: number }> = []
  for (const e of entries) {
    const content = (e.content ?? '').trim()
    if (!content) continue
    const tags = Array.isArray(e.tags) ? e.tags.filter((t) => typeof t === 'string' && t.trim()) : []
    const aliases = Array.isArray(e.aliases) ? e.aliases.filter((t) => typeof t === 'string' && t.trim()) : []
    // 匹配键 = 标签 + 别名：别名同样参与检索，确保改名后仍能被旧称呼命中
    const keys = [...tags, ...aliases]
    let rank: number
    if (e.required) {
      rank = 0 // 必需
    } else if (scene) {
      const exact = keys.some((t) => t.trim() === scene)
      let broad = false
      if (!exact) {
        for (const t of keys) {
          const tag = t.trim()
          if (tag && tag !== scene && (scene.includes(tag) || tag.includes(scene))) {
            broad = true
            break
          }
        }
      }
      if (exact) rank = 1 // 场景精确匹配
      else if (broad) rank = 1.5 // 场景双向包含（如场景"幽暗森林"命中标签"森林"）
      else rank = tagHitRank(ctx, keys) // 场景不命中，回退到上下文匹配
    } else {
      rank = tagHitRank(ctx, keys) // 无场景值，仅做上下文匹配
    }
    scored.push({ e, rank })
  }
  scored.sort((a, b) => a.rank - b.rank)
  let used = 0
  const picked: LoreEntry[] = []
  const pickedIds = new Set<string>()
  // 必需条目必须全部带入，不受预算限制
  const requiredEntries = scored.filter((s) => s.e.required)
  for (const s of requiredEntries) {
    picked.push(s.e)
    pickedIds.add(s.e.id)
    used += s.e.content.length
  }
  // activeNames 对应的条目强制注入（当前交互的地点/人物）
  if (activeNames && activeNames.length > 0) {
    const activeSet = new Set(activeNames.map((n) => n.trim()).filter((n) => !!n))
    for (const s of scored) {
      if (pickedIds.has(s.e.id)) continue
      const names = [s.e.title ?? '', ...(s.e.aliases ?? [])].map((n) => n.trim()).filter((n) => !!n)
      if (names.some((n) => activeSet.has(n))) {
        picked.push(s.e)
        pickedIds.add(s.e.id)
        used += s.e.content.length
      }
    }
  }
  // 其余条目按相关度填充剩余预算（数量受世界书最大匹配条目数限制）
  const loreLimit = cfg?.loreLimit && cfg.loreLimit > 0 ? Math.floor(cfg.loreLimit) : DEFAULT_LORE_LIMIT
  for (const s of scored) {
    if (s.e.required) continue
    if (pickedIds.has(s.e.id)) continue
    if (picked.length >= loreLimit) break
    const size = s.e.content.length
    if (used + size > loreBudget) continue
    picked.push(s.e)
    pickedIds.add(s.e.id)
    used += size
  }
  // 关联条目展开（仅一层）：对已选中的条目，按 links（标题）找到对应条目并注入，受预算限制
  const byTitle = new Map<string, LoreEntry>()
  for (const e of entries) {
    const t = (e.title ?? '').trim()
    if (t) byTitle.set(t, e)
  }
  const linkBudget = cfg?.linkBudget && cfg.linkBudget >= 0 ? Math.min(cfg.linkBudget, loreBudget) : Math.min(2000, loreBudget) // 关联条目额外预算上限
  let linkUsed = 0
  const basePicked = [...picked]
  for (const p of basePicked) {
    const links = Array.isArray(p.links) ? p.links : []
    for (const linkTitle of links) {
      const target = byTitle.get(linkTitle.trim())
      if (!target || pickedIds.has(target.id)) continue
      const size = target.content.length
      if (linkUsed + size > linkBudget) continue
      picked.push(target)
      pickedIds.add(target.id)
      linkUsed += size
    }
  }
  if (picked.length === 0) return ''
  const lines = picked.map((e) => {
    const head = e.title && e.title.trim() ? `【${e.title.trim()}】` : ''
    const tags = Array.isArray(e.tags) && e.tags.length ? `（标签：${e.tags.join('、')}）` : ''
    const aliasList = Array.isArray(e.aliases) ? e.aliases.filter((a) => typeof a === 'string' && a.trim()) : []
    const aliasStr = aliasList.length ? `（别名：${aliasList.join('、')}）` : ''
    const flags: string[] = []
    if (e.required) flags.push('必需')
    if (e.fixed) flags.push('固定')
    if (e.hidden) flags.push('隐藏·彩蛋')
    const flagStr = flags.length ? `（${flags.join('；')}）` : ''
    return `- ${head}${flagStr}${tags}${aliasStr}\n  ${e.content.trim()}`
  })
  return `

# 世界书（当前生效的详细设定）
以下条目为这个世界具体的扩展设定。你必须严格遵守；优先级：核心设定 ≥ 世界书条目 > 玩家临时行动。

${lines.join('\n')}

# 世界书使用规则
- 世界书条目必须与存档（overview、inventory、activeLocations、activeCharacters 等）保持一致，不得互相矛盾；若剧情推进改变了条目描述的事物，应通过 loreUpdates 同步更新该条目。
- 若玩家指令与某世界书设定冲突：不要拒绝玩家，也不得歪曲或悄悄改写设定来迎合玩家；应当推断"在该设定约束下，玩家行动会产生的合理、自然后果"并如实呈现。例如：石碑被设定为不可破坏，玩家执意挥锤猛砸，则锤柄崩裂、虎口震麻，石碑纹丝不动。
- 地点与人物信息全部通过世界书条目存储：每个地点对应一个 isLocation:true 条目，每个人物对应一个 isCharacter:true 条目。条目 title 用地点名/人名，content 记录详细情况（地点描述、人物介绍与态度、记忆与关系变化等）。不要在存档 map/characters 中存储这些信息（始终保持空数组）。
  - 地点条目的 tags 应包含该地点可能出现的人物名字、地点别名、相关势力/组织等，以便人物在场时能命中注入。
  - 人物条目的 tags 应包含其所在地点的名字、人物别名、身份/职业等关联信息，以便玩家到达该地点或提及相关话题时能命中注入。
  - 会四处游走的人物（如旅行商人、游侠）：tags 不要只写固定地点，而应包含其活动范围、身份特征（如"旅行商人""游侠"）、可能出现的场所类型等，让其在合适的情境自然命中而非绑定单一地点。
- 去重与禁止重建规则：创建任何新条目前，必须先检查世界书中是否已有同名、别名或名称相似的条目（包括已标注"【已死亡】""【已损毁】"等终态的条目）；若有则更新该条目，绝不新建。曾出现在剧情中或已存在于世界书的实体（地点/人物/物品/概念），无论当前是否已终结，都不得重新创建新条目——即使它已死亡、被摧毁或已结束。玩家再次触及已终结实体（凭吊亡者、拾取遗物、路过废墟、提及往事）时，应复用原条目并更新，而非新建。同一地点/人物/物品只能有一个对应条目。
- 条目 title/tags 可编辑（非 fixed 条目）：通过 loreUpdates 可修改已有条目的 title（实体改名、纠正标题）与 tags（随剧情增减关联人物/地点/身份/别名等）。发现同一实体存在多个不同标题的条目时，应主动合并到先建立的那条上（对齐 title、把冗余 title 并入 aliases、remove 多余条目）；aliases 是匹配兜底，优先靠改名让 title 保持统一。
- 别名与改名：当同一实体的称呼发生变化（如"神秘人"揭示身份为"阿尔萨斯"），不要新建条目，而应更新原条目：把 title 改为当前正式名称或主要称呼，并把旧称呼写入 aliases（字符串数组）。若该实体出现在存档 activeLocations/activeCharacters 中，改名时须一并把其中的旧称呼替换为新名称。新增条目前的查重必须同时比对 title 与 aliases，任一命中即视为同一条目，应更新而非新建。
- 同义条目合并：每轮输出 loreUpdates 时，检查当前生效（上下文中已列出）的世界书条目，若发现其中两条以上指向同一实体（如揭示身份前后的不同称呼、同一事物的不同叫法），必须合并——保留信息最完整的一条（把其它条目的有效内容并入其中），将其余条目的标题并入保留条目的 aliases，并对多余条目返回 { "title": "多余条目标题", "remove": true } 删除。
- 存档 activeLocations 维护：当前所在的地点排最前，正在前往的目的地次之；已离开且暂时不会返回的地点移出；将要前往或计划回去的地点保留或加入。activeCharacters 维护同理：本轮接触的人物排最前，越久未见的越靠后；已分别且暂时不会再见面的人物移出，将要见面或近期重逢的人物保留或加入。
- 仅露一面、无后续影响的龙套路人不必记录为世界书条目——若玩家日后寻找一个世界书中不存在的人或地点，应如实呈现"找不到"，而非凭空捏造。
- 若剧情中出现了值得长期记录的新概念、新地点、新人物或新事物（世界书尚未记载、且对后续剧情有持续影响），请通过输出格式中的 loreUpdates 字段返回新增或更新条目（保留必要的 title/tags/content/required/isLocation/isCharacter），不要记录琐碎、一次性或不重要的细节。
- 终态标注（重要）：当条目对应的事物已经死亡、被摧毁、被损毁、已完成或永久失效时，必须保留该条目、切勿删除；将条目 content 改写为终态描述并在开头加上状态前缀（如"【已死亡】""【已摧毁】""【已损毁】""【已完成】"），再通过 loreUpdates 更新该条目。
- 删除条目（仅限两种情形）：只有当条目属于"完全重复（与另一条内容重复）"或"记录错误（本不该存在、与剧情矛盾）"时，才可通过 loreUpdates 返回 { "title": "条目标题", "remove": true } 删除；只需 title 匹配即可，无需其他字段。fixed 条目（底层设定）不可删除。除此之外的任何"死亡/摧毁/损毁/结束"都不得使用删除，必须改为终态标注。
- 当玩家到达某地点或接触某人物时，在该条目的 lastVisitedTime 字段记录当前 worldTime（冒险时间快照）。当玩家时隔较久重返旧地点或重遇旧人物时，先对比当前 worldTime 与条目 lastVisitedTime 判断时间流逝程度，据此对该世界书条目做合理演化——地点可能兴衰变化、人物可能因独立日程而离开或改变，不会停在原地等待——再据此读取与呈现；演化结果与新的 lastVisitedTime 同时通过 loreUpdates 更新到世界书。
- 标注"隐藏·彩蛋"的条目是尚未出场的彩蛋角色/设定：不要主动让该角色出场，只在剧情自然发展遇到合理条件时（如旅途偶遇、城镇擦肩、任务交集）才让她出场；出场后通过 loreUpdates 更新该条目并移除 hidden 标记（在返回的条目中设 hidden 为 false 或省略），此后按普通世界书条目处理。
- 标注"固定"的条目是不可更改的底层设定：不得通过 loreUpdates 修改或删除固定条目的 title/tags/content/fixed/links，可以在该条目描述的框架内展开剧情。
- isLocation/isCharacter 标记由 AI 根据条目内容类型自动打上，不需要玩家编辑；地点条目打 isLocation:true，人物条目打 isCharacter:true，其他类型条目不打。
- loreUpdates 仅在确实有更新时返回，否则返回空数组 []。`
}

// 上下文标签匹配：统计每个标签在上下文中出现的次数，命中次数越多 rank 越小（越靠前）；
// 未命中返回 3（默认档）
function tagHitRank(ctx: string, tags: string[]): number {
  let hitCount = 0
  for (const t of tags) {
    const tag = t.trim()
    if (!tag || !ctx.includes(tag)) continue
    hitCount++
    let count = 0
    let p = 0
    while ((p = ctx.indexOf(tag, p)) !== -1) {
      count++
      p += tag.length
      if (count >= 3) break
    }
    if (count > 1) hitCount += Math.min(count - 1, 2)
  }
  if (hitCount > 0) return 2 - Math.min(hitCount, 3) * 0.1
  return 3
}

// 生成"角色设定 + 初始存档"（开始冒险）
export function buildCharacterGenPrompt(
  world: World,
  userInput: string,
  narrationMin: number,
  narrationMax: number,
  opts: { summarize?: boolean; expand?: boolean } = {},
  hiddenPreset?: string,
  loreCfg?: LoreInjectionConfig,
): string {
  const lines: string[] = []
  if (!opts.summarize && !opts.expand) {
    lines.push('- 请尽量忠实于玩家提供的角色描述进行整理（总结角色设定 characterProfile），不额外编造新的背景、能力、关系或物品。')
  }
  if (opts.summarize) {
    lines.push('- 请总结并优化玩家提供的角色描述：提炼核心人设与独特之处，去除冗余、含糊表达，使角色设定更清晰、逻辑更一致。')
  }
  if (opts.expand) {
    lines.push('- 请基于玩家描述补充更多合理、自洽的角色细节（如性格、习惯、动机、过往经历等），让角色更饱满立体，但不得与玩家已有描述相矛盾。')
  }
  lines.push('- 请把玩家提供的角色描述拆成两部分写入存档：characterProfile 记录稳定的人设背景（出身、性格、外貌、信念等），experience 记录角色与此前经历相关的概述；两者分开维护，后续剧情中 experience 持续演进，characterProfile 保持稳定。')
  lines.push('- 角色面板字段可根据设定的合理暗示推测填充（如描述提及"剑客"可推测有武器、擅长战斗），但不得编造设定中未暗示的具体物品名称、人物关系等。')
  lines.push('- 初始存档其余字段（inventory、map、characters 等）只填入与角色描述/世界设定直接相符的内容，未提及的方面用中性默认值补充（如空背包、起始位置）。')
  lines.push('- 生成开场叙事（第一幕场景）+ 2-3 个可选行动方向，并生成完整初始存档。')
  lines.push('- 玩家在这次描述中可能引入新的初始设定（世界设定之外的补充）。若与后续剧情相关、值得长期保留，请通过输出格式中的 loreUpdates 更新世界书（新增或更新条目）；不要遗漏值得保留的设定，也不要记录琐碎、一次性细节。')
  lines.push('- 若玩家描述过于单薄（缺少姓名、外形、出身、性格、动机等关键信息），第一轮不要直接展开剧情：在 narration 中友善地列出需要补充的信息（如"你还想给角色起个什么名字？""说说看，你为什么踏上这趟旅程？"），options 给出补充方向建议，同时生成初步存档（缺失处用中性默认值，characterProfile 记录已提供部分并标注待补充项）。玩家在下一轮输入补充后，再正式拉开序幕。')
  const constraint = lines.join('\n')
  const lorePart = buildLoreInjection(world, userInput, undefined, undefined, loreCfg)
  const fallbackPart = world.characterFallback && world.characterFallback.trim()
    ? `\n\n【角色来源兜底（仅本次创建角色时适用，不写入后续剧情）】\n${world.characterFallback.trim()}`
    : ''
  const hiddenPart = hiddenPreset && hiddenPreset.trim()
    ? `\n\n【隐藏设定（玩家不可见，仅你知晓）】\n${hiddenPreset.trim()}\n请严格依据此隐藏设定生成初始存档（如填入对应面板字段、技能、物品等），但在 narration 中不得直接暴露或提及这段设定的存在，让玩家在后续剧情中自然发现。`
    : ''
  return `【世界设定】
${world.worldSetting}${fallbackPart}
${lorePart}

【角色面板字段】
${panelSchemaToText(world.panelSchema)}

${buildOutputFormat(narrationMin, narrationMax)}

【当前存档（初始为空）】
{
  "panel": { 各字段按角色面板字段清单，type=number 填 0，type=text 填 "" },
  "inventory": { "equipment": [], "items": [] },
  "map": [],
  "characters": [],
  "characterProfile": "",
  "experience": "",
  "overview": { "impression": "", "ongoing": "", "recentEvents": [], "latestProgress": "" },
  "hidden": {},
  "worldTime": "冒险开始的时刻，如'启程第1天·某季节·某时段'"
}

【玩家创建的角色描述】
${userInput}${hiddenPart}

${constraint}`
}

// 生成"行动"（冒险主循环）
// 仅包含每次变化的内容：世界书注入、上一轮剧情、当前存档、玩家行动
// 稳定内容（世界设定、面板字段、输出格式、存档结构、背包规则）已移至 system prompt
// 递归移除空值（空数组/空字符串/空对象/undefined），用于生成紧凑 JSON 以压缩上下文体积
function compactJson(v: unknown): unknown {
  if (Array.isArray(v)) {
    const arr = v.map(compactJson)
    return arr.filter(
      (x) => x !== undefined && !(typeof x === 'string' && x === '') &&
        !(Array.isArray(x) && x.length === 0) &&
        !(x !== null && typeof x === 'object' && !Array.isArray(x) && Object.keys(x as object).length === 0),
    )
  }
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      const c = compactJson(val)
      if (c === undefined) continue
      if (typeof c === 'string' && c === '') continue
      if (Array.isArray(c) && c.length === 0) continue
      if (c !== null && typeof c === 'object' && !Array.isArray(c) && Object.keys(c as object).length === 0) continue
      out[k] = c
    }
    return out
  }
  return v
}

function stringifyCompact(v: unknown): string {
  return JSON.stringify(compactJson(v))
}

export function buildActionPrompt(
  world: World,
  currentSave: SaveData,
  userInput: string,
  lastNarration?: string,
  narrativeSpeed?: NarrativeSpeed,
  rules?: AdventureRules,
  loreCfg?: LoreInjectionConfig,
): string {
  const lastPart = lastNarration ? `【上一轮剧情供衔接参考】\n${lastNarration}\n\n` : ''
  const activeNames = [
    ...(currentSave.activeLocations ?? []),
    ...(currentSave.activeCharacters ?? []),
  ]
  const context = [
    userInput,
    lastNarration ?? '',
    ...Object.values(currentSave.panel).map((v) => String(v)),
    currentSave.characterProfile,
    currentSave.experience,
    currentSave.overview.impression,
    currentSave.overview.ongoing,
    ...activeNames,
    ...currentSave.map.map((m) => m.name),
    ...currentSave.characters.map((c) => c.name),
  ].join(' ')
  const lorePart = buildLoreInjection(
    world,
    context,
    world.sceneField ? String(currentSave.panel[world.sceneField] ?? '') : undefined,
    activeNames,
    loreCfg,
  )
  const speedPart = narrativeSpeedRule(narrativeSpeed ?? 'normal')
  const speedText = speedPart ? `\n\n${speedPart}` : ''
  const rulesPart = buildAdventureRulesPart(rules)
  return `${lorePart}

${lastPart}【当前存档（已是最新状态，须据此推进剧情并输出存档变化）】
${stringifyCompact(currentSave)}

# 角色开场判定
若当前存档表明角色尚未正式开场（characterProfile 极简或标注待补充、name/race 等关键字段为空或默认值、overview.impression 显示待补充等），本轮「玩家行动」应理解为「对角色设定的补充」而非正式行动：据此完善 characterProfile 与面板字段，然后生成正式的开场叙事并拉开序幕；若信息仍不足，继续友善追问需要补充的内容，不强行开始剧情。

【玩家行动】
${userInput}${speedText}${rulesPart}`
}

// 系统消息（行动场景用到）
// world 和 detailedBag 传入时，将稳定内容（世界设定、面板字段、背包规则）纳入 system 作为可缓存前缀
export function buildActionSystemPrompt(
  narrationMin: number,
  narrationMax: number,
  world?: World,
  detailedBag?: boolean,
  usePatch = false,
): string {
  let s = `${buildGlobalRules(narrationMin, narrationMax)}\n\n${buildOutputFormat(narrationMin, narrationMax, usePatch)}\n\n${SAVE_SCHEMA_DESC}`
  if (detailedBag) {
    const r = bagDetailRule(true)
    if (r) s += `\n${r}`
  }
  if (world) {
    s += `\n\n【世界设定】\n${world.worldSetting}\n\n【角色面板字段】\n${panelSchemaToText(world.panelSchema)}`
  }
  return s
}
// ===== 输出截断后的自动降级重试 Prompt =====
// 统一组装"世界书注入 + 上一轮剧情 + 当前存档 + 玩家行动"片段，供恢复请求复用
function buildActionRecoveryBase(
  world: World,
  currentSave: SaveData,
  userInput: string,
  lastNarration: string | undefined,
  includeSave: boolean,
  loreCfg?: LoreInjectionConfig,
): string {
  const activeNames = [
    ...(currentSave.activeLocations ?? []),
    ...(currentSave.activeCharacters ?? []),
  ]
  const context = [
    userInput,
    lastNarration ?? '',
    ...Object.values(currentSave.panel).map((v) => String(v)),
    currentSave.characterProfile,
    currentSave.experience,
    currentSave.overview.impression,
    currentSave.overview.ongoing,
    ...activeNames,
    ...currentSave.map.map((m) => m.name),
    ...currentSave.characters.map((c) => c.name),
  ].join(' ')
  const lorePart = buildLoreInjection(
    world,
    context,
    world.sceneField ? String(currentSave.panel[world.sceneField] ?? '') : undefined,
    activeNames,
    loreCfg,
  )
  const lastPart = lastNarration ? `【上一轮剧情供衔接参考】\n${lastNarration}\n\n` : ''
  const savePart = includeSave
    ? `${lastPart}【当前存档（须据此推进剧情并输出存档变化）】\n${stringifyCompact(currentSave)}\n\n`
    : lastPart
  return `${lorePart}\n\n${savePart}【玩家行动】\n${userInput}`
}

// JSON 语法硬性要求（截断恢复专用，简短版）
const RECOVERY_JSON_RULE = `JSON 语法硬性要求（违反任一条都会解析失败）：
- 键名与字符串值一律用英文双引号；字符串内换行写成 \\n，英文双引号写成 \\"。
- 不要单引号、中文引号、注释（//、/* */）、尾逗号。
- 不要截断 JSON：宁可把 narration 写短，也必须保证 JSON 完整闭合，只输出一个 JSON 对象且不加任何其他文字。`

// split 模式第 1 次：生成叙事 + 选项 + 存档 diff（patchSave）
// 理由：存档已小，截断主因是世界书大量修改；将存档 diff 与世界书更新分到不同请求
export function buildActionRecoverySplitNarrationPrompt(
  world: World,
  currentSave: SaveData,
  userInput: string,
  lastNarration: string | undefined,
  narrativeSpeed: NarrativeSpeed | undefined,
  rules?: AdventureRules,
  loreCfg?: LoreInjectionConfig,
): string {
  const speedPart = narrativeSpeed === 'fast' || narrativeSpeed === 'rapid'
    ? `\n- 叙事推进速度${narrativeSpeed === 'rapid' ? '·极速' : '·快速'}：省略过程细节，直接推进主线关键节点。`
    : ''
  const rulesPart = buildAdventureRulesPart(rules)
  return `上一轮输出因过长被截断，本轮拆成两次独立生成。这是第 1 次，你只输出一个 JSON 对象：
{
  "narration": "本轮剧情推进的叙事（精简但完整）",
  "options": ["参考选项1", "参考选项2", "参考选项3"],
  "patchSave": { ...只列发生变化的字段，见 patchSave 格式说明... }
}
不要输出 loreUpdates 字段。

${buildActionRecoveryBase(world, currentSave, userInput, lastNarration, true, loreCfg)}

${RECOVERY_JSON_RULE}${speedPart}${rulesPart}`
}

// split 模式第 2 次：基于第 1 次生成的叙事，只输出世界书更新（loreUpdates）
// 已死亡/摧毁/损毁/完成的条目保留并改写为终态（正文加"【已死亡】"等前缀），仅完全重复/记录错误的条目才用 remove 删除
export function buildActionRecoverySplitSavePrompt(
  world: World,
  currentSave: SaveData,
  narrationText: string,
  userInput: string,
  loreCfg?: LoreInjectionConfig,
): string {
  return `上一轮输出因过长被截断，本轮拆成两次独立生成。第 1 次已生成叙事与存档变化，这是第 2 次，你只输出一个 JSON 对象：
{
  "loreUpdates": [
    { "title": "条目标题", "aliases": ["别名", "曾用称呼"], "tags": ["标签"], "content": "正文", "required": false, "fixed": false, "links": ["关联条目标题"] },
    { "title": "已死亡/损毁的条目", "content": "【已死亡】……（保留条目并改写为终态，切勿删除）" },
    { "title": "重复或误记的条目", "remove": true }
  ]
}
不要输出 narration、options 或 patchSave 字段。

【loreUpdates 规则】
- 新增/更新条目：按正常格式返回（title + aliases + tags + content + ...）
- 终态标注：事物死亡/摧毁/损毁/完结时，保留条目并把 content 改写为终态（开头加"【已死亡】""【已损毁】"等前缀），切勿删除
- 禁止重建：曾出现过的实体（含已终结的）不得新建条目，必须先查重并复用原条目
- 别名与合并：实体改名时更新原条目（title 改新名、旧称呼写入 aliases），不得新建；发现当前生效条目中有指向同一实体的重复条目时，合并为一条（其余标题并入 aliases 后 remove）
- 删除条目：仅当条目完全重复或记录错误时，才返回 { "title": "条目标题", "remove": true }（fixed 条目不可删除）

【本轮实际发生的剧情（第 1 次生成结果，据此输出世界书变化）】
${narrationText}

${buildActionRecoveryBase(world, currentSave, userInput, narrationText, false, loreCfg)}

${RECOVERY_JSON_RULE}`
}
// 改写同步：玩家手动改写了最新一页的叙事，AI 据此修正存档与世界书（以改写版为准）
export function buildRewriteSyncPrompt(

  world: World,
  currentSave: SaveData,
  page: StoryPage,
  loreCfg?: LoreInjectionConfig,
): string {
  const activeNames = [
    ...(currentSave.activeLocations ?? []),
    ...(currentSave.activeCharacters ?? []),
  ]
  const context = [
    page.playerInput,
    page.narration,
    ...Object.values(currentSave.panel).map((v) => String(v)),
    currentSave.characterProfile,
    currentSave.experience,
    currentSave.overview.impression,
    currentSave.overview.ongoing,
    ...activeNames,
    ...currentSave.map.map((m) => m.name),
    ...currentSave.characters.map((c) => c.name),
  ].join(' ')
  const lorePart = buildLoreInjection(
    world,
    context,
    world.sceneField ? String(currentSave.panel[world.sceneField] ?? '') : undefined,
    activeNames,
    loreCfg,
  )
  return `${lorePart}

【改写同步（高优先级指令，务必执行）】
玩家手动改写了上一轮生成的叙事。请基于【改写后的叙事】检查当前存档与世界书，凡与改写内容存在矛盾、或改写引入的合理新情况尚未记录的地方，一律修正；以玩家改写版为唯一事实来源，不得试图恢复成改写前的说法。
- 世界书：有需要同步的条目标题/内容变化时，通过 loreUpdates 返回更新（未变化则返回空数组 []）。事物死亡/摧毁/损毁/完结时，保留条目并把 content 改写为终态（开头加"【已死亡】"等前缀），切勿删除；仅当条目完全重复或记录错误时才返回 { "title": "条目标题", "remove": true }。
- 存档：仅返回需要修改的字段（patch 语义，未列出的字段保持原样；inventory 按物品名增量更新——只列新增/变化的物品，未列出的保留，删除用 "remove": true；map / characters 已废弃始终省略；hidden 用 { "add": {...}, "remove": [...] } 表达增量）。
- 若改写内容与既有设定冲突，以改写内容为准，并相应调整设定描述使其自洽；若改写内容不影响任何数据，save 返回空对象 {}，loreUpdates 返回 []。
- 不要输出 narration 或 options 字段。

【上一轮的玩家行动】
${page.playerInput}

【改写后的叙事（以这个为准）】
${page.narration}

【当前存档】
${stringifyCompact(currentSave)}

JSON 语法硬性要求：键名与字符串值一律用英文双引号；字符串内换行写成 \\n；不要注释、尾逗号；只输出一个 JSON 对象。

{
  "save": { ...仅列出需要修改的字段（patch 语义）... },
  "loreUpdates": [ { "title": ..., "aliases": [...], "tags": [...], "content": ..., "required": false, "fixed": false, "links": [...] }, { "title": "重复或误记的条目", "remove": true } ]
}`
}
// 选项补全：AI 未正常生成选项时，基于本页叙事补 3 个选项
export function buildOptionsFallbackPrompt(narration: string): string {
  return `你是文字冒险游戏的叙事引擎。上一轮的叙事已经生成，但可执行的下一步行动选项缺失或不足。请基于以下叙事，生成 3 个自然、可执行的下一步行动方向。

只输出一个 JSON 对象，不要输出任何其他文字：
{
  "options": ["选项1", "选项2", "选项3"]
}

要求：
- 选项必须是玩家可以执行的具体行动，简短（5-15 字），第二人称视角。
- 选项应基于叙事中当前情境自然延伸，不要凭空捏造叙事中不存在的元素。
- 3 个选项应提供不同的行动方向（如推进主线、探索环境、检查状态等）。

【本轮叙事】
${narration}`
}