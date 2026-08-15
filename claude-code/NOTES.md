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

- 2026-08-02 **发版 v0.1.12** — 插件体验专项三连修(OPENCODE-PLAN REQ-089/090/091):静默短路收紧 + 发送 watchdog + 交互工具拦截改纯文本问答 + 长任务前台等待约定,详见 §13
- 2026-05-20 **发版 v0.1.3** — 含 ProviderInitError 修复 + 诊断版本号埋点(dist log 启动行 / install 脚本结尾打印 / zip 命名带版本号 `claude-code-0.1.3.zip`),详见 §10
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

## 10. ProviderInitError 与依赖 bundle 策略(2026-05-20,v0.1.3)

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

### 10.7 配套加的诊断版本号埋点(v0.1.3)

经验:上面这种"装上就坏"的 bug,朋友/未来诊断时第一个问题永远是"你装的是哪版?"。
v0.1.3 加了三处版本号埋点,以后诊断不用再问:

1. **`tsup.config.ts` 注入 `process.env.PLUGIN_VERSION`** — 编译期把 `package.json#version`
   字面量化进 dist。零运行时开销,纯编译期替换
2. **`src/index.ts` `createClaudeCode()` 入口 log 一次** — `log.info("plugin loaded", { version, cliPath, cwd, ... })`,
   DEBUG 开启时,DeskFox 重启选 Claude 模型,plugin log 第一行就有版本号 + 配置快照
3. **install.ps1 / install.sh 结尾打印** `[4/4] 安装完成 (claude-code plugin v0.1.3)`,
   读 `package.json#version`,装完用户/朋友立刻能看见装的是哪版

同步 `pack.mjs` 输出文件名带版本(`claude-code-0.1.3.zip`),对齐 getbot-opencode 命名约定。
未来 bump version 时:
- `package.json#version` 改一处,zip 名 / dist log / install 输出**全部自动跟随**
- 不必去 install 脚本手动改

## 11. 子进程生命周期:中断、回收、续接(v0.1.6)

背景:plugin 把 `claude --output-format stream-json --input-format stream-json` 包成长驻子进程,
按 `sessionKey`(cwd::model::scope::opencodeSessionId)在 `session-manager.ts` 的 `activeProcesses`
里复用跑多轮。早期两个缺陷:点"停止"不杀进程(只 `controller.close()`);跑完/会话关闭后进程永不回收
(无 idle timer、收不到 opencode session-close 事件)→ 孤儿 idle 进程(阻塞在 stdin)持续堆积。

### 11.1 中断真杀(`claude-code-language-model.ts` `doStream`)
- abort 与 cancel 走同一个 `teardown()`:移监听 + 可选关 controller,对**未正常完成**(`!turnCompleted`)
  的轮次 `deleteActiveProcess(sk)` 真杀进程。正常完成时 `controllerClosed` 已 true → 提前 return,
  进程留池供复用(不杀)。
- `cancel()` 不再为空,经抬到外层的 `onConsumerCancel` 触发同一 `teardown`。

### 11.2 idle 回收(`session-manager.ts` `resetIdleTimer`)
- 每轮 turn 完成(收到 `result`)后起 `setTimeout(IDLE_TIMEOUT_MS=7min)`;`getActiveProcess` 复用命中即清掉。
- 超时 → `deleteActiveProcess`(杀进程),**保留 session id**(见 §11.4)。
- 计时从 result 起算,量的是"两轮之间的沉默",**不是任务执行时长** → 长任务(50min)不会被误杀。

### 11.3 进程兜底(`session-manager.ts`)
- `deleteActiveProcess`:先 `SIGTERM`,`SIGKILL_DELAY_MS=2s` 未退再 `SIGKILL`。
- 模块级 `process.on("exit")` 同步杀全部;`SIGTERM`/`SIGINT` 只补杀子进程,**仅当我们是该信号唯一监听者**
  才重发信号终止(B2,避免抢跑 opencode 的优雅关闭)。
- `disposeAll()` / `provider.dispose()` 是**预留接口**:opencode 当前无插件 unload 钩子调它,
  真正兜底靠上面的 exit/signal handler。

