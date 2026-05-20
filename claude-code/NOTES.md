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

- **回 DEBUG 环境变量控制(默认关)** — 普通用户机器不再产生 debug.log。需要诊断时设系统变量 `DEBUG=opencode-claude-code` 重启 DeskFox,日志写到 `~/.config/opencode/claude-code-plugin.log`(2026-05-20 修硬编码 bug 后跨平台默认值;旧版本写死 `D:/project/deskfox-plugins/claude-code/debug.log` — 我的开发机绝对路径,朋友机器上 `appendFileSync` 静默失败丢日志)。自定义路径用 `OPENCODE_CLAUDE_CODE_LOG_FILE`
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

- 2026-05-20 修 ProviderInitError 根因 — tsup 加 `noExternal: [/@ai-sdk\//]` 让 dist 真正 self-contained,详见 §10;同步修 logger 默认日志路径硬编码到我开发机的 bug;补 `.gitignore` 排除运行时残留(`debug.log` / `*.log` / `.claude/`);清上游遗留 5 个死文件(`mod.ts` / `jsr.json` / `test.ts` / `10097.patch` / `.github/workflows/publish.yml`)
- 2026-05-13 image attachment 端到端跑通(image content block + modalities 字段)— 详见 §9
- 2026-04-29 cwd 接 `_opencode` namespace(配套 deskfox-fork `41817499d`),Bug #1 闭环
- 2026-04-29 install.ps1 + .bat 自动探测 + 配置写入 + 探测 native installer 路径
- 2026-04-29 4 个独立 bug fix(usage schema / silent return / PowerShell mapping / cwd 防御性)
- 2026-04-29 emit response-metadata + finishReason "stop" + silent short-circuit(开始未直接解,后由 opencode-fork 的 step loop fix 配合解决)
- 2026-04-29 message-builder 空 text 过滤 fix(等价上游 2d6f094)
- 2026-04-29 git clone unixfox 仓库 + bun install + bun run build,baseline 落地

## 9. Image attachment 支持(2026-05-13)

### 9.1 用户视角的症状

DeskFox 聊天窗 Ctrl+V / 点附件按钮上传截图,模型回复"当前模型不支持图片输入,请切到支持视觉的模型"。三个模型(sonnet/opus/haiku)行为一致。Opus 4.7 实际是有 vision 能力的,这句话是**模型基于看不到图片的事实做的合理化幻觉**。

### 9.2 根因(不在 plugin)

opencode 运行时在调用 provider plugin 之前,会基于 model config 的 `modalities.input` 数组判断要不要把 image / pdf / audio 等附件转发给 provider:

```js
// opencode-cli.exe 内部 (反汇编 grep 出来的逻辑)
input: {
  image: $.modalities?.input?.includes("image") ?? false,
  // ...
}
// 后面:
if (!$.capabilities.input[Sl(mediaType)]) {
  return {
    type: "text",
    text: `ERROR: Cannot read "${filename}" (this model does not support ${kind} input). Inform the user.`
  }
}
```

我们原 install 脚本只写了 `attachment: true`(那只是控 DeskFox UI 显不显示附件按钮),没写 `modalities`,所以 opencode 把 file part 替换成那段 ERROR 文本传给模型,模型照本宣科告诉用户"不支持"。

### 9.3 修复(双侧改动)

**Plugin 侧**(`src/message-builder.ts`):

- 在用户消息循环里加 `part.type === "file"` 分支(`// FORK 2026-05-13`),命中 `mediaType` 以 `image/` 开头的 file part 时,转成 Claude stream-json 的 `image` content block
- 新增 `toClaudeImageSource()` helper 处理 AI SDK v2 `LanguageModelV2FilePart.data` 的三种形态(`Uint8Array` / `URL` / `string`),分别走 base64 / url source。实测 opencode 喂过来的是 base64 string(命中兜底分支),Uint8Array/URL 路径目前用不上但保留以防 ai-sdk 改实现
- 非 image 的 file part(PDF 等)打 warn 后跳过,避免给 CLI 喂消化不了的东西

**Config 侧**(`install.sh` + `install.ps1`):

三个 model 节点都加(2026-05-13):

```json
"attachment": true,
"modalities": { "input": ["text", "image"], "output": ["text"] }
```

opencode schema(从二进制反汇编):

```js
modalities: optional(Struct({
  input:  Array(Literals(["text","audio","image","video","pdf"])),
  output: Array(Literals(["text","audio","image","video","pdf"])),
}))
```

**坑点**:`modalities` 整体是 optional,但**一旦提供,input + output 都必须给**。只给 input 触发 schema 校验失败,DeskFox 启动报"无法连接到本地服务器"。debug 期踩过一次,回滚到 install 备份恢复。

### 9.4 验证手段(留作下次 debug 参考)

- 设 `DEBUG=opencode-claude-code` 环境变量(`setx DEBUG opencode-claude-code`)→ plugin 写 `debug.log`
- 关键判定字段:
  - PROBE 日志里 user message parts 出现 `type:"file"` → 说明 opencode 没拦截
  - `doStream starting` 行的 `textLength` 飙到几十/几百 KB → 说明 image base64 真进 stream-json
  - CLI 端 `result: success` + `isError: false` → 说明 CLI 接受了 image block
