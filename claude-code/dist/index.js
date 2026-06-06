var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function __require() {
  return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));

// node_modules/.pnpm/secure-json-parse@2.7.0/node_modules/secure-json-parse/index.js
var require_secure_json_parse = __commonJS({
  "node_modules/.pnpm/secure-json-parse@2.7.0/node_modules/secure-json-parse/index.js"(exports, module) {
    "use strict";
    var hasBuffer = typeof Buffer !== "undefined";
    var suspectProtoRx = /"(?:_|\\u005[Ff])(?:_|\\u005[Ff])(?:p|\\u0070)(?:r|\\u0072)(?:o|\\u006[Ff])(?:t|\\u0074)(?:o|\\u006[Ff])(?:_|\\u005[Ff])(?:_|\\u005[Ff])"\s*:/;
    var suspectConstructorRx = /"(?:c|\\u0063)(?:o|\\u006[Ff])(?:n|\\u006[Ee])(?:s|\\u0073)(?:t|\\u0074)(?:r|\\u0072)(?:u|\\u0075)(?:c|\\u0063)(?:t|\\u0074)(?:o|\\u006[Ff])(?:r|\\u0072)"\s*:/;
    function _parse(text, reviver, options) {
      if (options == null) {
        if (reviver !== null && typeof reviver === "object") {
          options = reviver;
          reviver = void 0;
        }
      }
      if (hasBuffer && Buffer.isBuffer(text)) {
        text = text.toString();
      }
      if (text && text.charCodeAt(0) === 65279) {
        text = text.slice(1);
      }
      const obj = JSON.parse(text, reviver);
      if (obj === null || typeof obj !== "object") {
        return obj;
      }
      const protoAction = options && options.protoAction || "error";
      const constructorAction = options && options.constructorAction || "error";
      if (protoAction === "ignore" && constructorAction === "ignore") {
        return obj;
      }
      if (protoAction !== "ignore" && constructorAction !== "ignore") {
        if (suspectProtoRx.test(text) === false && suspectConstructorRx.test(text) === false) {
          return obj;
        }
      } else if (protoAction !== "ignore" && constructorAction === "ignore") {
        if (suspectProtoRx.test(text) === false) {
          return obj;
        }
      } else {
        if (suspectConstructorRx.test(text) === false) {
          return obj;
        }
      }
      return filter(obj, { protoAction, constructorAction, safe: options && options.safe });
    }
    function filter(obj, { protoAction = "error", constructorAction = "error", safe } = {}) {
      let next = [obj];
      while (next.length) {
        const nodes = next;
        next = [];
        for (const node of nodes) {
          if (protoAction !== "ignore" && Object.prototype.hasOwnProperty.call(node, "__proto__")) {
            if (safe === true) {
              return null;
            } else if (protoAction === "error") {
              throw new SyntaxError("Object contains forbidden prototype property");
            }
            delete node.__proto__;
          }
          if (constructorAction !== "ignore" && Object.prototype.hasOwnProperty.call(node, "constructor") && Object.prototype.hasOwnProperty.call(node.constructor, "prototype")) {
            if (safe === true) {
              return null;
            } else if (constructorAction === "error") {
              throw new SyntaxError("Object contains forbidden prototype property");
            }
            delete node.constructor;
          }
          for (const key in node) {
            const value = node[key];
            if (value && typeof value === "object") {
              next.push(value);
            }
          }
        }
      }
      return obj;
    }
    function parse(text, reviver, options) {
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      try {
        return _parse(text, reviver, options);
      } finally {
        Error.stackTraceLimit = stackTraceLimit;
      }
    }
    function safeParse(text, reviver) {
      const stackTraceLimit = Error.stackTraceLimit;
      Error.stackTraceLimit = 0;
      try {
        return _parse(text, reviver, { safe: true });
      } catch (_e) {
        return null;
      } finally {
        Error.stackTraceLimit = stackTraceLimit;
      }
    }
    module.exports = parse;
    module.exports.default = parse;
    module.exports.parse = parse;
    module.exports.safeParse = safeParse;
    module.exports.scan = filter;
  }
});

// src/claude-code-language-model.ts
import { createHash } from "crypto";

// node_modules/.pnpm/@ai-sdk+provider@1.1.3/node_modules/@ai-sdk/provider/dist/index.mjs
var marker = "vercel.ai.error";
var symbol = Symbol.for(marker);
var _a;
var _AISDKError = class _AISDKError2 extends Error {
  /**
   * Creates an AI SDK Error.
   *
   * @param {Object} params - The parameters for creating the error.
   * @param {string} params.name - The name of the error.
   * @param {string} params.message - The error message.
   * @param {unknown} [params.cause] - The underlying cause of the error.
   */
  constructor({
    name: name14,
    message,
    cause
  }) {
    super(message);
    this[_a] = true;
    this.name = name14;
    this.cause = cause;
  }
  /**
   * Checks if the given error is an AI SDK Error.
   * @param {unknown} error - The error to check.
   * @returns {boolean} True if the error is an AI SDK Error, false otherwise.
   */
  static isInstance(error) {
    return _AISDKError2.hasMarker(error, marker);
  }
  static hasMarker(error, marker15) {
    const markerSymbol = Symbol.for(marker15);
    return error != null && typeof error === "object" && markerSymbol in error && typeof error[markerSymbol] === "boolean" && error[markerSymbol] === true;
  }
};
_a = symbol;
var AISDKError = _AISDKError;
var name = "AI_APICallError";
var marker2 = `vercel.ai.error.${name}`;
var symbol2 = Symbol.for(marker2);
var _a2;
_a2 = symbol2;
var name2 = "AI_EmptyResponseBodyError";
var marker3 = `vercel.ai.error.${name2}`;
var symbol3 = Symbol.for(marker3);
var _a3;
_a3 = symbol3;
var name3 = "AI_InvalidArgumentError";
var marker4 = `vercel.ai.error.${name3}`;
var symbol4 = Symbol.for(marker4);
var _a4;
var InvalidArgumentError = class extends AISDKError {
  constructor({
    message,
    cause,
    argument
  }) {
    super({ name: name3, message, cause });
    this[_a4] = true;
    this.argument = argument;
  }
  static isInstance(error) {
    return AISDKError.hasMarker(error, marker4);
  }
};
_a4 = symbol4;
var name4 = "AI_InvalidPromptError";
var marker5 = `vercel.ai.error.${name4}`;
var symbol5 = Symbol.for(marker5);
var _a5;
_a5 = symbol5;
var name5 = "AI_InvalidResponseDataError";
var marker6 = `vercel.ai.error.${name5}`;
var symbol6 = Symbol.for(marker6);
var _a6;
_a6 = symbol6;
var name6 = "AI_JSONParseError";
var marker7 = `vercel.ai.error.${name6}`;
var symbol7 = Symbol.for(marker7);
var _a7;
_a7 = symbol7;
var name7 = "AI_LoadAPIKeyError";
var marker8 = `vercel.ai.error.${name7}`;
var symbol8 = Symbol.for(marker8);
var _a8;
_a8 = symbol8;
var name8 = "AI_LoadSettingError";
var marker9 = `vercel.ai.error.${name8}`;
var symbol9 = Symbol.for(marker9);
var _a9;
_a9 = symbol9;
var name9 = "AI_NoContentGeneratedError";
var marker10 = `vercel.ai.error.${name9}`;
var symbol10 = Symbol.for(marker10);
var _a10;
_a10 = symbol10;
var name10 = "AI_NoSuchModelError";
var marker11 = `vercel.ai.error.${name10}`;
var symbol11 = Symbol.for(marker11);
var _a11;
_a11 = symbol11;
var name11 = "AI_TooManyEmbeddingValuesForCallError";
var marker12 = `vercel.ai.error.${name11}`;
var symbol12 = Symbol.for(marker12);
var _a12;
_a12 = symbol12;
var name12 = "AI_TypeValidationError";
var marker13 = `vercel.ai.error.${name12}`;
var symbol13 = Symbol.for(marker13);
var _a13;
_a13 = symbol13;
var name13 = "AI_UnsupportedFunctionalityError";
var marker14 = `vercel.ai.error.${name13}`;
var symbol14 = Symbol.for(marker14);
var _a14;
_a14 = symbol14;

