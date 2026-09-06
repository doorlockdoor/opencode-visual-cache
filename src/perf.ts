import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { ASCII_PER_TOKEN, estimateTokens, num } from "./tokens"

// ── performance (TTFT / TPS / latency) ──
// 口径（在 opencode-throughput / tokenwatch 上的修正版）：
//   TTFT = 首个内容 part (text/reasoning) 的 time.start − message.time.created
//          （体感口径：含 DB 写、预处理与建连等待，略大于 provider 报告的 TTFT）
//   净生成 = time.completed − 首个 part start − 工具执行窗口∩生成区间
//   TPS   = (output + reasoning) / 净生成 × 1000   ← 供应商全量生成 token
//          （例外 1——隐藏思考：usage 计入 reasoningTokens 但无流式 reasoning
//            part（chat-completions o 系等）：思考解码期不可观测、分母从首个
//            text part 起算，保留思考 token 会数量级虚高 → 分子退回 output，
//            与实时估算"只数流式可见"一致）
//          （例外 2——整包参数：缓冲 router 把工具参数整包送达时分子剔除
//            参数估算、退回可见口径；判据与方向见 BUFFERED_* 常量注释）
//   延迟  = time.completed − time.created − 工具执行窗口∩生成区间（净模型耗时）
// 分子为供应商精确 output_tokens（含 tool_use 参数 JSON），分母仅扣"工具执行
// 等待"（tool-call→tool-result 的 state.time 区间，并行去重、钳位）。
// 压缩消息与纯工具 step 不计入样本；小步/缓冲网关守卫触发时 TPS 记 null。
// 宿主动态（packages/opencode/src/session/processor.ts）：
//   text-start → time.start；reasoning-start → time.start（思考段有戳，
//   delta 不更新 end，reasoning-end/cleanup 补 end，流式中只读 start）；
//   tool：参数流式期（tool-input-*）仅建 pending 无 time，tool-call 才置
//   running 并打 start，tool-result 补 end → 参数生成期不可观测，
//   留在分母（已知残余低估），与分子（参数已全量计入）方向相反相互弱化。
//   采样逻辑单一实现（computePerfSample），侧边栏累计与 hint 栏 lastTps
//   共用，杜绝双源漂移。消息与 part 时间戳持久化在数据库，直接读取推导。

// 小步噪声守卫：生成窗口 <500ms 时时间戳噪声占比过大，TPS 不可信 → 记 null
export const MIN_GEN_MS = 500
// 缓冲网关守卫：每 token 耗时 <0.2ms（非流式瞬间吐出）时 TPS 不可信 → 记 null
export const BUFFER_MS_PER_TOKEN = 0.2
// 实时估算守卫：生成窗口 <500ms 或产出 <8 token 时波动过大，不显示速度
export const LIVE_MIN_GEN_MS = 500
export const LIVE_MIN_TOK = 8
// 整包参数守卫：缓冲 router 把工具参数作为整块 chunk 送达（不流式经过可见
// 窗口）时，参数 token 计入分子而解码时间不在分母 → TPS 虚高。检测（首工具，
// 单次 LLM 调用内全部工具参数都流式于 [前置内容末端, 首工具 start] 窗口）：
//   ① 参数估算 ≥ BUFFERED_MIN_PARAM_TOK
//   ② 参数窗口 gap = 首工具 state.time.start − 前置内容 part 末端 ≤ BUFFERED_GAP_MS
//   ③ 隐含参数速度 ≥ BUFFERED_SPEED_RATIO × 同窗口文本流式速度
// 三者同时命中 → 该步分子剔除工具参数估算（退回可见口径）。阈值取宽（实测
// 正常流式的 deepseek 误伤 1/586 步），且方向保守：最多退回可见速度，不会
// 产生虚高值；文本速度用 O(1) 长度近似（CJK 混排会低估 visTps → 偏向触发，
// 由 gap 上界兜底：参数真实流式必占时间，不可能挤进 ≤150ms 窗口）。
export const BUFFERED_GAP_MS = 150
export const BUFFERED_MIN_PARAM_TOK = 30
export const BUFFERED_SPEED_RATIO = 5

/**
 * 合并工具执行区间（并行重叠去重），并钳位到 [lo, hi]（hi 省略表示无上界），
 * 返回合并后的总时长。用于从生成窗口扣除工具等待。
 */
