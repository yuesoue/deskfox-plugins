/**
 * OpenCode getbot.me 插件
 *
 * 双导出：
 *   - GetbotPlugin (server)：4 个多模态工具
 *     getbot_image / getbot_tts / getbot_asr / getbot_md2html
 *   - tui：命令面板条目（切换各模态默认模型、刷新模型列表） + Ctrl+Shift+V 语音输入
 *
 * 使用前请先运行：node .opencode/scripts/setup-getbot.mjs [sk-xxxx]
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, basename, extname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { tool } from "@opencode-ai/plugin";

// ========== 通用工具 ==========

const DEFAULT_BASE_URL = "https://api.getbot.me/v1";
const GLOBAL_OC_DIR = join(homedir(), ".config", "opencode");

function stripJsoncComments(text) {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:\\])\/\/.*$/gm, "$1");
}

function readGlobalOcConfig() {
  for (const name of ["opencode.jsonc", "opencode.json"]) {
    const p = join(GLOBAL_OC_DIR, name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf-8");
    try { return JSON.parse(raw); } catch {}
    try { return JSON.parse(stripJsoncComments(raw)); } catch {}
  }
  return null;
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
  // 3. OpenCode 全局配置里的 provider.getbot.options.apiKey（install.mjs 安装后）
  const oc = readGlobalOcConfig();
  const k = oc?.provider?.getbot?.options?.apiKey;
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
  if (!key) throw new Error("未找到 GETBOT_API_KEY：请运行安装脚本（install.mjs）或在 .env 中配置 GETBOT_API_KEY");
  return key;
}

// ========== API 调用 ==========

async function apiPostJson(url, apiKey, body) {
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} at ${url}: ${text.slice(0, 400)}`);
  }
  return resp;
}

async function callImage(apiKey, cfg, { model, prompt, size, n }) {
  const url = baseURL(cfg).replace(/\/$/, "") + "/images/generations";
  const resp = await apiPostJson(url, apiKey, {
    model, prompt,
    size: size || cfg?.defaults?.image_size || "1024x1024",
    n: n || cfg?.defaults?.image_n || 1,
  });
  const data = await resp.json();
  const items = data.data || data.images || [];
  const urls = items.map((it) => it.url || it.image_url || it.b64_json).filter(Boolean);
  return { urls, raw: data };
}

// getbot.me 2026-04 服务端调整后：TTS 走标准 OpenAI /v1/audio/speech 端点
// 返回 16-bit PCM mono 24kHz WAV 字节流；不再支持 chat/completions 路径
async function callTTS(apiKey, cfg, { model, text, voice }) {
  const url = baseURL(cfg).replace(/\/$/, "") + "/audio/speech";
  const actualVoice = voice || cfg?.defaults?.tts_voice || "Cherry";
  const body = { model, input: text, voice: actualVoice };
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      Accept: "audio/*",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`HTTP ${resp.status} at ${url}: ${errText.slice(0, 500)}`);
  }
  const ct = resp.headers.get("content-type") || "";
  if (!/^audio\//i.test(ct)) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`预期 audio/*，实际 ${ct}：${errText.slice(0, 400)}`);
  }
  return Buffer.from(await resp.arrayBuffer());
}

// ASR 前先把任意格式音频转成 16kHz/mono/32kbps mp3，大幅压小避开 Nginx 上传限制
async function compactAudioForAsr(inputPath, tmpDir) {
  let size = 0;
  try { size = statSync(inputPath).size; } catch {}
  // 已经是小 mp3 就不转码
  if (size > 0 && size < 200 * 1024 && /\.mp3$/i.test(inputPath)) return { path: inputPath, created: false };
  mkdirSync(tmpDir, { recursive: true });
  const out = join(tmpDir, `asr_${Date.now()}.mp3`);
  await runCmd("ffmpeg", [
    "-y", "-i", inputPath,
    "-vn", "-ar", "16000", "-ac", "1", "-b:a", "32k",
    out,
  ]);
  return { path: out, created: true };
}

// getbot.me 没有 /v1/audio/transcriptions，走 chat/completions 的 input_audio 多模态消息
async function callTranscription(apiKey, cfg, { model, audioPath, language, tmpDir }) {
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
    const resp = await apiPostJson(url, apiKey, body);
    const data = await resp.json();
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

async function downloadTo(url, destPath) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`下载失败 HTTP ${resp.status}: ${url}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  writeFileSync(destPath, buf);
  return destPath;
}

function writeBase64To(b64, destPath) {
  writeFileSync(destPath, Buffer.from(b64, "base64"));
  return destPath;
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

function runCmd(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { env: ffmpegEnv(), ...opts });
    const out = [], err = [];
    proc.stdout?.on("data", (d) => out.push(Buffer.from(d)));
    proc.stderr?.on("data", (d) => err.push(Buffer.from(d)));
    proc.on("close", (code) => {
      const stdout = Buffer.concat(out).toString("utf-8");
      const stderr = Buffer.concat(err).toString("utf-8");
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} failed (code ${code}): ${stderr.slice(0, 500)}`));
    });
    proc.on("error", (e) => reject(e));
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
  await runCmd("ffmpeg", args);
  return outputPath;
}

async function probeDurationSec(audioPath) {
  try {
    const r = await runCmd("ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", audioPath]);
    const sec = parseFloat(r.stdout.trim());
    return Number.isFinite(sec) ? sec : null;
  } catch { return null; }
}

async function splitAudio(audioPath, chunkSec, outDir) {
  mkdirSync(outDir, { recursive: true });
  const pattern = join(outDir, "chunk_%03d.wav");
  await runCmd("ffmpeg", [
    "-y", "-i", audioPath,
    "-f", "segment", "-segment_time", String(chunkSec),
    "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le",
    pattern,
  ]);
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
          const cache = loadCache(projectDir);
          const apiKey = await requireKey(projectDir).catch((e) => { throw e; });
          const model = args.model || resolveDefault(cache, "image", null, config);
          if (!model) return "错误：未配置文生图模型。请先运行 install.mjs 或 setup-getbot.mjs";
          const outDir = resolveOutputDir(projectDir, config, "image", "getbot.me/image");

          try {
            const { urls } = await callImage(apiKey, config, { model, prompt: args.prompt, size: args.size, n: args.n });
            if (!urls.length) return "生成失败：API 未返回图片";
            const saved = [];
            for (let i = 0; i < urls.length; i++) {
              const u = urls[i];
              const stamp = nowStamp();
              const name = urls.length === 1 ? `${stamp}.png` : `${stamp}_${i + 1}.png`;
              const dest = join(outDir, name);
              if (/^https?:/.test(u)) await downloadTo(u, dest);
              else if (u.startsWith("data:")) writeBase64To(u.split(",")[1], dest);
              else writeBase64To(u, dest);
              saved.push(dest);
            }
            return `已生成 ${saved.length} 张图片（model=${model}）：\n${saved.join("\n")}`;
          } catch (e) {
            return `文生图失败：${e.message}`;
          }
        },
      }),

      getbot_tts: tool({
        description: "使用 getbot.me TTS 模型将文字合成语音（走 /v1/audio/speech，返回 WAV）。voice 有默认值，调用时只需提供 text 即可，不要向用户询问。",
        args: {
          text: tool.schema.string().describe("要合成的文本，≤2000 字，中英皆可"),
          voice: tool.schema.string().optional().describe("音色名。不传则使用配置文件中的默认值（Qwen TTS 有效音色：Cherry/Ethan/Serena/Chelsie 等；也支持 alloy/echo 等 OpenAI 音色）"),
          model: tool.schema.string().optional().describe("强制指定模型 ID"),
        },
        async execute(args) {
          const config = loadConfig(projectDir);
          const cache = loadCache(projectDir);
          const apiKey = await requireKey(projectDir);
          const model = args.model || resolveDefault(cache, "tts", null, config);
          if (!model) return "错误：未配置 TTS 模型。请先运行 install.mjs 或 setup-getbot.mjs";
          const outDir = resolveOutputDir(projectDir, config, "audio", "getbot.me/audio");

          try {
            const buf = await callTTS(apiKey, config, { model, text: args.text, voice: args.voice });
            const dest = join(outDir, `${nowStamp()}.wav`);
            writeFileSync(dest, buf);
            const size = statSync(dest).size;
            return `已生成语音（model=${model}, ${(size / 1024).toFixed(1)}KB）：\n${dest}`;
          } catch (e) {
            return `语音合成失败：${e.message}`;
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
          const cache = loadCache(projectDir);
          const apiKey = await requireKey(projectDir);
          const model = args.model || resolveDefault(cache, "asr", null, config);
          if (!model) return "错误：未配置 ASR 模型。请先运行 install.mjs 或 setup-getbot.mjs";
          if (!existsSync(args.filePath)) return `错误：文件不存在 - ${args.filePath}`;

          // 120s + 32kbps mp3 ≈ 480KB，base64 后仍在 1MB Nginx 限制内
          const MAX_CHUNK_SEC = 120;
          const tmpBase = join(projectDir, ".opencode", "tmp", "getbot_asr_" + Date.now());
          const mdOutDir = resolveOutputDir(projectDir, config, "md", "getbot.me/md");
          const audioBase = safePdfFilename(basename(args.filePath, extname(args.filePath)));
          const outMd = join(mdOutDir, `${audioBase}_${nowStamp()}.md`);

          try {
            const dur = await probeDurationSec(args.filePath);
            let chunks;
            if (dur && dur > MAX_CHUNK_SEC) {
              chunks = await splitAudio(args.filePath, MAX_CHUNK_SEC, tmpBase);
            } else {
              chunks = [args.filePath];
            }

            const parts = [];
            for (let i = 0; i < chunks.length; i++) {
              const txt = await callTranscription(apiKey, config, {
                model, audioPath: chunks[i], language: args.language,
                tmpDir: join(tmpBase, `compact_${i}`),
              });
              parts.push(txt);
            }
            const full = parts.join("\n");
            const mdBody = `# ${audioBase} 转录结果\n\n> 源音频：${args.filePath}\n> 模型：${model}\n> 分片数：${chunks.length}\n\n${full}\n`;
            writeFileSync(outMd, mdBody, "utf-8");
            return `转录完成（model=${model}, 分片=${chunks.length}）\n结果保存至: ${outMd}\n\n${full}`;
          } catch (e) {
            return `转录失败：${e.message}`;
          } finally {
            try { rmSync(tmpBase, { recursive: true, force: true }); } catch {}
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
          let mdPath = (args.filePath || "").trim().replace(/^["']|["']$/g, "");
          if (!mdPath) return "错误：请提供 Markdown 文件路径";
          if (!/^([a-zA-Z]:[\\/]|[\\/]|~)/.test(mdPath)) mdPath = join(projectDir, mdPath);
          if (!existsSync(mdPath)) return `错误：文件不存在 - ${mdPath}`;
          if (statSync(mdPath).isDirectory()) return `错误：路径是目录 - ${mdPath}`;
          const ext = extname(mdPath).toLowerCase();
          if (![".md", ".markdown", ".txt"].includes(ext)) {
            return `错误：不支持的文件类型 ${ext}（仅 .md / .markdown / .txt）`;
          }

          const outDir = resolveOutputDir(projectDir, config, "html", "getbot.me/html");
          try {
            const outPath = await convertMdToPrintHtml(mdPath, outDir);
            const opened = openInBrowser(outPath);
            const tip = opened
              ? "已用默认浏览器打开。如需 PDF，按 Ctrl+P（macOS：Cmd+P）→ 另存为 PDF 即可。"
              : "自动打开浏览器失败，请手动双击该 HTML。";
            return `已生成打印排版 HTML：\n${outPath}\n\n${tip}`;
          } catch (e) {
            return `转换失败：${e.message}`;
          }
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
};

export const tui = async (api) => {
  const { ui, kv, state, command, lifecycle } = api;
  const projectDir = state.path.directory;

  let cache = loadCache(projectDir);
  let config = loadConfig(projectDir);

  // 把缓存里的 defaults 同步进 kv，kv 优先级更高
  const CATS = ["image", "tts", "asr"];
  for (const cat of CATS) {
    const saved = kv.get(`getbot.model.${cat}`, null);
    if (!saved) {
      const def = resolveDefault(cache, cat, null, config);
      if (def) kv.set(`getbot.model.${cat}`, def);
    }
  }

  const apiKey = loadApiKey(projectDir);
  if (!apiKey) {
    ui.toast({ variant: "warning", title: "getbot", message: "未配置 GETBOT_API_KEY，请运行 install.mjs" });
  }

  const missingCats = CATS.filter((c) => !resolveDefault(cache, c, null, config) && !kv.get(`getbot.model.${c}`));
  if (missingCats.length && cache) {
    ui.toast({ variant: "warning", title: "getbot", message: `未发现分类模型：${missingCats.join(", ")}。可在 .opencode/config/getbot.json 的 category_overrides 手工指定` });
  }

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
    recording = true;
    ui.toast({ variant: "info", title: "getbot 语音", message: `开始录音 ${duration} 秒...` });

    const tmpDir = join(projectDir, ".opencode", "tmp", "getbot_voice");
    mkdirSync(tmpDir, { recursive: true });
    const wav = join(tmpDir, `rec_${Date.now()}.wav`);

    try {
      await recordAudio(wav, duration);
      const text = await callTranscription(apiKey, config, { model: asrModel, audioPath: wav, language });
      const trimmed = (text || "").trim();
      if (!trimmed) {
        ui.toast({ variant: "warning", title: "getbot 语音", message: "未识别到内容" });
        return;
      }
      try {
        await copyToClipboard(trimmed);
        const preview = trimmed.length > 40 ? trimmed.slice(0, 40) + "..." : trimmed;
        ui.toast({ variant: "success", title: "getbot 语音", message: `已复制到剪贴板，按 Ctrl+V 粘贴：${preview}` });
      } catch (e) {
        ui.toast({ variant: "warning", title: "getbot 语音", message: `识别完成但剪贴板失败：${trimmed.slice(0, 50)}` });
      }
    } catch (e) {
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
    }
  };

  // 刷新模型列表（重新读缓存；实际拉取请跑 setup-getbot.mjs）
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
      description: "重新读取 .opencode/cache/getbot-models.json。若需从 API 拉取请跑 setup-getbot.mjs",
      category: "getbot",
      onSelect: () => refreshCache(),
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