// node_modules/.pnpm/nanoid@3.3.11/node_modules/nanoid/non-secure/index.js
var customAlphabet = (alphabet, defaultSize = 21) => {
  return (size = defaultSize) => {
    let id = "";
    let i = size | 0;
    while (i--) {
      id += alphabet[Math.random() * alphabet.length | 0];
    }
    return id;
  };
};

// node_modules/.pnpm/@ai-sdk+provider-utils@2.2.8_zod@3.25.76/node_modules/@ai-sdk/provider-utils/dist/index.mjs
var import_secure_json_parse = __toESM(require_secure_json_parse(), 1);
var createIdGenerator = ({
  prefix,
  size: defaultSize = 16,
  alphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz",
  separator = "-"
} = {}) => {
  const generator = customAlphabet(alphabet, defaultSize);
  if (prefix == null) {
    return generator;
  }
  if (alphabet.includes(separator)) {
    throw new InvalidArgumentError({
      argument: "separator",
      message: `The separator "${separator}" must not be part of the alphabet "${alphabet}".`
    });
  }
  return (size) => `${prefix}${separator}${generator(size)}`;
};
var generateId = createIdGenerator();
var { btoa, atob } = globalThis;

// src/logger.ts
import { appendFileSync, mkdirSync } from "fs";
import path from "path";
import os from "os";
var DEBUG = process.env.DEBUG?.includes("opencode-claude-code") ?? false;
var LOG_FILE = process.env.OPENCODE_CLAUDE_CODE_LOG_FILE ?? path.join(os.homedir(), ".config", "opencode", "claude-code-plugin.log");
if (DEBUG) {
  try {
    mkdirSync(path.dirname(LOG_FILE), { recursive: true });
  } catch {
  }
}
function fmt(level, msg, data) {
  const ts = (/* @__PURE__ */ new Date()).toISOString();
  const base = `[${ts}] [opencode-claude-code] ${level}: ${msg}`;
  if (data && Object.keys(data).length > 0) {
    return `${base} ${JSON.stringify(data)}`;
  }
  return base;
}
function write(line) {
  if (!DEBUG) return;
  try {
    appendFileSync(LOG_FILE, line + "\n");
  } catch {
  }
}
var log = {
  info(msg, data) {
    write(fmt("INFO", msg, data));
  },
  warn(msg, data) {
    write(fmt("WARN", msg, data));
  },
  // error 在关 DEBUG 时也走 stderr — sidecar stderr 可能被 DeskFox 主进程捕获到日志.
  // 这是 plugin 唯一一类"无论如何也要留痕"的 log level.
  error(msg, data) {
    const line = fmt("ERROR", msg, data);
    if (DEBUG) write(line);
    else console.error(line);
  },
  debug(msg, data) {
    write(fmt("DEBUG", msg, data));
  }
};

