import { spawn, execFileSync, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
import { existsSync } from "node:fs"
import { log } from "./logger.js"

export interface ActiveProcess {
  proc: ChildProcess
  lineEmitter: EventEmitter
  // FORK 2026-06-06 (bug#2) idle 回收: 每轮 turn 完成后启动, 超时未来新消息则回收进程, 复用命中时清掉.
  idleTimer?: ReturnType<typeof setTimeout>
}

// 空闲多久后回收子进程(补"插件收不到 opencode session-close 事件"缺口的唯一插件侧手段).
const IDLE_TIMEOUT_MS = 7 * 60 * 1000

// SIGTERM 后等多久, 进程仍未退出则 SIGKILL 兜底.
const SIGKILL_DELAY_MS = 2000

// Keyed by cwd - one active process per working directory
const activeProcesses = new Map<string, ActiveProcess>()

// Map cwd -> Claude CLI session ID for session reuse
const claudeSessions = new Map<string, string>()

export function getActiveProcess(key: string): ActiveProcess | undefined {
  const ap = activeProcesses.get(key)
  // FORK 2026-06-06 复用命中: 取消 idle 回收定时器, 进程要继续跑下一轮.
  if (ap?.idleTimer) {
    clearTimeout(ap.idleTimer)
    ap.idleTimer = undefined
  }
  return ap
}

export function setActiveProcess(key: string, ap: ActiveProcess): void {
  activeProcesses.set(key, ap)
}

export function deleteActiveProcess(key: string): void {
  const ap = activeProcesses.get(key)
  if (!ap) return
  if (ap.idleTimer) {
    clearTimeout(ap.idleTimer)
    ap.idleTimer = undefined
  }
  activeProcesses.delete(key)

  const proc = ap.proc
  // FORK 2026-06-06 (加固) 先 SIGTERM, 阻塞在 stdin 的 CLI 一般会响应;
  // 若 SIGKILL_DELAY_MS 后仍未退出再强杀兜底.
  try {
    proc.kill("SIGTERM")
  } catch {}

  if (proc.exitCode === null && proc.signalCode === null) {
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        log.warn("process did not exit after SIGTERM, sending SIGKILL", { key })
        try {
          proc.kill("SIGKILL")
        } catch {}
      }
    }, SIGKILL_DELAY_MS)
    killTimer.unref?.()
    proc.once("exit", () => clearTimeout(killTimer))
  }
}

/**
 * FORK 2026-06-06 (bug#2) 启动/重置 idle 回收定时器.
 * 在每轮 turn 完成后调用: 进程留池里供下一轮复用, 但若 IDLE_TIMEOUT_MS 内没有
 * 新消息(getActiveProcess 未命中), 就回收进程并清掉 session, 避免孤儿 idle 进程堆积.
 */
export function resetIdleTimer(key: string): void {
  const ap = activeProcesses.get(key)
  if (!ap) return
  if (ap.idleTimer) clearTimeout(ap.idleTimer)
  ap.idleTimer = setTimeout(() => {
    // FORK 2026-06-06 (方案 B) 只杀进程, 保留 session id: 本轮已正常完成(idle 计时从 result 起算),
    // 转录在盘上是完整的, 下轮 buildCliArgs 会用 --resume <id> 无损续接.
    log.info("idle process timed out, recycling (keeping session for resume)", {
      key,
    })
    deleteActiveProcess(key)
  }, IDLE_TIMEOUT_MS)
  ap.idleTimer.unref?.()
}

/**
 * FORK 2026-06-06 (兜底/dispose) 杀掉所有活动子进程并清空 session, 供插件卸载时调用.
 */
export function disposeAll(): void {
  for (const [key, ap] of activeProcesses) {
    if (ap.idleTimer) clearTimeout(ap.idleTimer)
    try {
      ap.proc.kill("SIGKILL")
    } catch {}
    activeProcesses.delete(key)
  }
  claudeSessions.clear()
}

