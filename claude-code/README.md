# claude-code plugin for DeskFox

让 DeskFox 通过本机已登录的 **Claude Code CLI 复用 Claude Pro/Max 订阅**,
在聊天窗口模型选择器里直接选 Claude Sonnet / Opus / Haiku。

不需要 Anthropic API key,不会被按 token 计费。

## 前提

**用户已经把 Claude Code CLI 配好,自己机器命令行能跑 `claude` 命令**。任何 Claude Code 自身安装 / 登录 / 网络问题不在本插件解决范围内 — 出问题先去查 Claude Code 官方文档。

支持的 Claude Code 安装方式:**官方 native installer / WinGet / npm global / bun / pnpm / yarn / scoop / chocolatey / 手动解压**(只要 PATH 里能找到 `claude` 或装在常见路径下,自动探测都能命中)。

DeskFox 本体也得已经装好(本仓只是 plugin)。

## 安装(Windows)

1. 双击 `install.bat`(或 PowerShell 跑 `install.ps1`)
2. 脚本自动:
   - 探测本机 `claude.exe` 路径
   - 找不到时让你手输完整路径(循环到正确为止)
   - 备份现有 `~/.config/opencode/opencode.jsonc` 为 `.bak.<时间戳>`
   - 合并写入 `claude-code` provider 节(**不动你其他 provider 配置**)
3. **完全退出 DeskFox 然后重启**(任务栏右键 → 退出,确保 sidecar `opencode-cli.exe` 也关掉)

## 安装(macOS / Linux)

**macOS 推荐:Finder 里双击 `install.command`**(会用 Terminal 打开并执行,跑完窗口保留方便看输出)。

命令行用户(或 Linux)直接跑:

```bash
cd /path/to/deskfox-plugins/claude-code
./install.sh
```

> `install.command` 只是双击友好的包装器,内部还是调 `install.sh`,逻辑完全一致。
> 如果是第一次从仓库拉下来双击没反应,可能是 macOS 给文件加了隔离属性,在该目录跑一次:
> `chmod +x install.command install.sh && xattr -d com.apple.quarantine install.command 2>/dev/null; true`

脚本自动:

- 检测 `dist/index.js`,缺失时按 `bun → pnpm → npm` 顺序选一个可用的自动 `install && run build`
- 探测 `claude` 可执行文件,顺序遍历:`PATH` → `~/.local/bin/claude`(Anthropic 官方安装器默认位置)→ `/opt/homebrew/bin/claude`(Apple Silicon brew)→ `/usr/local/bin/claude`(Intel brew / 系统级 npm)→ `~/.bun/bin/claude` → `~/.volta/bin/claude` → `~/.npm-global/bin/claude` → yarn / pnpm global → 当前激活的 `nvm`/`fnm`
- 找不到时让你手输完整路径(支持 `~` 展开,循环到正确为止)
- 备份现有 `~/.config/opencode/opencode.jsonc` 为 `.bak.<时间戳>`
- 合并写入 `claude-code` provider 节(**不动你其他 provider 配置**)

完成后 **完全退出 DeskFox 再启动**:macOS 用 `Cmd+Q`,如果担心 sidecar 没退,跑 `pkill -f opencode-cli` 兜底。

> 已有 config 含 `// JSONC 注释` 时 Node 内置 `JSON.parse` 解析不了,脚本会备份原文件并打印一段可直接粘贴的 `"claude-code": { ... }` snippet 让你手动合并,不会覆盖你的配置。

## 使用

打开 DeskFox → 模型选择器 → 选 **Claude Code (订阅)** 下三个模型之一:

- **Claude Sonnet (via Claude Code)** — 平衡(推荐日常用)
- **Claude Opus (via Claude Code)** — 最强(慢、贵但订阅免费)
- **Claude Haiku (via Claude Code)** — 最快(简单任务用)

正常聊天 / 工具调用(读文件、跑 bash、改代码)都支持。

## 卸载

不提供自动 uninstall。手动两步:

1. 编辑 `~/.config/opencode/opencode.jsonc`(Windows: `C:\Users\<you>\.config\opencode\opencode.jsonc`),删除 `provider` 对象里整个 `"claude-code": { ... }` 节(注意保持其余 provider 完整)
2. 删本插件目录(可选,不删也无害,只是占盘)

如果想恢复 install 之前的配置,直接重命名最新一个 `opencode.jsonc.bak.<时间戳>` 回 `opencode.jsonc` 即可。

