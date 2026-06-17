# deskfox-plugins

DeskFox / OpenCode 插件集合。

获取:

```bash
# Gitee（国内速度好）
git clone https://gitee.com/zoulukuang/deskfox-plugins.git
# GitHub
git clone https://github.com/yuesoue/deskfox-plugins.git
```

---

## claude-code — Claude Code 订阅直连插件

> `claude-code/`

让 DeskFox（基于 OpenCode）通过本机已登录的 **Claude Code CLI 复用 Claude Pro/Max 订阅**，无需 Anthropic API Key，不按 token 计费。

安装后在 DeskFox 模型选择器里可直接选：

| 模型 | 适用场景 |
|---|---|
| Claude Sonnet (via Claude Code) | 平衡，推荐日常 |
| Claude Opus (via Claude Code) | 强推理 |
| Claude Fable 5 (via Claude Code) | 最强（需订阅计划已开放） |
| Claude Haiku (via Claude Code) | 最快，简单任务 |

支持图片/截图输入（Ctrl+V 粘贴、附件按钮、拖拽）。

**前提**：Claude Code CLI 已在本机配好，命令行能跑 `claude`。

**安装**：
- Windows：双击 `claude-code/install.bat`
- macOS：双击 `claude-code/install.command`（或 `./install.sh`）
- Linux：`./claude-code/install.sh`

详细文档见 [claude-code/README.md](./claude-code/README.md)。

---

## getbot-opencode — GetBot 多模态插件

> `getbot-opencode/`

将 [getbot.me](https://getbot.me) 中转服务接入 OpenCode，装完新增六个斜杠命令：

| 命令 | 功能 |
|---|---|
| `/getbot-image` | 文生图 |
| `/getbot-tts` | 语音合成 |
| `/getbot-asr` | 语音识别 |
| `/getbot-translate` | 中英互译（自动判断方向） |
| `/getbot-md2html` | Markdown → A4 打印排版 HTML |
| `/getbot-help` | 使用说明 |

**前提**：OpenCode 桌面 App、Node.js 18+、ffmpeg（语音功能用）、getbot.me API Key。

**安装**：
- Windows：双击 `一键安装.bat`
- macOS：双击 `install.command`

详细文档见 [getbot-opencode/使用说明.txt](./getbot-opencode/使用说明.txt)。

---

## doubao — 豆包对话提取工具

> `doubao/`

通过 Chrome DevTools Protocol (CDP) 从豆包 (doubao.com) 对话页面批量提取消息，保存为纯文本或 JSON。

**前提**：macOS、Chrome 已登录豆包、Python 3.8+、`pip3 install websockets`。

```bash
# 提取指定对话（结果自动保存到 doubao/output/{chat_id}.txt）
python3 doubao/doubao_extract.py --chat 28899695618562

# 指定范围
python3 doubao/doubao_extract.py --chat 28899695618562 \
  --start "起始文本" --end "结束文本"

# 输出 JSON
python3 doubao/doubao_extract.py --chat 28899695618562 --json
```

---

## License

MIT
