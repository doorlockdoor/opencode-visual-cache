// ── 通用小工具（无业务依赖，可单测）──

/** 浅比较（键集合对称）：KV 快照与 last* 信号写入的去重判据。 */
export function shallowEqual<T extends object>(a: T | undefined, b: T): boolean {
  if (!a) return false
  const ab = a as Record<string, unknown>
  const bb = b as Record<string, unknown>
  for (const k in bb) if (ab[k] !== bb[k]) return false
  for (const k in ab) if (!(k in bb)) return false
  return true
}

/**
 * 前沿+尾沿节流：interval 内首个事件立即触发，后续事件在窗口末（lastBump +
 * interval）至多补一次，突发期间触发节奏恒定 ≤1/interval。
 * 与纯尾沿去抖的区别：连续 delta 流下去抖的定时器不断重置永不触发（饿死），
 * 本实现的触发目标锚定在 lastBump + interval，节奏稳定。
 * now 可注入以便单测；dispose 供 onCleanup 清理挂起的尾沿定时器。
 */
export function createThrottledBumper(bump: () => void, intervalMs: number, now: () => number = Date.now): {
  bump: () => void
  dispose: () => void
} {
  let last = -Infinity
  let timer: ReturnType<typeof setTimeout> | undefined
  const fire = () => {
    last = now()
    bump()
  }
  return {
    bump() {
      const t = now()
      if (t - last >= intervalMs) {
        fire()
        return
      }
      if (timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined
          fire()
        }, intervalMs - (t - last))
      }
    },
    dispose() {
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