// src/tool-mapping.ts
function mapToolInput(name14, input) {
  if (!input) return input;
  switch (name14) {
    case "Write":
      return {
        filePath: input.file_path ?? input.filePath,
        content: input.content
      };
    case "Edit":
      return {
        filePath: input.file_path ?? input.filePath,
        oldString: input.old_string ?? input.oldString,
        newString: input.new_string ?? input.newString,
        replaceAll: input.replace_all ?? input.replaceAll
      };
    case "Read":
      return {
        filePath: input.file_path ?? input.filePath,
        offset: input.offset,
        limit: input.limit
      };
    case "Bash":
      return {
        command: input.command,
        description: input.description || `Execute: ${String(input.command || "").slice(0, 50)}${String(input.command || "").length > 50 ? "..." : ""}`,
        timeout: input.timeout
      };
    case "NotebookEdit":
      return {
        notebookPath: input.notebook_path ?? input.notebookPath,
        cellNumber: input.cell_number ?? input.cellNumber,
        newSource: input.new_source ?? input.newSource,
        cellType: input.cell_type ?? input.cellType,
        editMode: input.edit_mode ?? input.editMode
      };
    case "Glob":
      return {
        pattern: input.pattern,
        path: input.path
      };
    case "Grep":
      return {
        pattern: input.pattern,
        path: input.path,
        include: input.include
      };
    case "TodoWrite":
      if (Array.isArray(input.todos)) {
        const mappedTodos = input.todos.map((todo, index) => ({
          content: todo.content,
          status: todo.status || "pending",
          priority: todo.priority || "medium",
          id: todo.id || `todo_${Date.now()}_${index}`
        }));
        return { todos: mappedTodos };
      }
      return input;
    default:
      return input;
  }
}
var OPENCODE_HANDLED_TOOLS = /* @__PURE__ */ new Set([
  "Edit",
  "Write",
  "Bash",
  "NotebookEdit",
  "TodoWrite",
  "Read",
  "Glob",
  "Grep"
]);
var CLAUDE_INTERNAL_TOOLS = /* @__PURE__ */ new Set([
  "ToolSearch",
  "Agent",
  "AskFollowupQuestion"
]);
function mapTool(name14, input) {
  if (CLAUDE_INTERNAL_TOOLS.has(name14)) {
    log.debug("skipping Claude CLI internal tool", { name: name14 });
    return { name: name14, input, executed: true, skip: true };
  }
  if (name14 === "EnterPlanMode") return { name: "plan_enter", input: {}, executed: false };
  if (name14 === "ExitPlanMode") return { name: "plan_exit", input, executed: false };
  if (name14 === "WebSearch" || name14 === "web_search") {
    const mappedInput = input?.query ? { query: input.query } : input;
    log.debug("mapping WebSearch", { originalInput: input, mappedInput });
    return { name: "websearch_web_search_exa", input: mappedInput, executed: false };
  }
  if (name14 === "PowerShell") {
    log.debug("mapping PowerShell to bash", { input });
    return { name: "bash", input, executed: true };
  }
  if (name14 === "TaskOutput") {
    if (!input) return { name: "bash", executed: false };
    const output = input?.content || input?.output || JSON.stringify(input);
    return {
      name: "bash",
      input: {
        command: `echo "TASK OUTPUT: ${String(output).replace(/"/g, '\\"')}"`,
        description: "Displaying task output"
      },
      executed: false
    };
  }
  if (name14.startsWith("mcp__")) {
    const parts = name14.slice(5).split("__");
    if (parts.length >= 2) {
      const serverName = parts[0];
      const toolName = parts.slice(1).join("_");
      const openCodeName = `${serverName}_${toolName}`;
      log.debug("mapping MCP tool", { original: name14, mapped: openCodeName });
      return { name: openCodeName, input, executed: false };
    }
  }
  if (OPENCODE_HANDLED_TOOLS.has(name14)) {
    const mappedInput = mapToolInput(name14, input);
    const openCodeName = name14.toLowerCase();
    log.debug("mapping CLI-executed tool", { name: name14, openCodeName });
    return { name: openCodeName, input: mappedInput, executed: true };
  }
  log.warn("unmapped tool fallthrough", { name: name14, input });
  return { name: name14, input, executed: true };
}

// src/message-builder.ts
function toClaudeImageSource(data, mediaType) {
  if (data instanceof Uint8Array) {
    return {
      type: "base64",
      media_type: mediaType,
      data: Buffer.from(data).toString("base64")
    };
  }
  if (data instanceof URL) {
    return { type: "url", url: data.toString() };
  }
  if (typeof data === "string") {
    if (data.startsWith("data:")) {
      const comma = data.indexOf(",");
      if (comma > 0) {
        const header = data.slice(5, comma);
        const isBase64 = header.endsWith(";base64");
        const mt = (isBase64 ? header.slice(0, -7) : header) || mediaType;
        const payload = data.slice(comma + 1);
        return {
          type: "base64",
          media_type: mt,
          // 非 base64 (即 url-encoded plain text) 的图片 data URL 几乎不存在, 这里仍走 base64 通道,
          // Claude 端校验失败再 fallback 处理.
          data: isBase64 ? payload : Buffer.from(decodeURIComponent(payload)).toString("base64")
        };
      }
    }
    if (data.startsWith("http://") || data.startsWith("https://")) {
      return { type: "url", url: data };
    }
    return { type: "base64", media_type: mediaType, data };
  }
  return null;
}
function compactConversationHistory(prompt) {
  const conversationMessages = prompt.filter(
    (m) => m.role === "user" || m.role === "assistant"
  );
  if (conversationMessages.length <= 1) {
    return null;
  }
  const historyParts = [];
  for (let i = 0; i < conversationMessages.length - 1; i++) {
    const msg = conversationMessages[i];
    const role = msg.role === "user" ? "User" : "Assistant";
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      const textParts = msg.content.filter((p) => p.type === "text" && p.text).map((p) => p.text);
      text = textParts.join("\n");
      const toolCalls = msg.content.filter(
        (p) => p.type === "tool-call"
      );
      const toolResults = msg.content.filter(
        (p) => p.type === "tool-result"
      );
      if (toolCalls.length > 0) {
        text += `
[Called ${toolCalls.length} tool(s): ${toolCalls.map((t) => t.toolName).join(", ")}]`;
      }
      if (toolResults.length > 0) {
        text += `
[Received ${toolResults.length} tool result(s)]`;
      }
    }
    if (text.trim()) {
      const truncated = text.length > 2e3 ? text.slice(0, 2e3) + "..." : text;
      historyParts.push(`${role}: ${truncated}`);
    }
  }
  if (historyParts.length === 0) {
    return null;
  }
  return historyParts.join("\n\n");
}
function getClaudeUserMessage(prompt, includeHistoryContext = false) {
  const content = [];
  if (includeHistoryContext) {
    const historyContext = compactConversationHistory(prompt);
    if (historyContext) {
      log.info("including conversation history context", {
        historyLength: historyContext.length
      });
      content.push({
        type: "text",
        text: `<conversation_history>
The following is a summary of our conversation so far (from a previous session that couldn't be resumed):

${historyContext}

</conversation_history>

Now continuing with the current message:

`
      });
    }
  }
  const messages = [];
  for (let i = prompt.length - 1; i >= 0; i--) {
    if (prompt[i].role === "assistant") break;
    messages.unshift(prompt[i]);
  }
  for (const msg of messages) {
    if (msg.role === "user") {
      if (typeof msg.content === "string" && msg.content) {
        content.push({ type: "text", text: msg.content });
      } else if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === "text" && part.text) {
            content.push({ type: "text", text: part.text });
          } else if (part.type === "file") {
            const mediaType = part.mediaType;
            if (!mediaType || !mediaType.startsWith("image/")) {
              log.warn("skipping non-image file part in user message", {
                mediaType
              });
              continue;
            }
            const concreteMediaType = mediaType === "image/*" ? "image/png" : mediaType;
            const source = toClaudeImageSource(part.data, concreteMediaType);
            if (source) {
              content.push({ type: "image", source });
            } else {
              log.warn("could not encode image part \u2014 dropped", {
                mediaType,
                dataType: typeof part.data
              });
            }
          } else if (part.type === "tool-result") {
            const p = part;
            let resultText = "";
            if (typeof p.result === "string") {
              resultText = p.result;
            } else if (typeof p.result === "object" && p.result && "output" in p.result) {
              resultText = String(p.result.output);
            } else {
              resultText = JSON.stringify(p.result);
            }
            content.push({
              type: "tool_result",
              tool_use_id: p.toolCallId,
              content: resultText
            });
          }
        }
      }
    }
  }
  if (content.length === 0) {
    return "";
  }
  return JSON.stringify({
    type: "user",
    message: {
      role: "user",
      content
    }
  });
}

