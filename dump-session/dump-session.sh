#!/usr/bin/env bash
# dump-session.sh — 把一条 DeskFox/opencode 会话的全过程还原成可读 transcript。
#
# DeskFox 内嵌的 opencode sidecar 自带 HTTP API,会话消息不落成可读文件,
# 但可经 sidecar 拉取。鉴权(basic auth)藏在 sidecar 进程的环境变量里
# (OPENCODE_SERVER_USERNAME / OPENCODE_SERVER_PASSWORD)。本脚本自动:
#   1) 从入参里抠出 ses_xxx 会话 id(支持直接给 oc:// 链接)
#   2) 枚举正在跑的 DeskFox sidecar 监听端口
#   3) 对每个端口取其进程环境里的鉴权,试 GET /session/<id>/message
#   4) 命中即把消息格式化成「用户指令 + 助手文本 + 工具动作概要」的 transcript
#
# 用法: dump-session.sh "<oc://...session/ses_xxx | ses_xxx>" [输出文件]
#   不给输出文件则打到 stdout。transcript 可能很大,建议给文件再分页读。
set -euo pipefail

INPUT="${1:-}"
OUT="${2:-}"
if [ -z "$INPUT" ]; then
  echo "usage: dump-session.sh \"<oc://...session/ses_xxx | ses_xxx>\" [outfile]" >&2
  exit 2
fi

SID=$(printf '%s' "$INPUT" | grep -oE 'ses_[A-Za-z0-9]+' | head -1 || true)
if [ -z "$SID" ]; then echo "未从入参解析出 ses_ 会话 id: $INPUT" >&2; exit 2; fi

PORTS=$(lsof -nP -iTCP -sTCP:LISTEN 2>/dev/null | grep -iE "deskfox|NodeServ" \
        | grep -oE '127\.0\.0\.1:[0-9]+' | cut -d: -f2 | sort -u)
if [ -z "$PORTS" ]; then echo "没有在跑的 DeskFox sidecar(应用开着吗?)" >&2; exit 3; fi

# 端口属主进程的 env 未必能读到密码(sidecar 子进程 env 不暴露),所以从所有
# DeskFox 进程里收集候选密码,再「端口 × 密码」全组合试。
OUSER=$(ps eww $(pgrep -i deskfox 2>/dev/null) 2>/dev/null | tr ' ' '\n' \
        | sed -n 's/^OPENCODE_SERVER_USERNAME=//p' | head -1)
OUSER=${OUSER:-opencode}
PASSWORDS=$(ps eww $(pgrep -i deskfox 2>/dev/null) 2>/dev/null | tr ' ' '\n' \
            | sed -n 's/^OPENCODE_SERVER_PASSWORD=//p' | grep -v '^$' | sort -u)
PASSWORDS="$PASSWORDS
"  # 末尾追加空密码,兼容未设密码的 sidecar

TMP=$(mktemp)
FOUND=""
for PORT in $PORTS; do
  for PASS in $PASSWORDS; do
    CODE=$(curl -s -m 6 -u "$OUSER:$PASS" \
           "http://127.0.0.1:$PORT/session/$SID/message" -o "$TMP" -w "%{http_code}" 2>/dev/null || echo 000)
    if [ "$CODE" = "200" ] && [ "$(wc -c < "$TMP")" -gt 10 ]; then FOUND="$PORT"; break 2; fi
  done
done

if [ -z "$FOUND" ]; then
  echo "会话 $SID 不在任何在跑的 sidecar 上(试过端口: $(echo $PORTS | tr '\n' ' '))" >&2; rm -f "$TMP"; exit 4
fi
echo "# session $SID  (sidecar 127.0.0.1:$FOUND)" >&2

python3 - "$TMP" > "${OUT:-/dev/stdout}" <<'PY'
import json, sys
msgs = json.load(open(sys.argv[1]))
def arg_of(p):
    st = p.get('state', {}) or {}
    inp = st.get('input', {}) if isinstance(st, dict) else {}
    if isinstance(inp, dict):
        for k in ('command','description','filePath','pattern','prompt','url'):
            if inp.get(k): return str(inp[k])
    return ''
for i, m in enumerate(msgs):
    info = m.get('info', m); role = info.get('role','?'); parts = m.get('parts', [])
    printed_header = False
    def header():
        global printed_header
        if not printed_header:
            print("\n##### [%d] %s #####" % (i, role.upper())); printed_header = True
    for p in parts:
        t = p.get('type')
        if t == 'text' and p.get('text','').strip():
            header(); print("[TEXT]\n%s" % p['text'])
        elif t == 'reasoning' and (p.get('text') or '').strip():
            header(); print("[THINK] %s" % (p.get('text','')[:600]))
        elif t == 'tool':
            header(); tn = p.get('tool') or p.get('name') or '?'
            print("  TOOL:%s  %s" % (tn, arg_of(p)[:200]))
PY

if [ -n "$OUT" ]; then echo "written: $OUT" >&2; fi
rm -f "$TMP"
