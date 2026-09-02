// ---------------------------------------------------------------------------
// Token helpers — pure, dependency-free (unit-testable).
// ---------------------------------------------------------------------------

/** Coerce unknown to a finite number; non-numbers become 0. */
export function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0
}

// ── token estimation ──
// Character-based BPE approximation.  o200k/cl100k 平均压缩率：ASCII ~4 chars/token
// （JSON/代码 ~3.5）、汉字 ~1.5 chars/token、假名/谚文 ~1.0 chars/token。
// 默认比例对自然语言较准，但 JSON 与源代码中几乎每个标点都是独立 token，
// 系统性低估——检测到这些形态后收紧 ASCII 比例。
// See: GPT-4 / Claude tokenizer behaviour with structured text.

export function estimateTokens(text: string): number {
  if (!text || text.length === 0) return 0
  let ascii = 0
  let cjk = 0 // 假名/谚文等：分词压缩率接近 1 字/token
  let han = 0 // 汉字：o200k 平均 ~1.5 字/token
  for (const c of text) {
    const code = c.codePointAt(0) ?? 0
    if (code >= 0x4E00 && code <= 0x9FFF) han++        // CJK Unified 汉字
    else if (code >= 0x3040 && code <= 0x30FF) cjk++   // Hiragana/Katakana
    else if (code >= 0xAC00 && code <= 0xD7A3) cjk++   // Hangul
    else if (code >= 0x1100 && code <= 0x11FF) cjk++   // Hangul Jamo
    else if (code >= 0x2E80 && code <= 0x2EFF) cjk++   // CJK Radicals
    else ascii++
  }

  // Real BPE tokenizers (cl100k_base, o200k_base) average ~3.5-4.0
  // ASCII chars/token for both JSON and source code — close to prose.
  // The old 2.0 / 2.5 ratios matched minified-JS extremes, not typical
  // payloads, and systematically over-estimated token counts.
  const trimmed = text.trimStart()
  // Strip markdown code-fence prefix so that ```json … is detected as JSON
  const strippedFence = trimmed.replace(/^\x60{3}\w*\s*\n?/, "")
  // jsonLike 判定统一基于 strippedFence，避免与 startsWith 的文本口径不一致。
  const jsonLike = (strippedFence.startsWith("{") || strippedFence.startsWith("["))
    && /"[^"]+"\s*:/.test(strippedFence)
  const codeLike = !jsonLike
    && /```|^import |^export |^function |^const |^let |^var |^class |^interface |^type |^def |^fn |^pub |^use |^mod |^package /m.test(text)

  const asciiPerToken = jsonLike ? 3.5 : codeLike ? 3.5 : 4
  return Math.max(1, Math.ceil(ascii / asciiPerToken + cjk / 1.0 + han / 1.5))
}
