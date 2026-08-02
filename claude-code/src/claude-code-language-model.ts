import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
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
  resolveCliPath,
  buildCliArgs,
  setClaudeSessionId,
  getClaudeSessionId,
  deleteClaudeSessionId,
  deleteActiveProcess,
  resetIdleTimer,
  sessionKey,
} from "./session-manager.js"
import { log } from "./logger.js"
// FORK 2026-06-04 (firehose-cap): Layer① 截流 — 防 claude Workflow 海量事件撑爆 sidecar 内存
// 详见 OPENCODE-PLAN/需求池/sidecar-OOM崩溃-四层防御加固.md (REQ-049 Layer①)
import {
  createFirehoseGuard,
  clampReasoning,
  clampToolInput,
} from "./firehose-guard.js"

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

// FORK 2026-05-19 vanilla opencode 没注入 _opencode.sessionID 时,用 prompt 第一条 user
// message 的哈希当 session 指纹,避免同 cwd+model 下多个 opencode 会话共享 Claude CLI 子进程
// 导致历史串台. 一次会话里第一条 user message 是稳定的;两个不同会话第一句撞一样概率极低.
function fingerprintFromPrompt(
  prompt: Parameters<LanguageModelV2["doStream"]>[0]["prompt"],
): string {
  for (const msg of prompt) {
    if (msg.role !== "user") continue
    let text = ""
    if (typeof msg.content === "string") {
      text = msg.content
    } else if (Array.isArray(msg.content)) {
      text = (msg.content as any[])
        .filter((p) => p.type === "text" && typeof p.text === "string")
        .map((p: any) => p.text as string)
        .join("")
    }
    if (text) {
      return createHash("sha256").update(text).digest("hex").slice(0, 12)
    }
  }
  return "default"
}

// FORK 2026-08-02 (REQ-089 修法B) 发送 watchdog: 写 stdin 后该毫秒数内没收到任何 stream-json
// 事件 → 判僵进程(REQ-051 领域的"写入已死进程石沉大海"), 杀掉重 spawn(session id 保留则自动
// --resume)重发本条, 用户无感。只守望"写入→首个事件"窗口, 事件一到即解除, 不影响长回合。
// 重试一次后仍无事件则放弃并给用户可见提示(胜过旧行为的无限沉默)。测试用环境变量调小。
const SEND_WATCHDOG_MS = Number(
  process.env.OPENCODE_CLAUDE_CODE_WATCHDOG_MS ?? 15000,
)

