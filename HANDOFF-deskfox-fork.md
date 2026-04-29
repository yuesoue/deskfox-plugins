# 工单 — DeskFox Step Loop 无限 polling 修复

> 交付给:负责 `D:\project\opencode-fork\` 的 agent
> 提交人:负责 `D:\project\deskfox-plugins\claude-code\` 的 agent
> 日期:2026-04-29
> 类型:**bug fix**(非新 feature)

---

## 一、背景

### 1.1 正在做的事

我们在 `D:\project\deskfox-plugins\claude-code\` 落地了一个独立 plugin(基于已 archive 的 `unixfox/opencode-claude-code-plugin`,2026-04-26 最后 commit),目的是让用户的 Claude Pro/Max 订阅能在 DeskFox 里使用。

机制:plugin spawn 本机已登录的 `claude` CLI 子进程 → 通过 stream-json 双向流转协议 → 把响应作为 `LanguageModelV2` provider 流回 DeskFox。

### 1.2 现象

用户在 DeskFox 里选择 `claude-code` provider 下任一模型(sonnet/opus/haiku),发任意消息(例:"你好"),Claude 正常回复一次,然后底部"思考中"**永久卡死**,UI 不结束 turn。

### 1.3 已确认根因 — 是 opencode-fork 上游 bug,不是 plugin 问题

引用上游 issue:

- **[anomalyco/opencode#17982](https://github.com/anomalyco/opencode/issues/17982)** — "OpenCode prompt loop continues after `finish=stop`,triggering prefill error on claude-opus-4-6"
  > "The prompt loop in `session.prompt` does not gate continuation on the finish reason. After step 0 completes with finish=stop, the loop enters step 1, re-resolves all tools, and fires a new LLM stream call."
  - 状态:**OPEN**(未合并)
  - PR #22404 提了一个修复但走的是另一条路(剥离尾部 assistant message),未合并

- **[anomalyco/opencode#15533](https://github.com/anomalyco/opencode/issues/15533)** — auto-compaction 同类无限循环,同样 OPEN

**关键点**:此 bug 在**官方 `@ai-sdk/anthropic` provider 上也复现**,与本 plugin 无关。

### 1.4 plugin 侧已做的事(不需要再改 plugin)

`D:\project\deskfox-plugins\claude-code\` 这边按 LanguageModelV2 协议已经 emit 完整序列:`stream-start` → `response-metadata` → `text-start` → `text-delta` → `text-end` → `finish (reason: "stop")` → `controller.close()`。所有 tool-call 都标 `providerExecuted: true`。

经诊断证实:**plugin 怎么改 emit 内容都不能修复**,因为 opencode 的 step loop 不是基于 finishReason 决定 break。

证据:`D:\project\deskfox-plugins\claude-code\debug.log` 显示一次"你好"对话:第一次 doStream 正常完成(spawn → stream-json 解析 → result success → finish stop → close),约 1 秒后 opencode **每 1.5 秒重新调一次 doStream**,每次 prompt 末尾都是 assistant role(没新 user 输入),plugin 走 short-circuit 返回空 stream,opencode 不停。无限循环。

### 1.5 涉及的核心文件(只读分析,**未改**)

`D:\project\opencode-fork\packages\opencode\src\session\prompt.ts:1335-1355` —— step loop 的 break 判定块:

```ts
const lastAssistantMsg = msgs.findLast(
  (msg) => msg.info.role === "assistant" && msg.info.id === lastAssistant?.id,
)
// Some providers return "stop" even when the assistant message contains tool calls.
// Keep the loop running so tool results can be sent back to the model.
// Skip provider-executed tool parts — those were fully handled within the
// provider's stream (e.g. DWS Agent Platform) and don't need a re-loop.
const hasToolCalls =
  lastAssistantMsg?.parts.some((part) => part.type === "tool" && !part.metadata?.providerExecuted) ?? false