// FORK 2026-06-06 (兜底) sidecar 退出/收到信号时, 强杀所有残留子进程, 避免变真孤儿.
let exitHandlersRegistered = false
function registerExitHandlers(): void {
  if (exitHandlersRegistered) return
  exitHandlersRegistered = true

  const killAll = () => {
    for (const ap of activeProcesses.values()) {
      try {
        ap.proc.kill("SIGKILL")
      } catch {}
    }
  }

  process.on("exit", killAll)
  for (const sig of ["SIGTERM", "SIGINT"] as const) {
    process.on(sig, () => {
      killAll()
      process.exit(0)
    })
  }
}
registerExitHandlers()

export function getClaudeSessionId(key: string): string | undefined {
  return claudeSessions.get(key)
}

export function setClaudeSessionId(key: string, sessionId: string): void {
  claudeSessions.set(key, sessionId)
}

export function deleteClaudeSessionId(key: string): void {
  claudeSessions.delete(key)
}

// FORK 2026-06-03 (cliPath robustness): 解析 + 自愈 cliPath。
// 背景: opencode.jsonc 里 Windows 路径若写成单反斜杠 "C:\Users\..."(非法 JSON),
// 宽松 jsonc 解析器会静默吞掉反斜杠 → plugin 收到 "C:Users..." → spawn 报 ENOENT / uv_spawn
// EUNKNOWN,错误晦涩难自查。这里在 spawn 前验证 cliPath,无效时自动 fallback 到 PATH 里的 claude,
// 彻底找不到才抛清晰中文错误。结果缓存,避免每次 spawn 都跑 where/which。
let cliPathCache: { input: string; output: string } | null = null

function findClaudeOnPath(): string | null {
  try {
    const cmd = process.platform === "win32" ? "where" : "which"
    const out = execFileSync(cmd, ["claude"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
    const first = out.split(/\r?\n/)[0]?.trim()
    return first || null
  } catch {
    return null
  }
}

export function resolveCliPath(cliPath: string): string {
  if (cliPathCache && cliPathCache.input === cliPath) return cliPathCache.output

  const looksLikePath = /[\\/]/.test(cliPath) || /^[a-zA-Z]:/.test(cliPath)
  // 裸命令名(如 "claude")→ 交给系统 PATH 解析,不做存在性检查
  if (!looksLikePath) {
    cliPathCache = { input: cliPath, output: cliPath }
    return cliPath
  }
  // 显式路径存在 → 直接用
  if (existsSync(cliPath)) {
    cliPathCache = { input: cliPath, output: cliPath }
    return cliPath
  }
  // 路径无效(典型: jsonc 单反斜杠被吞成 "C:Users...")→ 自愈: 从 PATH 找 claude
  const fromPath = findClaudeOnPath()
  if (fromPath) {
    log.error("configured cliPath invalid, auto-recovered from PATH", {
      configured: cliPath,
      recovered: fromPath,
      hint: "opencode.jsonc 里 Windows 路径反斜杠要写双反斜杠 \\\\ 或正斜杠 /;单 \\ 会被 JSON 解析吞掉",
    })
    cliPathCache = { input: cliPath, output: fromPath }
    return fromPath
  }
  // 彻底找不到 → 抛清晰错误(中文,可诊断)
  throw new Error(
    `claude CLI 未找到: 配置的 cliPath="${cliPath}" 不存在, 且系统 PATH 里也没有 claude。\n` +
      `请检查 ~/.config/opencode/opencode.jsonc 的 provider.claude-code.options.cliPath。\n` +
      `Windows 路径反斜杠需写成双反斜杠(C:\\\\Users\\\\...)或正斜杠(C:/Users/...)。`,
  )
}

export function spawnClaudeProcess(
  cliPath: string,
  cliArgs: string[],
  cwd: string,
  sessionKey: string,
): ActiveProcess {
  // Validate CWD: fall back to process.cwd() if missing or non-existent.
  // An invalid CWD causes uv_spawn to fail with EUNKNOWN on Windows.
  const effectiveCwd = (cwd && existsSync(cwd)) ? cwd : process.cwd()
  if (effectiveCwd !== cwd) {
    log.warn("cwd invalid or missing, falling back to process.cwd()", {
      requested: cwd,
      effective: effectiveCwd,
    })
  }

  const effectiveCliPath = resolveCliPath(cliPath)
  log.info("spawning new claude process", { cliPath: effectiveCliPath, cliArgs, cwd: effectiveCwd, sessionKey })

  const proc = spawn(effectiveCliPath, cliArgs, {
    cwd: effectiveCwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
  })

  // FORK 2026-06-03 (cliPath robustness): spawn 失败(ENOENT / EUNKNOWN 等)挂 error handler,
  // 把 cliPath / cwd 现场写进 error log。此前缺此 handler → spawn 失败不留日志, 难诊断。
  proc.on("error", (err: NodeJS.ErrnoException) => {
    log.error("claude process spawn failed", {
      error: err?.message ?? String(err),
      code: err?.code,
      cliPath: effectiveCliPath,
      cwd: effectiveCwd,
    })
  })

  const lineEmitter = new EventEmitter()

  const rl = createInterface({ input: proc.stdout! })
  rl.on("line", (line: string) => {
    lineEmitter.emit("line", line)
  })
  rl.on("close", () => {
    lineEmitter.emit("close")
  })

  const ap: ActiveProcess = { proc, lineEmitter }
  activeProcesses.set(sessionKey, ap)

  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey })
    activeProcesses.delete(sessionKey)
    if (code !== 0 && code !== null) {
      log.info("process exited with error, clearing session", {
        code,
        sessionKey,
      })
      claudeSessions.delete(sessionKey)
    }
  })

  proc.stderr?.on("data", (data: Buffer) => {
    const stderr = data.toString()
    log.debug("stderr", { data: stderr.slice(0, 200) })

    if (
      stderr.includes("Session ID") &&
      (stderr.includes("already in use") ||
        stderr.includes("not found") ||
        stderr.includes("invalid"))
    ) {
      log.warn("claude session ID error, clearing session", {
        sessionKey,
        error: stderr.slice(0, 200),
      })
      claudeSessions.delete(sessionKey)
    }
  })

  return ap
}