// FORK 2026-08-02 (REQ-089 修法A) 静默短路时的 prompt 形态快照: roles 链 + 末条消息的
// part 类型/长度。写进 log 便于回归观察短路是否误伤真实新消息(user 反馈"发了没反应"专项)。
function promptShapeSnapshot(
  prompt: Parameters<LanguageModelV2["doStream"]>[0]["prompt"],
): Record<string, unknown> {
  const last = prompt[prompt.length - 1]
  let lastParts: string[] = []
  if (last) {
    if (typeof last.content === "string") {
      lastParts = [`text(len=${(last.content as string).length})`]
    } else if (Array.isArray(last.content)) {
      lastParts = (last.content as any[]).map((p) =>
        p.type === "text"
          ? `text(len=${(p.text ?? "").length})`
          : p.type === "file"
            ? `file(${p.mediaType ?? "?"})`
            : String(p.type),
      )
    }
  }
  return {
    roles: prompt.map((m) => m.role).join(","),
    lastRole: last?.role,
    lastParts: lastParts.join("|"),
  }
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
    const providerCwd = (options.providerOptions as any)?._opencode?.cwd
    const opencodeSessionId =
      (options.providerOptions as any)?._opencode?.sessionID ??
      fingerprintFromPrompt(options.prompt)
    // Use || not ?? so empty-string CWD (possible from DeskFox) falls back correctly.
    const cwd = (providerCwd && existsSync(providerCwd))
      ? providerCwd
      : this.config.cwd || process.cwd()
    const scope = this.requestScope(options as any)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, opencodeSessionId)

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
      // FORK 2026-08-02 (REQ-089 修法A) 短路带 prompt 形态快照, 便于回归观察是否误伤
      log.debug(
        "doGenerate short-circuit: prompt ends with assistant",
        promptShapeSnapshot(options.prompt),
      )
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
      // FORK 2026-08-02 (REQ-089 修法A) 此路径经 message-builder 收紧后只剩"确证无新内容"
      // (有实质被丢附件时 message-builder 已改发兜底说明)。升 warn + 快照, 便于回归观察。
      log.warn(
        "doGenerate silent short-circuit: empty user message after message-builder",
        promptShapeSnapshot(options.prompt),
      )
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

    // FORK 2026-06-03 (cliPath robustness): 同 spawnClaudeProcess,解析 + 自愈 cliPath。
    const proc = spawn(resolveCliPath(this.config.cliPath), cliArgs, {
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

    type DoGenerateResult = typeof resultMeta & {
      text: string
      thinking: string
      toolCalls: typeof toolCalls
    }
    let result: DoGenerateResult
    // FORK 2026-06-06 (加固) doGenerate 每次新 spawn 不入池, 用完(含异常分支)必杀, 防残留 idle 进程.
    try {
      result = await new Promise<DoGenerateResult>((resolve, reject) => {
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
        log.error("process error (doGenerate)", {
          error: err.message,
          cliPath: this.config.cliPath,
          cwd,
        })
        reject(err)
      })

      proc.stderr?.on("data", (data: Buffer) => {
        log.debug("stderr", { data: data.toString().slice(0, 200) })
      })

      proc.stdin?.write(userMsg + "\n")
      })
    } finally {
      try {
        proc.kill("SIGTERM")
      } catch {}
    }

    const content: LanguageModelV2Content[] = []

    if (result.thinking) {
      content.push({
        type: "reasoning",
        // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): 截断超长思考,防 sidecar 内存堆积
        text: clampReasoning(result.thinking),
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
        // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): 截断超大入参字段
        input: JSON.stringify(clampToolInput(mappedInput)),
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
    // FORK 2026-04-29 (bug#1) cwd 优先级: 从 deskfox-fork 注入的 _opencode 通用 namespace 取项目目录.
    // 配套 deskfox-fork commit 41817499d (feat: plugin-cwd-channel), opencode 在 streamText
    // providerOptions 里加 _opencode.cwd = Instance.directory, 让所有 spawn-based plugin 共用此协议.
    // 优先级: _opencode.cwd > config.cwd > process.cwd() (process.cwd() 是 sidecar 启动目录, 不跟随用户切项目).
    const providerCwd = (options.providerOptions as any)?._opencode?.cwd
    const opencodeSessionId =
      (options.providerOptions as any)?._opencode?.sessionID ??
      fingerprintFromPrompt(options.prompt)
    // Use || not ?? so empty-string CWD (possible from DeskFox) falls back correctly.
    const cwd = (providerCwd && existsSync(providerCwd))
      ? providerCwd
      : this.config.cwd || process.cwd()
    const cliPath = this.config.cliPath
    const skipPermissions = this.config.skipPermissions !== false
    const scope = this.requestScope(options as any)
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, opencodeSessionId)

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
      // FORK 2026-08-02 (REQ-089 修法A) 短路带 prompt 形态快照, 便于回归观察是否误伤。
      // 此路径属 step-loop 正常轮询(每轮 turn 结束后必来一次), 保持 debug 级避免刷屏。
      log.debug(
        "doStream short-circuit: prompt ends with assistant",
        promptShapeSnapshot(options.prompt),
      )
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
      // FORK 2026-08-02 (REQ-089 修法A) 同 doGenerate: 收紧后只剩"确证无新内容", 升 warn + 快照。
      log.warn(
        "doStream silent short-circuit: empty user message after message-builder",
        promptShapeSnapshot(options.prompt),
      )
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

    // FORK 2026-06-06 (bug#1) consumer 取消 stream 时, cancel() 走与 abort 相同的清理.
    // teardown 在 start() 内构造(需访问 proc/handlers), 这里抬出引用供 cancel() 调.
    let onConsumerCancel: (() => void) | undefined

    const stream = new ReadableStream<LanguageModelV2StreamPart>({
      start(controller) {
        // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): 本回合的截流 guard,
        // 把 reasoning / tool 入参 / tool 结果有界化,防 sidecar 内存撑爆。
        const guard = createFirehoseGuard()
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

        // FORK 2026-06-06 (B1) resume 失败透明重试:
        // 本次是否用 --resume 起的(有存量 session id 且无活进程时 buildCliArgs 会加 --resume)。
        // 若 resume 的进程没吐出 system init 就退出(典型: 续接一个被 kill / 损坏的 session),
        // 自动清掉 id、用历史摘要重建消息、重 spawn 一个全新会话, 用户无感, 不丢这条消息。
        let usingResume = hasExistingSession && !hasActiveProcess
        let sawInit = false
        let resumeRetried = false
        let currentUserMsg = userMsg

        // FORK 2026-08-02 (REQ-089 修法B) 发送 watchdog 状态(定义见 armWatchdog/onWatchdogFire)
        let watchdogTimer: ReturnType<typeof setTimeout> | undefined
        let watchdogRetried = false
        const clearWatchdog = () => {
          if (watchdogTimer) {
            clearTimeout(watchdogTimer)
            watchdogTimer = undefined
          }
        }

        const lineHandler = (line: string) => {
          if (!line.trim()) return
          // FORK 2026-08-02 (REQ-089 修法B) 任何 stream 输出 = 进程活着, 解除发送守望
          clearWatchdog()
          if (controllerClosed) return

          try {
            const msg: ClaudeStreamMessage = JSON.parse(line)

            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype,
            })

            // Handle system init
            if (msg.type === "system" && msg.subtype === "init") {
              // FORK 2026-06-06 (B1) 收到 init = 进程活着且会话已建立(resume 成功或 fresh 成功),
              // 标记之, 让 closeHandler 不再误触发 resume 重试。
              sawInit = true
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id)
                log.info("session initialized", {
                  claudeSessionId: msg.session_id,
                  viaResume: usingResume,
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
                  // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): reasoning 超上限后丢弃
                  const safe = guard.filterReasoning(delta.thinking)
                  if (safe)
                    controller.enqueue({
                      type: "reasoning-delta",
                      id: reasoningId,
                      delta: safe,
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
                      // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): 截断超大入参字段
                      input: JSON.stringify(guard.clampToolInput(mappedInput)),
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
                  // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): reasoning 超上限后丢弃
                  const safe = guard.filterReasoning(block.thinking)
                  if (safe) {
                    const thinkingId = generateId()
                    controller.enqueue({
                      type: "reasoning-start",
                      id: thinkingId,
                    } as any)
                    controller.enqueue({
                      type: "reasoning-delta",
                      id: thinkingId,
                      delta: safe,
                    } as any)
                    controller.enqueue({
                      type: "reasoning-end",
                      id: thinkingId,
                    } as any)
                  }
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
                        // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): 截断超大入参字段
                        input: JSON.stringify(guard.clampToolInput(mappedInput)),
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
                        // FORK 2026-06-04 (firehose-cap REQ-049 Layer①): 截断超大工具结果(子任务输出大头)
                        output: clampToolInput(resultText) as string,
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
              // FORK 2026-06-06 (B1 修复) claude 对失败的 --resume 不静默退出, 而是发一条
              // result{isError:true}。若本次用了 resume 且从未 init, 这条 result 就是 resume
              // 失败信号 → 转 fresh 重试, 别把它当正常完成(否则这条消息被赔成空回复)。
              if (tryResumeRetry()) return

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

              // FORK 2026-06-06 (bug#2) 本轮正常完成, 进程留池供复用 → 启动 idle 回收定时器,
              // IDLE_TIMEOUT_MS 内无新消息则回收(getActiveProcess 命中会取消它).
              resetIdleTimer(sk)
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error:
                e instanceof Error ? e.message : String(e),
            })
          }
        }

        // FORK 2026-06-06 (B1 修复) resume 失败的透明重试, 统一两处入口:
        //   1) result 处理器: claude 对失败的 --resume 会发一条 result{isError:true} 而非静默退出
        //   2) closeHandler: resume 进程没吐 init 就 readline close(静默退出)
        // 判据 = 用了 --resume 且从未收到 init 且没重试过。命中则: 清 id、用历史摘要重建消息、
        // 重 spawn 一个全新会话, 用户无感, 不丢这条消息。
        const tryResumeRetry = (): boolean => {
          if (!(usingResume && !sawInit && !resumeRetried)) return false
          resumeRetried = true
          log.warn(
            "--resume failed (no init), retrying fresh with history summary",
            { sk },
          )
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          deleteClaudeSessionId(sk)
          deleteActiveProcess(sk)
          usingResume = false
          currentUserMsg = getClaudeUserMessage(options.prompt, true)
          relaunchFresh()
          return true
        }

        const closeHandler = () => {
          log.debug("readline closed")
          clearWatchdog()
          if (controllerClosed) return

          // resume 进程没 init 就静默关闭 → 转 fresh 重试
          if (tryResumeRetry()) return

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

        const procErrorHandler = (err: Error) => {
          log.error("process error (doStream)", {
            error: err.message,
            code: (err as any).code,
            cliPath,
            cwd,
          })
          clearWatchdog()
          if (controllerClosed) return
          controllerClosed = true
          controller.enqueue({ type: "error", error: err })
          try {
            controller.close()
          } catch {}
        }

        // FORK 2026-06-06 (B1) 把"挂监听"抽成函数, resume 失败重试时可对新进程重新挂。
        const attachHandlers = () => {
          lineEmitter.on("line", lineHandler)
          lineEmitter.on("close", closeHandler)
          proc.on("error", procErrorHandler)
        }

        // FORK 2026-06-06 (B1) resume 失败后重起一个全新会话(不带 --resume):
        // session id 已在 closeHandler 里清掉 → buildCliArgs 不会再加 --resume → fresh。
        const relaunchFresh = () => {
          const freshArgs = buildCliArgs({
            sessionKey: sk,
            skipPermissions,
            model: capturedModelId,
          })
          const ap = spawnClaudeProcess(cliPath, freshArgs, cwd, sk)
          proc = ap.proc
          lineEmitter = ap.lineEmitter
          attachHandlers()
          proc.stdin?.write(currentUserMsg + "\n")
          log.info("relaunched fresh after resume failure", { sk })
          // FORK 2026-08-02 (REQ-089 修法B) 重发的这条同样守望
          armWatchdog()
        }

        // FORK 2026-08-02 (REQ-089 修法B) watchdog 触发:
        // 第一次 → 判僵进程, 杀掉重 spawn 重发本条(session id 被 deleteActiveProcess 标记
        // 主动杀而保留, buildCliArgs 自动带 --resume; 换进程重挂监听复用 B1 骨架)。
        // SIGSTOP 挂起的进程吃不到 SIGTERM, 由 deleteActiveProcess 的 2s SIGKILL 兜底杀掉。
        // 第二次仍无事件 → 放弃, 给用户可见错误并正常收流, 胜过旧行为的无限沉默。
        const onWatchdogFire = () => {
          watchdogTimer = undefined
          if (controllerClosed) return
          if (!watchdogRetried) {
            watchdogRetried = true
            log.warn(
              "send watchdog fired: no stream events after stdin write, killing & respawning",
              { sk, timeoutMs: SEND_WATCHDOG_MS },
            )
            lineEmitter.off("line", lineHandler)
            lineEmitter.off("close", closeHandler)
            deleteActiveProcess(sk)
            const hasSid = !!getClaudeSessionId(sk)
            const retryArgs = buildCliArgs({
              sessionKey: sk,
              skipPermissions,
              model: capturedModelId,
            })
            const ap = spawnClaudeProcess(cliPath, retryArgs, cwd, sk)
            proc = ap.proc
            lineEmitter = ap.lineEmitter
            // 重试进程若 --resume 失败, 由既有 B1 逻辑兜底(转 fresh + 摘要重建)
            usingResume = hasSid
            sawInit = false
            attachHandlers()
            proc.stdin?.write(currentUserMsg + "\n")
            log.info("watchdog respawn complete, message re-sent", {
              sk,
              viaResume: hasSid,
            })
            armWatchdog()
          } else {
            log.error(
              "send watchdog fired twice: giving up, emitting visible failure",
              { sk },
            )
            controllerClosed = true
            lineEmitter.off("line", lineHandler)
            lineEmitter.off("close", closeHandler)
            deleteActiveProcess(sk)
            if (!textStarted) {
              controller.enqueue({ type: "text-start", id: textId } as any)
              textStarted = true
            }
            controller.enqueue({
              type: "text-delta",
              id: textId,
              delta:
                "⚠️ Claude CLI 子进程无响应(已自动重建并重试一次仍失败)。请重发本条消息;若持续出现,请检查 claude CLI 能否在终端正常启动。",
            })
            controller.enqueue({ type: "text-end", id: textId })
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: makeUsage(),
              providerMetadata: {
                "claude-code": { watchdogGaveUp: true },
              },
            })
            try {
              controller.close()
            } catch {}
          }
        }

        const armWatchdog = () => {
          clearWatchdog()
          watchdogTimer = setTimeout(onWatchdogFire, SEND_WATCHDOG_MS)
          watchdogTimer.unref?.()
        }

        attachHandlers()

        // FORK 2026-06-06 (bug#1) 中途中断的统一清理: 移除监听 + 可选关闭 controller,
        // 并对"未正常完成"的轮次真正杀掉子进程(否则中断了任务但 claude 仍在后台跑/占资源).
        // 正常完成时 controllerClosed 已为 true → 提前 return, 进程留池供复用(不杀)。
        //
        // FORK 2026-06-06 (方案 B) 中途 kill 不再清 session id: claude 的转录是逐条落盘的,
        // 被 SIGKILL 顶多丢"中断那一刻没 flush 完的半句", 之前已完成的轮次都在盘上。
        // 下轮 buildCliArgs 用 --resume <id> 从磁盘续接, 拿到无损上下文。
        // 万一 resume 这个被 kill 的 session 不干净, spawnClaudeProcess 的 stderr 兜底会
        // 检测到错误并清掉 id, 自动退回"摘要重建"路径, 不会卡死。
        const teardown = (reason: string, closeController: boolean) => {
          // FORK 2026-08-02 (REQ-089 修法B) 中断即解除守望, 防 abort 后 watchdog 又拉起新进程
          clearWatchdog()
          if (controllerClosed) return
          controllerClosed = true
          lineEmitter.off("line", lineHandler)
          lineEmitter.off("close", closeHandler)
          if (closeController) {
            try {
              controller.close()
            } catch {}
          }
          if (!turnCompleted) {
            log.info(
              "mid-turn teardown, killing claude process (keeping session for resume)",
              { cwd, sk, reason },
            )
            deleteActiveProcess(sk)
          }
        }

        // 供外层 cancel() 调用(consumer 取消 stream 时, controller 已在销毁, 不再 close)
        onConsumerCancel = () => teardown("cancel", false)

        // On abort: stop streaming and, if mid-turn, kill the process.
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            teardown("abort", true)
          })
        }

        // Send the user message
        proc.stdin?.write(currentUserMsg + "\n")
        log.debug("sent user message", { textLength: currentUserMsg.length })
        // FORK 2026-08-02 (REQ-089 修法B) 守望本次发送: N 秒无任何事件 → 重建重发
        armWatchdog()
      },
      cancel() {
        // FORK 2026-06-06 (bug#1) consumer 取消 stream → 同 abort 一样杀进程 + 清 session.
        onConsumerCancel?.()
      },
    })

    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} },
    }
  }
}
