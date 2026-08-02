// FORK 2026-08-02 (REQ-089 修法A) message-builder 静默短路收紧单测:
// 用户消息只含无法透传的附件(如 PDF)时, 不再返回 ""(那会走静默短路 → UI 表现"发了没反应"),
// 而是返回带兜底说明的消息, 让 Claude 给用户一个可见回应。真正无内容时仍返回 "" 保持短路。
import { test, expect } from "bun:test"
import { getClaudeUserMessage } from "../message-builder"

test("只含非图片附件 → 返回兜底说明消息而非空(不再静默短路)", () => {
  const prompt = [
    {
      role: "user",
      content: [
        { type: "file", mediaType: "application/pdf", data: "JVBERi0xLjQ=" },
      ],
    },
  ] as any

  const msg = getClaudeUserMessage(prompt)
  expect(msg).not.toBe("")
  const parsed = JSON.parse(msg)
  const text = parsed.message.content
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("")
  expect(text).toContain("application/pdf")
  expect(text).toContain("暂不支持")
})

test("确证无新内容(空 text)→ 仍返回空串走静默短路", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "" }] },
  ] as any
  expect(getClaudeUserMessage(prompt)).toBe("")
})

test("正常文本消息不受影响", () => {
  const prompt = [
    { role: "user", content: [{ type: "text", text: "你好" }] },
  ] as any
  const parsed = JSON.parse(getClaudeUserMessage(prompt))
  expect(parsed.message.content[0]).toEqual({ type: "text", text: "你好" })
})

test("文本 + 非图片附件混合 → 文本照发, 不附加兜底说明", () => {
  const prompt = [
    {
      role: "user",
      content: [
        { type: "text", text: "看下这个文件" },
        { type: "file", mediaType: "application/zip", data: "UEs=" },
      ],
    },
  ] as any
  const parsed = JSON.parse(getClaudeUserMessage(prompt))
  const texts = parsed.message.content.map((c: any) => c.text)
  expect(texts).toContain("看下这个文件")
  expect(texts.join("")).not.toContain("暂不支持")
})