- 调试期临时加过 `getClaudeUserMessage` 入口的 prompt shape dump probe,定位完已撤

### 9.5 Claude CLI 协议确认

stream-json input 模式支持 `{type:"image", source:{type:"base64", media_type, data}}` content block,跟 Anthropic Agent SDK streaming input 文档对齐(https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)。Single-message 模式不支持。我们 plugin 走的就是 stream-json,所以走通。

### 9.6 后续可扩

- PDF 支持:`mediaType === "application/pdf"` 时构造 `{type:"document", source:{type:"base64",...}}`,同时 `modalities.input` 加 `"pdf"`。Claude CLI 同样支持
- 上传 URL 形态附件(opencode 是否会直接给 URL data 还没测过)

## 10. ProviderInitError 与依赖 bundle 策略(2026-05-20)

### 10.1 症状

朋友机器装新版 plugin 后选 Claude Opus(via Claude Code),UI 立刻红条 `ProviderInitError`,
任何 prompt 都过不去。其他 provider(OpenAI 等)正常。

外部 AI 误诊为"opencode auth.json 没凭据"(`& opencode-cli.exe auth login` 修),
但我们这个 plugin **不走 opencode auth 体系** — 鉴权完全在 spawn 出去的 `claude` CLI 内部
(用户先前跑过 `claude login` 存的凭据),`opencode auth` 那套只对 OpenAI/Anthropic API key
直连有用,跟本 plugin 无关。

### 10.2 根因

`dist/index.js` 头部:

```js
import { generateId } from "@ai-sdk/provider-utils";
```

这是**运行时外部依赖**。tsup 默认把 `package.json#dependencies` 视为 external 不 bundle。
而 plugin 目录没有 `node_modules`(zip 不带,install 脚本不跑 npm install)。

历史上能跑是因为 ESM resolver 沿 `node_modules` 向上找,命中了 DeskFox 内嵌
opencode sidecar 自己 bundle 的 ai-sdk 副本(opencode 主程本来就是用 ai-sdk 写的)。
**plugin 一直在借 host 的依赖,从未真正 self-contained**。

DeskFox 升 opencode 到 `@opencode-ai/plugin@0.0.0--202605111441` 后改了 plugin
加载策略,不再向 plugin 暴露主程 `node_modules` → plugin 顶部 import 失败 →
opencode `provider.ts:1554` 包成 `ProviderInitError`。

### 10.3 触发时序(便于以后排相似 bug)

ProviderInitError 在 opencode 主程 **plugin init 阶段**抛,具体三步:

```ts
// opencode 主程 provider.ts:1544
const mod = await import("file:///.../dist/index.js")   // ← 这一步加载顶部 import
const fn = mod[Object.keys(mod).find((k) => k.startsWith("create"))!]
const loaded = fn({ name: model.providerID, ...options })
```

任何一步抛错 → 主程 catch 后 `throw new InitError({ providerID }, { cause: e })`。
本次 bug 卡在第 1 步(`import @ai-sdk/provider-utils` resolve 失败)。

**注意此阶段不接触 `claude.exe`**。`createClaudeCode()` 只是把 `cliPath` 字符串存起来,
不校验文件存不存在。哪怕 `cliPath: "不存在的路径"`,init 也会成功 — 真正的 spawn
发生在用户发消息时(`doStream` → `session-manager.ts:53`),那时挂报的是别的错
(`spawn ENOENT` 之类),**不是 ProviderInitError**。

### 10.4 修法

`tsup.config.ts` 加:

```ts
noExternal: [/@ai-sdk\//]
```

强制 bundle 所有 `@ai-sdk/*` 子包到 dist。

- dist 体积:47KB → 57KB(+10KB 把 generateId 及其依赖链 inline)
- zip 体积:43KB → 58KB
- 用户机器**不再需要 plugin 目录有 `node_modules`**,真正"解压 install 就能用"

### 10.5 验证手段(留作 release 前 checklist)

release 前必跑:

```bash
grep '^import ' dist/index.js
```

顶部 import 应该**只有 Node 内建模块**(`crypto` / `fs` / `path` / `os` /
`child_process` / `readline` / `events`)。任何 `from "@/[非 node:]"` 都视为待修。

也可以 `grep '@ai-sdk' dist/index.js`,匹配到的应只有 tsup 加的 `// node_modules/@ai-sdk/...`
**注释行**(表示 bundle 来源),不该有 `import ... from "@ai-sdk/..."` 语句。

### 10.6 教训

依赖 host 的 `node_modules` / sidecar bundle 是**脆弱协议** — host 升级一脚踩到,
plugin 就挂。对外分发的 plugin 必须强制 self-contained,任何运行时外部 import
都是潜在 ProviderInitError 触发器。

未来加新 `dependencies` 时:

1. tsup 默认 external 行为对发 npm 包合理,**对发 file:// dist 不合理** — 我们这条路上
   `dependencies` 字段实际只是给 dev 时 tsc / IDE 看的类型,生产是要 bundle 的
2. 加新包默认就该走 noExternal,或干脆 `noExternal: [/.*/]` 全量 bundle
3. 等价方案:把这些包从 `dependencies` 挪到 `devDependencies` — tsup 默认会 bundle dev 依赖
   (但 type-check 时 tsc 也需要它们,所以挪要小心。目前 noExternal 方案更稳)
