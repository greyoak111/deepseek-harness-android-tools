// debtool.mjs — 从 Debian arm64 仓库抽取包到自有前缀（无需 root / 无需发行版环境）
//
// 用法:
//   node debtool.mjs install <包名...>     # 解析依赖闭包并解包
//   node debtool.mjs list <关键词>         # 搜索
//   node debtool.mjs size <包名...>        # 只算闭包体积，不下载
//
// 环境变量:
//   DEB_PREFIX  解包目标（默认 <脚本目录>/debroot）
//   DEB_SUITE   trixie | bookworm | bullseye（默认 trixie）
//   DEB_SKIP    逗号分隔、要跳过的包（默认 libc6 —— 我们用 Termux 的 glibc）
//   DEB_CACHE   .deb 缓存目录
//
// 设计说明：
//   Debian 的 arm64 二进制在 Termux 的 glibc 2.44 下可直接运行（已实测 hello）。
//   因此只跳过 libc6，其余（libstdc++6 / libgcc-s1 / ffmpeg / python 等）全部取 Debian 的，
//   避免混用两套 C++ 运行时。

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
// 复用仓库内置的 xz 解码器
import * as xzNs from "./vendor/xz-decompress/dist/package/xz-decompress.js";
const xz = xzNs.default ?? xzNs;

const MIRROR = "https://deb.debian.org/debian/";
const SUITE = process.env.DEB_SUITE || "trixie";
const ARCH = "arm64";
const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " "));
const PREFIX = process.env.DEB_PREFIX || path.join(WORK, "debroot");
const CACHE = process.env.DEB_CACHE || path.join(WORK, "debcache");
const SKIP = new Set(
  (process.env.DEB_SKIP ?? "libc6").split(",").map((s) => s.trim()).filter(Boolean)
);

fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(PREFIX, { recursive: true });

let IDX = null;
async function loadIndex() {
  if (IDX) return IDX;
  const map = new Map();
  for (const comp of ["main", "contrib", "non-free"]) {
    const url = `${MIRROR}dists/${SUITE}/${comp}/binary-${ARCH}/Packages.gz`;
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(300000) });
      if (!r.ok) continue;
      const t = zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString();
      let n = 0;
      for (const b of t.split("\n\n")) {
        const name = (b.match(/^Package: (.+)$/m) || [])[1]?.trim();
        if (!name || map.has(name)) continue;
        map.set(name, {
          comp,
          ver: (b.match(/^Version: (.+)$/m) || [])[1]?.trim() || "?",
          file: (b.match(/^Filename: (.+)$/m) || [])[1]?.trim(),
          size: Number((b.match(/^Size: (.+)$/m) || [])[1] || 0),
          inst: Number((b.match(/^Installed-Size: (.+)$/m) || [])[1] || 0),
          deps: (b.match(/^Depends: (.+)$/m) || [])[1]?.trim() || "",
          pre: (b.match(/^Pre-Depends: (.+)$/m) || [])[1]?.trim() || "",
        });
        n++;
      }
      console.log(`  仓库 ${comp}: ${n} 个包`);
    } catch (e) {
      console.log(`  仓库 ${comp} 加载失败: ${e.name}`);
    }
  }
  IDX = map;
  return map;
}

/** 从依赖串里提取候选包名（处理 | 备选、版本约束、架构限定） */
function parseDeps(s) {
  const out = [];
  for (const grp of s.split(",")) {
    const first = grp.split("|")[0].trim();
    const name = first.split(/\s+/)[0].replace(/\(.*?\)/g, "").replace(/:.*$/, "").trim();
    if (name && !name.startsWith("${")) out.push(name);
  }
  return out;
}

async function closure(roots) {
  const idx = await loadIndex();
  const seen = new Set();
  const missing = new Set();
  const q = [...roots];
  let dl = 0, inst = 0;
  while (q.length) {
    const n = q.shift();
    if (seen.has(n) || SKIP.has(n)) continue;
    const p = idx.get(n);
    if (!p) { missing.add(n); continue; }
    seen.add(n);
    dl += p.size;
    inst += p.inst;
    for (const d of [...parseDeps(p.deps), ...parseDeps(p.pre)]) q.push(d);
  }
  return { order: [...seen], missing: [...missing], dl, inst };
}

