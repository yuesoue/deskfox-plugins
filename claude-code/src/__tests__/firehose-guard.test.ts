import { test, expect } from "bun:test"
import {
  createFirehoseGuard,
  clampToolInput,
  REASONING_TRUNCATION_NOTICE,
  type FirehoseLimits,
} from "../firehose-guard"

const SMALL: FirehoseLimits = { maxReasoningChars: 100, maxToolInputChars: 20 }

test("reasoning 未超上限时原样转发", () => {
  const g = createFirehoseGuard(SMALL)
  expect(g.filterReasoning("abc")).toBe("abc")
  expect(g.filterReasoning("def")).toBe("def")
  expect(g.isReasoningTruncated()).toBe(false)
})

test("reasoning 越过上限时:越线那刻发一次提示,之后全部丢弃", () => {
  const g = createFirehoseGuard(SMALL)
  // 累计 90 字符,未越线
  expect(g.filterReasoning("x".repeat(90))).toHaveLength(90)
  expect(g.isReasoningTruncated()).toBe(false)
  // 再来 20 字符 → 累计 110 ≥ 100,越线,返回一次性提示(不含原文)
  expect(g.filterReasoning("y".repeat(20))).toBe(REASONING_TRUNCATION_NOTICE)
  expect(g.isReasoningTruncated()).toBe(true)
  // 之后所有 reasoning 都被丢弃
  expect(g.filterReasoning("z".repeat(5))).toBe("")
  expect(g.filterReasoning("more thinking")).toBe("")
})

test("空 reasoning delta 直接返回空,不计数", () => {
  const g = createFirehoseGuard(SMALL)
  expect(g.filterReasoning("")).toBe("")
  expect(g.isReasoningTruncated()).toBe(false)
})

test("text(最终答案)不经 guard —— guard 只管 reasoning/tool,text 路径不调用本函数", () => {
  // 文档化保证:本 guard 不提供 filterText,调用方对 text-delta 直接转发。
  const g = createFirehoseGuard(SMALL)
  expect((g as any).filterText).toBeUndefined()
})

test("clampToolInput:短字符串原样保留", () => {
  expect(clampToolInput("hello", 20)).toBe("hello")
})

test("clampToolInput:超长字符串被截断并附提示", () => {
  const big = "a".repeat(100)
  const out = clampToolInput(big, 20) as string
  expect(out.startsWith("a".repeat(20))).toBe(true)
  expect(out).toContain("已截断")
  expect(out).toContain("80") // 100 - 20
})

test("clampToolInput:递归处理嵌套对象/数组,只动字符串,结构不变", () => {
  const input = {
    file: "doc.md",
    content: "x".repeat(50),
    nested: { deep: "y".repeat(50), keep: "ok" },
    arr: ["z".repeat(50), "short"],
    num: 42,
    bool: true,
    nil: null,
  }
  const out = clampToolInput(input, 20) as any
  expect(out.file).toBe("doc.md")
  expect(out.content).toContain("已截断")
  expect(out.nested.deep).toContain("已截断")
  expect(out.nested.keep).toBe("ok")
  expect(out.arr[0]).toContain("已截断")
  expect(out.arr[1]).toBe("short")
  // 非字符串原样
  expect(out.num).toBe(42)
  expect(out.bool).toBe(true)
  expect(out.nil).toBe(null)
})

test("guard.clampToolInput 用实例上限", () => {
  const g = createFirehoseGuard(SMALL)
  const out = g.clampToolInput({ content: "q".repeat(50) }) as any
  expect(out.content).toContain("已截断")
})
