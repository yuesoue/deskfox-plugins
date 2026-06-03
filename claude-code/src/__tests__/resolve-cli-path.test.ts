import { test, expect } from "bun:test"
import { existsSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { resolveCliPath } from "../session-manager"

function claudeOnPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which"
    const out = execFileSync(cmd, ["claude"], { encoding: "utf8" }).trim()
    return out.split(/\r?\n/)[0]?.trim() || null
  } catch {
    return null
  }
}

test("裸命令名原样返回(交给系统 PATH 解析)", () => {
  expect(resolveCliPath("claude")).toBe("claude")
})

test("有效绝对路径原样返回", () => {
  const real = claudeOnPath()
  if (!real || !existsSync(real)) return // 无 claude 环境跳过
  expect(resolveCliPath(real)).toBe(real)
})

// 核心:这正是今天线上故障的形状 —— jsonc 单反斜杠 "C:\Users\..\claude.exe" 被宽松解析吞掉反斜杠,
// plugin 收到 "C:Users..claude.exe"(无分隔符的死路径)。鲁棒性目标:自动 fallback 到 PATH 里的 claude。
test("反斜杠被吞的坏路径 → 自愈 fallback 到 PATH 的 claude", () => {
  const real = claudeOnPath()
  if (!real) return // 无 claude 环境时此场景应抛错,见下一条
  const mangled = "C:UsersBogusNonexistentWinGetLinksclaude.exe"
  const resolved = resolveCliPath(mangled)
  expect(resolved).not.toBe(mangled)
  expect(existsSync(resolved)).toBe(true)
})

test("路径无效且 PATH 也无 claude → 抛清晰中文错误", () => {
  if (claudeOnPath()) return // 机器装了 claude 时该路径走 fallback,本断言仅在无 claude 环境有效
  expect(() => resolveCliPath("Z:\\definitely\\missing\\claude.exe")).toThrow(/claude CLI 未找到/)
})
