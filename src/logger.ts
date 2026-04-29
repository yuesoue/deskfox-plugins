// FORK 2026-04-29 默认关日志, 避免普通用户机器无限增长 debug.log.
// 需要诊断时设系统环境变量 DEBUG=opencode-claude-code 后重启 DeskFox, plugin 会写日志到本文件.
// 自定义日志路径: 设 OPENCODE_CLAUDE_CODE_LOG_FILE=<path>.
import { appendFileSync, mkdirSync } from "node:fs"
import path from "node:path"

const DEBUG = process.env.DEBUG?.includes("opencode-claude-code") ?? false
const LOG_FILE =
  process.env.OPENCODE_CLAUDE_CODE_LOG_FILE ??
  "D:/project/deskfox-plugins/claude-code/debug.log"

if (DEBUG) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true })
  } catch {}
}

function fmt(level: string, msg: string, data?: Record<string, unknown>): string {
  const ts = new Date().toISOString()
  const base = `[${ts}] [opencode-claude-code] ${level}: ${msg}`
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`
  }
  return base
}

function write(line: string) {
  if (!DEBUG) return
  try {
    appendFileSync(LOG_FILE, line + "\n")
  } catch {}
}

export const log = {
  info(msg: string, data?: Record<string, unknown>) {
    write(fmt("INFO", msg, data))
  },
  warn(msg: string, data?: Record<string, unknown>) {
    write(fmt("WARN", msg, data))
  },
  // error 在关 DEBUG 时也走 stderr — sidecar stderr 可能被 DeskFox 主进程捕获到日志.
  // 这是 plugin 唯一一类"无论如何也要留痕"的 log level.
  error(msg: string, data?: Record<string, unknown>) {
    const line = fmt("ERROR", msg, data)
    if (DEBUG) write(line)
    else console.error(line)
  },
  debug(msg: string, data?: Record<string, unknown>) {
    write(fmt("DEBUG", msg, data))
  },
}
