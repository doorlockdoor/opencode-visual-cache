// ═══════════════════════════════════════════════════════════════════════════
// token 估算与采样吞吐基准 —— estimateTokens 扫描成本 + 精确采样路径成本
// ═══════════════════════════════════════════════════════════════════════════
//
// 【简介】
// estimateTokens 是全插件 token 估算的成本下限（分布扫描与
// 实时估算都建在它之上）；computePerfSample / aggregatePerf 只读时间戳、
// 不扫文本，代表精确采样的成本上限承诺。本脚本记录两者的吞吐基线，
// 采样项若从 µs 变 ms 即回退信号。
//
// 【如何执行】
//   npm run bench:tokens      # 仅本脚本
//   npm run bench             # 全部基准（dist + tokens）
//
// 【参考量级】（Node 24 / Win11，2026-09；仅作数量级锚点，勿作绝对断言）
//   estimateTokens(1MB ASCII)  ≈ 10ms     （ASCII 3.5-4 字符/token）
//   estimateTokens(1MB CJK)    ≈ 5.4ms    （汉字 1.5 字/token——CJK 项比
//                                           ASCII 项便宜是 1.5 比率生效的标志，
//                                           若反超说明比率改动回退了）
//   computePerfSample(20 parts)            ≈ 0.001ms
//   aggregatePerf(100 msgs)                ≈ 0.03ms
//
// 【与其他基准的关系】benchmarks/dist-bench.mts 的"冷启动/旧基线"数字
// ≈ 本脚本 estimateTokens 吞吐 × dist-bench 夹具文本量（~3MB → ~20ms），
// 两者互相印证；dist-bench 关注缓存/管线层，本脚本关注字符扫描层。
import { estimateTokens } from "../src/tokens"
import { computePerfSample, aggregatePerf } from "../src/perf"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

// 1MB ASCII（工具输出形态）与 1MB CJK（中文思考形态）
const ascii1MB = "a".repeat(1_000_000)
const cjk1MB = "中".repeat(500_000) // 50 万汉字 = 100 万 UTF-16 码元

function bench(name: string, fn: () => void, n: number) {
  fn() // 预热
  const t0 = performance.now()
  for (let i = 0; i < n; i++) fn()
  const ms = (performance.now() - t0) / n
  console.log(`${name}: ${ms.toFixed(3)}ms/次`)
}

bench("estimateTokens(1MB ASCII)", () => estimateTokens(ascii1MB), 20)
bench("estimateTokens(1MB CJK)", () => estimateTokens(cjk1MB), 20)

// computePerfSample 单消息（20 parts，含时间戳读取，无文本扫描）
const am = {
  id: "m1", sessionID: "s1", role: "assistant",
  time: { created: 1000, completed: 9000 },
  tokens: { input: 10, output: 600, reasoning: 900, cache: { read: 0, write: 0 } },
} as any
const parts = Array.from({ length: 19 }, (_, i) => ({
  id: `p${i}`, sessionID: "s1", messageID: "m1", type: "reasoning",
  text: cjk1MB.slice(0, 25_000), time: { start: 1100 + i },
})) as any[]
parts.push({ id: "px", sessionID: "s1", messageID: "m1", type: "tool", tool: "bash", state: { status: "completed", time: { start: 3000, end: 4000 } } } as any)

bench("computePerfSample(20 parts, ~500KB 文本但不扫描)", () => computePerfSample(am, parts), 2000)

// aggregatePerf 100 条消息（侧边栏精确聚合，每条一次 part 查找 + 采样）
const partsById: Record<string, any[]> = {}
const msgs = Array.from({ length: 100 }, (_, i) => {
  const m = { ...am, id: `m${i}`, time: { created: 1000 + i * 10_000, completed: 9000 + i * 10_000 } }
  partsById[`m${i}`] = parts
  return m as any
})
const api = { state: { part: (id: string) => partsById[id] ?? [] } } as unknown as TuiPluginApi
bench("aggregatePerf(100 msgs × 20 parts)", () => aggregatePerf(api, msgs), 200)
