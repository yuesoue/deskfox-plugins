---
name: dump-session
description: 把一条 DeskFox/opencode 会话(oc:// 链接或 ses_xxx id)的全过程还原成可读 transcript,用于复盘开发/分析"开发全过程"。当 user 甩来一个 oc://renderer/.../session/ses_xxx 链接、或说「定位这条 session / 看那次开发全过程 / dump 这个会话 / 把会话内容拉出来」时使用。
---

# dump-session — 会话链接 → 全过程 transcript

DeskFox 渲染层的 `oc://renderer/<base64(workspace)>/session/<ses_id>` 链接**不能直接 fetch**;
会话消息也不以可读文件落盘。但 DeskFox 内嵌的 opencode **sidecar 有 HTTP API**,可拉取整条会话。

## 何时用

- user 发来 `oc://...session/ses_xxx` 链接,要你"结合开发全过程分析";
- user 说「定位这条 session」「看那次开发都干了啥」「dump 会话」。

## 怎么做

前提:**对应的 DeskFox 应用正开着**(sidecar 才在跑)。然后一条命令:

```bash
bash ~/.claude/skills/dump-session/dump-session.sh "<oc链接或ses_id>" /tmp/session-dump.txt
```

脚本会自动:枚举在跑的 DeskFox sidecar 端口 → 从各 sidecar **进程环境变量**取 basic-auth
(`OPENCODE_SERVER_USERNAME`/`OPENCODE_SERVER_PASSWORD`)→ 命中的端口上
`GET /session/<id>/message` → 格式化成 `[TEXT]/[THINK]/TOOL:` 的 transcript。

然后 **Read `/tmp/session-dump.txt`**(transcript 常很大,用 offset/limit 分页读,或 Grep 定位关键段)。

## 排错

- `没有在跑的 DeskFox sidecar` → 让 user 把对应应用(正式版/预览版/本地版)打开再试。
- `会话不在任何 sidecar 上` → 该会话属于另一个 DeskFox 实例;确认开的是产生该链接的那个版本。
- 多个 DeskFox 实例同时跑很正常,脚本会逐个端口配对鉴权试,命中即停。

## 底层机制(可复用)

同一套「sidecar 端口 + 进程环境取鉴权」能查别的 API:`GET /project`(项目列表)、
`GET /session`(会话列表)、`GET /path?directory=<dir>` 等。详见 reference 记忆
`reference_deskfox_sidecar_api`。
