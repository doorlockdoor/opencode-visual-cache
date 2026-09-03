import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message, UserMessage } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { estimateTokens, num } from "./tokens"

// ── token 分布扫描（侧边栏「分布」区数据源）──
// 纯函数：api.state store 读取不建立响应式依赖，调用方须在 untrack 内调用。
//
// per-message 小计缓存：流式期间仅尾消息的 parts 在增长，而全量重扫
// （estimateTokens 逐字符，1MB≈5-10ms）过去随事件频率重跑成为 CPU 热点。
// 以「消息 id → 指纹+小计」缓存后，重建只需对每条消息计算 O(1) 字段指纹
// （不扫字符），未变化的消息直接复用小计，实际扫描收敛到真正变化的消息。
// 指纹覆盖所有被扫描字段的长度与状态（长度 O(1)），任一变化即失效；
// 消息 id 全局唯一，跨会话/override 无串扰；条目超上限全清防泄漏。
// 性能验证与收益量化见 benchmarks/dist-bench.mts（npm run bench:dist）。

export interface TokenDist {
  system: number   // UserMessage.system + agent config prompt
  user: number     // user message text/file parts
  agent: number    // task tool input prompt/description (sub-agent delegation)
  toolCall: number // ToolPart.input (actual tool params)
  toolResult: number // ToolPart completed output / error
  output: number   // AssistantMessage.tokens.output (API exact, reasoning excluded)
  reasoning: number // AssistantMessage.tokens.reasoning (API exact)
  apiOutput: number // 最后一条有数据消息的 tokens.output（API exact）
  apiInput: number  // API exact total input context (input + cache read + cache write)
  stepCost: number  // last step-finish part cost (USD) in the current round
  stepCount: number // step-finish parts count across the current round (parentID chain)
}

/** SDK 未就绪/越界时返回空 parts（逐条 try/catch 的公共形态） */
export function partsOf(api: TuiPluginApi, id: string): readonly Part[] {
  try { return api.state.part(id) } catch { return [] }
}

// TUI SDK 剥离工具元数据 — 从 skill 输出的固定格式提取名称
// （与 api.client.app.skills() 交叉验证过）
function skillNameFromOutput(output: string): string | undefined {
  const m = output.match(/^#{1,2}\s*Skill:\s*(.+)/m)
  return m?.[1].trim()
}

/** 回合统计：最后一条有 token 数据消息的 context 大小 + 其 parentID 链的 step 数与末次成本。 */
export function collectRoundUsage(api: TuiPluginApi, msgs: Message[]): {
  apiInput: number; apiOutput: number; stepCount: number; stepCost: number
} {
  // 从后往前找最后一条有 token 数据的 assistant 消息（避免取到 streaming 中未填充的消息）
  let lastAssMsg: AssistantMessage | undefined
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role !== "assistant") continue
    const tok = (msgs[i] as AssistantMessage).tokens
    if (tok && ((tok.input ?? 0) > 0 || (tok.cache?.read ?? 0) > 0 || (tok.cache?.write ?? 0) > 0)) { lastAssMsg = msgs[i] as AssistantMessage; break }
  }
  if (!lastAssMsg) return { apiInput: 0, apiOutput: 0, stepCount: 0, stepCost: 0 }
  // 取最后一条有数据消息的总输入（含缓存读/写）作为当前 context 大小
  const apiInput = num(lastAssMsg.tokens?.input) + num(lastAssMsg.tokens?.cache?.read) + num(lastAssMsg.tokens?.cache?.write)
  const apiOutput = num(lastAssMsg.tokens?.output)
  // 本回合（最后一条有数据消息所在的 parentID 链）的 API 调用次数与末次成本。
  // opencode 将回合内每次工具调用循环拆为独立 assistant 消息（各含 1 个 step-finish），
  // 故按 parentID 链聚合统计，而非单条消息。
  let stepCount = 0
  let lastCost: number | undefined
  const roundParent = lastAssMsg.parentID
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]
    if (m.role !== "assistant") continue
    if ((m as AssistantMessage).parentID !== roundParent) break
    for (const p of partsOf(api, m.id)) {
      if (p.type !== "step-finish") continue
      stepCount++
      const sc = (p as { cost?: unknown }).cost
      if (lastCost === undefined && typeof sc === "number" && Number.isFinite(sc)) lastCost = sc
    }
  }
  return { apiInput, apiOutput, stepCount, stepCost: lastCost ?? 0 }
}

