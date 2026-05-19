#!/usr/bin/env node
/**
 * getbot.me × OpenCode 一键安装脚本
 *
 * 默认安装到 OpenCode 全局目录：~/.config/opencode/
 *   - plugins/getbot/{getbot.js, marked.mjs, package.json}   ← 子目录形态（opencode 加载要求）
 *   - command/getbot-{image,tts,asr,translate,md2html,help}.md   ← 6 个面向用户的 slash 命令
 *   - config/getbot.json   ← 含 debug 开关，默认关闭，对 AI 说"开 getbot 调试"打开
 *   - （注：getbot-doctor / getbot-logs / getbot-debug 工具仅 LLM 可调，无 slash 入口）
 *   - config/getbot-secret.json（apiKey + baseURL，独立保存，不写主配置）
 *   - cache/getbot-models.json
 *
 * 同时会**自动 patch** ~/.config/opencode/opencode.jsonc：
 *   - 在 "plugin" 数组里追加 "file:///.../plugins/getbot"（已存在则跳过，幂等）
 *   - patch 前自动备份原文件到 opencode.jsonc.bak.<时间戳>
 *
 * 老版本（v1）会把 getbot.js / marked.mjs 直接放在 plugins/ 根下 —— opencode 不会
 * 自动加载这种"孤儿文件"。本脚本在检测到老布局时，自动把孤儿文件移到
 * plugins/.getbot-legacy-backup-<时间戳>/ 以保留可恢复历史。
 *
 * 用法：
 *   node install.mjs                 # 交互式（会提示粘贴 API Key）
 *   node install.mjs sk-xxxxxxxx     # 非交互，直接传 Key
 *   node install.mjs --uninstall     # 卸载
 *   node install.mjs --dry-run       # 只展示会做什么，不实际改任何文件
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve, dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { homedir, platform } from "node:os";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const GLOBAL_DIR = join(homedir(), ".config", "opencode");
const DEFAULT_BASE_URL = "https://api.getbot.me/v1";

// 子目录形态的插件包路径（opencode 通过 file:// URL + package.json#exports."./server" 加载）
const PLUGIN_PKG_DIR = join(GLOBAL_DIR, "plugins", "getbot");
const OPENCODE_CONFIG_CANDIDATES = ["opencode.jsonc", "opencode.json"];

// 把 Windows 路径转为 opencode 能识别的 file:/// URL
function pluginFileUrl() {
  const norm = PLUGIN_PKG_DIR.replace(/\\/g, "/");
  return /^[a-zA-Z]:/.test(norm) ? "file:///" + norm : "file://" + norm;
}

const PLUGIN_PACKAGE_JSON = {
  name: "@getbot/opencode-plugin",
  version: "0.0.0-local",
  private: true,
  type: "module",
  description: "getbot.me × OpenCode 多模态插件（image/tts/asr/translate/md2html + debug/logs/doctor）",
  main: "./getbot.js",
  exports: {
    "./server": "./getbot.js",
    "./tui": "./getbot.js",
  },
};

const DRY_RUN = process.argv.includes("--dry-run");

// ========== 分类规则（与 setup-getbot.mjs 保持一致）==========
// translate 必须排在 asr 前面：qwen3-livetranslate-* 含 "translate" 也含 "live"，
// 但它本质是流式 ASR+翻译；这里专门匹配 qwen-mt-* 这类纯文本翻译模型
const CLASSIFY_RULES = [
  { cat: "image", re: /image|flux|sd-?xl|sd-?[0-9]|dall-?e|\bmj\b|midjourney|ideogram|stable-diffusion|playground-v/i },
  { cat: "tts", re: /^(?!.*realtime).*((^|[-_\/])tts([-_]|$)|(^|[-_\/])speech([-_\/]|$)|cosyvoice|sambert)/i },
  { cat: "translate", re: /(^|[-_])mt([-_]|$)/i },
  { cat: "asr", re: /^(?!.*realtime).*(whisper|(^|[-_])asr([-_]|$)|(^|[-_])omni([-_]|$)|livetranslate)/i },
];
const BUCKET_PRIORITY = {
  image: (id) => (/z-image-turbo/i.test(id) ? 3 : 0) + (/\bpro\b/i.test(id) ? 2 : 0) + (/edit/i.test(id) ? -1 : 0),
  tts: (id) => (/(^|[-_\/])tts/i.test(id) ? 3 : 0) + (/hd/i.test(id) ? 2 : /turbo/i.test(id) ? 1 : 0),
  asr: (id) => (/(^|[-_])omni/i.test(id) ? 3 : 0) + (/whisper/i.test(id) ? 2 : 0) + (/livetranslate/i.test(id) ? -1 : 0),
  translate: (id) => (/turbo/i.test(id) ? 2 : 0) + (/\bplus\b/i.test(id) ? 1 : 0),
};

// ========== JSONC patcher（在 opencode.jsonc 的 plugin 数组里加/删一行 URL，保留注释/格式）==========
// 不用第三方包；只做字符串扫描。覆盖以下格式：
//   "plugin": []                          → 空数组
//   "plugin": ["url"]                     → 单行
//   "plugin": [ "url1", "url2" ]          → 单行多项
//   "plugin": [\n    "url1"\n  ]          → 多行
//   "plugin": [\n    "url1",\n    "url2"\n  ]   → 多行多项（带/不带尾随逗号都行）
//   完全没 "plugin" 键的根对象           → 自动添加

function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// 在 text 里找到 "plugin" 数组的 [ 和匹配的 ]，返回 {arrayStart, arrayClose} 或 null
function locatePluginArray(text) {
  const m = text.match(/"plugin"\s*:\s*\[/);
  if (!m) return null;
  const arrayStart = m.index + m[0].length;
  let depth = 1, i = arrayStart, inString = false, escape = false;
  while (i < text.length && depth > 0) {
    const c = text[i];
    if (escape) { escape = false; i++; continue; }
    if (c === "\\") { escape = true; i++; continue; }
    if (c === '"') inString = !inString;
    else if (!inString) {
      if (c === "[") depth++;
      else if (c === "]") depth--;
    }
    if (depth === 0) break;
    i++;
  }
  if (depth !== 0) return null;
  return { arrayStart, arrayClose: i };
}

function patchAddPlugin(text, url) {
  const loc = locatePluginArray(text);
  if (!loc) return insertPluginKey(text, url);
  const { arrayStart, arrayClose } = loc;
  const arrayContent = text.slice(arrayStart, arrayClose);

  if (arrayContent.includes(`"${url}"`)) {
    return { changed: false, text, action: "plugin 数组已包含本插件 URL，跳过" };
  }

  const isMultiline = /\n/.test(arrayContent);
  // 注意 j 边界：允许 j 跌到 arrayStart-1（即 `[`），用于识别"全空白数组"
  let j = arrayClose - 1;
  while (j >= arrayStart && /\s/.test(text[j])) j--;
  const lastChar = j < arrayStart ? "" : text[j];
  const isEmpty = lastChar === "" || lastChar === "[";

  // 推算缩进
  const closeLineStart = text.lastIndexOf("\n", arrayClose) + 1;
  const closeLine = text.slice(closeLineStart, arrayClose);
  const closeIndent = (closeLine.match(/^\s*/) || [""])[0];
  const itemIndent = closeIndent + "  ";

  if (isEmpty) {
    const insertion = isMultiline
      ? `\n${itemIndent}"${url}"\n${closeIndent}`
      : `"${url}"`;
    return {
      changed: true,
      text: text.slice(0, arrayStart) + insertion + text.slice(arrayClose),
      action: "在空 plugin 数组中插入",
    };
  }

  const tail = text.slice(j + 1, arrayClose);
  if (isMultiline) {
    const insertion = lastChar === ","
      ? `\n${itemIndent}"${url}"`
      : `,\n${itemIndent}"${url}"`;
    return {
      changed: true,
      text: text.slice(0, j + 1) + insertion + tail + text.slice(arrayClose),
      action: "在多行 plugin 数组末尾追加",
    };
  }
  const insertion = lastChar === "," ? ` "${url}"` : `, "${url}"`;
  return {
    changed: true,
    text: text.slice(0, j + 1) + insertion + tail + text.slice(arrayClose),
    action: "在单行 plugin 数组末尾追加",
  };
}

