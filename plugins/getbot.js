/**
 * OpenCode getbot.me 插件
 *
 * 双导出：
 *   - GetbotPlugin (server)：4 个多模态工具
 *     getbot_image / getbot_tts / getbot_asr / getbot_md2html
 *   - tui：命令面板条目（切换各模态默认模型、刷新模型列表） + Ctrl+Shift+V 语音输入
 *
 * 使用前请先运行：node install.mjs [sk-xxxx]
 * 安装后可用 /getbot-doctor 检查环境依赖是否就绪
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync, appendFileSync } from "node:fs";
import { dirname, basename, extname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir, hostname } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { tool } from "@opencode-ai/plugin";

// ========== 通用工具 ==========

const DEFAULT_BASE_URL = "https://api.getbot.me/v1";
const GLOBAL_OC_DIR = join(homedir(), ".config", "opencode");

// 启动时算一次 getbot.js 自身 hash（前 8 位），用于在日志里识别"对方跑的是否同一份代码"
const PLUGIN_HASH = (() => {
  try {
    return createHash("sha256").update(readFileSync(fileURLToPath(import.meta.url))).digest("hex").slice(0, 8);
  } catch { return null; }
})();

function readGetbotSecret() {
  const p = join(GLOBAL_OC_DIR, "config", "getbot-secret.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function nowStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function ffmpegEnv() {
  if (process.platform === "win32") {
    return { ...process.env, PATH: String.raw`C:\ffmpeg\bin;` + (process.env.PATH || "") };
  }
  return process.env;
}

function loadApiKey(projectDir) {
  // 1. 环境变量优先
  if (process.env.GETBOT_API_KEY) return process.env.GETBOT_API_KEY;
  // 2. 项目 .env（老项目兼容）
  const envPath = join(projectDir, ".env");
  if (existsSync(envPath)) {
    const match = readFileSync(envPath, "utf-8").match(/^\s*GETBOT_API_KEY\s*=\s*(.+?)\s*$/m);
    if (match) return match[1].trim();
  }
  // 3. 插件专用 secret 文件（install.mjs 安装后写入，不与 OpenCode 主配置混在一起）
  const secret = readGetbotSecret();
  const k = secret?.apiKey;
  if (typeof k === "string" && k && !/^\{env:/.test(k)) return k;
  return null;
}

function loadConfig(projectDir) {
  // 项目 .opencode/config/getbot.json 优先（允许项目覆盖），回落全局 ~/.config/opencode/config/getbot.json
  for (const p of [
    join(projectDir, ".opencode", "config", "getbot.json"),
    join(GLOBAL_OC_DIR, "config", "getbot.json"),
  ]) {
    if (!existsSync(p)) continue;
    try { return JSON.parse(readFileSync(p, "utf-8")); } catch {}
  }
  return {};
}

function cachePath(projectDir) {
  const projectP = join(projectDir, ".opencode", "cache", "getbot-models.json");
  const globalP = join(GLOBAL_OC_DIR, "cache", "getbot-models.json");
  if (existsSync(projectP)) return projectP;
  if (existsSync(globalP)) return globalP;
  return projectP;
}

function loadCache(projectDir) {
  const p = cachePath(projectDir);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch { return null; }
}

function saveCache(projectDir, cache) {
  const p = cachePath(projectDir);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2) + "\n", "utf-8");
}

function resolveDefault(cache, category, fallback = null, config = null) {
  // 优先级：config.category_overrides > cache.defaults > cache.categorized[0]
  const overrides = config?.category_overrides?.[category];
  if (Array.isArray(overrides) && overrides.length > 0) return overrides[0];
  if (!cache) return fallback;
  if (cache.defaults?.[category]) return cache.defaults[category];
  const list = cache.categorized?.[category];
  return (list && list[0]) || fallback;
}

function resolveOutputDir(projectDir, config, key, fallbackRel) {
  const rel = config?.output_dirs?.[key] || fallbackRel;
  const abs = join(projectDir, rel);
  mkdirSync(abs, { recursive: true });
  return abs;
}

function baseURL(config) {
  return config?.baseURL || DEFAULT_BASE_URL;
}

async function requireKey(projectDir) {
  const key = loadApiKey(projectDir);
  if (!key) throw new Error("未找到 GETBOT_API_KEY：请运行 install.mjs，或运行 /getbot-doctor 查看完整诊断");
  return key;
}

// ========== 调用日志 ==========
// 每次工具调用写一行 JSONL 到 <projectDir>/.opencode/logs/getbot-YYYY-MM-DD.jsonl
// 设计目标：对方机器出问题时把当天日志发回来就能定位
//   - args：LLM 实际传入的参数（free-tier 模型最易在这里被改写）
//   - api[].requestBody：真正发往 getbot.me 的 body
//   - api[].responseHeaders：含 x-request-id 等可上 getbot.me 后台对账的字段
//   - outputs[].sha256：跨多次调用对账，识别后端返还固定样本
//   - env.pluginHash：识别对方是否跑的同一份 getbot.js

function keyHint(key) {
  if (!key || typeof key !== "string") return null;
  if (key.length < 12) return "***";
  return key.slice(0, 4) + "..." + key.slice(-4);
}

function detectKeySource(projectDir) {
  if (process.env.GETBOT_API_KEY) return "env";
  const envPath = join(projectDir, ".env");
  if (existsSync(envPath)) {
    try {
      if (/^\s*GETBOT_API_KEY\s*=/m.test(readFileSync(envPath, "utf-8"))) return ".env";
    } catch {}
  }
  if (readGetbotSecret()?.apiKey) return "secret";
  return "none";
}

function sha256File(path) {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch { return null; }
}

function headersToObject(h) {
  const o = {};
  try { h.forEach((v, k) => { o[k] = v; }); } catch {}
  return o;
}

// JSON.stringify replacer：脱敏并裁剪超长字段，特别是 base64 音频/图像
function logReplacer(_key, value) {
  if (typeof value === "string") {
    // data:audio/...;base64,xxxx 或 data:image/...
    if (value.length > 200 && /^data:(audio|image|video)\//.test(value)) {
      const kind = value.slice(5, value.indexOf("/"));
      return `<${kind} base64 omitted, ${value.length} chars>`;
    }
    // 裸 base64 长串（无 data: 前缀）
    if (value.length > 500 && /^[A-Za-z0-9+/=_-]+$/.test(value)) {
      return `<base64-like omitted, ${value.length} chars>`;
    }
    if (value.length > 2000) {
      return value.slice(0, 1000) + `...<truncated, total ${value.length}>`;
    }
  }
  return value;
}

function sanitizeForLog(obj) {
  try { return JSON.parse(JSON.stringify(obj, logReplacer)); } catch { return null; }
}

// 日志统一写到全局位置，方便用户一键找到（不随项目目录变化）
function logDir() {
  return join(GLOBAL_OC_DIR, "logs");
}

function logFilePath() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return join(logDir(), `getbot-${stamp}.jsonl`);
}

function appendLog(entry) {
  try {
    const p = logFilePath();
    mkdirSync(dirname(p), { recursive: true });
    appendFileSync(p, JSON.stringify(entry) + "\n", "utf-8");
  } catch {}
}

function newLogContext(projectDir, toolName, args, config) {
  const cache = loadCache(projectDir);
  let host = null;
  try { host = hostname(); } catch {}
  return {
    _startedAt: Date.now(),
    ts: new Date().toISOString(),
    tool: toolName,
    args: sanitizeForLog(args),
    env: {
      platform: process.platform,
      hostname: host,
      node: process.version,
      cwd: process.cwd(),
      projectDir,
      pluginHash: PLUGIN_HASH,
    },
    config: {
      baseURL: baseURL(config),
      defaults: cache?.defaults || null,
      keySource: detectKeySource(projectDir),
      keyHint: keyHint(loadApiKey(projectDir)),
    },
    resolved: {},
    api: [],
    outputs: [],
    ok: false,
    error: null,
  };
}

function finishLog(ctx) {
  if (!ctx) return;
  const entry = {
    ts: ctx.ts,
    tool: ctx.tool,
    args: ctx.args,
    env: ctx.env,
    config: ctx.config,
    resolved: ctx.resolved,
    api: ctx.api,
    outputs: ctx.outputs,
    durationMs: Date.now() - ctx._startedAt,
    ok: ctx.ok,
    error: ctx.error,
  };
  appendLog(entry);
}

// ========== API 调用 ==========

// 统一 API 调用：JSON 入参，JSON 或 binary 出参；全程把请求/响应元信息推入 ctx.api。
// ctx 可为 null（如内部辅助调用），不影响功能，只是不写日志。
// opts.timeoutMs 默认 120s；图像调用应显式传更大值（180s+）；TTS/翻译可传更小（60s）
async function apiJsonRequest(ctx, url, apiKey, body, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 120000;
  const entry = {
    url, method: "POST",
    requestBody: sanitizeForLog(body),
    timeoutMs,
  };
  if (ctx?.api) ctx.api.push(entry);
  const t0 = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...(opts.accept ? { Accept: opts.accept } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    entry.status = resp.status;
    entry.contentType = resp.headers.get("content-type") || null;
    entry.responseHeaders = headersToObject(resp.headers);
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      entry.responsePreview = text.slice(0, 800);
      throw new Error(`HTTP ${resp.status} at ${url}: ${text.slice(0, 400)}`);
    }
    if (opts.binary) {
      const buf = Buffer.from(await resp.arrayBuffer());
      entry.responseBytes = buf.length;
      entry.responsePreview = `<binary ${buf.length} bytes, contentType=${entry.contentType}>`;
      if (opts.expectContentType && !opts.expectContentType.test(entry.contentType || "")) {
        throw new Error(`预期 ${opts.expectContentType}，实际 ${entry.contentType}`);
      }
      return buf;
    }
    const data = await resp.json();
    entry.responsePreview = sanitizeForLog(data);
    return data;
  } catch (e) {
    // AbortError → 转成更友好的超时错误
    const isAbort = e?.name === "AbortError" || /aborted/i.test(e?.message || "");
    const finalErr = isAbort
      ? new Error(`请求超时（${timeoutMs}ms 未响应）：${url}`)
      : e;
    if (!entry.error) entry.error = finalErr.message;
    throw finalErr;
  } finally {
    clearTimeout(timer);
    entry.durationMs = Date.now() - t0;
  }
}

async function callImage(apiKey, cfg, { model, prompt, size, n }, ctx) {
  const url = baseURL(cfg).replace(/\/$/, "") + "/images/generations";
  const body = {
    model, prompt,
    size: size || cfg?.defaults?.image_size || "1024x1024",
    n: n || cfg?.defaults?.image_n || 1,
  };
  // 图像模型偶尔单次需要 1-2 分钟，给 3 分钟超时
  const data = await apiJsonRequest(ctx, url, apiKey, body, { timeoutMs: 180000 });
  // 防御性解析：data 可能为 null；items 可能含 null 或非对象元素
  const itemsRaw = data?.data || data?.images || [];
  const items = Array.isArray(itemsRaw) ? itemsRaw : [];
  const urls = items
    .map((it) => (it && typeof it === "object") ? (it.url || it.image_url || it.b64_json) : null)
    .filter((u) => typeof u === "string" && u.length > 0);
  return { urls, raw: data };
}

// Qwen TTS 已知可用音色白名单。getbot.me 后端对未知音色不报错（会用默认音色兜底返回），
// 所以无法用 API 探测合法值，只能在此人工维护。发现新音色请在此追加。
const TTS_VOICES = ["Cherry", "Ethan", "Serena", "Chelsie"];

// getbot.me 2026-04 服务端调整后：TTS 走标准 OpenAI /v1/audio/speech 端点
// 返回 16-bit PCM mono 24kHz WAV 字节流；不再支持 chat/completions 路径
async function callTTS(apiKey, cfg, { model, text, voice }, ctx) {
  const url = baseURL(cfg).replace(/\/$/, "") + "/audio/speech";
  const actualVoice = voice || cfg?.defaults?.tts_voice || "Cherry";
  const body = { model, input: text, voice: actualVoice };
  return await apiJsonRequest(ctx, url, apiKey, body, {
    binary: true,
    accept: "audio/*",
    expectContentType: /^audio\//i,
    timeoutMs: 60000,
  });
}

// ASR 前先把任意格式音频转成 16kHz/mono/32kbps mp3，大幅压小避开 Nginx 上传限制
async function compactAudioForAsr(inputPath, tmpDir) {
  let size = 0;
  try { size = statSync(inputPath).size; } catch {}
  // 已经是小 mp3 就不转码
  if (size > 0 && size < 200 * 1024 && /\.mp3$/i.test(inputPath)) return { path: inputPath, created: false };
  mkdirSync(tmpDir, { recursive: true });
  const out = join(tmpDir, `asr_${Date.now()}.mp3`);
  // 压缩转码：通常 5-30 秒，给 90 秒兜底（极大文件转码时间更长，但 90 秒已经足够覆盖 1 小时音频）
  await runCmd("ffmpeg", [
    "-y", "-i", inputPath,
    "-vn", "-ar", "16000", "-ac", "1", "-b:a", "32k",
    out,
  ], { timeoutMs: 90000 });
  return { path: out, created: true };
}

// 语言名归一化：zh / 中文 / chinese → Chinese；en / 英文 / english → English
function normalizeLang(lang) {
  if (!lang) return null;
  const s = String(lang).trim().toLowerCase();
  const map = {
    zh: "Chinese", "zh-cn": "Chinese", "zh_cn": "Chinese", cn: "Chinese", chinese: "Chinese", "中文": "Chinese", "汉语": "Chinese",
    en: "English", "en-us": "English", us: "English", english: "English", "英文": "English", "英语": "English",
  };
  return map[s] || lang;
}

// getbot.me 中转层不透传 Qwen-MT 的 translation_options 字段，且 qwen-mt-* 拒绝 system 角色；
// 因此把翻译指令直接塞进 user content 里。实测 qwen-mt-turbo 输出干净、token 极少（约 30）。
async function callTranslate(apiKey, cfg, { model, text, sourceLang, targetLang }, ctx) {
  const url = baseURL(cfg).replace(/\/$/, "") + "/chat/completions";
  const target = normalizeLang(targetLang) || "English";
  const sourceHint = sourceLang ? ` from ${normalizeLang(sourceLang)}` : "";
  const prompt = `Translate the following text${sourceHint} to ${target}. Output ONLY the translation, no explanation, no quotes, no commentary.\n\n${text}`;
  const body = { model, messages: [{ role: "user", content: prompt }], stream: false };
  const data = await apiJsonRequest(ctx, url, apiKey, body, { timeoutMs: 60000 });
  const content = data.choices?.[0]?.message?.content;
  let out;
  if (typeof content === "string") out = content;
  else if (Array.isArray(content)) out = content.map((c) => (typeof c === "string" ? c : c.text || "")).join("");
  else out = String(content ?? "");
  return out.trim();
}

// getbot.me 没有 /v1/audio/transcriptions，走 chat/completions 的 input_audio 多模态消息
async function callTranscription(apiKey, cfg, { model, audioPath, language, tmpDir }, ctx) {
  const compactDir = tmpDir || join(dirname(audioPath), ".getbot_tmp_" + Date.now());
  const compact = await compactAudioForAsr(audioPath, compactDir);
  try {
    const buf = readFileSync(compact.path);
    const base64 = buf.toString("base64");
    const fmt = extname(compact.path).slice(1).toLowerCase() || "mp3";
    const promptText = (language && /^en/i.test(language))
      ? "Please transcribe this audio verbatim. Output only the transcript."
      : "请将这段音频逐字转录为文字，只输出转录结果本身，不要添加任何解释或说明。";
    const body = {
      model,
      messages: [{
        role: "user",
        content: [
          { type: "input_audio", input_audio: { data: `data:audio/${fmt};base64,${base64}`, format: fmt } },
          { type: "text", text: promptText },
        ],
      }],
      stream: false,
    };
    const url = baseURL(cfg).replace(/\/$/, "") + "/chat/completions";
    // ASR 单片可能耗时较长（特别是 omni 模型对长音频），给 120s
    const data = await apiJsonRequest(ctx, url, apiKey, body, { timeoutMs: 120000 });
    const content = data.choices?.[0]?.message?.content;
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
      return content.map((c) => (typeof c === "string" ? c : c.text || "")).join("");
    }
    return String(content ?? "");
  } finally {
    if (compact.created) {
      try { rmSync(compact.path); } catch {}
      try { rmSync(compactDir, { recursive: true, force: true }); } catch {}
    }
  }
}

async function downloadTo(url, destPath, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    writeFileSync(destPath, buf);
    return destPath;
  } catch (e) {
    if (e?.name === "AbortError") throw new Error(`下载超时（${timeoutMs}ms）：${url}`);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

function writeBase64To(b64, destPath) {
  writeFileSync(destPath, Buffer.from(b64, "base64"));
  return destPath;
}

// ========== 依赖检查 / Doctor ==========
// 用法：调用 runDoctor() 拿到 {goods, issues}，issues 里凡是 agentInstallable 为 true 的
// 都会被 formatDoctorReport 汇集进一份"给 AI 助理的安装指令"中。

function checkBinary(cmd, args = ["-version"]) {
  try {
    const r = spawnSync(cmd, args, { env: ffmpegEnv(), encoding: "utf-8", timeout: 5000 });
    if (r.error || (r.status !== 0 && r.status !== null)) return { ok: false };
    const firstLine = ((r.stdout || "") + (r.stderr || "")).split(/\r?\n/)[0].trim();
    return { ok: true, version: firstLine };
  } catch {
    return { ok: false };
  }
}

function runDoctor(projectDir, config) {
  const goods = [];
  const issues = [];

  // 1. 运行时基础信息（永远算 good，方便诊断）
  goods.push(`✓ Node/Bun: ${process.version}  |  平台: ${process.platform}  |  插件 hash: ${PLUGIN_HASH || "?"}`);

  // 2. API Key
  const apiKey = loadApiKey(projectDir);
  if (!apiKey) {
    issues.push({
      id: "no_api_key",
      title: "GETBOT_API_KEY 未配置",
      affects: "所有联网工具（image / tts / asr / translate）",
      manualFix: "在项目根目录运行：node install.mjs <你的-sk-key>",
      agentInstallable: false,
    });
  } else {
    goods.push(`✓ API Key 已配置（来源: ${detectKeySource(projectDir)}, hint: ${keyHint(apiKey)}）`);
  }

  // 3. 模型缓存
  const cache = loadCache(projectDir);
  const cats = ["image", "tts", "asr", "translate"];
  if (!cache) {
    issues.push({
      id: "no_cache",
      title: "模型缓存不存在（~/.config/opencode/cache/getbot-models.json）",
      affects: "所有联网工具",
      manualFix: "重跑：node install.mjs（会自动从 getbot.me API 拉取模型列表并分类）",
      agentInstallable: false,
    });
  } else {
    const missing = cats.filter((c) => !resolveDefault(cache, c, null, config));
    if (missing.length) {
      issues.push({
        id: "incomplete_cache",
        title: `模型缓存缺这些分类：${missing.join(", ")}`,
        affects: missing.join(" / "),
        manualFix: "重跑 install.mjs，或在 ~/.config/opencode/config/getbot.json 里手动加 category_overrides",
        agentInstallable: false,
      });
    } else {
      goods.push(`✓ 模型默认值：${cats.map((c) => `${c}=${cache.defaults?.[c]}`).join(", ")}`);
    }
  }

  // 4. ffmpeg / ffprobe
  const fm = checkBinary("ffmpeg");
  if (!fm.ok) {
    issues.push({
      id: "no_ffmpeg",
      title: "ffmpeg 未找到（PATH 和 C:\\ffmpeg\\bin\\ 都没有）",
      affects: "ASR（语音识别）/ TUI 语音输入",
      manualFix: process.platform === "win32"
        ? "下载 https://www.gyan.dev/ffmpeg/builds/ 解压后把 bin/ 内容放到 C:\\ffmpeg\\bin\\"
        : process.platform === "darwin" ? "brew install ffmpeg" : "sudo apt install ffmpeg",
      agentInstallable: true,
      agentPackages: ["ffmpeg"],
    });
  } else {
    goods.push(`✓ ffmpeg: ${fm.version}`);
    const fp = checkBinary("ffprobe");
    if (!fp.ok) {
      issues.push({
        id: "no_ffprobe",
        title: "ffprobe 未找到（罕见：ffmpeg 在但 ffprobe 不在）",
        affects: "ASR 大音频文件时长探测（影响是否分片，可能引发内存爆）",
        manualFix: "重装 ffmpeg 通常会带 ffprobe",
        agentInstallable: true,
        agentPackages: ["ffmpeg"],
      });
    } else {
      goods.push(`✓ ffprobe: ${fp.version}`);
    }
  }

  // 5. xclip（仅 Linux）
  if (process.platform === "linux") {
    const xc = checkBinary("xclip", ["-version"]);
    if (!xc.ok) {
      issues.push({
        id: "no_xclip",
        title: "xclip 未找到",
        affects: "TUI 语音输入识别后复制到剪贴板",
        manualFix: "sudo apt install xclip / sudo dnf install xclip",
        agentInstallable: true,
        agentPackages: ["xclip"],
      });
    } else {
      goods.push("✓ xclip 可用");
    }
  }

  // 6. 输出目录可写（取个代表性的）
  try {
    const probe = join(projectDir, ".opencode", "tmp", "doctor_probe_" + Date.now());
    mkdirSync(dirname(probe), { recursive: true });
    writeFileSync(probe, "ok");
    rmSync(probe);
    goods.push(`✓ 项目目录可写: ${projectDir}`);
  } catch (e) {
    issues.push({
      id: "no_write_perm",
      title: `项目目录不可写: ${projectDir}`,
      affects: "所有输出文件 / 日志 / 临时文件",
      manualFix: `检查 ${projectDir} 的写权限：${e.message}`,
      agentInstallable: false,
    });
  }

  return { goods, issues };
}

// 把 doctor 报告渲染成人类可读字符串，自动汇集"agent 可安装的依赖"为一段拷贝即用的提示词
function formatDoctorReport(report) {
  const lines = [];
  lines.push("============ getbot 环境诊断 ============");
  lines.push("");
  for (const g of report.goods) lines.push(g);
  lines.push("");

  if (!report.issues.length) {
    lines.push("🎉 所有依赖检查通过，可以正常使用 getbot 全部功能。");
    return lines.join("\n");
  }

  lines.push(`⚠ 发现 ${report.issues.length} 个问题：`);
  lines.push("");
  for (let i = 0; i < report.issues.length; i++) {
    const x = report.issues[i];
    lines.push(`  [${i + 1}] ${x.title}`);
    lines.push(`      影响：${x.affects}`);
    lines.push(`      手动修：${x.manualFix}`);
    lines.push("");
  }

  // 汇集 agent 可代办的包
  const installable = report.issues.filter((x) => x.agentInstallable);
  if (installable.length) {
    const pkgs = [...new Set(installable.flatMap((x) => x.agentPackages || []))];
    const platName = process.platform === "win32" ? "Windows" : process.platform === "darwin" ? "macOS" : "Linux";
    const pkgManagerHint = platName === "Windows"
      ? "winget / chocolatey / scoop"
      : platName === "macOS" ? "Homebrew" : "apt / dnf / pacman";

    lines.push("");
    lines.push("📋 ============ 复制下面这段给你的 AI 助理 ============");
    lines.push("");
    lines.push(`我正在使用 OpenCode 的 getbot 多模态插件，环境诊断检测到我的系统缺少以下依赖：`);
    for (const p of pkgs) lines.push(`- ${p}`);
    lines.push("");
    lines.push(`我的系统：${platName}（Node/Bun ${process.version}）`);
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
  }

  // 需手动处理（涉及账号/密钥的）
  const manual = report.issues.filter((x) => !x.agentInstallable);
  if (manual.length) {
    lines.push("");
    lines.push("📌 以下问题需要你**手动**处理（AI 助理无法代办 —— 涉及账号 / API Key）：");
    for (const x of manual) {
      lines.push(`  · ${x.title}`);
      lines.push(`    → ${x.manualFix}`);
    }
  }

  return lines.join("\n");
}

// ========== Markdown → A4 打印 HTML ==========
// 样式完全照搬 md2html (D:/project/工具/md2html/templates/print_template.html)

const PRINT_CSS = `
  @page { size: A4; margin: 0; }

  html, body { margin: 0; padding: 0; background: #e9ecef; }

  body {
    font-family: "SimSun", "宋体", "Microsoft YaHei", serif;
    font-size: 10.5pt;
    line-height: 1.75;
    color: #222;
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .page {
    background: #fff;
    max-width: 210mm;
    min-height: 297mm;
    margin: 20px auto;
    padding: 18mm 20mm;
    box-shadow: 0 2px 16px rgba(0,0,0,0.1);
    box-sizing: border-box;
  }

  .toolbar {
    max-width: 210mm;
    margin: 16px auto 0;
    padding: 10px 18px;
    background: #fff;
    border-radius: 4px;
    box-shadow: 0 1px 4px rgba(0,0,0,0.08);
    display: flex;
    justify-content: space-between;
    align-items: center;
    font-size: 12px;
    color: #666;
  }
  .toolbar button {
    padding: 6px 16px;
    background: #1A3C5E;
    color: #fff;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 13px;
  }
  .toolbar button:hover { background: #2B5F8A; }

  h1, h2, h3, h4, h5, h6 {
    font-family: "Microsoft YaHei", "微软雅黑", "SimHei", sans-serif;
    color: #1A3C5E;
    line-height: 1.4;
    margin: 1.2em 0 0.5em;
    page-break-after: avoid;
    break-after: avoid;
  }
  h1 {
    font-size: 22pt;
    text-align: center;
    color: #1A3C5E;
    border-bottom: 2px solid #1A3C5E;
    padding-bottom: 8px;
    margin: 0 0 16px;
  }
  h2 {
    font-size: 16pt;
    border-left: 4px solid #2B5F8A;
    padding-left: 10px;
    color: #2B5F8A;
  }
  h3 { font-size: 13pt; color: #2B5F8A; }
  h4 { font-size: 11.5pt; color: #3A6B94; }
  h5, h6 { font-size: 10.5pt; color: #555; }

  p { margin: 0.5em 0; text-align: justify; text-indent: 2em; overflow-wrap: anywhere; }
  li > p, blockquote p, td p, th p { text-indent: 0; }

  strong, b { color: #C0392B; font-weight: bold; }
  em, i { color: #555; }
  del, s { color: #999; }

  a { color: #2B5F8A; text-decoration: none; border-bottom: 1px dotted #2B5F8A; overflow-wrap: anywhere; }

  ul, ol { margin: 0.5em 0 0.5em 0; padding-left: 2em; }
  li { margin: 0.2em 0; overflow-wrap: anywhere; }
  li input[type=checkbox] { margin-right: 6px; transform: translateY(1px); }

  blockquote {
    margin: 0.8em 0;
    padding: 8px 14px;
    background: #FFF8E1;
    border-left: 4px solid #F9A825;
    color: #5D4037;
    font-family: "KaiTi", "楷体", serif;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  blockquote p { margin: 0.3em 0; }

  code {
    font-family: Consolas, "Courier New", "FangSong", "仿宋", monospace;
    background: #F5F5F5;
    padding: 1px 5px;
    border-radius: 3px;
    font-size: 0.92em;
    color: #C0392B;
  }
  pre {
    background: #F5F5F5;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 10px 14px;
    overflow-x: auto;
    max-width: 100%;
    white-space: pre;
    word-wrap: normal;
    font-size: 9.5pt;
    line-height: 1.5;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  pre code { background: transparent; padding: 0; color: #333; font-size: inherit; }

  table {
    width: 100%;
    border-collapse: collapse;
    table-layout: fixed;
    margin: 0.8em 0;
    font-size: 9.5pt;
    page-break-inside: avoid;
    break-inside: avoid;
  }
  th, td { border: 1px solid #B0BEC5; padding: 6px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; word-break: break-word; }
  th {
    background: #1A3C5E;
    color: #fff;
    font-family: "Microsoft YaHei", "SimHei", sans-serif;
    font-weight: normal;
    text-align: center;
  }
  tr:nth-child(even) td { background: #F0F4F8; }

  hr { border: none; border-top: 1px solid #B0BEC5; margin: 1.2em 0; }

  img {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 0.6em auto;
    page-break-inside: avoid;
    break-inside: avoid;
  }

  @media print {
    html, body { background: #fff; }
    .page { margin: 0; padding: 18mm 20mm; max-width: none; min-height: 0; box-shadow: none; }
    .toolbar { display: none; }
    pre, pre code { font-size: 8pt; line-height: 1.35; }
  }
`;

// 伪表格预处理：LLM 常用 Unicode 框字符 (┌─┐│├┼┤└┴┘) 或 ASCII +---+ 画表格，
// marked 识别不了会按段落渲染导致溢出。这里整段包进 ```text 围栏让它走 <pre>。
const PSEUDO_BORDER_LINE = /^\s*[│|┃┌├└┬┴┼╔╠╚╦╩╬+\-─═][\s\S]*[│|┃┐┤┘┬┴┼╗╣╝+\-─═]\s*$/;
const PSEUDO_SEP_LINE = /^\s*[─═+\-┬┴┼╦╩╬]{3,}\s*$/;
const PSEUDO_BOX_CHARS = /[│┃┌┐└┘├┤┬┴┼─═╔╗╚╝╠╣╦╩╬]/;
const PSEUDO_PLUS_BORDER = /^\s*\+[-+]+\+\s*$/;

function preprocessPseudoTables(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  const isFence = (l) => /^\s{0,3}(```|~~~)/.test(l);
  let i = 0;
  while (i < lines.length) {
    if (isFence(lines[i])) {
      out.push(lines[i++]);
      while (i < lines.length && !isFence(lines[i])) out.push(lines[i++]);
      if (i < lines.length) out.push(lines[i++]);
      continue;
    }
    let j = i, borders = 0, seps = 0;
    while (j < lines.length) {
      if (PSEUDO_SEP_LINE.test(lines[j])) { seps++; j++; }
      else if (PSEUDO_BORDER_LINE.test(lines[j])) { borders++; j++; }
      else break;
    }
    const block = lines.slice(i, j);
    const hasBox = block.some((l) => PSEUDO_BOX_CHARS.test(l) || PSEUDO_PLUS_BORDER.test(l));
    const qualifies = j - i >= 2 && borders >= 1 && (seps >= 1 || borders >= 2) && hasBox;
    if (qualifies) {
      out.push("```text");
      out.push(...block);
      out.push("```");
      i = j;
    } else {
      out.push(lines[i++]);
    }
  }
  return out.join("\n");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function safePdfFilename(name) {
  return name.replace(/[\\/:*?"<>|]/g, "_").trim() || "output";
}

// 生成 <base href="file://..."> 让 md 里的相对图片路径仍然能解析
function mdBaseHref(mdPath) {
  let dir = dirname(mdPath).replace(/\\/g, "/");
  if (!dir.startsWith("/")) dir = "/" + dir; // Windows: D:/x → /D:/x
  return "file://" + dir + "/";
}

async function convertMdToPrintHtml(mdPath, outDir) {
  const markedUrl = new URL("./marked.mjs", import.meta.url);
  const { marked } = await import(markedUrl.href);
  const mdText = readFileSync(mdPath, "utf-8");
  const bodyHtml = marked.parse(preprocessPseudoTables(mdText), { breaks: true, gfm: true });
  const title = basename(mdPath, extname(mdPath));
  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<base href="${mdBaseHref(mdPath)}">
<title>${escapeHtml(title)}</title>
<style>${PRINT_CSS}</style>
</head>
<body>

<div class="toolbar">
  <div style="color:#888;">提示：打印 PDF 时如仍显示页眉页脚，请在打印对话框"更多设置"中取消勾选"页眉和页脚"。</div>
  <button onclick="window.print()">打印 / 另存为 PDF</button>
</div>

<div class="page">
${bodyHtml}
</div>

</body>
</html>
`;
  const outPath = join(outDir, `${safePdfFilename(title)}_${nowStamp()}.html`);
  writeFileSync(outPath, html, "utf-8");
  return outPath;
}

function openInBrowser(filePath) {
  try {
    if (process.platform === "win32") {
      spawn("cmd", ["/c", "start", "", filePath], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "darwin") {
      spawn("open", [filePath], { detached: true, stdio: "ignore" }).unref();
    } else {
      spawn("xdg-open", [filePath], { detached: true, stdio: "ignore" }).unref();
    }
    return true;
  } catch {
    return false;
  }
}

// ========== ffmpeg 录音 / 切片 ==========

// opts.timeoutMs 默认无超时；调用方应按场景显式传值（录音/分片用 duration + 余量）
function runCmd(cmd, args, opts = {}) {
  const { timeoutMs, ...spawnOpts } = opts;
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: ffmpegEnv(), ...spawnOpts });
    const out = [], err = [];
    let timedOut = false;
    let timer = null;
    if (timeoutMs && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        // Windows 上 SIGKILL 等效；先 SIGTERM 给个机会，再 SIGKILL 兜底
        try { proc.kill("SIGTERM"); } catch {}
        setTimeout(() => { try { proc.kill("SIGKILL"); } catch {} }, 2000);
      }, timeoutMs);
    }
    proc.stdout?.on("data", (d) => out.push(Buffer.from(d)));
    proc.stderr?.on("data", (d) => err.push(Buffer.from(d)));
    proc.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      const stdout = Buffer.concat(out).toString("utf-8");
      const stderr = Buffer.concat(err).toString("utf-8");
      if (timedOut) reject(new Error(`${cmd} 超时（${timeoutMs}ms 未结束），已强制终止: ${stderr.slice(0, 400)}`));
      else if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} failed (code ${code}${signal ? `, signal ${signal}` : ""}): ${stderr.slice(0, 500)}`));
    });
    proc.on("error", (e) => {
      if (timer) clearTimeout(timer);
      reject(e);
    });
  });
}

function detectWindowsMicDevice() {
  try {
    const r = spawnSync("ffmpeg", ["-list_devices", "true", "-f", "dshow", "-i", "dummy"], { env: ffmpegEnv(), encoding: "utf-8" });
    const out = (r.stderr || "") + (r.stdout || "");
    const audioSection = out.split(/DirectShow audio devices/i)[1] || "";
    const m = audioSection.match(/"([^"]+)"/);
    if (m) return m[1];
  } catch {}
  return "麦克风";
}

async function recordAudio(outputPath, durationSec = 30) {
  const args = ["-y"];
  if (process.platform === "win32") {
    const device = detectWindowsMicDevice();
    args.push("-f", "dshow", "-i", `audio=${device}`);
  } else if (process.platform === "darwin") {
    args.push("-f", "avfoundation", "-i", ":0");
  } else {
    args.push("-f", "alsa", "-i", "default");
  }
  args.push("-t", String(durationSec), "-ar", "16000", "-ac", "1", outputPath);
  // 录音超时 = duration + 10 秒余量；防止 ffmpeg 被设备占用永远不退出
  await runCmd("ffmpeg", args, { timeoutMs: (durationSec + 10) * 1000 });
  return outputPath;
}

async function probeDurationSec(audioPath) {
  try {
    const r = await runCmd("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath], { timeoutMs: 10000 });
    const sec = parseFloat(r.stdout.trim());
    return Number.isFinite(sec) ? sec : null;
  } catch { return null; }
}

async function splitAudio(audioPath, chunkSec, outDir) {
  mkdirSync(outDir, { recursive: true });
  const pattern = join(outDir, "chunk_%03d.wav");
  // 分片转码：1 小时音频实测约 30 秒，给 5 分钟超时
  await runCmd("ffmpeg", [
    "-y", "-i", audioPath,
    "-f", "segment", "-segment_time", String(chunkSec),
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    pattern,
  ], { timeoutMs: 300000 });
  const glob = [];
  let i = 0;
  while (true) {
    const p = join(outDir, `chunk_${String(i).padStart(3, "0")}.wav`);
    if (!existsSync(p)) break;
    glob.push(p); i++;
  }
  return glob;
}

// ========== 剪贴板 ==========

async function copyToClipboard(text) {
  const plat = process.platform;
  if (plat === "win32") {
    await new Promise((resolve, reject) => {
      const p = spawn("clip", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("close", () => resolve());
      p.stdin.write(text, "utf-8");
      p.stdin.end();
    });
  } else if (plat === "darwin") {
    await new Promise((resolve, reject) => {
      const p = spawn("pbcopy", [], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("close", () => resolve());
      p.stdin.write(text, "utf-8");
      p.stdin.end();
    });
  } else {
    await new Promise((resolve, reject) => {
      const p = spawn("xclip", ["-selection", "clipboard"], { stdio: ["pipe", "ignore", "ignore"] });
      p.on("error", reject);
      p.on("close", () => resolve());
      p.stdin.write(text, "utf-8");
      p.stdin.end();
    });
  }
}

// ========== Server Plugin：4 个工具 ==========

export const GetbotPlugin = async ({ directory }) => {
  const projectDir = directory || process.cwd();

  return {
    tool: {
      getbot_image: tool({
        description: "使用 getbot.me 文生图模型生成图片。用户通过 /getbot-image <描述> 触发；prompt 为中文或英文描述。",
        args: {
          prompt: tool.schema.string().describe("图片内容描述"),
          size: tool.schema.string().optional().describe("图片尺寸，默认 1024x1024"),
          n: tool.schema.number().default(1).describe("生成数量"),
          model: tool.schema.string().optional().describe("强制指定模型 ID（默认使用 getbot-models.json 中的 defaults.image）"),
        },
        async execute(args) {
          const config = loadConfig(projectDir);
          const ctx = newLogContext(projectDir, "getbot_image", args, config);
          try {
            const cache = loadCache(projectDir);
            const apiKey = await requireKey(projectDir);
            const model = args.model || resolveDefault(cache, "image", null, config);
            if (!model) {
              ctx.error = "未配置文生图模型";
              return "错误：未配置文生图模型。请先运行 install.mjs（如已运行过 /getbot-doctor 获取详细诊断）";
            }
            const outDir = resolveOutputDir(projectDir, config, "image", "getbot.me/image");
            ctx.resolved = {
              model,
              size: args.size || config?.defaults?.image_size || "1024x1024",
              n: args.n || 1,
              outDir,
            };

            const { urls } = await callImage(apiKey, config, { model, prompt: args.prompt, size: args.size, n: args.n }, ctx);
            if (!urls.length) {
              ctx.error = "API 未返回图片";
              return "生成失败：API 未返回图片";
            }
            const saved = [];
            for (let i = 0; i < urls.length; i++) {
              const u = urls[i];
              const stamp = nowStamp();
              const name = urls.length === 1 ? `${stamp}.png` : `${stamp}_${i + 1}.png`;
              const dest = join(outDir, name);
              if (/^https?:/.test(u)) await downloadTo(u, dest);
              else if (u.startsWith("data:")) writeBase64To(u.split(",")[1], dest);
              else writeBase64To(u, dest);
              saved.push({ path: dest, bytes: statSync(dest).size, sha256: sha256File(dest) });
            }
            ctx.outputs = saved;
            ctx.ok = true;
            return `已生成 ${saved.length} 张图片（model=${model}）：\n${saved.map((s) => s.path).join("\n")}`;
          } catch (e) {
            ctx.error = e.message;
            return `文生图失败：${e.message}`;
          } finally {
            finishLog(ctx);
          }
        },
      }),

      getbot_tts: tool({
        description: "使用 getbot.me TTS 模型将文字合成语音（走 /v1/audio/speech，返回 WAV）。voice 有默认值，调用时只需提供 text 即可，不要向用户询问。如不传 text 或 text 为空字符串，则不合成、直接返回可用音色列表给用户参考。",
        args: {
          text: tool.schema.string().optional().describe("要合成的文本，≤2000 字，中英皆可。留空则改为返回音色列表"),
          voice: tool.schema.string().optional().describe("音色名。不传则使用配置文件中的默认值（Qwen TTS 有效音色：Cherry/Ethan/Serena/Chelsie；也支持 alloy/echo 等 OpenAI 音色）"),
          model: tool.schema.string().optional().describe("强制指定模型 ID"),
        },
        async execute(args) {
          const config = loadConfig(projectDir);
          const ctx = newLogContext(projectDir, "getbot_tts", args, config);
          try {
            const cache = loadCache(projectDir);

            const text = (args.text || "").trim();
            if (!text) {
              const defaultVoice = config?.defaults?.tts_voice || "Cherry";
              const ttsModel = resolveDefault(cache, "tts", null, config) || "（无可用模型）";
              const lines = [
                `getbot TTS 可用音色（模型：${ttsModel}）：`,
                ...TTS_VOICES.map((v) => `  - ${v}${v === defaultVoice ? "  ← 默认" : ""}`),
                "",
                "用法：",
                `  /getbot-tts 今天天气真好         （用默认音色 ${defaultVoice}）`,
                `  对话中说 "用 Ethan 念：你好"   （指定音色）`,
              ];
              ctx.resolved = { mode: "list_voices", model: ttsModel };
              ctx.ok = true;
              return lines.join("\n");
            }

            const apiKey = await requireKey(projectDir);
            const model = args.model || resolveDefault(cache, "tts", null, config);
            if (!model) {
              ctx.error = "未配置 TTS 模型";
              return "错误：未配置 TTS 模型。请先运行 install.mjs（如已运行过 /getbot-doctor 获取详细诊断）";
            }
            const outDir = resolveOutputDir(projectDir, config, "audio", "getbot.me/audio");
            ctx.resolved = {
              model,
              voice: args.voice || config?.defaults?.tts_voice || "Cherry",
              textLength: text.length,
              outDir,
            };

            const buf = await callTTS(apiKey, config, { model, text, voice: args.voice }, ctx);
            const dest = join(outDir, `${nowStamp()}.wav`);
            writeFileSync(dest, buf);
            const size = statSync(dest).size;
            ctx.outputs = [{ path: dest, bytes: size, sha256: sha256File(dest) }];
            ctx.ok = true;
            return `已生成语音（model=${model}, ${(size / 1024).toFixed(1)}KB）：\n${dest}`;
          } catch (e) {
            ctx.error = e.message;
            return `语音合成失败：${e.message}`;
          } finally {
            finishLog(ctx);
          }
        },
      }),

      getbot_asr: tool({
        description: "使用 getbot.me ASR 模型将音频文件转录为文字。超过 4 分钟自动切片。用户通过 /getbot-asr <文件路径> 触发。",
        args: {
          filePath: tool.schema.string().describe("音频文件路径"),
          language: tool.schema.string().default("zh").describe("语音语言代码"),
          model: tool.schema.string().optional().describe("强制指定模型 ID"),
        },
        async execute(args) {
          const config = loadConfig(projectDir);
          const ctx = newLogContext(projectDir, "getbot_asr", args, config);
          // 120s + 32kbps mp3 ≈ 480KB，base64 后仍在 1MB Nginx 限制内
          const MAX_CHUNK_SEC = 120;
          const tmpBase = join(projectDir, ".opencode", "tmp", "getbot_asr_" + Date.now());
          try {
            const cache = loadCache(projectDir);
            const apiKey = await requireKey(projectDir);
            const model = args.model || resolveDefault(cache, "asr", null, config);
            if (!model) {
              ctx.error = "未配置 ASR 模型";
              return "错误：未配置 ASR 模型。请先运行 install.mjs（如已运行过 /getbot-doctor 获取详细诊断）";
            }
            if (!existsSync(args.filePath)) {
              ctx.error = `文件不存在: ${args.filePath}`;
              return `错误：文件不存在 - ${args.filePath}`;
            }

            const mdOutDir = resolveOutputDir(projectDir, config, "md", "getbot.me/md");
            const audioBase = safePdfFilename(basename(args.filePath, extname(args.filePath)));
            const outMd = join(mdOutDir, `${audioBase}_${nowStamp()}.md`);
            ctx.resolved = {
              model,
              inputFile: args.filePath,
              inputBytes: statSync(args.filePath).size,
              outMd,
            };

            const dur = await probeDurationSec(args.filePath);
            ctx.resolved.audioDurationSec = dur;
            let chunks;
            if (dur && dur > MAX_CHUNK_SEC) {
              chunks = await splitAudio(args.filePath, MAX_CHUNK_SEC, tmpBase);
            } else {
              chunks = [args.filePath];
            }
            ctx.resolved.chunkCount = chunks.length;

            // 分片中途失败：保留已成功部分，落盘 md，并在文件 + 返回串里明确标注失败位置
            const parts = [];
            let failedAt = -1;
            let failureMsg = null;
            for (let i = 0; i < chunks.length; i++) {
              try {
                const txt = await callTranscription(apiKey, config, {
                  model, audioPath: chunks[i], language: args.language,
                  tmpDir: join(tmpBase, `compact_${i}`),
                }, ctx);
                parts.push(txt);
              } catch (e) {
                failedAt = i;
                failureMsg = e.message;
                break;
              }
            }

            const isPartial = failedAt >= 0;
            const full = parts.join("\n");
            const statusBlock = isPartial
              ? `> **⚠ 部分失败**：第 ${failedAt + 1}/${chunks.length} 片转录失败，下方仅为前 ${parts.length} 片内容\n> **失败原因**：${failureMsg}`
              : `> **完整转录**`;
            const mdBody = `# ${audioBase} 转录结果\n\n${statusBlock}\n> 源音频：${args.filePath}\n> 模型：${model}\n> 分片数：${chunks.length}\n\n${full}\n`;
            // 至少有一片成功时才写文件；全失败就只记日志、不留垃圾文件
            if (parts.length > 0) {
              writeFileSync(outMd, mdBody, "utf-8");
              ctx.outputs = [{
                path: outMd,
                bytes: statSync(outMd).size,
                sha256: sha256File(outMd),
                transcriptLength: full.length,
                partial: isPartial,
                successChunks: parts.length,
                totalChunks: chunks.length,
                failedAt: isPartial ? failedAt : null,
              }];
            } else {
              ctx.outputs = [];
            }

            if (isPartial) {
              ctx.error = `分片 ${failedAt + 1}/${chunks.length} 失败：${failureMsg}（已保留前 ${parts.length} 片）`;
              return parts.length > 0
                ? `转录部分失败（${parts.length}/${chunks.length} 片成功）\n失败原因：${failureMsg}\n已保存部分结果至: ${outMd}\n\n${full}`
                : `转录失败：第 1 片即失败 - ${failureMsg}`;
            }

            ctx.ok = true;
            return `转录完成（model=${model}, 分片=${chunks.length}）\n结果保存至: ${outMd}\n\n${full}`;
          } catch (e) {
            ctx.error = e.message;
            return `转录失败：${e.message}`;
          } finally {
            try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
            finishLog(ctx);
          }
        },
      }),

      getbot_translate: tool({
        description: "使用 getbot.me 翻译模型（qwen-mt-plus/turbo）在中英之间互译。用户通过 /getbot-translate <文本> 触发。不传 target_lang 时按输入主语言自动判断：含中文→英文，否则→中文。",
        args: {
          text: tool.schema.string().describe("要翻译的原文"),
          target_lang: tool.schema.string().optional().describe("目标语言：zh / en / Chinese / English；留空则按原文自动判断方向"),
          source_lang: tool.schema.string().optional().describe("源语言提示（可留空）"),
          model: tool.schema.string().optional().describe("强制指定模型 ID，默认 qwen-mt-turbo"),
        },
        async execute(args) {
          const config = loadConfig(projectDir);
          const ctx = newLogContext(projectDir, "getbot_translate", args, config);
          try {
            const cache = loadCache(projectDir);
            const apiKey = await requireKey(projectDir);
            const model = args.model || resolveDefault(cache, "translate", "qwen-mt-turbo", config);
            if (!model) {
              ctx.error = "未配置翻译模型";
              return "错误：未配置翻译模型。请先运行 install.mjs";
            }
            const text = (args.text || "").trim();
            if (!text) {
              ctx.error = "text 为空";
              return "错误：text 不能为空";
            }
            const target = args.target_lang || (/[一-鿿]/.test(text) ? "English" : "Chinese");
            ctx.resolved = {
              model,
              source_lang: args.source_lang || null,
              target_lang: normalizeLang(target),
              inputLength: text.length,
            };

            const out = await callTranslate(apiKey, config, {
              model, text, sourceLang: args.source_lang, targetLang: target,
            }, ctx);
            if (!out) {
              ctx.error = "模型未返回内容";
              return "翻译失败：模型未返回内容";
            }
            ctx.outputs = [{ text: out, length: out.length }];
            ctx.ok = true;
            return `[${model} → ${normalizeLang(target)}]\n${out}`;
          } catch (e) {
            ctx.error = e.message;
            return `翻译失败：${e.message}`;
          } finally {
            finishLog(ctx);
          }
        },
      }),

      getbot_md2html: tool({
        description: "把 Markdown 文件转成 A4 打印样式的 HTML 并自动用默认浏览器打开。如果用户需要 PDF，在浏览器里按 Ctrl+P（macOS：Cmd+P）→ '另存为 PDF' 即可。用户通过 /getbot-md2html <md 文件路径> 触发。",
        args: {
          filePath: tool.schema.string().describe("Markdown 文件路径，支持 .md / .markdown / .txt；相对路径基于当前项目目录"),
        },
        async execute(args) {
          const config = loadConfig(projectDir);
          const ctx = newLogContext(projectDir, "getbot_md2html", args, config);
          try {
            let mdPath = (args.filePath || "").trim().replace(/^["']|["']$/g, "");
            if (!mdPath) {
              ctx.error = "filePath 为空";
              return "错误：请提供 Markdown 文件路径";
            }
            if (!/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(mdPath)) mdPath = join(projectDir, mdPath);
            if (!existsSync(mdPath)) {
              ctx.error = `文件不存在: ${mdPath}`;
              return `错误：文件不存在 - ${mdPath}`;
            }
            if (statSync(mdPath).isDirectory()) {
              ctx.error = `路径是目录: ${mdPath}`;
              return `错误：路径是目录 - ${mdPath}`;
            }
            const ext = extname(mdPath).toLowerCase();
            if (![".md", ".markdown", ".txt"].includes(ext)) {
              ctx.error = `不支持的文件类型 ${ext}`;
              return `错误：不支持的文件类型 ${ext}（仅 .md / .markdown / .txt）`;
            }

            const outDir = resolveOutputDir(projectDir, config, "html", "getbot.me/html");
            ctx.resolved = { mdPath, mdBytes: statSync(mdPath).size, outDir };

            const outPath = await convertMdToPrintHtml(mdPath, outDir);
            const opened = openInBrowser(outPath);
            ctx.outputs = [{
              path: outPath,
              bytes: statSync(outPath).size,
              sha256: sha256File(outPath),
              opened,
            }];
            ctx.ok = true;
            const tip = opened
              ? "已用默认浏览器打开。如需 PDF，按 Ctrl+P（macOS：Cmd+P）→ 另存为 PDF 即可。"
              : "自动打开浏览器失败，请手动双击该 HTML。";
            return `已生成打印排版 HTML：\n${outPath}\n\n${tip}`;
          } catch (e) {
            ctx.error = e.message;
            return `转换失败：${e.message}`;
          } finally {
            finishLog(ctx);
          }
        },
      }),

      getbot_doctor: tool({
        description: "诊断 getbot 插件运行环境。检查 Node、API Key、模型缓存、ffmpeg/ffprobe、xclip（Linux）、写权限等依赖，对每个缺失项给出修复办法；同时把'AI 助理可代办的依赖安装'整合成一段拷贝即用的提示词。用户通过 /getbot-doctor 触发。",
        args: {},
        async execute() {
          const config = loadConfig(projectDir);
          const ctx = newLogContext(projectDir, "getbot_doctor", {}, config);
          try {
            const report = runDoctor(projectDir, config);
            ctx.resolved = {
              goodCount: report.goods.length,
              issueCount: report.issues.length,
              issueIds: report.issues.map((i) => i.id),
            };
            ctx.outputs = [{
              issues: report.issues.map((i) => ({ id: i.id, title: i.title, affects: i.affects, agentInstallable: i.agentInstallable })),
            }];
            ctx.ok = report.issues.length === 0;
            return formatDoctorReport(report);
          } catch (e) {
            ctx.error = e.message;
            return `诊断失败：${e.message}`;
          } finally {
            finishLog(ctx);
          }
        },
      }),

      getbot_logs: tool({
        description: "返回 getbot 插件调用日志所在路径，并可选自动用系统文件管理器打开日志文件夹。排查问题时把日志发给开发者即可。用户通过 /getbot-logs 触发。",
        args: {
          open: tool.schema.boolean().optional().describe("是否自动用系统文件管理器打开日志文件夹"),
        },
        async execute(args) {
          const dir = logDir();
          const today = logFilePath();
          try { mkdirSync(dir, { recursive: true }); } catch {}
          const todayExists = existsSync(today);
          const todaySize = todayExists ? statSync(today).size : 0;
          let opened = null;
          if (args.open) opened = openInBrowser(dir);

          const lines = [
            "getbot 调用日志（每天一个文件，每行一次工具调用）",
            "",
            `日志文件夹：${dir}`,
            `今日日志：${today}` + (todayExists ? `（${(todaySize / 1024).toFixed(1)}KB）` : "（暂无，调用一次工具后自动生成）"),
          ];
          if (args.open) {
            lines.push("");
            lines.push(opened ? "已尝试用系统文件管理器打开日志文件夹。" : "自动打开失败，请手动复制上面的路径打开。");
          }
          lines.push("");
          lines.push("排查时把今日日志文件发给开发者，单行 JSON 即可定位 args/请求体/响应头/输出 hash 等关键证据。");
          return lines.join("\n");
        },
      }),
    },
  };
};

// ========== TUI Plugin：命令面板 + 快捷键 ==========

const CATEGORY_LABELS = {
  image: "文生图",
  tts: "语音合成",
  asr: "语音识别",
  translate: "翻译",
};

export const tui = async (api) => {
  const { ui, kv, state, command, lifecycle } = api;
  const projectDir = state.path.directory;

  let cache = loadCache(projectDir);
  let config = loadConfig(projectDir);

  // 把缓存里的 defaults 同步进 kv，kv 优先级更高
  const CATS = ["image", "tts", "asr", "translate"];
  for (const cat of CATS) {
    const saved = kv.get(`getbot.model.${cat}`, null);
    if (!saved) {
      const def = resolveDefault(cache, cat, null, config);
      if (def) kv.set(`getbot.model.${cat}`, def);
    }
  }

  const apiKey = loadApiKey(projectDir);
  if (!apiKey) {
    ui.toast({ variant: "warning", title: "getbot", message: "未配置 GETBOT_API_KEY。运行 /getbot-doctor 查看完整修复指引" });
  }

  const missingCats = CATS.filter((c) => !resolveDefault(cache, c, null, config) && !kv.get(`getbot.model.${c}`));
  if (missingCats.length && cache) {
    ui.toast({ variant: "warning", title: "getbot", message: `缺分类模型：${missingCats.join(", ")}。运行 /getbot-doctor 查看修复指引` });
  }

  // 启动时静默查 ffmpeg：缺了不致命但语音相关全废，提示用户跑 /getbot-doctor
  try {
    if (!checkBinary("ffmpeg").ok) {
      ui.toast({ variant: "info", title: "getbot", message: "未检测到 ffmpeg —— 语音功能将受限。/getbot-doctor 获取自动安装指引" });
    }
  } catch {}

  const switchModel = (cat, modelId) => {
    kv.set(`getbot.model.${cat}`, modelId);
    if (cache) {
      cache.defaults = cache.defaults || {};
      cache.defaults[cat] = modelId;
      try { saveCache(projectDir, cache); } catch {}
    }
    ui.toast({ variant: "success", title: "getbot", message: `${CATEGORY_LABELS[cat]} 已切换到: ${modelId}` });
  };

  // 语音输入
  let recording = false;
  const voiceInput = async () => {
    if (recording) {
      ui.toast({ variant: "info", title: "getbot 语音", message: "正在录音中" });
      return;
    }
    if (!apiKey) {
      ui.toast({ variant: "error", title: "getbot 语音", message: "未配置 GETBOT_API_KEY" });
      return;
    }
    const asrModel = kv.get("getbot.model.asr", null) || resolveDefault(cache, "asr", null, config);
    if (!asrModel) {
      ui.toast({ variant: "error", title: "getbot 语音", message: "未找到 ASR 模型" });
      return;
    }

    const duration = config?.voice_input?.duration_sec || 30;
    const language = config?.voice_input?.language || "zh";
    const tmpDir = join(projectDir, ".opencode", "tmp", "getbot_voice");
    const wav = join(tmpDir, `rec_${Date.now()}.wav`);

    const ctx = newLogContext(projectDir, "tui_voice_input", { duration, language }, config);
    ctx.resolved = { asrModel, wav };

    // 锁必须在 try 内获取，确保 finally 一定能 reset；mkdirSync/toast 也包进 try 防止异常导致锁残留
    recording = true;
    try {
      mkdirSync(tmpDir, { recursive: true });
      ui.toast({ variant: "info", title: "getbot 语音", message: `开始录音 ${duration} 秒...` });
      await recordAudio(wav, duration);
      try { ctx.resolved.recordedBytes = statSync(wav).size; } catch {}
      const text = await callTranscription(apiKey, config, { model: asrModel, audioPath: wav, language }, ctx);
      const trimmed = (text || "").trim();
      ctx.outputs = [{ transcript: trimmed, length: trimmed.length }];
      if (!trimmed) {
        ctx.error = "未识别到内容";
        ui.toast({ variant: "warning", title: "getbot 语音", message: "未识别到内容" });
        return;
      }
      try {
        await copyToClipboard(trimmed);
        const preview = trimmed.length > 40 ? trimmed.slice(0, 40) + "..." : trimmed;
        ui.toast({ variant: "success", title: "getbot 语音", message: `已复制到剪贴板，按 Ctrl+V 粘贴：${preview}` });
        ctx.ok = true;
      } catch (e) {
        ctx.error = `clipboard: ${e.message}`;
        ui.toast({ variant: "warning", title: "getbot 语音", message: `识别完成但剪贴板失败：${trimmed.slice(0, 50)}` });
      }
    } catch (e) {
      ctx.error = e.message;
      if (/ffmpeg/i.test(e.message)) {
        const hint = process.platform === "win32"
          ? "winget install Gyan.FFmpeg"
          : process.platform === "darwin" ? "brew install ffmpeg" : "apt install ffmpeg";
        ui.toast({ variant: "error", title: "getbot 语音", message: `ffmpeg 失败：${hint}` });
      } else {
        ui.toast({ variant: "error", title: "getbot 语音", message: e.message });
      }
    } finally {
      recording = false;
      try { rmSync(wav); } catch {}
      finishLog(ctx);
    }
  };

  // 刷新模型列表（重新读缓存；实际拉取请重跑 install.mjs）
  const refreshCache = () => {
    cache = loadCache(projectDir);
    config = loadConfig(projectDir);
    const counts = cache ? CATS.map((c) => `${c}×${(cache.categorized?.[c] || []).length}`).join(" ") : "缓存不存在";
    ui.toast({ variant: "info", title: "getbot", message: `模型缓存已刷新：${counts}` });
  };

  const unregister = command.register(() => {
    const cmds = [];

    cmds.push({
      title: "getbot: 刷新模型列表（重新读缓存）",
      value: "getbot:refresh",
      description: "重新读取 .opencode/cache/getbot-models.json。若需从 API 拉取请重跑 install.mjs",
      category: "getbot",
      onSelect: () => refreshCache(),
    });

    cmds.push({
      title: "getbot: 打开调用日志文件夹",
      value: "getbot:logs",
      description: `${logDir()} —— 排查问题时把今日日志发给开发者`,
      category: "getbot",
      onSelect: () => {
        try { mkdirSync(logDir(), { recursive: true }); } catch {}
        const ok = openInBrowser(logDir());
        ui.toast({
          variant: ok ? "info" : "warning",
          title: "getbot",
          message: ok ? `已打开 ${logDir()}` : `打开失败，请手动访问 ${logDir()}`,
        });
      },
    });

    cmds.push({
      title: "语音输入（getbot ASR）",
      value: "getbot:voice",
      description: `录音 ${config?.voice_input?.duration_sec || 30} 秒 → 转文字 → 复制到剪贴板`,
      category: "getbot",
      keybind: config?.voice_input?.keybind || "ctrl+shift+v",
      onSelect: () => { voiceInput(); },
    });

    for (const cat of CATS) {
      const list = cache?.categorized?.[cat] || [];
      const current = kv.get(`getbot.model.${cat}`, resolveDefault(cache, cat, null, config));
      for (const m of list) {
        const isCurrent = m === current;
        cmds.push({
          title: `${isCurrent ? "✓ " : ""}选择【${CATEGORY_LABELS[cat]}】模型: ${m}`,
          value: `getbot:model:${cat}:${m}`,
          description: `将 ${CATEGORY_LABELS[cat]} 默认模型切换为 ${m}`,
          category: `getbot - ${CATEGORY_LABELS[cat]}`,
          onSelect: () => switchModel(cat, m),
        });
      }
    }

    return cmds;
  });

  lifecycle.onDispose(() => { try { unregister(); } catch {} });
};
