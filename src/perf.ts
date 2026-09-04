import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { estimateTokens, num } from "./tokens"

// ── performance (TTFT / TPS / latency) ──
// 在 opencode-throughput / opencode-tokenwatch 口径基础上的修正版：
//   TTFT   = 首个内容 part (text/reasoning) 的 time.start − message.time.created
//            （体感口径：含 DB 写、工具注册解析、git 快照、HTTP 建连与重试等待等
//             本地预处理开销，略大于 provider 报告的 TTFT）
//   净生成 = time.completed − 首个 part start − 工具执行窗口∩生成区间
//   TPS    = (output + reasoning − 工具参数token) / 净生成 × 1000
//            窗口从首个内容 part（含 reasoning）起算，覆盖思考+回答全程，
//            分子须含思考 token——opencode 的 tokens.output 已被
//            provider 侧扣除 reasoning（session.ts getUsage；Anthropic
//            例外整体在 output 里、reasoning 恒 0，加回 reasoning 同样正确），
//            只取 output 会把思考占比稀释成 1/3 级别的虚假低速（实测 10 vs 30+ tok/s）。
//   延迟   = time.completed − time.created − 工具执行窗口∩生成区间（净模型耗时）
// 修正点（与 throughput/tokenwatch 的差异）：
//   1. 取最早的 part 时间而非最后一个，避免把后续 part 误当首个而高估 TTFT（tokenwatch）
//   2. opencode 的 time.completed 在流 drain 完（含工具执行产出 tool-result）后才写入，
//      故按 tool part 的 state.time.start/end（区间合并去重）扣除工具等待，
//      工具密集的 step 不再拉低 TPS / 拉高延迟；首内容前的服务端工具时间计入 TTFT
//   3. 压缩（summary）消息与纯工具 step（无内容 part）不计入样本
//   4. 小步噪声守卫（生成窗口 <500ms 时时间戳噪声占比过大，实测 50ms 级
//      小步 TPS 虚高至 1500+）与缓冲网关守卫（<0.2ms/token，非流式瞬间
//      吐出）触发时 TPS 记 null 而非输出虚高值，聚合按有效子集计数
//      （ttftN / tpsN），null 样本不进入 tpsMed
//   5. 采样逻辑单一实现 computePerfSample，侧边栏累计与 hint 栏 lastTps 共用
//      （曾因 hint 栏独立副本漏加 reasoning 分子、漏扣工具区间，同屏差 4 倍）
//   6. 工具参数 token（estimateTokens(state.raw/input, "code")）从分子扣除。
//      两段源码事实（1.18 AI SDK 流，opencode server 验证）：
//      (a) tool part 的 state.time.start 打在 tool-call 事件（参数 JSON
//          流式生成完毕并解析后，processor.ts），end 打在 tool-result——
//          即 [start,end] 为纯工具执行窗口，参数流式生成期恰在窗口之外、
//          无任何 part 时间戳标记；
//      (b) 部分 provider 路由（实测 z-ai/glm-5.3-flash @ OpenRouter）把
//          工具参数作为整块 chunk 一次性到达（tool-call 紧贴文本结束，无
//          tool-input delta 时序）——参数 token 的大幅解码耗时并未反映在
//          [fs, completed] 窗口中，仅 count 在 usage.output 里。
//      两者叠加导致：分母已扣除执行窗口，却仍含"参数流式生成期"（a）或
//      "参数整包瞬时到达"（b），而分子若保留参数 token 则带工具 step 显著
//      虚高（本会话实测单步 431/227 tok/s，同期实时估算仅 48/28）。扣除参数
//      token 后口径 = 流式可见 token 的生成速度，与实时估算（只扫
//      text/reasoning 部分、工具相位不显示速度）一致；参数生成期被算入
//      分母的时间残差对文本型 step 影响 <5%（参数占比小时自然衰减）。
//      注（曾推倒又修正）：此前某版曾假设"窗口覆盖参数生成+执行"，据以将
//      分子保留参数——与 (a)(b) 的实测时序不符，已按本款回退。
// 状态驱动：消息与 part 的时间戳持久化在数据库中，直接响应式推导——
// 历史会话与子代理会话自动生效，无需事件监听、缓存或文件日志。

