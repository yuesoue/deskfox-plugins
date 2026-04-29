# NOTES — claude-code plugin(DeskFox 集成)

> 自维护 fork 的开发权威记录。日后跟随上游 / 排 bug / 移交他人 → 先看本文件。

## 1. 上游信息

- 源:https://github.com/unixfox/opencode-claude-code-plugin (**archived**)
- fork 时间:2026-04-29(基于 commit `6522f7a`,2026-04-26)
- 本目录是 git clone + bun install + bun run build 后的自维护副本
- 不发 npm,DeskFox 通过 `file:///D:/project/deskfox-plugins/claude-code/dist/index.js` 引用

## 2. 随上游策略

archived → 上游不会再有 commit。所有维护我们自己来。

可能需要跟的外部变化:
- **Claude Code CLI 协议**(stream-json 标志、tool name)— 详见 §4
- **ai-sdk LanguageModelV2 接口**(plugin 用 `@ai-sdk/provider ^2.0.0`,DeskFox 内嵌 ai-sdk@6 — 协议有不兼容时我们要跟)
- **opencode session prompt loop / providerOptions 协议** — 详见 §6

## 3. fork-only 改动清单(2026-04-29)

按文件分类。所有改动加 `// FORK <date>` marker 便于以后 grep。

### 3.1 `src/message-builder.ts`

- **空 text block 过滤** — 过滤 `msg.content === ""` 和 `part.text === ""` 的 user content,避免 Anthropic API 400 `cache_control` 错误。等价于上游 `2d6f094` 被 revert 的 fix(`644cad6` revert 没说理由,我们重新 apply)
- **空 content fallback throw → return ""** — 旧版 throw 会让 ai-sdk 上层冒红条 `"prompt has no user content..."`;改成返回空字符串作 sentinel,caller 检测后走 silent short-circuit。上游 opencode 的 step polling 行为是根本因,plugin 这是兼容修

### 3.2 `src/claude-code-language-model.ts`

- **finishReason 永远 "stop"** — 不再因为 toolCallMap 非空而标 "tool-calls"。所有 tool-call 已 `providerExecuted: true`(Claude CLI 内部执行),ai-sdk 不需要回灌 tool-result。原版逻辑会让 ai-sdk 误以为要继续工具循环
- **emit `response-metadata` part** — LanguageModelV2 协议要求,缺这个 opencode 收不到 message id/finish 字段。`stream-start` 之后立即 emit
- **silent short-circuit "prompt ends with assistant"** — opencode step loop 即便上游修了仍会有 polling 余震,plugin 检测 prompt 末尾是 assistant 直接返回完整空 stream
- **silent short-circuit "empty user message"** — message-builder 返回 sentinel "" 时同上,跟 above 路径合并
- **usage schema → ai-sdk@6 nested** — 7 处 emit 全走 `makeUsage(input?, output?)` helper,改 `{inputTokens: {total, noCache, cacheRead, cacheWrite}, outputTokens: {total, text, reasoning}}`,移除 `totalTokens` 字段。旧 flat number 形式在 ai-sdk@6 多轮对话会抛 `undefined is not an object (evaluating $.inputTokens.total)`
- **cwd 优先级 — 接 deskfox-fork `_opencode` 通用 namespace** — `options.providerOptions?._opencode?.cwd ?? this.config.cwd ?? process.cwd()`。配套 deskfox-fork commit `41817499d`(feat: plugin-cwd-channel),opencode 在 streamText 注入 `_opencode.cwd = Instance.directory`,让所有 spawn-based plugin(claude-code/codex/gemini/aider)共用此协议

### 3.3 `src/tool-mapping.ts`

- **PowerShell → bash 映射** — Claude CLI 在 Windows docx 编辑等场景调 `name="PowerShell"`(用 `python-docx` / Word COM API)。input 格式 `{command, description}` 跟 bash 工具一致,直接转 bash + `executed: true`,UI 正常显示
- **unmapped tool fallthrough log.warn** — 防御性诊断,以后再有未知 tool name 进来直接看 debug.log 就能定位

### 3.4 `src/logger.ts`

- **回 DEBUG 环境变量控制(默认关)** — 普通用户机器不再产生 debug.log。需要诊断时设系统变量 `DEBUG=opencode-claude-code` 重启 DeskFox,日志写到 `D:/project/deskfox-plugins/claude-code/debug.log`。自定义路径用 `OPENCODE_CLAUDE_CODE_LOG_FILE`
- **error 级别在 DEBUG 关时仍走 stderr** — sidecar stderr 可能被 DeskFox 主进程捕获,留唯一一类"无论如何留痕"