// ── 单消息 dist 小计 + 指纹缓存 ──

interface DistSub {
  system: number; user: number; agent: number; toolCall: number; toolResult: number
  skills: { name: string; tokens: number }[]
}

const distSubCache = new Map<string, { fp: string; sub: DistSub }>()
const DIST_SUB_CACHE_MAX = 1000

const strLen = (v: unknown): number => (typeof v === "string" ? v.length : 0)

/**
 * 单消息 dist 小计的廉价指纹：只读被扫描字段的长度/状态（JS 字符串 .length 为
 * O(1)，不扫字符）。角色感知——assistant 的 text/reasoning part 不参与分布
 * （output/reasoning 来自 tokens），其流式增长不应触发重扫。
 */
export function distFingerprint(msg: Message, parts: readonly Part[]): string {
  const role = msg.role as string
  if (role === "user") {
    let fp = `u:${strLen((msg as UserMessage).system)}:${parts.length}`
    for (const p of parts) {
      fp += `|${p.type}:${strLen((p as any).text)}:${(p as any).synthetic ? 1 : 0}:${(p as any).ignored ? 1 : 0}` +
        `:${strLen((p as any).source?.text?.value)}`
    }
    return fp
  }
  if (role !== "assistant") return `${role}:${parts.length}`
  let fp = `a:${parts.length}`
  for (const p of parts) {
    if (p.type === "tool") {
      // input 只记存在性（opencode 的 tool input 在 part 创建时一次性写入，
      // 无渐进填充）；其余按字符串长度感知。raw 缺失时扫描走 JSON.stringify
      // 兜底，两者以 input 存在性同步翻转，无需感知其内容。
      const ps = (p as any).state
      fp += `|t:${ps?.status ?? ""}:${ps?.time?.end ?? 0}:${strLen(ps?.raw)}:${strLen(ps?.output)}` +
        `:${strLen(ps?.error)}:${strLen(ps?.metadata?.name)}:${ps?.input != null ? 1 : 0}`
    } else if (p.type === "subtask") {
      fp += `|s:${strLen((p as any).prompt)}:${strLen((p as any).description)}`
    } else {
      fp += "|."
    }
  }
  return fp
}

/** 单消息扫描（estimateTokens 密集区；结果经指纹缓存复用）。 */
function scanMessageDist(msg: Message, parts: readonly Part[]): DistSub {
  const sub: DistSub = { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0, skills: [] }
  if (msg.role === "user") {
    const um = msg as UserMessage
    if (um.system) sub.system += estimateTokens(um.system)
    for (const p of parts) {
      if (p.type === "text" && !(p as any).synthetic && !(p as any).ignored) sub.user += estimateTokens((p as any).text)
      else if (p.type === "file") { const fp = p as any; if (fp.source?.text?.value) sub.user += estimateTokens(fp.source.text.value) }
    }
    return sub
  }
  if (msg.role !== "assistant") return sub
  for (const p of parts) {
    if (p.type === "tool") {
      const tp = p as any
      let rawInput = ""
      try { rawInput = tp.state.raw ?? (tp.state.input != null ? JSON.stringify(tp.state.input) : "") } catch {}
      if (rawInput) sub.toolCall += estimateTokens(rawInput, "code")
      // 子代理委托（task 工具）：任务描述计入子代理指令（1.15.x 无 subtask part）
      if (tp.tool === "task" && tp.state?.input) {
        const ti = tp.state.input
        const prompt = typeof ti.prompt === "string" ? ti.prompt : ""
        const desc = typeof ti.description === "string" ? ti.description : ""
        sub.agent += estimateTokens(prompt || desc)
      }
      if (tp.state.status === "completed") { if (tp.state.output) sub.toolResult += estimateTokens(tp.state.output, "code") }
      else if (tp.state.status === "error") { if (tp.state.error) sub.toolResult += estimateTokens(tp.state.error, "code") }
      if (tp.tool === "skill" && tp.state.status === "completed") {
        const output = typeof tp.state.output === "string" ? tp.state.output : ""
        const name = typeof tp.state.metadata?.name === "string" ? tp.state.metadata.name : skillNameFromOutput(output)
        if (name) {
          const tokens = output ? estimateTokens(output) : 0
          sub.skills.push({ name, tokens })
        }
      }
    } else if (p.type === "subtask") {
      const sb = p as any
      sub.agent += estimateTokens(sb.prompt || sb.description || "")
    }
  }
  return sub
}

