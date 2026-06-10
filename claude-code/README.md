# claude-code plugin for DeskFox

> 🌏 Language: **中文** | [English](./README.en.md)

让 DeskFox 通过本机已登录的 **Claude Code CLI 复用 Claude Pro/Max 订阅**,
在聊天窗口模型选择器里直接选 Claude Sonnet / Opus / Fable / Haiku。

不需要 Anthropic API key,不会被按 token 计费。

## 获取

任选其一(两个仓库内容完全一致):

```bash
# Gitee(国内速度好)
git clone https://gitee.com/zoulukuang/deskfox-plugins.git
# GitHub
git clone https://github.com/yuesoue/deskfox-plugins.git
```

也可以直接从 [Gitee](https://gitee.com/zoulukuang/deskfox-plugins) / [GitHub](https://github.com/yuesoue/deskfox-plugins) 下载 zip 解压。

> 仓库已包含编译好的 `dist/index.js`,**普通用户不需要装 bun/pnpm/npm**,clone 完直接进入安装步骤即可。

## 前提

**Claude Code CLI 已经在你机器上配好,命令行能直接跑 `claude`**。任何 Claude Code 自身安装 / 登录 / 网络问题不在本插件解决范围内 — 出问题先去查 Claude Code 官方文档。

支持的 Claude Code 安装方式(自动探测):**官方 native installer / WinGet / npm global / bun / pnpm / yarn / scoop / chocolatey / 手动解压**。只要 PATH 里能找到 `claude` 或装在常见路径下,脚本都能命中。

DeskFox 本体也得已经装好(本仓只是 plugin)。

## 安装(Windows)

1. 进入 `claude-code/` 目录
2. **双击 `install.bat`**(或 PowerShell 跑 `install.ps1`)
3. 脚本自动:
   - 探测本机 `claude.exe` 路径
   - 找不到时让你手输完整路径(循环验证到正确为止)
   - 备份现有 `%USERPROFILE%\.config\opencode\opencode.jsonc` 为 `.bak.<时间戳>`
   - 合并写入 `claude-code` provider 节(**不动你其他 provider 配置**)
4. **完全退出 DeskFox 然后重启**(任务栏右键 → 退出,确保后台 sidecar `opencode-cli.exe` 也关掉)

## 安装(macOS)

**推荐:Finder 里双击 `claude-code/install.command`**——会自动开 Terminal 跑安装,窗口跑完保留方便看输出。

命令行用户也行:

```bash
cd /path/to/deskfox-plugins/claude-code
./install.sh
```

> 第一次从仓库拉下来双击没反应?可能是 macOS 给文件加了隔离属性,在该目录跑一次:
> ```bash
> chmod +x install.command install.sh
> xattr -d com.apple.quarantine install.command 2>/dev/null; true
> ```

## 安装(Linux)

```bash
cd /path/to/deskfox-plugins/claude-code
./install.sh
```

## macOS / Linux 安装脚本做什么

- 检测 `dist/index.js`,**仓库已分发,通常直接跳过**;万一缺失,按 `bun → pnpm → npm` 顺序选一个可用的自动 `install && run build`
- 探测 `claude` 可执行文件,顺序遍历:`PATH` → `~/.local/bin/claude`(Anthropic 官方安装器默认)→ `/opt/homebrew/bin/claude`(Apple Silicon brew)→ `/usr/local/bin/claude`(Intel brew / 系统级 npm)→ `~/.bun/bin/claude` → `~/.volta/bin/claude` → `~/.npm-global/bin/claude` → yarn / pnpm global → 当前激活的 `nvm` / `fnm`
- 找不到时让你手输完整路径(支持 `~` 展开,循环到正确为止)
- 备份现有 `~/.config/opencode/opencode.jsonc` 为 `.bak.<时间戳>`
- 合并写入 `claude-code` provider 节(**不动你其他 provider 配置**)

完成后 **完全退出 DeskFox 再启动**:macOS 用 `Cmd+Q`,如果担心 sidecar 没退,`pkill -f opencode-cli` 兜底。

> 已有 config 含 `// JSONC 注释` 时 Node 内置 `JSON.parse` 解析不了,脚本会备份原文件并打印一段 `"claude-code": { ... }` snippet 让你手动合并,**不会覆盖你的配置**。

## 使用

打开 DeskFox → 模型选择器 → 选 **Claude Code (订阅)** 下四个模型之一:

- **Claude Sonnet (via Claude Code)** — 平衡(推荐日常用)
- **Claude Opus (via Claude Code)** — 强(慢、贵但订阅免费)
- **Claude Fable 5 (via Claude Code)** — 最强(Opus 之上的新档位;需订阅计划已开放,`claude` 里 `/model` 能看到 fable 即可用)
- **Claude Haiku (via Claude Code)** — 最快(简单任务用)

正常聊天 / 工具调用(读文件、跑 bash、改代码)都支持。

### 图片 / 截图输入(2026-05-13 起支持)

聊天输入框支持把截图作为附件发给 Claude:

- **Ctrl+V** 直接粘贴剪贴板里的图片
- 点输入框旁的 **📎 附件按钮** 选本机 PNG/JPG
- 从文件管理器**拖拽**图片进聊天框

三种方式都会显示缩略图,然后跟正常消息一起发出。四个模型都支持图像识别(Sonnet/Opus/Fable/Haiku 全部 vision-enabled)。

> 如果之前装过老版本 plugin,模型可能回复"当前模型不支持图片输入" — 说明你的 `opencode.jsonc` 里 `claude-code` 节没有 `modalities` 字段(老 install 写的)。**重跑一次 `install.bat` / `install.sh` 即可修复**(脚本会自动补字段并备份原配置)。

## 卸载

不提供自动 uninstall。手动两步:

1. 编辑 `~/.config/opencode/opencode.jsonc`(Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`),删除 `provider` 对象里整个 `"claude-code": { ... }` 节(保持其余 provider 完整)
2. 删本插件目录(可选,不删也无害,只是占盘)

想恢复 install 之前的配置:重命名最新一个 `opencode.jsonc.bak.<时间戳>` 回 `opencode.jsonc` 即可。

## 重新安装 / 换 Claude Code 路径

直接重跑 `install.bat`(Windows)或双击 `install.command` / 命令行 `install.sh`(macOS/Linux)。脚本重新探测 + 自动备份 + 合并写入,跟首次安装等价。

## 排错

### 启动 DeskFox 后模型选择器看不到 "Claude Code (订阅)"

1. 检查 `~/.config/opencode/opencode.jsonc`(Windows: `%USERPROFILE%\.config\opencode\opencode.jsonc`)里有没有 `"claude-code"` 节
2. 检查 `provider.claude-code.npm` 字段指向的 `file://.../dist/index.js` 文件确实存在
3. **完全退出 DeskFox 重启**——很多时候只是 sidecar 没刷新。macOS 用 `pkill -f opencode-cli`,Windows 任务栏右键退出

### 传截图后模型回复"不支持图片输入"

`opencode.jsonc` 里 `claude-code` 节的 model 配置缺 `modalities` 字段(老版 install 脚本写的配置没有这个)。opencode 运行时凭这个字段判断要不要把图片转发给 plugin,缺字段就直接拦下、塞个"模型不支持"的假错误给 Claude。

**修复**:重跑 `install.bat`(Windows)/ `install.sh`(macOS/Linux),脚本会自动补 `modalities:{input:["text","image"],output:["text"]}` + `attachment:true`。重跑会备份原 config,**不会覆盖你其他 provider 的配置**。然后**完全退出 DeskFox 重启**生效。

### 选了 Claude 模型,发消息后"思考中"卡死永远不停

需要 DeskFox 主程版本足够新(包含 step loop fix)。如果你的 build 比较旧,联系 DeskFox 维护者升级或重 build。

### 红条 `Model tried to call unavailable tool 'invalid'`

理论上 plugin 已经修了 `PowerShell` → `bash` 的映射。如果还出现,说明 Claude CLI 又调了某个我们没映射的 tool name。

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

历史上的 Bug #1。当前已通过 `_opencode.cwd` 通用 namespace 修复(配套 deskfox-fork 提交)。

如果你的 DeskFox build 不包含该 fix,**临时绕过**:在输入框里明确告诉 Claude 当前项目路径,例如 "我现在在 `~/projects/foo` 项目下,..."。

### 其他奇怪 bug

打开 DEBUG 模式抓 `debug.log`,贴给开发者。注意日志可能含敏感信息(代码片段、文件路径),贴前自行检查脱敏。

## 文件清单

| 文件 | 用途 |
|---|---|
| `install.bat` / `install.ps1` | 安装入口(Windows) |
| `install.command` | 安装入口(macOS,Finder 双击专用,内部调 `install.sh`) |
| `install.sh` | 安装入口(macOS / Linux 命令行) |
| `dist/index.js` | plugin 编译产物(DeskFox 加载这个,**已随仓库分发**) |
| `src/` | plugin 源码 |
| `package.json` / `tsup.config.ts` / `bun.lock` | 构建配置 |
| `NOTES.md` | 开发权威记录(每个 fork 改动都记在这,日后维护必读) |
| `HANDOFF-deskfox-fork.md` | DeskFox 主仓 step loop fix 工单(已完成) |
| `HANDOFF-deskfox-fork-2-cwd.md` | DeskFox 主仓 cwd 注入工单(已完成) |
| `README.md` / `README.en.md` | 用户文档(中文 / English) |

## 开发(只有需要改 plugin 源码时看)

```bash
cd path/to/deskfox-plugins/claude-code
bun install
bun run build      # 出 dist/index.js
bun run dev        # watch 模式
```

构建后**重启 DeskFox**(sidecar 在启动时 import dist,不会热加载)。

⚠️ 源码改动后记得 `bun run build` 然后**把新的 `dist/index.js` 一起 commit**,否则用户拉到的还是旧版。

详细的 fork 改动 / 协议兼容性 / 跟随上游策略,见 [`NOTES.md`](./NOTES.md)。

## 致谢

本插件 fork 自 [unixfox/opencode-claude-code-plugin](https://github.com/unixfox/opencode-claude-code-plugin)(已 archive)。fork 后的所有兼容性 / DeskFox 集成改动详见 [`NOTES.md`](./NOTES.md)。

## License

MIT(继承上游)
