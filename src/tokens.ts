// ---------------------------------------------------------------------------
// Token helpers — pure, dependency-free (unit-testable).
// ---------------------------------------------------------------------------

/** Coerce unknown to a finite number; non-numbers become 0. */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// ── token estimation ──
// Character-based BPE approximation. 密度校准（2026-09，DeepSeek-V4 官方
// tokenizer + GPT o200k 对用户真实会话的实测拟合，见 benchmarks/ 注释）：
//   汉字：~1.5 字/token（o200k 实测 1.34、DS-V4 1.52、答案段拟合 1.43 → 1.5 折中）
//   ASCII 散文：~3.3 字符/token（DS-V4 3.12 / o200k 3.45）
//   ASCII 代码/JSON：~3.7 字符/token（DS-V4 3.71 / o200k 3.92）
//   假名/谚文：~1.0 字/token
// 不同 part 形态的真实密度差异显著（同模型：答案段 ascii 2.97 vs 思考段 4.04），
// 故以 profile 参数区分：估算 tokens 时按 part 形态传 profile（省略参数走
// default 检测路径）。default 保留 jsonLike/codeLike 检测（JSON/源码几乎每个
// 标点独立 token，需收紧）。
// See: GPT-4 / Claude tokenizer behaviour with structured text.

export type TokProfile = "thinking" | "answer" | "code"

const ASCII_PER_TOKEN: Record<TokProfile, number> = {
  thinking: 4.0, // reasoning part：~95% ascii 思考流（实测密度 4.04）
  answer: 2.9,   // text part：符号/代码片段密集的答案（实测 2.97，含全角/符号稀释）
  code: 3.7,     // tool raw/output：纯代码/命令输出（实测密度 3.71）
}

export function estimateTokens(text: string, profile?: TokProfile): number {
  if (!text || text.length === 0) return 0
  let ascii = 0
  let cjk = 0 // 假名/谚文等：分词压缩率接近 1 字/token
  let han = 0 // 汉字：o200k 平均 ~1.5 字/token
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x4E00 && code <= 0x9FFF) han++        // CJK Unified 汉字
    else if (code >= 0x3040 && code <= 0x30FF) cjk++   // Hiragana/Katakana
    else if (code >= 0x3000 && code <= 0x303F) cjk++   // CJK 全角标点（密度~1 字/token，归 ascii 会低估答案段）
    else if (code >= 0xFF00 && code <= 0xFFEF) cjk++   // 全角形式（０ａｂ＊，同上）
    else if (code >= 0xAC00 && code <= 0xD7A3) cjk++   // Hangul
    else if (code >= 0x1100 && code <= 0x11FF) cjk++   // Hangul Jamo
    else if (code >= 0x2E80 && code <= 0x2EFF) cjk++   // CJK Radicals
    else ascii++
  }

  // Real BPE tokenizers (cl100k_base, o200k_base) average ~3.5-4.0
  // ASCII chars/token for both JSON and source code — close to prose.
  // The old 2.0 / 2.5 ratios matched minified-JS extremes, not typical
  // payloads, and systematically over-estimated token counts.
  let asciiPerToken: number
  if (profile) {
    asciiPerToken = ASCII_PER_TOKEN[profile]
  } else {
    const trimmed = text.trimStart()
    // Strip markdown code-fence prefix so that ```json … is detected as JSON
    const strippedFence = trimmed.replace(/^\x60{3}\w*\s*\n?/, "")
    // jsonLike 判定统一基于 strippedFence，避免与 startsWith 的文本口径不一致。
    const jsonLike = (strippedFence.startsWith("{") || strippedFence.startsWith("["))
      && /"[^"]+"\s*:/.test(strippedFence)
    const codeLike = !jsonLike
      && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)

    asciiPerToken = jsonLike ? 3.7 : codeLike ? 3.7 : 3.3
  }
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.0 + han / 1.5))
}
