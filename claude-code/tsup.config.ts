import { defineConfig } from "tsup"
import pkg from "./package.json" with { type: "json" }

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  splitting: false,
  sourcemap: true,
  clean: true,
  target: "es2022",
  // 强制 bundle 所有 @ai-sdk/* 依赖, 让 dist self-contained.
  // 历史上 plugin 依靠 DeskFox 内嵌 opencode sidecar 的 ai-sdk node_modules 被动 resolve,
  // 但 opencode @opencode-ai/plugin loader 升级 (2026-05) 后不再向 plugin 暴露主程 node_modules,
  // 不 bundle 就会运行时 import 失败 → opencode 包成 ProviderInitError.
  noExternal: [/@ai-sdk\//],
  // 把 package.json 的 version 编译进 dist, 运行时可读 process.env.PLUGIN_VERSION.
  // 用于 DEBUG log 打印 plugin 自身版本, 朋友诊断时不用猜装的是哪版.
  env: {
    PLUGIN_VERSION: pkg.version,
  },
})
