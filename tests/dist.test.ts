import assert from "node:assert/strict"
import { collectTokenDist, collectRoundUsage, distFingerprint } from "../src/dist"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { AssistantMessage, UserMessage } from "@opencode-ai/sdk"
import type { Part } from "@opencode-ai/sdk/v2"
import { estimateTokens } from "../src/tokens"

// ── fixtures ───────────────────────────────────────────────────────────────

function fakeApi(partsByMsg: Record<string, Part[]>, config: Record<string, unknown> = {}): TuiPluginApi {
  return { state: { part: (id: string) => partsByMsg[id] ?? [], config } } as unknown as TuiPluginApi
}

function userMsg(id: string, overrides: Record<string, unknown> = {}): UserMessage {
  return {
    id, sessionID: "s1", role: "user", time: { created: 1000 },
    ...overrides,
  } as unknown as UserMessage
}

function assMsg(id: string, overrides: Record<string, unknown> = {}): AssistantMessage {
  return {
    id, sessionID: "s1", role: "assistant", time: { created: 2000, completed: 4000 },
    parentID: "p1", modelID: "model", providerID: "prov", mode: "default", agent: "build",
    path: { cwd: "/", root: "/" }, cost: 0,
    tokens: { input: 10, output: 100, reasoning: 50, cache: { read: 0, write: 0 } },
    ...overrides,
  } as unknown as AssistantMessage
}

function textPart(mid: string, text: string, flags: Record<string, unknown> = {}): Part {
  return { id: `t-${mid}-${text.length}`, sessionID: "s1", messageID: mid, type: "text", text, ...flags } as unknown as Part
}

function toolPart(mid: string, state: Record<string, unknown>): Part {
  return {
    id: `tl-${mid}-${state.status}-${(state.output as string | undefined)?.length ?? 0}`,
    sessionID: "s1", messageID: mid, type: "tool", callID: "c", tool: "bash",
    state: { status: "completed", time: { start: 2500, end: 3000 }, ...state },
  } as unknown as Part
}

// ── 扫描正确性 ─────────────────────────────────────────────────────────────

{
  const raw = '{"cmd":"ls"}'
  const parts: Record<string, Part[]> = {
    u1: [
      textPart("u1", "hello world"),
      textPart("u1", "synthetic text", { synthetic: true }), // 跳过
      { id: "f1", sessionID: "s1", messageID: "u1", type: "file", source: { text: { value: "file content" } } } as unknown as Part,
    ],
    a1: [toolPart("a1", { raw, output: "STDOUT" })],
  }
  const api = fakeApi(parts, { agent: { build: { prompt: "AGENTSYS" } } })
  const msgs = [
    userMsg("u1", { system: "USERSYS" }),
    assMsg("a1"),
  ] as never[]
  const { dist, hasDistData, skills } = collectTokenDist(api, msgs, { agent: "build" })
  assert.equal(dist.system, estimateTokens("AGENTSYS") + estimateTokens("USERSYS"))
  assert.equal(dist.user, estimateTokens("hello world") + estimateTokens("file content"))
  assert.equal(dist.toolCall, estimateTokens(raw))
  assert.equal(dist.toolResult, estimateTokens("STDOUT"))
  assert.equal(dist.output, 100) // API 精确 tokens，不走 estimateTokens
  assert.equal(dist.reasoning, 50)
  assert.deepEqual(skills, [])
  assert.equal(hasDistData, true)
}

// JSON.stringify 兜底（无 state.raw）
{
  const input = { command: "echo hi" }
  const api = fakeApi({ a1: [toolPart("a1", { input, output: "" })] })
  const { dist } = collectTokenDist(api, [assMsg("a1")] as never[], undefined)
  assert.equal(dist.toolCall, estimateTokens(JSON.stringify(input)))
  assert.equal(dist.toolResult, 0) // output 空
}

// ── 指纹与缓存失效 ─────────────────────────────────────────────────────────

// assistant text part 流式增长 → 指纹不变（text 不参与分布，不应触发重扫）
{
  const tp = textPart("a1", "x")
  const parts: Record<string, Part[]> = { a1: [tp, toolPart("a1", { raw: "raw" })] }
  const api = fakeApi(parts)
  const m = [assMsg("a1")] as never[]
  const fp0 = distFingerprint(m[0] as AssistantMessage, parts.a1)
  ;(tp as unknown as { text: string }).text = "x".repeat(50_000) // 模拟流式 delta
  assert.equal(distFingerprint(m[0] as AssistantMessage, parts.a1), fp0, "assistant text 增长不应改变指纹")
  const r1 = collectTokenDist(api, m, undefined)
  const r2 = collectTokenDist(api, m, undefined)
  assert.equal(r2.dist.toolCall, r1.dist.toolCall) // 缓存复用，结果一致
}