// src/session-manager.ts
import { spawn } from "child_process";
import { createInterface } from "readline";
import { EventEmitter } from "events";
var IDLE_TIMEOUT_MS = 7 * 60 * 1e3;
var SIGKILL_DELAY_MS = 2e3;
var activeProcesses = /* @__PURE__ */ new Map();
var claudeSessions = /* @__PURE__ */ new Map();
function getActiveProcess(key) {
  const ap = activeProcesses.get(key);
  if (ap?.idleTimer) {
    clearTimeout(ap.idleTimer);
    ap.idleTimer = void 0;
  }
  return ap;
}
function deleteActiveProcess(key) {
  const ap = activeProcesses.get(key);
  if (!ap) return;
  if (ap.idleTimer) {
    clearTimeout(ap.idleTimer);
    ap.idleTimer = void 0;
  }
  activeProcesses.delete(key);
  const proc = ap.proc;
  try {
    proc.kill("SIGTERM");
  } catch {
  }
  if (proc.exitCode === null && proc.signalCode === null) {
    const killTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) {
        log.warn("process did not exit after SIGTERM, sending SIGKILL", { key });
        try {
          proc.kill("SIGKILL");
        } catch {
        }
      }
    }, SIGKILL_DELAY_MS);
    killTimer.unref?.();
    proc.once("exit", () => clearTimeout(killTimer));
  }
}
function resetIdleTimer(key) {
  const ap = activeProcesses.get(key);
  if (!ap) return;
  if (ap.idleTimer) clearTimeout(ap.idleTimer);
  ap.idleTimer = setTimeout(() => {
    log.info("idle process timed out, recycling (keeping session for resume)", {
      key
    });
    deleteActiveProcess(key);
  }, IDLE_TIMEOUT_MS);
  ap.idleTimer.unref?.();
}
function disposeAll() {
  for (const [key, ap] of activeProcesses) {
    if (ap.idleTimer) clearTimeout(ap.idleTimer);
    try {
      ap.proc.kill("SIGKILL");
    } catch {
    }
    activeProcesses.delete(key);
  }
  claudeSessions.clear();
}
var exitHandlersRegistered = false;
function registerExitHandlers() {
  if (exitHandlersRegistered) return;
  exitHandlersRegistered = true;
  const killAll = () => {
    for (const ap of activeProcesses.values()) {
      try {
        ap.proc.kill("SIGKILL");
      } catch {
      }
    }
  };
  process.on("exit", killAll);
  for (const sig of ["SIGTERM", "SIGINT"]) {
    process.on(sig, () => {
      killAll();
      process.exit(0);
    });
  }
}
registerExitHandlers();
function getClaudeSessionId(key) {
  return claudeSessions.get(key);
}
function setClaudeSessionId(key, sessionId) {
  claudeSessions.set(key, sessionId);
}
function deleteClaudeSessionId(key) {
  claudeSessions.delete(key);
}
function spawnClaudeProcess(cliPath, cliArgs, cwd, sessionKey2) {
  log.info("spawning new claude process", { cliPath, cliArgs, cwd, sessionKey: sessionKey2 });
  const proc = spawn(cliPath, cliArgs, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, TERM: "xterm-256color" }
  });
  const lineEmitter = new EventEmitter();
  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => {
    lineEmitter.emit("line", line);
  });
  rl.on("close", () => {
    lineEmitter.emit("close");
  });
  const ap = { proc, lineEmitter };
  activeProcesses.set(sessionKey2, ap);
  proc.on("exit", (code, signal) => {
    log.info("claude process exited", { code, signal, sessionKey: sessionKey2 });
    activeProcesses.delete(sessionKey2);
    if (code !== 0 && code !== null) {
      log.info("process exited with error, clearing session", {
        code,
        sessionKey: sessionKey2
      });
      claudeSessions.delete(sessionKey2);
    }
  });
  proc.stderr?.on("data", (data) => {
    const stderr = data.toString();
    log.debug("stderr", { data: stderr.slice(0, 200) });
    if (stderr.includes("Session ID") && (stderr.includes("already in use") || stderr.includes("not found") || stderr.includes("invalid"))) {
      log.warn("claude session ID error, clearing session", {
        sessionKey: sessionKey2,
        error: stderr.slice(0, 200)
      });
      claudeSessions.delete(sessionKey2);
    }
  });
  return ap;
}
function buildCliArgs(opts) {
  const { sessionKey: sessionKey2, skipPermissions, includeSessionId = true, model } = opts;
  const args = [
    "--output-format",
    "stream-json",
    "--input-format",
    "stream-json",
    "--verbose"
  ];
  if (model) {
    args.push("--model", model);
  }
  if (includeSessionId) {
    const sessionId = claudeSessions.get(sessionKey2);
    if (sessionId && !activeProcesses.has(sessionKey2)) {
      args.push("--resume", sessionId);
    }
  }
  if (skipPermissions) {
    args.push("--dangerously-skip-permissions");
  }
  return args;
}
function sessionKey(cwd, modelId, opencodeSessionId) {
  return `${cwd}::${modelId}::${opencodeSessionId ?? "default"}`;
}

