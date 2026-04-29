# 工单 — 把 session.project_root 注入 providerOptions["claude-code"].cwd

> 交付给:负责 `D:\project\opencode-fork\` 的 agent
> 提交人:负责 `D:\project\deskfox-plugins\claude-code\` 的 agent
> 日期:2026-04-29
> 类型:**bug fix**(非新 feature)
> 关联:本工单是上份 `HANDOFF-deskfox-fork.md`(claude-code-loop-fix)的后续。
> Plugin 仓:`D:\project\deskfox-plugins\claude-code\`

---

## 一、背景

### 1.1 现象

DeskFox UI 切到某项目(如 `~/Downloads/`),问 Claude "你在哪个项目里",或让 Claude 跑 `git status` / 读项目文件。Claude 不知道用户选的是哪个项目,在 sidecar 启动 cwd(raw exe 跑模式下是 `packages/desktop/src-tauri/target/release`,installer 模式下是 Program Files 之类)运行工具,**结果全跑偏到错的目录**。

### 1.2 根因(两层)

**第一层 plugin**:`D:\project\deskfox-plugins\claude-code\src\claude-code-language-model.ts` `doStream` / `doGenerate` 里取 cwd:

```ts
const providerCwd = (options.providerOptions as any)?.["claude-code"]?.cwd
const cwd = providerCwd ?? this.config.cwd ?? process.cwd()
```

`process.cwd()` = sidecar 进程启动目录,不跟随用户切项目。

**第二层 opencode**:plugin 已经在等 `providerOptions["claude-code"].cwd` 这个字段,但 opencode 当前**没传**。诊断 log 证实:

```
{"providerOptionsKeys":["claude-code"],"providerOptions":{"claude-code":{}}}
```

`providerOptions["claude-code"]` 是空对象。

### 1.3 这次要改的

**只改 opencode 一处**:在 streamText 调用时把 session.project_root 注入到 `providerOptions["claude-code"].cwd`。**plugin 一行不改就自动生效**(plugin 已就位的优先级判断会自动用上)。

---

## 二、修改点

### 文件

`D:\project\opencode-fork\packages\opencode\src\session\llm.ts`

### 现状(line ~363)

```ts
return streamText({
  ...
  providerOptions: ProviderTransform.providerOptions(input.model, params.options),
  ...
})
```

### 修法

`ProviderTransform.providerOptions` 返回的 object 上,**对 `claude-code` provider 追加 `cwd` 字段**(只对 claude-code 生效,不污染其他 provider):

**方案 A(在 llm.ts 直接 patch return value,最小改动)**:

```ts
// FORK 2026-04-29 plugin claude-code 需要从 ai-sdk providerOptions 拿 session 当前项目 cwd
// (sidecar process.cwd() 不跟随用户切项目). plugin 侧已就位等这个字段, 见
// D:\project\deskfox-plugins\claude-code\src\claude-code-language-model.ts.
const providerOpts = ProviderTransform.providerOptions(input.model, params.options)
if (input.model.providerID === "claude-code") {
  const sessionCwd = ctx.directory  // 或当前 session 的 project root, 见 1.4 字段名确认
  providerOpts["claude-code"] = {
    ...(providerOpts["claude-code"] ?? {}),
    cwd: sessionCwd,
  }
}

