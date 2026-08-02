import type { LanguageModelV2 } from "@ai-sdk/provider"
import { log } from "./logger.js"

type Prompt = Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"]

type ClaudeImageSource =
  | { type: "base64"; media_type: string; data: string }
  | { type: "url"; url: string }

// AI SDK v2 file part 的 data 字段是 Uint8Array | string | URL.
// Claude stream-json 的 image block source 支持 base64 / url 两种, 这里做兜底转换.
function toClaudeImageSource(
  data: unknown,
  mediaType: string,
): ClaudeImageSource | null {
  if (data instanceof Uint8Array) {
    return {
      type: "base64",
      media_type: mediaType,
      data: Buffer.from(data).toString("base64"),
    }
  }
  if (data instanceof URL) {
    return { type: "url", url: data.toString() }
  }
  if (typeof data === "string") {
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",")
      if (comma > 0) {
        const header = data.slice(5, comma) // 去掉 "data:"
        const isBase64 = header.endsWith(";base64")
        const mt = (isBase64 ? header.slice(0, -7) : header) || mediaType
        const payload = data.slice(comma + 1)
        return {
          type: "base64",
          media_type: mt,
          // 非 base64 (即 url-encoded plain text) 的图片 data URL 几乎不存在, 这里仍走 base64 通道,
          // Claude 端校验失败再 fallback 处理.
          data: isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString("base64"),
        }
      }
    }
    if (data.startsWith("http://") || data.startsWith("https://")) {
      return { type: "url", url: data }
    }
    // 兜底: 假设已经是 base64.
    return { type: "base64", media_type: mediaType, data }
  }
  return null
}

/**
 * Compact conversation history into a context summary for when we start
 * a fresh Claude CLI session but want to preserve conversation context.
 */
export function compactConversationHistory(prompt: Prompt): string | null {
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant",
  )

  if (conversationMessages.length <= 1) {
    return null
  }

  const historyParts: string[] = []

  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i]
    const role = msg.role === "user" ? "User" : "Assistant"

    let text = ""
    if (typeof msg.content === "string") {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      const textParts = (msg.content as any[])
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
      text = textParts.join("\n")

      const toolCalls = (msg.content as any[]).filter(
        (p) => p.type === "tool-call",
      )
      const toolResults = (msg.content as any[]).filter(
        (p) => p.type === "tool-result",
      )

      if (toolCalls.length > 0) {
        text += `\n[Called ${toolCalls.length} tool(s): ${toolCalls.map((t: any) => t.toolName).join(", ")}]`
      }
      if (toolResults.length > 0) {
        text += `\n[Received ${toolResults.length} tool result(s)]`
      }
    }

    if (text.trim()) {
      const truncated =
        text.length > 2000 ? text.slice(0, 2000) + "..." : text
      historyParts.push(`${role}: ${truncated}`)
    }
  }

  if (historyParts.length === 0) {
    return null
  }

  return historyParts.join("\n\n")
}

/**
 * Convert AI SDK prompt into a Claude CLI stream-json user message.
 */
export function getClaudeUserMessage(
  prompt: Prompt,
  includeHistoryContext: boolean = false,
): string {
  const content: any[] = []

  if (includeHistoryContext) {
    const historyContext = compactConversationHistory(prompt)
    if (historyContext) {
      log.info("including conversation history context", {
        historyLength: historyContext.length,
      })
      content.push({
        type: "text",
        text: `<conversation_history>
The following is a summary of our conversation so far (from a previous session that couldn't be resumed):

${historyContext}

</conversation_history>

Now continuing with the current message:

`,
      })
    }
  }

  // Find messages since last assistant message
  const messages: typeof prompt = []
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "assistant") break
    messages.unshift(prompt[i])
  }

  // FORK 2026-08-02 (REQ-089 修法A) 记录"有实质内容但透传不了"的 part(非图片附件/编不出的图片)。
  // 若最终 content 为空但确有这类 part,说明用户发了东西 → 不能静默短路,改发兜底说明,
  // 让 Claude 给用户一个可见回应,治"发附件后没任何反应"。
  const droppedParts: string[] = []

  for (const msg of messages) {
    if (msg.role === "user") {
      // FORK: filter empty text blocks to avoid Anthropic 400 cache_control error 2026-04-29
      // Re-applies upstream commit 2d6f094 which was reverted in 644cad6 without explanation.
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content })
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content as any[]) {
          if (part.type === "text" && part.text) {
            content.push({ type: "text", text: part.text })
          } else if (part.type === "file") {
            const mediaType: string | undefined = part.mediaType
            if (!mediaType || !mediaType.startsWith("image/")) {
              log.warn("skipping non-image file part in user message", {
                mediaType,
              })
              droppedParts.push(`file(${mediaType ?? "unknown"})`)
              continue
            }
            // 通配 image/* 没法当具体 media_type 用, 退回 image/png 作为最常见选择.
            const concreteMediaType =
              mediaType === "image/*" ? "image/png" : mediaType
            const source = toClaudeImageSource(part.data, concreteMediaType)
            if (source) {
              content.push({ type: "image", source })
            } else {
              log.warn("could not encode image part — dropped", {
                mediaType,
                dataType: typeof part.data,
              })
              droppedParts.push(`image-unencodable(${mediaType})`)
            }
          } else if (part.type === "tool-result") {
            const p = part as any
            let resultText = ""
            if (typeof p.result === "string") {
              resultText = p.result
            } else if (
              typeof p.result === "object" &&
              p.result &&
              "output" in p.result
            ) {
              resultText = String(p.result.output)
            } else {
              resultText = JSON.stringify(p.result)
            }
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: resultText,
            })
          }
        }
      }
    }
  }

  if (content.length === 0) {
    // FORK 2026-08-02 (REQ-089 修法A) 有实质 part 被丢弃 → 不是"无新内容", 静默短路会表现成
    // "发了没反应"。改发兜底说明, 让 Claude 回一句可见的提示, 用户至少知道消息到了但附件不支持。
    if (droppedParts.length > 0) {
      log.warn(
        "all user parts undeliverable — sending fallback note instead of silent short-circuit",
        { droppedParts },
      )
      content.push({
        type: "text",
        text:
          `[系统提示] 用户刚发来的消息只包含无法透传给你的内容(${droppedParts.join(", ")});` +
          `当前通道仅支持文本和图片。请用用户的语言简短告知:该消息的附件类型暂不支持,` +
          `请改用文本描述或截图重发。不要执行其他操作。`,
      })
    } else {
      // FORK 2026-04-29 旧版抛错会在 UI 冒红条 ('prompt has no user content...').
      // 改成返回空字符串作 sentinel — caller (doStream/doGenerate) 检测到空就走 short-circuit
      // 路径返回空 stream, 避免给 Claude CLI 写入空 / 占位消息触发 400 或自循环.
      return ""
    }
  }

  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content,
    },
  })
}