function insertPluginKey(text, url) {
  // 根对象 } 的位置
  let i = text.length - 1;
  while (i >= 0 && /\s/.test(text[i])) i--;
  if (i < 0 || text[i] !== "}") {
    return { changed: false, text, action: "找不到根对象 }，无法添加 plugin 键" };
  }
  const closeLineStart = text.lastIndexOf("\n", i) + 1;
  const closeLine = text.slice(closeLineStart, i);
  const closeIndent = (closeLine.match(/^\s*/) || [""])[0];
  const fieldIndent = closeIndent + "  ";

  let j = i - 1;
  while (j >= 0 && /\s/.test(text[j])) j--;
  const needsComma = j >= 0 && text[j] !== "{" && text[j] !== ",";

  const insertion = (needsComma ? "," : "") +
    `\n${fieldIndent}"plugin": [\n${fieldIndent}  "${url}"\n${fieldIndent}]`;

  return {
    changed: true,
    text: text.slice(0, j + 1) + insertion + text.slice(j + 1, i) + text.slice(i),
    action: '根对象里添加新 "plugin" 键',
  };
}

function patchRemovePlugin(text, url) {
  if (!text.includes(`"${url}"`)) return { changed: false, text, action: "未找到本插件 URL" };

  const escUrl = escRe(`"${url}"`);

  // 仅含本项的数组：[\s*"url"\s*]
  const onlyItemRe = new RegExp(`(\\[)(\\s*)${escUrl}(\\s*)(\\])`);
  if (onlyItemRe.test(text)) {
    return {
      changed: true,
      text: text.replace(onlyItemRe, "$1$4"),
      action: "本插件是数组唯一项，移除后变空数组",
    };
  }

  // 前面有其它项："url" 前的逗号 + 空白
  const leadingCommaRe = new RegExp(`,\\s*${escUrl}`);
  if (leadingCommaRe.test(text)) {
    return { changed: true, text: text.replace(leadingCommaRe, ""), action: "移除（前有逗号的项）" };
  }
  // 后面有其它项："url" 后的逗号 + 空白
  const trailingCommaRe = new RegExp(`${escUrl}\\s*,\\s*`);
  if (trailingCommaRe.test(text)) {
    return { changed: true, text: text.replace(trailingCommaRe, ""), action: "移除（后有逗号的项）" };
  }
  // 兜底：直接删 URL 串（不应触发）
  return { changed: true, text: text.replace(new RegExp(escUrl), ""), action: "强制移除（可能留下脏格式）" };
}

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
    const k = (await prompt("请粘贴 getbot.me API Key: ")).trim();
    if (!k) { warn("Key 不能为空，重试。"); continue; }
    return k;
  }
}

