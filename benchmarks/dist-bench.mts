// ═══════════════════════════════════════════════════════════════════════════
// dist 管线性能基准 —— 指纹缓存收益验证（对照 = 无缓存的旧行为）
// ═══════════════════════════════════════════════════════════════════════════
//
// 【简介】
// 侧边栏刷新管线有两版实现的对照：优化后 = 节流 + 指纹缓存，
// 只增量重算真正变化的消息（热重建 ≈ 0.15ms）；优化前 = 每个事件全量重扫
// 会话文本（≈ 20ms/次，重会话流式期间 ~40% 单核）。本脚本同时测量两版，
// 量化缓存收益，并作为后续改动的回退探针。
//
// 【如何执行】
//   npm run bench:dist        # 仅本脚本
//   npm run bench             # 全部基准（dist + tokens）
// tsx 直接运行 TS，无需先 build。建议改动后与改动前各跑一次做相对对比，
// 而非对照本注释里的参考数字（绝对值随机器/负载波动）。
//
// 【场景判读】（编号对应下方输出）
//   1 冷启动    缓存空的全量扫描。量级应 ≈ 场景 5 基线（≈ estimateTokens 吞吐
//              × 会话文本量；参考 7-10ms/MB）。若数量级变化 → 扫描逻辑或
//              estimateTokens 变了。
//   2 热重建    无变化时重建（流式期间绝大多数重算的情形）。应 <1ms；
//              若接近场景 5 → 缓存失效/指纹误判，回退！
//   3 流式增量  尾 assistant 文本持续增长。assistant text 不参与分布，
//              指纹不感知 → 应 ≈ 场景 2。若显著变大 → 指纹误把 text 计入
//              assistant 分支了（distFingerprint 的角色感知被破坏）。
//   4 工具完成  尾消息新增 part → 仅该消息重扫。应 ≈ 单消息扫描成本
//              （几 KB 级 → <1ms），远小于场景 5。
//   5 旧基线    全部消息 id 换新 → 缓存全 miss = 优化前的每次事件成本。
//   6 参照      aggregatePerf 只读时间戳，应保持 µs 级；若变 ms 级说明
//              有人往采样路径里加了文本扫描。
//
// 【何时该跑】改动以下任何一处之后：
//   - src/dist.ts（指纹字段 / 缓存策略 / 扫描范围）——尤其注意：指纹必须
//     覆盖所有被扫描字段的长度/状态，二者必须同步修改
//   - src/tokens.ts（estimateTokens 比率或实现）
//   - index.tsx 刷新管线（节流参数 / 事件接线 / untrack 范围）
//
// 【约定】本脚本不进 npm test 门禁——时序断言在 CI/负载下会随机假红。
// 灾难性回退（如缓存永远 miss）由 tests/dist.test.ts 的宽松冒烟断言兜底；
// 精细对比靠人工跑本脚本。
//
// 【测量陷阱】bench() 辅助函数会先预热一次——"冷启动"必须在任何预热前
// 用裸 performance.now() 直测首个调用（本脚本已按此实现，改动时保持）。
import { collectTokenDist } from "../src/dist"
import { aggregatePerf } from "../src/perf"
import type { TuiPluginApi } from "@opencode-ai/plugin/tui"

// ── 重会话夹具：150 轮 × (user 1KB + 3 工具[输入1KB/输出5KB] + assistant 文本 2KB) ≈ 3MB ──
// 夹具刻意用重复字符而非真实文本：estimateTokens 是逐字符吞吐型扫描，
// 字符分布不影响量级；真实会话的差异主要体现在文本总量上。
const RAW = "x".repeat(1024)
const OUT = "y".repeat(5 * 1024)

function buildSession() {
  const partsByMsg: Record<string, any[]> = {}
  const msgs: any[] = []
  for (let i = 0; i < 150; i++) {
    const uid = `u${i}`, aid = `a${i}`
    msgs.push({ id: uid, role: "user", time: { created: i * 100_000 } })
    partsByMsg[uid] = [{ type: "text", text: "u".repeat(1024), synthetic: false, ignored: false, id: uid + "t" }]
    msgs.push({
      id: aid, role: "assistant", time: { created: i * 100_000 + 5, completed: i * 100_000 + 50 },
      parentID: `p${i}`, tokens: { input: 1000, output: 300, reasoning: 100, cache: { read: 0, write: 0 } },
    })
    partsByMsg[aid] = [
      ...Array.from({ length: 3 }, (_, j) => ({
        type: "tool", tool: "bash", id: aid + "tl" + j,
        state: { status: "completed", raw: RAW, output: OUT, time: { start: i * 100_000 + 10, end: i * 100_000 + 20 } },
      })),
      { type: "text", text: "x".repeat(2048), id: aid + "tx", time: { start: i * 100_000 + 6 } },
    ]
  }
  return { msgs, partsByMsg }
}

