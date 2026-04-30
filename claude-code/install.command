#!/usr/bin/env bash
# 双击启动包装器:macOS Finder 双击 .command 会用 Terminal 执行
# 真正的安装逻辑在同目录的 install.sh
cd "$(dirname "$0")" && bash ./install.sh
status=$?
echo
if [[ $status -eq 0 ]]; then
  echo "[完成] 可以关闭此窗口。"
else
  echo "[失败] 退出码 $status,请把上面输出截图反馈。"
fi
exit $status
