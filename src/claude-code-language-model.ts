import type {
  LanguageModelV2,
  LanguageModelV2CallWarning,
  LanguageModelV2Content,
  LanguageModelV2FinishReason,
  LanguageModelV2StreamPart,
  LanguageModelV2Usage,
} from "@ai-sdk/provider"
import { generateId } from "@ai-sdk/provider-utils"
import type { ClaudeCodeConfig, ClaudeStreamMessage } from "./types.js"
import { mapTool } from "./tool-mapping.js"
import { getClaudeUserMessage } from "./message-builder.js"
import {
  getActiveProcess,
  spawnClaudeProcess,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
  deleteActiveProcess,
  sessionKey,
} from "./session-manager.js"
import { log } from "./logger.js"

// FORK 2026-04-29 ai-sdk@6 升级了 usage schema (asLanguageModelUsage 期望 nested object,
// 见 ai/dist/index.js:2526). 旧 flat number 形式 { inputTokens: 0 } 会让 ai-sdk
// 多轮对话访问 .total 时抛 "undefined is not an object". 所有 usage emit 走此 helper.
// 旧 totalTokens 字段 v6 不要(ai-sdk 内部用 addTokenCounts 自己算).
function makeUsage(input?: number, output?: number) {
  return {
    inputTokens: {
      total: input ?? 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    outputTokens: {
      total: output ?? 0,
      text: 0,
      reasoning: 0,
    },
  } as any
}

export class ClaudeCodeLanguageModel implements LanguageModelV2 {
  readonly specificationVersion = "v2"
  readonly modelId: string
  private readonly config: ClaudeCodeConfig

  constructor(modelId: string, config: ClaudeCodeConfig) {
    this.modelId = modelId
    this.config = config
  }

  readonly supportedUrls: Record<string, RegExp[]> = {}

  get provider(): string {
    return this.config.provider
  }

  private requestScope(options: { tools?: unknown }): "tools" | "no-tools" {
    return Array.isArray(options?.tools) ? "tools" : "no-tools"
  }

  private latestUserText(
    prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
  ): string {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i]
      if (msg.role !== "user") continue

      if (typeof msg.content === "string") {
        return String(msg.content).trim()
      }

      if (Array.isArray(msg.content)) {
        const text = (msg.content as any[])
          .filter((part) => part.type === "text" && typeof part.text === "string")
          .map((part: any) => String(part.text).trim())
          .filter(Boolean)
          .join(" ")
        if (text) return text
      }
    }

    return ""
  }

  private synthesizeTitle(
    prompt: Parameters<LanguageModelV2["doGenerate"]>[0]["prompt"],
  ): string {
    const source = this.latestUserText(prompt)
      .replace(/\s+/g, " ")
      .replace(/[^\p{L}\p{N}\s-]/gu, " ")
      .trim()

    if (!source) return "New Session"

    const stop = new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project",
    ])

    const words = source
      .split(" ")
      .map((word) => word.trim())
      .filter(Boolean)
      .filter((word) => !stop.has(word.toLowerCase()))

    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean))
      .slice(0, 6)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ")

    return picked || "New Session"
  }

  async doGenerate(
    options: Parameters<LanguageModelV2["doGenerate"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doGenerate"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    const cwd = this.config.cwd ?? process.cwd()
    const scope = this.requestScope(options as any)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`)

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      return {
        content: [{ type: "text", text }] as any,
        finishReason: "stop",
        usage: makeUsage(),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools",
          },
        },
        warnings,
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    // FORK 2026-04-29 同 doStream: 返回 content 包含一个空 text part 而非 [], 防止 opencode 重 poll.
    const lastMessage = options.prompt[options.prompt.length - 1]
    if (lastMessage?.role === "assistant") {
      log.debug("doGenerate short-circuit: prompt ends with assistant")
      return {
        content: [{ type: "text", text: "" }] as any,
        finishReason: "stop",
        usage: makeUsage(),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-turn" },
        },
        warnings,
      }
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const includeHistoryContext = !hasExistingSession && hasPriorConversation

    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext)

    // FORK 2026-04-29 (bug#3) message-builder 返回 "" 表示 prompt 没有可发的 user content.
    // 不能 spawn Claude — 走跟 'prompt ends with assistant' 同样的 silent short-circuit, 避免 UI 红条.
    if (!userMsg) {
      log.debug("doGenerate silent: empty user message after message-builder")
      return {
        content: [{ type: "text", text: "" }] as any,
        finishReason: "stop",
        usage: makeUsage(),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: new Date(),
          modelId: this.modelId,
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-turn-empty-msg" },
        },
        warnings,
      }
    }

    // doGenerate always spawns a fresh process, never reuse session ID
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId,
    })

    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
    })

    const { spawn } = await import("node:child_process")
    const { createInterface } = await import("node:readline")

    const proc = spawn(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" },
    })

    const rl = createInterface({ input: proc.stdout! })

    let responseText = ""
    let thinkingText = ""
    let resultMeta: {
      sessionId?: string
      costUsd?: number
      durationMs?: number
      usage?: ClaudeStreamMessage["usage"]
    } = {}
    const toolCalls: Array<{ id: string; name: string; args: unknown }> = []

    const result = await new Promise<
      typeof resultMeta & {
        text: string
        thinking: string
        toolCalls: typeof toolCalls
      }
    >((resolve, reject) => {
      rl.on("line", (line) => {
        if (!line.trim()) return
        try {
          const msg: ClaudeStreamMessage = JSON.parse(line)

          if (msg.type === "system" && msg.subtype === "init") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
          }

          if (msg.type === "assistant" && msg.message?.content) {
            for (const block of msg.message.content) {
              if (block.type === "text" && block.text) {
                responseText += block.text
              }
              if (block.type === "thinking" && block.thinking) {
                thinkingText += block.thinking
              }
              if (block.type === "tool_use" && block.id && block.name) {
                if (
                  block.name === "AskUserQuestion" ||
                  block.name === "ask_user_question"
                ) {
                  // Emit question as text
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const question =
                    (parsedInput?.question as string) || "Question?"
                  responseText += `\n\n_Asking: ${question}_\n\n`
                  continue
                }

                if (block.name === "ExitPlanMode") {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  const plan = (parsedInput?.plan as string) || ""
                  responseText += `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`
                  continue
                }

                toolCalls.push({
                  id: block.id,
                  name: block.name,
                  args: block.input ?? {},
                })
              }
            }
          }

          if (msg.type === "content_block_start" && msg.content_block) {
            if (
              msg.content_block.type === "tool_use" &&
              msg.content_block.id &&
              msg.content_block.name
            ) {
              toolCalls.push({
                id: msg.content_block.id,
                name: msg.content_block.name,
                args: {},
              })
            }
          }

          if (msg.type === "content_block_delta" && msg.delta) {
            if (msg.delta.type === "text_delta" && msg.delta.text) {
              responseText += msg.delta.text
            }
            if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
              thinkingText += msg.delta.thinking
            }
            if (
              msg.delta.type === "input_json_delta" &&
              msg.delta.partial_json &&
              msg.index !== undefined
            ) {
              const tc = toolCalls[msg.index]
              if (tc) {
                try {
                  tc.args = JSON.parse(msg.delta.partial_json)
                } catch {
                  // Partial JSON, accumulate
                }
              }
            }
          }

          if (msg.type === "result") {
            if (msg.session_id) {
              setClaudeSessionId(sk, msg.session_id)
            }
            resultMeta = {
              sessionId: msg.session_id,
              costUsd: msg.total_cost_usd,
              durationMs: msg.duration_ms,
              usage: msg.usage,
            }
            resolve({
              ...resultMeta,
              text: responseText,
              thinking: thinkingText,
              toolCalls,
            })
          }
        } catch {
          // Ignore non-JSON lines
        }
      })

      rl.on("close", () => {
        resolve({
          ...resultMeta,
          text: responseText,
          thinking: thinkingText,
          toolCalls,
        })
      })

      proc.on("error", (err) => {
        log.error("process error", { error: err.message })
        reject(err)
      })

      proc.stderr?.on("data", (data: Buffer) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) })
      })

      proc.stdin?.write(userMsg + "\n")
    })

    const content: LanguageModelV2Content[] = []

    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking,
      } as any)
    }

    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null,
          },
        },
      })
    }

    for (const tc of result.toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip,
      } = mapTool(tc.name, tc.args)
      if (skip) continue
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed,
      } as any)
    }

    const usage: LanguageModelV2Usage = makeUsage(
      result.usage?.input_tokens,
      result.usage?.output_tokens,
    )

    return {
      content,
      // FORK 2026-04-29 同 stream 端: 全部 providerExecuted=true 不需 ai-sdk 回灌 tool-result, 永远 "stop".
      finishReason: "stop" as LanguageModelV2FinishReason,
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: new Date(),
        modelId: this.modelId,
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null,
        },
      },
      warnings,
    }
  }

  async doStream(
    options: Parameters<LanguageModelV2["doStream"]>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV2["doStream"]>>> {
    const warnings: LanguageModelV2CallWarning[] = []
    // FORK 2026-04-29 (bug#1) cwd 优先级: 当前 opencode 没传 providerOptions['claude-code'].cwd
    // (诊断 log 确认 providerOptions['claude-code'] 是空对象), 但保留这个优先级 — 一旦上游 opencode
    // 加了 session.project_root 注入, plugin 不用改一行就自动跟随用户切项目.
    // raw exe 跑模式下 process.cwd() = release 目录会让 Claude 误判项目位置, 留待 opencode 端改.
    const providerCwd = (options.providerOptions as any)?.["claude-code"]?.cwd
    const cwd = providerCwd ?? this.config.cwd ?? process.cwd()
    const cliPath = this.config.cliPath
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`)

    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt)
      const textId = generateId()
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({ type: "text-start", id: textId } as any)
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text,
          })
          controller.enqueue({ type: "text-end", id: textId })
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools",
              },
            },
          })
          controller.close()
        },
      })

      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    const hasPriorConversation =
      options.prompt.filter((m) => m.role === "user" || m.role === "assistant")
        .length > 1

    // New session — clear any stale state from a previous session
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk)
      deleteActiveProcess(sk)
    }

    // FORK 2026-04-29 prompt 末尾是 assistant: opencode 在 turn 结束后还会 polling 调 doStream,
    // 必须返回"完整空响应" stream 才能让 opencode 状态机认这次 turn 真正结束 (只 stream-start+finish 不够).
    const lastMessage = options.prompt[options.prompt.length - 1]
    if (lastMessage?.role === "assistant") {
      log.debug("doStream short-circuit: prompt ends with assistant")
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          const tid = generateId()
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({
            type: "response-metadata",
            id: generateId(),
            timestamp: new Date(),
            modelId: "sonnet",
          } as any)
          controller.enqueue({ type: "text-start", id: tid } as any)
          controller.enqueue({ type: "text-delta", id: tid, delta: "" } as any)
          controller.enqueue({ type: "text-end", id: tid })
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-turn" },
            },
          })
          controller.close()
        },
      })
      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    const hasExistingSession = !!getClaudeSessionId(sk)
    const hasActiveProcess = !!getActiveProcess(sk)
    const includeHistoryContext =
      !hasExistingSession && !hasActiveProcess && hasPriorConversation

    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext)

    // FORK 2026-04-29 (bug#3) 同 doGenerate: 空 userMsg 走 silent short-circuit, 避免 UI 红条.
    if (!userMsg) {
      log.debug("doStream silent: empty user message after message-builder")
      const tid = generateId()
      const modelIdSnapshot = this.modelId
      const stream = new ReadableStream<LanguageModelV2StreamPart>({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings })
          controller.enqueue({
            type: "response-metadata",
            id: generateId(),
            timestamp: new Date(),
            modelId: modelIdSnapshot,
          } as any)
          controller.enqueue({ type: "text-start", id: tid } as any)
          controller.enqueue({ type: "text-delta", id: tid, delta: "" } as any)
          controller.enqueue({ type: "text-end", id: tid })
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-turn-empty-msg" },
            },
          })
          controller.close()
        },
      })
      return {
        stream,
        request: { body: { text: "" } },
      }
    }

    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess,
    })

    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions,
      model: this.modelId,
    })

    // FORK 2026-04-29 capture 给 stream callback 用 (callback 内 `this` 不是 class 实例)
    const capturedModelId = this.modelId

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        let activeProcess = getActiveProcess(sk)
        let proc: import("child_process").ChildProcess
        let lineEmitter: import("events").EventEmitter

        if (activeProcess) {
          proc = activeProcess.proc
          lineEmitter = activeProcess.lineEmitter
          log.debug("reusing active process", { sk })
        } else {
          const ap = spawnClaudeProcess(cliPath, cliArgs, cwd, sk)
          proc = ap.proc
          lineEmitter = ap.lineEmitter
        }

        controller.enqueue({ type: "stream-start", warnings })
        // FORK 2026-04-29 必须 emit response-metadata, 否则 opencode 收不到 message id/finish 字段,
        // step loop break 条件 (lastAssistant?.finish truthy) 永远失败 → 无限 polling.
        controller.enqueue({
          type: "response-metadata",
          id: generateId(),
          timestamp: new Date(),
          modelId: capturedModelId,
        } as any)

        const textId = generateId()
        let textStarted = false

        const reasoningIds = new Map<number, string>()
        const reasoningStarted = new Map<number, boolean>()

        let turnCompleted = false
        let controllerClosed = false

        const toolCallMap = new Map<
          number,
          { id: string; name: string; inputJson: string }
        >()
        const toolCallsById = new Map<
          string,
          { id: string; name: string; input: unknown }
        >()

        let resultMeta: {
          sessionId?: string
          costUsd?: number
          durationMs?: number
          usage?: ClaudeStreamMessage["usage"]
        } = {}

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          if (controllerClosed) return

          try {
            const msg: ClaudeStreamMessage = JSON.parse(line)

            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype,
            })

            // Handle system init
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
                log.info("session initialized", {
                  claudeSessionId: msg.session_id,
                })
              }
            }

            // content_block_start
            if (
              msg.type === "content_block_start" &&
              msg.content_block &&
              msg.index !== undefined
            ) {
              const block = msg.content_block
              const idx = msg.index

              if (block.type === "thinking") {
                const reasoningId = generateId()
                reasoningIds.set(idx, reasoningId)
                controller.enqueue({
                  type: "reasoning-start",
                  id: reasoningId,
                } as any)
                reasoningStarted.set(idx, true)
              }

              if (block.type === "text") {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId,
                  } as any)
                  textStarted = true
                }
              }

              if (block.type === "tool_use" && block.id && block.name) {
                toolCallMap.set(idx, {
                  id: block.id,
                  name: block.name,
                  inputJson: "",
                })

                if (
                  block.name !== "AskUserQuestion" &&
                  block.name !== "ask_user_question" &&
                  block.name !== "ExitPlanMode"
                ) {
                  const { name: mappedName, skip } = mapTool(block.name)
                  if (!skip) {
                    controller.enqueue({
                      type: "tool-input-start",
                      id: block.id,
                      toolName: mappedName,
                    } as any)
                    log.info("tool started", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                    })
                  }
                }
              }
            }

            // content_block_delta
            if (
              msg.type === "content_block_delta" &&
              msg.delta &&
              msg.index !== undefined
            ) {
              const delta = msg.delta
              const idx = msg.index

              if (delta.type === "thinking_delta" && delta.thinking) {
                const reasoningId = reasoningIds.get(idx)
                if (reasoningId) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking,
                  } as any)
                }
              }

              if (delta.type === "text_delta" && delta.text) {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId,
                  } as any)
                  textStarted = true
                }
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: delta.text,
                })
              }

              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx)
                if (tc) {
                  tc.inputJson += delta.partial_json
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: delta.partial_json,
                  } as any)
                }
              }
            }

            // content_block_stop
            if (
              msg.type === "content_block_stop" &&
              msg.index !== undefined
            ) {
              const idx = msg.index

              const reasoningId = reasoningIds.get(idx)
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId,
                } as any)
                reasoningStarted.delete(idx)
              }

              const tc = toolCallMap.get(idx)
              if (tc) {
                let parsedInput: any = {}
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}")
                } catch {}

                if (
                  tc.name === "AskUserQuestion" ||
                  tc.name === "ask_user_question"
                ) {
                  // Emit question as text
                  let question = "Question?"
                  if (
                    parsedInput?.questions &&
                    Array.isArray(parsedInput.questions) &&
                    parsedInput.questions.length > 0
                  ) {
                    question =
                      parsedInput.questions[0].question ||
                      parsedInput.questions[0].text ||
                      "Question?"
                  } else {
                    question =
                      parsedInput?.question ||
                      parsedInput?.text ||
                      "Question?"
                  }

                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId,
                    } as any)
                    textStarted = true
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: `\n\n_Asking: ${question}_\n\n`,
                  })
                } else if (tc.name === "ExitPlanMode") {
                  // Emit plan as text and ask user to accept/refuse
                  const plan = (parsedInput?.plan as string) || ""

                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId,
                    } as any)
                    textStarted = true
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                  })
                } else {
                  const {
                    name: mappedName,
                    input: mappedInput,
                    executed,
                    skip,
                  } = mapTool(tc.name, parsedInput)

                  if (!skip) {
                    toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: tc.name,
                      input: parsedInput,
                    })

                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: tc.id,
                      toolName: mappedName,
                      input: JSON.stringify(mappedInput),
                      providerExecuted: executed,
                    } as any)
                  }
                  log.info("tool call complete", {
                    name: tc.name,
                    mappedName,
                    id: tc.id,
                    executed,
                  })
                }
              }
            }

            // assistant message (complete, not streaming)
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId,
                    } as any)
                    textStarted = true
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: block.text,
                  })
                }

                if (block.type === "thinking" && block.thinking) {
                  const thinkingId = generateId()
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking,
                  } as any)
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId,
                  } as any)
                }

                if (block.type === "tool_use" && block.id && block.name) {
                  const parsedInput = (block.input ?? {}) as Record<
                    string,
                    unknown
                  >
                  toolCallsById.set(block.id, {
                    id: block.id,
                    name: block.name,
                    input: parsedInput,
                  })

                  if (
                    block.name === "AskUserQuestion" ||
                    block.name === "ask_user_question"
                  ) {
                    let question = "Question?"
                    if (
                      parsedInput?.questions &&
                      Array.isArray(parsedInput.questions) &&
                      parsedInput.questions.length > 0
                    ) {
                      const q = parsedInput.questions[0] as any
                      question = q.question || q.text || "Question?"
                    } else {
                      question =
                        (parsedInput?.question as string) ||
                        (parsedInput?.text as string) ||
                        "Question?"
                    }

                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      } as any)
                      textStarted = true
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `\n\n_Asking: ${question}_\n\n`,
                    })
                  } else if (block.name === "ExitPlanMode") {
                    // Emit plan as text and ask user to accept/refuse
                    const plan = (parsedInput?.plan as string) || ""

                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId,
                      } as any)
                      textStarted = true
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `\n\n${plan}\n\n---\n**Do you want to proceed with this plan?** (yes/no)\n`,
                    })
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip,
                    } = mapTool(block.name, parsedInput)

                    if (!skip) {
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName,
                      } as any)
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed,
                      } as any)
                    }
                    log.info("tool_use from assistant message", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                      executed,
                    })
                  }
                }

                if (block.type === "tool_result") {
                  log.debug("tool_result", {
                    toolUseId: block.tool_use_id,
                  })
                }
              }
            }

            // user message (tool results from Claude CLI)
            if (msg.type === "user" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  const toolCall = toolCallsById.get(block.tool_use_id)
                  if (toolCall) {
                    let resultText = ""
                    if (typeof block.content === "string") {
                      resultText = block.content
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content
                        .filter(
                          (
                            c,
                          ): c is { type: string; text: string } =>
                            c.type === "text" &&
                            typeof c.text === "string",
                        )
                        .map((c) => c.text)
                        .join("\n")
                    }

                    controller.enqueue({
                      type: "tool-result",
                      toolCallId: block.tool_use_id,
                      toolName: toolCall.name,
                      result: {
                        output: resultText,
                        title: toolCall.name,
                        metadata: {},
                      },
                      providerExecuted: true,
                    } as any)
                    log.info("tool result emitted", {
                      toolUseId: block.tool_use_id,
                      name: toolCall.name,
                    })
                    toolCallsById.delete(block.tool_use_id)
                  }
                }
              }
            }

            // result - end of conversation turn
            if (msg.type === "result") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
              }
              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage,
              }

              log.info("conversation result", {
                sessionId: msg.session_id,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                isError: msg.is_error,
              })

              turnCompleted = true

              if (textStarted) {
                controller.enqueue({ type: "text-end", id: textId })
              }

              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId,
                  } as any)
                }
              }

              controller.enqueue({
                type: "finish",
                // FORK 2026-04-29 永远 "stop": 所有 tool-call 都 providerExecuted=true,
                // Claude CLI 内部已执行完, ai-sdk 不需要回灌 tool-result.
                // 标 "tool-calls" 会让 ai-sdk 误以为要继续工具循环, 又调 doStream 触发"思考中"卡死.
                finishReason: "stop",
                usage: makeUsage(msg.usage?.input_tokens, msg.usage?.output_tokens),
                providerMetadata: {
                  "claude-code": resultMeta,
                },
              })

              controllerClosed = true
              lineEmitter.off("line", lineHandler)
              lineEmitter.off("close", closeHandler)

              try {
                controller.close()
              } catch {}
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error:
                e instanceof Error ? e.message : String(e),
            })
          }
        }

        const closeHandler = () => {
          log.debug("readline closed")
          if (controllerClosed) return
          controllerClosed = true
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textId })
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": resultMeta,
            },
          })
          try {
            controller.close()
          } catch {}
        }

        lineEmitter.on("line", lineHandler)
        lineEmitter.on("close", closeHandler)

        proc.on("error", (err: Error) => {
          log.error("process error", { error: err.message })
          if (controllerClosed) return
          controllerClosed = true
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        })

        // On abort, keep process alive for next message
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            if (!turnCompleted) {
              log.info(
                "abort signal received mid-turn, keeping process alive",
                { cwd },
              )
            }
            if (!controllerClosed) {
              controllerClosed = true
              lineEmitter.off("line", lineHandler)
              lineEmitter.off("close", closeHandler)
              try {
                controller.close()
              } catch {}
            }
          })
        }

        // Send the user message
        proc.stdin?.write(userMsg + "\n")
        log.debug("sent user message", { textLength: userMsg.length })
      },
      cancel() {
        // Consumer cancelled the stream
      },
    })

    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} },
    }
  }
}