export function buildCliArgs(opts: {
  sessionKey: string
  skipPermissions: boolean
  includeSessionId?: boolean
  model?: string
}): string[] {
  const { sessionKey, skipPermissions, includeSessionId = true, model } = opts
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose",
  ]

  if (model) {
    args.push("--model", model)
  }

  if (includeSessionId) {
    const sessionId = claudeSessions.get(sessionKey)
    if (sessionId && !activeProcesses.has(sessionKey)) {
      // FORK 2026-06-06 (方案 B) 进程被回收/中途 kill 后, 转录仍完整落在 claude 自己盘上
      // (~/.claude/projects/<hash>/<session-id>.jsonl). 下轮用 --resume <id> 从磁盘无损续接,
      // 而非 --session-id(后者是"给新会话指定 id", 对已存在的 id 会撞 "already in use").
      // resume 失败(转录损坏/被占)由 spawnClaudeProcess 的 stderr 兜底清掉 id, 退回摘要重建.
      args.push("--resume", sessionId)
    }
  }

  if (skipPermissions) {
    args.push("--dangerously-skip-permissions")
  }

  return args
}

/**
 * Build a session key that includes cwd, model, and the opencode sessionID
 * so different opencode sessions on the same project+model get separate
 * Claude CLI processes (otherwise they share stdin/stdout and conversation history).
 * opencodeSessionId comes from providerOptions._opencode.sessionID (deskfox-fork).
 * Falls back to "default" on vanilla opencode — same as previous behavior.
 */
export function sessionKey(
  cwd: string,
  modelId: string,
  opencodeSessionId?: string,
): string {
  return `${cwd}::${modelId}::${opencodeSessionId ?? "default"}`
}