### 3.5 `install.ps1` + `install.bat`(新增)

Windows 用户一键装。流程:
1. 探测 `claude.exe`:`where claude` → 5 个常见路径(native installer / WinGet / npm 三种 shim)
2. 找不到 → PowerShell `Read-Host` 让用户手输完整路径,循环验证
3. 备份现有 `~/.config/opencode/opencode.jsonc` 为 `.bak.<timestamp>`
4. 合并写入 `provider['claude-code']` 节(保留用户其他 provider 不动)
5. 写 UTF-8 no BOM,unicode escape 解码后中文可读
6. 提示重启 DeskFox

`.ps1` 必须 UTF-8 with BOM 否则 PowerShell 5.1 按 GBK 解析中文乱码。

## 4. Claude CLI 协议兼容性(2026-04-29 验)

| 标志 | CLI 状态 |
|---|---|
| `--output-format stream-json` | 仍支持 |
| `--input-format stream-json` | 仍支持 |
| `--verbose` | 仍支持 |
| `--model sonnet/opus/haiku` | 仍支持(别名) |
| `--session-id <uuid>` | 仍支持 |
| `--dangerously-skip-permissions` | 仍支持 |

注:CLI help 写 `--input-format/--output-format` "only works with --print",但 plugin 实测不加 `-p` 也能跑(双向流模式 CLI 默认走 print 行为)。这跟 help 文本表述不一致,但实测 OK,未来 CLI 修可能要加 `-p`。

## 5. 配套的 deskfox-fork 改动

不在本仓内,记录指针便于追溯:

- **opencode step loop 不 break** — `D:\project\opencode-fork\packages\opencode\src\session\prompt.ts` 加 hasStepFinish 兜底块,commit `e2a9d7167`,文档 `docs/features/claude-code-loop-fix/`。**此 fix 不依赖 plugin,plugin 哪怕全删 fork 改动只剩原版,opencode 这边 step loop 也修了**
- **opencode 注入 `_opencode.cwd` 给 spawn 类 plugin** — `D:\project\opencode-fork\packages\opencode\src\session\llm.ts` 在 streamText `providerOptions` 里加 `_opencode = { cwd: Instance.directory, project: Instance.project.id }`,commit `41817499d`,文档 `docs/features/plugin-cwd-channel/`。**plugin 配套读取 `options.providerOptions._opencode.cwd`,两端齐备 → user 切项目时 Claude 看到正确 cwd**

## 6. 已知 TODO

(暂无遗留)

### 已关闭
- ~~Bug #1 真修(cwd 注入)~~ — 2026-04-29 完成。工单 `HANDOFF-deskfox-fork-2-cwd.md` 接手, deskfox-fork commit `41817499d` 用更通用的 `_opencode` namespace 注入(覆盖所有 spawn 类 plugin),plugin 配套接 commit `<本笔>`。两端齐备,user 切项目时 Claude 跟随。注:实际命名比工单建议的 `claude-code` namespace 更通用,deskfox-fork agent 优化了设计

## 7. 工程约定

- 改 plugin 源码必加 `// FORK <date> ...` marker,理由要写
- 不发 npm,本地 `file://` 引用 dist
- DEBUG 默认关,出 bug 时设环境变量复现 + 看 `debug.log`
- 上游 archived → 不存在 rebase 上游(只有跟 Claude CLI / ai-sdk 协议的兼容性维护)

## 8. 历史(commit 时间线)

按时间倒序:

- 2026-04-29 cwd 接 `_opencode` namespace(配套 deskfox-fork `41817499d`),Bug #1 闭环
- 2026-04-29 install.ps1 + .bat 自动探测 + 配置写入 + 探测 native installer 路径
- 2026-04-29 4 个独立 bug fix(usage schema / silent return / PowerShell mapping / cwd 防御性)
- 2026-04-29 emit response-metadata + finishReason "stop" + silent short-circuit(开始未直接解,后由 opencode-fork 的 step loop fix 配合解决)
- 2026-04-29 message-builder 空 text 过滤 fix(等价上游 2d6f094)
- 2026-04-29 git clone unixfox 仓库 + bun install + bun run build,baseline 落地