### 11.4 无损续接 = 方案 B(`buildCliArgs` 用 `--resume`)
- claude 的会话转录由 CLI 自己逐条落盘(`~/.claude/projects/<hash>/<session-id>.jsonl`),
  与进程死活无关。所以回收/中途 kill **都保留 session id**,下轮 `buildCliArgs` 用 `--resume <id>`
  从磁盘**无损**续接(取代旧的 `--session-id`,后者对已存在 id 会撞 "already in use")。
- **B1 透明重试**:若 `--resume` 的进程没吐 `system init` 就退出(续接被 kill / 损坏的 session),
  `closeHandler` 自动清 id、用历史摘要重建消息、重 spawn 一个 fresh 会话 → 用户无感,不丢这条消息。
  (摘要重建是有损兜底,见 `message-builder.ts compactConversationHistory`)。
- **C4**:方案 B 后 idle 不再清 session id → `claudeSessions` 只增不减,故 `setClaudeSessionId`
  加了 `MAX_TRACKED_SESSIONS=200` 的 LRU 淘汰。

### 11.5 已实测(v0.1.9,真机 DeskFox + 真 claude 2.1.x)
T1~T8 全过:中断真杀、中途 kill 后 `--resume` 续接(进程+语义)、idle 回收后续接、长任务不被
误杀、多次中断无堆积、退出兜底。`claude --resume <id> --input-format stream-json` 组合可用,
被 SIGTERM/SIGKILL 的 session 能干净 resume。单测见 `src/__tests__/`(`bun test`,需本机有 bun);
doStream 流式 / B1 result-path 属集成行为,由真机实测覆盖,未做单测。

### 11.6 ⚠️ 真 claude 的退出/失败行为(踩坑实录,改这块前必读)
方案 B / B1 上线时栽了两个坑,**都因为"假进程/单测的行为和真 claude 不一样",只有真机暴露**。
后人动 §11.3/§11.4 的回收、exit handler、B1 逻辑前,务必记住这两条 claude 实测行为:

1. **claude 被 SIGTERM 杀时,以退出码 143 退出(`code:143, signal:null`),不是 `signal:"SIGTERM"`。**
   → 老 exit handler 的 `if (code !== 0 && code !== null) 清 session` 会把**我们主动杀**的进程当
   错误退出,清掉 session id → 方案 B 的 `--resume` 整个失效(实测:点停止后下轮变 fresh 无 resume)。
   修法:`ActiveProcess.killedIntentionally` 标记,`deleteActiveProcess`/`disposeAll` 主动杀前置位,
   exit handler 仅在 `!killedIntentionally` 时才清。**别假设"信号杀=code null"。**(v0.1.8)

2. **claude 对失败的 `--resume`(转录不存在)不是静默退出,而是先发一条 `result{is_error:true}`
   再以 `code:1` 退出**,stderr 同时有 `No conversation found with session ID: <id>`。
   → B1 最初只在 closeHandler(静默关闭)里检测重试,但 `result` 处理器一看到 result 就
   `turnCompleted=true` 关流,B1 永远跑不到 → 这条消息被赔成空回复,要用户重发才靠摘要自愈。
   修法:`tryResumeRetry()`(判据=用了 resume 且从未收到 `system init` 且没重试过)在 **result 处理器
   顶部** 和 closeHandler 两处都调;配 spawnClaudeProcess exit handler 的**身份守卫**
   (`activeProcesses.get(key) === ap` 才 delete),防 B1 重起的同 key 新进程被老进程退出误删。(v0.1.9)

3. **`result` 不一定属于本轮**:`--resume` 一个"上次结束时留有未完结后台任务"的会话时,claude 会
   先给那条恢复通知补一个**空回合**再处理本轮消息,stdout 实测顺序是
   `system task_notification → system init → result{num_turns:0,result:""} → system init(第二次)
   → assistant(真正的回答) → result{num_turns:1}`。
   → result 处理器一看到第 3 行就 `turnCompleted=true` 关流,真正的回答无处可去 → **UI 上是
   "回车了没有任何反应"**(零 token / 无文本 / 无报错),而 CLI 那头照常把活干完(user 现场:
   DeskFox 侧 1.4s 空回合,CLI 侧继续跑了 3 分半并改完文件)。
   修法与判据取舍见 **§14**。(v0.1.13)

**通用教训**:判断"resume 是否失败"的可靠信号是 **`usingResume && 从未收到 system init`**,
而不是"进程怎么退出的"——因为 claude 失败有多种退出形态(静默 close / result{isError} / 非零 code)。
**同理,收到 `result` 也不等于"本轮结束"**——先确认它属于本轮(见第 3 条)再关流。

