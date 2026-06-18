# Skill: 豆包对话内容提取

## 概述

从豆包 (doubao.com) 对话页面提取指定范围的聊天内容。通过 Chrome DevTools Protocol (CDP) 在页面上下文中调用豆包内部 API，自动分页拉取全部消息。

## 前置条件

- macOS 系统
- Chrome 浏览器已登录豆包账号
- Python 3.8+ 已安装
- `websockets` 库已安装 (`pip3 install websockets`)

## 使用方式

当用户要求提取豆包对话内容时，按以下步骤执行：

### 1. 确认参数

向用户确认以下信息：
- **对话 ID**：从豆包 URL 中提取，如 `https://www.doubao.com/chat/28899695618562` 中的 `28899695618562`
- **起始文本**（可选）：提取范围的开始标记
- **结束文本**（可选）：提取范围的结束标记
- **输出路径**（可选）：保存文件的路径，默认保存到工作目录

### 2. 执行提取脚本

运行 `/Volumes/ExtSSD/OPENCODE-PLAN/doubao/doubao_extract.py`：

```bash
python3 /Volumes/ExtSSD/OPENCODE-PLAN/doubao/doubao_extract.py \
  --chat <对话ID> \
  --start "<起始文本>" \
  --end "<结束文本>" \
  --output <输出路径>
```

### 3. 脚本工作原理

1. 复制 Chrome profile 到临时目录（保留登录状态）
2. 关闭当前 Chrome
3. 用 `--remote-debugging-port=9222` 和临时 profile 启动 Chrome
4. 导航到豆包对话页面
5. 通过 CDP WebSocket 在页面上下文中执行 JavaScript
6. 调用豆包内部 API `/im/chain/single` 分页拉取消息
7. 按起始/结束标记过滤消息
8. 格式化输出并保存
9. 关闭调试 Chrome，恢复正常 Chrome

### 4. 关键技术细节

#### API 端点
```
POST /im/chain/single?version_code=20800&language=zh&device_platform=web&aid=497858&...
```

#### 必需 Headers
```json
{
  "Accept": "application/json, text/plain, */*",
  "Content-Type": "application/json; encoding=utf-8",
  "Agw-Js-Conv": "str"
}
```

#### 请求体格式
```json
{
  "cmd": 3100,
  "uplink_body": {
    "pull_singe_chain_uplink_body": {
      "conversation_id": "<对话ID>",
      "anchor_index": 999999,
      "conversation_type": 0,
      "direction": 1,
      "limit": 50,
      "ext": {},
      "filter": {"index_list": []},
      "evaluate_ab_params": "",
      "evaluate_common_params": ""
    }
  },
  "sequence_id": "<UUID>"
}
```

#### 分页逻辑
- 首次请求 `anchor_index=999999` 获取最新消息
- 后续请求使用上一页最旧消息的 `index_in_conv - 1` 作为 `anchor_index`
- 当 `has_more=false` 或消息为空时停止
- `conversation_type=0` 可获取全部消息类型

#### 消息结构
```json
{
  "index_in_conv": 15093,
  "user_type": 1,
  "content_block": [
    {
      "content": {
        "text_block": {
          "text": "消息文本内容"
        }
      }
    }
  ]
}
```

- `user_type=1` 表示用户
- `user_type=2` 表示豆包

### 5. 注意事项

- 脚本运行时会临时关闭 Chrome（约 15-30 秒），完成后自动恢复
- 需要用户已登录豆包账号（cookies 有效）
- 如果提取范围很大，可能需要较长时间（每页 50 条消息）
- 输出格式为 `【用户】` 和 `【豆包】` 标记的纯文本

## 故障排除

### Chrome 无法启动调试模式
- 确保没有其他 Chrome 实例在运行
- 检查端口 9222 是否被占用：`lsof -i :9222`

### 无法连接到豆包标签页
- 确认对话 ID 正确
- 检查 Chrome 是否成功启动：`curl -s http://127.0.0.1:9222/json/list`

### API 返回 401 错误
- Cookies 已过期，需要重新登录豆包
- 关闭调试 Chrome，手动登录一次，再重试

### 提取内容不完整
- 检查 `conversation_type` 参数，使用 `0` 可获取全部类型
- 增加 `--limit` 参数或检查分页是否完整

## 示例

```bash
# 提取 Agent 长期记忆讨论
python3 /Volumes/ExtSSD/OPENCODE-PLAN/doubao/doubao_extract.py \
  --chat 28899695618562 \
  --start "我想跟你聊一个 Agent 长期记忆" \
  --end "国内的飞书有没有可能协同" \
  --output /Volumes/ExtSSD/OPENCODE-PLAN/doubao_agent_memory.txt

# 提取全部对话
python3 /Volumes/ExtSSD/OPENCODE-PLAN/doubao/doubao_extract.py \
  --chat 28899695618562 \
  --output /Volumes/ExtSSD/OPENCODE-PLAN/doubao_full_chat.txt

# 输出为 JSON 格式
python3 /Volumes/ExtSSD/OPENCODE-PLAN/doubao/doubao_extract.py \
  --chat 28899695618562 \
  --json \
  --output /Volumes/ExtSSD/OPENCODE-PLAN/doubao_messages.json
```
