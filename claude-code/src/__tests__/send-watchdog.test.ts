// FORK 2026-08-02 (REQ-089 修法B) 发送 watchdog 真子进程单测:
// 用 fake-claude.cjs(真子进程、不花 token)模拟僵进程,验证
//   1) 僵进程 → watchdog 杀掉重 spawn 重发 → 第二个进程正常应答, 用户无感拿到回复;
//   2) 重试后仍僵 → 放弃并给用户可见错误提示 + 正常收流(不再无限沉默)。
// watchdog 阈值经 OPENCODE_CLAUDE_CODE_WATCHDOG_MS 调小; 该值在模块加载时读取,
// 必须先设 env 再动态 import 被测模块。
import { test, expect } from "bun:test"
import { chmodSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnClaudeProcess, sessionKey } from "../session-manager"

// 1000ms: 全量套件并行负载下 node 冷启可到数百 ms, 窗口太小会把"应答进程还在启动"误判成僵死
process.env.OPENCODE_CLAUDE_CODE_WATCHDOG_MS = "1000"

const { ClaudeCodeLanguageModel } = await import("../claude-code-language-model")

const FAKE_CLI = path.join(import.meta.dir, "fake-claude.sh")
chmodSync(FAKE_CLI, 0o755)
chmodSync(path.join(import.meta.dir, "fake-claude.cjs"), 0o755)

function makeModel(cwd: string) {
  return new ClaudeCodeLanguageModel("sonnet", {
    provider: "claude-code",
    cliPath: FAKE_CLI,
    cwd,
  })
}

async function runStream(model: InstanceType<typeof ClaudeCodeLanguageModel>, sessionID: string) {
  const { stream } = await model.doStream({
    prompt: [
      { role: "user", content: [{ type: "text", text: "hello" }] },
    ],
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
  "watchdog 自愈: 僵进程被杀重建重发, 第二个进程应答, 用户无感",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-rescue-"))
    process.env.FAKE_CLAUDE_MODE = "silent-once"
    process.env.FAKE_CLAUDE_MARKER = path.join(dir, "first-run-marker")

    const parts = await runStream(makeModel(dir), "wd-rescue")

    expect(textOf(parts)).toContain("rescued-by-watchdog")
    const finish = parts.find((p) => p.type === "finish")
    expect(finish).toBeDefined()
    expect(finish.finishReason).toBe("stop")
  },
  15000,
)

test(
  "验收场景: SIGSTOP 挂起池中复用进程后发送 → watchdog 自动重建并正常回复",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-sigstop-"))
    delete process.env.FAKE_CLAUDE_MODE // talk 模式
    delete process.env.FAKE_CLAUDE_MARKER

    // 预放一个"活进程"进池(doStream 将复用它), 然后 SIGSTOP 挂起 —— 模拟真僵进程:
    // 写 stdin 石沉大海, 无任何 stream 事件。watchdog 应杀掉(SIGTERM 对挂起进程不生效,
    // 走 2s SIGKILL 兜底)并重 spawn 一个正常进程重发, 用户无感拿到回复。
    const sk = sessionKey(dir, "sonnet::tools", "wd-sigstop")
    const ap = spawnClaudeProcess(FAKE_CLI, [], dir, sk)
    await new Promise((r) => setTimeout(r, 300)) // 等 sh/node 起来
    ap.proc.kill("SIGSTOP")

    const parts = await runStream(makeModel(dir), "wd-sigstop")

    expect(textOf(parts)).toContain("rescued-by-watchdog")
    const finish = parts.find((p) => p.type === "finish")
    expect(finish).toBeDefined()
    expect(finish.finishReason).toBe("stop")
    try {
      ap.proc.kill("SIGKILL")
    } catch {}
  },
  20000,
)

test(
  "watchdog 放弃: 重试后仍无事件 → 可见错误提示 + 正常收流",
  async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wd-giveup-"))
    process.env.FAKE_CLAUDE_MODE = "silent"
    delete process.env.FAKE_CLAUDE_MARKER

    const parts = await runStream(makeModel(dir), "wd-giveup")

    expect(textOf(parts)).toContain("无响应")
    const finish = parts.find((p) => p.type === "finish")
    expect(finish).toBeDefined()
    expect(finish.finishReason).toBe("stop")
    expect(finish.providerMetadata?.["claude-code"]?.watchdogGaveUp).toBe(true)
  },
  15000,
)