### 11.7 为什么用 7 分钟 idle、而不是"会话结束信号"(已调研,决定不做 — 2026-06-06)

有人(包括未来的我)会问:能不能不用 7 分钟 idle 计时,改成 DeskFox 通知插件"会话结束了"再精确回收?
**结论:不能替代,已决定维持 7 分钟现状。** 调研依据(opencode-fork 代码):

1. **provider 拿不到任何会话生命周期信号。** 我们是 AI-SDK provider, 运行时只有 `doStream(options)`。
   这个 fork 往 `providerOptions._opencode` 只注入了 `{cwd, project}`(`llm.ts:375-378`)——
   **连 sessionID 都没注入**。(顺带踩坑记录:本插件代码读 `_opencode.sessionID` 其实永远是
   undefined, 一直在走 `fingerprintFromPrompt` 兜底, 用首条 user message 的哈希当会话指纹;
   sessionKey 末尾那 12 位 hex 就是这指纹, 不是真 sessionID。功能能跑因为指纹在一会话内稳定。)

2. **会话事件存在, 但在另一套系统里。** opencode 有独立的 **Plugin** 系统(配 `plugin:[...]`,
   非 provider), `Hooks.event`(`packages/plugin/src/index.ts:75,223`)能收所有总线事件, 包括
   `session.deleted`(`session/session.ts:324`)、`session.idle`/`session.status`(`session/status.ts:38`)。

3. **根本性语义问题(关键):opencode 的会话是永久记录, "关闭" ≠ "结束/删除"。**
   关掉对话窗口 / 不聊了, 会话仍存在(随时能 resume)。只有**显式删除**才 `session.deleted`。
   所以:
   - 用户显式删对话 → ✅ `session.deleted`(精确)
   - 用户只是不聊了/关窗口 → ❌ **没有任何事件**(设计如此, 会话不死)← 这正是最常见场景
   - 每轮结束 → `session.idle` 会发, 但那是"这轮完了"非"会话完了", 拿来回收=每轮都杀, 白费复用
   → 对"不聊了"这个主场景 opencode **本质上给不出信号**, idle 计时是架构使然, 不是偷懒。

4. **即便只想接 `session.deleted` 做精确补充, 也有前置 gap**:事件带的是真 sessionID, 而 provider
   现在按 fingerprint 建键, 两边对不上。要落地需:fork 在 `_opencode` 补注入 sessionID + provider
   改用 sessionID 建键 + 新增 opencode plugin 入口订阅事件 + `plugin:[]` 注册本包 —— 跨 fork+plugin
   双改的正经功能, 且**替代不了 idle 兜底**(主场景仍无信号)。**投入产出不值, 决定不做。**

结论:7 分钟 idle 计时是当前架构下回收孤儿进程的**唯一可行手段**, 维持现状。
若将来要做精确删除同步, 按第 4 点的清单走, 但记住它只是"删除即时清理"的锦上添花, idle 仍是地基。

### 11.8 Windows 退出/孤儿验证(2026-06-06,真机实测,结论:免 Job Object)
`HANDOFF-windows.md` 第②点让 Windows 端验"宿主退出 / 被强杀时, 插件 spawn 的 claude 子进程
是否变孤儿"。真机(本开发机, Win11 + DeskFox + 真 claude)实测两条路径**均无残留**:

| 场景 | sidecar(opencode-cli) | 插件 claude(带 `--output-format stream-json`) | `exit` 钩子 |
|---|---|---|---|
| ① 托盘正常退出 | 退出 | ✅ 随之消失 | 触发(`process.on("exit", killAll)`) |
| ② **`Stop-Process -Force` 强杀 sidecar**(等价 `TerminateProcess`) | 被强杀 | ✅ **仍随之消失, 无孤儿** | **没机会跑**, 照样无残留 |

**关键机制(强杀也不留孤儿的真正原因, 不是 exit 钩子):** 插件 claude 是 `--input-format stream-json`,
阻塞读取 sidecar 持有的 stdin 管道。sidecar 被 `TerminateProcess` 时 OS 关闭管道写入端 →
claude stdin 收到 EOF → **claude 自行退出**。这条路径不依赖任何信号/钩子, 比 `exit` 钩子更鲁棒。
→ 清理有**双保险**:优雅退出靠 `registerExitHandlers` 的 `killAll`;强杀靠 stdin EOF 自然死。