if (
  lastAssistant?.finish &&
  !["tool-calls"].includes(lastAssistant.finish) &&
  !hasToolCalls &&
  lastUser.id < lastAssistant.id
) {
  yield* slog.info("exiting loop")
  break
}

step++
```

字面看 break 条件**应该**对 finish=stop 触发 break。**但实测不 break,说明四个条件里有一项实际不满足**。需要诊断到底哪一项挂了。

---

## 二、任务

### 阶段 A — 诊断(必做,先做)

**目标**:定位 break 条件四项 (`lastAssistant?.finish` / `!["tool-calls"].includes(...)` / `!hasToolCalls` / `lastUser.id < lastAssistant.id`) 中**哪一项实际为 false**,导致 break 不触发。

**手段**:在 `prompt.ts:1345` 之前插入临时 debug 日志(slog 已经在 scope 里):

```ts
yield* slog.info("loop break check", {
  step,
  hasFinish: Boolean(lastAssistant?.finish),
  finish: lastAssistant?.finish,
  isNotToolCalls: lastAssistant?.finish ? !["tool-calls"].includes(lastAssistant.finish) : null,
  hasToolCalls,
  lastUserID: lastUser.id,
  lastAssistantID: lastAssistant?.id,
  idOrderOk: lastAssistant ? lastUser.id < lastAssistant.id : null,
})
```

加 `// FORK: temp diagnostic 2026-04-29 (R2)` marker。

**测试方法**:
1. 重 build deskfox(走 `packages/branding/scripts/build-deskfox.ps1 -Env dev` wrapper,产物 `DeskFox.exe` —— 见用户内存 `feedback_opencode_fork_verification.md`)。build 前 user 会自动 kill 现存 DeskFox 进程,无需问。
2. 启动新 DeskFox,确保 `claude-code` provider 已配(已写入 `~/.config/opencode/opencode.jsonc`,prefix `provider.claude-code.npm = file:///D:/project/deskfox-plugins/claude-code/dist/index.js`)。
3. 新对话,选 `Claude Sonnet (via Claude Code)`,发"你好"。
4. 等 5-10 秒"思考中"卡死出现。
5. 看 sidecar 日志(opencode-cli 的 slog 输出,DeskFox release build 的位置可能在 `~/.local/share/opencode/log/`,如果不在那就 grep `loop break check` 字串穿过所有日志路径)。

**输出**:在 `2-plan.md` 记下 4 项的真实值,确定凶手是哪一项。

### 阶段 B — 修复

**根据阶段 A 的发现,选择修复路径**:

**case 1**: `lastAssistant?.finish` 是 undefined → ai-sdk 没把 plugin 的 finish part 转成 finish-step 事件传给 opencode。可能性:
- ai-sdk v3 协议要求 plugin 多 emit 某个 part(我已加 response-metadata,但仍可能不够)
- ai-sdk 工具调用流被截 → 看 plugin debug.log 第一次 doStream 的实际 emit 序列
- 修法:在 `prompt.ts:1345` 之前加防御:**finish 是 undefined 时也认为可以 break**(只要 `!hasToolCalls && lastUser.id < lastAssistant.id`)

**case 2**: `hasToolCalls` 是 true(尽管 plugin 全部 tool 标了 `providerExecuted: true`)→ ai-sdk 转换 stream tool-call 到 part metadata 时,没把 `providerExecuted` flag 写到 `part.metadata.providerExecuted`。可能性:
- ai-sdk 写到了别的字段(比如 `part.providerExecuted` 顶级,而不是 `part.metadata.providerExecuted`)
- 修法:`prompt.ts:1342-1343` 的 hasToolCalls 检查同时看顶级和 metadata 两个位置:`!part.metadata?.providerExecuted && !(part as any).providerExecuted`

**case 3**: `lastUser.id < lastAssistant.id` 不成立 → ID 排序问题
- 可能 plugin 没 emit response-metadata 或 emit 错了 timestamp 导致 message ID 顺序乱(plugin 已加 response-metadata,可能要 verify)
- 修法:阶段 A 报告里看 ID 实际值再决定

