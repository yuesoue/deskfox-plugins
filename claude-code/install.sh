#!/usr/bin/env bash
# DeskFox claude-code plugin installer (macOS / Linux)
# 自动探测 claude CLI + 写入 ~/.config/opencode/opencode.jsonc 的 provider['claude-code'] 节

set -euo pipefail

# ---------- 颜色 ----------
if [[ -t 1 ]]; then
  C_CYAN=$'\033[36m'; C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'
  C_RED=$'\033[31m'; C_DIM=$'\033[2m'; C_RESET=$'\033[0m'
else
  C_CYAN=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_DIM=""; C_RESET=""
fi

# ---------- 路径 ----------
PLUGIN_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST_PATH="$PLUGIN_ROOT/dist/index.js"
PKG_JSON="$PLUGIN_ROOT/package.json"
CONFIG_DIR="$HOME/.config/opencode"
CONFIG_JSONC="$CONFIG_DIR/opencode.jsonc"

# 读取 plugin 自身版本号 (失败不致命, 装完打印用)
PLUGIN_VERSION="unknown"
if [[ -f "$PKG_JSON" ]]; then
  PLUGIN_VERSION="$(grep -E '"version"' "$PKG_JSON" | head -1 | sed -E 's/.*"version"[^"]*"([^"]+)".*/\1/')" || PLUGIN_VERSION="unknown"
fi

echo
echo "${C_CYAN}DeskFox claude-code plugin 安装器 (macOS / Linux)${C_RESET}"
echo "${C_CYAN}===================================================${C_RESET}"
echo

# ---------- Step 1: 检查 plugin dist (必要时自动 build) ----------
# build 用任何一个包管理器都行 (tsup 能在 bun/pnpm/npm 下跑),按速度优先级 fallback
if [[ ! -f "$DIST_PATH" ]]; then
  echo "${C_YELLOW}[1/4] dist 不存在,尝试自动 build...${C_RESET}"
  BUILD_PM=""
  if command -v bun >/dev/null 2>&1; then
    BUILD_PM="bun"
  elif command -v pnpm >/dev/null 2>&1; then
    BUILD_PM="pnpm"
  elif command -v npm >/dev/null 2>&1; then
    BUILD_PM="npm"
  fi

  if [[ -z "$BUILD_PM" ]]; then
    echo "${C_RED}[ERROR] 找不到 plugin build 产物: $DIST_PATH${C_RESET}"
    echo "${C_YELLOW}找不到任何包管理器(bun / pnpm / npm 都没有)。${C_RESET}"
    echo "${C_YELLOW}请装其中之一,推荐 bun (https://bun.sh),然后重跑本脚本。${C_RESET}"
    exit 1
  fi

  echo "${C_DIM}      使用 $BUILD_PM 安装依赖并 build...${C_RESET}"
  case "$BUILD_PM" in
    bun)  (cd "$PLUGIN_ROOT" && bun install && bun run build) ;;
    pnpm) (cd "$PLUGIN_ROOT" && pnpm install && pnpm run build) ;;
    npm)  (cd "$PLUGIN_ROOT" && npm install && npm run build) ;;
  esac
fi
if [[ ! -f "$DIST_PATH" ]]; then
  echo "${C_RED}[ERROR] build 后仍未生成 $DIST_PATH${C_RESET}"
  exit 1
fi
echo "${C_GREEN}[1/4] plugin dist OK: $DIST_PATH${C_RESET}"

# ---------- Step 2: 探测 claude CLI ----------
test_claude() {
  local exe="$1"
  [[ -n "$exe" && -x "$exe" ]] || return 1
  "$exe" --version >/dev/null 2>&1
}

CANDIDATES=()

# PATH 中所有命中
if command -v claude >/dev/null 2>&1; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && CANDIDATES+=("$line")
  done < <(command -v -a claude 2>/dev/null || which -a claude 2>/dev/null || true)
fi

# 常见安装位置兜底
# Anthropic 官方 native installer (https://claude.ai/install.sh) — 装到 ~/.local/bin
CANDIDATES+=("$HOME/.local/bin/claude")
# Homebrew (Apple Silicon)
CANDIDATES+=("/opt/homebrew/bin/claude")
# Homebrew (Intel) / 系统级 npm global
CANDIDATES+=("/usr/local/bin/claude")
# bun global
CANDIDATES+=("$HOME/.bun/bin/claude")
# Volta
CANDIDATES+=("$HOME/.volta/bin/claude")
# 用户级 npm global (npm prefix=~/.npm-global 这类)
CANDIDATES+=("$HOME/.npm-global/bin/claude")
# yarn global
CANDIDATES+=("$HOME/.config/yarn/global/node_modules/.bin/claude")
# pnpm global
CANDIDATES+=("$HOME/.local/share/pnpm/claude")
# nvm 当前激活版本
if [[ -n "${NVM_BIN:-}" ]]; then
  CANDIDATES+=("$NVM_BIN/claude")
fi
# fnm 当前激活版本
if [[ -n "${FNM_MULTISHELL_PATH:-}" ]]; then
  CANDIDATES+=("$FNM_MULTISHELL_PATH/bin/claude")
