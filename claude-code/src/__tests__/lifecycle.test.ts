import { test, expect } from "bun:test"
import { spawn } from "node:child_process"
import { EventEmitter } from "node:events"
import {
  setActiveProcess,
  getActiveProcess,
  deleteActiveProcess,
  disposeAll,
  setClaudeSessionId,
  getClaudeSessionId,
} from "../session-manager"

// 用真实子进程(长驻 node 进程)验证 kill / dispose 行为, 不依赖 claude。
function spawnSleeper() {
  // 阻塞在 setInterval, 不退出, 直到被信号杀掉
  const proc = spawn(process.execPath, ["-e", "setInterval(()=>{}, 1e9)"], {
    stdio: ["pipe", "pipe", "pipe"],
  })
  return proc
}

function onExit(proc: ReturnType<typeof spawnSleeper>): Promise<void> {
  return new Promise((res) => proc.once("exit", () => res()))
}

test("deleteActiveProcess: SIGTERM 杀掉真实子进程并从池中移除", async () => {
  const proc = spawnSleeper()
  setActiveProcess("life-1", { proc, lineEmitter: new EventEmitter() })
  expect(getActiveProcess("life-1")).toBeDefined()

  const exited = onExit(proc)
  deleteActiveProcess("life-1")
  await exited // 子进程应响应 SIGTERM 退出

  expect(proc.killed).toBe(true)
  expect(getActiveProcess("life-1")).toBeUndefined()
})

test("disposeAll: SIGKILL 杀掉所有子进程并清空 session", async () => {
  const a = spawnSleeper()
  const b = spawnSleeper()
  setActiveProcess("life-a", { proc: a, lineEmitter: new EventEmitter() })
  setActiveProcess("life-b", { proc: b, lineEmitter: new EventEmitter() })
  setClaudeSessionId("life-a", "sid-a")

  const bothExited = Promise.all([onExit(a), onExit(b)])
  disposeAll()
  await bothExited

  expect(a.killed).toBe(true)
  expect(b.killed).toBe(true)
  expect(getActiveProcess("life-a")).toBeUndefined()
  expect(getActiveProcess("life-b")).toBeUndefined()
  expect(getClaudeSessionId("life-a")).toBeUndefined() // disposeAll 清空 claudeSessions
})

test(
  "deleteActiveProcess: 子进程吞掉 SIGTERM 时 2s 后 SIGKILL 兜底",
  async () => {
    // 用 /bin/sh 的 `trap "" TERM` 忽略 SIGTERM(与 node/bun 运行时无关), 模拟"阻塞在
    // stdin 不响应 SIGTERM"的 claude → 只有 SIGKILL 能杀。
    const proc = spawn(
      "/bin/sh",
      ["-c", 'trap "" TERM; while :; do sleep 0.2; done'],
      { stdio: ["pipe", "pipe", "pipe"] },
    )
    setActiveProcess("life-kill", { proc, lineEmitter: new EventEmitter() })

    const exitInfo = new Promise<{ code: number | null; signal: string | null }>(
      (res) => proc.once("exit", (code, signal) => res({ code, signal })),
    )
    // 等 sh 执行到 trap 那行装好忽略 handler, 否则 SIGTERM 在 trap 生效前到达会直接杀掉
    await new Promise((r) => setTimeout(r, 300))
    deleteActiveProcess("life-kill") // SIGTERM 被吞 → SIGKILL_DELAY_MS(2s) 后 SIGKILL
    const { signal } = await exitInfo

    expect(signal).toBe("SIGKILL")
    expect(getActiveProcess("life-kill")).toBeUndefined()
  },
  10000, // 兜底 2s + 余量
)

test("deleteActiveProcess 对不存在的 key 安全无副作用", () => {
  expect(() => deleteActiveProcess("nope")).not.toThrow()
})