const session = buildSession()
let gen = 0
function apiOf(map: Record<string, any[]>): TuiPluginApi {
  return { state: { part: (id: string) => map[id] ?? [] } } as unknown as TuiPluginApi
}

// 旧行为基线：所有消息 id 换新 → 缓存全 miss → 全量重扫
function baselineRun() {
  gen++
  const map: Record<string, any[]> = {}
  const msgs = session.msgs.map((m: any) => {
    const id = `${m.id}@${gen}`
    map[id] = session.partsByMsg[m.id]
    return { ...m, id }
  })
  return collectTokenDist(apiOf(map), msgs as never, undefined)
}

function bench(name: string, fn: () => unknown, n: number) {
  fn() // 预热（含首次建缓存）
  const ts: number[] = []
  for (let i = 0; i < n; i++) {
    const t0 = performance.now()
    fn()
    ts.push(performance.now() - t0)
  }
  ts.sort((a, b) => a - b)
  const med = ts[Math.floor(n / 2)]
  console.log(`${name}: 中位 ${med.toFixed(3)}ms  (min ${ts[0].toFixed(3)} / max ${ts[n - 1].toFixed(3)}, n=${n})`)
  return med
}

console.log(`会话规模: ${session.msgs.length} 消息, 文本总量 ≈ ${((150 * 20 + 75) / 1024).toFixed(2)}MB`)

// 1. 冷启动（进程首次调用，缓存空——须在最前测量，bench 的预热会污染）
{
  const t0 = performance.now()
  collectTokenDist(apiOf(session.partsByMsg), session.msgs as never, undefined)
  console.log(`1 冷启动（全量扫描 ≈ 旧行为单次）: ${(performance.now() - t0).toFixed(2)}ms`)
}

// 2. 热重建：无变化（流式期间绝大多数重算的情形）
const warm = bench("2 热重建（无变化，缓存全命中）", () => collectTokenDist(apiOf(session.partsByMsg), session.msgs as never, undefined), 30)

// 3. 流式模拟：尾 assistant 文本每轮 +1KB（指纹应不感知 → 不重扫）
{
  const last = session.partsByMsg.a149
  const tp = last[last.length - 1] as { text: string }
  let i = 0
  const t = bench("3 流式增量（尾消息 text +1KB/轮）", () => {
    tp.text = "x".repeat(2048 + (++i % 64) * 1024)
    return collectTokenDist(apiOf(session.partsByMsg), session.msgs as never, undefined)
  }, 30)
  console.log(`   → 指纹稳定，成本 ≈ 热重建（${Math.max(t, warm).toFixed(3)}ms 级）`)
}

// 4. 工具完成模拟：尾 assistant 每轮新增一个已完成工具 part（仅该消息重扫）
{
  const last = session.partsByMsg.a149
  let j = 0
  bench("4 工具完成（尾消息新增 part → 单消息重扫）", () => {
    last.push({ type: "tool", tool: "bash", id: "extra" + j++, state: { status: "completed", raw: RAW, output: OUT, time: { start: 1, end: 2 } } })
    return collectTokenDist(apiOf(session.partsByMsg), session.msgs as never, undefined)
  }, 10)
}

// 5. 旧行为基线：缓存全 miss 全量重扫（≈ 优化前每次事件重算的成本）
const base = bench("5 旧行为基线（无缓存全量重扫）", () => baselineRun(), 5)

console.log(`\n收益：热重建 vs 旧基线 = ${base < 0.001 ? "∞" : (base / Math.max(warm, 0.0001)).toFixed(0)}×  (${base.toFixed(1)}ms → ${warm.toFixed(3)}ms/次)`)
console.log(`旧基线在 20Hz 事件流下 ≈ ${(base * 20).toFixed(0)}ms/s CPU；节流后 10Hz × 热重建 ≈ ${(warm * 10).toFixed(1)}ms/s`)

// 6. 参照：性能聚合（同一会话）
bench("6 aggregatePerf（150 消息，参照）", () => aggregatePerf(apiOf(session.partsByMsg), session.msgs as never), 50)