附带观察:强杀 sidecar 后 DeskFox(GUI 主进程)会**自动重启一个新 sidecar**(新 opencode-cli, 父=DeskFox.exe),
新 sidecar 下不挂任何 claude → 印证旧 claude 是真死透, 不是被新 sidecar 接管。

**决定:不写 Windows Job Object。** 交接文件原判"这是唯一可能需要真正动代码的点"——实测排除,
Windows 适配实际无"必须动代码"项(第①④点本就不动, 第③点仅为在 Windows 跑 `bun test` 时才改测试)。
检测命令(复现用, 只抓插件 spawn 的 claude, 自动排除交互式 Claude Code CLI 会话):
```powershell
Get-CimInstance Win32_Process | Where-Object {
  ($_.Name -eq 'claude.exe' -and $_.CommandLine -like '*stream-json*') -or $_.Name -eq 'opencode-cli.exe'
} | Select-Object ProcessId, ParentProcessId, Name, CreationDate | Format-Table -Auto
```

## 12. Windows 探测踩坑:`where claude` 选中非 .exe shim → uv_spawn ENOENT(2026-06-10,v0.1.11)

朋友机器(Win11,npm 全局安装 claude)复现:插件升级重跑 `install.ps1` 后,DeskFox 一发消息就报
`ENOENT: no such file or directory, uv_spawn 'C:\Users\<user>\AppData\Roaming\npm\claude'`。

**根因:** `where.exe claude` 的第一个结果是 npm 生成的**无扩展名 sh 脚本**(给 Git Bash/Cygwin 用的),
它被写进 `options.cliPath`。opencode 侧 spawn(libuv `uv_spawn`)只能跑 PE 可执行文件——
无扩展名 sh 脚本直接 ENOENT;`.cmd` shim 同样跑不了(需要 cmd.exe 解释,spawn 不带 shell 时报错)。
之前没炸纯属探测顺序运气好,npm 装法的用户每次重装都会踩。

**修复(v0.1.11,单卡点):** `Test-ClaudeExe` 一律拒绝非 `.exe` 路径。这同时覆盖三条来路:
`where` 结果、固定候选列表、用户手输。并从候选里删掉 `npm\claude.cmd`,
npm 装法的真实 exe 在包内:`%APPDATA%\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe`(保留为候选)。

**已被坑用户的恢复路径:** 重跑一次新版 `install.bat` 即可,探测会自动跳过 shim 选中真 exe 并重写 config。

## 13. 体验专项三连修:发送无响应 / 选择不透传 / 长任务约定(2026-08-02,v0.1.12,REQ-089/090/091)

计划与排查明细见 OPENCODE-PLAN `需求计划/2026-08-02-2.md` 及需求池三份 REQ doc。

### 13.1 REQ-089 修法A:静默短路收紧(message-builder + 两条 short-circuit)

- `message-builder.ts`:用户消息的全部 part 都透传不了(非图片附件 / 编不出的图片)时,**不再返回 `""` 走静默短路**(旧行为 = UI 上"发了没反应"),改为发一条兜底说明消息,让 Claude 给用户可见回应("该附件类型暂不支持,请改文本或截图")。真正无内容(空 text、纯轮询)仍返回 `""` 保持短路。
- 两条短路路径(`no-new-turn` / `no-new-turn-empty-msg`)log 均带 `promptShapeSnapshot`(roles 链 + 末条消息 part 类型/长度);`empty-msg` 路径升 **warn** 级(收紧后它只剩"确证无新内容",出现即值得看一眼),`ends-with-assistant` 保持 debug(step-loop 每轮正常轮询必来,warn 会刷屏)。
- **真机定位指引**(复现"发了没反应"时开 DEBUG 看 debug.log):若出现 `silent short-circuit` warn → 误伤还有残留形态,拿快照回来对;若 `reusing active process` 后长时间无 `stream message` → 僵进程(已由修法B watchdog 自动救,还能看到 `send watchdog fired`)。

### 13.2 REQ-089 修法B:发送 watchdog(doStream)

