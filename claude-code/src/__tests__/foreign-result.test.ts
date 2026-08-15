// FORK 2026-08-15 (静默空回复修复) 回归测试:
// 现场 = DeskFox 会话空闲超 IDLE_TIMEOUT 被回收后再发消息, 插件走 --resume, 而被恢复的 CC 会话
// 上次结束时留有未完结后台任务。实测 claude 2.1.x 此时的 stdout 顺序:
//   system task_notification → system init → result{num_turns:0,result:""}
//   → system init → assistant(真正的回答) → result{num_turns:1}
// 旧行为在第 3 行就判本轮完成并收流 → 用户看到"回车了没有任何反应"(零 token/无文本/无报错),
// 而 CLI 那头照常把活干完。修复后必须忽略那条不属于本轮的 result, 拿到真正的回答。
import { test, expect } from "bun:test"
import { chmodSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

// 桩几十毫秒内应答, 给足余量即可; 必须先设 env 再动态 import(模块加载时读取该值)
process.env.OPENCODE_CLAUDE_CODE_WATCHDOG_MS = "5000"

const { ClaudeCodeLanguageModel } = await import("../claude-code-language-model")

const FAKE_CLI = path.join(import.meta.dir, "fake-claude.sh")
chmodSync(FAKE_CLI, 0o755)
chmodSync(path.join(import.meta.dir, "fake-claude.cjs"), 0o755)

async function runStream(cwd: string, sessionID: string) {
  const model = new ClaudeCodeLanguageModel("sonnet", {
    provider: "claude-code",
    cliPath: FAKE_CLI,
    cwd,
  })
  const { stream } = await model.doStream({
    prompt: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
    tools: [],
    providerOptions: { _opencode: { sessionID } },
  } as any)

  const parts: any[] = []
  const reader = stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }
  return parts
}

function textOf(parts: any[]): string {
  return parts
    .filter((p) => p.type === "text-delta")
    .map((p) => p.delta)
    .join("")
}

test(
  "resume 场景: 忽略 num_turns=0 的外来 result, 真正的回答不被丢弃",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "foreign-result-"))
    process.env.FAKE_CLAUDE_MODE = "foreign-result"
    delete process.env.FAKE_CLAUDE_MARKER

    const parts = await runStream(dir, "foreign-result")

    // 核心: 真正的回答必须到达(旧行为这里是空字符串)
    expect(textOf(parts)).toContain("real-answer-after-resume")

    // 且只收一次流, 收在真正的 result 上
    const finishes = parts.filter((p) => p.type === "finish")
    expect(finishes.length).toBe(1)
    expect(finishes[0].finishReason).toBe("stop")
    // 不该是 watchdog 兜底救回来的
    expect(finishes[0].providerMetadata?.["claude-code"]?.watchdogGaveUp).toBeUndefined()
  },
  15000,
)

test(
  "非 resume 的普通回合不受影响(num_turns=1 的 result 照常收流)",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "normal-turn-"))
    delete process.env.FAKE_CLAUDE_MODE
    delete process.env.FAKE_CLAUDE_MARKER

    const parts = await runStream(dir, "normal-turn")

    expect(textOf(parts)).toContain("rescued-by-watchdog")
    const finishes = parts.filter((p) => p.type === "finish")
    expect(finishes.length).toBe(1)
    expect(finishes[0].finishReason).toBe("stop")
  },
  15000,
)