**case 4**: 全部条件都满足但还是不 break → control flow 有别的早期分支吃掉了 break。需要再贴更多日志。

**回退方案(如阶段 A 太复杂)**:**强制在 finish 为任何 stop-class 值时 break**,跳过 hasToolCalls / id 检查。即在 `prompt.ts:1345-1353` 之前加:

```ts
// FORK: 2026-04-29 workaround for upstream issue #17982 — opencode step loop
// fails to gate on finishReason="stop" when using claude-code plugin (and also
// official @ai-sdk/anthropic per upstream report). Force break when assistant
// finished with non-tool-calls reason, regardless of message-part metadata
// quirks.
// 上游修后此块删除即可恢复主线行为. tracking: anomalyco/opencode#17982
if (
  lastAssistant?.finish &&
  !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
  lastUser.id < lastAssistant.id
) {
  yield* slog.info("exiting loop (FORK upstream-17982 workaround)")
  break
}
```

注意只多加一个**前置 guard**,**不**改原有 break 块(原块保留作 fallback),减少 rebase 冲突面。

### 阶段 C — 收尾

阶段 B fix 验证通过后:
- 移除阶段 A 的临时 diagnostic 日志(`temp diagnostic` 那段)
- 保留 fix 块的 `// FORK:` marker 和 issue 引用注释
- 更新 `3-changelog.md`

---

## 三、规范遵守

按 `D:\project\opencode-fork\CLAUDE.md`:

### R2(强制)
所有改动加 `// FORK: <reason> <YYYY-MM-DD>` 单点 marker,或 `// FORK-BEGIN: ...` / `// FORK-END` 多行。本工单已经在每段示例代码里给了。

### R4(可能触发)
确认 `packages/opencode/src/session/prompt.ts` 是否在 `docs/governance/blacklist.md`(或类似)的黑名单中。如果是:
- commit message 加 `[override-blacklist: 修上游 issue#17982 step loop 不停]`
- 写复核报告(wrapper 不可行性 / 风险评估 / 改动日志论证 三项)→ 等 user 点头再 commit

如果不在黑名单,直接 R2 marker 即可,不走 R4。

### R1 三级跳
本任务**必须**深度改上游(level 3),理由:bug 在 opencode core 的 step loop 里,plugin 层和"新文件 + 接口注入"路径都已验证走不通(plugin 5 轮迭代,见 `D:\project\deskfox-plugins\claude-code\NOTES.md` 和 git log 里 4 个 fix commit)。

### 三文档结构
建 `D:\project\opencode-fork\docs\features\claude-code-loop-fix\`:
- `1-spec.md`:本工单内容(摘录)
- `2-plan.md`:阶段 A 诊断结果 + 阶段 B 选定路径 + 决策轨迹
- `3-changelog.md`:commit hash 列表 + 行数 + 影响范围 + 回归测试 + 回退方法

---

## 四、验收标准

修复合格的判据(全通过才算 done):

1. **基础对话不卡** — DeskFox 新对话发"你好",10 秒内完整收到回复,底部"思考中"消失,▢ 停止按钮恢复成 ↑ 发送按钮
2. **多轮对话不卡** — 上一条之后再发"你的强项是什么",再次收到完整回复后 turn 正常结束
3. **工具调用不卡** — 让 Claude 读 `D:\project\deskfox-plugins\claude-code\package.json` 文件,Claude 调 Read 工具返回版本号 `0.1.2`,turn 结束
4. **Bash 工具不卡** — 让 Claude 跑 `git status`,正确返回输出,turn 结束
5. **回归** — 现有 `getbot` provider 模型(如 `MiniMax-M2.7`、`qwen3-coder-480b`)依然能用,不被波及
6. **debug.log 干净** — 完成一次完整 turn 后,`D:\project\deskfox-plugins\claude-code\debug.log` 不再出现连续的 `doStream short-circuit` 行(以前会无限刷)

### 验收命令

```powershell
# 1. 清旧日志和进程
Stop-Process -Name DeskFox,opencode-cli,claude -Force -ErrorAction SilentlyContinue
Remove-Item -Force -ErrorAction SilentlyContinue D:\project\deskfox-plugins\claude-code\debug.log

