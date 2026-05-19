# OpenCode 插件开发实战经验

> 基于语音转文字插件（Whisper 本地版 + Qwen3-ASR 云端版）的开发全过程总结。
> 踩过的坑比写的代码还多，记录下来避免重复踩。

---

## 一、插件基本结构

### 1.1 目录规范

```
项目根目录/
├── opencode.json              # 注册插件
├── .env                       # 存放 API Key 等敏感配置
└── .opencode/
    ├── package.json           # 插件依赖
    └── plugins/
        └── my-plugin.js       # 插件代码
```

### 1.2 opencode.json 注册插件

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ".opencode/plugins/my-plugin.js"
  ]
}
```

### 1.3 package.json 必须声明 ESM

```json
{
  "type": "module",
  "dependencies": {
    "@opencode-ai/plugin": "1.4.3"
  }
}
```

**踩坑：** 不加 `"type": "module"` 会导致 ES module 的 `import` 语句报错或产生警告。

### 1.4 安装依赖

```bash
cd .opencode
npm install
```

---

## 二、插件代码标准写法

### 2.1 最小示例（官方 SDK 范例）

```js
import { tool } from "@opencode-ai/plugin";

export const MyPlugin = async (ctx) => {
  return {
    tool: {
      my_tool: tool({
        description: "工具描述",
        args: {
          name: tool.schema.string().describe("参数说明"),
        },
        async execute(args, ctx) {
          return `Hello ${args.name}!`;  // 必须返回字符串
        },
      }),
    },
  };
};
```

### 2.2 关键规则

| 规则 | 说明 |
|------|------|
| **必须用 `tool()` 包装** | 从 `@opencode-ai/plugin` 导入，不能用裸对象 |
| **参数用 `tool.schema`（zod）** | 不能用 JSON Schema 的 `{ type: "object", properties: ... }` |
| **`execute` 必须返回 `string`** | 不能返回对象，否则框架 `.split()` 报错 |
| **插件导出为 `async` 函数** | 接收 `ctx` 参数（含 `directory`, `worktree`, `client` 等） |

---

## 三、踩坑记录

### 坑 1：execute 返回对象导致 `text8.split is not a function`

**现象：** 工具调用后报 `text8.split is not a function`，`text8.split` is undefined。

**原因：** SDK 类型定义明确要求 `execute` 返回 `Promise<string>`：

```typescript
// node_modules/@opencode-ai/plugin/dist/tool.d.ts
execute(args: ...): Promise<string>;
```

OpenCode 框架拿到返回值后会当字符串处理（调用 `.split()` 等方法）。如果返回了对象 `{ success: true, text: "..." }`，对象没有 `.split()` 方法，直接炸。

**错误写法：**
```js
async execute(args) {
  return { success: true, text: "转录结果", outputPath: "..." };  // 返回对象
}
```

**正确写法：**
```js
async execute(args) {
  return `转录完成\n结果已保存至: ${outputPath}\n\n${text}`;  // 返回纯字符串
}
```

**教训：** 看 SDK 的类型定义文件（`tool.d.ts`），不要凭直觉猜接口格式。

---

### 坑 2：Buffer 拼接乱码

**现象：** `child_process.spawn` 获取的中文输出变成乱码。

**原因：** `stdout.on("data")` 回调收到的是 `Buffer` 对象，用 `+=` 拼接会隐式调用 `.toString()`，在多字节字符（中文）的边界处可能截断，导致乱码。

**错误写法：**
```js
let stdout = "";
proc.stdout.on("data", (d) => (stdout += d));  // Buffer 隐式 toString，可能截断中文
```

**正确写法：**
```js
const chunks = [];
proc.stdout.on("data", (d) => chunks.push(Buffer.from(d)));
proc.on("close", () => {
  const stdout = Buffer.concat(chunks).toString("utf8");
});
```

---

### 坑 3：用 `@` 引用二进制文件导致无法启动工具

**现象：** 在 OpenCode 对话框中拖入 `.m4a` 音频文件（显示为 `@实验材料\xxx.m4a`），报错 `Cannot read binary file`。

**原因：** OpenCode 的 `@` 引用机制会尝试将文件内容读入对话上下文。音频是二进制文件，读不了，于是在「发消息」阶段就失败了，AI 根本没机会调用工具。

**解决方案 - 两种都行：**

方案 A：不拖文件，直接打字告诉路径
```
请用 qwen_asr 工具转录：D:\project\course\xxx\音频.m4a
```

方案 B：优化 description 让 LLM 学会从 `@` 引用中提取路径（后来 OpenCode 的模型自己修复了这个问题）
```js
description: "...当用户提到音频文件时，必须从用户消息中提取文件路径作为 filePath 参数。",
args: {
  filePath: tool.schema.string().describe("音频文件的完整路径，例如: 实验材料/新录音 87.m4a"),
},
```

---

### 坑 4：DashScope API 不接受 m4a 格式的 base64

**现象：** 用 base64 编码的 m4a 文件调用 Qwen3-ASR Flash API，返回 400：`The audio format is illegal and cannot be opened`。

**原因：** DashScope 的 OpenAI 兼容接口对 base64 音频格式有限制，m4a 不被直接支持。

**解决方案：** 先用 ffmpeg 转成 16kHz 单声道 WAV，再 base64 编码上传。

```js
// 转换命令
ffmpeg -y -i input.m4a -ar 16000 -ac 1 output.wav
```

---

### 坑 5：长音频处理策略

**现象：** 87 分钟的音频文件，base64 编码后几百 MB，直接调 API 不现实。

**DashScope Qwen3-ASR 的限制：**

| 模型 | 最大时长 | 最大文件 | 调用方式 |
|------|---------|---------|---------|
| `qwen3-asr-flash`（同步） | 5 分钟 | 10 MB | REST POST |
| `qwen3-asr-flash-filetrans`（异步） | 12 小时 | 2 GB | 提交 + 轮询，需公网 URL |
| `qwen3-asr-flash-realtime`（流式） | 无限制 | N/A | WebSocket |

**我们的方案：** ffmpeg 自动切片（每片 4 分钟）→ 转 WAV → 逐片调用同步 API → 拼接结果。

```js
// 切片命令
ffmpeg -y -i long_audio.m4a \
  -f segment -segment_time 240 \
  -ar 16000 -ac 1 \
  -reset_timestamps 1 \
  chunk_%04d.wav