return streamText({
  ...
  providerOptions: providerOpts,
  ...
})
```

**方案 B(改 ProviderTransform.providerOptions 内部)**:更彻底,但触面更广。**不推荐**(单 plugin 需求不必把它升级到 transform 层)。

### 1.4 字段名确认(实施前必做)

`session.project_root` 在 opencode 内部 ctx 里叫什么?候选:
- `ctx.directory`(看 `prompt.ts:1412` `path: { cwd: ctx.directory, root: ctx.worktree }`)
- `ctx.worktree`(可能更准)
- `session.project.id` / `session.cwd`

**实施前先 grep 确认当前 streamText 调用上下文里能拿到的 session 路径字段**,不要瞎用一个字段。最稳的路径:跟 `prompt.ts:1412` 的 `path.cwd` 字段保持一致(那也是 assistant message 的 cwd 字段)。

---

## 三、验收

### 3.1 功能验收

修完 build deskfox(`packages/branding/scripts/build-deskfox.ps1 -Env dev`),启动 DeskFox:

1. **新建对话** + 在 UI 左上选定一个具体项目(如 `~/Downloads/`)
2. **选 Claude Sonnet** 模型
3. **问**:`你在哪个项目里?`
4. **期望**:Claude 回答"`Downloads`" 或类似(说出 user 真实选定的目录)
5. **现状**:Claude 回答 release 目录或 sidecar 启动 cwd

### 3.2 日志验收

**先把诊断打开**:系统环境变量加 `DEBUG=opencode-claude-code`,重启 DeskFox。

跑完场景后,grep 这份日志:

```
D:\project\deskfox-plugins\claude-code\debug.log
```

应该看到 plugin 的 `doStream starting` 行里 `cwd` 字段是 user 选定的项目路径(不再是 release / Program Files 等 sidecar cwd)。

修完记得**删除**或**关闭** DEBUG 环境变量(plugin logger 默认关闭, DEBUG 开会写文件,见 `D:\project\deskfox-plugins\claude-code\src\logger.ts`)。

### 3.3 回归

- 选其他 provider(getbot 等)不受影响 — `providerOptions["claude-code"]` 只对 claude-code provider 生效,不会污染其他
- 不切项目场景仍 work

---

## 四、规范

按 `D:\project\opencode-fork\CLAUDE.md`:

- **R2 FORK marker**:加 `// FORK 2026-04-29 ...` 单点 / `// FORK-BEGIN ... // FORK-END` 多行
- **R4 黑名单 override**:`packages/opencode/src/session/llm.ts` 是否在黑名单?查 `docs/governance/blacklist.md`(或类似),如果是:commit message 加 `[override-blacklist: 注入 plugin cwd]` + 复核报告(wrapper 不可行性 / 风险 / 改动论证)→ user 审 → commit
- **R1 三级跳**:本任务必须改上游(level 3),理由:这是 ai-sdk providerOptions 协议字段,只能在 streamText 调用层注入,plugin 层 / 新文件 / wrapper 都不可行
- **三文档**:建 `D:\project\opencode-fork\docs\features\claude-code-cwd-injection\{1-spec.md, 2-plan.md, 3-changelog.md}`

---

## 五、风险与回滚

### 风险(均低)

**R-1**:字段名选错(`ctx.directory` vs `ctx.worktree` vs ...)→ 缓解:先 grep + 跟 `prompt.ts:1412` `path.cwd` 字段保持一致

**R-2**:其他 provider 误用 `providerOptions["claude-code"]` → 缓解:用 if 隔离 `if (input.model.providerID === "claude-code")`,不污染 transform 公共逻辑

**R-3**:rebase 上游 opencode 时与未来官方 cwd 注入功能冲突 → 缓解:fix 加显式 FORK marker,上游若加同名字段直接删 FORK 块

### 回滚

单 commit,`git revert` 或删 FORK 块即可。plugin 侧的 `providerCwd ?? this.config.cwd ?? process.cwd()` 优先级链已就位,即使删除注入也会 fallback 到 `process.cwd()`(回到当前不修的状态),不会引入新错误。

---

## 六、附录:plugin 侧已就位的相关代码

参考(不需改):

```ts
// D:\project\deskfox-plugins\claude-code\src\claude-code-language-model.ts:489-495
// FORK 2026-04-29 (bug#1) cwd 优先级: 当前 opencode 没传 providerOptions['claude-code'].cwd
// (诊断 log 确认 providerOptions['claude-code'] 是空对象), 但保留这个优先级 — 一旦上游 opencode
// 加了 session.project_root 注入, plugin 不用改一行就自动跟随用户切项目.
// raw exe 跑模式下 process.cwd() = release 目录会让 Claude 误判项目位置, 留待 opencode 端改.
const providerCwd = (options.providerOptions as any)?.["claude-code"]?.cwd
const cwd = providerCwd ?? this.config.cwd ?? process.cwd()
```

---

## 任务完成后回报

请将以下信息回报给 plugin 侧:
1. 字段名最终用的什么(ctx.directory? ctx.worktree?)
2. commit hash + diff 行数
3. 验收 3.1 / 3.2 / 3.3 三项的实际通过状态

收到后 plugin 侧会更新 NOTES.md 把 bug#1 标记为"已彻底解决"。

---

完。