# 2. 重 build deskfox
& D:\project\opencode-fork\packages\branding\scripts\build-deskfox.ps1 -Env dev

# 3. user 启动 DeskFox 跑上面 4 个测试场景

# 4. 验完 debug.log
Get-Content D:\project\deskfox-plugins\claude-code\debug.log | Select-String "short-circuit" | Measure-Object -Line
# 期望: 0 行,或 1-2 行(可接受的瞬态),不应该是几十上百行的循环
```

---

## 五、上游 PR 关系 + 风险 + 回滚

### 关系
- 上游 issue [#17982](https://github.com/anomalyco/opencode/issues/17982) OPEN
- 上游 PR [#22404](https://github.com/anomalyco/opencode/pull/22404) 提了不同方向的修复(剥离尾部 assistant message in `ProviderTransform.message()`,只在 `options.thinking` 启用时生效),OPEN 未合并

### 风险

**R-1**(中)— 强制 break 可能误伤需要多步执行的 agent 场景。
缓解:break 条件保留 `!["tool-calls", "unknown"].includes(...)`,只对明确 stop 类的 finish reason 生效。tool-calls 场景照样能继续 step。

**R-2**(低)— 上游一旦合 PR #22404 我们 rebase 时会冲突。
缓解:fix 块加显式 `tracking: anomalyco/opencode#17982` 注释,rebase 时直接删除整段 FORK 块即可。修法 wrapper 风格,不破坏原有 break 块(原块作 fallback)。

**R-3**(低)— ai-sdk 协议升级引入新 finishReason 值。
缓解:用白名单 `["tool-calls", "unknown"]` 而不是 `=== "stop"`,新 reason 默认 break(更安全)。

### 回滚
单 commit,git revert 即可。或者删除一段 `// FORK-BEGIN` ... `// FORK-END` 块。

---

## 六、附录:plugin 侧的相关产物(供阶段 A 参考)

- `D:\project\deskfox-plugins\claude-code\NOTES.md` — plugin 协议兼容性 + 已知风险
- `D:\project\deskfox-plugins\claude-code\debug.log` — 上一次卡死的真实事件流(已留作样本)
- `D:\project\deskfox-plugins\claude-code\src\claude-code-language-model.ts` — plugin 主逻辑,完整 stream emit 序列在 `doStream` 函数 line 565-1145
- `D:\project\deskfox-plugins\claude-code\dist\index.js` — 当前生效的 plugin build(43.8 KB,2026-04-29 08:52 mtime)
- `~/.config/opencode/opencode.jsonc` — 全局配置,`provider.claude-code` 节已就位

plugin 侧 5 轮 fix commit(都已经做对,不需要再改):
1. `cache_control` 400 修复 — 过滤空 text block + 用 "continue" 替代 "" 占位
2. fallback throw → 切回防御性
3. caller short-circuit — prompt 末尾 assistant 时返回空 stream
4. finishReason 永远 "stop"(去掉 toolCallMap.size > 0 ? "tool-calls" : "stop")
5. emit `response-metadata` part(LanguageModelV2 协议要求)

---

## 任务完成后回报

请将以下信息回报给 plugin 侧 agent:
1. 阶段 A 诊断结果(4 个条件的真实值)
2. 选用的修复路径(case 1/2/3/4 / 回退方案)
3. commit hash + diff 行数
4. 验收 6 项的实际通过/失败状态

收到后 plugin 侧会更新 `D:\project\deskfox-plugins\claude-code\NOTES.md`,把"已确认根因 + 修复 commit hash"作为永久记录。

---

完。