- 写 stdin 后 **15s**(`OPENCODE_CLAUDE_CODE_WATCHDOG_MS` 可调)没收到**任何** stream-json 事件 → 判僵进程:杀掉(`deleteActiveProcess` SIGTERM→2s SIGKILL 兜底,SIGSTOP 挂起的进程也能杀)→ 重 spawn(session id 因"主动杀"标记而保留 → `buildCliArgs` 自动带 `--resume`)→ 重发本条,复用 B1 的"换进程重挂监听"骨架,用户无感。重试进程 resume 失败由既有 B1 逻辑兜底(转 fresh + 摘要重建)。
- 重试后仍无事件 → **放弃**:发可见 ⚠️ 提示 + 正常收流(`providerMetadata["claude-code"].watchdogGaveUp=true`),胜过旧行为的无限沉默。
- 只守望"写入 → 首个事件"窗口:任何事件即解除,不影响长回合思考;abort/cancel/teardown 也解除(防中断后 watchdog 又拉起新进程)。
- 单测(`send-watchdog.test.ts` + `fake-claude.sh`/`.cjs` 真子进程,不花 token):自愈路径 / SIGSTOP 验收场景(池中复用进程被挂起)/ 二次放弃路径。**踩坑:fake CLI 必须 sh 入口**(~10ms 起步),node 冷启在全量套件负载下可超小窗口,直接用 node 会出现"应答进程还在启动就被当僵死"的测试竞态。`doGenerate` 未加 watchdog(DeskFox 主链路走 doStream,doGenerate 每次 fresh spawn 且用完即杀)。

### 13.3 REQ-091 快修:交互工具拦截改纯文本问答

- **真机核实(claude 2.1.219,双向 stream-json 无头,Mac)**:`system init` 的 tools 列表里**本就没有 AskUserQuestion / ExitPlanMode**;硬要求模型调用时,模型自己声明工具不存在并转纯文本提问,turn 正常结束。也**没有 control_request** 问答通道参与。→ user 遇到的"选择超时走默认"应来自旧版/异版 CLI(Win 端 CLI 版本待抽查),拦截点选在 **CLI 参数层**而非 control 通道。
- **双保险(版本无关)**,`buildCliArgs` 注入:
  1. `--disallowedTools AskUserQuestion ExitPlanMode` — 硬禁,对不存在的工具是 no-op,加了只赚不赔;
  2. `--append-system-prompt BRIDGE_SYSTEM_PROMPT`(`<deskfox-bridge>` 段)— 引导:需要选择/确认时用编号纯文本列选项并**结束回合等待**,user 答复走 `--resume` 续接;严禁替用户默认选。
- **真机验证**:部署方式二选一场景(haiku)→ 输出编号纯文本选项,9s 回合正常结束,无超时无默认选。流内旧渲染(`_Asking: ..._` / plan yes/no)保留作最后兜底。
- 二期"真透传 UI"(control_request → DeskFox 选择卡片)按计划不做,等快修跑一段再看。

### 13.4 REQ-090 第1档:长任务前台等待约定(同段 BRIDGE_SYSTEM_PROMPT 承载)

- 约定:严禁承诺"稍后汇报/后台继续"后提前结束回合(turn 结束即失联是 provider 架构必然);长任务必须当前回合内前台等待(sleep+检查循环)直到出结果。回合不结束 → DeskFox 持续"执行中",结果必达;点停止可中断(abort 真杀,v0.1.6+)。
- 注入点决策:选**插件统一注入**(vs 项目 AGENTS/CLAUDE 指令)——全局零配置双端一致;措辞条件式,短任务命中不了任何条款,干扰可忽略(真机 probe 验证普通消息行为无变化)。
- 第3档(between-turns 推送 / promptAsync / sessionID 注入)评估结论:**不做**,理由与重开条件见 OPENCODE-PLAN 需求池 REQ-090 doc 交付记录(核心:第1档把"自发后台产出"场景挖空;idle 豁免与 REQ-051 冲突;定时类正解在调度层)。
- **逃生口**:环境变量 `OPENCODE_CLAUDE_CODE_NO_BRIDGE_PROMPT=1` 整体关闭桥接注入(禁工具 + 提示),排查"提示是否干扰行为"时用。

## 14. resume 场景的「外来 result」→ 空回复静默(2026-08-15,v0.1.13)

### 14.1 现场

user 反馈"回车提交后没有任何反应,已是第二次"。DeskFox 侧证据(sidecar API + opencode 日志):