function mergedIntervalMs(intervals: readonly [number, number][], lo: number, hi?: number): number {
  if (intervals.length === 0) return 0
  const sorted = [...intervals].sort((a, b) => a[0] - b[0])
  let ms = 0
  let ws = -1
  let we = -1
  for (const [s, e] of sorted) {
    const a = Math.max(s, lo)
    const b = hi === undefined ? e : Math.min(e, hi)
    if (b <= a) continue
    if (ws < 0) { ws = a; we = b }
    else if (a <= we) { if (b > we) we = b }
    else { ms += we - ws; ws = a; we = b }
  }
  if (ws >= 0) ms += we - ws
  return ms
}

export interface PerfSample {
  ttft: number
  tps: number | null
  latency: number
}

/**
 * 工具参数原文：优先 state.raw（模型生成的原始参数文本），回退 state.input 序列化。
 * 序列化抛错（循环引用等）按空串处理。
 */
function toolParamText(p: Part): string {
  const st = (p as { state?: { raw?: unknown; input?: unknown } }).state
  try {
    if (typeof st?.raw === "string" && st.raw) return st.raw
    return st?.input != null ? JSON.stringify(st.input) : ""
  } catch { return "" }
}

/**
 * 整包参数守卫（见 BUFFERED_* 注释）：命中返回应从分子剔除的参数估算，未命中返回 0。
 */
function bufferedParamTok(
  toolRefs: readonly { start: number; part: Part }[],
  contentRefs: readonly { end: number; len: number; reasoning: boolean }[],
  fs: number,
): number {
  const fts = Math.min(...toolRefs.map((t) => t.start))
  const pre = contentRefs.filter((c) => c.end <= fts)
  if (pre.length === 0) return 0
  const anchor = Math.max(...pre.map((c) => c.end))
  const gap = fts - anchor
  if (gap > BUFFERED_GAP_MS) return 0
  let visTok = 0
  for (const c of pre) visTok += Math.ceil(c.len / (c.reasoning ? ASCII_PER_TOKEN.thinking : ASCII_PER_TOKEN.answer))
  const visMs = anchor - fs
  const visTps = visMs > 0 ? (visTok / visMs) * 1000 : 0
  if (visTps <= 0) return 0
  const paramTok = toolRefs.reduce((n, t) => n + Math.ceil(toolParamText(t.part).length / ASCII_PER_TOKEN.code), 0)
  if (paramTok < BUFFERED_MIN_PARAM_TOK) return 0
  if ((paramTok / Math.max(gap, 1)) * 1000 < visTps * BUFFERED_SPEED_RATIO) return 0
  return paramTok
}

// ── per-message perf sample ──
// 单条 assistant 消息的性能样本（精确口径唯一实现）：侧边栏「性能」累计与
// hint 栏 lastTps 共用。条件：已完成、无错误、非压缩、产出 token>0、有内容
// part 且首 part 晚于创建；返回 null 表示不计入样本。
export function computePerfSample(
  am: AssistantMessage,
  parts: readonly Part[],
): PerfSample | null {
  const created = am.time?.created
  const completed = am.time?.completed
  if (!created || !completed || am.error || am.summary) return null
  const outputTok = num(am.tokens?.output)
  const reasoningTok = num(am.tokens?.reasoning)
  if (outputTok + reasoningTok <= 0) return null
  // 首内容 part 的 time.start = 首 token 到达时刻（text-start / reasoning-start
  // 打戳，取最早）；工具执行窗口扣减 [tool-call 起, tool-result 止] 的
  // state.time 区间。分子用供应商全量 output_tokens（含工具参数 JSON）——
  // 参数生成期（pending 段）无时间戳、留分母，与"参数已全量计入分子"
  // 方向相反、相互弱化；缓冲 router 的整包参数例外由下方守卫剔除
  // （详见头部口径说明）。
  let firstStart: number | undefined
  let toolIvs: [number, number][] | null = null
  let hasReasoning = false
  const toolRefs: { start: number; part: Part }[] = []
  const contentRefs: { end: number; len: number; reasoning: boolean }[] = []
  for (const p of parts) {
    if (p.type === "tool") {
      const tw = (p as any).state?.time
      if (typeof tw?.start === "number" && tw.start > 0) {
        toolRefs.push({ start: tw.start, part: p })
        if (typeof tw.end === "number" && tw.end > tw.start) {
          toolIvs ??= []
          toolIvs.push([tw.start, tw.end])
        }
      }
      continue
    }
    if (p.type !== "text" && p.type !== "reasoning") continue
    if (p.type === "reasoning") hasReasoning = true
    const tm = (p as { time?: { start?: number; end?: number } }).time
    const st = tm?.start
    if (typeof st !== "number" || st <= 0) continue
    const text = (p as { text?: unknown }).text
    contentRefs.push({
      end: typeof tm?.end === "number" && tm.end > st ? tm.end : st,
      len: typeof text === "string" ? text.length : 0,
      reasoning: p.type === "reasoning",
    })
    if (firstStart === undefined || st < firstStart) firstStart = st
  }
  if (firstStart === undefined || firstStart <= created) return null
  // 隐藏思考：无流式 reasoning part → 思考解码时间不可观测，分子退回 output（见头部例外 1）
  let genTok = reasoningTok > 0 && !hasReasoning ? outputTok : outputTok + reasoningTok
  const fs = firstStart
  // 合并工具执行窗口（并行区间重叠去重），钳位到 [fs, completed] 后扣除：
  // 首内容前的工具时间不参与扣减——它被计入 TTFT（体感口径），latency 同基准。
  // 已知偏差：[start,end] 为纯执行窗口，参数生成期无时间戳（含在延迟与净生成内）。
  const toolMs = toolIvs ? mergedIntervalMs(toolIvs, fs, completed) : 0
  // 整包参数守卫（见 BUFFERED_* 注释）：命中时从分子剔除参数估算
  if (toolRefs.length) genTok = Math.max(0, genTok - bufferedParamTok(toolRefs, contentRefs, fs))
  const ttft = fs - created
  const genMs = Math.max(0, completed - fs - toolMs)
  const latency = Math.max(0, completed - created - toolMs)
  // 守卫（小步噪声 / 缓冲网关）触发：TPS 记 null，ttft/latency 照常
  const tps = genTok > 0 && genMs >= Math.max(MIN_GEN_MS, genTok * BUFFER_MS_PER_TOKEN) ? (genTok / genMs) * 1000 : null
  return { ttft, tps, latency }
}

