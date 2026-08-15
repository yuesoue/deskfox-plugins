#!/usr/bin/env node
// REQ-089 watchdog 测试用假 claude(应答部分)。入口/沉默分支见 fake-claude.sh。
// 行为: 立即输出 system init, 读到一行 user 消息后输出 assistant 文本 + result。
//
// FORK 2026-08-15 (静默空回复修复) FAKE_CLAUDE_MODE=foreign-result 复刻实测事件序列:
// --resume 一个"上次结束时留有未完结后台任务"的会话时, CLI 先给那条恢复通知补一个空回合
// (result{num_turns:0}), 第二次 init 之后才是本轮真正的回答。插件必须忽略前一条 result。
const readline = require("node:readline")

const FOREIGN = process.env.FAKE_CLAUDE_MODE === "foreign-result"

if (FOREIGN) {
  process.stdout.write(
    JSON.stringify({ type: "system", subtype: "task_notification" }) + "\n",
  )
}

process.stdout.write(
  JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sid-1" }) + "\n",
)

if (FOREIGN) {
  // 不属于本轮的空 result: num_turns=0, 无任何内容
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "fake-sid-1",
      is_error: false,
      num_turns: 0,
      duration_ms: 48,
      result: "",
    }) + "\n",
  )
  process.stdout.write(
    JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sid-1" }) + "\n",
  )
}

let answered = false
const rl = readline.createInterface({ input: process.stdin })
rl.on("line", () => {
  if (answered) return
  answered = true
  process.stdout.write(
    JSON.stringify({
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: FOREIGN ? "real-answer-after-resume" : "rescued-by-watchdog",
          },
        ],
      },
    }) + "\n",
  )
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "fake-sid-1",
      num_turns: 1,
      usage: { input_tokens: 1, output_tokens: 1 },
    }) + "\n",
  )
})
