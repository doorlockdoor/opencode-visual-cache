import assert from "node:assert/strict"
import { shallowEqual, createThrottledBumper } from "../src/util"

// ── shallowEqual ───────────────────────────────────────────────────────────

assert.equal(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 2 }), true)
assert.equal(shallowEqual({ a: 1, b: 2 }, { a: 1, b: 3 }), false)
assert.equal(shallowEqual({ a: 1 }, { a: 1, b: 2 }), false) // 键集合不对称（b 侧多）
assert.equal(shallowEqual({ a: 1, b: undefined }, { a: 1 }), false) // 对称检查（a 侧多）
assert.equal(shallowEqual(undefined, { a: 1 }), false)
assert.equal(shallowEqual({} as Record<string, never>, {} as Record<string, never>), true)

// PerfStats 形状（KV 去重的实际用例）
{
  const a: Record<string, unknown> = { ttftLast: 500, tpsLast: null, latLast: 2000, ttftAvg: 500, tpsAvg: null, latAvg: 2000, ttftN: 1, tpsN: 0, hasPerf: true }
  assert.equal(shallowEqual(a, { ...a }), true)
  assert.equal(shallowEqual(a, { ...a, tpsLast: 66.7 }), false)
}

// ── createThrottledBumper（真实定时器 + 宽松界，避免时序脆弱）──────────────

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// 突发 N 个同步事件 → 恰好 2 次：前沿立即 + 尾沿一次
{
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  for (let i = 0; i < 10; i++) b.bump()
  assert.equal(n, 1) // 前沿立即
  await sleep(90)
  assert.equal(n, 2) // 尾沿补一次，不多不少
  b.dispose()
}

// 连续流（每 20ms 一事件，持续 400ms，间隔 40ms）→ 钳到 ~11 次（10Hz 节奏），不饿死
{
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  const t0 = Date.now()
  while (Date.now() - t0 < 400) {
    b.bump()
    await sleep(20)
  }
  await sleep(100)
  assert.ok(n >= 8 && n <= 15, `连续流触发次数 ${n} 应在 [8,15]`)
  b.dispose()
}

// 静默期后的首个事件立即生效（前沿）
{
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  b.bump()
  await sleep(90)
  const before = n
  b.bump()
  assert.equal(n, before + 1)
  b.dispose()
}

// dispose 后不再触发
{
  let n = 0
  const b = createThrottledBumper(() => n++, 40)
  b.bump()
  b.dispose()
  await sleep(90)
  assert.equal(n, 1)
}

console.log("util tests passed")