// ── session perf aggregation ──
// PerfStats 从 index.tsx 迁入：聚合与采样同属精确口径，单文件单来源，可被
// tests/perf.test.ts 直接单测。聚合用中位数而非均值：会话常跨模型/跨路由，
// 均值被高速段与离群短步拉偏；偶数样本取中间两值平均。数组随聚合重建
// （节流下 O(n log n) 可忽略），KV 快照只存聚合结果不存原始样本。
export interface PerfStats {
  ttftLast: number | null // 最近一次首字延迟 (ms)
  tpsLast: number | null  // 最近一次输出速度 (tok/s)
  latLast: number | null  // 最近一次净模型延迟 (ms，已扣工具执行窗口)
  ttftMed: number | null  // 会话首字延迟中位数 (ms)
  tpsMed: number | null   // 会话输出速度中位数 (tok/s)
  latMed: number | null   // 会话净模型延迟中位数 (ms)
  ttftN: number           // 有效样本数（TTFT/延迟共用；压缩消息与纯工具 step 不计）
  tpsN: number            // TPS 有效样本数（守卫记 null 的样本不计入）
  hasPerf: boolean        // 是否存在有效样本
}

export const EMPTY_PERF: PerfStats = {
  ttftLast: null, tpsLast: null, latLast: null,
  ttftMed: null, tpsMed: null, latMed: null,
  ttftN: 0, tpsN: 0, hasPerf: false,
}

