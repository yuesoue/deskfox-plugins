import { test, expect } from "bun:test"
import {
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
} from "../session-manager"

// 注意: session-manager 的 activeProcesses / claudeSessions 是模块级单例 Map,
// 各 test 用独立 key 前缀避免互相干扰。

test("buildCliArgs: 无存量 session 时不加 --resume", () => {
  const args = buildCliArgs({ sessionKey: "k-none", skipPermissions: true })
  expect(args).not.toContain("--resume")
  expect(args).not.toContain("--session-id")
})

test("buildCliArgs: 有存量 session 且无活进程 → 加 --resume <id>（方案B）", () => {
  setClaudeSessionId("k-resume", "sess-abc")
  const args = buildCliArgs({ sessionKey: "k-resume", skipPermissions: true })
  const i = args.indexOf("--resume")
  expect(i).toBeGreaterThanOrEqual(0)
  expect(args[i + 1]).toBe("sess-abc")
  // 不应再用旧的 --session-id 续接
  expect(args).not.toContain("--session-id")
})

test("buildCliArgs: includeSessionId=false 时即便有 id 也不 resume（doGenerate 路径）", () => {
  setClaudeSessionId("k-nogen", "sess-x")
  const args = buildCliArgs({
    sessionKey: "k-nogen",
    skipPermissions: true,
    includeSessionId: false,
  })
  expect(args).not.toContain("--resume")
})

test("deleteClaudeSessionId 后不再 resume", () => {
  setClaudeSessionId("k-del", "sess-del")
  deleteClaudeSessionId("k-del")
  const args = buildCliArgs({ sessionKey: "k-del", skipPermissions: true })
  expect(args).not.toContain("--resume")
})

test("setClaudeSessionId: 超过上限 LRU 淘汰最旧条目（C4 防无界增长）", () => {
  // 写入足够多条触发上限(MAX_TRACKED_SESSIONS=200)
  for (let i = 0; i < 260; i++) {
    setClaudeSessionId(`cap-${i}`, `id-${i}`)
  }
  // 最早写入的应已被淘汰
  expect(getClaudeSessionId("cap-0")).toBeUndefined()
  // 最近写入的应还在
  expect(getClaudeSessionId("cap-259")).toBe("id-259")
})
