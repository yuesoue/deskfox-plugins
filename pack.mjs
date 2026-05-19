#!/usr/bin/env node
/**
 * 把 getbot-opencode/ 自身打成 dist/getbot-opencode.zip
 *
 * 为什么不用 PowerShell Compress-Archive：它不设 UTF-8 filename flag（0x0800），
 * 导致中文文件名在 macOS/Linux 上解压出现 mojibake。这里手写 ZIP 结构并显式
 * 置位 UTF-8 flag，跨平台解压都能拿到正确文件名。
 *
 * 用法：node getbot-opencode/pack.mjs（从仓库根跑），或 cd 进 getbot-opencode/ 后跑 node pack.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { deflateRawSync, crc32 } from "node:zlib";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = __dirname;                                       // 插件目录本身
const OUT = resolve(__dirname, "dist", "getbot-opencode.zip");   // 打包产物
const SELF_NAME = "pack.mjs";

// 不打进 zip 的顶层子项：
//   pack.mjs   —— 打包脚本自身，最终用户不需要
//   dist       —— 上次打的 zip，不能套娃
//   _docs      —— 开发文档，发行包不需要
//   _smoke     —— 本地烟测脚本（也被 .gitignore 排除）
const EXCLUDE_TOP = new Set([SELF_NAME, "dist", "_docs", "_smoke"]);

if (!existsSync(SRC_DIR)) { console.error("源目录不存在: " + SRC_DIR); process.exit(1); }

export function walk(dir, base = dir) {
  const entries = [];
  for (const name of readdirSync(dir)) {
    // 顶层排除（只在 base === dir 这一层判断）
    if (dir === base && EXCLUDE_TOP.has(name)) continue;
    const full = join(dir, name);
    const st = statSync(full);
    const rel = relative(base, full).split(sep).join("/");
    if (st.isDirectory()) entries.push(...walk(full, base));
    else entries.push({ rel, full, size: st.size });
  }
  return entries.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ZIP 时间戳：用 1980-01-01 00:00:00（所有人看起来一致，便于 reproducible 打包）
const DOS_TIME = 0;
const DOS_DATE = (1 << 5) | 1; // year offset from 1980 = 0, month=1, day=1

export function packZip(entries, outPath) {
  const localHeaders = [];
  const centralDir = [];
  let offset = 0;

  for (const e of entries) {
    const nameBuf = Buffer.from(e.rel, "utf-8");
    const data = readFileSync(e.full);
    const crc = crc32(data);
    const deflated = deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const compData = useDeflate ? deflated : data;
    const compMethod = useDeflate ? 8 : 0;

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);        // version needed
    lh.writeUInt16LE(0x0800, 6);    // general purpose flag — bit 11 = UTF-8
    lh.writeUInt16LE(compMethod, 8);
    lh.writeUInt16LE(DOS_TIME, 10);
    lh.writeUInt16LE(DOS_DATE, 12);
    lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(compData.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);
    lh.writeUInt16LE(0, 28);

    localHeaders.push(Buffer.concat([lh, nameBuf, compData]));

    const cd = Buffer.alloc(46);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);        // version made by
    cd.writeUInt16LE(20, 6);        // version needed
    cd.writeUInt16LE(0x0800, 8);    // flag UTF-8
    cd.writeUInt16LE(compMethod, 10);
    cd.writeUInt16LE(DOS_TIME, 12);
    cd.writeUInt16LE(DOS_DATE, 14);
    cd.writeUInt32LE(crc, 16);
    cd.writeUInt32LE(compData.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt16LE(0, 30);        // extra length
    cd.writeUInt16LE(0, 32);        // comment length
    cd.writeUInt16LE(0, 34);        // disk number
    cd.writeUInt16LE(0, 36);        // internal attrs
    cd.writeUInt32LE(0, 38);        // external attrs
    cd.writeUInt32LE(offset, 42);   // local header offset

    centralDir.push(Buffer.concat([cd, nameBuf]));
    offset += localHeaders[localHeaders.length - 1].length;
  }

  const localBlob = Buffer.concat(localHeaders);
  const cdBlob = Buffer.concat(centralDir);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBlob.length, 12);
  eocd.writeUInt32LE(localBlob.length, 16);
  eocd.writeUInt16LE(0, 20);

  writeFileSync(outPath, Buffer.concat([localBlob, cdBlob, eocd]));
}

// 仅当作为主脚本运行时才执行打包（被其他模块 import 时不副作用）
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, "/")}` || fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const entries = walk(SRC_DIR);
  mkdirSync(dirname(OUT), { recursive: true });
  packZip(entries, OUT);
  const totalRaw = entries.reduce((a, e) => a + e.size, 0);
  const outSize = statSync(OUT).size;
  console.log(`✓ 打包完成：${OUT}`);
  console.log(`  条目 ${entries.length} 个 / 源大小 ${(totalRaw / 1024).toFixed(1)}KB → zip ${(outSize / 1024).toFixed(1)}KB`);
  console.log(`  已排除：${[...EXCLUDE_TOP].join(", ")}`);
  console.log("  所有文件名使用 UTF-8 flag，跨平台解压中文名不会 mojibake");
}