/** 中位数：偶数个取中间两值平均。 */
function median(values: readonly number[]): number {
  const s = [...values].sort((a, b) => a - b)
  const mid = s.length >> 1
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

// ── model filtering ──
// 同一会话跨模型切换会混合不同模型的样本（速度差异可达数倍），中位数与最近值
// 均不代表当前模型。每条 assistant 消息自带 modelID/providerID（生成时
// 写入、持久化），按此过滤零成本；过滤上下文由调用方传入（见 index.tsx）。
/**
 * 消息的模型指纹（`providerID/modelID`）。字段缺失（旧版数据）→ null，
 * 表示无法归属任何模型；过滤开启时该类消息被排除。
 */
export function modelKeyOf(am: AssistantMessage): string | null {
  const p = am.providerID
  const m = am.modelID
  return p && m ? `${p}/${m}` : null
}

/**
 * 当前会话的模型指纹：优先 `session.model`（下一条回复将使用的模型，
 * 切换模型后 session 更新即生效，无消息也能得到正确目标），
 * 回退到最后一条 assistant 消息的模型（旧版 SDK/子代理会话缺 model 信息）。
 * 返回 null 表示当前模型不可知——调用方可据此退化为"不过滤"（全局统计）。
 */
export function currentModelKey(api: TuiPluginApi, sid: string): string | null {
  try {
    const session = typeof api.state.session.get === "function" ? api.state.session.get(sid) : undefined
    const p = session?.model?.providerID
    const m = session?.model?.id
    if (p && m) return `${p}/${m}`
  } catch { /* fall through */ }
  try {
    const msgs = api.state.session.messages(sid) as Message[]
    for (let i = msgs.length - 1; i >= 0; i--) {
      const msg = msgs[i]
      if (msg.role !== "assistant") continue
      const k = modelKeyOf(msg as AssistantMessage)
      if (k) return k
    }
  } catch { /* fall through */ }
  return null
}

/** aggregatePerf 的可选过滤：modelKey 存在时只统计该模型归属的样本。 */
export interface PerfFilterOpts {
  modelKey?: string | null
}

/** 遍历 assistant 消息逐条采样（computePerfSample 唯一口径），聚合为中位数 PerfStats。 */
export function aggregatePerf(api: TuiPluginApi, msgs: readonly Message[], opts?: PerfFilterOpts): PerfStats {
  const filterKey = opts?.modelKey || undefined
  const ttfts: number[] = []
  const tpss: number[] = []
  const lats: number[] = []
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue
    const am = msg as AssistantMessage
    if (filterKey !== undefined && modelKeyOf(am) !== filterKey) continue
    let parts: readonly Part[] = []
    try { parts = api.state.part(am.id) } catch {}
    const sample = computePerfSample(am, parts)
    if (!sample) continue
    ttfts.push(sample.ttft)
    lats.push(sample.latency)
    if (sample.tps !== null) tpss.push(sample.tps)
  }
  return {
    ttftLast: ttfts.length ? ttfts[ttfts.length - 1] : null,
    tpsLast: tpss.length ? tpss[tpss.length - 1] : null,
    latLast: lats.length ? lats[lats.length - 1] : null,
    ttftMed: ttfts.length ? median(ttfts) : null,
    tpsMed: tpss.length ? median(tpss) : null,
    latMed: lats.length ? median(lats) : null,
    ttftN: ttfts.length,
    tpsN: tpss.length,
    hasPerf: ttfts.length > 0,
  }
}

// ── live (streaming) perf estimation ──
// usage 与 time.completed 仅在 step 结束时写入，流式期间从 part 增量实时估算：
//   TTFT = 首个内容 part 的 time.start − time.created（首个 part 到达前显示等待时长）
//   TPS  = Σ estimateTokens(text/reasoning + 已完成工具参数) / 纯生成时长
//          （含 reasoning，与精确口径同为全量方向：工具参数经 input/raw 估算
//            近似——pending 段无流式增量可估；estimateTokens 有估算误差，
//            显示时保留 "≈" 标记，step 结束后由精确值覆盖）
//   纯生成时长 = now − 首个 part start − 已完成工具区间并集（重叠去重、钳位到生成窗口）
//   工具相位：part pending/running、消息以 tool-calls/unknown 收尾（延续到下一步
//   prefill）均计入工具计时；工具恢复后速度与暂停前严格连续。
// 时钟：part 时间戳与 Date.now() 同机同钟，可直接相减。
export type LivePerf =
  | { phase: "prefill"; waitMs: number }                      // 首个内容 part 尚未到达
  | { phase: "streaming"; ttft: number; tps: number | null }  // 已有内容产出
  | { phase: "tool"; toolMs: number }                         // 工具运行/工具回合延续

// 单条消息内最后一次工具调用的 time.start（任意状态）
function lastToolStartOf(api: TuiPluginApi, m: AssistantMessage): number | undefined {
  let t: number | undefined
  let parts: readonly Part[] = []
  try { parts = api.state.part(m.id) } catch {}
  for (const p of parts) {
    if (p.type !== "tool") continue
    const ts = (p as { state?: { time?: { start?: number } } }).state?.time?.start
    if (typeof ts === "number" && (t === undefined || ts > t)) t = ts
  }
  return t
}

