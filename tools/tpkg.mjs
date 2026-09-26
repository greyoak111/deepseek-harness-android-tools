// tpkg.mjs — 从 Termux aarch64 仓库抽取包到自有目录，无需 Termux 本体
// 用法: node tpkg.mjs install aapt2 apksigner ...
//       node tpkg.mjs list <关键词>
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import * as xzNs from "./vendor/xz-decompress/dist/package/xz-decompress.js";
const xz = xzNs.default ?? xzNs;

const REPOS = [
  { name: "main",  base: "https://packages.termux.dev/apt/termux-main/",      idx: "dists/stable/main/binary-aarch64/Packages.gz" },
  { name: "glibc", base: "https://packages-cf.termux.dev/apt/termux-glibc/",  idx: "dists/glibc/stable/binary-aarch64/Packages.gz" },
];
const BASE = REPOS[0].base;
const WORK = path.dirname(new URL(import.meta.url).pathname.replace(/%20/g, " "));
const CACHE = path.join(WORK, "debs");
const STAGE = path.join(WORK, "stage");           // 解包暂存（Tempux 原始层级）
const PREFIX = path.join(WORK, "prefix");         // 整理后的最终前缀
fs.mkdirSync(CACHE, { recursive: true });
fs.mkdirSync(STAGE, { recursive: true });

async function loadIndex() {
  const map = new Map();
  for (const repo of REPOS) {
    try {
      const gz = Buffer.from(await (await fetch(repo.base + repo.idx, { signal: AbortSignal.timeout(120000) })).arrayBuffer());
      const text = zlib.gunzipSync(gz).toString();
      let n = 0;
      for (const b of text.split(/\n\n/)) {
        const pn = b.match(/^Package: (.+)$/m);
        if (!pn) continue;
        const name = pn[1].trim();
        if (map.has(name)) continue;               // main 优先
        map.set(name, {
          repo: repo.name,
          base: repo.base,
          ver: (b.match(/^Version: (.+)$/m) || [])[1]?.trim() || "?",
          file: (b.match(/^Filename: (.+)$/m) || [])[1]?.trim(),
          deps: (b.match(/^Depends: (.+)$/m) || [])[1]?.trim() || "",
          size: Number((b.match(/^Installed-Size: (.+)$/m) || [])[1] || 0),
        });
        n++;
      }
      console.log(`  仓库 ${repo.name}: ${n} 个包`);
    } catch (e) {
      console.log(`  仓库 ${repo.name} 加载失败: ${e.name}`);
    }
  }
  return map;
}

/** 依赖闭包（这次不过滤，libc++ 也要） */
function closure(idx, roots) {
  const out = new Set();
  const walk = (n) => {
    n = n.trim();
    if (!n || out.has(n)) return;
    const p = idx.get(n);
    if (!p) { console.log(`  ⚠️  索引里没有: ${n}`); return; }
    out.add(n);
    for (const d of p.deps.split(",")) walk(d.trim().split(/[\s(|]/)[0]);
  };
  roots.forEach(walk);
  return [...out];
}

async function fetchDeb(idx, name) {
  const p = idx.get(name);
  const dest = path.join(CACHE, p.file.split("/").pop());
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) return dest;
  const buf = Buffer.from(await (await fetch((p.base || BASE) + p.file, { signal: AbortSignal.timeout(300000) })).arrayBuffer());
  fs.writeFileSync(dest, buf);
  return dest;
}

/** 解 .deb：ar → data.tar.xz → xz 解码 → tar 解包 */
async function extractDeb(deb, destRoot) {
  const buf = fs.readFileSync(deb);
  if (buf.subarray(0, 8).toString() !== "!<arch>\n") throw new Error("不是 ar 归档: " + deb);
  let off = 8;
  while (off + 60 <= buf.length) {
    const h = buf.subarray(off, off + 60);
    const name = h.subarray(0, 16).toString().trim().replace(/\/$/, "");
    const size = parseInt(h.subarray(48, 58).toString().trim(), 10);
    const data = buf.subarray(off + 60, off + 60 + size);
    if (name === "data.tar.xz") {
      const src = new Blob([data]).stream();
      const reader = new xz.XzReadableStream(src).getReader();
      const chunks = [];
      for (;;) { const { done, value } = await reader.read(); if (done) break; chunks.push(Buffer.from(value)); }
      const tmpTar = path.join(CACHE, path.basename(deb) + ".tar");
      fs.writeFileSync(tmpTar, Buffer.concat(chunks));
      try {
        execFileSync("/system/bin/tar", ["-xf", tmpTar, "-C", destRoot], { stdio: "pipe" });
      } catch (e) {
        // 某些包带绝对路径软链接（如 alsa 配置），toybox tar 会拒绝——忽略，不影响我们
        console.log(`\n      ⚠️  ${path.basename(deb)} 部分文件跳过（软链接越界）`);
      }
      fs.unlinkSync(tmpTar);
      return;
    }
    if (name === "data.tar.gz" || name === "data.tar") {
      const tmpTar = path.join(CACHE, path.basename(deb) + ".tar");
      fs.writeFileSync(tmpTar, name.endsWith(".gz") ? zlib.gunzipSync(data) : data);
      execFileSync("/system/bin/tar", ["-xf", tmpTar, "-C", destRoot], { stdio: "inherit" });
      fs.unlinkSync(tmpTar);
      return;
    }
    off += 60 + size + (size % 2);
  }
  throw new Error("没找到 data.tar.*: " + deb);
}

const [cmd, ...args] = process.argv.slice(2);
const idx = await loadIndex();

if (cmd === "list") {
  const kw = (args[0] || "").toLowerCase();
  for (const [n, p] of idx) if (n.toLowerCase().includes(kw)) console.log(`${n.padEnd(26)} v${p.ver}`);
  process.exit(0);
}

if (cmd === "install") {
  const roots = args;
  const cl = closure(idx, roots);
  const total = cl.reduce((s, n) => s + idx.get(n).size, 0) / 1024;
  console.log(`需要 ${cl.length} 个包，解压后约 ${total.toFixed(1)}MB\n`);

  for (const n of cl) {
    const p = idx.get(n);
    const cached = fs.existsSync(path.join(CACHE, p.file.split("/").pop()));
    process.stdout.write(`  ${cached ? "缓存" : "下载"} ${n.padEnd(22)} v${p.ver.padEnd(16)}`);
    const deb = await fetchDeb(idx, n);
    await extractDeb(deb, STAGE);
    console.log(` ${(fs.statSync(deb).size / 1024).toFixed(0)}KB ✓`);
  }

  // 整理：stage/data/data/com.termux/files/usr/* → prefix/
  const src = path.join(STAGE, "data/data/com.termux/files/usr");
  if (fs.existsSync(src)) {
    fs.mkdirSync(PREFIX, { recursive: true });
    execFileSync("/system/bin/sh", ["-c", `cp -r "${src}/." "${PREFIX}/" 2>/dev/null; true`]);
  }
  console.log(`\n✅ 已安装到 ${PREFIX}`);
  console.log(`   二进制: ${PREFIX}/bin`);
  console.log(`   库文件: ${PREFIX}/lib`);
  console.log(`\n运行时这样用：`);
  console.log(`   LD_LIBRARY_PATH="${PREFIX}/lib" ${PREFIX}/bin/<工具>`);
}
