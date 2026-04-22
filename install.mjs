#!/usr/bin/env node
/**
 * getbot.me × OpenCode 一键安装脚本
 *
 * 默认安装到 OpenCode 全局目录：~/.config/opencode/
 *   - plugins/getbot.js + plugins/marked.mjs
 *   - command/getbot-{image,tts,asr,md2html}.md
 *   - config/getbot.json
 *   - opencode.jsonc 合并 provider.getbot + 模型 + apiKey
 *   - cache/getbot-models.json
 *
 * 用法：
 *   node install.mjs                 # 交互式（会提示粘贴 API Key）
 *   node install.mjs sk-xxxxxxxx     # 非交互，直接传 Key
 *   node install.mjs --uninstall     # 卸载
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DIR = join(homedir(), ".config", "opencode");
const DEFAULT_BASE_URL = "https://api.getbot.me/v1";

// ========== 分类规则（与 setup-getbot.mjs 保持一致）==========
const CLASSIFY_RULES = [
  { cat: "image", re: /image|flux|sd-?xl|sd-?[0-9]|dall-?e|\bmj\b|midjourney|ideogram|stable-diffusion|playground-v/i },
  { cat: "tts", re: /^(?!.*realtime).*((^|[-_\/])tts([-_]|$)|(^|[-_\/])speech([-_\/]|$)|cosyvoice|sambert)/i },
  { cat: "asr", re: /^(?!.*realtime).*(whisper|(^|[-_])asr([-_]|$)|(^|[-_])omni([-_]|$)|livetranslate)/i },
];
const BUCKET_PRIORITY = {
  image: (id) => (/z-image-turbo/i.test(id) ? 3 : 0) + (/\bpro\b/i.test(id) ? 2 : 0) + (/edit/i.test(id) ? -1 : 0),
  tts: (id) => (/(^|[-_\/])tts/i.test(id) ? 3 : 0) + (/hd/i.test(id) ? 2 : /turbo/i.test(id) ? 1 : 0),
  asr: (id) => (/(^|[-_])omni/i.test(id) ? 3 : 0) + (/whisper/i.test(id) ? 2 : 0) + (/livetranslate/i.test(id) ? -1 : 0),
};

// ========== 日志工具 ==========
function log(msg = "") { process.stdout.write(msg + "\n"); }
function warn(msg) { process.stderr.write("[警告] " + msg + "\n"); }
function err(msg) { process.stderr.write("[错误] " + msg + "\n"); }
function die(msg) { err(msg); process.exit(1); }

function banner() {
  log("");
  log("==============================================================");
  log("  getbot.me × OpenCode 一键安装");
  log("  把 getbot.me 中转的 Qwen/GPT/Claude 等模型接入 OpenCode 桌面 app");
  log("  新增：/getbot-image /getbot-tts /getbot-asr /getbot-md2html + Ctrl+Shift+V");
  log("==============================================================");
  log("");
}

// ========== 交互输入 ==========
function prompt(q) {
  return new Promise((res) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, (ans) => { rl.close(); res(ans); });
  });
}

async function askKey(existing) {
  if (existing) {
    log(`检测到已配置 API Key：${existing.slice(0, 8)}***${existing.slice(-4)}`);
    const c = (await prompt("继续使用这个 Key 吗？[Y/n]: ")).trim();
    if (c === "" || /^y/i.test(c)) return existing;
  }
  while (true) {
    const k = (await prompt("请粘贴 getbot.me API Key（通常以 sk- 开头）: ")).trim();
    if (!k) { warn("Key 不能为空，重试。"); continue; }
    if (!/^sk-/.test(k)) {
      const c = (await prompt("Key 不以 sk- 开头，确定要用吗？[y/N]: ")).trim();
      if (!/^y/i.test(c)) continue;
    }
    return k;
  }
}

// ========== JSONC 读写 ==========
function stripJsoncComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function findGlobalConfigPath() {
  const jsoncPath = join(GLOBAL_DIR, "opencode.jsonc");
  const jsonPath = join(GLOBAL_DIR, "opencode.json");
  if (existsSync(jsoncPath)) return jsoncPath;
  if (existsSync(jsonPath)) return jsonPath;
  return jsoncPath;
}

function loadGlobalConfig(path) {
  if (!existsSync(path)) return { $schema: "https://opencode.ai/config.json" };
  const raw = readFileSync(path, "utf-8");
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(stripJsoncComments(raw)); }
  catch (e) { throw new Error(`解析 ${path} 失败：${e.message}`); }
}

// ========== API ==========
async function fetchModels(apiKey) {
  const url = DEFAULT_BASE_URL.replace(/\/$/, "") + "/models";
  const resp = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`${url} 返回 HTTP ${resp.status}: ${body.slice(0, 300)}`);
  }
  return await resp.json();
}

function extractModelIds(raw) {
  if (Array.isArray(raw)) return raw.map((m) => m?.id || m?.name || m).filter(Boolean);
  if (raw && Array.isArray(raw.data)) return raw.data.map((m) => m?.id || m?.name || m).filter(Boolean);
  if (raw && Array.isArray(raw.models)) return raw.models.map((m) => m?.id || m?.name || m).filter(Boolean);
  throw new Error("无法识别 /v1/models 响应结构");
}

function classify(ids) {
  const buckets = { image: [], tts: [], asr: [], chat: [] };
  for (const id of ids) {
    let matched = false;
    for (const { cat, re } of CLASSIFY_RULES) {
      if (re.test(id)) { buckets[cat].push(id); matched = true; break; }
    }
    if (!matched) buckets.chat.push(id);
  }
  for (const cat of Object.keys(BUCKET_PRIORITY)) {
    buckets[cat].sort((a, b) => BUCKET_PRIORITY[cat](b) - BUCKET_PRIORITY[cat](a) || a.localeCompare(b));
  }
  return buckets;
}

function inferModelConfig(id) {
  const isRealtime = /realtime|streaming/i.test(id);
  const isOmni = /omni/i.test(id);
  const isVision = /vision|vl\b|visual/i.test(id);
  const isAudio = /audio|asr|tts|whisper|speech/i.test(id);
  const isReasoning = /\bo1\b|\bo3\b|\bo4\b|thinking|reasoning/i.test(id);
  const cfg = { name: id };
  cfg.tool_call = !isRealtime;
  if (isOmni || isVision || isAudio || /gpt-4o|claude/i.test(id)) cfg.attachment = true;
  if (isReasoning) cfg.reasoning = true;
  return cfg;
}

// ========== ffmpeg 检测 ==========
function checkFfmpeg() {
  const cmd = platform() === "win32" ? "where" : "which";
  const r = spawnSync(cmd, ["ffmpeg"], { encoding: "utf-8" });
  if (r.status === 0 && r.stdout.trim()) return true;
  const p = platform() === "win32" ? "C:\\ffmpeg\\bin\\ffmpeg.exe" : null;
  if (p && existsSync(p)) return true;
  return false;
}

// ========== 文件复制 ==========
function copyTree(srcDir, dstDir, patternRe) {
  mkdirSync(dstDir, { recursive: true });
  let count = 0;
  for (const name of readdirSync(srcDir)) {
    if (patternRe && !patternRe.test(name)) continue;
    const s = join(srcDir, name);
    const d = join(dstDir, name);
    const stat = statSync(s);
    if (stat.isDirectory()) {
      count += copyTree(s, d, patternRe);
    } else {
      copyFileSync(s, d);
      count++;
    }
  }
  return count;
}

function installFiles() {
  const result = { plugin: 0, commands: 0, config: 0 };
  result.plugin = copyTree(join(__dirname, "plugins"), join(GLOBAL_DIR, "plugins"));
  result.commands = copyTree(join(__dirname, "command"), join(GLOBAL_DIR, "command"), /^getbot-.*\.md$/i);
  // config 文件只有第一次安装时写入，已有则保留（保护用户手工改动）
  const srcCfg = join(__dirname, "config", "getbot.json");
  const dstCfg = join(GLOBAL_DIR, "config", "getbot.json");
  if (!existsSync(dstCfg)) {
    mkdirSync(dirname(dstCfg), { recursive: true });
    copyFileSync(srcCfg, dstCfg);
    result.config = 1;
  }
  return result;
}

// ========== 合并 opencode.jsonc ==========
function mergeProvider(cfg, apiKey, chatIds) {
  if (Array.isArray(cfg.disabled_providers)) {
    const filtered = cfg.disabled_providers.filter((p) => p !== "getbot");
    if (filtered.length === 0) delete cfg.disabled_providers;
    else cfg.disabled_providers = filtered;
  }
  cfg.provider ??= {};
  const existing = cfg.provider.getbot || {};
  const existingModels = existing.models || {};
  const mergedModels = { ...existingModels };
  let added = 0;
  for (const id of chatIds) {
    if (!mergedModels[id]) { mergedModels[id] = inferModelConfig(id); added++; }
  }
  cfg.provider.getbot = {
    name: existing.name || "getbot",
    npm: existing.npm || "@ai-sdk/openai-compatible",
    options: {
      baseURL: existing.options?.baseURL || DEFAULT_BASE_URL,
      apiKey,
    },
    models: mergedModels,
  };
  return { added, total: Object.keys(mergedModels).length };
}

// ========== 写缓存 ==========
function writeCache(buckets, raw) {
  const cacheDir = join(GLOBAL_DIR, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const defaults = {
    image: buckets.image[0] || null,
    tts: buckets.tts[0] || null,
    asr: buckets.asr[0] || null,
  };
  writeFileSync(join(cacheDir, "getbot-models.json"), JSON.stringify({
    fetched_at: Date.now(),
    baseURL: DEFAULT_BASE_URL,
    categorized: buckets,
    defaults,
  }, null, 2) + "\n", "utf-8");
  writeFileSync(join(cacheDir, "getbot-models.raw.json"), JSON.stringify(raw, null, 2) + "\n", "utf-8");
  return defaults;
}

// ========== 卸载 ==========
async function confirmUninstall() {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;

  const targets = [
    join(GLOBAL_DIR, "plugins", "getbot.js"),
    join(GLOBAL_DIR, "plugins", "marked.mjs"),
    join(GLOBAL_DIR, "command", "getbot-image.md"),
    join(GLOBAL_DIR, "command", "getbot-tts.md"),
    join(GLOBAL_DIR, "command", "getbot-asr.md"),
    join(GLOBAL_DIR, "command", "getbot-md2html.md"),
    join(GLOBAL_DIR, "cache", "getbot-models.json"),
    join(GLOBAL_DIR, "cache", "getbot-models.raw.json"),
  ];
  const existing = targets.filter((p) => existsSync(p));
  const cfgPath = findGlobalConfigPath();
  const cfg = existsSync(cfgPath) ? loadGlobalConfig(cfgPath) : null;
  const hasProvider = !!cfg?.provider?.getbot;

  log("将执行以下删除操作：");
  log("");
  if (existing.length) {
    log("  文件（" + existing.length + " 个）：");
    for (const p of existing) log("    - " + p);
  } else {
    log("  （未发现已安装的插件文件）");
  }
  if (hasProvider) {
    log("  配置：");
    log("    - " + cfgPath + " 中的 provider.getbot 整块");
  }
  log("");
  log("保留：" + join(GLOBAL_DIR, "config", "getbot.json") + "（含你手调的参数）");
  log("");

  if (!existing.length && !hasProvider) {
    log("没有需要卸载的内容，直接退出。");
    return false;
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ans = await new Promise((res) => rl.question("确认卸载？输入 y 回车继续，其它任意键取消：", (a) => { rl.close(); res(a); }));
  if (ans.trim().toLowerCase() !== "y") {
    log("已取消。");
    return false;
  }
  return true;
}

async function uninstall() {
  if (!(await confirmUninstall())) return;

  log("");
  log("→ 卸载 getbot 插件...");
  const targets = [
    join(GLOBAL_DIR, "plugins", "getbot.js"),
    join(GLOBAL_DIR, "plugins", "marked.mjs"),
    join(GLOBAL_DIR, "command", "getbot-image.md"),
    join(GLOBAL_DIR, "command", "getbot-tts.md"),
    join(GLOBAL_DIR, "command", "getbot-asr.md"),
    join(GLOBAL_DIR, "command", "getbot-md2html.md"),
    join(GLOBAL_DIR, "cache", "getbot-models.json"),
    join(GLOBAL_DIR, "cache", "getbot-models.raw.json"),
  ];
  let removed = 0;
  for (const p of targets) {
    if (existsSync(p)) { rmSync(p); removed++; log("  删 " + p); }
  }

  const cfgPath = findGlobalConfigPath();
  if (existsSync(cfgPath)) {
    const cfg = loadGlobalConfig(cfgPath);
    if (cfg.provider?.getbot) { delete cfg.provider.getbot; log("  从 opencode.jsonc 移除 provider.getbot"); }
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n", "utf-8");
  }

  log(`✅ 已删除 ${removed} 个文件。config/getbot.json 保留（含用户配置），如需彻底删除：`);
  log("    rm " + join(GLOBAL_DIR, "config", "getbot.json"));
  log("");
}

// ========== 主流程 ==========
async function main() {
  banner();

  if (process.argv.includes("--uninstall") || process.argv.includes("-u")) {
    await uninstall();
    return;
  }

  // 1. 目标目录
  mkdirSync(GLOBAL_DIR, { recursive: true });
  log("安装目标：" + GLOBAL_DIR);
  log("");

  // 2. API Key：命令行 > 已配置 > 交互输入
  const argKey = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const cfgPath = findGlobalConfigPath();
  const existingCfg = loadGlobalConfig(cfgPath);
  const existingKey = existingCfg?.provider?.getbot?.options?.apiKey;
  const apiKey = argKey || await askKey(existingKey);

  // 3. 验证 key + 拉模型
  log("");
  log("→ 验证 API Key 并拉取模型列表...");
  let raw;
  try {
    raw = await fetchModels(apiKey);
  } catch (e) {
    die(`API 调用失败：${e.message}\n\n可能原因：Key 无效 / 网络不通 / getbot.me 服务端异常`);
  }
  let ids;
  try { ids = extractModelIds(raw); } catch (e) { die(e.message); }
  const buckets = classify(ids);
  log(`✓ 共 ${ids.length} 个模型：chat×${buckets.chat.length}  image×${buckets.image.length}  tts×${buckets.tts.length}  asr×${buckets.asr.length}`);

  // 4. 复制插件、命令、config
  log("→ 复制插件到 " + GLOBAL_DIR + " ...");
  const filesResult = installFiles();
  log(`✓ plugins/getbot.js 已安装`);
  log(`✓ 命令文件 ${filesResult.commands} 个（/getbot-image /getbot-tts /getbot-asr /getbot-md2html）`);
  log(filesResult.config === 1 ? "✓ config/getbot.json 已写入默认配置" : "  config/getbot.json 已存在，保留用户配置");

  // 5. 合并 opencode.jsonc
  log("→ 更新全局 opencode.jsonc（注册 provider + " + buckets.chat.length + " 个 chat 模型）...");
  const providerResult = mergeProvider(existingCfg, apiKey, buckets.chat);
  writeFileSync(cfgPath, JSON.stringify(existingCfg, null, 2) + "\n", "utf-8");
  log(`✓ provider.getbot 已写入（模型 ${providerResult.total}，新增 ${providerResult.added}），apiKey 已保存`);

  // 6. 写缓存
  const toolDefaults = writeCache(buckets, raw);
  log("✓ 模型分类缓存已写入 " + join(GLOBAL_DIR, "cache", "getbot-models.json"));

  // 7. ffmpeg
  const hasFfmpeg = checkFfmpeg();

  // 8. 总结
  log("");
  log("==============================================================");
  log("  ✅ 安装完成");
  log("==============================================================");
  log("");
  log("已注册 4 个斜杠命令（在 OpenCode 聊天窗输入 / 查看）：");
  log(`  /getbot-image   文生图    默认模型 → ${toolDefaults.image || "（无可用模型）"}`);
  log(`  /getbot-tts     语音合成  默认模型 → ${toolDefaults.tts || "（无可用模型）"}`);
  log(`  /getbot-asr     语音识别  默认模型 → ${toolDefaults.asr || "（无可用模型）"}`);
  log(`  /getbot-md2html MD 转打印排版 HTML（需要 PDF 在浏览器里 Ctrl+P 另存，无需模型）`);
  log("快捷键：Ctrl+Shift+V → 录音 30s → 自动转文字插入输入框");
  log("");

  if (!hasFfmpeg) {
    log("⚠  未检测到 ffmpeg，语音识别 / 语音输入会受影响：");
    log("    Windows: winget install Gyan.FFmpeg");
    log("    macOS:   brew install ffmpeg");
    log("    Linux:   sudo apt install ffmpeg");
    log("");
  }

  log("📋 下一步：");
  log("  1) 完全退出 OpenCode 桌面 app（包括系统托盘图标）");
  log("  2) 重开 app");
  log("  3) 进入「管理模型」→ getbot 分组里打开你想用的模型开关");
  log("  4) 在任意项目里开一个聊天，试试 /getbot-image 一只橘猫");
  log("");
  log("如需卸载：node install.mjs --uninstall");
}

main().catch((e) => {
  err(e.stack || e.message);
  process.exit(1);
});