/** token 分布扫描：user 消息（system/text/file）与 assistant 消息（tool 输入/结果、task/skill 子代理指令）。 */
export function collectTokenDist(api: TuiPluginApi, msgs: Message[], session: { agent?: unknown } | undefined): {
  dist: TokenDist
  hasDistData: boolean
  skills: { name: string; tokens: number }[]
} {
  const dist: TokenDist = { system: 0, user: 0, agent: 0, toolCall: 0, toolResult: 0, output: 0, reasoning: 0, apiOutput: 0, apiInput: 0, stepCost: 0, stepCount: 0 }
  const loadedSkills = new Map<string, { name: string; tokens: number }>()
  const cfg = api.state.config as Record<string, unknown> | undefined
  const agentName = String(session?.agent ?? cfg?.default_agent ?? "build")
  const agents = cfg?.agent as Record<string, unknown> | undefined
  const agentCfg = agents?.[agentName] as Record<string, unknown> | undefined
  const sysPrompt = typeof agentCfg?.prompt === "string" ? agentCfg.prompt : ""
  if (sysPrompt) dist.system = estimateTokens(sysPrompt)
  for (const msg of msgs) {
    const parts = partsOf(api, msg.id)
    const fp = distFingerprint(msg, parts)
    let entry = distSubCache.get(msg.id)
    if (!entry || entry.fp !== fp) {
      if (distSubCache.size >= DIST_SUB_CACHE_MAX) distSubCache.clear()
      entry = { fp, sub: scanMessageDist(msg, parts) }
      distSubCache.set(msg.id, entry)
    }
    dist.system += entry.sub.system
    dist.user += entry.sub.user
    dist.agent += entry.sub.agent
    dist.toolCall += entry.sub.toolCall
    dist.toolResult += entry.sub.toolResult
    // output/reasoning 来自 API 精确 tokens（非文本扫描），不进缓存——
    // tokens 在 step 末写入而指纹不感知，须每次从消息直接读取
    if (msg.role === "assistant") {
      const am = msg as AssistantMessage
      dist.output += num(am.tokens?.output)
      dist.reasoning += num(am.tokens?.reasoning)
    }
    // skill 语义与旧实现一致：跨消息按名称保留最大 token 数
    for (const sk of entry.sub.skills) {
      const existing = loadedSkills.get(sk.name)
      if (!existing || existing.tokens < sk.tokens) loadedSkills.set(sk.name, sk)
    }
  }
  Object.assign(dist, collectRoundUsage(api, msgs))
  const hasDistData = dist.system + dist.user + dist.agent + dist.toolCall + dist.toolResult > 0
    || dist.apiOutput > 0 || dist.apiInput > 0 || dist.reasoning > 0
  return { dist, hasDistData, skills: [...loadedSkills.values()] }
}