async function fetchDeb(p) {
  const dest = path.join(CACHE, path.basename(p.file));
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const r = await fetch(MIRROR + p.file, { signal: AbortSignal.timeout(600000) });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${p.file}`);
  fs.writeFileSync(dest, Buffer.from(await r.arrayBuffer()));
  return dest;
}

/** 解 .deb：ar → data.tar.xz → xz → tar */
async function extractDeb(deb, destRoot) {
  const buf = fs.readFileSync(deb);
  if (buf.subarray(0, 8).toString() !== "!<arch>\n") throw new Error("不是 ar 归档");
  let off = 8;
  while (off + 60 <= buf.length) {
    const h = buf.subarray(off, off + 60);
    const name = h.subarray(0, 16).toString().trim().replace(/\/$/, "");
    const size = parseInt(h.subarray(48, 58).toString().trim(), 10);
    const data = buf.subarray(off + 60, off + 60 + size);
    if (name.startsWith("data.tar")) {
      let raw;
      if (name.endsWith(".xz")) {
        const reader = new xz.XzReadableStream(new Blob([data]).stream()).getReader();
        const chunks = [];
        for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
        raw = Buffer.concat(chunks);
      } else if (name.endsWith(".gz")) {
        raw = zlib.gunzipSync(data);
      } else {
        raw = Buffer.from(data);
      }
      const tmpTar = path.join(CACHE, path.basename(deb) + ".tar");
      fs.writeFileSync(tmpTar, raw);
      try {
        // Debian 包里有指向 /lib 等的绝对符号链接，toybox tar 会报警；忽略即可
        execFileSync("/system/bin/tar", ["-xf", tmpTar, "-C", destRoot], { stdio: "pipe" });
      } catch {
        /* 部分文件（多为绝对软链）跳过，不影响可执行文件 */
      }
      fs.unlinkSync(tmpTar);
      return;
    }
    off += 60 + size + (size % 2);
  }
  throw new Error("没找到 data.tar.*");
}

// ------------------------------------------------------------------ 主流程
const [cmd, ...args] = process.argv.slice(2);

if (cmd === "list") {
  const idx = await loadIndex();
  const kw = new RegExp(args[0] || ".", "i");
  for (const [n, p] of idx) if (kw.test(n)) console.log(`  ${n.padEnd(30)} ${p.ver}`);
} else if (cmd === "size" || cmd === "install") {
  if (!args.length) { console.log("用法: node debtool.mjs install <包名...>"); process.exit(1); }
  console.log(`仓库: Debian ${SUITE}/${ARCH}   跳过: ${[...SKIP].join(",") || "无"}`);
  const c = await closure(args);
  console.log(`\n依赖闭包: ${c.order.length} 个包`);
  console.log(`  下载: ${(c.dl / 1048576).toFixed(0)} MB`);
  console.log(`  安装: ${(c.inst / 1024).toFixed(0)} MB`);
  if (c.missing.length) console.log(`  未解析（虚包等）: ${c.missing.length} 个: ${c.missing.slice(0, 10).join(", ")}`);

  if (cmd === "size") process.exit(0);

  console.log(`\n解包到: ${PREFIX}\n`);
  const idx = await loadIndex();
  let i = 0, failed = [];
  for (const n of c.order) {
    i++;
    const p = idx.get(n);
    const pct = String(Math.round((i / c.order.length) * 100)).padStart(3);
    try {
      const deb = await fetchDeb(p);
      await extractDeb(deb, PREFIX);
      process.stdout.write(`\r  [${pct}%] ${i}/${c.order.length} ${n.padEnd(30)}`);
    } catch (e) {
      failed.push(`${n}: ${e.message}`);
      process.stdout.write(`\r  [${pct}%] ${i}/${c.order.length} ${n.padEnd(30)} ❌\n`);
    }
  }
  console.log("\n\n✅ 完成");
  console.log(`  前缀: ${PREFIX}`);
  if (failed.length) {
    console.log(`  ⚠️ ${failed.length} 个包失败:`);
    failed.slice(0, 10).forEach((f) => console.log("     " + f));
  }
} else {
  console.log("用法: node debtool.mjs install|size|list ...");
}
