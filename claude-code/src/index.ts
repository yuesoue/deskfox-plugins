import type { LanguageModelV2, ProviderV2 } from "@ai-sdk/provider"
import { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
import { log } from "./logger.js"
import type { ClaudeCodeProviderSettings } from "./types.js"

// 编译期由 tsup 注入 (见 tsup.config.ts `env.PLUGIN_VERSION`).
// 朋友报 ProviderInitError 时, 打开 DEBUG 就能在 log 第一行看到装的是哪版.
export const PLUGIN_VERSION = process.env.PLUGIN_VERSION ?? "dev"

export interface ClaudeCodeProvider extends ProviderV2 {
  (modelId: string): LanguageModelV2
  languageModel(modelId: string): LanguageModelV2
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

  return provider
}

export { ClaudeCodeLanguageModel } from "./claude-code-language-model.js"
export type {
  ClaudeCodeConfig,
  ClaudeCodeProviderSettings,
  ClaudeStreamMessage,
} from "./types.js"