// src/claude-code-language-model.ts
function makeUsage(input, output) {
  return {
    inputTokens: {
      total: input ?? 0,
      noCache: 0,
      cacheRead: 0,
      cacheWrite: 0
    },
    outputTokens: {
      total: output ?? 0,
      text: 0,
      reasoning: 0
    }
  };
}
function fingerprintFromPrompt(prompt) {
  for (const msg of prompt) {
    if (msg.role !== "user") continue;
    let text = "";
    if (typeof msg.content === "string") {
      text = msg.content;
    } else if (Array.isArray(msg.content)) {
      text = msg.content.filter((p) => p.type === "text" && typeof p.text === "string").map((p) => p.text).join("");
    }
    if (text) {
      return createHash("sha256").update(text).digest("hex").slice(0, 12);
    }
  }
  return "default";
}
var ClaudeCodeLanguageModel = class {
  specificationVersion = "v2";
  modelId;
  config;
  constructor(modelId, config) {
    this.modelId = modelId;
    this.config = config;
  }
  supportedUrls = {};
  get provider() {
    return this.config.provider;
  }
  requestScope(options) {
    return Array.isArray(options?.tools) ? "tools" : "no-tools";
  }
  latestUserText(prompt) {
    for (let i = prompt.length - 1; i >= 0; i--) {
      const msg = prompt[i];
      if (msg.role !== "user") continue;
      if (typeof msg.content === "string") {
        return String(msg.content).trim();
      }
      if (Array.isArray(msg.content)) {
        const text = msg.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => String(part.text).trim()).filter(Boolean).join(" ");
        if (text) return text;
      }
    }
    return "";
  }
  synthesizeTitle(prompt) {
    const source = this.latestUserText(prompt).replace(/\s+/g, " ").replace(/[^\p{L}\p{N}\s-]/gu, " ").trim();
    if (!source) return "New Session";
    const stop = /* @__PURE__ */ new Set([
      "a",
      "an",
      "the",
      "and",
      "or",
      "but",
      "to",
      "for",
      "of",
      "in",
      "on",
      "at",
      "with",
      "can",
      "could",
      "would",
      "should",
      "please",
      "hi",
      "hello",
      "hey",
      "there",
      "you",
      "your",
      "this",
      "that",
      "is",
      "are",
      "was",
      "were",
      "be",
      "do",
      "does",
      "did",
      "summarize",
      "summary",
      "project"
    ]);
    const words = source.split(" ").map((word) => word.trim()).filter(Boolean).filter((word) => !stop.has(word.toLowerCase()));
    const picked = (words.length > 0 ? words : source.split(" ").filter(Boolean)).slice(0, 6).map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join(" ");
    return picked || "New Session";
  }
  async doGenerate(options) {
    const warnings = [];
    const providerCwd = options.providerOptions?._opencode?.cwd;
    const opencodeSessionId = options.providerOptions?._opencode?.sessionID ?? fingerprintFromPrompt(options.prompt);
    const cwd = providerCwd ?? this.config.cwd ?? process.cwd();
    const scope = this.requestScope(options);
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, opencodeSessionId);
    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt);
      return {
        content: [{ type: "text", text }],
        finishReason: "stop",
        usage: makeUsage(),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: this.modelId
        },
        providerMetadata: {
          "claude-code": {
            synthetic: true,
            path: "no-tools"
          }
        },
        warnings
      };
    }
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
      deleteActiveProcess(sk);
    }
    const lastMessage = options.prompt[options.prompt.length - 1];
    if (lastMessage?.role === "assistant") {
      log.debug("doGenerate short-circuit: prompt ends with assistant");
      return {
        content: [{ type: "text", text: "" }],
        finishReason: "stop",
        usage: makeUsage(),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: this.modelId
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-turn" }
        },
        warnings
      };
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const includeHistoryContext = !hasExistingSession && hasPriorConversation;
    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext);
    if (!userMsg) {
      log.debug("doGenerate silent: empty user message after message-builder");
      return {
        content: [{ type: "text", text: "" }],
        finishReason: "stop",
        usage: makeUsage(),
        request: { body: { text: "" } },
        response: {
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: this.modelId
        },
        providerMetadata: {
          "claude-code": { synthetic: true, path: "no-new-turn-empty-msg" }
        },
        warnings
      };
    }
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions: this.config.skipPermissions !== false,
      includeSessionId: false,
      model: this.modelId
    });
    log.info("doGenerate starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext
    });
    const { spawn: spawn2 } = await import("child_process");
    const { createInterface: createInterface2 } = await import("readline");
    const proc = spawn2(this.config.cliPath, cliArgs, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, TERM: "xterm-256color" }
    });
    const rl = createInterface2({ input: proc.stdout });
    let responseText = "";
    let thinkingText = "";
    let resultMeta = {};
    const toolCalls = [];
    let result;
    try {
      result = await new Promise((resolve, reject) => {
        rl.on("line", (line) => {
          if (!line.trim()) return;
          try {
            const msg = JSON.parse(line);
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id);
              }
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  responseText += block.text;
                }
                if (block.type === "thinking" && block.thinking) {
                  thinkingText += block.thinking;
                }
                if (block.type === "tool_use" && block.id && block.name) {
                  if (block.name === "AskUserQuestion" || block.name === "ask_user_question") {
                    const parsedInput = block.input ?? {};
                    const question = parsedInput?.question || "Question?";
                    responseText += `

_Asking: ${question}_

`;
                    continue;
                  }
                  if (block.name === "ExitPlanMode") {
                    const parsedInput = block.input ?? {};
                    const plan = parsedInput?.plan || "";
                    responseText += `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`;
                    continue;
                  }
                  toolCalls.push({
                    id: block.id,
                    name: block.name,
                    args: block.input ?? {}
                  });
                }
              }
            }
            if (msg.type === "content_block_start" && msg.content_block) {
              if (msg.content_block.type === "tool_use" && msg.content_block.id && msg.content_block.name) {
                toolCalls.push({
                  id: msg.content_block.id,
                  name: msg.content_block.name,
                  args: {}
                });
              }
            }
            if (msg.type === "content_block_delta" && msg.delta) {
              if (msg.delta.type === "text_delta" && msg.delta.text) {
                responseText += msg.delta.text;
              }
              if (msg.delta.type === "thinking_delta" && msg.delta.thinking) {
                thinkingText += msg.delta.thinking;
              }
              if (msg.delta.type === "input_json_delta" && msg.delta.partial_json && msg.index !== void 0) {
                const tc = toolCalls[msg.index];
                if (tc) {
                  try {
                    tc.args = JSON.parse(msg.delta.partial_json);
                  } catch {
                  }
                }
              }
            }
            if (msg.type === "result") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id);
              }
              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage
              };
              resolve({
                ...resultMeta,
                text: responseText,
                thinking: thinkingText,
                toolCalls
              });
            }
          } catch {
          }
        });
        rl.on("close", () => {
          resolve({
            ...resultMeta,
            text: responseText,
            thinking: thinkingText,
            toolCalls
          });
        });
        proc.on("error", (err) => {
          log.error("process error", { error: err.message });
          reject(err);
        });
        proc.stderr?.on("data", (data) => {
          log.debug("stderr", { data: data.toString().slice(0, 200) });
        });
        proc.stdin?.write(userMsg + "\n");
      });
    } finally {
      try {
        proc.kill("SIGTERM");
      } catch {
      }
    }
    const content = [];
    if (result.thinking) {
      content.push({
        type: "reasoning",
        text: result.thinking
      });
    }
    if (result.text) {
      content.push({
        type: "text",
        text: result.text,
        providerMetadata: {
          "claude-code": {
            sessionId: result.sessionId ?? null,
            costUsd: result.costUsd ?? null,
            durationMs: result.durationMs ?? null
          }
        }
      });
    }
    for (const tc of result.toolCalls) {
      const {
        name: mappedName,
        input: mappedInput,
        executed,
        skip
      } = mapTool(tc.name, tc.args);
      if (skip) continue;
      content.push({
        type: "tool-call",
        toolCallId: tc.id,
        toolName: mappedName,
        input: JSON.stringify(mappedInput),
        providerExecuted: executed
      });
    }
    const usage = makeUsage(
      result.usage?.input_tokens,
      result.usage?.output_tokens
    );
    return {
      content,
      // FORK 2026-04-29 同 stream 端: 全部 providerExecuted=true 不需 ai-sdk 回灌 tool-result, 永远 "stop".
      finishReason: "stop",
      usage,
      request: { body: { text: userMsg } },
      response: {
        id: result.sessionId ?? generateId(),
        timestamp: /* @__PURE__ */ new Date(),
        modelId: this.modelId
      },
      providerMetadata: {
        "claude-code": {
          sessionId: result.sessionId ?? null,
          costUsd: result.costUsd ?? null,
          durationMs: result.durationMs ?? null
        }
      },
      warnings
    };
  }
  async doStream(options) {
    const warnings = [];
    const providerCwd = options.providerOptions?._opencode?.cwd;
    const opencodeSessionId = options.providerOptions?._opencode?.sessionID ?? fingerprintFromPrompt(options.prompt);
    const cwd = providerCwd ?? this.config.cwd ?? process.cwd();
    const cliPath = this.config.cliPath;
    const skipPermissions = this.config.skipPermissions !== false;
    const scope = this.requestScope(options);
    const sk = sessionKey(cwd, `${this.modelId}::${scope}`, opencodeSessionId);
    if (scope === "no-tools") {
      const text = this.synthesizeTitle(options.prompt);
      const textId = generateId();
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({ type: "text-start", id: textId });
          controller.enqueue({
            type: "text-delta",
            id: textId,
            delta: text
          });
          controller.enqueue({ type: "text-end", id: textId });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": {
                synthetic: true,
                path: "no-tools"
              }
            }
          });
          controller.close();
        }
      });
      return {
        stream: stream2,
        request: { body: { text: "" } }
      };
    }
    const hasPriorConversation = options.prompt.filter((m) => m.role === "user" || m.role === "assistant").length > 1;
    if (!hasPriorConversation) {
      deleteClaudeSessionId(sk);
      deleteActiveProcess(sk);
    }
    const lastMessage = options.prompt[options.prompt.length - 1];
    if (lastMessage?.role === "assistant") {
      log.debug("doStream short-circuit: prompt ends with assistant");
      const stream2 = new ReadableStream({
        start(controller) {
          const tid = generateId();
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({
            type: "response-metadata",
            id: generateId(),
            timestamp: /* @__PURE__ */ new Date(),
            modelId: "sonnet"
          });
          controller.enqueue({ type: "text-start", id: tid });
          controller.enqueue({ type: "text-delta", id: tid, delta: "" });
          controller.enqueue({ type: "text-end", id: tid });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-turn" }
            }
          });
          controller.close();
        }
      });
      return {
        stream: stream2,
        request: { body: { text: "" } }
      };
    }
    const hasExistingSession = !!getClaudeSessionId(sk);
    const hasActiveProcess = !!getActiveProcess(sk);
    const includeHistoryContext = !hasExistingSession && !hasActiveProcess && hasPriorConversation;
    const userMsg = getClaudeUserMessage(options.prompt, includeHistoryContext);
    if (!userMsg) {
      log.debug("doStream silent: empty user message after message-builder");
      const tid = generateId();
      const modelIdSnapshot = this.modelId;
      const stream2 = new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings });
          controller.enqueue({
            type: "response-metadata",
            id: generateId(),
            timestamp: /* @__PURE__ */ new Date(),
            modelId: modelIdSnapshot
          });
          controller.enqueue({ type: "text-start", id: tid });
          controller.enqueue({ type: "text-delta", id: tid, delta: "" });
          controller.enqueue({ type: "text-end", id: tid });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": { synthetic: true, path: "no-new-turn-empty-msg" }
            }
          });
          controller.close();
        }
      });
      return {
        stream: stream2,
        request: { body: { text: "" } }
      };
    }
    log.info("doStream starting", {
      cwd,
      model: this.modelId,
      textLength: userMsg.length,
      includeHistoryContext,
      hasActiveProcess
    });
    const cliArgs = buildCliArgs({
      sessionKey: sk,
      skipPermissions,
      model: this.modelId
    });
    const capturedModelId = this.modelId;
    let onConsumerCancel;
    const stream = new ReadableStream({
      start(controller) {
        let activeProcess = getActiveProcess(sk);
        let proc;
        let lineEmitter;
        if (activeProcess) {
          proc = activeProcess.proc;
          lineEmitter = activeProcess.lineEmitter;
          log.debug("reusing active process", { sk });
        } else {
          const ap = spawnClaudeProcess(cliPath, cliArgs, cwd, sk);
          proc = ap.proc;
          lineEmitter = ap.lineEmitter;
        }
        controller.enqueue({ type: "stream-start", warnings });
        controller.enqueue({
          type: "response-metadata",
          id: generateId(),
          timestamp: /* @__PURE__ */ new Date(),
          modelId: capturedModelId
        });
        const textId = generateId();
        let textStarted = false;
        const reasoningIds = /* @__PURE__ */ new Map();
        const reasoningStarted = /* @__PURE__ */ new Map();
        let turnCompleted = false;
        let controllerClosed = false;
        const toolCallMap = /* @__PURE__ */ new Map();
        const toolCallsById = /* @__PURE__ */ new Map();
        let resultMeta = {};
        const lineHandler = (line) => {
          if (!line.trim()) return;
          if (controllerClosed) return;
          try {
            const msg = JSON.parse(line);
            log.debug("stream message", {
              type: msg.type,
              subtype: msg.subtype
            });
            if (msg.type === "system" && msg.subtype === "init") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id);
                log.info("session initialized", {
                  claudeSessionId: msg.session_id
                });
              }
            }
            if (msg.type === "content_block_start" && msg.content_block && msg.index !== void 0) {
              const block = msg.content_block;
              const idx = msg.index;
              if (block.type === "thinking") {
                const reasoningId = generateId();
                reasoningIds.set(idx, reasoningId);
                controller.enqueue({
                  type: "reasoning-start",
                  id: reasoningId
                });
                reasoningStarted.set(idx, true);
              }
              if (block.type === "text") {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId
                  });
                  textStarted = true;
                }
              }
              if (block.type === "tool_use" && block.id && block.name) {
                toolCallMap.set(idx, {
                  id: block.id,
                  name: block.name,
                  inputJson: ""
                });
                if (block.name !== "AskUserQuestion" && block.name !== "ask_user_question" && block.name !== "ExitPlanMode") {
                  const { name: mappedName, skip } = mapTool(block.name);
                  if (!skip) {
                    controller.enqueue({
                      type: "tool-input-start",
                      id: block.id,
                      toolName: mappedName
                    });
                    log.info("tool started", {
                      name: block.name,
                      mappedName,
                      id: block.id
                    });
                  }
                }
              }
            }
            if (msg.type === "content_block_delta" && msg.delta && msg.index !== void 0) {
              const delta = msg.delta;
              const idx = msg.index;
              if (delta.type === "thinking_delta" && delta.thinking) {
                const reasoningId = reasoningIds.get(idx);
                if (reasoningId) {
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: reasoningId,
                    delta: delta.thinking
                  });
                }
              }
              if (delta.type === "text_delta" && delta.text) {
                if (!textStarted) {
                  controller.enqueue({
                    type: "text-start",
                    id: textId
                  });
                  textStarted = true;
                }
                controller.enqueue({
                  type: "text-delta",
                  id: textId,
                  delta: delta.text
                });
              }
              if (delta.type === "input_json_delta" && delta.partial_json) {
                const tc = toolCallMap.get(idx);
                if (tc) {
                  tc.inputJson += delta.partial_json;
                  controller.enqueue({
                    type: "tool-input-delta",
                    id: tc.id,
                    delta: delta.partial_json
                  });
                }
              }
            }
            if (msg.type === "content_block_stop" && msg.index !== void 0) {
              const idx = msg.index;
              const reasoningId = reasoningIds.get(idx);
              if (reasoningId && reasoningStarted.get(idx)) {
                controller.enqueue({
                  type: "reasoning-end",
                  id: reasoningId
                });
                reasoningStarted.delete(idx);
              }
              const tc = toolCallMap.get(idx);
              if (tc) {
                let parsedInput = {};
                try {
                  parsedInput = JSON.parse(tc.inputJson || "{}");
                } catch {
                }
                if (tc.name === "AskUserQuestion" || tc.name === "ask_user_question") {
                  let question = "Question?";
                  if (parsedInput?.questions && Array.isArray(parsedInput.questions) && parsedInput.questions.length > 0) {
                    question = parsedInput.questions[0].question || parsedInput.questions[0].text || "Question?";
                  } else {
                    question = parsedInput?.question || parsedInput?.text || "Question?";
                  }
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId
                    });
                    textStarted = true;
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: `

_Asking: ${question}_

`
                  });
                } else if (tc.name === "ExitPlanMode") {
                  const plan = parsedInput?.plan || "";
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId
                    });
                    textStarted = true;
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`
                  });
                } else {
                  const {
                    name: mappedName,
                    input: mappedInput,
                    executed,
                    skip
                  } = mapTool(tc.name, parsedInput);
                  if (!skip) {
                    toolCallsById.set(tc.id, {
                      id: tc.id,
                      name: tc.name,
                      input: parsedInput
                    });
                    controller.enqueue({
                      type: "tool-call",
                      toolCallId: tc.id,
                      toolName: mappedName,
                      input: JSON.stringify(mappedInput),
                      providerExecuted: executed
                    });
                  }
                  log.info("tool call complete", {
                    name: tc.name,
                    mappedName,
                    id: tc.id,
                    executed
                  });
                }
              }
            }
            if (msg.type === "assistant" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "text" && block.text) {
                  if (!textStarted) {
                    controller.enqueue({
                      type: "text-start",
                      id: textId
                    });
                    textStarted = true;
                  }
                  controller.enqueue({
                    type: "text-delta",
                    id: textId,
                    delta: block.text
                  });
                }
                if (block.type === "thinking" && block.thinking) {
                  const thinkingId = generateId();
                  controller.enqueue({
                    type: "reasoning-start",
                    id: thinkingId
                  });
                  controller.enqueue({
                    type: "reasoning-delta",
                    id: thinkingId,
                    delta: block.thinking
                  });
                  controller.enqueue({
                    type: "reasoning-end",
                    id: thinkingId
                  });
                }
                if (block.type === "tool_use" && block.id && block.name) {
                  const parsedInput = block.input ?? {};
                  toolCallsById.set(block.id, {
                    id: block.id,
                    name: block.name,
                    input: parsedInput
                  });
                  if (block.name === "AskUserQuestion" || block.name === "ask_user_question") {
                    let question = "Question?";
                    if (parsedInput?.questions && Array.isArray(parsedInput.questions) && parsedInput.questions.length > 0) {
                      const q = parsedInput.questions[0];
                      question = q.question || q.text || "Question?";
                    } else {
                      question = parsedInput?.question || parsedInput?.text || "Question?";
                    }
                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId
                      });
                      textStarted = true;
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `

