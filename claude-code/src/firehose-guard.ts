// Layer ① — 咽喉点①截流 (firehose cap)
//
// 起因 (2026-06-03): claude 在 Workflow 模式下会喷出海量 stream-json 事件 (尤其
// extended thinking / 子任务思考过程),插件逐条转发给 opencode sidecar → sidecar
// 把每条都堆进内存 + 落库 + 每轮重载历史 → 单进程内存撑爆 (exit 0x80000003),
// 连带前台卡死、停止键失灵、殃及飞书白屏。详见
// OPENCODE-PLAN/需求池/sidecar-OOM崩溃-四层防御加固.md (REQ-049 Layer ①)。
//
// 本 guard 在"洪流进 sidecar 之前"做有界化:
//   - reasoning (thinking): 单轮累计超上限后丢弃,只留一次性提示 — 仅影响展示,绝不影响答案/执行
//   - tool 调用 input: 对最终 parsed JSON 里的超大字符串字段做截断 (合法 JSON,安全)
//   - text (最终答案): 永不截断
//
// 设计原则: 纯函数 + 显式上限,无副作用 (除内部计数),可单测。

export interface FirehoseLimits {
  /** 单轮累计转发给 sidecar 的 reasoning 字符上限,超出后丢弃 */
  maxReasoningChars: number
  /** 单个 tool 调用 input 里任一字符串字段的字符上限,超出截断 */
  maxToolInputChars: number
}

export const DEFAULT_FIREHOSE_LIMITS: FirehoseLimits = {
  // 32K 字符 ≈ 8K token 的思考,展示足够;再多对用户无意义,纯内存负担
  maxReasoningChars: 32_000,
  // 单个 tool 入参里的大字段 (如 Write 的 file content) 截到 16K 字符
  maxToolInputChars: 16_000,
}

export const REASONING_TRUNCATION_NOTICE = "\n\n…[思考过程过长，已省略剩余部分以保护内存]\n\n"

function truncationNote(original: number, kept: number): string {
  return `…[已截断 ${original - kept} 字符以保护内存]`
}

/**
 * 一次性截断一整段 reasoning (供 doGenerate 非流式路径用 —— 它一次拿到完整 thinking)。
 * 与流式 filterReasoning 区别:这里保留前 N 字符再附提示,而非整段丢弃。
 */
export function clampReasoning(
  text: string,
  limits: FirehoseLimits = DEFAULT_FIREHOSE_LIMITS,
): string {
  if (text.length <= limits.maxReasoningChars) return text
  return text.slice(0, limits.maxReasoningChars) + REASONING_TRUNCATION_NOTICE
}

/**
 * 递归截断 parsed tool input 里的超长字符串字段。
 * 只动字符串值,保持对象/数组结构完整 → 产物仍是合法 JSON。
 * 仅影响展示 (claude-code provider 的 tool 都 providerExecuted=true,opencode 不会重跑)。
 */
export function clampToolInput(
  input: unknown,
  maxChars: number = DEFAULT_FIREHOSE_LIMITS.maxToolInputChars,
): unknown {
  if (typeof input === "string") {
    if (input.length <= maxChars) return input
    return input.slice(0, maxChars) + truncationNote(input.length, maxChars)
  }
  if (Array.isArray(input)) {
    return input.map((v) => clampToolInput(v, maxChars))
  }
  if (input && typeof input === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      out[k] = clampToolInput(v, maxChars)
    }
    return out
  }
  return input
}

export interface FirehoseGuard {
  /**
   * 过滤一段 reasoning delta。
   * 返回应转发给 sidecar 的内容 (可能是原文、一次性截断提示、或空串表示丢弃)。
   */
  filterReasoning(delta: string): string
  /** 截断 tool input 里的大字段,返回安全版本 (合法 JSON 结构)。 */
  clampToolInput(input: unknown): unknown
  /** 是否已进入截断 (compact) 状态 — 供日志/诊断。 */
  isReasoningTruncated(): boolean
}

/**
 * 每个 claude 回合 (一次 doStream / doGenerate) 新建一个 guard,持有该回合的累计计数。
 */
export function createFirehoseGuard(
  limits: FirehoseLimits = DEFAULT_FIREHOSE_LIMITS,
): FirehoseGuard {
  let reasoningChars = 0
  let reasoningTruncated = false

  return {
    filterReasoning(delta: string): string {
      if (!delta) return ""
      if (reasoningTruncated) return "" // 已截断,后续 reasoning 全丢
      reasoningChars += delta.length
      if (reasoningChars >= limits.maxReasoningChars) {
        reasoningTruncated = true
        return REASONING_TRUNCATION_NOTICE // 越线这一刻,转发一次提示,之后全丢
      }
      return delta
    },
    clampToolInput(input: unknown): unknown {
      return clampToolInput(input, limits.maxToolInputChars)
    },
    isReasoningTruncated(): boolean {
      return reasoningTruncated
    },
  }
}