## 重新安装 / 换 Claude Code 路径

直接重跑 `install.bat`(Windows)或双击 `install.command` / 命令行 `install.sh`(macOS/Linux)。脚本会重新探测 + 自动备份 + 合并写入,跟首次安装等价。

## 排错

### 启动 DeskFox 后模型选择器看不到 "Claude Code (订阅)"

1. 检查 `~/.config/opencode/opencode.jsonc`(Windows: `C:\Users\<you>\.config\opencode\opencode.jsonc`)里有没有 `"claude-code"` 节(install 应该写入了)
2. 检查 `provider.claude-code.npm` 字段指向的 `file://.../dist/index.js` 文件确实存在
3. **完全退出 DeskFox 重启**(很多时候只是 sidecar 没刷新;macOS 用 `pkill -f opencode-cli`,Windows 任务栏右键退出)

### 选了 Claude 模型,发消息后"思考中"卡死永远不停

需要先确认 DeskFox 这边 step loop fix 已经合入(commit `e2a9d7167` 或之后,在 `D:\project\opencode-fork\` 主仓 `feat/editable-file-viewer` 分支)。如果你的 DeskFox build 早于该 commit,需要重 build。

### 红条 `Model tried to call unavailable tool 'invalid'`

理论上 plugin 已经修了 `PowerShell` → `bash` 的映射。如果还出现,说明 Claude CLI 又调了一个我们没映射的 tool name。

诊断:开 DEBUG 看 plugin 调了什么。

Windows (PowerShell):

```powershell
[Environment]::SetEnvironmentVariable("DEBUG", "opencode-claude-code", "User")
# 重启 DeskFox 复现问题
```

macOS / Linux:

```bash
launchctl setenv DEBUG opencode-claude-code   # macOS GUI 启动的 DeskFox
# 或 export DEBUG=opencode-claude-code 后从同一终端启动 DeskFox
# 重启 DeskFox 复现问题
```

然后看插件目录下 `debug.log` 里的 `unmapped tool fallthrough` 行,把 name 报告给开发者。诊断完关掉:

```powershell
# Windows
[Environment]::SetEnvironmentVariable("DEBUG", $null, "User")
```

```bash
# macOS
launchctl unsetenv DEBUG
```

### Claude 答错"我在哪个项目里"

已知问题(Bug #1)。当前 plugin 拿不到 DeskFox UI 选定的项目路径,Claude 看到的是 sidecar 进程启动目录(可能是 release 目录或 Program Files)。

**临时绕过**:在 DeskFox 输入框里明确说 "我现在在 `D:\xxx\yyy` 项目下,..."。

**真修**:需要 DeskFox 主程把 session 项目路径注入到 ai-sdk providerOptions,见仓内 `HANDOFF-deskfox-fork-2-cwd.md` 工单。

### 别的奇怪 bug

打开 DEBUG 模式抓 `debug.log`,把日志贴给开发者。注意日志可能含敏感信息(代码片段、文件路径),贴前自行检查。

## 文件清单

| 文件 | 用途 |
|---|---|
| `install.bat` / `install.ps1` | 安装入口(Windows) |
| `install.command` | 安装入口(macOS,Finder 双击专用,内部调 `install.sh`) |
| `install.sh` | 安装入口(macOS / Linux 命令行) |
| `dist/index.js` | plugin 编译产物(DeskFox 加载这个) |
| `src/` | plugin 源码 |
| `package.json` / `tsup.config.ts` / `bun.lock` | 构建配置 |
| `NOTES.md` | 开发权威记录(每个 fork 改动都记在这,日后维护必读) |
| `HANDOFF-deskfox-fork.md` | 给 DeskFox 主仓 agent 的 step loop fix 工单(已完成) |
| `HANDOFF-deskfox-fork-2-cwd.md` | 给 DeskFox 主仓 agent 的 cwd 注入工单(待) |
| `README.md` | 本文(用户文档) |

## 开发(只有需要改 plugin 源码时看)

```bash
cd /path/to/deskfox-plugins/claude-code   # Windows: D:\project\deskfox-plugins\claude-code
bun install
bun run build      # 出 dist/index.js
bun run dev        # watch 模式
```

构建后重启 DeskFox(sidecar 在启动时 import dist,不会热加载)。

详细的 fork 改动 / 协议兼容性 / 跟随上游策略,见 [`NOTES.md`](./NOTES.md)。

## License

MIT(继承上游 unixfox/opencode-claude-code-plugin)
