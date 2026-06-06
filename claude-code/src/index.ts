import type { LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { disposeAll } from "./session-manager.js"
import { log } from "./logger.js"
import type { ClaudeCodeProviderSettings } from "./types.js"

// 编译期由 tsup 注入 (见 tsup.config.ts `env.PLUGIN_VERSION`).
// 朋友报 ProviderInitError 时, 打开 DEBUG 就能在 log 第一行看到装的是哪版.
export const PLUGIN_VERSION = process.env.PLUGIN_VERSION ?? "dev"

export interface ClaudeCodeProvider extends ProviderV2 {
  (modelId: string): LanguageModelV2
  languageModel(modelId: string): LanguageModelV2
  // FORK 2026-06-06 (兜底) 杀掉所有活动 claude 子进程并清 session。
  // 注意: opencode 当前没有插件卸载钩子会调它, 故这是"预留接口"——真正的进程兜底回收
  // 靠 session-manager 注册的 process exit/signal handler。若将来 opencode 暴露 unload 钩子,
  // 在那里调 provider.dispose() 即可做到更及时的回收。
  dispose(): void
}

export function createClaudeCode(
  settings: ClaudeCodeProviderSettings = {},
): ClaudeCodeProvider {
  const cliPath =
    settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude"
  const cwd = settings.cwd ?? process.cwd()
  const providerName = settings.name ?? "claude-code"

  log.info("plugin loaded", {
    version: PLUGIN_VERSION,
    cliPath,
    cwd,
    providerName,
  })

  const createModel = (modelId: string): LanguageModelV2 => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      cwd,
      skipPermissions: settings.skipPermissions ?? true,
    })
  }

  const provider = function (modelId: string) {
    return createModel(modelId)
  } as ClaudeCodeProvider

  provider.languageModel = createModel
  provider.dispose = disposeAll

  return provider
}

export { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
export { disposeAll } from "./session-manager.js"
export type {
  ClaudeCodeConfig,
  ClaudeCodeProviderSettings,
  ClaudeStreamMessage,
} from "./types.js"
