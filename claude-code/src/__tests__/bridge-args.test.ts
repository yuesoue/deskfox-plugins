// FORK 2026-08-02 (REQ-091 快修 + REQ-090 第1档) 桥接注入单测:
// buildCliArgs 默认带 --disallowedTools(硬禁交互工具)与 --append-system-prompt(纯文本问答
// + 长任务前台轮询约定); 设 OPENCODE_CLAUDE_CODE_NO_BRIDGE_PROMPT=1 可整体关掉。
import { test, expect, afterEach } from "bun:test"
import {
  buildCliArgs,
  BRIDGE_DISALLOWED_TOOLS,
  BRIDGE_SYSTEM_PROMPT,
} from "../session-manager"

afterEach(() => {
  delete process.env.OPENCODE_CLAUDE_CODE_NO_BRIDGE_PROMPT
})

test("默认注入 --disallowedTools 与 --append-system-prompt", () => {
  const args = buildCliArgs({ sessionKey: "bridge-1", skipPermissions: true })

  const di = args.indexOf("--disallowedTools")
  expect(di).toBeGreaterThan(-1)
  for (const [offset, tool] of BRIDGE_DISALLOWED_TOOLS.entries()) {
    expect(args[di + 1 + offset]).toBe(tool)
  }

  const si = args.indexOf("--append-system-prompt")
  expect(si).toBeGreaterThan(-1)
  expect(args[si + 1]).toBe(BRIDGE_SYSTEM_PROMPT)
})

test("桥接提示覆盖 REQ-091 选择约定与 REQ-090 长任务约定", () => {
  expect(BRIDGE_DISALLOWED_TOOLS).toContain("AskUserQuestion")
  expect(BRIDGE_DISALLOWED_TOOLS).toContain("ExitPlanMode")
  expect(BRIDGE_SYSTEM_PROMPT).toContain("纯文本列出")
  expect(BRIDGE_SYSTEM_PROMPT).toContain("结束回合等待用户回复")
  expect(BRIDGE_SYSTEM_PROMPT).toContain("稍后汇报")
  expect(BRIDGE_SYSTEM_PROMPT).toContain("前台等待")
})

test("OPENCODE_CLAUDE_CODE_NO_BRIDGE_PROMPT=1 → 不注入", () => {
  process.env.OPENCODE_CLAUDE_CODE_NO_BRIDGE_PROMPT = "1"
  const args = buildCliArgs({ sessionKey: "bridge-2", skipPermissions: true })
  expect(args).not.toContain("--disallowedTools")
  expect(args).not.toContain("--append-system-prompt")
})
