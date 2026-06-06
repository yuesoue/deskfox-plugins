# HANDOFF —— Windows 端适配交接

> 收件人:负责 Windows 版本适配的开发 / Agent
> 交接人:Mac 端(已完成核心功能 + 真机验证,版本 v0.1.9)
> 日期:2026-06-06

## 0. 背景(你接手的是什么)

claude-code 是把 `claude` CLI 包成 opencode/DeskFox 的 AI-SDK provider 的插件。它按
`sessionKey`(cwd+model+scope+会话指纹)`spawn` 长驻 `claude --output-format stream-json`
子进程并复用跑多轮。本轮(v0.1.6→v0.1.9)做了一套**子进程生命周期 + 无损续接**改动:

- 中断/停止时真杀子进程(不再只 close 留进程后台跑)
- idle 7 分钟回收空闲进程(防孤儿堆积)
- 退出兜底(sidecar 退出杀掉所有子进程)
- 方案 B:`--resume <id>` 无损续接(替代有损摘要)
- B1:resume 失败时透明重试 fresh

详细设计与踩坑见 `NOTES.md` §11(尤其 §11.6 真 claude 退出/失败行为、§11.7 为何用 idle)。

**这些改动 Mac 上已 T1~T8 真机全过、23 单测全绿。运行时逻辑跨平台,Windows 上 dist 照常工作,
但有 4 处与平台相关,需要你确认 / 适配。**

---

## 1. 信号 → 在 Windows 上是强杀(行为差异,通常无需改)

文件:`src/session-manager.ts` `deleteActiveProcess()` / `disposeAll()` / `registerExitHandlers()`

Windows 没有 POSIX 信号,Node 里 `proc.kill("SIGTERM")` 会直接变成强制 `TerminateProcess`
(等价 SIGKILL)。后果:

- 进程照样被杀 ✅(目的达成)
- 「先 SIGTERM 优雅 → `SIGKILL_DELAY_MS`(2s)后 SIGKILL 兜底」**退化成一上来就强杀**,
  那个 2s 兜底定时器基本不会触发(无害)。
- claude 来不及优雅 flush → 被中断那一轮的转录可能比 Mac 多截断一点。但**已完成的轮次都在盘上
  (append 写入),`--resume` 照常**,只是被中断那半句更不完整。

**结论:一般可直接接受强杀,无需改。** 若产品上要求 Windows 也尽量优雅终止(少丢转录),
得另找 Windows 优雅终止子进程的手段——但 Windows 标准做法就是强杀,建议不折腾。

**关键保障:不要试图依赖具体退出码来判断「是不是错误退出」。** 我们靠 `ActiveProcess.killedIntentionally`
标记区分「主动杀 vs claude 自己崩」(见 §1 的 exit handler),这个标记**与平台/退出码无关**,
Windows 上即便退出码和 Mac(`code:143`)不同也照样正确。**改这块时务必保留 killedIntentionally 语义。**

---

## 2. `process.on("SIGTERM")` 在 Windows 不触发 —— 必须确认退出兜底

> **✅ 已验证(2026-06-06,真机)——结论:无孤儿,免 Job Object。** 两条路径均测,均无残留:
> ①托盘正常退出 → claude 随之消失(`exit` 钩子触发);②`Stop-Process -Force` 强杀 sidecar
> (等价 `TerminateProcess`,绕过 `exit` 钩子)→ claude **仍随之消失**。真正保命的不是 `exit`
> 钩子,而是 **stdin 管道 EOF**:claude 阻塞读 sidecar 的 stdin,sidecar 一死管道写端关闭 →
> claude 收 EOF 自退。详见 `NOTES.md` §11.8。**本点无需再适配。**

文件:`src/session-manager.ts` `registerExitHandlers()`

- `process.on("SIGTERM")` 在 Windows 上**永不触发**(Node 不支持),那段是死代码,但**无害**(注册不报错)。
- 退出清理实际靠 **`process.on("exit", killAll)`**(Windows 支持)+ `SIGINT`(Ctrl+C,Windows 支持)。