// 小步噪声守卫：生成窗口 <500ms 时 completed 等时间戳的噪声占比过大，TPS
// 不可信（实测 50ms 级小步虚高至 1500+）→ 记 null。与实时口径对齐（LIVE_MIN_GEN_MS）。
export const MIN_GEN_MS = 500
// 缓冲网关守卫：每 token 耗时 <0.2ms（非流式瞬间吐出）时 TPS 不可信 → 记 null。
export const BUFFER_MS_PER_TOKEN = 0.2
// 实时估算守卫：生成窗口 <500ms 或产出 <8 token 时波动过大，不显示速度。
export const LIVE_MIN_GEN_MS = 500
export const LIVE_MIN_TOK = 8

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
 * 与 dist.ts 扫描口径一致；序列化抛错（循环引用等）按空串处理。
 */
function toolParamText(p: Part): string {
  const st = (p as { state?: { raw?: unknown; input?: unknown } }).state
  try {
    if (typeof st?.raw === "string" && st.raw) return st.raw
    return st?.input != null ? JSON.stringify(st.input) : ""
  } catch { return "" }
}

// ── 单条 assistant 消息的性能样本（精确口径唯一实现）──
// 侧边栏「性能」累计与 hint 栏 lastTps 共用，杜绝双源漂移（历史上 hint 栏
// 的独立副本漏加 reasoning 分子、漏扣工具区间，显示值差 4 倍以上）。
// 条件：已完成、无错误、非压缩、产出 token>0、有内容 part 且首 part 晚于创建。
// 返回 null 表示不计入样本。
export function computePerfSample(
  am: AssistantMessage,
  parts: readonly Part[],
): PerfSample | null {
  const created = am.time?.created
  const completed = am.time?.completed
  if (!created || !completed || am.error || am.summary) return null
  // 产出 = output + reasoning（思考 token），与分母窗口（含思考段）口径对齐
  const outputTok = num(am.tokens?.output)
  const reasoningTok = num(am.tokens?.reasoning)
  const genTok = outputTok + reasoningTok
  if (genTok <= 0) return null
  // 首个内容 part (text/reasoning) 的开始时间 = 首 token 到达时刻，取最早值；
  // 工具执行窗口 [start, end] 列表（completed/error 才有完整时间）；
  // 工具参数 token 累计：state.time.start 打在参数流式生成完毕之后（tool-call
  // 事件），且部分 router 参数整包瞬时到达——参数解码时长不可观测（见头部
  // 修正点 6），分子扣除参数 token 以对齐"流式可见 token 速度"口径。
  let firstStart: number | undefined
  let toolIvs: [number, number][] | null = null
  let paramTok = 0
  for (const p of parts) {
    if (p.type === "tool") {
      const tw = (p as any).state?.time
      if (typeof tw?.start === "number" && tw.start > 0 && typeof tw.end === "number" && tw.end > tw.start) {
        toolIvs ??= []
        toolIvs.push([tw.start, tw.end])
      }
      const raw = toolParamText(p)
      if (raw) paramTok += estimateTokens(raw, "code")
      continue
    }
    if (p.type !== "text" && p.type !== "reasoning") continue
    const st = (p as any).time?.start
    if (typeof st === "number" && st > 0 && (firstStart === undefined || st < firstStart)) firstStart = st
  }
  if (firstStart === undefined || firstStart <= created) return null
  // 参数 token 占满产出（write 大文档等纯参数 step 或估算偏差）：产出不可见
  // token 为 0 → 匀速测算无意义，TPS 记 null（TTFT/延迟继续有效，见守卫注释）
  const visTok = genTok - paramTok
  const fs = firstStart
  // 合并工具执行窗口（并行工具区间重叠），扣除与生成区间的交集。
  // 注意：这里钳位到 [fs, completed]，即首内容前的工具时间不参与扣减——
  // 它被计入 TTFT（体感口径）；latency 也因此与 TTFT 保持同一扣减基准。
  // 若需严格“净模型耗时”，应改用 [created, completed] 钳位，当前为有意约定。
  // 已知偏差：[start,end] 为纯执行窗口；参数生成期无时间戳（含在延迟与
  // 净生成内，体感口径），TTFT 同基准。
  const toolMs = toolIvs ? mergedIntervalMs(toolIvs, fs, completed) : 0
  const ttft = fs - created
  const genMs = Math.max(0, completed - fs - toolMs)
  const latency = Math.max(0, completed - created - toolMs)
  // 守卫（小步噪声 + 缓冲网关 + 可见产出)任一触发：TPS 记 null，ttft/latency 照常返回
  const tps = visTok > 0 && genMs >= Math.max(MIN_GEN_MS, visTok * BUFFER_MS_PER_TOKEN) ? (visTok / genMs) * 1000 : null
  return { ttft, tps, latency }
}

