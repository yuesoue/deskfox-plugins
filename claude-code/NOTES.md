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

**通用教训**:判断"resume 是否失败"的可靠信号是 **`usingResume && 从未收到 system init`**,
而不是"进程怎么退出的"——因为 claude 失败有多种退出形态(静默 close / result{isError} / 非零 code)。
