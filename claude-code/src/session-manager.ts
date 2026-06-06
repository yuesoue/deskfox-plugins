import { spawn, type ChildProcess } from "node:child_process"
import { createInterface } from "node:readline"
import { EventEmitter } from "node:events"
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

export function spawnClaudeProcess(
  cliPath: string,
  cliArgs: string[],
  cwd: string,
  sessionKey: string,
): ActiveProcess {
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey })

  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" },
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
