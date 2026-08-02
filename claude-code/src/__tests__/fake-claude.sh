#!/bin/sh
# REQ-089 watchdog 测试用假 claude 入口。用 sh 起步(~10ms, 远快于 node 冷启),
# 保证 marker 写入/分支判定发生在 watchdog 窗口内, 消除测试竞态。
#   FAKE_CLAUDE_MODE=silent      → 永远沉默(模拟僵死/SIGSTOP 挂起进程)
#   FAKE_CLAUDE_MODE=silent-once → 首启(marker 不存在)沉默; 被 watchdog 杀掉重启后正常应答
#   其他                          → 正常应答(交给 fake-claude.cjs)
case "$FAKE_CLAUDE_MODE" in
  silent)
    while :; do sleep 0.2; done
    ;;
  silent-once)
    if [ -n "$FAKE_CLAUDE_MARKER" ] && [ ! -f "$FAKE_CLAUDE_MARKER" ]; then
      : > "$FAKE_CLAUDE_MARKER"
      while :; do sleep 0.2; done
    fi
    exec node "$(dirname "$0")/fake-claude.cjs"
    ;;
  *)
    exec node "$(dirname "$0")/fake-claude.cjs"
    ;;
esac