// ── 会话级性能聚合（侧边栏「性能」区消费）──
// PerfStats 形状从 index.tsx 迁入：聚合与采样同属精确口径，单文件单来源，
// 并可被 tests/perf.test.ts 直接单测（替代易漂移的手工镜像）。
// 聚合用中位数而非均值：会话常跨模型/跨路由（均值被高速段与离群短步拉偏，
// 实测单模型会话 44→52、多模型会话 30→37+），中位数与体感一致且抗离群；
// 偶数样本取中间两值平均。数组随聚合重建（10Hz 节流下 O(n log n) 可忽略），
// KV 快照只存聚合结果不存原始样本。
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

/** 遍历 assistant 消息逐条采样（computePerfSample 唯一口径），聚合为中位数 PerfStats。 */
export function aggregatePerf(api: TuiPluginApi, msgs: readonly Message[]): PerfStats {
  const ttfts: number[] = []
  const tpss: number[] = []
  const lats: number[] = []
  for (const msg of msgs) {
    if (msg.role !== "assistant") continue
    const am = msg as AssistantMessage
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
// usage 与 time.completed 仅在 step 结束时写入，精确值只能事后显示；
// 流式期间从 part 增量实时估算，让长时间思考阶段也有速度可看：
//   TTFT：首个内容 part (text/reasoning) 的 time.start − time.created
//         （真实首 delta 时间戳，非估算；首个 part 到达前显示等待时长）
//   TPS：Σ estimateTokens(text/reasoning part 累积文本) / 纯生成时长
//         含 reasoning 字符（思考阶段也有速度可读），与结束后精确口径
//         （(output+reasoning)/净生成，同样含思考 token）一致，仅剩
//         estimateTokens 的估算误差——按 part 形态分档校准（reasoning 走
//         "thinking" 密度、text 走 "answer" 密度，见 src/tokens.ts 的实测
//         依据），残余 ~±5%，故显示时保留 "≈" 标记，step 结束后由精确口径覆盖。
//   纯生成时长：now − 首个 part start − 已完成工具区间并集（并行重叠去重、
//         钳位到生成窗口）。工具在 LLM 流内执行（含 question 等待作答）：
//         工具 part 处于 pending/running 期间模型不产出 token，恢复生成后
//         窗口已扣除全部工具暂停 → 速度与暂停前严格连续，不被工具耗时稀释。
//   工具相位：1.18 每个 step 是独立 assistant 消息，工具跑完该消息立即写
//         completed（finish=tool-calls），下一步再建新消息等待 LLM——亚秒级
//         工具的 running 窗口一闪而过，肉眼可见的是"工具结束→新内容"的间隙
//         与下一步 prefill。因此工具相位除 part pending/running 外，还延续到
//         本条消息以 tool-calls/unknown 收尾、以及工具后的下一步 prefill
//         （上一条以 tool-calls 收尾且跨回合边界不延续），计时统一从最后一
//         次工具调用的 time.start 连续累计，新内容到达后回到 streaming。
// 时钟：part 时间戳与 Date.now() 同机同钟（本地 server），可直接相减。
export type LivePerf =
  | { phase: "prefill"; waitMs: number }                      // 首个内容 part 尚未到达
  | { phase: "streaming"; ttft: number; tps: number | null }  // 已有内容产出
  | { phase: "tool"; toolMs: number }                         // 工具运行/工具回合延续

// 单条消息内最后一次工具调用的 time.start（任意状态）
export function lastToolStartOf(api: TuiPluginApi, m: AssistantMessage): number | undefined {
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
          // 计时起点取最新活跃工具的 time.start；缺失时回退消息创建时刻
          if (typeof ts === "number" && (toolStart === undefined || ts > toolStart)) toolStart = ts
        } else {
          // 已完成/出错工具：记录区间，循环后统一合并钳位再扣除
          const t1 = ps?.time?.end
          if (typeof ts === "number" && ts > 0 && typeof t1 === "number" && t1 > ts) {
            toolIvs ??= []
            toolIvs.push([ts, t1])
          }
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