_Asking: ${question}_

`
                    });
                  } else if (block.name === "ExitPlanMode") {
                    const plan = parsedInput?.plan || "";
                    if (!textStarted) {
                      controller.enqueue({
                        type: "text-start",
                        id: textId
                      });
                      textStarted = true;
                    }
                    controller.enqueue({
                      type: "text-delta",
                      id: textId,
                      delta: `

${plan}

---
**Do you want to proceed with this plan?** (yes/no)
`
                    });
                  } else {
                    const {
                      name: mappedName,
                      input: mappedInput,
                      executed,
                      skip
                    } = mapTool(block.name, parsedInput);
                    if (!skip) {
                      controller.enqueue({
                        type: "tool-input-start",
                        id: block.id,
                        toolName: mappedName
                      });
                      controller.enqueue({
                        type: "tool-call",
                        toolCallId: block.id,
                        toolName: mappedName,
                        input: JSON.stringify(mappedInput),
                        providerExecuted: executed
                      });
                    }
                    log.info("tool_use from assistant message", {
                      name: block.name,
                      mappedName,
                      id: block.id,
                      executed
                    });
                  }
                }
                if (block.type === "tool_result") {
                  log.debug("tool_result", {
                    toolUseId: block.tool_use_id
                  });
                }
              }
            }
            if (msg.type === "user" && msg.message?.content) {
              for (const block of msg.message.content) {
                if (block.type === "tool_result" && block.tool_use_id) {
                  const toolCall = toolCallsById.get(block.tool_use_id);
                  if (toolCall) {
                    let resultText = "";
                    if (typeof block.content === "string") {
                      resultText = block.content;
                    } else if (Array.isArray(block.content)) {
                      resultText = block.content.filter(
                        (c) => c.type === "text" && typeof c.text === "string"
                      ).map((c) => c.text).join("\n");
                    }
                    controller.enqueue({
                      type: "tool-result",
                      toolCallId: block.tool_use_id,
                      toolName: toolCall.name,
                      result: {
                        output: resultText,
                        title: toolCall.name,
                        metadata: {}
                      },
                      providerExecuted: true
                    });
                    log.info("tool result emitted", {
                      toolUseId: block.tool_use_id,
                      name: toolCall.name
                    });
                    toolCallsById.delete(block.tool_use_id);
                  }
                }
              }
            }
            if (msg.type === "result") {
              if (msg.session_id) {
                setClaudeSessionId(sk, msg.session_id);
              }
              resultMeta = {
                sessionId: msg.session_id,
                costUsd: msg.total_cost_usd,
                durationMs: msg.duration_ms,
                usage: msg.usage
              };
              log.info("conversation result", {
                sessionId: msg.session_id,
                durationMs: msg.duration_ms,
                numTurns: msg.num_turns,
                isError: msg.is_error
              });
              turnCompleted = true;
              if (textStarted) {
                controller.enqueue({ type: "text-end", id: textId });
              }
              for (const [idx, reasoningId] of reasoningIds) {
                if (reasoningStarted.get(idx)) {
                  controller.enqueue({
                    type: "reasoning-end",
                    id: reasoningId
                  });
                }
              }
              controller.enqueue({
                type: "finish",
                // FORK 2026-04-29 永远 "stop": 所有 tool-call 都 providerExecuted=true,
                // Claude CLI 内部已执行完, ai-sdk 不需要回灌 tool-result.
                // 标 "tool-calls" 会让 ai-sdk 误以为要继续工具循环, 又调 doStream 触发"思考中"卡死.
                finishReason: "stop",
                usage: makeUsage(msg.usage?.input_tokens, msg.usage?.output_tokens),
                providerMetadata: {
                  "claude-code": resultMeta
                }
              });
              controllerClosed = true;
              lineEmitter.off("line", lineHandler);
              lineEmitter.off("close", closeHandler);
              try {
                controller.close();
              } catch {
              }
              resetIdleTimer(sk);
            }
          } catch (e) {
            log.debug("failed to parse line", {
              error: e instanceof Error ? e.message : String(e)
            });
          }
        };
        const closeHandler = () => {
          log.debug("readline closed");
          if (controllerClosed) return;
          controllerClosed = true;
          lineEmitter.off("line", lineHandler);
          lineEmitter.off("close", closeHandler);
          if (textStarted) {
            controller.enqueue({ type: "text-end", id: textId });
          }
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: makeUsage(),
            providerMetadata: {
              "claude-code": resultMeta
            }
          });
          try {
            controller.close();
          } catch {
          }
        };
        lineEmitter.on("line", lineHandler);
        lineEmitter.on("close", closeHandler);
        proc.on("error", (err) => {
          log.error("process error", { error: err.message });
          if (controllerClosed) return;
          controllerClosed = true;
          controller.enqueue({ type: "error", error: err });
          try {
            controller.close();
          } catch {
          }
        });
        const teardown = (reason, closeController) => {
          if (controllerClosed) return;
          controllerClosed = true;
          lineEmitter.off("line", lineHandler);
          lineEmitter.off("close", closeHandler);
          if (closeController) {
            try {
              controller.close();
            } catch {
            }
          }
          if (!turnCompleted) {
            log.info(
              "mid-turn teardown, killing claude process (keeping session for resume)",
              { cwd, sk, reason }
            );
            deleteActiveProcess(sk);
          }
        };
        onConsumerCancel = () => teardown("cancel", false);
        if (options.abortSignal) {
          options.abortSignal.addEventListener("abort", () => {
            teardown("abort", true);
          });
        }
        proc.stdin?.write(userMsg + "\n");
        log.debug("sent user message", { textLength: userMsg.length });
      },
      cancel() {
        onConsumerCancel?.();
      }
    });
    return {
      stream,
      request: { body: { text: userMsg } },
      response: { headers: {} }
    };
  }
};

// src/index.ts
var PLUGIN_VERSION = "0.1.4";
function createClaudeCode(settings = {}) {
  const cliPath = settings.cliPath ?? process.env.CLAUDE_CLI_PATH ?? "claude";
  const cwd = settings.cwd ?? process.cwd();
  const providerName = settings.name ?? "claude-code";
  log.info("plugin loaded", {
    version: PLUGIN_VERSION,
    cliPath,
    cwd,
    providerName
  });
  const createModel = (modelId) => {
    return new ClaudeCodeLanguageModel(modelId, {
      provider: providerName,
      cliPath,
      cwd,
      skipPermissions: settings.skipPermissions ?? true
    });
  };
  const provider = function(modelId) {
    return createModel(modelId);
  };
  provider.languageModel = createModel;
  provider.dispose = disposeAll;
  return provider;
}
export {
  ClaudeCodeLanguageModel,
  PLUGIN_VERSION,
  createClaudeCode,
  disposeAll
};
//# sourceMappingURL=index.js.map