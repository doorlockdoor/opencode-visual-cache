// ---------------------------------------------------------------------------
// token 估算校准探针 —— estimateTokens 各 profile vs API 上报真值
// ---------------------------------------------------------------------------
//
// 【简介】
// estimateTokens 是字符级 BPE 近似，密度参数（汉字 1.5 字/token、
// ASCII thinking 4.0 / answer 2.9 / code 3.7）基于 2026-09 对官方 tokenizer
// （DeepSeek-V4 / GPT o200k）与真实会话 API 上报的实测拟合。本脚本是持续
// 探针：改密度、换模型词表（如 GPT 换新 tokenizer、DS-V5 发布）后重跑，
// 数字应稳定在 ≥0.9 / ≤1.1——偏离即回归风险。
//
// 【如何执行】npm run bench:calibrate（读本机 opencode.db，无需构建）
//
// 【判读】
//   - 思考段：reasoning part 文本 vs tokens.reasoning（estimateTokens "thinking" 档）
//   - 答案段：无工具消息的 text part vs tokens.output（estimateTokens "answer" 档）
//   - est/actual < 1 → 低估（实时 TPS 会偏低）；> 1 → 高估
//   - 按 provider/model 分组，若某模型显著偏离（±10%+），是该模型词表密度
//     与当前参数的差异信号
//
// 【数据来源】本机 ~/.local/share/opencode/opencode.db（opencode 的 SQLite 库）。
// 取最近 200 会话的 assistant 消息；无数据时直接退出。
// 另一台机器用 OPCODE_CALIBRATE_DB 环境变量指向其数据库即可。
//
// 【可选深入】如需绝对真值对照（而非 API 上报），下载官方 tokenizer 包
// （DeepSeek: https://cdn.deepseek.com/api-docs/deepseek_v4_tokenizer.zip）
// 用 Python tokenizers 库对同一批样本编码并与本脚本输出交叉验证。
// 该路径依赖外部文件与 Python 环境，不收入本仓库。
import { DatabaseSync } from "node:sqlite"
import os from "node:os"
import path from "node:path"
import fs from "node:fs"
import { estimateTokens, num } from "../src/tokens"

const dbFile = process.env.OPCODE_CALIBRATE_DB || path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
if (!fs.existsSync(dbFile)) {
  console.log(`未找到 opencode 数据库 (${dbFile})；可用环境变量 OPCODE_CALIBRATE_DB 指向其他路径后重跑。`)
  process.exit(0)
}
const db = new DatabaseSync(dbFile)

const sessions = db.prepare("SELECT id FROM session ORDER BY time_updated DESC LIMIT 200").all() as { id: string }[]
if (!sessions.length) {
  console.log("最近会话为空，无样本可校准。")
  process.exit(0)
}
const ph = sessions.map(() => "?").join(",")
const msgs = db.prepare(`SELECT id, time_created, data FROM message WHERE session_id IN (${ph}) ORDER BY time_created DESC`).all(...sessions.map(s => s.id)) as { id: string; time_created: number; data: string }[]

let minT = Infinity, maxT = 0
const groups = new Map<string, { reas: { text: string; actual: number }[]; ans: { text: string; actual: number }[] }>()
const groupOf = (key: string) => {
  let g = groups.get(key)
  if (!g) { g = { reas: [], ans: [] }; groups.set(key, g) }
  return g
}

for (const row of msgs) {
  const d = JSON.parse(row.data)
  if (d.role !== "assistant") continue
  const key = [d.providerID ?? "?", d.modelID ?? "?"].join(" | ")
  const tok = d.tokens ?? {}
  const reasActual = num(tok.reasoning)
  const outActual = num(tok.output)
  if (reasActual <= 0 && outActual <= 0) continue
  const parts = db.prepare("SELECT data FROM part WHERE message_id = ?").all(row.id) as { data: string }[]
  let reasText = "", outText = "", hasTool = false, compShort = false
  for (const p of parts) {
    const pd = JSON.parse(p.data)
    if (pd.type === "reasoning") reasText += pd.text ?? ""
    else if (pd.type === "text") { if (pd.compacted) compShort = true; outText += pd.text ?? "" }
    else if (pd.type === "tool") hasTool = true
  }
  if (row.time_created) {
    const t = new Date(row.time_created).getTime()
    if (t < minT) minT = t
    if (t > maxT) maxT = t
  }
  const g = groupOf(key)
  // 思考段：纯推理消息（思考占比 >5×输出），避免与输出混算
  if (reasText && reasActual >= 200 && reasActual / Math.max(outActual, 1) > 5) {
    g.reas.push({ text: reasText, actual: reasActual })
  }
  // 答案段：无工具调用的纯答案消息（text part 与 tokens.output 一一对应）
  if (outText && outActual >= 30 && !hasTool && !compShort) {
    g.ans.push({ text: outText, actual: outActual })
  }
}

const fmtRange = () => {
  if (minT === Infinity) return "n/a"
  const a = new Date(minT).toLocaleDateString("zh-CN"), b = new Date(maxT).toLocaleDateString("zh-CN")
  return a === b ? a : `${a} ~ ${b}`
}

console.log(`opencode 样本库: ${sessions.length} 会话, 数据范围 ${fmtRange()}`)
for (const [key, g] of [...groups.entries()].sort((a, b) => (a[1].reas.length + a[1].ans.length) - (b[1].reas.length + b[1].ans.length)).reverse()) {
  console.log(`\n${key}:`)
  if (g.reas.length) {
    const est = g.reas.reduce((s, r) => s + estimateTokens(r.text, "thinking"), 0)
    const act = g.reas.reduce((s, r) => s + r.actual, 0)
    console.log(`  思考段 n=${g.reas.length}: est/actual = ${(est / act).toFixed(3)}   ${est.toLocaleString()} / ${act.toLocaleString()}`)
  }
  if (g.ans.length) {
    const est = g.ans.reduce((s, r) => s + estimateTokens(r.text, "answer"), 0)
    const act = g.ans.reduce((s, r) => s + r.actual, 0)
    console.log(`  答案段 n=${g.ans.length}: est/actual = ${(est / act).toFixed(3)}   ${est.toLocaleString()} / ${act.toLocaleString()}`)
  }
  if (!g.reas.length && !g.ans.length) console.log("  (无合格样本)")
}
console.log("\n判读：est/actual 应落在 0.90 ~ 1.10；若某档逼近或越过边界，说明密度参数需要重新校准（见文件头注释）")
