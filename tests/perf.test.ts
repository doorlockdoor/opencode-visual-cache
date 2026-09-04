import assert from "node:assert/strict"
import { estimateTokens, num } from "../src/tokens"
import { computePerfSample, computeLivePerf, aggregatePerf } from "../src/perf"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, Message } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"

// ── estimateTokens ─────────────────────────────────────────────────────────

assert.equal(estimateTokens(""), 0)
assert.equal(estimateTokens("hello"), 2) // 5 ASCII / 3.3 → ceil 2
assert.equal(estimateTokens("你好"), 2) // 2 汉字 / 1.5 → ceil 2
assert.equal(estimateTokens("你好世界"), 3) // 4 汉字 / 1.5 → ceil 3
assert.equal(estimateTokens("你好abc"), 3) // 2 汉字/1.5 + 3 ASCII/3.3 → ceil 3
assert.equal(estimateTokens("かな"), 2) // 假名按 1 字/token（与汉字区分）
assert.equal(estimateTokens("{}"), 1) // 无 "key": 不判 JSON，按 prose 2/3.3 → 1
assert.equal(estimateTokens('{"a":1}'), 2) // JSON：7 ASCII / 3.7 → 2
assert.equal(estimateTokens("import x from 'y'"), 5) // code：17 ASCII / 3.7 → 5
// profile 分档：reasoning("thinking") / text("answer") / tool("code")
assert.equal(estimateTokens("hello world", "thinking"), 3) // 11 ASCII / 4.0 → 3
assert.equal(estimateTokens("hello world", "answer"), 4) // 11 ASCII / 3.0 → 4
assert.equal(estimateTokens("你好abc", "answer"), 3) // 2/1.5 + 3/3.0 → 3
assert.equal(estimateTokens('{"cmd":"x"}', "code"), 3) // code 档不检测形态，11 ASCII / 3.7 → 3

// ── num ────────────────────────────────────────────────────────────────────

assert.equal(num(1.5), 1.5)
assert.equal(num(NaN), 0)
assert.equal(num("3"), 0)
assert.equal(num(undefined), 0)

// ── computePerfSample helpers ──────────────────────────────────────────────

function am(overrides: Record<string, unknown> = {}): AssistantMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 1000, completed: 3000 },
    parentID: "p1",
    modelID: "model",
    providerID: "prov",
    mode: "default",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as unknown as AssistantMessage
}

function textPart(start: number, text = "x"): Part {
  return { id: "t", sessionID: "s1", messageID: "m1", type: "text", text, time: { start } } as unknown as Part
}

function reasoningPart(start: number, text = "x"): Part {
  return { id: "r", sessionID: "s1", messageID: "m1", type: "reasoning", text, time: { start } } as unknown as Part
}

function toolPart(start: number, end: number, raw?: string): Part {
  return {
    id: "tl",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    callID: "c",
    tool: "bash",
    state: { status: "completed", time: { start, end }, ...(raw !== undefined ? { raw } : {}) },
  } as unknown as Part
}

// ── computePerfSample tests ────────────────────────────────────────────────

const basic = computePerfSample(am(), [textPart(1500)])!
assert.equal(basic.ttft, 500)
assert.equal(basic.latency, 2000)
assert.ok(Math.abs(basic.tps! - 100 / 1.5) < 1e-9) // 100 tok / 1500ms × 1000

// 分子含 reasoning
const withReasoning = computePerfSample(am({ tokens: { input: 10, output: 100, reasoning: 50, cache: { read: 0, write: 0 } } }), [textPart(1500)])!
assert.ok(Math.abs(withReasoning.tps! - 100) < 1e-9) // 150 tok / 1500ms