// ========== secret 文件读写（apiKey/baseURL 独立保存，不写主配置） ==========
const SECRET_PATH = join(GLOBAL_DIR, "config", "getbot-secret.json");

function loadSecret() {
  if (!existsSync(SECRET_PATH)) return {};
  try { return JSON.parse(readFileSync(SECRET_PATH, "utf-8")); }
  catch (e) { warn(`解析 ${SECRET_PATH} 失败：${e.message}，将重新生成`); return {}; }
}

function writeSecret(apiKey) {
  mkdirSync(dirname(SECRET_PATH), { recursive: true });
  writeFileSync(SECRET_PATH, JSON.stringify({ apiKey }, null, 2) + "\n", "utf-8");
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
  const buckets = { image: [], tts: [], asr: [], translate: [], chat: [] };
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

// ========== ffmpeg 检测 ==========
// 通用二进制存在性检查（PATH + Windows 固定路径）
function whichBinary(name) {
  const cmd = platform() === "win32" ? "where" : "which";
  const r = spawnSync(cmd, [name], { encoding: "utf-8" });
  if (r.status === 0 && r.stdout.trim()) return true;
  if (platform() === "win32") {
    const fixed = `C:\\ffmpeg\\bin\\${name}.exe`;
    if (existsSync(fixed)) return true;
  }
  return false;
}

// 安装末尾跑：检查 getbot 插件运行时依赖的二进制（ffmpeg/ffprobe/xclip），
// 缺什么列什么 + 生成可拷给 AI 助理的安装提示词。其他诊断项（API Key/cache/写权限）
// install.mjs 自身流程已经覆盖（fetchModels 验 key、writeCache 验写权限），不在这里重复。
function checkInstallDeps() {
  const missing = [];
  if (!whichBinary("ffmpeg")) missing.push("ffmpeg");
  else if (!whichBinary("ffprobe")) missing.push("ffprobe");  // 罕见，ffmpeg 装了但 ffprobe 没装
  if (platform() === "linux" && !whichBinary("xclip")) missing.push("xclip");
  return missing;
}

function formatDepsInstallPrompt(missingPkgs) {
  // 与 plugins/getbot.js 里 formatDoctorReport 的 AI 代办段保持口径一致
  const platName = platform() === "win32" ? "Windows" : platform() === "darwin" ? "macOS" : "Linux";
  const pkgManagerHint = platName === "Windows"
    ? "winget / chocolatey / scoop"
    : platName === "macOS" ? "Homebrew" : "apt / dnf / pacman";
  // 去重（ffmpeg/ffprobe 都靠 ffmpeg 包提供）
  const pkgs = [...new Set(missingPkgs.map((p) => p === "ffprobe" ? "ffmpeg" : p))];
  const lines = [];
  lines.push("");
  lines.push("📋 ============ 复制下面这段给你的 AI 助理 ============");
  lines.push("");
  lines.push("我刚装好 OpenCode 的 getbot 多模态插件，环境检测发现缺少以下依赖：");
  for (const p of pkgs) lines.push(`- ${p}`);
  lines.push("");
  lines.push(`我的系统：${platName}（Node ${process.version}）`);
  lines.push("");
  lines.push("请你帮我自动完成以下事情，**不要再询问我细节，直接开始**：");
  lines.push("");
  lines.push(`1. 检测我系统上可用的包管理器（${pkgManagerHint}）`);
  lines.push(`2. 用首选的包管理器一次性安装：${pkgs.join(" / ")}`);
  if (pkgs.includes("ffmpeg") && platName === "Windows") {
    lines.push(`3. 注意：getbot 插件会自动把 C:\\ffmpeg\\bin\\ 加到 PATH 前面。如果包管理器装到了别处（比如 winget 默认路径），请额外把 ffmpeg.exe 和 ffprobe.exe 复制一份到 C:\\ffmpeg\\bin\\，或确认其安装位置已在系统 PATH 中。`);
    lines.push(`4. 全部包管理器都失败时：从 https://www.gyan.dev/ffmpeg/builds/ 下载 release-essentials.zip，解压后把 bin\\ 目录里的全部 .exe 放到 C:\\ffmpeg\\bin\\`);
  }
  const verifyStep = (pkgs.includes("ffmpeg") && platName === "Windows") ? 5 : 3;
  lines.push(`${verifyStep}. 安装完成后逐项验证：`);
  for (const p of pkgs) lines.push(`   - ${p} -version`);
  lines.push(`${verifyStep + 1}. 把每项验证的版本号告诉我，然后告诉我"可以继续使用 getbot 插件了"`);
  lines.push("");
  lines.push("=========================================================");
  return lines.join("\n");
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

// 把老布局留下的孤儿文件（plugins/getbot.js + plugins/marked.mjs）移到时间戳备份目录
// 这种文件 opencode 不会自动加载，但放在那儿让人误以为已经装好；统一搬走避免歧义
function migrateLegacyOrphans() {
  const orphans = [
    join(GLOBAL_DIR, "plugins", "getbot.js"),
    join(GLOBAL_DIR, "plugins", "marked.mjs"),
  ].filter((p) => existsSync(p));
  if (!orphans.length) return null;
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const backup = join(GLOBAL_DIR, "plugins", `.getbot-legacy-backup-${stamp}`);
  if (DRY_RUN) {
    log(`  [dry-run] 会把以下孤儿文件移到 ${backup}/:`);
    for (const p of orphans) log("    - " + p);
    return backup;
  }
  mkdirSync(backup, { recursive: true });
  for (const p of orphans) {
    const dst = join(backup, basename(p));
    copyFileSync(p, dst);
    rmSync(p);
    log("  ↻ 老孤儿 → " + dst);
  }
  return backup;
}

function installFiles() {
  const result = { plugin: 0, commands: 0, config: 0, legacyMoved: null };

  // 0. 检测并搬走老布局的孤儿文件
  result.legacyMoved = migrateLegacyOrphans();

  // 1. 新布局：plugins/getbot/ 子目录（含 package.json + getbot.js + marked.mjs）
  if (DRY_RUN) {
    log(`  [dry-run] 会写入 ${PLUGIN_PKG_DIR}/{getbot.js,marked.mjs,package.json}`);
    result.plugin = 3;
  } else {
    mkdirSync(PLUGIN_PKG_DIR, { recursive: true });
    copyFileSync(join(__dirname, "plugins", "getbot.js"), join(PLUGIN_PKG_DIR, "getbot.js"));
    copyFileSync(join(__dirname, "plugins", "marked.mjs"), join(PLUGIN_PKG_DIR, "marked.mjs"));
    writeFileSync(join(PLUGIN_PKG_DIR, "package.json"), JSON.stringify(PLUGIN_PACKAGE_JSON, null, 2) + "\n", "utf-8");
    result.plugin = 3;
  }

  // 2. 命令文件（不变）
  if (DRY_RUN) {
    const cmdFiles = readdirSync(join(__dirname, "command")).filter((n) => /^getbot-.*\.md$/i.test(n));
    log(`  [dry-run] 会复制 ${cmdFiles.length} 个命令文件到 ${join(GLOBAL_DIR, "command")}`);
    result.commands = cmdFiles.length;
  } else {
    result.commands = copyTree(join(__dirname, "command"), join(GLOBAL_DIR, "command"), /^getbot-.*\.md$/i);
  }

  // 3. config 文件只有第一次安装时写入（保留用户手调）
  const srcCfg = join(__dirname, "config", "getbot.json");
  const dstCfg = join(GLOBAL_DIR, "config", "getbot.json");
  if (!existsSync(dstCfg)) {
    if (DRY_RUN) {
      log(`  [dry-run] 会写入 ${dstCfg}`);
    } else {
      mkdirSync(dirname(dstCfg), { recursive: true });
      copyFileSync(srcCfg, dstCfg);
    }
    result.config = 1;
  }
  return result;
}

// 找 opencode 主配置文件；若都不存在，创建最小 jsonc
function findOrCreateOpencodeConfig() {
  for (const name of OPENCODE_CONFIG_CANDIDATES) {
    const p = join(GLOBAL_DIR, name);
    if (existsSync(p)) return p;
  }
  const p = join(GLOBAL_DIR, "opencode.jsonc");
  if (DRY_RUN) {
    log(`  [dry-run] 没找到主配置，会创建空 ${p}`);
    return p;
  }
  mkdirSync(GLOBAL_DIR, { recursive: true });
  writeFileSync(p, `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`, "utf-8");
  log("  创建主配置: " + p);
  return p;
}

function backupFile(p) {
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const bak = `${p}.bak.${stamp}`;
  if (DRY_RUN) {
    log(`  [dry-run] 会备份 ${p} → ${bak}`);
    return bak;
  }
  copyFileSync(p, bak);
  return bak;
}

function patchOpencodeJsoncAdd() {
  const cfgPath = findOrCreateOpencodeConfig();
  const url = pluginFileUrl();
  const raw = existsSync(cfgPath) ? readFileSync(cfgPath, "utf-8") : `{\n  "$schema": "https://opencode.ai/config.json"\n}\n`;
  const { changed, text, action } = patchAddPlugin(raw, url);
  if (!changed) {
    log(`  ${cfgPath}: ${action}`);
    return { changed: false, cfgPath };
  }
  const bak = backupFile(cfgPath);
  if (DRY_RUN) {
    log(`  [dry-run] 会写入 ${cfgPath}（${action}）`);
  } else {
    writeFileSync(cfgPath, text, "utf-8");
    log(`  ${cfgPath}: ${action}（备份在 ${bak}）`);
  }
  return { changed: true, cfgPath, bak };
}

function patchOpencodeJsoncRemove() {
  const cfgPath = findOrCreateOpencodeConfig();
  if (!existsSync(cfgPath)) return { changed: false, cfgPath };
  const url = pluginFileUrl();
  const raw = readFileSync(cfgPath, "utf-8");
  const { changed, text, action } = patchRemovePlugin(raw, url);
  if (!changed) {
    log(`  ${cfgPath}: ${action}`);
    return { changed: false, cfgPath };
  }
  const bak = backupFile(cfgPath);
  if (DRY_RUN) {
    log(`  [dry-run] 会写入 ${cfgPath}（${action}）`);
  } else {
    writeFileSync(cfgPath, text, "utf-8");
    log(`  ${cfgPath}: ${action}（备份在 ${bak}）`);
  }
  return { changed: true, cfgPath, bak };
}

// ========== 写缓存 ==========
function writeCache(buckets, raw) {
  const cacheDir = join(GLOBAL_DIR, "cache");
  mkdirSync(cacheDir, { recursive: true });
  const defaults = {
    image: buckets.image[0] || null,
    tts: buckets.tts[0] || null,
    asr: buckets.asr[0] || null,
    translate: buckets.translate[0] || null,
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
function uninstallTargets() {
  // 文件列表（含老 / 新两种布局的所有可能位置）
  const files = [
    // 老布局孤儿（v1）
    join(GLOBAL_DIR, "plugins", "getbot.js"),
    join(GLOBAL_DIR, "plugins", "marked.mjs"),
    // 命令
    join(GLOBAL_DIR, "command", "getbot-image.md"),
    join(GLOBAL_DIR, "command", "getbot-tts.md"),
    join(GLOBAL_DIR, "command", "getbot-asr.md"),
    join(GLOBAL_DIR, "command", "getbot-translate.md"),
    join(GLOBAL_DIR, "command", "getbot-md2html.md"),
    join(GLOBAL_DIR, "command", "getbot-doctor.md"),
    join(GLOBAL_DIR, "command", "getbot-logs.md"),
    // 缓存 + secret
    join(GLOBAL_DIR, "cache", "getbot-models.json"),
    join(GLOBAL_DIR, "cache", "getbot-models.raw.json"),
    SECRET_PATH,
  ].filter((p) => existsSync(p));
  // 目录（新布局插件包）
  const dirs = [PLUGIN_PKG_DIR].filter((p) => existsSync(p));
  return { files, dirs };
}

async function confirmUninstall() {
  if (process.argv.includes("--yes") || process.argv.includes("-y")) return true;

  const { files, dirs } = uninstallTargets();
  log("将执行以下删除操作：");
  log("");
  if (dirs.length) {
    log("  目录（" + dirs.length + " 个）：");
    for (const p of dirs) log("    - " + p);
  }
  if (files.length) {
    log("  文件（" + files.length + " 个）：");
    for (const p of files) log("    - " + p);
  }
  if (!dirs.length && !files.length) log("  （未发现已安装的插件文件）");
  log("");
  log("另外会从 opencode.jsonc 的 plugin 数组里移除：" + pluginFileUrl());
  log("");
  log("保留：" + join(GLOBAL_DIR, "config", "getbot.json") + "（含你手调的参数）");
  log("");

  if (!dirs.length && !files.length) {
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
  const { files, dirs } = uninstallTargets();
  let removed = 0;

  for (const p of dirs) {
    if (DRY_RUN) { log("  [dry-run] 会删目录 " + p); continue; }
    rmSync(p, { recursive: true, force: true });
    removed++;
    log("  删目录 " + p);
  }
  for (const p of files) {
    if (DRY_RUN) { log("  [dry-run] 会删文件 " + p); continue; }
    rmSync(p);
    removed++;
    log("  删 " + p);
  }

  // 从 opencode.jsonc 移除 plugin 登记
  log("→ 从 opencode.jsonc 摘除本插件登记 ...");
  patchOpencodeJsoncRemove();

  log("");
  log(`✅ 已清理 ${removed} 项。config/getbot.json 保留（含用户配置），如需彻底删除：`);
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

  // 2. API Key：命令行 > 已配置（secret 文件） > 交互输入
  const argKey = process.argv[2] && !process.argv[2].startsWith("--") ? process.argv[2] : null;
  const existingSecret = loadSecret();
  const existingKey = existingSecret?.apiKey;
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
  log(`✓ 共 ${ids.length} 个模型：chat×${buckets.chat.length}  image×${buckets.image.length}  tts×${buckets.tts.length}  asr×${buckets.asr.length}  translate×${buckets.translate.length}`);

  // 4. 复制插件、命令、config
  log("→ 复制插件到 " + GLOBAL_DIR + " ...");
  const filesResult = installFiles();
  log(`✓ 插件包已安装：${PLUGIN_PKG_DIR}/{getbot.js,marked.mjs,package.json}`);
  if (filesResult.legacyMoved) log(`  老布局孤儿已搬到 ${filesResult.legacyMoved}（可手动删除）`);
  log(`✓ 命令文件 ${filesResult.commands} 个`);
  log(filesResult.config === 1 ? "✓ config/getbot.json 已写入默认配置" : "  config/getbot.json 已存在，保留用户配置");

  // 4.5 patch opencode.jsonc 让 opencode 识别本插件
  log("→ 登记到 opencode 主配置（opencode.jsonc 的 plugin 数组）...");
  patchOpencodeJsoncAdd();

  // 5. 写 secret 文件（apiKey + baseURL，独立保存，不写主配置）
  log("→ 保存 API Key 到 " + SECRET_PATH + " ...");
  writeSecret(apiKey);
  log("✓ apiKey 已保存（不会写入 opencode.jsonc，插件模型不暴露到主聊天界面）");

  // 6. 写缓存
  const toolDefaults = writeCache(buckets, raw);
  log("✓ 模型分类缓存已写入 " + join(GLOBAL_DIR, "cache", "getbot-models.json"));

  // 7. 检查运行时二进制依赖（ffmpeg/ffprobe/xclip）
  const missingDeps = checkInstallDeps();

  // 8. 总结
  log("");
  log("==============================================================");
  log("  ✅ 安装完成");
  log("==============================================================");
  log("");
  log("已注册 6 个斜杠命令（在 OpenCode 聊天窗输入 / 查看）：");
  log(`  /getbot-image     文生图    默认模型 → ${toolDefaults.image || "（无可用模型）"}`);
  log(`  /getbot-tts       语音合成  默认模型 → ${toolDefaults.tts || "（无可用模型）"}`);
  log(`  /getbot-asr       语音识别  默认模型 → ${toolDefaults.asr || "（无可用模型）"}`);
  log(`  /getbot-translate 中英互译  默认模型 → ${toolDefaults.translate || "（无可用模型）"}`);
  log(`  /getbot-md2html   MD 转打印排版 HTML（在浏览器里 Ctrl+P 另存 PDF）`);
  log(`  /getbot-help      使用说明（命令清单 / TTS 音色 / 默认模型 / 排查入口）`);
  log("快捷键：Ctrl+Shift+V → 录音 30s → 自动转文字插入输入框");
  log("排查：遇到问题时对 AI 说\"开 getbot 调试\"，会打开 debug 日志 + 跑环境诊断");
  log("");

  if (missingDeps.length) {
    log(`⚠  检测到缺少 ${missingDeps.length} 个运行时依赖：${missingDeps.join(", ")}`);
    log("   插件本体已装好，但语音相关功能（ASR / 录音输入）将受限。");
    log(formatDepsInstallPrompt(missingDeps));
    log("");
  } else {
    log("✓ 运行时依赖（ffmpeg / ffprobe" + (platform() === "linux" ? " / xclip" : "") + "）齐全");
    log("");
  }

  log("📋 下一步：");
  log("  1) 完全退出 OpenCode 桌面 app（包括系统托盘图标）");
  log("  2) 重开 app");
  log("  3) 输 /getbot-help 看完整说明，再试 /getbot-image 一只橘猫");
  log("");
  log("说明：插件已登记到 opencode.jsonc 的 plugin 数组。");
  log("      插件模型不出现在 OpenCode 主聊天的模型列表里，只通过 /getbot-* 斜杠命令调用。");
  log("");
  log("如需卸载：node install.mjs --uninstall");
}

main().catch((e) => {
  err(e.stack || e.message);
  process.exit(1);
});
