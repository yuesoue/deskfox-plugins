#!/usr/bin/env node
/**
 * getbot.me × OpenCode 一键安装脚本（**provider 版**）
 *
 * 相比普通版（getbot-opencode），本版**额外**把 getbot.me 作为 provider 注入到
 * OpenCode 主聊天的模型选择器，让 27+ 个 chat 模型可直接在主对话框里选用。
 *
 * 默认安装到 OpenCode 全局目录：~/.config/opencode/
 *   - plugins/getbot/{getbot.js, marked.mjs, package.json}   ← 子目录形态（opencode 加载要求）
 *   - command/getbot-{image,tts,asr,translate,md2html,help}.md   ← 6 个面向用户的 slash 命令
 *   - config/getbot.json   ← 含 debug 开关，默认关闭，对 AI 说"开 getbot 调试"打开
 *   - （注：getbot-doctor / getbot-logs / getbot-debug 工具仅 LLM 可调，无 slash 入口）
 *   - config/getbot-secret.json（apiKey + baseURL，插件本体用，独立保存）
 *   - cache/getbot-models.json
 *
 * 同时会**自动 patch** ~/.config/opencode/opencode.jsonc：
 *   - 在 "plugin" 数组里追加 "file:///.../plugins/getbot"（字符串 patch，保留 jsonc 注释；幂等）
 *   - 若 provider.getbot.options.apiKey **未配置**（不存在 / 空串），写入完整
 *     provider.getbot.{name, npm, options.{baseURL, apiKey}, models}
 *     （JSON 重写，**会丢失原 jsonc 注释**；写入前自动备份到 opencode.jsonc.bak.<时间戳>）
 *   - 若 apiKey **已配置**（OpenCode app 的"连接 provider"装过 / 上次跑过本脚本）→ **跳过**
 *     provider 注入步骤；不破坏已有配置，secret 文件该写还写
 *   - apiKey 写两份：secret 文件（插件本体用，每次必写）+ opencode.jsonc 的
 *     provider.getbot.options.apiKey（主聊天 provider 用，幂等跳过时不写）
 *   - 推荐 5 个模型不写 release_date → 默认显示在主聊天模型选择器
 *     其余 22+ 个写 release_date: "2020-01-01" → 默认隐藏（用户可在模型设置页手动开启）
 *
 * 卸载语义（**与普通版的关键差别**）：
 *   - 卸载只清"插件部分"（plugin 数组项 + plugins/getbot/ + command + cache + secret）
 *   - **不动** opencode.jsonc 的 provider.getbot（注入后视为独立事项，只装不卸；
 *     要清需用户手动改 opencode.jsonc）
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

// 从安装包顶层 package.json 读版本号（单一来源）。打 zip 时 package.json 会随包一起进去。
function readPkgVersion() {
  try {
    const pkg = JSON.parse(readFileSync(join(__dirname, "package.json"), "utf-8"));
    return typeof pkg.version === "string" && pkg.version ? pkg.version : "0.0.0-local";
  } catch {
    return "0.0.0-local";
  }
}
const PKG_VERSION = readPkgVersion();

const PLUGIN_PACKAGE_JSON = {
  name: "@getbot/opencode-plugin",
  version: PKG_VERSION,
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
  log("  getbot.me × OpenCode 一键安装（provider 版）");
  log("  把 getbot.me 的 Qwen/GPT/Claude 等模型既装为插件斜杠命令，");
  log("  也注入到主聊天 provider 列表（可在模型选择器直接选用）。");
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

// 安装末尾跑：检查 getbot 插件运行时依赖的二进制（ffmpeg/ffprobe），
// 缺什么列什么 + 生成可拷给 AI 助理的安装提示词。其他诊断项（API Key/cache/写权限）
// install.mjs 自身流程已经覆盖（fetchModels 验 key、writeCache 验写权限），不在这里重复。
function checkInstallDeps() {
  const missing = [];
  if (!whichBinary("ffmpeg")) missing.push("ffmpeg");
  else if (!whichBinary("ffprobe")) missing.push("ffprobe");  // 罕见，ffmpeg 装了但 ffprobe 没装
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

// ========== Provider 注入（写 opencode.jsonc 的 provider.getbot） ==========
//
// 与 patchOpencodeJsoncAdd（只动 plugin 数组的字符串 patch）不同，本段用
// JSON.parse + stringify 重写整个 opencode.jsonc —— 会丢掉原 jsonc 注释和格式。
// 安装前自动备份到 opencode.jsonc.bak.<时间戳>。
//
// 卸载时**不**调用本段任何函数 —— provider.getbot 注入后视为独立事项，只装不卸。

// 简易 jsonc 注释剥离（够用：opencode 主配置不会有复杂的注释嵌套）
function stripJsoncComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function loadOpencodeConfigJson(path) {
  if (!existsSync(path)) return { $schema: "https://opencode.ai/config.json" };
  const raw = readFileSync(path, "utf-8");
  try { return JSON.parse(raw); } catch {}
  try { return JSON.parse(stripJsoncComments(raw)); }
  catch (e) { throw new Error(`解析 ${path} 失败：${e.message}`); }
}

// 根据模型 id 推断能力字段；recommended=false 时加 release_date: "2020-01-01"
// 让 opencode 默认把这个模型隐藏（不在 "latest 6 月内" 集合里）。
// 见 D:/project/opencode-fork/packages/app/src/context/models.tsx:114 visible()
function inferModelConfig(id, recommended) {
  const isRealtime = /realtime|streaming/i.test(id);
  const isOmni = /omni/i.test(id);
  const isVision = /vision|vl\b|visual/i.test(id);
  const isAudio = /audio|asr|tts|whisper|speech/i.test(id);
  const isReasoning = /\bo1\b|\bo3\b|\bo4\b|thinking|reasoning/i.test(id);
  const cfg = { name: id };
  cfg.tool_call = !isRealtime;
  if (isOmni || isVision || isAudio || /gpt-4o|claude/i.test(id)) cfg.attachment = true;
  if (isReasoning) cfg.reasoning = true;
  if (!recommended) cfg.release_date = "2020-01-01";
  return cfg;
}

// 从 buckets.chat 实际列表里按优先级类别选 N 个推荐（避免硬编码不存在的 id）。
// 用户后续可以根据自己的偏好改 RECOMMEND_RULES。
const RECOMMEND_RULES = [
  { name: "旗舰通用",       re: /qwen-max-latest|qwen3-max|qwen-max(?!-)|gpt-4o(?!-mini)/i },
  { name: "coder",          re: /coder|qwen3-coder/i },
  { name: "reasoning",      re: /thinking|reasoning|deepseek-r1|deepseek-v3|\bo[134]\b/i },
  { name: "vision",         re: /vl-max|qwen.*vl|gpt-4o(?!-mini)/i },
  { name: "kimi/glm/claude", re: /kimi-k2|kimi.*latest|glm-4(?!\.5)|claude-3\.?5-sonnet|claude/i },
];

function pickRecommended(chatIds, n = 5) {
  const picked = [];
  for (const { re } of RECOMMEND_RULES) {
    const m = chatIds.find((id) => re.test(id) && !picked.includes(id));
    if (m) picked.push(m);
    if (picked.length >= n) break;
  }
  // 兜底：分类没匹满 n 个，按 chatIds 顺序补齐
  for (const id of chatIds) {
    if (picked.length >= n) break;
    if (!picked.includes(id)) picked.push(id);
  }
  return picked;
}

// 把 getbot 作为 provider 合并写入 opencode.jsonc，apiKey 直接明文存
// （等同 OpenCode 其他 provider 的标准存储方式）
function mergeProvider(cfg, apiKey, chatIds, recommendedIds) {
  // 若用户曾把 getbot 加入 disabled_providers，自动移除
  if (Array.isArray(cfg.disabled_providers)) {
    const filtered = cfg.disabled_providers.filter((p) => p !== "getbot");
    if (filtered.length === 0) delete cfg.disabled_providers;
    else cfg.disabled_providers = filtered;
  }
  cfg.provider ??= {};
  const existing = cfg.provider.getbot || {};
  const existingModels = existing.models || {};
  const mergedModels = { ...existingModels };
  const recSet = new Set(recommendedIds);
  let added = 0;
  for (const id of chatIds) {
    if (!mergedModels[id]) {
      mergedModels[id] = inferModelConfig(id, recSet.has(id));
      added++;
    }
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

// 调用入口：定位主配置文件路径 → 幂等检测 → 备份 → 合并 → 写回
//
// 幂等检测：判断标准是"provider.getbot.options.apiKey 是否已是非空字符串"，
// 不是"provider.getbot 块是否存在"。这样能正确处理：
//   - opencode-fork 内置 getbot UI 支持但用户没在 UI 连接过（jsonc 无块）→ 注入
//   - fork 写过 stub 但 key 为空（理论可能，当前 fork 不会这样）→ 注入帮填 key
//   - 用户用 UI 完整连接过（block + key 都齐）→ 跳过，避免破坏 jsonc 注释 / 改用户配置
//   - 用过本脚本（block + key 都齐）→ 跳过
//
// disabled_providers：在"key 已配置"时不动；在"未配置 → 注入"时由 mergeProvider 顺手清掉
// "getbot" 项（因为用户既然来跑本脚本就是想用 getbot，禁用标记应清）。
function injectProvider(apiKey, chatIds, recommendedIds) {
  const cfgPath = findOrCreateOpencodeConfig();
  const existed = existsSync(cfgPath);
  const cfg = loadOpencodeConfigJson(cfgPath);

  // 幂等检测
  const existingKey = cfg.provider?.getbot?.options?.apiKey;
  const keyConfigured = typeof existingKey === "string" && existingKey.trim().length > 0;
  if (keyConfigured) {
    const modelCount = Object.keys(cfg.provider.getbot.models || {}).length;
    log(`  ✓ 检测到 opencode.jsonc 已配置 provider.getbot（${modelCount} 个模型，含 apiKey），跳过注入`);
    log(`    （由 OpenCode app 的"连接 provider"或上次本脚本写入）`);
    log(`    本脚本不会破坏已有配置；如需重新注入，请手动从 opencode.jsonc 移除`);
    log(`    provider.getbot 整块（或清空 options.apiKey 字段），再跑本脚本。`);
    return { skipped: true, total: modelCount, added: 0 };
  }

  // 注入路径
  const result = mergeProvider(cfg, apiKey, chatIds, recommendedIds);
  const text = JSON.stringify(cfg, null, 2) + "\n";
  let bak = null;
  if (existed) bak = backupFile(cfgPath);
  if (DRY_RUN) {
    log(`  [dry-run] 会写入 ${cfgPath}（provider.getbot：${result.total} 个模型，新增 ${result.added}）`);
  } else {
    writeFileSync(cfgPath, text, "utf-8");
    log(`  ${cfgPath}: provider.getbot 已写入（共 ${result.total} 个模型，新增 ${result.added}）`);
    if (bak) log(`    原文件已备份到 ${bak}（注意：jsonc 注释会丢失，可从备份恢复）`);
  }
  return result;
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
    join(GLOBAL_DIR, "command", "getbot-help.md"),
    // 老版本兼容（v1 曾有但已删除的 slash 命令文件）
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
  log("保留（**不会**清理）：");
  log("  - " + join(GLOBAL_DIR, "config", "getbot.json") + "（含你手调的参数）");
  log("  - opencode.jsonc 的 provider.getbot 整块（注入主聊天的 provider 视为独立事项，只装不卸）");
  log("    如需清理，请手动改 opencode.jsonc 或从 .bak.<时间戳> 备份恢复");
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

  // 4.5 patch opencode.jsonc 让 opencode 识别本插件（字符串 patch 保留 jsonc 注释）
  log("→ 登记到 opencode 主配置（opencode.jsonc 的 plugin 数组）...");
  patchOpencodeJsoncAdd();

  // 4.6 注入 provider.getbot 到 opencode.jsonc（JSON 重写，会丢注释，写入前自动备份）
  //     幂等：若已配置 apiKey 则整段跳过；推荐 5 个 / 22 个隐藏 只在真正注入时打印
  log("→ 注入 provider.getbot 到 opencode 主配置 ...");
  const recommendedIds = pickRecommended(buckets.chat, 5);
  const providerResult = injectProvider(apiKey, buckets.chat, recommendedIds);
  if (!providerResult.skipped) {
    log("  推荐 5 个模型（默认在主聊天选择器显示）：");
    for (const id of recommendedIds) log(`    ✨ ${id}`);
    log(`  其他 ${Math.max(0, buckets.chat.length - recommendedIds.length)} 个 chat 模型默认隐藏（用户可在模型设置页手动开启）`);
  }

  // 5. 同时写 secret 文件（插件本体用，独立 key 副本；与 opencode.jsonc 的 provider key 互不干扰）
  log("→ 保存 API Key 到 " + SECRET_PATH + " ...");
  writeSecret(apiKey);
  log(providerResult.skipped
    ? `✓ apiKey 已保存到 secret 文件（插件本体用）；opencode.jsonc 已有 provider key 未动`
    : `✓ apiKey 已保存到 secret 文件（插件本体用）+ opencode.jsonc 的 provider.getbot.options.apiKey（主聊天 provider 用）`);

  // 6. 写缓存
  const toolDefaults = writeCache(buckets, raw);
  log("✓ 模型分类缓存已写入 " + join(GLOBAL_DIR, "cache", "getbot-models.json"));

  // 7. 检查运行时二进制依赖（ffmpeg/ffprobe）
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
  log("排查：遇到问题时对 AI 说\"开 getbot 调试\"，会打开 debug 日志 + 跑环境诊断");
  log("");

  if (missingDeps.length) {
    log(`⚠  检测到缺少 ${missingDeps.length} 个运行时依赖：${missingDeps.join(", ")}`);
    log("   插件本体已装好，但 /getbot-asr 功能将受限（依赖 ffmpeg / ffprobe 做音频预处理与分片）。");
    log(formatDepsInstallPrompt(missingDeps));
    log("");
  } else {
    log("✓ 运行时依赖（ffmpeg / ffprobe）齐全");
    log("");
  }

  log("📋 下一步：");
  log("  1) 完全退出 OpenCode 桌面 app（包括系统托盘图标）");
  log("  2) 重开 app");
  log("  3) 主聊天底部模型选择器里会出现上面推荐的 5 个 getbot 模型，可直接选用");
  log("     其他 chat 模型在 OpenCode 设置 → 模型 里 toggle 开启");
  log("  4) 输 /getbot-help 看插件 slash 命令清单，再试 /getbot-image 一只橘猫");
  log("");
  log("⚠ 卸载语义：");
  log("  node install.mjs --uninstall  只清插件部分（plugin 数组项 + plugins/getbot/ + command + cache + secret）");
  log("  **不会**清 opencode.jsonc 的 provider.getbot —— 注入主聊天的 provider 视为独立事项，");
  log("  要清需要你手动改 opencode.jsonc（或从 .bak 备份恢复）");
}

main().catch((e) => {
  err(e.stack || e.message);
  process.exit(1);
});
