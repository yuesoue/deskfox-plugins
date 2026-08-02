#!/usr/bin/env node
// REQ-089 watchdog 测试用假 claude(应答部分)。入口/沉默分支见 fake-claude.sh。
// 行为: 立即输出 system init, 读到一行 user 消息后输出 assistant 文本 + result。
const readline = require("node:readline")

process.stdout.write(
  JSON.stringify({ type: "system", subtype: "init", session_id: "fake-sid-1" }) + "\n",
)

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
        content: [{ type: "text", text: "rescued-by-watchdog" }],
      },
    }) + "\n",
  )
  process.stdout.write(
    JSON.stringify({
      type: "result",
      subtype: "success",
      session_id: "fake-sid-1",
      usage: { input_tokens: 1, output_tokens: 1 },
    }) + "\n",
  )
})