fi

CLAUDE_PATH=""
for c in "${CANDIDATES[@]}"; do
  if test_claude "$c"; then
    CLAUDE_PATH="$c"
    break
  fi
done

if [[ -z "$CLAUDE_PATH" ]]; then
  echo "${C_YELLOW}[2/4] 未找到 claude CLI,请手动输入路径${C_RESET}"
  echo "${C_DIM}      参考:Anthropic 官方安装脚本默认装在 ~/.local/bin/claude${C_RESET}"
  while true; do
    read -r -p "请输入 claude 完整路径(直接回车退出): " user_input
    if [[ -z "$user_input" ]]; then
      echo "${C_YELLOW}已取消安装。${C_RESET}"
      exit 1
    fi
    user_input="${user_input//\"/}"
    user_input="${user_input//\'/}"
    user_input="${user_input/#\~/$HOME}"
    if test_claude "$user_input"; then
      CLAUDE_PATH="$user_input"
      break
    fi
    echo "${C_RED}  X 路径无效或 claude --version 失败,请重试${C_RESET}"
  done
fi

echo "${C_GREEN}[2/4] claude CLI: $CLAUDE_PATH${C_RESET}"

# ---------- Step 3: 写入配置 ----------
mkdir -p "$CONFIG_DIR"

# 备份现有 config
if [[ -f "$CONFIG_JSONC" ]]; then
  BAK="$CONFIG_JSONC.bak.$(date +%Y%m%d%H%M%S)"
  cp "$CONFIG_JSONC" "$BAK"
  echo "${C_DIM}      备份原 config -> $(basename "$BAK")${C_RESET}"
fi

# 选 JS runtime 来做 JSON 合并(plugin build 已要求 bun, 这里 bun 必有)
if command -v node >/dev/null 2>&1; then
  JS_RUNTIME="node"
elif command -v bun >/dev/null 2>&1; then
  JS_RUNTIME="bun"
else
  echo "${C_RED}[ERROR] 需要 node 或 bun 来写 JSON,二者皆缺${C_RESET}"
  exit 1
fi

PLUGIN_URL="file://$DIST_PATH"

# 用环境变量传值,避免 shell 转义噩梦
export DF_CONFIG_PATH="$CONFIG_JSONC"
export DF_PLUGIN_URL="$PLUGIN_URL"
export DF_CLAUDE_PATH="$CLAUDE_PATH"

"$JS_RUNTIME" -e '
const fs = require("fs");
const p = process.env.DF_CONFIG_PATH;

const provider = {
  npm: process.env.DF_PLUGIN_URL,
  name: "Claude Code (订阅)",
  models: {
    sonnet: {
      name: "Claude Sonnet (via Claude Code)",
      attachment: true, reasoning: true, tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 16384 },
    },
    opus: {
      name: "Claude Opus (via Claude Code)",
      attachment: true, reasoning: true, tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 1000000, output: 16384 },
    },
    haiku: {
      name: "Claude Haiku (via Claude Code)",
      attachment: true, reasoning: false, tool_call: true,
      modalities: { input: ["text", "image"], output: ["text"] },
      limit: { context: 200000, output: 8192 },
    },
  },
  options: { cliPath: process.env.DF_CLAUDE_PATH },
};

let cfg = null;
if (fs.existsSync(p)) {
  const raw = fs.readFileSync(p, "utf8");
  if (raw.trim()) {
    try {
      cfg = JSON.parse(raw);
    } catch (e) {
      console.error("\n[ERROR] 现有 config 解析失败 (可能含 // JSONC 注释或语法错误):");
      console.error("  " + e.message);
      console.error("\n请手动在 " + p + " 的 provider 节里加入下面这块:\n");
      console.error("  \"claude-code\": " + JSON.stringify(provider, null, 2) + "\n");
      process.exit(2);
    }
  }
}

if (!cfg || typeof cfg !== "object") {
  cfg = { "$schema": "https://opencode.ai/config.json", provider: {} };
}
if (!cfg.provider || typeof cfg.provider !== "object") {
  cfg.provider = {};
}
cfg.provider["claude-code"] = provider;

fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
'

echo "${C_GREEN}[3/4] config 已更新: $CONFIG_JSONC${C_RESET}"

# ---------- Step 4: 完成 ----------
echo
echo "${C_GREEN}[4/4] 安装完成  (claude-code plugin v$PLUGIN_VERSION)${C_RESET}"
echo
echo "${C_CYAN}下一步:${C_RESET}"
echo "  1. 完全退出 DeskFox(macOS: Cmd+Q,确保后台 sidecar opencode-cli 也关掉:"
echo "     pgrep -fl opencode-cli  →  pkill -f opencode-cli)"
echo "  2. 重启 DeskFox"
echo "  3. 模型选择器看到 'Claude Code (订阅)',选 Claude Sonnet/Opus/Haiku 任一即可"
echo
echo "${C_DIM}如以后 claude CLI 移位置或要换路径,重跑此脚本即可。${C_RESET}"
echo
