#!/bin/bash
# getbot.me × OpenCode 安装启动器（macOS / Linux）
# 如果双击打不开，请在终端里执行： bash install.command

cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  cat <<EOF

[错误] 未检测到 Node.js

getbot 安装脚本需要 Node.js 运行时。请先安装：
  macOS:  brew install node
  Linux:  sudo apt install nodejs npm   （或用 nvm）

装完后重开本窗口。

EOF
  read -n 1 -s -r -p "按任意键退出..."
  echo
  exit 1
fi

node install.mjs "$@"
rc=$?

echo
echo "=============================================================="
if [ $rc -eq 0 ]; then
  echo "安装完成。请完全退出并重开 OpenCode 桌面 app。"
else
  echo "安装过程出错，错误码 $rc。请把以上日志发给技术支持。"
fi
echo "=============================================================="
echo
read -n 1 -s -r -p "按任意键退出..."
echo
exit $rc
