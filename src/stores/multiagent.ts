import { defineStore } from 'pinia'
import {
  getMaState,
  putMaState,
  deleteMaState,
  listAgents,
  putAgent,
  deleteAgent,
  listMessages,
  putMessage,
  replaceMessages,
} from '@/db'
import { createId, NARRATOR_ID, PLAYER_ID, CROWD_ID } from '@/types'
import type { MaState, AgentState, StoryMessage, World, LoreEntry, Secret } from '@/types'
import {
  generateDirector,
  generateNpcSpeech,
  generatePlayerOptions,
  generateNarration,
  generateCrowd,
  compressAgentMemory,
  compressAgentPersona,
} from '@/ai/agents'
import { buildLoreInjection, buildMaNarratorRules, buildMaActorDetailRule } from '@/ai/prompts'
import { normalizeLorebook } from '@/ai/service'
import { mergeLoreUpdates } from '@/utils/lore'
import { compressDualEntries } from '@/ai/loreCompress'
import { parseSpecialCommands, addBanned, tickBanned, bannedPrompt, purgeInstruction, onceInstruction } from '@/utils/commands'
import { errorMessage } from '@/ai/client'
import { useWorldStore } from './world'
import { useSettingsStore } from './settings'

const DAY_MINUTES = 1440

// 世界时钟 → 展示文本（仅多智能体模式使用，普通模式仍用 SaveData.worldTime）
export function clockText(day: number, minute: number): string {
  const h = Math.floor(minute / 60)
  const phase =
    h < 5 ? '凌晨' : h < 8 ? '清晨' : h < 11 ? '上午' : h < 13 ? '正午' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '夜晚' : '深夜'
  return `第 ${day} 天 · ${phase}`
}

// 多智能体运行状态与角色状态的容器。
// 约定：AgentState 存在 === 该角色已被分配为独立智能体。
// 旁白与玩家角色各自始终有一条 AgentState（charId 为保留值）。

export interface DispatchResult {
  next: string
  focus?: string
  presence?: string[]
  combatStart?: boolean
  combatEnd?: boolean
}

export function createDefaultMaState(worldId: string): MaState {
  const now = Date.now()
  return {
    worldId,
    clockDay: 1,
    clockMinute: 8 * 60,
    beat: 0,
    narratorIdle: 0,
    lastSpeakerId: null,
    presence: [],
    sceneState: '',
    sceneAsOfSeq: 0,
    secrets: [],
    digestSeq: 0,
    storySummary: '',
    autoAdvanceLeft: 0,
    createdAt: now,
    updatedAt: now,
  }
}

function createAgent(worldId: string, charId: string, name: string, opts: Partial<AgentState> = {}): AgentState {
  return {
    worldId,
    charId,
    name,
    privatePersona: '',
    memory: '',
    rev: 1,
    updatedAt: Date.now(),
    ...opts,
  }
}