- 用户消息正常落库,`15:11:06.196` 起流 `providerID=claude-code modelID=opus`;
- `15:11:07.60`(**1.4 秒**)assistant 消息就结束:parts 只有 `step-start`/`step-finish`,
  **零 token、无文本、无 error**,opencode 随即 `exiting loop` —— 整轮静默,UI 一片空白;
- 但 CLI 那头(`~/.claude/projects/<escaped-cwd>/<uuid>.jsonl`)**收到了这条消息并干到 `15:14:46`**:
  Read → 7 次 Edit → 跑校验 → 输出完整总结。**活干完了,只是回复没回流到界面。**

### 14.2 复现(真 CLI,两轮)

```bash
# 第一轮: 造一个"结束时留有未完结后台任务"的会话
printf '%s\n' '{"type":"user","message":{"role":"user","content":"用 Bash 在后台启动 sleep 400,然后立刻回复 STARTED 结束回合"}}' \
  | claude --output-format stream-json --input-format stream-json --verbose --dangerously-skip-permissions
# 第二轮: --resume 它
printf '%s\n' '{"type":"user","message":{"role":"user","content":"只回复 OK"}}' \
  | claude --output-format stream-json --input-format stream-json --verbose --resume <SID>
```

第二轮 stdout(claude 2.1.x 实测):

```
01 system task_notification
02 system init
03 result success  num_turns=0  duration=48ms  result=''   <- 外来 result
04 system init                                             <- 第二次 init,这才开始本轮
05 assistant  TXT:OK                                       <- 真正的回答
06 result success  num_turns=1  duration=4691ms  result='OK'
```

**对照组**(resume 一个无遗留后台任务的干净会话)只有 `init → assistant → result{num_turns:1}`,
没有第 03 行 → 触发条件锁定为「**resume + 上次留有未完结后台任务**」。

### 14.3 触发链(为什么是间歇发作)

会话空闲超 `IDLE_TIMEOUT_MS`(7min)→ 进程被回收 → 下条消息必走 `--resume`;
被恢复的 CC 会话若留有未完结后台任务 → 外来 result → 空回复。
`claudeSessions` 是**进程内内存 Map**,重启 DeskFox 即清空 → 下条走 fresh 不 resume → 当场不复现,
所以看起来像"重装/重启修好了",其实只是躲开了触发条件。**重装插件对此无效**(dist 与 src 同源,
`install.sh` 在 dist 存在时不重建,只重写 opencode.jsonc 里同一段配置)。

### 14.4 修法

`doStream` / `doGenerate` 的 result 处理器加"归属校验",命中则**忽略这条 result 继续等**:

- 判据 = `num_turns === 0`(CLI 明说这个 turn 没有轮次)**且**本轮确实一点内容都没产出
  (`doStream`: `!textStarted && toolCallsById.size===0 && reasoningIds.size===0`)。
- **为什么双条件**:只看"无内容"会误伤「模型真的返回空回复」(那种 `num_turns>=1`),
  一旦误判就不是空回复而是**流永不 finish**(进程留池、rl 不 close)——转圈卡死比空白更糟。
- **安全网**:忽略后重新 `armWatchdog()`,万一之后再无任何事件,由既有 watchdog(§13.2)兜底
  重建重发 / 给可见错误,不会静默挂死。
- 位置在 `tryResumeRetry()` 之后:resume 彻底失败(从未 init)仍优先走 B1 转 fresh。

### 14.5 回归测试

`foreign-result.test.ts` + `fake-claude.cjs` 的 `FAKE_CLAUDE_MODE=foreign-result` 模式复刻上面
6 行事件序列(真子进程,不花 token)。**做过红灯验证**:临时禁用判据后该用例收到的文本正是 `""`,
与生产现场一致;恢复后 35 项全绿。第二个用例守住"普通回合(num_turns=1)照常收流"不被误伤。

### 14.6 DeskFox 主仓侧的可选加固(未做,根因不在那)

这类回合在 opencode 侧是彻底静默的:assistant 消息零 part、`finish=unknown`,`runLoop` 直接
`exiting loop`,界面上既没有内容也没有错误。值得加"本回合零输出且无 error → 给可见提示"的兜底,
否则将来任何 provider 出这类问题,表现都还是"回车了没反应"。另注:`processor` 把 `unknown` 当
"未完成"、`runLoop` 却把非 `tool-calls` 当"已完成",两处判定本身也不一致。
