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

test("deleteActiveProcess 对不存在的 key 安全无副作用", () => {
  expect(() => deleteActiveProcess("nope")).not.toThrow()
})