export const useMaStore = defineStore('multiagent', {
  state: () => ({
    worldId: null as string | null,
    ma: null as MaState | null,
    agents: [] as AgentState[],
    messages: [] as StoryMessage[],
    loading: false,
    turnLoading: false,
    error: null as string | null,
    pendingPlayer: false, // 当前是否轮到玩家（显示选项、等待输入）
    currentOptions: [] as string[],
    beatsDone: 0,
    beatsTotal: 0,
    pendingOnce: '', // 本次提交的一次性指令指示（跳过/换场/回顾），用完即清
  }),
  getters: {
    isActive(state): boolean {
      return state.worldId !== null && state.ma !== null
    },
    narrator(state): AgentState | null {
      return state.agents.find((a) => a.charId === NARRATOR_ID) ?? null
    },
    player(state): AgentState | null {
      return state.agents.find((a) => a.charId === PLAYER_ID) ?? null
    },
    // 已分配为独立智能体的 NPC（不含旁白/玩家）
    npcs(state): AgentState[] {
      return state.agents.filter((a) => a.charId !== NARRATOR_ID && a.charId !== PLAYER_ID)
    },
    agentOf(state) {
      return (charId: string): AgentState | null => state.agents.find((a) => a.charId === charId) ?? null
    },
  },
  actions: {
    async open(worldId: string) {
      if (this.worldId === worldId && this.ma) return
      this.loading = true
      try {
        let ma = await getMaState(worldId)
        if (!ma) {
          ma = createDefaultMaState(worldId)
          await putMaState(ma)
        }
        if (this.worldId !== worldId && this.worldId !== null) {
          // 切换世界：先清空旧状态
          this.agents = []
          this.messages = []
        }
        this.worldId = worldId
        this.ma = ma
        this.agents = await listAgents(worldId)
        this.messages = await listMessages(worldId)
        await this.ensureSystemAgents()
        // 条目改名后让 agent.name 跟随（世界书是名字的唯一来源）
        const world = useWorldStore().currentWorld
        if (world && world.id === worldId) await this.syncRoster(world)
        // 首次进入：默认所有已分配 NPC 都在场
        if (this.ma && this.ma.presence.length === 0) {
          const ids = this.agents
            .filter((a) => a.charId !== NARRATOR_ID && a.charId !== PLAYER_ID)
            .map((a) => a.charId)
          if (ids.length > 0) {
            this.ma.presence = ids
            await putMaState({ ...this.ma })
          }
        }
      } finally {
        this.loading = false
      }
    },

    // 旁白与玩家角色的 AgentState 始终存在
    async ensureSystemAgents() {
      const worldId = this.worldId
      if (!worldId) return
      if (!this.agents.some((a) => a.charId === NARRATOR_ID)) {
        const a = createAgent(worldId, NARRATOR_ID, '旁白', { isNarrator: true, present: true })
        await putAgent(a)
        this.agents.push(a)
      }
      if (!this.agents.some((a) => a.charId === PLAYER_ID)) {
        const a = createAgent(worldId, PLAYER_ID, '你', { isPlayer: true, present: true })
        await putAgent(a)
        this.agents.push(a)
      }
    },

    // 从世界书同步角色名册：为已分配的 NPC 补齐名称（条目改名后跟随）
    async syncRoster(world: World) {
      const worldId = this.worldId
      if (!worldId) return
      const chars = (world.lorebook ?? []).filter((e): e is LoreEntry => e.isCharacter === true)
      const byId = new Map(chars.map((c) => [c.id, c]))
      for (const a of this.agents) {
        if (a.charId === NARRATOR_ID || a.charId === PLAYER_ID) continue
        const entry = byId.get(a.charId)
        if (!entry) continue
        const name = (entry.title ?? '').trim() || a.name
        if (name !== a.name) {
          a.name = name
          await putAgent(a)
        }
      }
    },

    // 分配为独立智能体：以世界书里的 persona/memory 作为初始值
    async assign(entry: LoreEntry) {
      const worldId = this.worldId
      if (!worldId) return
      if (this.agents.some((a) => a.charId === entry.id)) return
      const name = (entry.title ?? '').trim() || '无名者'
      const agent = createAgent(worldId, entry.id, name, {
        privatePersona: '',
        memory: (entry.memory ?? '').trim(),
        lastSeenDay: this.ma?.clockDay,
      })
      await putAgent(agent)
      this.agents.push(agent)
      // 新分配的角色默认在场，否则导演会认为他不在而永远不选他
      if (this.ma && !this.ma.presence.includes(entry.id)) {
        this.ma.presence.push(entry.id)
        await this.persistMa()
      }
    },

    // 取消分配（会丢弃该 NPC 的私有记忆，需调用方二次确认）
    async unassign(charId: string) {
      const worldId = this.worldId
      if (!worldId) return
      if (charId === NARRATOR_ID || charId === PLAYER_ID) return
      await deleteAgent(worldId, charId)
      this.agents = this.agents.filter((a) => a.charId !== charId)
      if (this.ma) {
        this.ma.presence = this.ma.presence.filter((id) => id !== charId)
        await this.persistMa()
      }
    },

    // 玩家手动编辑（设定/记忆/在场等）：rev++ 使在途的异步写回失效
    async updateAgent(charId: string, patch: Partial<Pick<AgentState, 'name' | 'privatePersona' | 'memory' | 'memorySummary' | 'present' | 'lastSeenDay' | 'stance' | 'knownLore'>>) {
      const worldId = this.worldId
      if (!worldId) return
      const idx = this.agents.findIndex((a) => a.charId === charId)
      if (idx < 0) return
      const next: AgentState = {
        ...this.agents[idx],
        ...patch,
        rev: this.agents[idx].rev + 1,
        updatedAt: Date.now(),
      }
      await putAgent(next)
      this.agents[idx] = next
    },

    // 重新从世界书导入公开人设/记忆（仅覆盖 memory 初始值，不动 privatePersona）
    async clearMemory(charId: string) {
      await this.updateAgent(charId, { memory: '', memorySummary: '' })
    },

    async persistMa() {
      if (!this.ma) return
      this.ma.updatedAt = Date.now()
      await putMaState({ ...this.ma })
    },

    async patchMa(patch: Partial<MaState>) {
      if (!this.ma) return
      this.ma = { ...this.ma, ...patch, updatedAt: Date.now() }
      await putMaState({ ...this.ma })
    },

    // ===== 消息流 =====
    getNextSeq(): number {
      return this.messages.reduce((m, x) => Math.max(m, x.seq), -1) + 1
    },

    async appendMessage(input: Omit<StoryMessage, 'id' | 'seq' | 'createdAt'> & { seq?: number }): Promise<StoryMessage> {
      const msg: StoryMessage = {
        ...input,
        id: createId(),
        seq: input.seq ?? this.getNextSeq(),
        createdAt: Date.now(),
      } as StoryMessage
      await putMessage(msg)
      this.messages.push(msg)
      this.messages.sort((a, b) => a.seq - b.seq)
      return msg
    },

    // 重新加载消息（回退/导入后）
    async reloadMessages() {
      if (!this.worldId) return
      this.messages = await listMessages(this.worldId)
    },

    // ===== 并发安全的写回（异步压缩/摘要必须带 baseRev）=====
    async safeWriteAgent(
      charId: string,
      baseRev: number,
      patch: Partial<Pick<AgentState, 'memory' | 'memorySummary' | 'privatePersona' | 'present' | 'lastSeenDay'>>,
    ): Promise<boolean> {
      const idx = this.agents.findIndex((a) => a.charId === charId)
      if (idx < 0) return false
      const cur = this.agents[idx]
      // 已被回退/手动编辑/其它写回更新过 → 丢弃本次结果，避免覆盖新状态
      if (cur.rev !== baseRev) return false
      const next: AgentState = { ...cur, ...patch, rev: cur.rev + 1, updatedAt: Date.now() }
      await putAgent(next)
      this.agents[idx] = next
      return true
    },

    // 记忆/设定超阈值时压缩（异步、带 rev 校验；失败静默）
    async compressAgentIfNeeded(charId: string): Promise<void> {
      const world = useWorldStore().currentWorld
      const st = useSettingsStore()
      const agent = this.agents.find((a) => a.charId === charId)
      if (!world || !agent) return
      // 世界已切换（异步压缩在途）：丢弃，避免用错世界名或写错世界
      if (world.id !== agent.worldId) return
      if (agent.charId === NARRATOR_ID || agent.charId === CROWD_ID) return

      // 1) 记忆压缩：保留近期原文，更早内容并入摘要
      const memThreshold = st.maMemoryThreshold
      if (memThreshold > 0 && agent.memory.length > memThreshold) {
        const baseRev = agent.rev
        try {
          const res = await compressAgentMemory(
            world.name,
            agent.name,
            agent.memorySummary ?? '',
            agent.memory,
            memThreshold,
            st.config,
          )
          const lines = agent.memory.split('\n').map((l) => l.trim()).filter(Boolean)
          const kept = lines.slice(res.keepFrom).join('\n')
          // res.summary 已是合并后的完整摘要，直接替换（拼接会越滚越长）
          const summary = res.summary.trim() || (agent.memorySummary ?? '')
          // 长期影响提升进设定，避免"和某人成了朋友"被压进摘要后淡出
          const persona = res.promote.trim()
            ? [agent.privatePersona, res.promote.trim()].filter((x) => !!x).join('\n')
            : agent.privatePersona
          if (kept.length < agent.memory.length) {
            await this.safeWriteAgent(charId, baseRev, {
              memory: kept,
              memorySummary: summary,
              privatePersona: persona,
            })
          }
        } catch (err) {
          console.warn('[ma] 记忆压缩失败（已忽略）', err)
        }
      }

      // 2) 设定压缩：仅在明显超长时触发，且只去冗余
      const fresh = this.agents.find((a) => a.charId === charId)
      const personaThreshold = st.maPersonaThreshold
      if (!fresh || personaThreshold <= 0 || fresh.privatePersona.length <= personaThreshold) return
      const baseRev = fresh.rev
      try {
        const compressed = await compressAgentPersona(world.name, fresh.name, fresh.privatePersona, st.config)
        if (compressed && compressed.length < fresh.privatePersona.length) {
          await this.safeWriteAgent(charId, baseRev, { privatePersona: compressed })
        }
      } catch (err) {
        console.warn('[ma] 设定压缩失败（已忽略）', err)
      }
    },

    // ===== 回合核心 =====

    computeKnows(): string[] {
      return [...new Set([PLAYER_ID, ...(this.ma?.presence ?? [])])]
    },

    advanceClockLocal(minutes: number) {
      const ma = this.ma
      if (!ma || !Number.isFinite(minutes) || minutes <= 0) return
      let m = ma.clockMinute + Math.round(minutes)
      let d = ma.clockDay
      while (m >= DAY_MINUTES) {
        m -= DAY_MINUTES
        d += 1
      }
      ma.clockMinute = m
      ma.clockDay = d
    },

    // 最近消息的机械拼接（不依赖 AI，永远最新）
    recentText(limit = 14, viewer?: string): string {
      const list = this.messages
        .filter((m) => !viewer || m.knows.includes(viewer) || m.speakerId === viewer)
        .slice(-limit)
      return list
        .map((m) => {
          const t = m.meta ? `[第${m.meta.day}天]` : ''
          return `${t}${m.speakerName}：${m.text}`
        })
        .join('\n')
    },

    activeNames(): string[] {
      const ma = this.ma
      if (!ma) return []
      return ma.presence
        .map((id) => this.agents.find((a) => a.charId === id)?.name ?? '')
        .filter(Boolean)
    },

    loreFor(viewerCharId: string, context: string): string {
      const world = useWorldStore().currentWorld
      if (!world) return ''
      const st = useSettingsStore()
      // 该角色的"应当知道的世界书条目标题"白名单（优化人设时配置）
      const knownLore = this.agents.find((a) => a.charId === viewerCharId)?.knownLore
      // 旁白需要看到全部秘密，给它更大的预算与条数；角色按常规预算
      const isNarrator = viewerCharId === NARRATOR_ID
      const budget = isNarrator ? Math.round(st.loreBudget * 1.5) : st.loreBudget
      const limit = isNarrator ? Math.max(world.loreLimit ?? 15, 24) : world.loreLimit
      return buildLoreInjection(
        world,
        context,
        this.ma?.sceneValue,
        this.activeNames(),
        { loreLimit: limit, loreBudget: budget, linkBudget: st.linkBudget },
        viewerCharId,
        knownLore,
      )
    },

    // 最近一条消息是否意味着"世界事实"发生变化（移动/战斗/时间跳跃等），需要旁白介入。
    // 无消息时返回 false：首次旁白由 sceneState 为空触发，避免刚刚旁白完又重复调用。
    worldFactChanged(): boolean {
      const last = this.messages[this.messages.length - 1]
      if (!last) return false
      if (last.speakerId === NARRATOR_ID) return false
      return /(前往|动身|离开|进入|抵达|到达|回到|走出|走进|推开|拔剑|开火|攻击|倒下|昏迷|醒来|天亮|天黑|第二天|次日)/.test(
        last.text,
      )
    },

    needNarrator(): boolean {
      const ma = this.ma
      if (!ma) return false
      const st = useSettingsStore()
      const interval = ma.heartbeatInterval ?? st.maNarratorHeartbeat
      if (!ma.sceneState.trim()) return true
      if (ma.narratorIdle >= interval) return true
      // 战斗中由导演逐拍决定"要不要插旁白"，不再用关键词触发，否则每一击都会拉一次旁白
      if (ma.combat?.active) return false
      if (this.worldFactChanged()) return true
      if (ma.secrets.some((s) => s.status === 'pending' && s.expiresAtDay !== undefined && ma.clockDay > s.expiresAtDay)) return true
      return false
    },

    // 本地打分（仅 hybrid 档使用）：所有角色（含玩家角色）统一规则，不做任何特判
    rankCandidates(): Array<{ id: string; name: string; score: number }> {
      const ma = this.ma
      if (!ma) return []
      const msgs = this.messages
      const last = msgs[msgs.length - 1]
      const lastSeq = last?.seq ?? 0
      const out: Array<{ id: string; name: string; score: number }> = []
      for (const a of this.agents) {
        if (a.charId === NARRATOR_ID) continue
        const present = a.charId === PLAYER_ID || ma.presence.includes(a.charId)
        const called = !!(last && a.name && last.text.includes(a.name))
        if (!present && !called) continue
        let score = present ? 60 : -50
        if (called) score += 100
        if (last && last.speakerId !== a.charId && last.knows.includes(a.charId)) score += 80
        const lastSpoke = [...msgs].reverse().find((m) => m.speakerId === a.charId)
        const idle = lastSpoke ? lastSeq - lastSpoke.seq : 12
        score += Math.min(idle, 12) * 3
        if (a.charId === ma.lastSpeakerId) score -= 999
        out.push({ id: a.charId, name: a.name, score })
      }
      return out.sort((x, y) => y.score - x.score)
    },

    // 调度档位：solo 仅在恰好 1 名 NPC 时生效，否则回落 director
    resolveDispatchMode(): 'director' | 'hybrid' | 'solo' {
      const mode = useSettingsStore().maDispatchMode
      if (mode === 'solo' && this.npcs.length !== 1) return 'director'
      return mode
    },

    // 最近一次"角色级"发言者（跳过旁白与路人），用于一对一档的轮转基准。
    // 若直接用 lastSpeakerId，旁白心跳插一句后就变成"NPC 连说两次"。
    lastActorId(): string | null {
      for (let i = this.messages.length - 1; i >= 0; i--) {
        const id = this.messages[i].speakerId
        if (id !== NARRATOR_ID && id !== CROWD_ID) return id
      }
      return null
    },

    // 每个角色"距上次开口多少条消息"，用于名册
    idleOf(charId: string): number {
      const msgs = this.messages
      if (msgs.length === 0) return 0
      const lastSeq = msgs[msgs.length - 1].seq
      const lastSpoke = [...msgs].reverse().find((m) => m.speakerId === charId)
      return lastSpoke ? lastSeq - lastSpoke.seq : msgs.length
    },

    // 场外可入场人物：世界书里未分配的人物中，被场景/最近对话提到的优先
    offstageActors(world: World): Array<{ name: string; brief: string }> {
      const assigned = new Set(this.agents.map((a) => a.charId))
      const text = `${this.ma?.sceneState ?? ''}\n${this.recentText(12)}`
      const list = (world.lorebook ?? []).filter(
        (e) => e.isCharacter === true && !e.hidden && !assigned.has(e.id) && e.access?.mode !== 'secret',
      )
      const mentioned = list.filter((e) => {
        const t = (e.title ?? '').trim()
        return t.length > 0 && text.includes(t)
      })
      const picked = mentioned.length > 0 ? mentioned : list
      return picked.slice(0, 6).map((e) => ({
        name: (e.title ?? '').trim() || '无名者',
        brief: ((e.persona ?? e.content ?? '').split('\n')[0] ?? '').slice(0, 40),
      }))
    },

    // 调导演：对称名册（不出现"玩家"标签），战斗时 restricted 限定本轮可行动者
    async askDirector(
      world: World,
      config: ReturnType<typeof useSettingsStore>['config'],
      restricted?: string[],
    ): Promise<DispatchResult> {
      const ma = this.ma
      if (!ma) return { next: CROWD_ID }
      const roster = this.agents
        .filter((a) => a.charId !== NARRATOR_ID)
        .map((a) => {
          const entry = (world.lorebook ?? []).find((x) => x.id === a.charId)
          const persona = a.charId === PLAYER_ID ? a.privatePersona : (entry?.persona ?? entry?.content ?? '')
          return {
            id: a.charId,
            name: a.name,
            brief: (persona.split('\n')[0] ?? '').slice(0, 40),
            stance: a.stance ?? '',
            present: a.charId === PLAYER_ID || ma.presence.includes(a.charId),
            idleBeats: this.idleOf(a.charId),
          }
        })
      const combat = ma.combat?.active
        ? {
            round: ma.combat.round,
            order: ma.combat.order.map((id) => ({
              id,
              name: this.agents.find((a) => a.charId === id)?.name ?? id,
            })),
            currentId: restricted?.[0] ?? ma.combat.order[ma.combat.index] ?? '',
          }
        : undefined

      try {
        const res = await generateDirector(
          {
            worldName: world.name,
            clockText: clockText(ma.clockDay, ma.clockMinute),
            sceneState: ma.sceneState,
            sceneAsOfSeq: ma.sceneAsOfSeq,
            eventType: ma.eventType ?? '',
            recent: this.recentText(12),
            roster,
            offstage: this.offstageActors(world),
            lastSpeakerName: this.agents.find((a) => a.charId === ma.lastSpeakerId)?.name ?? '',
            combat,
          },
          config,
        )
        const allowed = new Set<string>([...this.agents.map((a) => a.charId), NARRATOR_ID, CROWD_ID])
        const next = allowed.has(res.next) ? res.next : ''
        // 战斗中只接受"本轮轮到者"或旁白
        const finalNext = restricted && restricted.length > 0
          ? next === NARRATOR_ID
            ? NARRATOR_ID
            : restricted[0]
          : next
        return {
          next: finalNext || restricted?.[0] || this.rankCandidates()[0]?.id || CROWD_ID,
          focus: res.focus,
          presence: res.presence,
          combatStart: res.combatStart,
          combatEnd: res.combatEnd,
        }
      } catch {
        const fallback = restricted?.[0] ?? this.rankCandidates()[0]?.id ?? CROWD_ID
        return { next: fallback }
      }
    },

    async chooseNext(
      world: World,
      config: ReturnType<typeof useSettingsStore>['config'],
    ): Promise<DispatchResult> {
      const ma = this.ma
      if (!ma) return { next: CROWD_ID }
      const mode = this.resolveDispatchMode()

      // 战斗：按回合序轮转（各档位一致），导演只决定"要不要插旁白"
      if (ma.combat?.active) {
        const c = ma.combat
        const currentId = c.order[c.index] ?? c.order[0]
        if (!currentId) return { next: CROWD_ID }
        return await this.askDirector(world, config, [currentId])
      }

      // 一对一：固定 NPC ↔ 玩家轮转，不调导演、不调路人
      if (mode === 'solo' && this.npcs.length === 1) {
        const only = this.npcs[0]
        return { next: this.lastActorId() === only.charId ? PLAYER_ID : only.charId }
      }

      // hybrid：本地分差足够大时直接决定（省一次请求）
      if (mode === 'hybrid') {
        const ranked = this.rankCandidates()
        if (ranked.length === 1) return { next: ranked[0].id }
        if (ranked.length > 1 && ranked[0].score - ranked[1].score >= 30) return { next: ranked[0].id }
      }

      const res = await this.askDirector(world, config)
      // 兜底：模型可能忽略"不要连选"的规则，刚说完的人不该立刻再说（玩家也不例外）
      if (res.next && res.next === ma.lastSpeakerId) {
        const alt = this.rankCandidates().find((r) => r.id !== ma.lastSpeakerId)
        if (alt) return { ...res, next: alt.id }
        return { ...res, next: NARRATOR_ID }
      }
      return res
    },

    async runNarrator(world: World, opts: { combatStart?: boolean } = {}) {
      const ma = this.ma
      if (!ma) return
      const st = useSettingsStore()
      const expired = ma.secrets.filter(
        (s) => s.status === 'pending' && s.expiresAtDay !== undefined && ma.clockDay > s.expiresAtDay,
      )
      const res = await generateNarration(
        {
          worldName: world.name,
          sceneState: ma.sceneState,
          sceneAsOfSeq: ma.sceneAsOfSeq,
          eventType: ma.eventType ?? '',
          recent: this.recentText(12),
          lore: this.loreFor(NARRATOR_ID, ''),
          clockText: clockText(ma.clockDay, ma.clockMinute),
          secrets: ma.secrets,
          expiredSecrets: expired,
          // 在场者列表要包含玩家，否则旁白无法把秘密揭示给玩家（revealTo 需要用 __player__）
          presence: [
            ...ma.presence.map((id) => ({ id, name: this.agents.find((a) => a.charId === id)?.name ?? id })),
            { id: PLAYER_ID, name: this.player?.name ?? '你' },
          ],
          narrationMax: st.config.narrationMax ?? 500,
          combatStart: opts.combatStart === true,
          extra:
            [
              buildMaNarratorRules(
                { eventFrequency: st.eventFrequency, difficulty: st.difficulty, narrativeDetail: st.narrativeDetail },
                st.narrativeSpeed,
              ),
              bannedPrompt(ma.bannedEvents),
              purgeInstruction(ma.pendingPurge ?? []),
              this.pendingOnce,
            ]
              .filter((x) => !!x)
              .join('\n\n') || undefined,
        },
        st.config,
      )

      if (res.narration) {
        const msg = await this.appendMessage({
          worldId: world.id,
          speakerId: NARRATOR_ID,
          speakerName: '旁白',
          text: res.narration,
          knows: [...new Set([PLAYER_ID, ...ma.presence])],
          appliedTo: [],
          meta: { day: ma.clockDay, minute: ma.clockMinute },
        })
        ma.sceneAsOfSeq = msg.seq
        ma.lastSpeakerId = NARRATOR_ID
      }
      if (res.sceneState) ma.sceneState = res.sceneState
      if (res.eventType) ma.eventType = res.eventType
      // 清理请求已随本轮下发，无论模型是否全部照做都不再重复下发（避免每拍都带清理指令）
      if ((ma.pendingPurge?.length ?? 0) > 0) ma.pendingPurge = []
      this.pendingOnce = ''
      // 旁白是世界书更新的唯一写入者：合并 loreUpdates（含 access / revealTo）
      if (res.loreUpdates && res.loreUpdates.length > 0) {
        const updates = normalizeLorebook(res.loreUpdates)
        if (updates.length > 0) {
          const book = Array.isArray(world.lorebook) ? world.lorebook : []
          const merged = mergeLoreUpdates(book, updates)
          if (merged) {
            await useWorldStore().updateWorld(world.id, { lorebook: merged })
            // 双字段条目的记忆/事件压缩（异步，不阻塞本拍）
            const titles = new Set(updates.map((u) => (u.title ?? '').trim()).filter(Boolean))
            void compressDualEntries(world.id, titles, st.config).catch(() => {})
          }
        }
      }
      // 伏笔处置即移除（重要的事已由旁白写进 loreUpdates）；过期的若旁白没处置也一并移除，避免无限触发心跳
      const handled = new Set<string>(res.secretUpdates.map((u) => u.id))
      for (const s of expired) handled.add(s.id)
      if (handled.size > 0) ma.secrets = ma.secrets.filter((s) => !handled.has(s.id))
      for (const n of res.newSecrets) {
        const sec: Secret = {
          id: createId(),
          text: n.text,
          trigger: n.trigger,
          expiresAtDay: n.expiresAtDay,
          status: 'pending',
        }
        ma.secrets.push(sec)
      }
      // 战斗：旁白开场时建立回合序；旁白也可宣告结束
      if (res.combat?.order && res.combat.order.length > 0) {
        // 只接受本世界里已分配的角色，避免模型编造 id 导致回合卡在不存在的人身上
        const known = new Set(this.agents.map((a) => a.charId))
        const order = res.combat.order.filter((id) => known.has(id))
        if (order.length > 0) ma.combat = { active: true, round: 1, order, index: 0 }
      }
      if (res.combat?.end) ma.combat = undefined
      if (res.presence && res.presence.length > 0) {
        // presence 只表示"在场 NPC"：过滤掉旁白与玩家（旁白上下文里包含玩家 id，模型可能原样回传）
        ma.presence = res.presence.filter((id) => id !== PLAYER_ID && id !== NARRATOR_ID && id !== CROWD_ID)
      }
      // 存档变更由视图层应用（避免 store 间循环依赖）；多拍之间浅合并，保留最后一次的值
      if (res.patchSave && Object.keys(res.patchSave).length > 0) {
        ma.pendingSavePatch = { ...(ma.pendingSavePatch ?? {}), ...res.patchSave }
      }
      this.advanceClockLocal(res.timeAdvanceMinutes)
      ma.narratorIdle = 0
      await this.persistMa()
    },

    async runCrowd(world: World, focus?: string) {
      const ma = this.ma
      if (!ma) return
      const st = useSettingsStore()
      const recent = this.recentText(8)
      const res = await generateCrowd(
        {
          worldName: world.name,
          sceneState: ma.sceneState,
          sceneAsOfSeq: ma.sceneAsOfSeq,
          recent,
          lore: this.loreFor(CROWD_ID, focus ? `${focus} ${recent}` : recent),
          clockText: clockText(ma.clockDay, ma.clockMinute),
          focus,
        },
        st.config,
      )
      if (!res.speech) return
      await this.appendMessage({
        worldId: world.id,
        speakerId: CROWD_ID,
        speakerName: res.name,
        text: res.speech,
        knows: [...new Set([PLAYER_ID, ...ma.presence])],
        appliedTo: [],
        meta: { day: ma.clockDay, minute: ma.clockMinute },
      })
      ma.lastSpeakerId = CROWD_ID
      await this.persistMa()
    },

    async runNpc(charId: string, world: World) {
      const ma = this.ma
      const agent = this.agents.find((a) => a.charId === charId)
      if (!ma || !agent) return
      const st = useSettingsStore()
      const entry = (world.lorebook ?? []).find((e) => e.id === charId)
      const offlineDays = agent.lastSeenDay !== undefined ? ma.clockDay - agent.lastSeenDay : 0
      const res = await generateNpcSpeech(
        {
          worldName: world.name,
          name: agent.name,
          publicPersona: (entry?.persona ?? entry?.content ?? '').trim(),
          privatePersona: agent.privatePersona,
          memorySummary: agent.memorySummary ?? '',
          memory: agent.memory,
          stance: agent.stance ?? '',
          sceneState: ma.sceneState,
          sceneAsOfSeq: ma.sceneAsOfSeq,
          recent: this.recentText(14, charId),
          lore: this.loreFor(charId, this.recentText(6, charId)),
          clockText: clockText(ma.clockDay, ma.clockMinute),
          offlineDays: offlineDays > 0 ? offlineDays : undefined,
          extra:
            [buildMaActorDetailRule(st.narrativeDetail), bannedPrompt(ma.bannedEvents)]
              .filter((x) => !!x)
              .join('\n\n') || undefined,
        },
        st.config,
      )

      if (!res.speech) return

      // 记忆增量：先删行，再追加
      let memory = agent.memory
      if (res.memoryRemove.length > 0) {
        memory = memory
          .split('\n')
          .filter((line) => !line.trim() || !res.memoryRemove.some((r) => line.includes(r)))
          .join('\n')
      }
      for (const item of res.memoryAppend) {
        if (!item.trim()) continue
        if (memory.includes(item.trim())) continue
        memory = memory ? `${memory}\n${item.trim()}` : item.trim()
      }
      await this.updateAgent(charId, {
        memory,
        lastSeenDay: ma.clockDay,
        present: true,
        ...(res.stance ? { stance: res.stance } : {}),
      })

      const audience = res.audience && res.audience.length > 0 ? res.audience : null
      await this.appendMessage({
        worldId: world.id,
        speakerId: charId,
        speakerName: agent.name,
        text: res.speech,
        knows: audience ? [...new Set([PLAYER_ID, ...audience])] : [...new Set([PLAYER_ID, ...ma.presence])],
        appliedTo: [],
        meta: { day: ma.clockDay, minute: ma.clockMinute },
      })
      ma.lastSpeakerId = charId
      this.advanceClockLocal(res.timeAdvanceMinutes)
      // 本轮开口的 NPC 视为在场
      if (!ma.presence.includes(charId)) ma.presence.push(charId)
      await this.persistMa()
    },

    // 玩家角色被调度到时调用：生成三个"可能的输出"（第一人称，与 NPC 同构），等待玩家选择或自行输入
    async runPlayer(world: World) {
      const ma = this.ma
      if (!ma) return
      const st = useSettingsStore()
      const agent = this.player
      try {
        const recent = this.recentText(10, PLAYER_ID)
        const res = await generatePlayerOptions(
          {
            worldName: world.name,
            playerName: agent?.name ?? '你',
            playerPersona: (agent?.privatePersona ?? '').trim(),
            playerMemory: agent?.memory ?? '',
            playerStance: agent?.stance ?? '',
            sceneState: ma.sceneState,
            sceneAsOfSeq: ma.sceneAsOfSeq,
            recent,
            lore: this.loreFor(PLAYER_ID, recent),
            clockText: clockText(ma.clockDay, ma.clockMinute),
            optionCount: st.optionCount || 3,
            extra:
              [buildMaActorDetailRule(st.narrativeDetail), bannedPrompt(ma.bannedEvents)]
                .filter((x) => !!x)
                .join('\n\n') || undefined,
          },
          st.config,
        )
        this.currentOptions = res.options
        if (agent && (res.memoryAppend.length > 0 || res.stance)) {
          let memory = agent.memory
          for (const item of res.memoryAppend) {
            if (item.trim() && !memory.includes(item.trim())) {
              memory = memory ? `${memory}\n${item.trim()}` : item.trim()
            }
          }
          await this.updateAgent(PLAYER_ID, {
            memory,
            ...(res.stance ? { stance: res.stance } : {}),
          })
        }
      } catch (e) {
        this.error = errorMessage(e, st.devMode)
      }
      await this.persistMa()
    },

    // 推进一拍；返回 true 表示已轮到玩家（自动推进应停止）
    async beat(playerInput?: string): Promise<boolean> {
      const world = useWorldStore().currentWorld
      const ma = this.ma
      const st = useSettingsStore()
      if (!world || !ma || !world.multiAgent) return false
      const worldId = world.id
      this.error = null
      this.turnLoading = true
      try {
        // 1. 玩家输入入流
        const text = (playerInput ?? '').trim()
        if (text) {
          await this.appendMessage({
            worldId,
            speakerId: PLAYER_ID,
            speakerName: this.player?.name ?? '你',
            text,
            knows: this.computeKnows(),
            appliedTo: [],
            meta: { day: ma.clockDay, minute: ma.clockMinute },
          })
          this.advanceClockLocal(2)
          ma.lastSpeakerId = PLAYER_ID
          // 战斗中轮到玩家时：玩家的这次输入即视为其回合行动，推进回合序
          const c0 = ma.combat
          if (c0?.active && c0.order[c0.index] === PLAYER_ID) {
            c0.index += 1
            if (c0.index >= c0.order.length) {
              c0.index = 0
              c0.round += 1
            }
          }
        }

        // 2. 先问调度：同时得到下一个发言者、在场修正与战斗指令
        const dispatch = await this.chooseNext(world, st.config)
        if (this.worldId !== worldId) return false

        // 3. 先应用导演的在场修正 / 战斗结束，旁白再基于修正后的在场者判断（旁白的结论优先级更高，后写覆盖）
        if (dispatch.presence && dispatch.presence.length > 0) {
          ma.presence = dispatch.presence.filter((id) => id !== PLAYER_ID && id !== NARRATOR_ID && id !== CROWD_ID)
        }
        if (dispatch.combatEnd) {
          ma.combat = undefined
          if (ma.eventType === '战斗') ma.eventType = '对话'
        }

        // 4. 旁白：心跳 / 本拍就是旁白 / 战斗开场
        if (this.needNarrator() || dispatch.next === NARRATOR_ID || dispatch.combatStart) {
          await this.runNarrator(world, { combatStart: dispatch.combatStart === true })
          if (this.worldId !== worldId) return false
        } else {
          ma.narratorIdle += 1
        }

        // 5. 执行
        if (dispatch.next === PLAYER_ID) {
          await this.runPlayer(world)
          this.pendingPlayer = true
          return true
        }
        if (dispatch.next === NARRATOR_ID) {
          // 第 3 步已由旁白完成本拍
        } else if (dispatch.next === CROWD_ID) {
          await this.runCrowd(world, dispatch.focus)
        } else {
          await this.runNpc(dispatch.next, world)
        }

        // 5. 战斗回合推进（仅当本拍确实是该回合角色行动）
        const c = ma.combat
        if (c?.active && dispatch.next === c.order[c.index]) {
          c.index += 1
          if (c.index >= c.order.length) {
            c.index = 0
            c.round += 1
          }
        }
        return false
      } catch (e) {
        this.error = errorMessage(e, st.devMode)
        return false
      } finally {
        if (this.worldId === worldId && this.ma) {
          this.ma.beat += 1
          this.turnLoading = false
          await this.persistMa().catch(() => {})
          // 本轮发言的角色：异步检查记忆/设定是否需要压缩（不阻塞下一拍）
          const speaker = this.ma.lastSpeakerId
          if (speaker && speaker !== NARRATOR_ID && speaker !== CROWD_ID && speaker !== PLAYER_ID) {
            void this.compressAgentIfNeeded(speaker).catch(() => {})
          }
        }
      }
    },

    // 玩家发送 / 继续：走一拍后按设置自动推进若干拍
    async submit(input?: string) {
      const ma = this.ma
      if (!ma) return
      this.pendingPlayer = false
      this.currentOptions = []
      this.pendingOnce = ''

      // 特殊指令：本地剥离；禁令先按回合递减，再加入本次新增
      const parsed = parseSpecialCommands(input ?? '')
      ma.bannedEvents = tickBanned(ma.bannedEvents ?? [])
      let text = parsed.text
      if (parsed.commands.length > 0) {
        const bans = parsed.commands.filter((c) => c.type === 'terminate').map((c) => c.arg).filter(Boolean)
        const once = parsed.commands.filter((c) => c.type !== 'terminate')
        for (const b of bans) {
          ma.bannedEvents = addBanned(ma.bannedEvents, b)
          ma.pendingPurge = [...new Set([...(ma.pendingPurge ?? []), b])]
        }
        this.pendingOnce = onceInstruction(once)
        await this.persistMa()
        // 只有指令、没有正文：只让旁白做一次清理，不推进角色
        if (!text) {
          const world = useWorldStore().currentWorld
          if (world && (bans.length > 0 || once.length > 0)) {
            this.turnLoading = true
            try {
              await this.runNarrator(world)
            } catch (e) {
              this.error = errorMessage(e, useSettingsStore().devMode)
            } finally {
              this.pendingOnce = ''
              this.turnLoading = false
            }
            return
          }
          return
        }
      }

      const total = Math.max(1, Math.min(10, ma.autoAdvance ?? useSettingsStore().maAutoAdvance))
      this.beatsTotal = total
      this.beatsDone = 0

      let waiting = await this.beat(text || undefined)
      this.beatsDone = 1
      let left = total - 1
      let emptyStraight = 0
      while (!waiting && left > 0) {
        const before = this.messages.length
        waiting = await this.beat()
        this.beatsDone += 1
        left -= 1
        // 连续两拍没有任何消息产出时停止，避免空转烧 token
        emptyStraight = this.messages.length === before ? emptyStraight + 1 : 0
        if (emptyStraight >= 2) break
      }
      if (waiting) {
        // 轮到玩家：重新计数，等玩家输入
        this.beatsDone = 0
        this.beatsTotal = 0
      }
    },

    // 手动解除某条「终止事件」禁令
    async removeBanned(text: string) {
      const ma = this.ma
      if (!ma) return
      ma.bannedEvents = (ma.bannedEvents ?? []).filter((b) => b.text !== text)
      await this.persistMa()
    },

    async resetTurnState() {
      this.pendingPlayer = false
      this.currentOptions = []
      this.beatsDone = 0
      this.beatsTotal = 0
      this.error = null
    },

    // 读档/导入：用快照整体替换多智能体状态
    async restoreSnapshot(worldId: string, maState: MaState, agents: AgentState[], messages: StoryMessage[]) {
      const existing = await listAgents(worldId)
      for (const a of existing) await deleteAgent(worldId, a.charId)
      for (const a of agents) await putAgent(a)
      await replaceMessages(worldId, messages)
      await putMaState(maState)
      this.worldId = worldId
      this.ma = maState
      this.agents = [...agents]
      this.messages = [...messages].sort((a, b) => a.seq - b.seq)
      this.pendingPlayer = false
      this.currentOptions = []
      this.beatsDone = 0
      this.beatsTotal = 0
      this.error = null
      await this.ensureSystemAgents()
    },

    // 重新开始：清空该世界的全部多智能体数据
    async clearAll() {
      const worldId = this.worldId
      if (!worldId) return
      const existing = await listAgents(worldId)
      for (const a of existing) await deleteAgent(worldId, a.charId)
      await replaceMessages(worldId, [])
      await deleteMaState(worldId)
      this.ma = null
      this.agents = []
      this.messages = []
      this.pendingPlayer = false
      this.currentOptions = []
      this.beatsDone = 0
      this.beatsTotal = 0
    },

    // 开局：把普通模式生成的开场白转成多智能体消息流的起点
    async seedOpening(input: { worldId: string; playerInput: string; narration: string; playerProfile: string }) {
      const ma = this.ma
      if (!ma) return
      if (this.messages.length > 0) return // 已有剧情，不重复播种
      if (input.playerInput.trim()) {
        await this.appendMessage({
          worldId: input.worldId,
          speakerId: PLAYER_ID,
          speakerName: this.player?.name ?? '你',
          text: input.playerInput.trim(),
          knows: [PLAYER_ID, ...(ma.presence ?? [])],
          appliedTo: [],
          meta: { day: ma.clockDay, minute: ma.clockMinute },
        })
      }
      if (input.narration.trim()) {
        const msg = await this.appendMessage({
          worldId: input.worldId,
          speakerId: NARRATOR_ID,
          speakerName: '旁白',
          text: input.narration.trim(),
          knows: [PLAYER_ID, ...(ma.presence ?? [])],
          appliedTo: [],
          meta: { day: ma.clockDay, minute: ma.clockMinute },
        })
        ma.sceneAsOfSeq = msg.seq
        ma.sceneState = input.narration.trim().slice(0, 1200)
        ma.lastSpeakerId = NARRATOR_ID
      }
      ma.beat = 1
      ma.narratorIdle = 0
      if (input.playerProfile.trim()) {
        await this.updateAgent(PLAYER_ID, { privatePersona: input.playerProfile.trim() })
      }
      await this.persistMa()
    },
  },
})