// user text 增长 → 指纹变化 → 重扫（数值更新）
{
  const tp = textPart("u1", "short")
  const parts: Record<string, Part[]> = { u1: [tp] }
  const api = fakeApi(parts)
  const m = [userMsg("u1")] as never[]
  const r1 = collectTokenDist(api, m, undefined)
  assert.equal(r1.dist.user, estimateTokens("short"))
  ;(tp as unknown as { text: string }).text = "short and now much longer"
  const r2 = collectTokenDist(api, m, undefined)
  assert.equal(r2.dist.user, estimateTokens("short and now much longer"))
}

// tool 完成（pending/running → completed + output + time.end）→ 指纹变化 → 重扫
{
  const tp = toolPart("a1", { status: "running", time: { start: 2500 } })
  const parts: Record<string, Part[]> = { a1: [tp] }
  const api = fakeApi(parts)
  const m = [assMsg("a1")] as never[]
  assert.equal(collectTokenDist(api, m, undefined).dist.toolResult, 0)
  const ps = (tp as unknown as { state: Record<string, unknown> }).state
  ps.status = "completed"
  ps.output = "RESULT"
  ;(ps.time as Record<string, unknown>).end = 3000
  assert.equal(collectTokenDist(api, m, undefined).dist.toolResult, estimateTokens("RESULT"))
}

// ── skill 跨消息保留最大 token 数 ──────────────────────────────────────────

{
  const parts = {
    a1: [toolPart("a1", { tool: "skill", output: "short", metadata: { name: "foo" } })],
    a2: [toolPart("a2", { tool: "skill", output: "x".repeat(500), metadata: { name: "foo" } })],
  }
  // toolPart 固定 tool: "bash" — 覆写
  ;(parts.a1[0] as unknown as { tool: string }).tool = "skill"
  ;(parts.a2[0] as unknown as { tool: string }).tool = "skill"
  const api = fakeApi(parts)
  const { skills } = collectTokenDist(api, [assMsg("a1"), assMsg("a2")] as never[], undefined)
  assert.equal(skills.length, 1)
  assert.equal(skills[0].name, "foo")
  assert.equal(skills[0].tokens, estimateTokens("x".repeat(500))) // 取最大
}

// ── hasDistData 门控 ───────────────────────────────────────────────────────

{
  const api = fakeApi({})
  const { dist, hasDistData } = collectTokenDist(api, [
    assMsg("a1", { tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
  ] as never[], undefined)
  assert.equal(dist.system + dist.user + dist.agent + dist.toolCall + dist.toolResult + dist.output + dist.reasoning, 0)
  assert.equal(hasDistData, false)
}

// ── collectRoundUsage ──────────────────────────────────────────────────────

{
  const stepPart = (mid: string, cost: number) =>
    ({ id: `sf-${mid}-${cost}`, sessionID: "s1", messageID: mid, type: "step-finish", cost }) as unknown as Part
  const parts = {
    a0: [stepPart("a0", 9)],
    a2: [stepPart("a2", 0), stepPart("a2", 5)], // 首个有限值胜出：cost=0 合法
  }
  const api = fakeApi(parts)
  const msgs = [
    assMsg("a0", { parentID: "p0", tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }),
    assMsg("a1"),                                        // 无 tokens → 不作 lastAssMsg
    assMsg("a2", { tokens: { input: 100, output: 30, reasoning: 0, cache: { read: 20, write: 0 } } }),
    userMsg("u2"),                                       // 非 assistant → 链回溯跳过
  ] as never[]
  const u = collectRoundUsage(api, msgs)
  assert.equal(u.apiInput, 120) // 100 + 20（最后一条有数据消息 = a2）
  assert.equal(u.apiOutput, 30)
  assert.equal(u.stepCount, 2)  // p1 链（a2 贡献 2，a1 无 step parts）；a0 属 p0，异 parentID 处 break，其 stepPart(9) 不计
  assert.equal(u.stepCost, 0)   // 第一个有限 cost（0）胜出，而非后面的 5
}

console.log("dist tests passed")