export function computeLivePerf(api: TuiPluginApi, sid: string): LivePerf | null {
  try {
    // status 仅作辅助排除（retry 等）：函数不存在时跳过，
    // 由下方消息状态（最后一条 assistant 未完成）承担流式判定
    try {
      const st = api.state.session.status?.(sid)
      if (st && st.type !== "busy") return null
    } catch {}
    const msgs = api.state.session.messages(sid) as Message[]
    let li = -1
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (msgs[i].role === "assistant") { li = i; break }
    }
    if (li < 0) return null
    const am = msgs[li] as AssistantMessage
    // 出错或压缩流 → 不做实时估算
    if (am.error || am.summary) return null
    const created = am.time?.created
    if (!created) return null
    let firstStart: number | undefined
    let estTok = 0
    let toolActive = false
    let toolStart: number | undefined
    let lastToolStart: number | undefined
    let toolIvs: [number, number][] | undefined
    let parts: readonly Part[] = []
    try { parts = api.state.part(am.id) } catch {}
    for (const p of parts) {
      if (p.type === "tool") {
        const ps = (p as { state?: { status?: string; time?: { start?: number; end?: number } } }).state
        const ts = ps?.time?.start
        if (typeof ts === "number" && (lastToolStart === undefined || ts > lastToolStart)) lastToolStart = ts
        if (ps?.status === "pending" || ps?.status === "running") {
          toolActive = true
          // 计时起点取最新活跃工具的 time.start；pending（参数仍在流式生成）
          // 时无 time，回退消息创建时刻兜底
          if (typeof ts === "number" && (toolStart === undefined || ts > toolStart)) toolStart = ts
        } else {
          // 已完成/出错工具：记录区间，循环后统一合并钳位再扣除，并把
          // 工具参数（tool_use 输入）计入估算分子，与精确侧全量口径一致；
          // pending 段参数无增量可估，仅计已落地 input/raw
          const t1 = ps?.time?.end
          if (typeof ts === "number" && ts > 0 && typeof t1 === "number" && t1 > ts) {
            toolIvs ??= []
            toolIvs.push([ts, t1])
          }
          const rawText = toolParamText(p)
          if (rawText) estTok += estimateTokens(rawText, "code")
        }
        continue
      }
      if (p.type !== "text" && p.type !== "reasoning") continue
      const tm = (p as { time?: { start?: number; end?: number } }).time
      const st = tm?.start
      if (typeof st === "number" && st > 0 && (firstStart === undefined || st < firstStart)) firstStart = st
      const txt = (p as { text?: unknown }).text
      if (typeof txt === "string" && txt) estTok += estimateTokens(txt, p.type === "reasoning" ? "thinking" : "answer")
    }
    const now = Date.now()
    // 工具运行中 → 显示工具计时（含纯工具调用消息）
    if (toolActive) {
      return { phase: "tool", toolMs: Math.max(0, now - (toolStart ?? created)) }
    }
    // 工具回合延续 ①：本条消息以工具调用收尾（finish=tool-calls/unknown，
    // 含纯工具 step 完成后的间隙）→ 从最后一次工具调用起连续计时
    if (lastToolStart !== undefined && (am.finish === "tool-calls" || am.finish === "unknown")) {
      return { phase: "tool", toolMs: Math.max(0, now - lastToolStart) }
    }
    // 工具回合延续 ②：本条是工具后的下一步等待（无内容产出、未完成），
    // 且上一条 assistant 消息以工具收尾 → 计时从上一条最后一次工具调用起算。
    // 跨回合边界（中间隔用户消息）不延续。
    if (firstStart === undefined && !am.time?.completed) {
      let prevFinish: string | undefined
      let prevToolStart: number | undefined
      for (let i = li - 1; i >= 0; i--) {
        if (msgs[i].role === "user") break
        if (msgs[i].role !== "assistant") continue
        const pm = msgs[i] as AssistantMessage
        prevFinish = typeof pm.finish === "string" ? pm.finish : undefined
        prevToolStart = lastToolStartOf(api, pm)
        break
      }
      if (prevFinish === "tool-calls" || prevFinish === "unknown") {
        const ts = prevToolStart ?? lastToolStart
        if (ts !== undefined) return { phase: "tool", toolMs: Math.max(0, now - ts) }
      }
      return { phase: "prefill", waitMs: Math.max(0, now - created) }
    }
    if (am.time?.completed) return null
    if (firstStart === undefined) return { phase: "prefill", waitMs: Math.max(0, now - created) }
    // 纯生成时长：已完成工具区间按 start 排序取并集（并行重叠去重），
    // 钳位到生成窗口 [firstStart, now]（首内容前执行的工具不计）后扣除
    const pausedMs = toolIvs ? mergedIntervalMs(toolIvs, firstStart) : 0
    const genMs = Math.max(0, now - firstStart - pausedMs)
    // 守卫：生成窗口 <LIVE_MIN_GEN_MS 或产出 <LIVE_MIN_TOK 时波动过大，不显示速度（首字照常显示）
    const tps = genMs >= LIVE_MIN_GEN_MS && estTok >= LIVE_MIN_TOK ? (estTok / genMs) * 1000 : null
    return { phase: "streaming", ttft: Math.max(0, firstStart - created), tps }
  } catch { return null }
}