```

**注意：** 切片文件放到同名子文件夹中（如 `音频名_asr_tmp/`），不要平铺在源文件同目录，避免污染用户目录。转录完成后清理临时文件。

---

### 坑 6：Python 输出中混入警告信息

**现象：** Whisper 插件调用 Python，`stdout` 中混入了模型加载的 warning，导致 `JSON.parse()` 失败。

**解决方案：** 从输出的最后一行开始往前找第一个有效 JSON：

```js
const lines = raw.trim().split("\n");
let result;
for (let i = lines.length - 1; i >= 0; i--) {
  try {
    result = JSON.parse(lines[i].trim());
    break;
  } catch {
    continue;
  }
}
if (!result) throw new Error("无法解析输出");
```

---

## 四、调试技巧

### 4.1 查看 OpenCode 日志

日志位置：
```
C:\Users\<用户名>\AppData\Local\ai.opencode.desktop\logs\
```

按时间排序找最新的 `.log` 文件，搜关键词：
```bash
grep -i "plugin\|tool.*error\|system error" opencode-desktop_xxxx.log
```

### 4.2 在本地用 Node.js 模拟测试

不需要每次都在 OpenCode 里测。可以用 Node.js 直接运行插件的核心逻辑：

```bash
node -e "
const { readFileSync } = require('fs');
// ... 把 callAsr / runPython 等函数复制过来测试
"
```

验证通过后再放到 OpenCode 里跑。

### 4.3 查看 SDK 类型定义

遇到框架报错时，先看 SDK 源码：
```
.opencode/node_modules/@opencode-ai/plugin/dist/tool.d.ts    # 工具定义
.opencode/node_modules/@opencode-ai/plugin/dist/index.d.ts   # 完整插件接口
.opencode/node_modules/@opencode-ai/plugin/dist/example.js   # 官方示例
```

---

## 五、插件的 Hooks 能力一览

除了 `tool`，OpenCode 插件还支持以下钩子（来自 `index.d.ts`）：

| Hook | 用途 |
|------|------|
| `tool` | 注册自定义工具 |
| `event` | 监听所有事件 |
| `config` | 修改配置 |
| `auth` | 自定义认证流程 |
| `provider` | 自定义模型 provider |
| `chat.message` | 收到新消息时触发 |
| `chat.params` | 修改发给 LLM 的参数（temperature 等） |
| `chat.headers` | 修改请求头 |
| `shell.env` | 注入 shell 环境变量 |
| `tool.execute.before` | 工具执行前拦截 |
| `tool.execute.after` | 工具执行后处理 |
| `tool.definition` | 修改工具定义 |

---

## 六、总结清单

开发 OpenCode 插件前，对照检查：

- [ ] `package.json` 有 `"type": "module"` 和 `@opencode-ai/plugin` 依赖
- [ ] 已运行 `npm install` 安装依赖
- [ ] `opencode.json` 中注册了插件路径
- [ ] 使用 `tool()` 包装工具定义，参数用 `tool.schema`
- [ ] `execute` 函数返回**纯字符串**，不是对象
- [ ] `description` 中包含足够的使用示例，帮助 LLM 正确提取参数
- [ ] 调用外部进程时用 `Buffer.concat()` 处理输出
- [ ] 敏感信息（API Key）放在 `.env` 文件中，不硬编码
- [ ] 临时文件用完即删，不污染用户目录
