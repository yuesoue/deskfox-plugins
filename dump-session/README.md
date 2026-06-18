# dump-session skill

把一条 DeskFox/opencode 会话的全过程还原成可读 transcript，用于复盘开发过程或分析某次对话。

## 文件结构

```
dump-session/
├── SKILL.md          — Claude Code skill 元数据，定义触发条件（Claude Code 框架读取）
├── dump-session.sh   — 实际执行脚本，输出 transcript 到文件或 stdout
└── README.md         — 本文件，供 Agent 阅读
```

## 触发条件

当 user 发来以下任意信号时使用本 skill：

- 甩来一个 `oc://renderer/.../session/ses_xxx` 链接，说"分析这次开发过程"
- 说"定位这条 session"、"看那次开发都干了啥"、"dump 这个会话"、"把会话内容拉出来"

## 前提条件

**对应的 DeskFox 实例必须正在运行**（sidecar HTTP API 才在监听）。若 DeskFox 未开，让 user 先打开再执行。

## 使用方式

### 第一步：执行脚本

```bash
bash ~/.claude/skills/dump-session/dump-session.sh "<oc链接或ses_id>" /tmp/session-dump.txt
```

入参支持两种格式：

| 格式 | 示例 |
|------|------|
| 完整 oc:// 链接 | `oc://renderer/Li9wcm9qZWN0/session/ses_abc123` |
| 裸会话 ID | `ses_abc123` |

### 第二步：读取输出

transcript 通常较大，用分页读或 grep 定位关键段：

```bash
# 分页读（每次 200 行）
# Read /tmp/session-dump.txt offset=0 limit=200

# 或 grep 定位关键词
grep -n "TOOL:Bash\|ERROR\|\[TEXT\]" /tmp/session-dump.txt | head -50
```

### 输出格式

每条消息以 `##### [序号] ROLE #####` 分隔，内部结构：

```
##### [3] ASSISTANT #####
[THINK] 模型的推理过程（前 600 字符）
[TEXT]
助手回复的文本内容
  TOOL:Bash  git status
  TOOL:Read  /path/to/file.ts
```

## 底层机制

脚本自动完成：

1. 从入参解析出 `ses_xxx` 会话 ID
2. 用 `lsof` 枚举本机监听中的 DeskFox sidecar 端口
3. 用 `ps eww` 从 DeskFox 进程环境变量取 basic-auth 凭证（`OPENCODE_SERVER_USERNAME` / `OPENCODE_SERVER_PASSWORD`）
4. 逐端口配对鉴权，`GET /session/<id>/message`，命中即停
5. 用内嵌 Python3 把 JSON 格式化成人类可读 transcript

同一套端口发现 + 鉴权机制可复用于其他 sidecar API（`/project`、`/session`、`/path` 等）。

## 常见报错

| 报错 | 原因 | 处理 |
|------|------|------|
| `没有在跑的 DeskFox sidecar` | DeskFox 未启动 | 让 user 打开对应版本的 DeskFox |
| `会话不在任何在跑的 sidecar 上` | 会话属于另一个 DeskFox 实例 | 确认 user 打开的是产生该链接的那个版本 |
| 输出为空 / 内容异常 | sidecar 返回了空会话 | 核查 ses_id 是否正确 |