**⚠️ 待你验证(等价 Mac 的 T7):** 在 Windows 上**正常关闭 DeskFox / sidecar 退出时,
`exit` 钩子能否触发、claude 子进程是否被清掉、有无残留**。
- 验证方法:任务管理器 / `tasklist | findstr claude` 看 `claude` 进程;关掉 DeskFox(及其 sidecar)后应无残留。
- **如果 DeskFox 在 Windows 上是被强杀(而非正常退出)→ `exit` 钩子可能不触发 → 子进程会变孤儿。**
  那才需要补适配(例如:让 DeskFox 关闭时给 sidecar 一个能触发清理的机会,或 sidecar 侧用
  job object 让子进程随父进程一起死)。这是**唯一可能需要真正动代码的点**,请重点验。

---

## 3. 测试用例是 Mac-only —— 想在 Windows 跑 `bun test` 必须改

文件:`src/__tests__/lifecycle.test.ts`

里面用 `/bin/sh -c '...'` 起模拟子进程(还用了 `trap`),Windows 上没有 `/bin/sh` → **这几个用例在
Windows 上会失败**。

- **只影响在 Windows 上跑测试,不影响 dist 运行时**(测试不打包进 dist)。
- 要在 Windows 跑测试:把 `spawn("/bin/sh", ["-c", ...])` 换成跨平台写法,或 `process.platform === "win32"`
  时 `test.skip`。模拟「忽略 SIGTERM 的进程」在 Windows 上没意义(信号语义不同),那个 SIGKILL 兜底
  用例直接 skip 即可。
- `src/__tests__/session-manager.test.ts`(纯逻辑:buildCliArgs / session 上限)是跨平台的,无需改。

---

## 4. 已有的 Windows 适配 —— 别重复造

文件:`src/session-manager.ts` `resolveCliPath()` + `spawnClaudeProcess()` 的 cwd 兜底

这部分**本来就是为 Windows 写的**(来自上游 commit `1ced054` "Windows spawn 鲁棒性"):
- `opencode.jsonc` 里 Windows 路径单反斜杠 `C:\Users\...` 被 JSON 吞成 `C:Users...` → 自动从 PATH 找 claude 自愈
- cwd 不存在 → fallback `process.cwd()`(防 uv_spawn EUNKNOWN)
- spawn 失败挂 error handler 写 `claude-code-error.log`

**这块已覆盖 Windows,别动。** 如发现新 Windows 路径坑,在这里加。

---

## 5. 怎么 build / 跑

```
cd claude-code
bun install        # 或 pnpm install
bun run typecheck
bun test           # 注意第 3 点:lifecycle.test.ts 在 Windows 会挂, 先改或 skip
bun run build      # 产物 dist/index.js, opencode 直接 file:// 加载它, 无需 npm 发布
```

opencode 加载方式:`opencode.jsonc` 的 `provider["claude-code"].npm = "file://<绝对路径>/dist/index.js"`。
改完 `bun run build` → 完全重启 DeskFox(连 sidecar 一起,Windows 上确认 sidecar 进程也重启)即生效。

诊断:设环境变量 `DEBUG=opencode-claude-code` 再启动 → 写日志到
`%USERPROFILE%\.config\opencode\claude-code-plugin.log`(error 日志总写 `claude-code-error.log`)。

---

## 6. 一句话总结

**运行时逻辑跨平台,dist 在 Windows 上照常工作。** 你真正要做的:
1. ~~**重点验第 2 点**——Windows 上关闭 DeskFox 后 claude 子进程是否被清~~ —— **✅ 2026-06-06 真机已验,
   优雅退出 + 强杀 sidecar 两种路径都无孤儿(stdin EOF 双保险),不写 Job Object。详见第 2 点顶部 / NOTES §11.8。**
2. 想跑测试就改第 3 点的 `lifecycle.test.ts`(唯一还剩的可选改动,仅影响在 Windows 跑 `bun test`);
3. 第 1、4 点了解即可,一般不用动。

**净结论:Windows 适配已无"必须动代码"项;唯一可选项是想跑测试时改第 3 点。**

有疑问回看 `NOTES.md` §11(实现 + 踩坑 + 架构决策全在那)。