// 工具区间扣除
const withTool = computePerfSample(
  am({ time: { created: 1000, completed: 4000 }, tokens: { input: 10, output: 150, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1500), toolPart(2000, 3000)],
)!
assert.equal(withTool.ttft, 500)
assert.equal(withTool.latency, 2000)
assert.ok(Math.abs(withTool.tps! - 100) < 1e-9) // 150 / 1500ms

// 分子扣除工具参数 token（state.raw 37 ASCII → code 档 10 tok）：150−10=140 / 1500ms
const withParam = computePerfSample(
  am({ time: { created: 1000, completed: 4000 }, tokens: { input: 10, output: 150, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1500), toolPart(2000, 3000, "a".repeat(37))],
)!
assert.ok(Math.abs(withParam.tps! - 140 / 1.5) < 1e-9)

// state.input 回退序列化：{"content":"x"*74} 88 chars → ceil(88/3.7)=24 tok → 126/1500ms
const withInput = computePerfSample(
  am({ time: { created: 1000, completed: 4000 }, tokens: { input: 10, output: 150, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1500), { ...toolPart(2000, 3000), state: { status: "completed", time: { start: 2000, end: 3000 }, input: { content: "x".repeat(74) } } } as unknown as Part],
)!
assert.ok(Math.abs(withInput.tps! - 126 / 1.5) < 1e-9)

// 真实流语义：参数在 [text.start, tool.start] 无时间戳段生成（不在工具窗口内），
// 工具窗口 [2600,3000] 为纯执行 → genMs = 4000−1500−400 = 2100；(150−10)/2.1 ≈ 66.7
const realWindow = computePerfSample(
  am({ time: { created: 1000, completed: 4000 }, tokens: { input: 10, output: 150, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1500), toolPart(2600, 3000, "a".repeat(37))],
)!
assert.equal(realWindow.ttft, 500)
assert.equal(realWindow.latency, 2600)
assert.ok(Math.abs(realWindow.tps! - 140 / 2.1) < 1e-9)

// 并行重叠工具区间去重
const overlapping = computePerfSample(
  am({ time: { created: 1000, completed: 4000 }, tokens: { input: 10, output: 150, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1500), toolPart(2000, 3000), toolPart(2500, 3500)],
)!
assert.equal(overlapping.latency, 1500) // 合并后工具窗口 1500ms，4000-1000-1500

// 缓冲网关 → tps null（ttft/latency 仍有值）
const buffered = computePerfSample(
  am({ time: { created: 1000, completed: 1005 }, tokens: { input: 10, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1001)],
)!
assert.equal(buffered.tps, null)
assert.equal(buffered.ttft, 1)
assert.equal(buffered.latency, 5)

// 不计入样本的各类情况
assert.equal(computePerfSample(am({ summary: true }), [textPart(1500)]), null)
assert.equal(computePerfSample(am({ error: { name: "UnknownError", data: { message: "x" } } }), [textPart(1500)]), null)
assert.equal(computePerfSample(am({ tokens: { input: 10, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }), [textPart(1500)]), null)
assert.equal(computePerfSample(am(), [toolPart(2000, 3000)]), null) // 无内容 part
assert.equal(computePerfSample(am(), [textPart(1000)]), null) // firstStart <= created

// 小步噪声守卫（genMs <500ms）：旧口径此类步虚高至 1500+，现 TPS 记 null（ttft/latency 保留）
const tinyStep = computePerfSample(
  am({ time: { created: 1000, completed: 1223 } }),
  [textPart(1100), toolPart(1150, 1200)],
)!
assert.equal(tinyStep.tps, null)
assert.equal(tinyStep.ttft, 100)
assert.equal(tinyStep.latency, 173)

// 参数远大于内容产出（如 write 大文档）：分子扣除后 visTok ≤ 0 → TPS 记 null；
// 样本保留（TTFT/延迟照常有效，不被稀释进均值）
const bigParam = computePerfSample(
  am({ tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 0, write: 0 } } }),
  [textPart(1500), toolPart(2000, 3000, "a".repeat(37))],
)!
assert.equal(bigParam.tps, null)
assert.equal(bigParam.ttft, 500)
assert.equal(bigParam.latency, 1000) // 3000−1000−1000

// ── aggregatePerf（侧边栏聚合，perf.ts 单一来源）───────────────────────────

// 两条有效样本 → 中位数（偶数取中间两值平均）
{
  const m1 = am() // ttft 500 / tps 66.7 / lat 2000
  const m2 = am({ id: "m2", time: { created: 5000, completed: 6000 }, tokens: { input: 5, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } })
  const api = makeApi({
    messages: () => [],
    parts: (mid) => (mid === "m1" ? [textPart(1500)] : mid === "m2" ? [textPart(5500)] : []),
  })
  const perf = aggregatePerf(api, [m1, m2] as unknown as Message[])
  assert.equal(perf.ttftN, 2)
  assert.equal(perf.ttftMed, 500)
  assert.equal(perf.tpsN, 2)
  assert.ok(Math.abs(perf.tpsMed! - (100 / 1.5 + 400) / 2) < 1e-9) // m2: 200 tok / 500ms
  assert.equal(perf.tpsLast, 400)
  assert.equal(perf.latLast, 1000)
  assert.equal(perf.hasPerf, true)
}

// 三条样本 → 中位数 ≠ 均值（200/400/1800 → 中位 400，均值 800）
{
  const msgs = [
    am({ id: "a", time: { created: 1000, completed: 1600 }, tokens: { input: 1, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } }),
    am({ id: "b", time: { created: 2000, completed: 2600 }, tokens: { input: 1, output: 200, reasoning: 0, cache: { read: 0, write: 0 } } }),
    am({ id: "c", time: { created: 3000, completed: 3600 }, tokens: { input: 1, output: 900, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ]
  const api = makeApi({
    messages: () => [],
    parts: (mid) => [textPart(mid === "a" ? 1100 : mid === "b" ? 2100 : 3100)],
  })
  const perf = aggregatePerf(api, msgs as unknown as Message[])
  // 各步生成窗口均 500ms（≥MIN_GEN_MS）→ a:200 / b:400 / c:1800 tok/s
  assert.equal(perf.tpsN, 3)
  assert.equal(perf.tpsMed, 400) // 中位数
  assert.ok(Math.abs(perf.tpsLast! - 1800) < 1e-9)
  assert.equal(perf.ttftMed, 100) // 三条 ttft 均 100
}

// 压缩/纯工具不计入；守卫只剔除 tps，不进入中位数
{
  const valid = am()
  const skipped = am({ id: "m2", summary: true })
  const buffered = am({ id: "m3", time: { created: 1000, completed: 1005 }, tokens: { input: 1, output: 10, reasoning: 0, cache: { read: 0, write: 0 } } })
  const api = makeApi({
    messages: () => [],
    parts: (mid) => (mid === "m1" ? [textPart(1500)] : mid === "m3" ? [textPart(1001)] : []),
  })
  const perf = aggregatePerf(api, [valid, skipped, buffered] as unknown as Message[])
  assert.equal(perf.ttftN, 2) // summary 不计；buffered 仍计 ttft/latency
  assert.equal(perf.tpsN, 1) // buffered 的 tps 为 null，不计入
  assert.ok(Math.abs(perf.tpsMed! - 100 / 1.5) < 1e-9)
  assert.equal(perf.ttftLast, 1)
  assert.equal(perf.hasPerf, true)
}

// ── computeLivePerf helpers ────────────────────────────────────────────────

interface ApiOpts {
  status?: (sid: string) => { type: string } | undefined
  messages: (sid: string) => Message[]
  parts: (mid: string) => Part[]
}

function makeApi(opts: ApiOpts): TuiPluginApi {
  return {
    state: {
      session: {
        status: opts.status,
        messages: opts.messages,
      },
      part: opts.parts,
    },
  } as unknown as TuiPluginApi
}

function liveAm(overrides: Record<string, unknown> = {}): AssistantMessage {
  return {
    id: "m1",
    sessionID: "s1",
    role: "assistant",
    time: { created: 1000 },
    parentID: "p1",
    modelID: "model",
    providerID: "prov",
    mode: "default",
    agent: "build",
    path: { cwd: "/", root: "/" },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  } as unknown as AssistantMessage
}

function runningToolPart(start: number): Part {
  return {
    id: "tl",
    sessionID: "s1",
    messageID: "m1",
    type: "tool",
    callID: "c",
    tool: "bash",
    state: { status: "running", time: { start } },
  } as unknown as Part
}

// ── computeLivePerf tests ──────────────────────────────────────────────────

// streaming：首字精确 + 估算速度
{
  const longText = "a".repeat(40) // answer 档估算 = 40/3.0 → ceil 14
  const api = makeApi({
    status: () => ({ type: "busy" }),
    messages: () => [liveAm()],
    parts: () => [textPart(1500, longText)],
  })
  const origNow = Date.now
  Date.now = () => 4000
  try {
    const lv = computeLivePerf(api, "s1")
    assert.ok(lv && lv.phase === "streaming")
    if (lv && lv.phase === "streaming") {
      assert.equal(lv.ttft, 500)
      assert.ok(Math.abs(lv.tps! - 5.6) < 1e-9) // 14 tok / 2500ms × 1000
    }
  } finally {
    Date.now = origNow
  }
}

// prefill：首个内容 part 未到达 → 显示等待时长
{
  const api = makeApi({ status: () => ({ type: "busy" }), messages: () => [liveAm()], parts: () => [] })
  const origNow = Date.now
  Date.now = () => 2000
  try {
    const lv = computeLivePerf(api, "s1")
    assert.ok(lv && lv.phase === "prefill" && lv.waitMs === 1000)
  } finally {
    Date.now = origNow
  }
}

// tool：工具运行中 → 工具计时
{
  const api = makeApi({ status: () => ({ type: "busy" }), messages: () => [liveAm()], parts: () => [runningToolPart(2000)] })
  const origNow = Date.now
  Date.now = () => 3000
  try {
    const lv = computeLivePerf(api, "s1")
    assert.ok(lv && lv.phase === "tool" && lv.toolMs === 1000)
  } finally {
    Date.now = origNow
  }
}

// tool 回合延续 ①：本条消息以 tool-calls 收尾
{
  const done = liveAm({ time: { created: 1000, completed: 3000 }, finish: "tool-calls" })
  const api = makeApi({ status: () => ({ type: "busy" }), messages: () => [done], parts: () => [toolPart(1500, 2000)] })
  const origNow = Date.now
  Date.now = () => 4000
  try {
    const lv = computeLivePerf(api, "s1")
    assert.ok(lv && lv.phase === "tool" && lv.toolMs === 2500)
  } finally {
    Date.now = origNow
  }
}

// tool 回合延续 ②：工具后的下一步 prefill（上一条以 tool-calls 收尾）
{
  const prev = liveAm({ id: "m0", time: { created: 500, completed: 1500 }, finish: "tool-calls" })
  const cur = liveAm({ id: "m1", time: { created: 1000 } })
  const api = makeApi({
    status: () => ({ type: "busy" }),
    messages: () => [prev, cur],
    parts: (mid) => (mid === "m0" ? [toolPart(1200, 1400)] : []),
  })
  const origNow = Date.now
  Date.now = () => 4000
  try {
    const lv = computeLivePerf(api, "s1")
    assert.ok(lv && lv.phase === "tool" && lv.toolMs === 2800) // 4000 - 1200
  } finally {
    Date.now = origNow
  }
}

// idle / retry → null（回落宿主 Slot）
assert.equal(computeLivePerf(makeApi({ status: () => ({ type: "idle" }), messages: () => [liveAm()], parts: () => [] }), "s1"), null)
assert.equal(computeLivePerf(makeApi({ status: () => ({ type: "retry" }), messages: () => [liveAm()], parts: () => [] }), "s1"), null)

console.log("perf tests passed")
